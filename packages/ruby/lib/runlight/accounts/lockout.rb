# frozen_string_literal: true

module Runlight
  module Accounts
    # Counts wrong second-factor codes under a key and locks it for longer each time the tries run out: five
    # tries, then fifteen minutes, then thirty, then an hour, doubling up to a day. A right code clears the
    # key, and so does a week with no lock and no try. A lock always ends, at most a day later, so nobody is
    # shut out for good.
    #
    # TypeScript keeps the counts in its process. Here they live in the database's settings, as
    # "lockout:<name>:<id>" holding {count, until, locks, forget}, so every process of an install shares them
    # and a restart does not hand out five more tries. A key is an account's id (with "\ndevice" for a browser
    # that signed in to it before), never anything made from a caller's address, and it is kept as a hash.
    # One that is forgotten is deleted when it is next read, by the scheduled check, and by each process once
    # an hour (sweep).
    class Lockout
      PREFIX = "lockout:"
      private_constant :PREFIX

      def initialize(store, name, limit = 5, window_ms = 15 * 60_000, longest_ms = 86_400_000, forget_ms = 7 * 86_400_000)
        @store = store
        @name = name
        @limit = limit
        @window_ms = window_ms
        @longest_ms = longest_ms
        @forget_ms = forget_ms
      end

      # Deletes every key long forgotten, for the scheduled check and each process's hourly sweep.
      def self.sweep(store, now)
        store.settings_starting_with(PREFIX).each do |row|
          entry = Json.try_decode(row["value"])
          forget = entry.is_a?(Hash) ? Js.number(entry["forget"].nil? ? 0 : entry["forget"]) : 0
          store.set_setting(row["key"], nil) unless forget.is_a?(Numeric) && forget.to_f.finite? && forget > now
        end
      end

      # Counts a try before the code is checked, so a burst cannot get past the limit. False, counting
      # nothing, while the key is locked. The try that uses up the last one starts the lock.
      def take(key, now)
        name = setting(key)
        # Checked and counted in one turn, so tries at once from other threads and processes wait for it.
        turn do
          entry = read(name)
          entry = nil if !entry.nil? && entry["forget"] <= now
          next false if !entry.nil? && entry["count"] >= @limit && entry["until"] > now

          if entry.nil?
            entry = { "count" => 0, "until" => now + @window_ms, "locks" => 0, "forget" => 0 }
          elsif entry["until"] <= now
            entry["count"] = 0
            entry["until"] = now + @window_ms
          end
          entry["count"] += 1
          if entry["count"] >= @limit
            entry["until"] = now + [@window_ms * (2**[entry["locks"], 40].min), @longest_ms].min
            entry["locks"] += 1
          end
          entry["forget"] = entry["until"] + @forget_ms
          @store.set_setting(name, Json.encode(entry))
          true
        end
      end

      # Forgets a key, for a code that turned out right.
      def clear(key)
        @store.set_setting(setting(key), nil)
        nil
      end

      private

      def setting(key)
        "#{PREFIX}#{@name}:#{Hashing.sha256("#{@name}\n#{key}")[0, 32]}"
      end

      def read(name)
        saved = @store.setting(name)
        entry = saved.nil? ? nil : Json.try_decode(saved)
        return nil unless entry.is_a?(Hash)

        %w[count until locks forget].to_h { |field| [field, whole(entry[field])] }
      end

      # A saved number, whole, and 0 for anything that is not a number.
      def whole(value)
        n = Js.number(value.nil? ? 0 : value)
        n.is_a?(Float) && !n.finite? ? 0 : n.to_i
      end

      # One change at a time, across threads and processes, as the accounts take turns.
      def turn(&block)
        db = @store.db
        db.respond_to?(:turn) ? db.turn { block.call } : db.exclusive { block.call }
      end
    end
  end
end

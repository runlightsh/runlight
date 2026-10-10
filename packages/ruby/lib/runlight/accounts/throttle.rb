# frozen_string_literal: true

module Runlight
  module Accounts
    # Counts failed sign-ins under a key and refuses more than a few in a while.
    # Keys are hashed with a key made for each UTC day, so the counts never hold
    # an address or an email as it was given.
    #
    # TypeScript keeps the counts in its process. Here they live in the database's
    # settings, as "throttle:<name>:<id>" holding {count, until}, and the hashing
    # key as "throttle-key:<UTC day>", so every process of an install shares the
    # same counts. Some keys are addresses, and nothing derived from one lasts
    # longer than a day: an expired count is deleted when it is read and by the
    # scheduled check (sweep), and a day's hashing key goes once the day is over
    # (yesterday's is kept only long enough to carry a count across midnight).
    class Throttle
      KEY = "throttle-key:"
      # The one hashing key from before keys were made per day.
      LEGACY_KEY = "throttle-key"
      DAY_MS = 86_400_000
      # How long after midnight yesterday's key carries a count over: the longest window a throttle counts in.
      CARRY_MS = 15 * 60_000
      private_constant :KEY, :LEGACY_KEY, :DAY_MS, :CARRY_MS

      def initialize(store, name, limit = 10, window_ms = 15 * 60_000)
        @store = store
        @name = name
        @limit = limit
        @window_ms = window_ms
      end

      # Deletes every count that has run out and the hashing keys of days gone, for the scheduled check.
      def self.sweep(store, now)
        store.settings_starting_with("throttle:").each do |row|
          entry = Json.try_decode(row["value"])
          until_ms = entry.is_a?(Hash) ? Js.number(entry["until"].nil? ? 0 : entry["until"]) : 0
          store.set_setting(row["key"], nil) unless until_ms.is_a?(Numeric) && until_ms.finite? && until_ms > now
        end
        drop_old_keys(store, now)
      end

      # The UTC day a time falls on, as YYYY-MM-DD.
      def self.day(now)
        Time.at(now.to_i / 1000).utc.strftime("%Y-%m-%d")
      end

      # Keeps today's hashing key, and yesterday's only just after midnight; the one from before days goes too.
      def self.drop_old_keys(store, now)
        keep = [day(now)]
        keep << day(now - DAY_MS) if now.to_i % DAY_MS < CARRY_MS
        store.set_setting(LEGACY_KEY, nil) unless store.setting(LEGACY_KEY).nil?
        store.settings_starting_with(KEY).each do |row|
          store.set_setting(row["key"], nil) unless keep.include?(row["key"][KEY.length..])
        end
      end

      def blocked(key, now)
        today, yesterday = ids(key, now)
        entry = entry(today, now) || (yesterday && entry(yesterday, now))
        blocked_entry?(entry)
      end

      # Counts a try before the slow check it guards, so a burst that arrives
      # while earlier tries are still being checked cannot get past the limit.
      # False, counting nothing, when the key is already at its limit. A try
      # that turns out right is taken back with forgive().
      def take(key, now)
        ids = ids(key, now)
        # Checked and counted in one turn, so tries at once from other threads and processes wait for it.
        turn do
          entry = carry(ids, now)
          next false if blocked_entry?(entry)

          count(ids[0], entry, now)
          true
        end
      end

      # Takes back one counted try, for one that turned out right.
      def forgive(key, now)
        ids = ids(key, now)
        turn do
          entry = carry(ids, now)
          next unless entry && entry["count"].positive?

          entry["count"] -= 1
          save(ids[0], entry)
        end
        nil
      end

      def record_failure(key, now)
        ids = ids(key, now)
        turn { count(ids[0], carry(ids, now), now) }
        nil
      end

      def clear(key, now)
        ids(key, now).compact.each { |id| @store.set_setting("#{prefix}#{id}", nil) }
        nil
      end

      private

      # The day's hashing key, made the first time it is needed (unless make is false, for yesterday's).
      def salt(now, make = true)
        name = "#{KEY}#{self.class.day(now)}"
        saved = @store.setting(name)
        return saved if saved && saved != ""
        return nil unless make

        # Made in a turn, so two processes starting at once do not each keep a different one.
        turn do
          saved = @store.setting(name)
          next saved if saved && saved != ""

          made = Hashing.random_id(16)
          @store.set_setting(name, made)
          self.class.drop_old_keys(@store, now)
          made
        end
      end

      # One change to the counts at a time, across threads and processes, as the accounts take turns.
      def turn(&block)
        db = @store.db
        db.respond_to?(:turn) ? db.turn { block.call } : db.exclusive { block.call }
      end

      # The key's id under today's hashing key, and under yesterday's while that is still kept (else nil).
      def ids(key, now)
        yesterday = salt(now - DAY_MS, false)
        [keyed(salt(now), key), yesterday.nil? ? nil : keyed(yesterday, key)]
      end

      def keyed(salt, key)
        Crypto.base64url(Crypto.hmac("SHA-256", salt, key))[0, 22]
      end

      def prefix
        "throttle:#{@name}:"
      end

      # A count that has not run out, or nil. One that has is deleted as it is read.
      def entry(id, now)
        saved = @store.setting("#{prefix}#{id}")
        return nil if saved.nil?

        entry = Json.try_decode(saved)
        entry = entry.is_a?(Hash) ? { "count" => int(entry["count"]), "until" => int(entry["until"]) } : nil
        return entry if entry && entry["until"] > now

        @store.set_setting("#{prefix}#{id}", nil)
        nil
      end

      # Today's count, or yesterday's moved under today's id, so a window that crosses midnight goes on.
      def carry(ids, now)
        today, yesterday = ids
        found = entry(today, now)
        return found if found || yesterday.nil?

        found = entry(yesterday, now)
        return nil if found.nil?

        @store.set_setting("#{prefix}#{yesterday}", nil)
        save(today, found)
        found
      end

      # A saved number, whole, and 0 for anything that is not a number.
      def int(value)
        n = Js.number(value.nil? ? 0 : value)
        n.is_a?(Float) && !n.finite? ? 0 : n.to_i
      end

      def save(id, entry)
        @store.set_setting("#{prefix}#{id}", Json.encode(entry))
      end

      def blocked_entry?(entry)
        !entry.nil? && entry["count"] >= @limit
      end

      def count(id, entry, now)
        if entry.nil?
          save(id, { "count" => 1, "until" => now + @window_ms })
          prune(now)
          return
        end
        entry["count"] += 1
        save(id, entry)
      end

      # Expired entries go first, then the oldest that are not blocked, and blocked ones last, so the counts
      # have a hard ceiling and a flood of made-up names cannot wipe out a real block. Run when a new entry is
      # made, since only then can there be more.
      def prune(now)
        entries = []
        @store.settings_starting_with(prefix).each do |row|
          entry = Json.try_decode(row["value"])
          until_ms = entry.is_a?(Hash) ? int(entry["until"]) : 0
          if until_ms <= now
            @store.set_setting(row["key"], nil)
            next
          end
          entries << { "key" => row["key"], "until" => until_ms, "blocked" => entry.is_a?(Hash) && int(entry["count"]) >= @limit }
        end
        size = entries.length
        return if size <= Accounts::MAX_THROTTLED

        # Oldest first: each entry's window started windowMs before its end.
        entries = entries.each_with_index.sort_by { |e, i| [e["until"], i] }.map(&:first)
        [false, true].each do |blocked|
          entries.each do |e|
            return if size <= Accounts::MAX_THROTTLED

            if e["blocked"] == blocked
              @store.set_setting(e["key"], nil)
              size -= 1
            end
          end
        end
      end
    end
  end
end

# frozen_string_literal: true

module Runlight
  module Db
    # A database whose tables and indexes start with a prefix of the app's choosing in place of `rl_`, such as
    # `wp_rl_` beside a WordPress database's tables, so two apps sharing one database each keep a set of their
    # own. Runlight's SQL names every table and index `rl_` and something, and those names alone are rewritten
    # on the way through, in each statement and in the names a schema check compares as text. A store given a
    # prefix puts one in front of its database, so the accounts and importers that reach the database through
    # the store follow it too. Values bound to `?` are never rewritten.
    class Prefixed
      # Whatever else the database underneath has (close, limit_statements, connection_class) is passed on.
      OPTIONAL = %i[affected turn metered?].freeze
      private_constant :OPTIONAL

      attr_reader :inner, :prefix

      def initialize(inner, prefix)
        # A name in a statement, and short enough that the longest index name stays inside MySQL's 64.
        unless prefix.is_a?(String) && prefix.match?(/\A[A-Za-z_][A-Za-z0-9_]{0,31}\z/)
          raise ArgumentError, "Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit"
        end

        @inner = inner
        @prefix = prefix
      end

      # A statement with each of Runlight's names under the prefix.
      def sql(text)
        text.gsub(/\brl_(?=[a-z])/, @prefix)
      end

      def dialect
        @inner.dialect
      end

      def all(text, params = [])
        @inner.all(sql(text), params)
      end

      def run(text, params = [])
        @inner.run(sql(text), params)
      end

      def affected(text, params = [])
        @inner.affected(sql(text), params)
      end

      def metered?
        @inner.metered?
      end

      def transaction
        @inner.transaction { |db| yield wrap(db) }
      end

      def exclusive
        @inner.exclusive { |db| yield wrap(db) }
      end

      def turn
        @inner.turn { |db| yield wrap(db) }
      end

      def close
        @inner.close
      end

      def respond_to?(name, include_all = false)
        return @inner.respond_to?(name, include_all) if OPTIONAL.include?(name.to_sym)

        super
      end

      private

      def wrap(db)
        db.equal?(@inner) ? self : Prefixed.new(db, @prefix)
      end

      def method_missing(name, ...)
        return super unless @inner.respond_to?(name)

        @inner.public_send(name, ...)
      end

      def respond_to_missing?(name, include_all = false)
        @inner.respond_to?(name, include_all) || super
      end
    end
  end
end

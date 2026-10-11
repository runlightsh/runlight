# frozen_string_literal: true

module Runlight
  # The stores stores/sqlite.ts, stores/postgres.ts, and stores/mysql.ts make, over ActiveRecord. Tables are
  # prefixed `rl_`, so the database can be the app's own, and a database made by the TypeScript SDK opens here.
  # Each takes `prefix:` in place of `rl_`: what every table and index name starts with, so two apps sharing
  # one database each keep a set of their own, up to 32 letters, digits, and underscores, not starting with a
  # digit.
  module Stores
    module_function

    # Runlight's tables in a SQLite file (or ":memory:"), in WAL mode, as better-sqlite3 opens it there. A
    # file it makes is for its owner and group alone (0660).
    def sqlite(path, prefix: Store::Sql::PREFIX)
      Store::SqlStore.new(Db::Connect.sqlite(path), prefix)
    end

    # Runlight's tables in Postgres, from a connection string. statement_timeout is the longest one statement
    # may run, in milliseconds (default 120000, 0 for no limit); schema is the search path.
    def postgres(url, statement_timeout: 120_000, schema: nil, prefix: Store::Sql::PREFIX)
      raise ArgumentError, "Runlight: postgres() needs a url" if url.to_s.empty?

      Store::SqlStore.new(Db::Connect.postgres(url, statement_timeout: statement_timeout, schema: schema), prefix)
    end

    # Runlight's tables in MySQL 8.4 or MariaDB 11.4 and later, from a mysql:// or mariadb:// URL. Text is
    # utf8mb4 with a binary collation, so it compares and sorts by code point, case and trailing spaces
    # included, as SQLite and Postgres do. statement_timeout is in milliseconds (default 120000, 0 for no
    # limit), which MySQL applies to reads only and MariaDB to every statement.
    def mysql(url, statement_timeout: 120_000, prefix: Store::Sql::PREFIX)
      raise ArgumentError, "Runlight: mysql() needs a url" if url.to_s.empty?

      Store::SqlStore.new(Db::Connect.mysql(url, statement_timeout: statement_timeout), prefix)
    end

    # The store a DATABASE_URL names, as the standalone server picks one: postgres:// or postgresql:// for
    # Postgres, mysql:// or mariadb:// for MySQL, and sqlite: or file: followed by a path for SQLite.
    def url(database_url, prefix: Store::Sql::PREFIX)
      Store::SqlStore.new(Db::Connect.url(database_url), prefix)
    end

    # Runlight's tables in the database an ActiveRecord class connects to: the app's own by default. Writes
    # join a transaction the app has open.
    def active_record(connection_class = ::ActiveRecord::Base, prefix: Store::Sql::PREFIX)
      Store::SqlStore.new(Db::Database.new(connection_class), prefix)
    end

    # A store over any Db::Database, with its tables under `prefix` in place of `rl_` when one is given.
    def from_db(db, prefix: Store::Sql::PREFIX)
      Store::SqlStore.new(db, prefix)
    end
  end
end

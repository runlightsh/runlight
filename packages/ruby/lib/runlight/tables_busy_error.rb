# frozen_string_literal: true

module Runlight
  # Another process held the lock for creating tables past Db::Database::LOCK_WAIT_MS, such as one building an
  # index on a big table after an upgrade. The request that waited fails with this, rather than waiting for good.
  class TablesBusyError < RuntimeError
    def initialize(waited = Db::Database::LOCK_WAIT_MS)
      super("Runlight: another process is creating or upgrading the tables, and had not finished after #{(waited / 1000.0).round} seconds. Try again in a minute.")
    end
  end
end

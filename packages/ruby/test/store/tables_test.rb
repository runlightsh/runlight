# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require_relative "../support/store_test_case"
require_relative "../routes/make"

# Table prefixes, the wait for another process creating the tables, and the mode of a new SQLite file:
# tables.test.ts.
class StoreTablesTest < StoreTestCase
  SqlStore = Runlight::Store::SqlStore
  Stores = Runlight::Stores
  Database = Runlight::Db::Database
  PREFIX = Runlight::Store::Sql::PREFIX
  TABLES = Runlight::Store::Sql::TABLES

  # A database the store's lock for creating tables never comes from, until the test says whether it came or
  # the wait gave up: as another process holding it would be.
  class HeldDb
    def initialize(inner)
      @inner = inner
      @gate = Queue.new
    end

    # Lets one waiting turn go ahead, or give up when busy.
    def release(busy)
      @gate << busy
    end

    def dialect
      @inner.dialect
    end

    def all(sql, params = [])
      @inner.all(sql, params)
    end

    def run(sql, params = [])
      @inner.run(sql, params)
    end

    def transaction
      @inner.transaction { yield self }
    end

    def exclusive
      raise Runlight::TablesBusyError if @gate.pop

      @inner.exclusive { yield self }
    end

    def close
      @inner.close
    end
  end

  def setup
    super
    @dir = Dir.mktmpdir("runlight-tables-")
  end

  def teardown
    super
    Database.lock_wait_in_tests(nil)
    FileUtils.rm_rf(@dir)
  end

  # Every table and index name in the database, as each dialect lists them.
  def names(db)
    sql = case db.dialect
          when "sqlite" then "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
          when "postgres"
            "SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'i', 'S')"
          else
            "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()
             UNION SELECT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name <> 'PRIMARY'"
          end
    db.all(sql).map { |row| row.values.first.to_s }.sort
  end

  # A store with its tables under rl_, and a lambda that opens another on the same database under wp_rl_.
  def pair(kind)
    if kind == "sqlite"
      file = File.join(@dir, "shared.db")
      return [StoreDatabases.closing(Stores.sqlite(file)), -> { StoreDatabases.closing(Stores.sqlite(file, prefix: "wp_rl_")) }]
    end
    if kind == "postgres"
      schema = StoreDatabases.pg_schema
      url = Databases.pg_url
      return [StoreDatabases.closing(Stores.postgres(url, schema: schema)),
              -> { StoreDatabases.closing(Stores.postgres(url, schema: schema, prefix: "wp_rl_")) }]
    end
    url = StoreDatabases.mysql_database(kind)
    [StoreDatabases.closing(Stores.mysql(url)), -> { StoreDatabases.closing(Stores.mysql(url, prefix: "wp_rl_")) }]
  end

  on_each "a_prefix_keeps_a_second_set_of_tables_beside_the_first_in_one_database", Databases.kinds do |kind|
    plain, open = pair(kind)
    other = open.call
    other.migrate
    # A second process with the same prefix finds every table and index already there.
    open.call.migrate(true)
    made = names(plain.db)
    refute_empty made
    assert_equal [], made.reject { |name| name.start_with?("wp_rl_") }, "every name is under the prefix"
    assert_equal TABLES.map { |table| "wp_rl_#{table}" }, other.tables
    assert_equal [], other.tables.first(15) - made, "the store's 15 tables, listed for removing them"

    plain.migrate
    plain_names = names(plain.db).select { |name| name.start_with?(PREFIX) }
    assert_equal 15, plain_names.count { |name| TABLES.include?(name.delete_prefix(PREFIX)) }
    site = ->(id) { { "id" => id, "name" => id, "hostnames" => ["#{id}.example"], "timezone" => "UTC" } }
    plain.upsert_site(site.call("first"), 1)
    other.upsert_site(site.call("second"), 1)
    assert_equal ["first"], plain.sites.map { |s| s["id"] }
    assert_equal ["second"], other.sites.map { |s| s["id"] }
    assert_equal "second", other.transaction { |tx| tx.sites[0]["id"] }, "a transaction keeps the prefix"
    other.set_setting("k", "wp")
    assert_nil plain.setting("k")
    assert_equal "wp", other.setting("k")
  end

  def test_a_table_prefix_is_letters_digits_and_underscores_and_does_not_start_with_a_digit
    ["1rl_", "rl-", "rl_; DROP TABLE x", "", "a" * 33].each do |prefix|
      error = assert_raises(ArgumentError, prefix) { StoreDatabases.closing(Stores.sqlite(":memory:", prefix: prefix)) }
      assert_equal "Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit", error.message
    end
    ["rl_", "wp_rl_", "_x", "A" * 32].each do |prefix|
      assert_equal prefix, StoreDatabases.closing(Stores.sqlite(":memory:", prefix: prefix)).prefix
    end
    prefixed = StoreDatabases.closing(Stores.sqlite(":memory:", prefix: "wp_rl_"))
    assert_equal "wp_rl_", SqlStore.new(prefixed.db).prefix, "a store over a prefixed database keeps its prefix"
    assert_equal "wp_rl_", Stores.from_db(prefixed.db, prefix: "other_").prefix
    assert_equal %w[rl_meta rl_sites], StoreDatabases.closing(Stores.sqlite(":memory:")).tables.first(2)
  end

  def test_names_bound_as_values_are_left_alone_and_names_in_statements_are_rewritten
    db = Runlight::Db::Prefixed.new(Databases.db("sqlite"), "wp_rl_")
    assert_equal "SELECT x FROM wp_rl_users WHERE table_name = 'wp_rl_users' AND v = 'rl_' AND w = 'rl_1' AND s = 'url_x'",
                 db.sql("SELECT x FROM rl_users WHERE table_name = 'rl_users' AND v = 'rl_' AND w = 'rl_1' AND s = 'url_x'")
    store = Stores.from_db(db)
    store.migrate
    store.set_setting("rl_sites", "rl_meta")
    assert_equal "rl_meta", store.setting("rl_sites")
  end

  def test_a_new_sqlite_file_is_for_its_owner_and_group_alone_and_so_are_the_files_sqlite_makes_beside_it
    skip "Windows has no such modes" if Gem.win_platform?

    folder = File.join(@dir, "data")
    file = File.join(folder, "mode.db")
    store = Stores.sqlite(file)
    store.migrate
    store.set_setting("k", "v")
    assert_equal 0o660, File.stat(file).mode & 0o777
    assert File.exist?("#{file}-wal")
    assert_equal 0o660, File.stat("#{file}-wal").mode & 0o777
    assert_equal 0o770, File.stat(folder).mode & 0o777, "the folder the store made for it"
    store.close

    # A file that was there before keeps its mode.
    File.chmod(0o640, file)
    again = Stores.sqlite(file)
    again.migrate
    assert_equal 0o640, File.stat(file).mode & 0o777
    again.close
  end

  def test_a_tracker_hit_waits_a_moment_at_most_while_another_process_creates_the_tables_and_other_requests_hear_why
    db = HeldDb.new(Databases.db("sqlite"))
    rl = Runlight::Core.new("store" => SqlStore.new(db), "site" => { "hostnames" => ["example.com"] }, "now" => -> { utc(2026, 10, 6, 12) })
    routes = rl.routes("token" => "secret")
    started = monotonic
    hit = routes.handle(Runlight::Http::Request.new("https://example.com/runlight/e", method: "POST", headers: {
      "user-agent" => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      "x-forwarded-for" => "203.0.113.1", "content-type" => "text/plain;charset=UTF-8",
    }, body: Runlight::Json.encode({ "k" => "pageview", "u" => "https://example.com/", "i" => "a1" })))
    assert_equal 202, hit.status
    waited = monotonic - started
    assert waited >= 9.9 && waited < 12, "the hit waited #{waited}s"

    # The other process gives up the wait: the request that waited answers 503, saying why. Both the init the
    # hit left going and the request's own try hear it.
    asked = Thread.new { routes.handle(RoutesMake.owner("/runlight/api/stats?period=today")) }
    db.release(true)
    db.release(true)
    answer = asked.value
    assert_equal 503, answer.status
    assert_equal "30", answer.headers.get("retry-after")
    assert_equal({ "error" => "Runlight is creating or upgrading its tables. Try again in a minute.", "code" => "tables_busy" }, RoutesMake.body(answer))

    # Once the tables are there, hits are counted again.
    db.release(false)
    rl.init
    stats = RoutesMake.body(routes.handle(RoutesMake.owner("/runlight/api/stats?period=today&compare=off")))
    assert_equal 0, stats["stats"]["visitors"], "the hit that came while the tables were busy was dropped"
  end

  def test_postgres_waiting_for_another_process_creating_the_tables_gives_up_after_the_lock_wait
    skip "RUNLIGHT_TEST_PG is not set" if Databases.pg_url.nil?

    schema = StoreDatabases.pg_schema
    admin = Runlight::Db::Connect.postgres(Databases.pg_url)
    session = admin.connection_class.connection_pool.checkout
    begin
      Database.lock_wait_in_tests(1_000)
      # The lock every Runlight takes to create tables, held by another session. Asked for again and again, as
      # the stores do, since waiting on it could deadlock with an index another process is building concurrently.
      sleep 0.05 until [true, "t"].include?(session.exec_query("SELECT pg_try_advisory_lock(#{Database::MIGRATION_LOCK}) AS ok").rows[0][0])
      store = StoreDatabases.closing(Stores.postgres(Databases.pg_url, schema: schema))
      started = monotonic
      error = assert_raises(Runlight::TablesBusyError) { store.migrate }
      assert_equal "Runlight: another process is creating or upgrading the tables, and had not finished after 1 seconds. Try again in a minute.", error.message
      assert monotonic - started < 5
      session.exec_query("SELECT pg_advisory_unlock(#{Database::MIGRATION_LOCK})")
      store.migrate
    ensure
      admin.connection_class.connection_pool.checkin(session)
      admin.close
    end
  end

  def test_postgres_an_index_left_unusable_is_built_again_under_a_prefix_that_itself_starts_rl
    skip "RUNLIGHT_TEST_PG is not set" if Databases.pg_url.nil?

    schema = StoreDatabases.pg_schema
    open = -> { StoreDatabases.closing(Stores.postgres(Databases.pg_url, schema: schema, prefix: "rl_wp_")) }
    open.call.migrate
    admin = StoreDatabases.closing(Stores.postgres(Databases.pg_url)).db
    # As a concurrent build stopped part way leaves it.
    begin
      admin.run("UPDATE pg_index SET indisvalid = false WHERE indexrelid = '#{schema}.rl_wp_events_site_ts'::regclass")
    rescue ActiveRecord::StatementInvalid
      skip "marking an index unusable needs a superuser"
    end
    open.call.migrate(true)
    valid = admin.all("SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = '#{schema}.rl_wp_events_site_ts'::regclass")
    assert_equal [{ "valid" => true }], valid
  end

  on_each "waiting_for_another_process_creating_the_tables_gives_up_after_the_lock_wait", Databases.kinds - %w[sqlite postgres] do |kind|
    url = StoreDatabases.mysql_database(kind)
    other = Runlight::Db::Connect.mysql(url)
    session = other.connection_class.connection_pool.checkout
    store = StoreDatabases.closing(Stores.mysql(url))
    begin
      Database.lock_wait_in_tests(1_000)
      # The lock every Runlight takes to create tables in this database, held by another session.
      session.exec_query("SELECT GET_LOCK(#{Database::MYSQL_LOCK}, 0)")
      started = monotonic
      assert_raises(Runlight::TablesBusyError) { store.migrate }
      assert monotonic - started < 5
      session.exec_query("DO RELEASE_LOCK(#{Database::MYSQL_LOCK})")
      store.migrate
    ensure
      other.connection_class.connection_pool.checkin(session)
      other.close
    end
  end

  def test_a_tables_busy_error_says_how_long_it_waited
    assert_equal "Runlight: another process is creating or upgrading the tables, and had not finished after 30 seconds. Try again in a minute.",
                 Runlight::TablesBusyError.new.message
    assert_equal 30_000, Database::LOCK_WAIT_MS
  end

  private

  def monotonic
    Process.clock_gettime(Process::CLOCK_MONOTONIC)
  end

  def utc(...)
    RoutesMake.utc(...)
  end
end

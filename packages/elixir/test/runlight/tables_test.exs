defmodule Runlight.TablesTest do
  @moduledoc """
  The SDK's tables.test.ts: a table prefix keeps a second set of tables in
  one database, and a process waits only so long for another one creating
  the tables.
  """
  use ExUnit.Case, async: false

  alias Runlight.Db
  alias Runlight.Http.Request
  alias Runlight.Http.Response
  alias Runlight.JS
  alias Runlight.Store
  alias Runlight.TablesBusyError
  alias Runlight.Test.SqliteRepo
  alias Runlight.Test.Stores

  # Every table and index name in the database, as each dialect lists them.
  defp names(%Db{dialect: dialect} = db) do
    sql =
      case dialect do
        :sqlite ->
          "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"

        :postgres ->
          "SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'i', 'S')"

        :mysql ->
          """
          SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()
                     UNION SELECT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name <> 'PRIMARY'\
          """
      end

    db |> Db.all(sql, []) |> Enum.map(&JS.string(&1["name"])) |> Enum.sort()
  end

  # A store with its tables under rl_, a function making one under wp_rl_ in the same database, and a raw look at it.
  defp shared_pair(:sqlite) do
    dir = Path.join(System.tmp_dir!(), "runlight-tables-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    {:ok, pid} = SqliteRepo.start_link(name: nil, database: Path.join(dir, "shared.db"), pool_size: 1, log: false)
    Process.unlink(pid)

    on_exit(fn ->
      Supervisor.stop(pid, :normal, 10_000)
      File.rm_rf!(dir)
    end)

    plain = Store.ecto(repo: SqliteRepo, dynamic_repo: pid)
    {plain, fn -> Store.ecto(repo: SqliteRepo, dynamic_repo: pid, prefix: "wp_rl_") end}
  end

  defp shared_pair(kind) do
    {plain, cleanup} = Stores.store(kind, Keyword.fetch!(Stores.kinds(), kind))
    on_exit(cleanup)
    {plain, fn -> Store.new(plain.db, prefix: "wp_rl_") end}
  end

  for {kind, _} <- Stores.kinds(), kind in [:sqlite, :postgres, :mysql, :mariadb] do
    @kind kind
    test "#{kind}: a prefix keeps a second set of tables beside the first in one database" do
      {plain, open} = shared_pair(@kind)
      raw = plain.db
      other = open.()
      Store.migrate(other)
      # A second process with the same prefix finds every table and index already there.
      Store.migrate(open.())
      made = names(raw)
      assert made != []
      assert Enum.reject(made, &String.starts_with?(&1, "wp_rl_")) == [], "every name is under the prefix"
      assert Store.tables(other) == Enum.map(Store.table_names(), &("wp_rl_" <> &1))
      assert other |> Store.tables() |> Enum.take(15) |> Enum.reject(&(&1 in made)) == [], "the store's 15 tables"

      Store.migrate(plain)
      plain_names = raw |> names() |> Enum.filter(&String.starts_with?(&1, "rl_"))
      assert Enum.count(plain_names, &(String.replace_prefix(&1, "rl_", "") in Store.table_names())) == 15
      site = fn id -> JS.obj(id: id, name: id, hostnames: ["#{id}.example"], timezone: "UTC") end
      Store.upsert_site(plain, site.("first"), 1)
      Store.upsert_site(other, site.("second"), 1)
      assert Enum.map(Store.sites(plain), & &1["id"]) == ["first"]
      assert Enum.map(Store.sites(other), & &1["id"]) == ["second"]

      assert Store.transaction(other, fn tx -> hd(Store.sites(tx))["id"] end) == "second",
             "a transaction keeps the prefix"

      Store.set_setting(other, "k", "wp")
      assert Store.setting(plain, "k") == nil
      assert Store.setting(other, "k") == "wp"
    end
  end

  test "a table prefix is letters, digits, and underscores, and does not start with a digit" do
    {store, cleanup} = Stores.store(:sqlite)
    on_exit(cleanup)

    for prefix <- ["1rl_", "rl-", "rl_; DROP TABLE x", "", String.duplicate("a", 33)] do
      assert_raise ArgumentError, ~r/a table prefix is up to 32 letters, digits, and underscores/, fn ->
        Store.new(store.db, prefix: prefix)
      end
    end

    for prefix <- ["rl_", "wp_rl_", "_x", String.duplicate("A", 32)],
        do: assert(Store.new(store.db, prefix: prefix).prefix == prefix)

    assert Store.new(Store.new(store.db, prefix: "wp_rl_").db).prefix == "wp_rl_",
           "a store over a prefixed Db keeps its prefix"

    assert store |> Store.tables() |> Enum.take(2) == ["rl_meta", "rl_sites"]
    assert Store.prefix(store) == "rl_"
  end

  defmodule Held do
    @moduledoc false
    # A Db whose lock for creating tables another process holds: it waits until the test says go, or gives up.
    @behaviour Runlight.Db

    def new(inner, agent), do: %Db{module: __MODULE__, dialect: inner.dialect, state: %{inner: inner, agent: agent}}

    @impl Db
    def all(db, sql, params), do: Db.all(db.state.inner, sql, params)
    @impl Db
    def run(db, sql, params), do: Db.run(db.state.inner, sql, params)
    @impl Db
    def affected(db, sql, params), do: Db.affected(db.state.inner, sql, params)
    @impl Db
    def transaction(db, fun), do: Db.transaction(db.state.inner, fun)

    @impl Db
    def exclusive(db, fun) do
      case Agent.get(db.state.agent, & &1) do
        :go ->
          fun.(db.state.inner)

        :busy ->
          raise TablesBusyError

        :hold ->
          Process.sleep(10)
          exclusive(db, fun)
      end
    end
  end

  test "a tracker hit waits a moment at most while another process creates the tables, and other requests hear why they failed" do
    {store, cleanup} = Stores.store(:sqlite)
    on_exit(cleanup)
    {:ok, lock} = Agent.start_link(fn -> :hold end)
    now = 1_791_288_000_000

    rl =
      Runlight.new(store: Store.new(Held.new(store.db, lock)), site: [hostnames: ["example.com"]], now: fn -> now end)

    handle = &Runlight.Routes.handle(Runlight.routes(rl, token: "secret"), &1)
    started = System.monotonic_time(:millisecond)

    hit =
      handle.(
        Request.new("https://example.com/runlight/e",
          method: "POST",
          headers: [
            {"user-agent",
             "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"},
            {"x-forwarded-for", "203.0.113.1"}
          ],
          body: ~s({"k":"pageview","u":"https://example.com/","i":"a1"})
        )
      )

    assert hit.status == 202
    waited = System.monotonic_time(:millisecond) - started
    assert waited >= 9900 and waited < 12_000, "the hit waited #{waited}ms"

    # The other process gives up the wait: a request that waited answers 503, saying why.
    stats = fn ->
      handle.(
        Request.new("https://example.com/runlight/api/stats?period=today&compare=off",
          headers: [{"authorization", "Bearer secret"}]
        )
      )
    end

    asked = Task.async(stats)
    Agent.update(lock, fn _ -> :busy end)
    answer = Task.await(asked)
    assert answer.status == 503
    assert Response.header(answer, "retry-after") == "30"

    assert Jason.decode!(answer.body) == %{
             "error" => "Runlight is creating or upgrading its tables. Try again in a minute.",
             "code" => "tables_busy"
           }

    # Once the tables are there, hits are counted again.
    Agent.update(lock, fn _ -> :go end)
    Runlight.init(rl)
    answer = stats.()
    assert answer.status == 200

    assert Jason.decode!(answer.body)["stats"]["visitors"] == 0,
           "the hit that came while the tables were busy was dropped"
  end

  if url = Keyword.get(Stores.kinds(), :postgres) do
    @url url
    test "postgres: waiting for another process creating the tables gives up after the lock wait" do
      {store, cleanup} = Stores.store(:postgres, @url)
      on_exit(cleanup)
      {:ok, admin} = Postgrex.start_link(Stores.parse(@url))
      Store.lock_wait_in_tests(1_000)

      try do
        # The lock every Runlight takes to create tables, held by another session.
        Stream.repeatedly(fn -> Postgrex.query!(admin, "SELECT pg_try_advisory_lock(7331906) AS ok", []).rows end)
        |> Enum.find(&(&1 == [[true]]))

        started = System.monotonic_time(:millisecond)

        assert_raise TablesBusyError, ~r/had not finished after 1 seconds/, fn -> Store.migrate(store) end
        assert System.monotonic_time(:millisecond) - started < 5_000
        Postgrex.query!(admin, "SELECT pg_advisory_unlock(7331906)", [])
        assert Store.migrate(store) == :ok
      after
        Store.lock_wait_in_tests(nil)
        GenServer.stop(admin)
      end
    end
  end

  if url = Keyword.get(Stores.kinds(), :postgres) do
    @url url
    test "postgres: an index left unusable is built again under a prefix that itself starts rl_" do
      {store, cleanup} = Stores.store(:postgres, @url)
      on_exit(cleanup)
      Store.migrate(Store.new(store.db, prefix: "rl_wp_"))
      # As a concurrent build stopped part way leaves it.
      Db.run(store.db, "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'rl_wp_events_site_ts'::regclass")
      Store.migrate(Store.new(store.db, prefix: "rl_wp_"))

      assert Db.all(
               store.db,
               "SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = 'rl_wp_events_site_ts'::regclass"
             ) ==
               [JS.obj(valid: true)]
    end
  end

  for {kind, url} <- Stores.kinds(), kind in [:mysql, :mariadb] do
    @kind kind
    @url url
    test "#{kind}: waiting for another process creating the tables gives up after the lock wait" do
      {store, cleanup} = Stores.store(@kind, @url)
      on_exit(cleanup)
      {:ok, other} = MyXQL.start_link(Stores.parse(@url))
      name = "CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48))"
      Store.lock_wait_in_tests(1_000)

      try do
        # The lock every Runlight takes to create tables in this database, held by another session.
        MyXQL.query!(other, "SELECT GET_LOCK(#{name}, 0)", [], query_type: :text)
        started = System.monotonic_time(:millisecond)
        assert_raise TablesBusyError, fn -> Store.migrate(store) end
        assert System.monotonic_time(:millisecond) - started < 5_000
        MyXQL.query!(other, "DO RELEASE_LOCK(#{name})", [], query_type: :text)
        assert Store.migrate(store) == :ok
      after
        Store.lock_wait_in_tests(nil)
        GenServer.stop(other)
      end
    end
  end
end

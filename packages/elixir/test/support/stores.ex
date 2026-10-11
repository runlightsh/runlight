defmodule Runlight.Test.SqliteRepo do
  @moduledoc false
  use Ecto.Repo, otp_app: :runlight, adapter: Ecto.Adapters.SQLite3
end

defmodule Runlight.Test.PgRepo do
  @moduledoc false
  use Ecto.Repo, otp_app: :runlight, adapter: Ecto.Adapters.Postgres
end

defmodule Runlight.Test.MyRepo do
  @moduledoc false
  use Ecto.Repo, otp_app: :runlight, adapter: Ecto.Adapters.MyXQL
end

defmodule Runlight.Test.Stores do
  @moduledoc false
  # Fresh, empty stores for the tests: SQLite in memory always, a Postgres
  # schema of its own when RUNLIGHT_TEST_PG is set, and an emptied MySQL or
  # MariaDB database when RUNLIGHT_TEST_MYSQL or RUNLIGHT_TEST_MARIADB is set.
  # Each variable holds a connection URL, such as
  # postgres://joncphillips@127.0.0.1:5432/runlight_test_elixir. Each kind also
  # runs once more with its tables under another prefix (the "+prefix" kinds,
  # as the SDK's helpers.ts has them).
  #
  # A MySQL or MariaDB database is used as it is, its rl_ and wp_rl_ tables
  # dropped before each test, so the tests that use one run one at a time.

  alias Runlight.Test.MyRepo
  alias Runlight.Test.PgRepo
  alias Runlight.Test.SqliteRepo

  @doc "The table prefix the \"+prefix\" stores use in place of rl_, as WordPress would give one."
  def test_prefix, do: "wp_rl_"

  @doc "The kinds of store to test on, each with its URL (nil for SQLite), and each again under a prefix."
  def kinds do
    plain =
      [{:sqlite, nil}] ++
        for {kind, var} <- [
              postgres: "RUNLIGHT_TEST_PG",
              mysql: "RUNLIGHT_TEST_MYSQL",
              mariadb: "RUNLIGHT_TEST_MARIADB"
            ],
            url = env(var),
            do: {kind, url}

    plain ++ for {kind, url} <- plain, do: {String.to_atom("#{kind}+prefix"), url}
  end

  defp env(name) do
    case System.get_env(name) do
      nil -> nil
      value -> if String.trim(value) == "", do: nil, else: String.trim(value)
    end
  end

  @doc """
  A fresh store of a kind, and a function that drops what it made. The repo
  is started under the calling process, with any options given added to its
  own (MySQL and MariaDB only).
  """
  def store(kind, url \\ nil, repo_opts \\ [])

  def store(kind, url, repo_opts)
      when kind in [:"sqlite+prefix", :"postgres+prefix", :"mysql+prefix", :"mariadb+prefix"] do
    plain = kind |> Atom.to_string() |> String.replace_suffix("+prefix", "") |> String.to_existing_atom()
    store(plain, url, Keyword.put(repo_opts, :prefix, test_prefix()))
  end

  def store(:sqlite, _url, repo_opts) do
    {:ok, pid} = SqliteRepo.start_link(name: nil, database: ":memory:", pool_size: 1, log: false)
    Process.unlink(pid)
    store = Runlight.Store.ecto(repo: SqliteRepo, dynamic_repo: pid, prefix: repo_opts[:prefix])
    {store, fn -> stop(pid) end}
  end

  def store(:postgres, url, repo_opts) do
    name = "rl_test_" <> Base.encode16(:crypto.strong_rand_bytes(5), case: :lower)
    config = parse(url)
    {:ok, admin} = Postgrex.start_link(config)
    Process.unlink(admin)
    Postgrex.query!(admin, ~s(CREATE SCHEMA "#{name}"), [])
    {:ok, pid} = PgRepo.start_link([name: nil, pool_size: 2, log: false, parameters: [search_path: name]] ++ config)
    Process.unlink(pid)
    store = Runlight.Store.ecto(repo: PgRepo, dynamic_repo: pid, prefix: repo_opts[:prefix])

    {store,
     fn ->
       stop(pid)
       Postgrex.query!(admin, ~s(DROP SCHEMA IF EXISTS "#{name}" CASCADE), [])
       GenServer.stop(admin)
       :ok
     end}
  end

  def store(kind, url, repo_opts) when kind in [:mysql, :mariadb] do
    config = parse(url)
    {prefix, repo_opts} = Keyword.pop(repo_opts, :prefix)
    {:ok, pid} = MyRepo.start_link([name: nil, pool_size: 2, log: false] ++ repo_opts ++ config)
    Process.unlink(pid)
    previous = MyRepo.put_dynamic_repo(pid)
    empty_mysql()
    MyRepo.put_dynamic_repo(previous)
    store = Runlight.Store.ecto(repo: MyRepo, dynamic_repo: pid, prefix: prefix)

    {store,
     fn ->
       previous = MyRepo.put_dynamic_repo(pid)
       empty_mysql()
       MyRepo.put_dynamic_repo(previous)
       stop(pid)
     end}
  end

  defp empty_mysql do
    %{rows: rows} =
      MyRepo.query!(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND (table_name LIKE 'rl!_%' ESCAPE '!' OR table_name LIKE 'wp!_rl!_%' ESCAPE '!')",
        [],
        log: false
      )

    for [table] <- rows, do: MyRepo.query!("DROP TABLE IF EXISTS `#{table}`", [], log: false)
  end

  # Supervisor.stop works from any process; an exit signal from one that is not the repo's parent is ignored.
  defp stop(pid) do
    if Process.alive?(pid), do: Supervisor.stop(pid, :normal, 10_000)
    :ok
  catch
    :exit, _ -> :ok
  end

  @doc "A connection URL as Postgrex and MyXQL options."
  def parse(url) do
    uri = URI.parse(url)

    {user, pass} =
      case String.split(uri.userinfo || "", ":", parts: 2) do
        [u, p] -> {URI.decode(u), URI.decode(p)}
        [u] -> {URI.decode(u), nil}
      end

    [hostname: uri.host, port: uri.port, username: user, database: String.trim_leading(uri.path || "", "/")] ++
      if(pass, do: [password: pass], else: [])
  end
end

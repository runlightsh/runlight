if Code.ensure_loaded?(Ecto.Adapters.SQL) do
  defmodule Runlight.Db.Ecto do
    @moduledoc """
    Runlight's statements through an app's own Ecto repo, on SQLite
    (`ecto_sqlite3`), Postgres (`postgrex`), or MySQL 8.4 and MariaDB 11.4
    and later (`myxql`). The repo's adapter picks the dialect.

        Runlight.Db.Ecto.new(repo: MyApp.Repo)

    Options:

      * `:repo` (required) - the app's Ecto repo.
      * `:dynamic_repo` - a repo started with `name: nil` (its pid) or under
        another name, put with `put_dynamic_repo/1` around each statement.

    Nothing uses Ecto's schemas: every statement is the SDK's, run with the
    repo's `query/3`, and Runlight's tables are made on first use (`CREATE
    TABLE IF NOT EXISTS`), so a Node, PHP, or Elixir process can make them in
    any order. Statements are not logged (they would fill an app's debug log
    with a line for every tracker hit).

    On SQLite keep ecto_sqlite3's `journal_mode: :wal` and give the repo a
    `busy_timeout` of at least 5000, as the SDK's SQLite store sets them.
    Runlight turns on `secure_delete` (FAST) itself before each statement that
    deletes or overwrites rows, and at the start of each transaction, so a
    deleted salt does not linger in the file's free space. An in-memory
    database is one per connection, so a `database: ":memory:"`
    repo needs `pool_size: 1`. On MySQL and MariaDB the tables use the binary
    collation `utf8mb4_0900_bin`, which MariaDB has from 11.4.
    """

    @behaviour Runlight.Db

    alias Runlight.Db
    alias Runlight.JS.Object

    # Arbitrary but fixed, so every Runlight process takes the same lock to create tables.
    @migration_lock 7_331_906

    # The session's sql_mode as it was, less NO_BACKSLASH_ESCAPES, wherever it sits in the list.
    @no_backslash_escapes_off "SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',NO_BACKSLASH_ESCAPES,', ','))"

    @doc "A `Runlight.Db` over the repo."
    @spec new(keyword()) :: Db.t()
    def new(opts) do
      repo = Keyword.fetch!(opts, :repo)

      unless is_atom(repo) and Code.ensure_loaded?(repo) and function_exported?(repo, :__adapter__, 0),
        do: raise(ArgumentError, "Runlight.Db.Ecto needs :repo to be an Ecto repo, not #{inspect(repo)}")

      dialect =
        case repo.__adapter__() do
          Ecto.Adapters.SQLite3 -> :sqlite
          Ecto.Adapters.Postgres -> :postgres
          Ecto.Adapters.MyXQL -> :mysql
          other -> raise ArgumentError, "Runlight.Db.Ecto does not support the #{inspect(other)} adapter"
        end

      %Db{module: __MODULE__, dialect: dialect, state: %{repo: repo, dynamic: Keyword.get(opts, :dynamic_repo)}}
    end

    defp with_repo(%Db{state: %{repo: repo, dynamic: nil}}, fun), do: fun.(repo)

    defp with_repo(%Db{state: %{repo: repo, dynamic: dyn}}, fun) do
      previous = repo.put_dynamic_repo(dyn)

      try do
        fun.(repo)
      after
        repo.put_dynamic_repo(previous)
      end
    end

    defp query(%Db{dialect: dialect} = db, sql, params) do
      with_repo(db, fn repo ->
        result =
          case dialect do
            :sqlite ->
              run = fn -> repo.query(sql, Enum.map(params, &sqlite_value/1), log: false) end
              if sqlite_frees?(sql), do: sqlite_checkout(repo, run), else: run.()

            :postgres ->
              repo.query(Db.postgres_text(sql, params), [], log: false)

            :mysql ->
              mysql_checkout(repo, fn -> repo.query(Db.mysql_text(sql, params), [], log: false, query_type: :text) end)
          end

        case result do
          {:ok, result} -> result
          {:error, error} -> raise error
        end
      end)
    end

    # Values are escaped with backslashes, which a server set to NO_BACKSLASH_ESCAPES reads as text, so a quote could
    # end the value early. Every connection drops that one mode before Runlight's statements run on it, an app's own
    # repo's too. A pooled connection cannot be told from the next one before a statement runs on it, so the mode is
    # dropped once for each checkout, which a transaction holds for all of its statements.
    defp mysql_checkout(repo, fun) do
      key = {__MODULE__, :mysql_checkout, repo.get_dynamic_repo()}

      if Process.get(key) do
        fun.()
      else
        repo.checkout(
          fn ->
            case repo.query(@no_backslash_escapes_off, [], log: false, query_type: :text) do
              {:ok, _} -> :ok
              {:error, error} -> raise error
            end

            Process.put(key, true)

            try do
              fun.()
            after
              Process.delete(key)
            end
          end,
          timeout: :infinity
        )
      end
    end

    # Whether a statement can leave a deleted or overwritten row in SQLite's free pages.
    defp sqlite_frees?(sql),
      do: Regex.match?(~r/\A\s*(DELETE|UPDATE|REPLACE)\b|\bON\s+CONFLICT\b|\bOR\s+REPLACE\b/i, sql)

    # Deleted rows, such as a day's salt once it is gone, are overwritten where that costs no extra writes, so they
    # do not linger in the file's free space. The setting belongs to the connection, which ecto_sqlite3 opens with
    # it off, so it is turned on once for each checkout that may delete something, as MySQL's mode is dropped.
    defp sqlite_checkout(repo, fun) do
      key = {__MODULE__, :sqlite_checkout, repo.get_dynamic_repo()}

      if Process.get(key) do
        fun.()
      else
        repo.checkout(
          fn ->
            case repo.query("PRAGMA secure_delete = FAST", [], log: false) do
              {:ok, _} -> :ok
              {:error, error} -> raise error
            end

            Process.put(key, true)

            try do
              fun.()
            after
              Process.delete(key)
            end
          end,
          timeout: :infinity
        )
      end
    end

    # SQLite keeps a whole number as INTEGER and anything else as REAL, as better-sqlite3 binds them once the
    # store makes safe integers BigInts.
    defp sqlite_value(true), do: 1
    defp sqlite_value(false), do: 0
    defp sqlite_value(v), do: v

    @impl Db
    def all(db, sql, params) do
      result = query(db, sql, params)

      case result do
        %{columns: columns, rows: rows} when is_list(columns) and is_list(rows) ->
          Enum.map(rows, fn row -> %Object{pairs: Enum.zip(columns, Enum.map(row, &value/1))} end)

        _ ->
          []
      end
    end

    # Bytes from a text column that are not UTF-8 read as U+FFFD, as the SDK's drivers decode them.
    defp value(v) when is_binary(v), do: Runlight.JS.scrub(v)
    defp value(v), do: v

    @impl Db
    def run(db, sql, params) do
      _ = query(db, sql, params)
      :ok
    end

    @impl Db
    def affected(db, sql, params) do
      case query(db, sql, params) do
        %{num_rows: n} when is_integer(n) -> n
        _ -> 0
      end
    end

    @impl Db
    def transaction(%Db{dialect: dialect} = db, fun) do
      with_repo(db, fn repo ->
        run_in = fn ->
          case repo.transaction(fn -> fun.(db) end, log: false, timeout: :infinity) do
            {:ok, value} -> value
            {:error, reason} -> raise "Runlight: the transaction was rolled back: #{inspect(reason)}"
          end
        end

        cond do
          dialect == :mysql and not repo.in_transaction?() ->
            mysql_checkout(repo, fn ->
              # As Postgres does by default: each statement sees what was committed before it began, and
              # InnoDB takes no gap locks, so two writers to neighbouring rows do not deadlock.
              {:ok, _} =
                repo.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", [], log: false, query_type: :text)

              run_in.()
            end)

          dialect == :sqlite and not repo.in_transaction?() ->
            sqlite_checkout(repo, run_in)

          true ->
            run_in.()
        end
      end)
    end

    @impl Db
    def exclusive(%Db{dialect: :sqlite} = db, fun), do: fun.(db)

    def exclusive(%Db{dialect: :postgres} = db, fun) do
      with_repo(db, fn repo ->
        repo.checkout(
          fn ->
            # Asked for again and again rather than waited on: a waiting statement would hold up an index being
            # built CONCURRENTLY by whoever has the lock, and the two would wait on each other for good.
            # Up to the lock wait, so a request does not wait on a long index build for good.
            wait = Runlight.Store.lock_wait_ms()
            until = System.monotonic_time(:millisecond) + wait

            wait_for = fn wait_for ->
              case repo.query("SELECT pg_try_advisory_lock(#{@migration_lock}) AS ok", [], log: false) do
                {:ok, %{rows: [[true]]}} ->
                  :ok

                {:ok, _} ->
                  if System.monotonic_time(:millisecond) >= until, do: raise(Runlight.TablesBusyError, waited: wait)
                  Process.sleep(100)
                  wait_for.(wait_for)

                {:error, e} ->
                  raise e
              end
            end

            wait_for.(wait_for)

            try do
              fun.(db)
            after
              # A lost connection ends its session, and the lock with it.
              _ = repo.query("SELECT pg_advisory_unlock(#{@migration_lock})", [], log: false)
            end
          end,
          timeout: :infinity
        )
      end)
    end

    def exclusive(%Db{dialect: :mysql} = db, fun) do
      with_repo(db, fn repo ->
        mysql_checkout(
          repo,
          fn ->
            # One lock per database, so installs sharing a server do not wait on each other. Lock names are 64
            # characters at most.
            name = "CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48))"
            # Up to the lock wait, so a request does not wait on a long index build for good.
            wait = Runlight.Store.lock_wait_ms()
            until = System.monotonic_time(:millisecond) + wait

            wait_for = fn wait_for ->
              left = (until - System.monotonic_time(:millisecond)) |> Kernel./(1000) |> Float.ceil() |> trunc()

              case repo.query("SELECT GET_LOCK(#{name}, #{left |> min(5) |> max(1)}) AS ok", [],
                     log: false,
                     query_type: :text
                   ) do
                {:ok, %{rows: [[1]]}} ->
                  :ok

                {:ok, %{rows: [[nil]]}} ->
                  raise "Runlight: MySQL refused the lock for creating tables"

                # Not got in time: another process is creating the tables. Ask again, until the wait is up.
                {:ok, _} ->
                  if System.monotonic_time(:millisecond) >= until, do: raise(Runlight.TablesBusyError, waited: wait)
                  wait_for.(wait_for)

                {:error, e} ->
                  raise e
              end
            end

            wait_for.(wait_for)

            try do
              fun.(db)
            after
              _ = repo.query("DO RELEASE_LOCK(#{name})", [], log: false, query_type: :text)
            end
          end
        )
      end)
    end
  end
end

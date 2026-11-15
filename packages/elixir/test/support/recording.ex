defmodule Runlight.Test.Recording do
  @moduledoc false
  # Repos that stand in front of the test repos and keep every statement handed to the driver, with its values,
  # exactly as `Runlight.Db.Ecto` sends them, so a test can see that no value was written into a statement.
  # Runlight sends no telemetry for its statements, so this is the one place they can be seen.

  @table :runlight_recorded

  @doc "Starts keeping statements, from none."
  def start do
    if :ets.whereis(@table) == :undefined, do: :ets.new(@table, [:named_table, :public, :duplicate_bag])
    :ets.delete_all_objects(@table)
    :ok
  end

  @doc "Every statement kept since start/0, as `{sql, params}`."
  def statements, do: for({:statement, sql, params} <- :ets.tab2list(@table), do: {sql, params})

  @doc false
  def keep(sql, params) do
    if :ets.whereis(@table) != :undefined, do: :ets.insert(@table, {:statement, IO.iodata_to_binary(sql), params})
    :ok
  end

  @doc "The store over the same database, through the repo that keeps its statements."
  def over(%Runlight.Store{} = store) do
    inner =
      case store.db do
        %Runlight.Db{module: Runlight.Db.Prefixed, state: %{inner: inner}} -> inner
        db -> db
      end

    repo =
      case inner.state.repo do
        Runlight.Test.SqliteRepo -> Runlight.Test.RecordingSqliteRepo
        Runlight.Test.PgRepo -> Runlight.Test.RecordingPgRepo
        Runlight.Test.MyRepo -> Runlight.Test.RecordingMyRepo
      end

    Runlight.Store.ecto(
      repo: repo,
      dynamic_repo: inner.state.dynamic,
      prefix: Runlight.Db.Prefixed.prefix_of(store.db)
    )
  end

  defmacro __using__(repo: repo) do
    quote do
      @repo unquote(repo)
      def __adapter__, do: @repo.__adapter__()

      def query(sql, params \\ [], opts \\ []) do
        Runlight.Test.Recording.keep(sql, params)
        @repo.query(sql, params, opts)
      end

      def checkout(fun, opts \\ []), do: @repo.checkout(fun, opts)
      def transaction(fun, opts \\ []), do: @repo.transaction(fun, opts)
      def in_transaction?, do: @repo.in_transaction?()
      def get_dynamic_repo, do: @repo.get_dynamic_repo()
      def put_dynamic_repo(dynamic), do: @repo.put_dynamic_repo(dynamic)
    end
  end
end

defmodule Runlight.Test.RecordingSqliteRepo do
  @moduledoc false
  use Runlight.Test.Recording, repo: Runlight.Test.SqliteRepo
end

defmodule Runlight.Test.RecordingPgRepo do
  @moduledoc false
  use Runlight.Test.Recording, repo: Runlight.Test.PgRepo
end

defmodule Runlight.Test.RecordingMyRepo do
  @moduledoc false
  use Runlight.Test.Recording, repo: Runlight.Test.MyRepo
end

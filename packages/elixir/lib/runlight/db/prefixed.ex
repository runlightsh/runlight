defmodule Runlight.Db.Prefixed do
  @moduledoc """
  A `Runlight.Db` whose tables and indexes start with a prefix in place of
  `rl_`, such as `wp_rl_` inside WordPress, so two apps sharing one database
  each keep a set of their own (the SDK's prefixed()). Runlight's SQL names
  every table and index `rl_` and something, and those names alone are
  rewritten on the way through, in each statement and in the names a schema
  check compares as text. A store given a prefix puts one in front of its Db,
  so the accounts and importers that reach the Db through the store follow it
  too.

      Runlight.Db.Prefixed.new(Runlight.Db.Ecto.new(repo: MyApp.Repo), "wp_rl_")

  Values bound as parameters are not rewritten.
  """

  @behaviour Runlight.Db

  alias Runlight.Db

  @doc """
  The Db with every `rl_` name under `prefix`: up to 32 letters, digits, and
  underscores, not starting with a digit.
  """
  @spec new(Db.t(), String.t()) :: Db.t()
  def new(%Db{} = inner, prefix) do
    # A name in a statement, and short enough that the longest index name stays inside MySQL's 64.
    unless is_binary(prefix) and Regex.match?(~r/\A[A-Za-z_][A-Za-z0-9_]{0,31}\z/, prefix),
      do:
        raise(
          ArgumentError,
          "Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit"
        )

    %Db{module: __MODULE__, dialect: inner.dialect, metered: inner.metered, state: %{inner: inner, prefix: prefix}}
  end

  @doc "The prefix a Db was made with, or nil when it is not a prefixed one."
  @spec prefix_of(Db.t()) :: String.t() | nil
  def prefix_of(%Db{module: __MODULE__, state: %{prefix: prefix}}), do: prefix
  def prefix_of(%Db{}), do: nil

  defp sql(%Db{state: %{prefix: prefix}}, text), do: Regex.replace(~r/\brl_(?=[a-z])/, text, prefix)

  # The Db a transaction or lock hands over, under the same prefix: this one when it is the inner Db itself.
  defp wrap(%Db{state: %{inner: inner, prefix: prefix}} = outer, db),
    do: if(db == inner, do: outer, else: new(db, prefix))

  @impl Db
  def all(%Db{state: %{inner: inner}} = db, text, params), do: Db.all(inner, sql(db, text), params)

  @impl Db
  def run(%Db{state: %{inner: inner}} = db, text, params), do: Db.run(inner, sql(db, text), params)

  @impl Db
  def affected(%Db{state: %{inner: inner}} = db, text, params), do: Db.affected(inner, sql(db, text), params)

  @impl Db
  def transaction(%Db{state: %{inner: inner}} = db, fun), do: Db.transaction(inner, &fun.(wrap(db, &1)))

  @impl Db
  def exclusive(%Db{state: %{inner: inner}} = db, fun), do: Db.exclusive(inner, &fun.(wrap(db, &1)))
end

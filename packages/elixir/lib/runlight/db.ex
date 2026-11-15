defmodule Runlight.Db do
  @moduledoc """
  The little the store needs from a database: its dialect, and statements
  with `?` placeholders that answer rows. `Runlight.Db.Ecto` runs them through
  an app's own Ecto repo; anything else that implements the callbacks below
  can stand in.

  SQL is written with `?` placeholders and "double quotes" around a name that
  is a keyword somewhere. Each implementation turns that into what its
  database reads, and binds the values: no value is written into a
  statement. Postgres gets numbered placeholders, each cast to its value's
  type, and MySQL gets backticks for quoted names.
  """

  @enforce_keys [:module, :dialect, :state]
  defstruct [:module, :dialect, :state, metered: false]

  @type dialect :: :sqlite | :postgres | :mysql
  @type t :: %__MODULE__{module: module(), dialect: dialect(), state: term(), metered: boolean()}

  @doc "Rows as JavaScript objects, their keys in column order."
  @callback all(t(), String.t(), [term()]) :: [Runlight.JS.Object.t()]
  @callback run(t(), String.t(), [term()]) :: :ok
  @doc "How many rows an UPDATE or DELETE matched."
  @callback affected(t(), String.t(), [term()]) :: non_neg_integer()
  @doc "Runs `fun` in one transaction on one connection, committing what it did, or rolling back when it raises."
  @callback transaction(t(), (t() -> term())) :: term()
  @doc """
  Runs `fun` while holding a database-wide lock, so two processes starting at
  once do not race to create tables. Waits for the lock at most
  `Runlight.Store.lock_wait_ms/0`, then raises a `Runlight.TablesBusyError`.
  """
  @callback exclusive(t(), (t() -> term())) :: term()

  @doc "The dialect's name, as the SDK writes it."
  @spec dialect(t()) :: String.t()
  def dialect(%__MODULE__{dialect: d}), do: Atom.to_string(d)

  @spec all(t(), String.t(), [term()]) :: [Runlight.JS.Object.t()]
  def all(%__MODULE__{module: m} = db, sql, params \\ []), do: m.all(db, sql, params)

  @spec run(t(), String.t(), [term()]) :: :ok
  def run(%__MODULE__{module: m} = db, sql, params \\ []), do: m.run(db, sql, params)

  @spec affected(t(), String.t(), [term()]) :: non_neg_integer()
  def affected(%__MODULE__{module: m} = db, sql, params \\ []), do: m.affected(db, sql, params)

  @spec transaction(t(), (t() -> term())) :: term()
  def transaction(%__MODULE__{module: m} = db, fun), do: m.transaction(db, fun)

  @spec exclusive(t(), (t() -> term())) :: term()
  def exclusive(%__MODULE__{module: m} = db, fun), do: m.exclusive(db, fun)

  @doc "`?` placeholders to `$1, $2, ...`, leaving quoted text alone (the Postgres driver's numberPlaceholders)."
  @spec number_placeholders(String.t()) :: String.t()
  def number_placeholders(sql) do
    {out, _, _} =
      for <<ch::utf8 <- sql>>, reduce: {[], 0, nil} do
        {out, n, quote} ->
          cond do
            quote != nil -> {[<<ch::utf8>> | out], n, if(ch == quote, do: nil, else: quote)}
            ch in [?', ?"] -> {[<<ch::utf8>> | out], n, ch}
            ch == ?? -> {["$#{n + 1}" | out], n + 1, nil}
            true -> {[<<ch::utf8>> | out], n, nil}
          end
      end

    out |> Enum.reverse() |> IO.iodata_to_binary()
  end

  @doc """
  The statement as Postgres reads it, and the values to bind to it: each `?`
  becomes `$1`, `$2`, and so on, cast to the type of the value it stands for
  (text, bigint, double precision, or boolean), since Postgrex sends every
  value in the type it has here. A nil is written as `NULL`, which is no
  value, so it takes any column's type. No value is ever written into the
  statement.
  """
  @spec postgres_bound(String.t(), [term()]) :: {String.t(), [term()]}
  def postgres_bound(sql, params) do
    {parts, bound} =
      scan(sql, params, false, fn value, bound ->
        case postgres_value(value) do
          :null -> {"NULL", bound}
          {type, value} -> {"$#{length(bound) + 1}::#{type}", [value | bound]}
        end
      end)

    {IO.iodata_to_binary(parts), Enum.reverse(bound)}
  end

  # The widest whole number a BIGINT holds.
  @int8 9_223_372_036_854_775_807

  defp postgres_value(nil), do: :null
  defp postgres_value(v) when is_boolean(v), do: {"boolean", v}
  defp postgres_value(v) when is_integer(v) and v >= -@int8 - 1 and v <= @int8, do: {"bigint", v}
  defp postgres_value(v) when is_float(v), do: {"double precision", v}

  defp postgres_value(v) when is_binary(v) do
    if String.contains?(v, <<0>>), do: raise(ArgumentError, "Runlight: Postgres text cannot hold a zero byte")
    {"text", v}
  end

  # Anything else as the text JavaScript's String() gives it, as it was always sent.
  defp postgres_value(v), do: postgres_value(Runlight.JS.string(v))

  @doc """
  SQL written for SQLite and Postgres, as MySQL and MariaDB read it (the SDK's
  mysqlText, less its values), and the values to bind to it: a "quoted"
  identifier is quoted with backticks, and a backslash inside 'text' the
  statement itself holds is doubled, since MySQL reads it as an escape where
  standard SQL takes it literally. Each `?` stays a `?`, for the prepared
  statement to bind, so no value is ever written into the statement.
  """
  @spec mysql_bound(String.t(), [term()]) :: {String.t(), [term()]}
  def mysql_bound(sql, params) do
    {parts, bound} = scan(sql, params, true, fn value, bound -> {"?", [mysql_value(value) | bound]} end)
    {IO.iodata_to_binary(parts), Enum.reverse(bound)}
  end

  defp mysql_value(v) when is_nil(v) or is_boolean(v) or is_integer(v) or is_float(v) or is_binary(v), do: v
  defp mysql_value(%{__struct__: Decimal} = v), do: v
  defp mysql_value(other), do: Runlight.JS.string(other)

  # Walks a statement, leaving what is quoted alone (but for MySQL's own quoting), and hands each placeholder's
  # value to `place`, which answers what to write there and the values bound so far.
  defp scan(sql, params, mysql, place) do
    {out, rest, _quote, bound} =
      for <<ch::utf8 <- sql>>, reduce: {[], params, nil, []} do
        {out, rest, quote, bound} ->
          cond do
            quote != nil ->
              cond do
                ch == quote -> {[if(mysql and ch == ?", do: "`", else: <<ch::utf8>>) | out], rest, nil, bound}
                mysql and quote == ?' and ch == ?\\ -> {["\\\\" | out], rest, quote, bound}
                mysql and quote == ?" and ch == ?` -> {["``" | out], rest, quote, bound}
                true -> {[<<ch::utf8>> | out], rest, quote, bound}
              end

            ch in [?', ?"] or (mysql and ch == ?`) ->
              {[if(mysql and ch == ?", do: "`", else: <<ch::utf8>>) | out], rest, ch, bound}

            ch == ?? ->
              case rest do
                [v | more] ->
                  {text, bound} = place.(v, bound)
                  {[text | out], more, nil, bound}

                [] ->
                  raise ArgumentError, "Runlight: a statement has more placeholders than values"
              end

            true ->
              {[<<ch::utf8>> | out], rest, nil, bound}
          end
      end

    if rest != [], do: raise(ArgumentError, "Runlight: a statement has more values than placeholders")
    {Enum.reverse(out), bound}
  end
end

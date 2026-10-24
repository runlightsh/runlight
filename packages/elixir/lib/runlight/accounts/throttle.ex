defmodule Runlight.Accounts.Throttle do
  @moduledoc false
  # Internal. Counts failed sign-ins under a key and refuses more than a few
  # in a while (the SDK's Throttle). Keys are hashed with a key made when the
  # throttle is, so the table never holds an address or an email as it was
  # given. A throttle lives in an instance's state table under a name of its
  # own.

  alias Runlight.Crypto
  alias Runlight.State

  # The most sign-in keys the throttle remembers at once.
  @max_throttled 10_000

  defstruct [:table, :name, :limit, :window_ms, :salt]

  @type t :: %__MODULE__{}

  @doc "A throttle of `limit` tries in `window_ms`, in `table`, under `name`."
  @spec new(:ets.tid(), term(), pos_integer(), pos_integer()) :: t()
  def new(table, name, limit \\ 10, window_ms \\ 15 * 60_000) do
    salt =
      case State.get(table, {:throttle_salt, name}) do
        nil -> State.put(table, {:throttle_salt, name}, Crypto.random_bytes(16))
        salt -> salt
      end

    %__MODULE__{table: table, name: name, limit: limit, window_ms: window_ms, salt: salt}
  end

  defp id(t, key), do: t.salt |> then(&Crypto.hmac(:sha256, &1, key)) |> Crypto.base64url() |> binary_part(0, 22)

  defp entry(t, id), do: State.get(t.table, {:throttle, t.name, id})

  defp blocked_id?(t, id, now) do
    case entry(t, id) do
      %{count: count, until: until} when until > now -> count >= t.limit
      _ -> false
    end
  end

  defp locked(t, fun), do: State.one_at_a_time(t.table, {:throttle, t.name}, fun)

  @doc "Whether the key is at its limit now."
  @spec blocked?(t(), String.t(), integer()) :: boolean()
  def blocked?(t, key, now), do: blocked_id?(t, id(t, key), now)

  @doc """
  Counts a try before the slow check it guards, so a burst cannot get past
  the limit. False, counting nothing, when the key is already at its limit.
  A try that turns out right is taken back with forgive/2.
  """
  @spec take(t(), String.t(), integer()) :: boolean()
  def take(t, key, now) do
    id = id(t, key)

    locked(t, fn ->
      if blocked_id?(t, id, now) do
        false
      else
        count(t, id, now)
        true
      end
    end)
  end

  @doc "Takes back one counted try, for one that turned out right."
  @spec forgive(t(), String.t()) :: :ok
  def forgive(t, key) do
    id = id(t, key)

    locked(t, fn ->
      case entry(t, id) do
        %{count: count} = e when count > 0 -> State.put(t.table, {:throttle, t.name, id}, %{e | count: count - 1})
        _ -> :ok
      end
    end)

    :ok
  end

  @spec fail(t(), String.t(), integer()) :: :ok
  def fail(t, key, now) do
    id = id(t, key)
    locked(t, fn -> count(t, id, now) end)
    :ok
  end

  @spec clear(t(), String.t()) :: :ok
  def clear(t, key) do
    id = id(t, key)

    locked(t, fn ->
      if entry(t, id) do
        State.delete(t.table, {:throttle, t.name, id})
        State.bump(t.table, {:throttle_size, t.name}, -1)
      end
    end)

    :ok
  end

  defp count(t, id, now) do
    case entry(t, id) do
      %{until: until} = e when until > now ->
        State.put(t.table, {:throttle, t.name, id}, %{e | count: e.count + 1})

      e ->
        State.put(t.table, {:throttle, t.name, id}, %{
          count: 1,
          until: now + t.window_ms,
          seq: :erlang.unique_integer([:monotonic])
        })

        if e == nil and State.bump(t.table, {:throttle_size, t.name}) > @max_throttled, do: evict(t, now)
    end

    :ok
  end

  # The keys are counted as they come and go, and the table is looked through only once there are more than the
  # ceiling. Expired entries go first, then those with the fewest tries, oldest first, down to nine tenths of the
  # ceiling so this runs seldom. A flood of made-up names has one try each, so it cannot wipe out a block, or the count
  # of a name someone is close to blocking. The count is set again from what is left.
  defp evict(t, now) do
    entries = :ets.match_object(t.table, {{:throttle, t.name, :_}, :_})
    {expired, live} = Enum.split_with(entries, fn {_, e} -> e.until <= now end)
    Enum.each(expired, fn {k, _} -> :ets.delete(t.table, k) end)
    over = if length(live) > @max_throttled, do: length(live) - div(@max_throttled * 9, 10), else: 0

    if over > 0 do
      live
      |> Enum.sort_by(fn {_, e} -> {e.count, e.seq} end)
      |> Enum.take(over)
      |> Enum.each(fn {k, _} -> :ets.delete(t.table, k) end)
    end

    State.put(t.table, {:throttle_size, t.name}, length(live) - max(over, 0))
    :ok
  end
end

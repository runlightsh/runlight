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

defmodule Runlight.Accounts.Lockout do
  @moduledoc false
  # Internal. Counts wrong second-factor codes under a key and locks it for longer each time the tries run out
  # (the SDK's Lockout): five tries, then fifteen minutes, then thirty, then an hour, doubling up to a day. A
  # right code clears the key, and so does a week with no lock and no try. A lock always ends, at most a day
  # later, so nobody is shut out for good. Keys are hashed with a key made when the lockout is, as Throttle's are.

  alias Runlight.Crypto
  alias Runlight.State

  # The most keys remembered before those long forgotten are looked for.
  @max_locked 10_000

  defstruct [:table, :name, :limit, :window_ms, :longest_ms, :forget_ms, :salt]

  @type t :: %__MODULE__{}

  @doc "A lockout of `limit` tries in `table`, under `name`."
  @spec new(:ets.tid(), term(), pos_integer(), pos_integer(), pos_integer(), pos_integer()) :: t()
  def new(table, name, limit \\ 5, window_ms \\ 15 * 60_000, longest_ms \\ 86_400_000, forget_ms \\ 7 * 86_400_000) do
    salt =
      case State.get(table, {:lockout_salt, name}) do
        nil -> State.put(table, {:lockout_salt, name}, Crypto.random_bytes(16))
        salt -> salt
      end

    %__MODULE__{
      table: table,
      name: name,
      limit: limit,
      window_ms: window_ms,
      longest_ms: longest_ms,
      forget_ms: forget_ms,
      salt: salt
    }
  end

  defp id(t, key), do: t.salt |> then(&Crypto.hmac(:sha256, &1, key)) |> Crypto.base64url() |> binary_part(0, 22)

  defp locked(t, fun), do: State.one_at_a_time(t.table, {:lockout, t.name}, fun)

  @doc """
  Counts a try before the code is checked, so a burst cannot get past the limit. False, counting nothing,
  while the key is locked. The try that uses up the last one starts the lock.
  """
  @spec take(t(), String.t(), integer()) :: boolean()
  def take(t, key, now) do
    at = {:lockout, t.name, id(t, key)}

    locked(t, fn ->
      known = State.get(t.table, at)
      entry = if known != nil and known.forget <= now, do: nil, else: known

      if entry != nil and entry.count >= t.limit and entry.until > now do
        false
      else
        entry =
          cond do
            entry == nil -> %{count: 0, until: now + t.window_ms, locks: 0, forget: 0}
            entry.until <= now -> %{entry | count: 0, until: now + t.window_ms}
            true -> entry
          end

        entry = %{entry | count: entry.count + 1}

        entry =
          if entry.count >= t.limit,
            do: %{
              entry
              | until: now + min(t.window_ms * Integer.pow(2, entry.locks), t.longest_ms),
                locks: entry.locks + 1
            },
            else: entry

        State.put(t.table, at, %{entry | forget: entry.until + t.forget_ms})

        # Keys are accounts that passed the password step, so there are few; anything long forgotten goes.
        if known == nil and State.bump(t.table, {:lockout_size, t.name}) > @max_locked, do: sweep(t, now)
        true
      end
    end)
  end

  @doc "Forgets a key, for a code that turned out right."
  @spec clear(t(), String.t()) :: :ok
  def clear(t, key) do
    at = {:lockout, t.name, id(t, key)}

    locked(t, fn ->
      if State.get(t.table, at) do
        State.delete(t.table, at)
        State.bump(t.table, {:lockout_size, t.name}, -1)
      end
    end)

    :ok
  end

  defp sweep(t, now) do
    entries = :ets.match_object(t.table, {{:lockout, t.name, :_}, :_})
    {gone, kept} = Enum.split_with(entries, fn {_, e} -> e.forget <= now end)
    Enum.each(gone, fn {k, _} -> :ets.delete(t.table, k) end)
    State.put(t.table, {:lockout_size, t.name}, length(kept))
    :ok
  end
end

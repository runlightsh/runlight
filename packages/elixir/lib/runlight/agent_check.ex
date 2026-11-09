defmodule Runlight.AgentCheck do
  @moduledoc false
  # Internal. Checks a request that names an AI agent against the addresses
  # that agent's company publishes (the SDK's agentcheck.ts). Every list is in
  # the same shape, {"prefixes": [{"ipv4Prefix": "a.b.c.d/n"} or
  # {"ipv6Prefix": "x::/n"}]}.
  #
  # The answer is "verified" when the address is in the list, "mismatch" when
  # the company publishes a list and the address is not in it, and "" when
  # there is nothing to check against: no list for that agent, or no usable
  # address. The address is only compared, never kept.

  import Bitwise

  alias Runlight.Http.Response
  alias Runlight.JS
  alias Runlight.JS.Object

  # A list of more prefixes than this, or a reply bigger than @max_list_bytes, is not a list we read.
  @max_prefixes 20_000
  @max_list_bytes 4_000_000

  @typedoc "An address as `{4, n}` or `{6, n}`."
  @type address :: {4 | 6, non_neg_integer()}

  @typedoc "A prefix as `{family, base, bits}`."
  @type prefix :: {4 | 6, non_neg_integer(), non_neg_integer()}

  defp ipv4(text) do
    parts = String.split(text, ".")

    if length(parts) == 4 do
      Enum.reduce_while(parts, 0, fn part, n ->
        if Regex.match?(~r/\A\d{1,3}\z/, part) and String.to_integer(part) <= 255,
          do: {:cont, n * 256 + String.to_integer(part)},
          else: {:halt, nil}
      end)
    end
  end

  defp ipv6(text) do
    if Regex.match?(~r/\A[0-9a-f:.]+\z/i, text) and length(String.split(text, "::")) <= 2 do
      # A dotted IPv4 tail ("::ffff:1.2.3.4") stands for the last two groups.
      case dotted_tail(text) do
        nil -> nil
        groups -> ipv6_groups(groups)
      end
    end
  end

  defp dotted_tail(text) do
    if String.contains?(text, ".") do
      {head, tail} = split_last_colon(text)

      case ipv4(tail) do
        nil ->
          nil

        n ->
          head <>
            String.downcase(Integer.to_string(n >>> 16, 16)) <>
            ":" <> String.downcase(Integer.to_string(n &&& 0xFFFF, 16))
      end
    else
      text
    end
  end

  # The text up to and including its last colon, and what follows it.
  defp split_last_colon(text) do
    case :binary.matches(text, ":") do
      [] ->
        {"", text}

      matches ->
        {at, _} = List.last(matches)
        {binary_part(text, 0, at + 1), binary_part(text, at + 1, byte_size(text) - at - 1)}
    end
  end

  defp ipv6_groups(groups) do
    {head, rest} =
      case String.split(groups, "::") do
        [head] -> {head, nil}
        [head, rest] -> {head, rest}
        _ -> {nil, nil}
      end

    left = if head in [nil, ""], do: [], else: String.split(head, ":")
    right = if rest in [nil, ""], do: [], else: String.split(rest, ":")
    missing = 8 - length(left) - length(right)

    if head != nil and ((rest == nil and missing == 0) or (rest != nil and missing >= 1)) do
      fill = if rest == nil, do: [], else: List.duplicate("0", missing)

      Enum.reduce_while(left ++ fill ++ right, 0, fn group, n ->
        if Regex.match?(~r/\A[0-9a-f]{1,4}\z/i, group),
          do: {:cont, n <<< 16 ||| String.to_integer(group, 16)},
          else: {:halt, nil}
      end)
    end
  end

  @doc """
  An address as the check reads it: surrounding space, [brackets], and an
  IPv6 zone ("%eth0") are ignored, and an IPv4 address written as IPv6
  (::ffff:1.2.3.4) is read as IPv4. Nil when it is not one.
  """
  @spec parse_address(String.t()) :: address() | nil
  def parse_address(text) when is_binary(text) do
    s = JS.trim(text)

    s =
      if String.starts_with?(s, "[") and String.ends_with?(s, "]") and byte_size(s) >= 2,
        do: binary_part(s, 1, byte_size(s) - 2),
        else: s

    s = s |> String.split("%", parts: 2) |> hd()

    cond do
      s == "" ->
        nil

      not String.contains?(s, ":") ->
        case ipv4(s) do
          nil -> nil
          n -> {4, n}
        end

      true ->
        case ipv6(s) do
          nil -> nil
          n when n >>> 32 == 0xFFFF -> {4, n &&& 0xFFFFFFFF}
          n -> {6, n}
        end
    end
  end

  def parse_address(_), do: nil

  # A prefix such as 20.171.206.0/24 or 2600:1f28::/56, or nil. Bits past the length are ignored.
  @doc false
  @spec parse_prefix(String.t()) :: prefix() | nil
  def parse_prefix(text) do
    with [head, bits_text] <- String.split(text, "/", parts: 2),
         true <- Regex.match?(~r/\A\d{1,3}\z/, bits_text) do
      bits = String.to_integer(bits_text)

      if String.contains?(head, ":") do
        n = ipv6(head)
        if n != nil and bits <= 128, do: {6, n, bits}
      else
        n = ipv4(head)
        if n != nil and bits <= 32, do: {4, n, bits}
      end
    else
      _ -> nil
    end
  end

  defp covers({v, base, bits}, {v, n}) do
    shift = if(v == 4, do: 32, else: 128) - bits
    n >>> shift == base >>> shift
  end

  defp covers(_prefix, _address), do: false

  @doc """
  The prefixes in a published list, or nil when the reply is not a list in
  the expected shape (not an object, no prefixes, an entry that is not a
  prefix, or too many). One bad entry rejects the whole list, so a half
  broken download never replaces a good copy.
  """
  @spec read_range_list(term()) :: [String.t()] | nil
  def read_range_list(%Object{} = body) do
    case JS.prop(body, "prefixes") do
      prefixes when is_list(prefixes) and prefixes != [] and length(prefixes) <= @max_prefixes ->
        texts = Enum.map(prefixes, &entry_prefix/1)
        if Enum.all?(texts, &is_binary/1), do: texts

      _ ->
        nil
    end
  end

  def read_range_list(_), do: nil

  defp entry_prefix(%Object{} = entry) do
    {text, family} =
      case {JS.prop(entry, "ipv4Prefix"), JS.prop(entry, "ipv6Prefix")} do
        {v4, _} when is_binary(v4) -> {v4, 4}
        {_, v6} when is_binary(v6) -> {v6, 6}
        _ -> {nil, nil}
      end

    if text do
      text = JS.trim(text)

      case parse_prefix(text) do
        {^family, _, _} -> text
        _ -> nil
      end
    end
  end

  defp entry_prefix(_), do: nil

  @doc """
  Downloads one published list through `fetch` (a fetcher, see
  `Runlight.Fetch`). Nil when it cannot be fetched or read; the caller keeps
  what it had.
  """
  @spec download_range_list(Runlight.Fetch.fetcher(), String.t(), pos_integer()) :: [String.t()] | nil
  def download_range_list(fetch, url, timeout_ms \\ 15_000) do
    opts = [
      headers: [{"accept", "application/json"}, {"user-agent", "Runlight (+https://runlight.sh)"}],
      redirect: :follow,
      timeout: timeout_ms,
      max_bytes: @max_list_bytes
    ]

    with {:ok, %Response{} = response} <- fetch.(url, opts),
         true <- Response.ok?(response),
         true <- JS.number(Response.header(response, "content-length") || 0) |> fits?(),
         text = Response.text(response),
         true <- JS.len16(text) <= @max_list_bytes,
         {:ok, body} <- JS.parse(text) do
      read_range_list(body)
    else
      _ -> nil
    end
  rescue
    _ -> nil
  catch
    _, _ -> nil
  end

  # Whether a content-length leaves the reply small enough to read; one that is not a number says nothing.
  defp fits?(n) when is_number(n), do: n <= @max_list_bytes
  defp fits?(_), do: true

  @doc "The prefixes of a list, parsed once, to check addresses against."
  @spec compile([String.t()]) :: [prefix()]
  def compile(list), do: list |> Enum.map(&parse_prefix/1) |> Enum.reject(&is_nil/1)

  @doc "Whether `ip` is inside any of the prefixes. False for an address that cannot be read."
  @spec in_ranges?(String.t(), [String.t()] | [prefix()]) :: boolean()
  def in_ranges?(ip, list) do
    case parse_address(ip) do
      nil -> false
      address -> Enum.any?(compiled(list), &covers(&1, address))
    end
  end

  @doc """
  The check for one request that names `agent`, made from `ip`, against
  `lists` (a map of list URL to its prefixes, as strings or compiled): "verified",
  "mismatch", or "".
  """
  @spec check_agent(map(), String.t(), map()) :: String.t()
  def check_agent(agent, ip, lists) do
    list = if is_binary(agent[:ranges]), do: Map.get(lists, agent[:ranges])
    address = if is_binary(ip), do: parse_address(ip)

    cond do
      list == nil or address == nil -> ""
      Enum.any?(compiled(list), &covers(&1, address)) -> "verified"
      true -> "mismatch"
    end
  end

  defp compiled([first | _] = list) when is_binary(first), do: compile(list)
  defp compiled(list), do: list
end

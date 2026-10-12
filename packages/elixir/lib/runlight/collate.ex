defmodule Runlight.Collate do
  @moduledoc false
  # Internal. Text compared as `a.localeCompare(b)` compares it in ICU's root
  # collation, closely enough for sorting names: letters first without regard
  # to accents or case, then accents, then lowercase before uppercase, and the
  # code points last.

  @doc "-1, 0, or 1, as `localeCompare` answers."
  @spec compare(String.t(), String.t()) :: -1 | 0 | 1
  def compare(a, b) when a == b, do: 0

  def compare(a, b) do
    case cmp(primary(a), primary(b)) do
      0 ->
        case cmp(secondary(a), secondary(b)) do
          0 ->
            case cmp(tertiary(a), tertiary(b)) do
              0 -> cmp(a, b)
              n -> n
            end

          n ->
            n
        end

      n ->
        n
    end
  end

  defp cmp(a, b) when a < b, do: -1
  defp cmp(a, b) when a > b, do: 1
  defp cmp(_, _), do: 0

  # ICU's root order of the printable ASCII characters that are neither digits nor letters, as Node's
  # localeCompare has them (the Python port holds the same list).
  @icu_ascii ~c" _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$"
  @icu_rank @icu_ascii |> Enum.with_index() |> Map.new()

  # Punctuation and spaces sort before digits, and digits before letters, as ICU orders them.
  defp primary(s) do
    s
    |> String.normalize(:nfd)
    |> String.replace(~r/\p{Mn}/u, "")
    |> String.downcase()
    |> String.to_charlist()
    |> Enum.map(fn c ->
      cond do
        c in ?a..?z -> 3_000_000 + c
        c in ?0..?9 -> 2_000_000 + c
        c < 128 -> 1_000_000 + Map.get(@icu_rank, c, 1000 + c)
        true -> 3_000_000 + c
      end
    end)
  end

  defp secondary(s), do: s |> String.normalize(:nfd) |> String.downcase()

  defp tertiary(s), do: s |> String.to_charlist() |> Enum.map(fn c -> if c in ?A..?Z, do: {1, c}, else: {0, c} end)
end

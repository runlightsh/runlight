defmodule Runlight.Payload do
  @moduledoc false
  # Internal. What the tracker sends, after validation (the SDK's payload.ts).
  # Anything malformed is dropped.

  alias Runlight.JS
  alias Runlight.JS.Object
  alias Runlight.Url

  @max_body 8 * 1024
  # One engagement ping covers at most the 30 minutes a session can idle.
  @max_engaged_ms 30 * 60 * 1000
  @max_props 30

  @doc "The longest body a tracker hit can be."
  def max_body, do: @max_body

  # A string as it came, cut to `max` UTF-16 units: for a URL, which the parser then encodes.
  defp str(value, max) when is_binary(value), do: JS.slice(value, 0, max)
  defp str(_value, _max), do: ""

  @doc """
  Text as every database can keep it: without U+0000, which Postgres refuses, and with anything that is no
  character as U+FFFD (half a surrogate pair is already U+FFFD by the time JSON is read here).
  """
  @spec tidy(String.t()) :: String.t()
  def tidy(text), do: text |> JS.scrub() |> String.replace(<<0>>, "")

  @doc "Tidied text cut to `max` characters (code points), so a character such as an emoji is never cut in half."
  @spec clean_text(String.t(), non_neg_integer()) :: String.t()
  def clean_text(text, max) do
    clean = tidy(text)
    if JS.len16(clean) <= max, do: clean, else: clean |> String.codepoints() |> Enum.take(max) |> Enum.join()
  end

  # A string the tracker sent, as it is stored.
  defp stored(value, max) when is_binary(value), do: clean_text(value, max)
  defp stored(_value, _max), do: ""

  defp int(value, min, max) when is_integer(value) or is_float(value), do: value |> JS.round() |> max(min) |> min(max)
  defp int(_value, _min, _max), do: nil

  defp props(%Object{} = value) do
    {out, count} =
      Enum.reduce_while(Object.to_list(value), {Object.new(), 0}, fn {key, raw}, {out, count} ->
        if count >= @max_props do
          {:halt, {out, count}}
        else
          k = key |> tidy() |> JS.trim() |> clean_text(60)
          # A prop named __proto__ is kept like any other, as the reference's object without a prototype keeps it.
          put = fn v -> Object.put(out, k, v) end

          cond do
            k == "" -> {:cont, {out, count}}
            is_binary(raw) -> {:cont, {put.(clean_text(raw, 500)), count + 1}}
            is_integer(raw) or is_float(raw) -> {:cont, {put.(JS.string(raw)), count + 1}}
            is_boolean(raw) -> {:cont, {put.(JS.string(raw)), count + 1}}
            true -> {:cont, {out, count}}
          end
        end
      end)

    if count > 0, do: out
  end

  defp props(_), do: nil

  # The events the tracker sends on its own for a link that was followed, each with the link as `url`.
  @link_events ["Outbound link", "File download"]

  # An automatic link event's `url` without its query string or fragment, as page paths are kept, since tokens and
  # email addresses ride in them. Done here rather than in the tracker, which has no bytes to spare, and so a tracker
  # cached from before is held to it too.
  defp link_props(name, %Object{} = given) when name in @link_events do
    case given["url"] do
      url when is_binary(url) -> Object.put(given, "url", url |> String.split(["?", "#"], parts: 2) |> hd())
      _ -> given
    end
  end

  defp link_props(_name, given), do: given

  @doc "The tracker's hit, or nil when it is not one."
  @spec parse(String.t()) :: map() | nil
  def parse(text) do
    with true <- JS.len16(text) <= @max_body,
         {:ok, %Object{} = body} <- JS.parse(text),
         kind when kind in ["pageview", "event", "engagement"] <- body["k"],
         %Url{} = url <- Url.parse(str(body["u"], 2048)),
         true <- url.protocol in ["http:", "https:"],
         name = body["n"] |> stored(120) |> JS.trim(),
         false <- kind == "event" and name == "",
         pageview_id = str(body["i"], 32),
         true <- pageview_id == "" or Regex.match?(~r/\A[a-z0-9]+\z/i, pageview_id),
         false <- kind == "engagement" and pageview_id == "" do
      %{
        kind: kind,
        site: stored(body["s"], 64),
        url: url,
        referrer: str(body["r"], 2048),
        title: stored(body["t"], 500),
        screen_width: int(body["w"], 0, 20_000),
        screen_height: int(body["h"], 0, 20_000),
        language: stored(body["l"], 35),
        name: name,
        props: if(kind == "event", do: link_props(name, props(body["p"]))),
        pageview_id: pageview_id,
        engaged_ms: if(kind == "engagement", do: int(body["e"], 0, @max_engaged_ms) || 0, else: 0),
        scroll: int(body["d"], 0, 100)
      }
    else
      _ -> nil
    end
  end
end

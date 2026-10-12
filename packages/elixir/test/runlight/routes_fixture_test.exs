defmodule Runlight.RoutesFixtureTest do
  @moduledoc """
  Replays packages/php/tests/fixtures/routes.json, which
  scripts/php-fixtures-routes.mts writes from the TypeScript SDK: the
  dashboard's page, the tracker, refusals with their codes, and OAuth's
  documents, each answer byte for byte with every header, and the helpers
  routes.ts and oauth.ts export.
  """
  use ExUnit.Case, async: true

  alias Runlight.Http.Request
  alias Runlight.JS.Object
  alias Runlight.Routes
  alias Runlight.Test.Fixtures
  alias Runlight.Test.Stores

  @fixture Fixtures.php("routes.json")

  defp atoms(%Object{} = o), do: Map.new(Object.to_list(o), fn {k, v} -> {String.to_atom(k), atoms(v)} end)
  defp atoms(list) when is_list(list), do: Enum.map(list, &atoms/1)
  defp atoms(v), do: v

  defp snake(key), do: key |> Macro.underscore() |> String.to_atom()

  # Headers as the fixture holds them: one string per name, the values joined, and Set-Cookie as a list.
  defp headers(pairs) do
    pairs
    |> Enum.group_by(&String.downcase(elem(&1, 0)), &elem(&1, 1))
    |> Map.new(fn
      {"set-cookie", values} -> {"set-cookie", values}
      {name, values} -> {name, Enum.join(values, ", ")}
    end)
  end

  defp plain(%Object{} = o), do: Map.new(Object.to_list(o))

  for {exchange, i} <- Enum.with_index(@fixture["exchanges"]) do
    @tag index: i
    test "answers as the TypeScript does: #{exchange["name"]}", %{index: i} do
      exchange = Enum.at(@fixture["exchanges"], i)
      now = @fixture["now"]
      {store, cleanup} = Stores.store(:sqlite)
      on_exit(cleanup)

      options = for {k, v} <- Object.to_list(exchange["runlight"]), do: {snake(k), atoms(v)}
      rl = Runlight.new([store: store, now: fn -> now end] ++ options)
      Runlight.init(rl)
      routes = Runlight.routes(rl, for({k, v} <- Object.to_list(exchange["routes"]), do: {snake(k), v}))

      for answer <- exchange["answers"] do
        ask = answer["ask"]
        method = ask["method"] || "GET"
        label = "#{method} #{ask["path"]}"
        given = for {k, v} <- Object.to_list(ask["headers"] || Object.new()), do: {String.downcase(k), v}

        given =
          if Object.has_key?(ask, "body") and not List.keymember?(given, "content-type", 0),
            do: given ++ [{"content-type", "text/plain;charset=UTF-8"}],
            else: given

        response =
          Routes.handle(
            routes,
            Request.new("https://example.com" <> ask["path"], method: method, headers: given, body: ask["body"] || "")
          )

        assert response.status == answer["status"], "#{label}: status"
        assert headers(response.headers) == plain(answer["headers"]), "#{label}: headers"

        if Object.has_key?(answer, "sha256") do
          assert Base.encode16(:crypto.hash(:sha256, response.body), case: :lower) == answer["sha256"], "#{label}: body"
        else
          assert response.body == answer["text"], "#{label}: body"
        end
      end
    end
  end

  test "coded errors are the same bytes" do
    for c <- @fixture["coded"] do
      [error, code, status, params, headers] = c["args"]
      params = if params, do: Map.new(Object.to_list(params)), else: nil
      response = Routes.coded(error, code, status, params, Object.to_list(headers))
      assert response.status == c["status"], code
      assert response.body == c["text"], code
      assert headers(response.headers) == plain(c["headers"]), code
    end
  end

  test "host names are bare as the TypeScript makes them" do
    for [given, want] <- @fixture["hostName"], do: assert(Routes.host_name(given) == want, given)
  end

  test "manage paths are the same" do
    for [method, path, want] <- @fixture["managePath"],
        do: assert(Routes.manage_path?(method, path) == want, "#{method} #{path}")
  end

  test "PKCE's S256 matches the TypeScript" do
    for [verifier, want] <- @fixture["s256"], do: assert(Runlight.OAuth.s256(verifier) == want, verifier)
    # RFC 7636's own example.
    assert Runlight.OAuth.s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") ==
             "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  end

  test "the resource metadata URL" do
    for [origin, base, want] <- @fixture["resourceMetadataUrl"],
        do: assert(Runlight.OAuth.resource_metadata_url(origin, base) == want)
  end
end

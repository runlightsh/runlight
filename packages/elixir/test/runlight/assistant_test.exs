defmodule Runlight.AssistantTest do
  @moduledoc """
  The assistant against packages/php/tests/fixtures/assistant.json: for each
  provider and failure, the very requests the TypeScript sends (bodies
  compared by SHA-256), the API reads its tools make, and what it answers.
  """
  use ExUnit.Case, async: true

  alias Runlight.Assistant
  alias Runlight.AssistantError
  alias Runlight.Http.Response
  alias Runlight.JS
  alias Runlight.JS.Object
  alias Runlight.Test.Fixtures
  alias Runlight.Test.Stores

  @fixture Fixtures.php("assistant.json")

  # A read_api that logs each read and answers from the fixture's canned API.
  defp read_api(log) do
    api = @fixture["api"]

    fn path, params ->
      Agent.update(log, &[JS.obj(path: path, params: Enum.map(params, fn {k, v} -> [k, v] end)) | &1])

      canned =
        api[path] || JS.obj(status: 404, body: ~s({"error":"Not found: #{String.replace(path, "\"", "")}"}))

      Response.new(canned["body"], canned["status"], [{"content-type", "application/json"}])
    end
  end

  defp params(nil), do: Object.new()
  defp params(p) when is_map(p) and not is_struct(p), do: JS.obj(Enum.to_list(p))
  defp params(p) when is_list(p), do: JS.obj(p)
  defp params(%Object{} = p), do: p

  defp context(c) do
    site = c["site"]

    %{
      site: %{id: site["id"], name: site["name"], timezone: site["timezone"]},
      today: c["today"],
      view: c["view"],
      language: c["language"]
    }
  end

  test "scenarios send the same requests and answer the same" do
    {store, cleanup} = Stores.store(:sqlite)
    on_exit(cleanup)

    for scenario <- @fixture["scenarios"] do
      name = scenario["name"]
      {:ok, queue} = Agent.start_link(fn -> scenario["responses"] end)

      {:ok, sent} = Agent.start_link(fn -> [] end)

      fetcher = fn url, opts ->
        # Headers as the TypeScript hands them to fetch, in the order given.
        headers = for {k, v} <- Keyword.get(opts, :headers, []), do: {String.downcase(to_string(k)), v}

        request =
          JS.obj(
            url: url,
            method: Keyword.get(opts, :method, "GET"),
            headers: JS.obj(headers),
            body: Keyword.get(opts, :body)
          )

        Agent.update(sent, &(&1 ++ [request]))

        case Agent.get_and_update(queue, fn [first | rest] -> {first, rest} end) do
          %Object{} = c ->
            case c["throws"] do
              "timeout" -> {:error, :timeout}
              "network" -> {:error, :econnrefused}
              nil -> {:ok, Response.new(c["body"], c["status"], [{"content-type", "application/json"}])}
            end
        end
      end

      rl = Runlight.new(store: store, site: [hostnames: ["example.com"]], fetcher: fetcher)
      {:ok, log} = Agent.start_link(fn -> [] end)

      outcome =
        try do
          if scenario["call"] == "chat" do
            messages = for m <- scenario["messages"], do: %{role: m["role"], content: m["content"]}
            {:ok, Assistant.chat(rl, scenario["settings"], messages, context(scenario["context"]), read_api(log))}
          else
            {:ok, Assistant.list_models(rl, scenario["settings"])}
          end
        rescue
          error in AssistantError -> {:error, error}
        end

      case outcome do
        {:ok, result} ->
          assert Object.has_key?(scenario, "result"), "#{name} answered #{JS.stringify(result)}"
          assert JS.stringify(result) == JS.stringify(scenario["result"]), name

        {:error, error} ->
          assert Object.has_key?(scenario, "error"), "#{name} threw #{Exception.message(error)}"
          assert error.message == scenario["error"]["message"], name
          assert error.code == scenario["error"]["code"], name
          assert JS.stringify(params(error.params)) == JS.stringify(scenario["error"]["params"]), name
      end

      tools = log |> Agent.get(& &1) |> Enum.reverse()
      assert JS.stringify(tools) == JS.stringify(scenario["tools"]), "#{name} read the API differently"
      requests = Agent.get(sent, & &1)
      assert length(requests) == length(scenario["requests"]), name

      for {{got, want}, i} <- Enum.with_index(Enum.zip(requests, scenario["requests"])) do
        assert got["url"] == want["url"], "#{name} request #{i}"
        assert got["method"] == want["method"], "#{name} request #{i}"
        assert JS.stringify(got["headers"]) == JS.stringify(want["headers"]), "#{name} request #{i} headers"
        sha = if got["body"] == nil, do: nil, else: Base.encode16(:crypto.hash(:sha256, got["body"]), case: :lower)
        assert sha == want["bodySha256"], "#{name} request #{i} body: #{got["body"]}"
      end
    end
  end

  test "acknowledgements match" do
    for c <- @fixture["acknowledgements"] do
      assert Assistant.acknowledgement(c["text"], c["language"]) == c["reply"],
             JS.stringify([c["text"], c["language"]])
    end
  end
end

defmodule Runlight.McpTest do
  @moduledoc """
  The MCP server against packages/php/tests/fixtures/mcp.json: the
  TypeScript's API reads and answers for the same JSON-RPC messages and tool
  arguments, over canned API answers.
  """
  use ExUnit.Case, async: true

  alias Runlight.Http.Request
  alias Runlight.Http.Response
  alias Runlight.JS
  alias Runlight.JS.Object
  alias Runlight.Mcp
  alias Runlight.Test.Fixtures

  @fixture Fixtures.php("mcp.json")

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

  defp logged(log), do: log |> Agent.get(& &1) |> Enum.reverse()

  test "tool calls read the same API and answer the same" do
    for c <- @fixture["calls"] do
      label = JS.stringify(c["params"])
      {:ok, log} = Agent.start_link(fn -> [] end)

      try do
        Mcp.call_tool(c["params"], read_api(log))
      catch
        {:rpc, _code, message} -> {:thrown, message}
      end
      |> case do
        {:thrown, message} ->
          assert Object.has_key?(c, "throws"), "#{label} threw #{message}"
          assert message == c["message"], label

        result ->
          refute Object.has_key?(c, "throws"), "#{label} should throw"
          assert JS.stringify(logged(log)) == JS.stringify(c["requests"]), label
          assert JS.stringify(result) == JS.stringify(c["value"]), label
      end
    end
  end

  test "JSON-RPC answers match" do
    for c <- @fixture["rpcs"] do
      body = if Object.has_key?(c, "bodyHex"), do: Base.decode16!(c["bodyHex"], case: :mixed), else: c["body"]
      label = inspect(body)
      {:ok, log} = Agent.start_link(fn -> [] end)
      answer = Mcp.response(Request.new("https://example.com/runlight/mcp", method: "POST", body: body), read_api(log))
      assert answer.status == c["status"], label
      assert Map.new(answer.headers) == Map.new(Object.to_list(c["headers"])), label
      assert (answer.body || "") == c["text"], label
      assert JS.stringify(logged(log)) == JS.stringify(c["requests"]), label
    end
  end

  test "tools are listed read only, in order" do
    {:ok, log} = Agent.start_link(fn -> [] end)

    answer =
      Mcp.response(
        Request.new("https://x.com/mcp", method: "POST", body: ~s({"jsonrpc":"2.0","id":1,"method":"tools/list"})),
        read_api(log)
      )

    tools = JS.parse!(answer.body)["result"]["tools"]
    assert Enum.map(tools, & &1["name"]) == @fixture["tools"]
    assert Enum.all?(tools, &(&1["annotations"]["readOnlyHint"] == true))
    assert answer.body =~ ~s("properties":{}), "an empty schema is an object"
  end
end

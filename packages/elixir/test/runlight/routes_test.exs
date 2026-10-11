defmodule Runlight.RoutesTest do
  @moduledoc "The SDK's routes.test.ts on paths: broken percent escapes."
  use ExUnit.Case, async: true

  alias Runlight.Http.Request
  alias Runlight.Http.Response
  alias Runlight.Store
  alias Runlight.Test.Stores

  defp rl(opts) do
    {store, cleanup} = Stores.store(:sqlite)
    on_exit(cleanup)
    rl = Runlight.new([store: store] ++ opts)
    Runlight.init(rl)
    rl
  end

  defp req(path, method \\ "GET", headers \\ [], body \\ ""),
    do: Request.new("https://example.com#{path}", method: method, headers: headers, body: body)

  defp owner(path, method, body, bearer \\ "secret"),
    do:
      req(
        path,
        method,
        [{"authorization", "Bearer #{bearer}"}, {"content-type", "application/json"}],
        if(body, do: Jason.encode!(body), else: "")
      )

  defp body(%Response{body: body}), do: Jason.decode!(body)

  test "broken percent escapes in a path answer as a name nobody has, never an error" do
    rl = rl(sites: [[id: "blog", hostnames: ["blog.example.com"]]])
    handle = &Runlight.Routes.handle(Runlight.routes(rl, token: "secret"), &1)

    cases = [
      {"PATCH", "/runlight/api/goals/%E0?site=blog", "unknown_goal", %{name: "X", kind: "event", match: "X"}},
      {"DELETE", "/runlight/api/goals/%zz?site=blog", "unknown_goal", nil},
      {"PATCH", "/runlight/api/shares/%E0%A4?site=blog", "unknown_share", %{name: "X"}},
      {"DELETE", "/runlight/api/shares/%?site=blog", "unknown_share", nil},
      {"PATCH", "/runlight/api/sites/%E0", "unknown_site", %{name: "X"}},
      {"DELETE", "/runlight/api/sites/%zz", "unknown_site", nil},
      {"GET", "/runlight/api/link-domains/%E0/check?site=blog", "unknown_domain", nil},
      {"DELETE", "/runlight/api/link-domains/%zz?site=blog", "unknown_domain", nil}
    ]

    for {method, path, code, sent} <- cases do
      answer = handle.(owner(path, method, sent))
      assert answer.status == 404, "#{method} #{path}"
      assert body(answer)["code"] == code, "#{method} #{path}"
    end

    # A hub's manage token, checked against its one site before anything else.
    made = body(handle.(owner("/runlight/api/tokens", "POST", %{name: "Hub", scope: "manage", site: "blog"})))
    assert handle.(owner("/runlight/api/sites/%E0", "PATCH", %{name: "X"}, made["secret"])).status == 404

    # Public pages and short links: the share page, unsubscribing, the app's link path, and a link domain.
    assert handle.(req("/runlight/share/%E0")).status == 404
    assert handle.(req("/runlight/unsubscribe/%E0")).status == 404
    assert handle.(req("/runlight/assets/app.%E0.js")).status == 404
    assert Runlight.link_handler(rl, req("/go/%E0")).status == 404
    assert Runlight.link_handler(rl, req("/go/%zz")).status == 404
    Store.add_link_domain(rl.store, "go.example.net", "blog", System.system_time(:millisecond))
    Runlight.forget_link_domains(rl)
    assert Runlight.link_domain_response(rl, Request.new("https://go.example.net/%E0")).status == 404
  end
end

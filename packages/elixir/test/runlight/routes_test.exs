defmodule Runlight.RoutesTest do
  @moduledoc "The SDK's routes.test.ts on the picker's relay page, broken percent escapes in a path, and the dashboard's CMS and csrf token."
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

  test "the picker sends its choice to the relay page its ticket names, never through the tab that opened it" do
    {:ok, clock} = Agent.start_link(fn -> 1_791_374_400_000 end)
    rl = rl(sites: [[id: "blog", hostnames: ["blog.example.com"]]], now: fn -> Agent.get(clock, & &1) end)
    handle = &Runlight.Routes.handle(Runlight.routes(rl, token: "secret"), &1)
    ask = fn sent, bearer -> handle.(owner("/runlight/api/pick?site=blog", "POST", sent, bearer)) end

    script = fn ticket ->
      handle.(req("/runlight/pick.js?runlight=pick&runlight_ticket=#{URI.encode_www_form(ticket)}")).body
    end

    nonce = "0123456789abcdef0123456789abcdef"
    back = "https://stats.example.com/runlight/pick-return"

    asked = ask.(%{origin: "https://stats.example.com", return: back, nonce: nonce}, "secret")
    assert asked.status == 200
    %{"ticket" => ticket} = body(asked)
    assert length(String.split(ticket, ".")) == 6, "the return address and nonce are signed into the ticket"
    picker = script.(ticket)
    assert picker =~ Jason.encode!(back) and picker =~ Jason.encode!(nonce)
    refute picker =~ "__RUNLIGHT_PICK_RETURN__" or picker =~ "__RUNLIGHT_PICK_NONCE__"

    # Neither can be changed: a ticket with another return address or nonce is no ticket, and the picker sends nowhere.
    parts = String.split(ticket, ".")
    other = Base.encode16("https://stats.example.com/elsewhere/pick-return", case: :lower)

    for changed <- [
          List.replace_at(parts, 3, other),
          List.replace_at(parts, 4, String.duplicate("f", 32))
        ] do
      sent = script.(Enum.join(changed, "."))
      refute sent =~ "stats.example.com" or sent =~ nonce
    end

    # The return address is the relay page on the dashboard's own origin, and the nonce is 32 hex digits.
    for sent <- [
          %{origin: "https://stats.example.com", return: "https://evil.example/pick-return", nonce: nonce},
          %{
            origin: "https://stats.example.com",
            return: "https://stats.example.com.evil.example/pick-return",
            nonce: nonce
          },
          %{origin: "https://stats.example.com", return: "https://stats.example.com/runlight/", nonce: nonce},
          %{origin: "https://stats.example.com", return: "https://stats.example.com/pick-return?x=1", nonce: nonce},
          %{origin: "https://stats.example.com", return: "https://stats.example.com/pick-return#x", nonce: nonce},
          %{origin: "https://stats.example.com", return: back},
          %{origin: "https://stats.example.com", return: back, nonce: "short"},
          %{origin: "https://stats.example.com", nonce: nonce}
        ] do
      refused = ask.(sent, "secret")
      assert refused.status == 400, inspect(sent)
      assert body(refused)["code"] == "pick_return"
    end

    assert ask.(
             %{origin: "https://stats.example.com", return: "https://stats.example.com/pick-return", nonce: nonce},
             "secret"
           ).status ==
             200,
           "a dashboard at the root"

    # A hub's ticket names a relay page on the hub it connected from, and no other origin.
    made = body(handle.(owner("/runlight/api/tokens", "POST", %{name: "Hub", scope: "manage", site: "blog"})))
    Store.set_setting(rl.store, "token-origin:#{made["token"]["id"]}", "https://hub.example.net")
    hub = %{origin: "https://hub.example.net", return: "https://hub.example.net/pick-return", nonce: nonce}
    assert ask.(hub, made["secret"]).status == 200
    assert ask.(%{hub | return: "https://evil.example/pick-return"}, made["secret"]).status == 400

    Agent.update(clock, &(&1 + 31 * 60_000))
    refute script.(ticket) =~ nonce, "a ticket runs out after half an hour"
  end

  test "the relay page is static, runs only its own script, and keeps its address to itself" do
    handle = &Runlight.Routes.handle(Runlight.routes(rl([]), token: "secret"), &1)
    page = handle.(req("/runlight/pick-return", "GET", [{"accept-language", "de-DE,de;q=0.9"}]))
    assert page.status == 200
    assert Response.header(page, "content-type") =~ "text/html"
    assert Response.header(page, "cache-control") == "no-store"
    assert Response.header(page, "referrer-policy") == "no-referrer"
    csp = Response.header(page, "content-security-policy")
    assert csp =~ "script-src 'self'"
    assert csp =~ "frame-ancestors 'none'"
    refute csp =~ ~r/script-src[^;]*unsafe/, "no inline script"
    assert page.body =~ ~s(lang="de")
    assert page.body =~ ~s(<script src="/runlight/pick-return.js"></script>)
    refute page.body =~ "<script>", "no inline script"
    script = handle.(req("/runlight/pick-return.js"))
    assert Response.header(script, "content-type") =~ "javascript"
    assert script.body =~ "BroadcastChannel"
    # Signed out, it answers the same: it holds nothing.
    open = Runlight.routes(rl(secret: String.duplicate("a", 32)), token: "secret", accounts: true)
    assert Runlight.Routes.handle(open, req("/runlight/pick-return")).status == 200
  end

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

  test "the dashboard names the CMS that adds the script only when one is set" do
    page = fn opts ->
      Runlight.Routes.handle(Runlight.routes(rl([]), [token: "secret"] ++ opts), owner("/runlight", "GET", nil))
    end

    plain = page.([])
    assert plain.status == 200
    refute plain.body =~ "data-cms"
    inside = page.(cms: ~s(Word"Press))
    assert inside.body =~ ~s(<div id="app" data-base="/runlight" data-cms="Word&#34;Press" data-world=)
    # Its own admin may frame the whole dashboard; otherwise nothing may.
    assert Response.header(inside, "content-security-policy") =~ "frame-ancestors 'self'"
    assert Response.header(inside, "x-frame-options") == "SAMEORIGIN"
    assert Response.header(plain, "content-security-policy") =~ "frame-ancestors 'none'"
    assert Response.header(plain, "x-frame-options") == "DENY"
  end

  test "an app's csrf token is printed in the dashboard and the OAuth consent form, asked for each time, and only when given" do
    {:ok, made} = Agent.start_link(fn -> 0 end)

    pages = fn opts ->
      routes = Runlight.routes(rl(site: [hostnames: ["example.com"]]), [authorize: fn _ -> true end] ++ opts)
      dashboard = Runlight.Routes.handle(routes, req("/runlight/")).body

      registered =
        Runlight.Routes.handle(
          routes,
          req(
            "/runlight/oauth/register",
            "POST",
            [{"content-type", "application/json"}],
            Jason.encode!(%{client_name: "App", redirect_uris: ["https://app.example/cb"]})
          )
        )

      params =
        URI.encode_query(%{
          response_type: "code",
          client_id: body(registered)["client_id"],
          redirect_uri: "https://app.example/cb",
          code_challenge: String.duplicate("a", 43),
          code_challenge_method: "S256"
        })

      consent = Runlight.Routes.handle(routes, req("/runlight/oauth/authorize?#{params}")).body
      {dashboard, consent}
    end

    {dashboard, consent} = pages.(csrf: fn -> "tok-#{Agent.get_and_update(made, &{&1 + 1, &1 + 1})}" end)
    assert dashboard =~ ~s(data-csrf="tok-1")
    assert consent =~ ~s(<input type="hidden" name="csrf" value="tok-2">)
    {dashboard, consent} = pages.([])
    refute dashboard =~ "data-csrf"
    refute consent =~ ~s(name="csrf")
  end

  test "a site change refused for a bad domain changes nothing" do
    rl = rl(managed_sites: true)
    handle = &Runlight.Routes.handle(Runlight.routes(rl, token: "secret"), &1)

    added =
      handle.(owner("/runlight/api/sites", "POST", %{name: "Blog", hostnames: ["blog.example.com"], timezone: "UTC"}))

    %{"site" => %{"id" => id}} = body(added)

    other =
      handle.(owner("/runlight/api/sites", "POST", %{name: "Shop", hostnames: ["shop.example.com"], timezone: "UTC"}))

    assert other.status == 201

    for hostnames <- [["not a domain"], ["shop.example.com"]] do
      refused =
        handle.(
          owner("/runlight/api/sites/#{id}", "PATCH", %{
            retentionMonths: 12,
            timezone: "Asia/Tokyo",
            name: "Not saved",
            hostnames: hostnames
          })
        )

      assert refused.status in [400, 409]
      Runlight.idle(rl)
      assert Runlight.retention(rl, id) == nil
      assert Store.setting(rl.store, "rollup-zone:#{id}") in [nil, ~s({"zone":"UTC","since":0})]
      site = Runlight.site(rl, id)
      assert {site["name"], site["timezone"], site["hostnames"]} == {"Blog", "UTC", ["blog.example.com"]}
    end

    saved = handle.(owner("/runlight/api/sites/#{id}", "PATCH", %{retentionMonths: 12, timezone: "Asia/Tokyo"}))
    assert saved.status == 200
    Runlight.idle(rl)
    assert Runlight.retention(rl, id) == 12
    assert Runlight.site(rl, id)["timezone"] == "Asia/Tokyo"
  end

  test "questions sent at once count once each against a viewer's daily number" do
    now = fn -> 1_791_806_400_000 end

    fetcher = fn _, _ -> {:error, :econnrefused} end
    first = rl(sites: [[id: "a", name: "A", hostnames: ["a.example.com"]]], now: now, fetcher: fetcher)

    Runlight.save_assistant_settings(
      first,
      Runlight.JS.obj(provider: "custom", model: "m", baseUrl: "http://127.0.0.1:9/v1", key: "k")
    )

    Store.set_setting(first.store, "assistant-viewer-daily", "1")

    handler = fn rl ->
      routes =
        Runlight.routes(rl,
          authorize: fn r -> if Request.header(r, "x-who"), do: "read", else: false end,
          account_of: fn r -> Request.header(r, "x-who") end
        )

      &Runlight.Routes.handle(routes, &1)
    end

    ask = fn handle, who ->
      handle.(
        req(
          "/runlight/api/assistant/chat",
          "POST",
          [{"x-who", who}, {"content-type", "application/json"}],
          Jason.encode!(%{site: "a", messages: [%{role: "user", content: "hi"}]})
        )
      )
    end

    passed = fn answers -> Enum.count(answers, &(&1.status != 429)) end
    day = "assistant-asked:2026-10-12:"

    # One instance: the second and later questions see the first.
    one = handler.(first)
    answers = 1..10 |> Task.async_stream(fn _ -> ask.(one, "viewer-1") end, timeout: 30_000) |> Enum.map(&elem(&1, 1))
    assert passed.(answers) == 1
    assert Store.setting(first.store, day <> "viewer-1") == "1"

    # Ten instances on one database, each with its own counts in memory: the database lets one through.
    handlers =
      for _ <- 1..10,
          do:
            handler.(
              Runlight.new(
                store: first.store,
                sites: [[id: "a", hostnames: ["a.example.com"]]],
                now: now,
                fetcher: fetcher
              )
            )

    answers =
      handlers |> Task.async_stream(fn h -> ask.(h, "viewer-2") end, timeout: 30_000) |> Enum.map(&elem(&1, 1))

    assert passed.(answers) == 1
    assert Store.setting(first.store, day <> "viewer-2") == "1"

    # Two viewers at once each have their own row, and neither write loses the other's.
    answers =
      ["viewer-3", "viewer-4"]
      |> Enum.zip(handlers)
      |> Task.async_stream(fn {who, h} -> ask.(h, who) end, timeout: 30_000)
      |> Enum.map(&elem(&1, 1))

    assert passed.(answers) == 2
    assert Store.setting(first.store, day <> "viewer-3") == "1"
    assert Store.setting(first.store, day <> "viewer-4") == "1"

    # A refused question gives its slot back, so a viewer at the limit is not locked out of the hour's thirty.
    for _ <- 1..40, do: assert(ask.(one, "viewer-1").status == 429)
    assert Store.setting(first.store, day <> "viewer-1") == "1"
  end

  test "a key made on first use is the same for every request that asks at once" do
    rl = rl(sites: [[id: "a", hostnames: ["a.example.com"]]])

    for key <- ["oauth-key", "pick-key", "embed-key"] do
      made = fn -> Runlight.Hash.random_id(32) end
      keys = 1..20 |> Task.async_stream(fn _ -> Store.setting_or_add(rl.store, key, made) end) |> Enum.map(&elem(&1, 1))
      assert length(Enum.uniq(keys)) == 1
      assert Store.setting(rl.store, key) == hd(keys)
    end

    assert Store.add_setting(rl.store, "once", "1")
    refute Store.add_setting(rl.store, "once", "2")
    assert Store.setting(rl.store, "once") == "1"
    refute Store.swap_setting(rl.store, "once", "2", "3")
    assert Store.swap_setting(rl.store, "once", "1", "2")
    assert Store.setting(rl.store, "once") == "2"

    agents = 1..20 |> Task.async_stream(fn _ -> Runlight.OAuth.agents_key(rl, "a") end) |> Enum.map(&elem(&1, 1))
    assert length(Enum.uniq(agents)) == 1
    assert Runlight.OAuth.agents_key(rl, "a", true) != hd(agents)
  end
end

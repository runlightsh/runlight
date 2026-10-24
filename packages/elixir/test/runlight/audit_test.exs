defmodule Runlight.AuditTest do
  @moduledoc """
  The audit fixes of 2026-10-16 as the SDK's tests check them: password costs, sign-in rehashing, forgotten sites,
  salts that outlast a visit, click goal renames, clipped text, settled visits, hostname suggestions, and the smaller
  report edges. Then the audit of 2026-10-23: members' tokens, signing out everywhere, cross-site form posts,
  tokens taken back with a new password, the throttle's eviction, the salt cache, retried hits, the funnel cap, and
  automatic link events.
  """
  use ExUnit.Case, async: false

  alias Runlight.Accounts
  alias Runlight.Crypto
  alias Runlight.Db
  alias Runlight.Http.Request
  alias Runlight.Http.Response
  alias Runlight.JS
  alias Runlight.Store
  alias Runlight.Test.Stores
  alias Runlight.Time

  @moduletag timeout: 300_000

  @hour 3_600_000
  @minute 60_000
  @chrome "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"

  defp at(iso), do: JS.date_parse(iso)

  defp harness(kind, url, now, opts \\ []) do
    {store, cleanup} = Stores.store(kind, url)
    on_exit(cleanup)
    clock = :counters.new(1, [])
    :counters.put(clock, 1, now)

    rl =
      Runlight.new(
        Keyword.merge(
          [store: store, site: [hostnames: ["example.com"], timezone: "UTC"], now: fn -> :counters.get(clock, 1) end],
          opts
        )
      )

    Runlight.init(rl)
    {rl, clock}
  end

  defp advance(clock, ms), do: :counters.put(clock, 1, :counters.get(clock, 1) + ms)

  defp hit(rl, body, ip, host \\ "example.com") do
    Runlight.collect(
      rl,
      Request.new("https://#{host}/runlight/e",
        method: "POST",
        headers: [
          {"user-agent", @chrome},
          {"x-forwarded-for", ip},
          {"content-type", "text/plain;charset=UTF-8"}
        ],
        body: JS.stringify(body)
      )
    )
  end

  defp salts(rl), do: rl.store |> Store.all_rows("SELECT day FROM rl_salts ORDER BY day", []) |> Enum.map(& &1["day"])

  defp pbkdf2_hash(password, rounds) do
    salt = :crypto.strong_rand_bytes(16)

    "pbkdf2$#{rounds}$#{Crypto.base64url(salt)}$#{Crypto.base64url(Crypto.pbkdf2(password, salt, rounds, 32))}"
  end

  test "new password hashes cost 600,000 PBKDF2 rounds, and scrypt hashes check at the cost they record" do
    assert Crypto.hash_password("a long password") =~ ~r/\Apbkdf2\$600000\$/

    salt = :crypto.strong_rand_bytes(16)
    key = Crypto.scrypt("a long password", salt, 16, 8, 1, 32)
    recorded = "scrypt$16$8$1$#{Crypto.base64url(salt)}$#{Crypto.base64url(key)}"
    assert Crypto.check_password("a long password", recorded)
    refute Crypto.check_password("a long passwore", recorded)

    # A cost out of bounds is refused without running it.
    for cost <- [
          "2097152$8$1",
          "30000$8$1",
          "1$8$1",
          "16384$33$1",
          "16384$8$17",
          "16384$0$1",
          "x$8$1",
          "16.5$8$1",
          "1048576$1$1",
          "65536$1$1"
        ] do
      hash = "scrypt$#{cost}$#{Crypto.base64url(salt)}$#{Crypto.base64url(key)}"
      {micros, false} = :timer.tc(fn -> Crypto.check_password("a long password", hash) end)
      assert micros < 500_000, cost
    end

    assert Crypto.weaker_than_now?(pbkdf2_hash("x", 100_000))
    refute Crypto.weaker_than_now?(pbkdf2_hash("x", 600_000))
    refute Crypto.weaker_than_now?(recorded)
  end

  for {kind, url} <- Stores.kinds() do
    @kind kind
    @url url

    test "#{kind}: signing in hashes a password made at a lower cost again, and a wrong password changes nothing" do
      {rl, _} = harness(@kind, @url, at("2026-10-14T12:00:00Z"))
      acc = Accounts.new(rl, String.duplicate("s", 64))
      user = Accounts.set_password(acc, "owner@example.com", "a long password", 1)
      old = pbkdf2_hash("a long password", 100_000)
      Db.run(rl.store.db, "UPDATE rl_users SET hash = ? WHERE id = ?", [old, user["id"]])

      assert Accounts.sign_in(acc, "owner@example.com", "a wrong password") == nil
      assert Accounts.by_id(acc, user["id"])["hash"] == old

      signed_in = Accounts.sign_in(acc, "owner@example.com", "a long password")
      assert signed_in["hash"] =~ ~r/\Apbkdf2\$600000\$/, "made again at the new cost"
      assert Accounts.by_id(acc, user["id"])["hash"] == signed_in["hash"]
      assert Accounts.sign_in(acc, "owner@example.com", "a long password")
    end

    test "#{kind}: deleting a site removes the accounts and invitations kept to it, and no one else" do
      {rl, _} = harness(@kind, @url, at("2026-10-14T12:00:00Z"))
      acc = Accounts.new(rl, String.duplicate("s", 64))
      now = at("2026-10-14T12:00:00Z")
      Accounts.set_password(acc, "owner@example.com", "a long password", now)
      Accounts.set_password(acc, "alpha@example.com", "a long password", now, "viewer", "alpha")
      Accounts.set_password(acc, "beta@example.com", "a long password", now, "member", "beta")
      Accounts.invite(acc, "invited@example.com", "member", "owner@example.com", now, "alpha")
      Accounts.invite(acc, "other@example.com", "member", "owner@example.com", now, "beta")

      Accounts.forget_site(acc, "alpha")

      assert acc |> Accounts.list() |> Enum.map(& &1["email"]) |> Enum.sort() == [
               "beta@example.com",
               "owner@example.com"
             ]

      assert acc |> Accounts.invites(now) |> Enum.map(& &1["email"]) == ["other@example.com"]
    end

    test "#{kind}: a salt lasts its day, and past midnight only while a visit that began that day goes on" do
      {rl, clock} = harness(@kind, @url, at("2026-10-06T12:00:00Z"))
      hit(rl, JS.obj(k: "pageview", u: "https://example.com/"), "203.0.113.1")

      for i <- 1..3 do
        advance(clock, 24 * @hour)
        hit(rl, JS.obj(k: "pageview", u: "https://example.com/"), "203.0.113.#{i + 1}")
      end

      Runlight.check(rl)
      assert salts(rl) == ["2026-10-09"], "no visit from the 8th is still going, so only today's salt is left"

      advance(clock, 11 * @hour + 50 * @minute)
      hit(rl, JS.obj(k: "pageview", u: "https://example.com/late"), "203.0.113.50")
      advance(clock, 20 * @minute)
      hit(rl, JS.obj(k: "pageview", u: "https://example.com/later"), "203.0.113.50")
      Runlight.check(rl)
      assert salts(rl) == ["2026-10-09", "2026-10-10"], "the visit is still going"

      advance(clock, 31 * @minute)
      Runlight.check(rl)
      assert salts(rl) == ["2026-10-10"]

      query = %{
        site: "default",
        from: Time.start_of("2026-10-09", "UTC"),
        to: Time.start_of("2026-10-11", "UTC"),
        filters: []
      }

      stats = Store.stats(rl.store, query)
      assert [stats["visits"], stats["pageviews"]] == [2, 3], "the visit across midnight is one visit"
    end

    test "#{kind}: renaming a click goal keeps its conversions on built days, even onto a name with events of its own" do
      {rl, clock} = harness(@kind, @url, at("2026-10-06T12:00:00Z"))
      advance(clock, -3 * 24 * @hour)

      for i <- 0..2 do
        ip = "203.0.113.#{60 + i}"
        hit(rl, JS.obj(k: "pageview", u: "https://example.com/"), ip)
        hit(rl, JS.obj(k: "event", u: "https://example.com/", n: "Buy click"), ip)
        if i == 0, do: hit(rl, JS.obj(k: "event", u: "https://example.com/", n: "Purchase"), ip)
        advance(clock, @hour)
      end

      advance(clock, 3 * 24 * @hour - 3 * @hour)

      goal =
        JS.obj(
          id: String.duplicate("c", 24),
          site: "default",
          name: "Buy click",
          kind: "click",
          match: "button.buy",
          clickBy: "selector",
          valueMode: "none",
          value: 0,
          valueProp: "",
          currency: "USD",
          createdAt: :counters.get(clock, 1)
        )

      Store.save_goal(rl.store, goal)
      build_all = fn f -> if Runlight.build_rollups(rl) > 0, do: f.(f), else: :ok end
      build_all.(build_all)

      now = :counters.get(clock, 1)
      query = %{site: "default", from: now - 7 * 24 * @hour, to: now + @hour, filters: []}
      read = fn -> Store.goal_totals_all(rl.store, query, Store.goals(rl.store, "default")) end

      conversions = fn totals ->
        totals |> Runlight.JS.Object.values() |> Enum.map(&[&1["conversions"], &1["visitors"]])
      end

      assert conversions.(read.()) == [[3, 3]]

      for name <- ["Checkout click", "Purchase"] do
        [before] = Store.goals(rl.store, "default")
        Store.save_goal(rl.store, Runlight.JS.Object.put(before, "name", name), before)
        want = [[if(name == "Purchase", do: 4, else: 3), 3]]
        assert conversions.(read.()) == want, "renamed to #{name}: #{inspect(read.())}"

        # Days built again where both names met, then every built day reads the same as the raw events.
        build_all.(build_all)
        built = read.()
        Store.clear_rollups(rl.store, "default")
        assert built == read.(), "rollups agree with the raw events after renaming to #{name}"
        build_all.(build_all)
      end
    end

    test "#{kind}: text longer than its column is cut to fit, never through a character" do
      {rl, _} = harness(@kind, @url, at("2026-10-06T12:00:00Z"))
      long = String.duplicate("é", 300)

      Store.insert_session(rl.store, %{
        id: "a",
        site: "default",
        visitor: "v",
        started_at: 1,
        hostname: "example.com",
        referrer_host: "",
        referrer_path: "",
        source: "",
        channel: "Direct",
        utm_source: long,
        utm_medium: String.duplicate("😀", 150),
        utm_campaign: "",
        utm_term: "",
        utm_content: "",
        country: "",
        region: "",
        city: "",
        browser: "",
        browser_version: "",
        os: String.duplicate("W", 400),
        os_version: "",
        device: "",
        screen: "",
        language: ""
      })

      Store.touch_session(rl.store, "a", 2, "pageview", "/" <> String.duplicate("a", 1500))
      [row] = Store.all_rows(rl.store, "SELECT utm_source, utm_medium, os, entry_path, exit_path FROM rl_sessions", [])
      assert String.length(row["utm_source"]) == 200
      assert String.length(row["utm_medium"]) == 150, "300 UTF-16 units, so cut to 200 characters would keep all 150"
      assert String.length(row["os"]) == 100
      assert String.length(row["entry_path"]) == 1000
      assert String.length(row["exit_path"]) == 1000
    end

    test "#{kind}: two visits opened for one visitor at once, by two processes, settle on one" do
      {rl, clock} = harness(@kind, @url, at("2026-10-06T12:00:00Z"))
      now = :counters.get(clock, 1)

      row = fn id ->
        %{
          id: id,
          site: "default",
          visitor: "v1",
          started_at: now,
          hostname: "example.com",
          referrer_host: "",
          referrer_path: "",
          source: "",
          channel: "Direct",
          utm_source: "",
          utm_medium: "",
          utm_campaign: "",
          utm_term: "",
          utm_content: "",
          country: "",
          region: "",
          city: "",
          browser: "",
          browser_version: "",
          os: "",
          os_version: "",
          device: "",
          screen: "",
          language: ""
        }
      end

      Store.insert_session(rl.store, row.("bbbb"))
      Store.insert_session(rl.store, row.("aaaa"))
      one = Store.settle_open_session(rl.store, "default", ["v1"], now - 60_000, %{id: "bbbb", visitor: "v1"})
      other = Store.settle_open_session(rl.store, "default", ["v1"], now - 60_000, %{id: "aaaa", visitor: "v1"})
      assert [one.id, other.id] == ["aaaa", "aaaa"]
      assert rl.store |> Store.all_rows("SELECT id FROM rl_sessions", []) |> Enum.map(& &1["id"]) == ["aaaa"]
    end

    test "#{kind}: hostname suggestions step through hostnames in the order they are sorted in" do
      {rl, _} =
        harness(@kind, @url, at("2026-10-06T12:00:00Z"),
          site: [id: "a", hostnames: ["blog.example.com", "blog-staging.example.com", "shop.example.com"]]
        )

      for {host, ip} <- [{"blog.example.com", 2}, {"blog-staging.example.com", 3}, {"shop.example.com", 4}] do
        hit(rl, JS.obj(k: "pageview", u: "https://#{host}/"), "203.0.113.#{ip}", host)
      end

      routes = Runlight.routes(rl, token: "secret")

      answer =
        Runlight.Routes.handle(
          routes,
          Request.new("https://example.com/runlight/api/breakdown?site=a&period=today&dimension=hostname&suggestions=1",
            headers: [{"authorization", "Bearer secret"}]
          )
        )

      assert answer.status == 200

      assert answer.body |> Jason.decode!() |> Map.fetch!("rows") |> Enum.map(& &1["value"]) ==
               ["blog-staging.example.com", "blog.example.com", "shop.example.com"]
    end
  end

  test "each site's timezone keeps the salts its own visits need" do
    {rl, _clock} =
      harness(:sqlite, nil, at("2026-10-06T02:00:00Z"),
        site: nil,
        sites: [
          [id: "utc", name: "UTC", hostnames: ["example.com"], timezone: "UTC"],
          [id: "to", name: "Toronto", hostnames: ["example.org"], timezone: "America/Toronto"]
        ]
      )

    Runlight.check(rl)
    for day <- salts(rl), do: assert(day in ["2026-10-05", "2026-10-06"], day)
    hit(rl, JS.obj(k: "pageview", u: "https://example.org/"), "203.0.113.1", "example.org")
    hit(rl, JS.obj(k: "pageview", u: "https://example.com/"), "203.0.113.2")
    Runlight.check(rl)
    assert salts(rl) == ["2026-10-05", "2026-10-06"], "today in each timezone"
  end

  test "N months back from a month's last days stays in that month" do
    {rl, clock} = harness(:sqlite, nil, at("2026-08-31T12:00:00Z"))
    Runlight.set_retention(rl, "default", 6)

    for {now, cutoff} <- [
          {"2026-08-31T12:00:00Z", "2026-02-28T12:00:00Z"},
          {"2026-08-30T12:00:00Z", "2026-02-28T12:00:00Z"},
          {"2028-08-31T12:00:00Z", "2028-02-29T12:00:00Z"},
          {"2026-10-06T12:00:00Z", "2026-04-06T12:00:00Z"}
        ] do
      :counters.put(clock, 1, at(now))
      assert Runlight.retention_cutoff(rl, "default") == at(cutoff), now
    end
  end

  test "a day where clocks fall back across midnight begins at the first midnight" do
    for {date, zone} <- [
          {"2019-10-25", "Asia/Amman"},
          {"2020-10-24", "Asia/Gaza"},
          {"2020-10-24", "Asia/Hebron"},
          {"2019-03-17", "Antarctica/Casey"}
        ] do
      start = Time.start_of(date, zone)
      assert Time.local_date(start, zone) == date, zone
      assert Time.local_date(start - 1, zone) < date, "#{zone}: the moment before is the day before"
    end
  end

  defp api(routes, path, headers \\ [{"authorization", "Bearer secret"}]),
    do: Runlight.Routes.handle(routes, Request.new("https://example.com/runlight#{path}", headers: headers))

  test "paging takes whole numbers only, and a journey takes a page as written" do
    {rl, clock} = harness(:sqlite, nil, at("2026-10-06T12:00:00Z"))
    routes = Runlight.routes(rl, token: "secret")

    for query <- ["limit=2.5", "page=1e20", "limit=-3&page=0", "limit=abc&page=2.5"] do
      assert api(routes, "/api/breakdown?period=7d&dimension=page&#{query}").status == 200, query
    end

    hit(rl, JS.obj(k: "pageview", u: "https://example.com/café"), "203.0.113.1")
    advance(clock, 30_000)
    hit(rl, JS.obj(k: "pageview", u: "https://example.com/pricing"), "203.0.113.1")

    for query <- [
          "start=#{URI.encode_www_form("/café")}",
          "start=#{URI.encode_www_form("/caf%C3%A9")}",
          "end=#{URI.encode_www_form("/pricing")}&start=#{URI.encode_www_form("/café")}",
          "through=#{URI.encode_www_form("0:/café")}"
        ] do
      journey = api(routes, "/api/journeys?period=today&#{query}")
      assert Jason.decode!(journey.body)["visits"] == 1, "#{query}: #{journey.body}"
    end
  end

  test "a site's agents key is kept sealed, and one kept as plain text before still works and is sealed when read" do
    {rl, _} = harness(:sqlite, nil, at("2026-10-06T12:00:00Z"), secret: String.duplicate("s", 32))
    routes = Runlight.routes(rl, token: "owner")
    key = Runlight.OAuth.agents_key(rl, "default")
    stored = Store.setting(rl.store, "observe-key:default")
    refute stored =~ key, "not in the database as it is"

    observe = fn bearer ->
      Runlight.Routes.handle(
        routes,
        Request.new("https://example.com/runlight/api/observe",
          method: "POST",
          headers: [{"authorization", "Bearer #{bearer}"}, {"content-type", "application/json"}],
          body: Jason.encode!(%{url: "https://example.com/", userAgent: "Mozilla/5.0 (compatible; GPTBot/1.2)"})
        )
      ).status
    end

    assert observe.(key) == 204
    Store.set_setting(rl.store, "observe-key:default", "rlo_legacykeylegacykey00")
    assert observe.("rlo_legacykeylegacykey00") == 204
    assert Runlight.OAuth.agents_key(rl, "default") == "rlo_legacykeylegacykey00", "shown as it was"
    refute Store.setting(rl.store, "observe-key:default") =~ "rlo_legacy", "and sealed now"
    assert observe.("rlo_legacykeylegacykey00") == 204, "still working"
    assert observe.("rlo_wrongkeywrongkeywron") == 401
  end

  test "a test email goes at most once a minute through each mail service" do
    {:ok, sent} = Agent.start_link(fn -> [] end)
    {store, cleanup} = Stores.store(:sqlite)
    on_exit(cleanup)
    {:ok, clock} = Agent.start_link(fn -> 1_791_374_400_000 end)

    rl =
      Runlight.new(
        store: store,
        site: [name: "Example", hostnames: ["example.com"]],
        now: fn -> Agent.get(clock, & &1) end,
        mail: [from: "site@example.com", via: "An app", send: fn m -> Agent.update(sent, &(&1 ++ [m])) end]
      )

    routes = Runlight.routes(rl, token: "t")

    test_mail = fn ->
      answer =
        Runlight.Routes.handle(
          routes,
          Request.new("https://example.com/runlight/api/mail/test",
            method: "POST",
            headers: [{"authorization", "Bearer t"}, {"content-type", "application/json"}],
            body: Jason.encode!(%{to: "jon@example.com"})
          )
        )

      {answer.status, Jason.decode!(answer.body)["code"]}
    end

    assert {200, nil} = test_mail.()
    assert {429, "test_soon"} = test_mail.()
    assert length(Agent.get(sent, & &1)) == 1
    Agent.update(clock, &(&1 + 60_000))
    assert {200, nil} = test_mail.()
  end

  test "a question carries at most 24,000 characters of earlier turns, however much history the browser sends" do
    {store, cleanup} = Stores.store(:sqlite)
    on_exit(cleanup)
    {:ok, seen} = Agent.start_link(fn -> [] end)

    fetcher = fn _url, opts ->
      Agent.update(seen, &(&1 ++ [Jason.decode!(Keyword.fetch!(opts, :body))]))

      {:ok,
       Response.new(Jason.encode!(%{content: [%{type: "text", text: "ok"}], stop_reason: "end_turn"}), 200, [
         {"content-type", "application/json"}
       ])}
    end

    rl = Runlight.new(store: store, site: [hostnames: ["example.com"]], fetcher: fetcher)

    history =
      for i <- 0..18,
          do: %{
            role: if(rem(i, 2) == 1, do: "assistant", else: "user"),
            content: "#{i} " <> String.duplicate("x", 7998)
          }

    messages = history ++ [%{role: "user", content: "How many visitors?"}]

    context = %{
      site: %{id: "default", name: "Default", timezone: "UTC"},
      today: "2026-10-06",
      view: "today",
      language: "en"
    }

    settings =
      JS.obj(provider: "anthropic", key: "sk-ant-secret", baseUrl: "https://model.test/v1", model: "claude-opus-5-5")

    assert %{} = Runlight.Assistant.chat(rl, settings, messages, context, fn _, _ -> Response.new("{}", 200, []) end)

    for body <- Agent.get(seen, & &1) do
      texts = for m <- body["messages"], is_binary(m["content"]), do: m["content"]
      assert texts |> Enum.map(&JS.len16/1) |> Enum.sum() <= 24_000
      assert hd(body["messages"])["role"] == "user", "still starting with a question"
      assert List.last(texts) =~ "How many visitors?"
    end
  end

  test "the Plug honours the first x-forwarded-proto of http or https" do
    conn = fn headers ->
      Enum.reduce(headers, Plug.Test.conn(:get, "/stats/"), fn {k, v}, c -> Plug.Conn.put_req_header(c, k, v) end)
    end

    assert Runlight.Plug.scheme(conn.([])) == "http"
    assert Runlight.Plug.scheme(conn.([{"x-forwarded-proto", "https"}])) == "https"
    assert Runlight.Plug.scheme(conn.([{"x-forwarded-proto", "HTTPS, http"}])) == "https"
    assert Runlight.Plug.scheme(conn.([{"x-forwarded-proto", "ftp"}])) == "http"
    assert Runlight.Plug.scheme(%{conn.([{"x-forwarded-proto", "http"}]) | scheme: :https}) == "http"
    assert Runlight.Plug.scheme(%{conn.([]) | scheme: :https}) == "https"
  end

  test "hosts are mapped by UTS 46 before Punycode, and an IPv4 host follows the standard's rules" do
    host = fn text -> Runlight.Url.new("https://#{text}/").hostname end

    assert host.("EXAMPLE.com") == "example.com"
    assert host.("ｅｘａｍｐｌｅ.com") == "example.com", "full width letters"
    assert host.("exa­mple.com") == "example.com", "a soft hyphen is ignored"
    assert host.("example。com") == "example.com", "an ideographic full stop is a dot"
    assert host.("example​.com") == "example.com", "a zero width space is ignored"
    assert host.("ｅｘａｍｐｌｅ。ｃｏｍ") == "example.com"
    assert host.("café.com") == "xn--caf-dma.com"
    assert host.("ＣＡＦÉ.com") == "xn--caf-dma.com"
    assert_raise ArgumentError, fn -> host.("exa％mple.com") end

    assert host.("0x7f.1") == "127.0.0.1"
    assert host.("010.1.1.1") == "8.1.1.1"
    for bad <- ["08.1.1.1", "1.2.3.4.5", "1.2.3.09", "256.1.1.1"], do: assert_raise(ArgumentError, fn -> host.(bad) end)
    assert host.("1.2.3.4.example") == "1.2.3.4.example"
  end

  # The audit of 2026-10-23.

  defp account_req(path, opts), do: Request.new("https://example.com/runlight#{path}", opts)

  defp form_post(fields, headers \\ []),
    do: [
      method: "POST",
      headers: [{"content-type", "application/x-www-form-urlencoded"} | headers],
      body: URI.encode_query(fields)
    ]

  defp cookie_from(response) do
    response.headers
    |> Enum.find_value("", fn {k, v} -> if String.downcase(k) == "set-cookie", do: v end)
    |> String.split(";")
    |> hd()
  end

  # An install with accounts: its owner, and a member who joined by invite.
  defp with_member do
    {rl, _} = harness(:sqlite, nil, at("2026-10-06T12:00:00Z"), secret: String.duplicate("k", 64))
    routes = Runlight.routes(rl, token: "app-token", accounts: true)
    handler = &Runlight.Routes.handle(routes, &1)

    json = fn cookie, method, path, body ->
      handler.(
        account_req(path,
          method: method,
          headers: [{"cookie", cookie}, {"content-type", "application/json"}],
          body: if(body == nil, do: "", else: Jason.encode!(body))
        )
      )
    end

    owner =
      cookie_from(
        handler.(
          account_req(
            "/setup",
            form_post(%{
              code: "app-token",
              email: "jon@example.com",
              password: "a long password",
              again: "a long password"
            })
          )
        )
      )

    sent = json.(owner, "POST", "/api/people", %{allSites: true, email: "mo@example.com", role: "member"})
    invite = URI.parse(Jason.decode!(sent.body)["link"])
    code = URI.decode_query(invite.query)["code"]

    member =
      cookie_from(
        handler.(
          account_req("/invite", form_post(%{code: code, password: "a long password", again: "a long password"}))
        )
      )

    %{rl: rl, handler: handler, json: json, owner: owner, member: member}
  end

  defp sign_in(handler, headers \\ []) do
    handler.(
      account_req(
        "/login",
        form_post(%{email: "mo@example.com", password: "a long password", next: "/runlight/"}, headers)
      )
    )
  end

  test "audit 2026-10-23: a member sees and revokes only the tokens they made, and cannot replace a site's agents key" do
    %{json: json, owner: owner, member: member} = with_member()
    make = fn cookie, name -> Jason.decode!(json.(cookie, "POST", "/api/tokens", %{name: name}).body)["token"]["id"] end
    owners = make.(owner, "Owner's")
    mine = make.(member, "Member's")

    listed = fn cookie ->
      Jason.decode!(json.(cookie, "GET", "/api/tokens", nil).body)["tokens"] |> Enum.map(& &1["id"]) |> Enum.sort()
    end

    assert listed.(member) == [mine]
    assert listed.(owner) == Enum.sort([owners, mine]), "the owner sees every token"
    assert json.(member, "DELETE", "/api/tokens/#{owners}", nil).status == 404, "the owner's token is not the member's"
    assert listed.(owner) == Enum.sort([owners, mine])
    assert json.(member, "DELETE", "/api/tokens/#{mine}", nil).status == 200
    assert json.(member, "POST", "/api/observe-key/new?site=default", %{}).status == 403
    assert json.(owner, "POST", "/api/observe-key/new?site=default", %{}).status == 200
  end

  test "audit 2026-10-23: signing out ends this browser's session, signing out everywhere ends them all, and only from the dashboard's own pages" do
    %{handler: handler, json: json, member: member} = with_member()

    set_cookie = fn r ->
      Enum.find_value(r.headers, "", fn {k, v} -> if String.downcase(k) == "set-cookie", do: v end)
    end

    other = cookie_from(sign_in(handler))

    cross_site = handler.(account_req("/logout", headers: [{"cookie", member}, {"sec-fetch-site", "cross-site"}]))
    assert cross_site.status == 403, "another site cannot sign anyone out"

    out = handler.(account_req("/logout", headers: [{"cookie", member}, {"sec-fetch-site", "same-origin"}]))
    assert out.status == 303
    assert set_cookie.(out) =~ ~r/Max-Age=0/i, "this browser's cookie goes"
    assert json.(other, "GET", "/api/account", nil).status == 200, "the other browser stays signed in"

    third = cookie_from(sign_in(handler))
    ended = json.(other, "POST", "/api/account/sign-out-everywhere", %{})
    assert ended.status == 200
    assert set_cookie.(ended) =~ ~r/Max-Age=0/i
    assert json.(other, "GET", "/api/account", nil).status == 401, "the browser that asked is signed out"
    assert json.(third, "GET", "/api/account", nil).status == 401, "and so is every other"
    assert json.(member, "GET", "/api/account", nil).status == 401, "and a cookie copied before"

    back = cookie_from(sign_in(handler))
    assert json.(back, "GET", "/api/account", nil).status == 200, "signing in again works"
  end

  test "audit 2026-10-23: the sign-in forms take a post only from their own pages" do
    %{handler: handler} = with_member()

    for site <- ["cross-site", "same-site"] do
      refused = sign_in(handler, [{"sec-fetch-site", site}])
      assert refused.status == 403, site
      refute Enum.any?(refused.headers, fn {k, _} -> String.downcase(k) == "set-cookie" end), "#{site}: no session"
    end

    assert sign_in(handler, [{"sec-fetch-site", "same-origin"}]).status == 303
  end

  test "audit 2026-10-23: a new password can take back the tokens the account made" do
    %{json: json, member: member} = with_member()
    json.(member, "POST", "/api/tokens", %{name: "Kept"})

    changed =
      json.(member, "POST", "/api/account/password", %{current: "a long password", next: "another long password"})

    fresh = cookie_from(changed)
    kept = json.(fresh, "GET", "/api/tokens", nil)
    assert kept.status == 200, kept.body
    assert length(Jason.decode!(kept.body)["tokens"]) == 1, "kept unless asked"

    latest =
      cookie_from(
        json.(fresh, "POST", "/api/account/password", %{
          current: "another long password",
          next: "a third long password",
          revokeTokens: true
        })
      )

    assert Jason.decode!(json.(latest, "GET", "/api/tokens", nil).body)["tokens"] == []
  end

  test "audit 2026-10-23: a flood of made-up names cannot reset the count of one close to its limit" do
    {rl, _} = harness(:sqlite, nil, at("2026-10-06T12:00:00Z"))
    throttle = Runlight.Accounts.Throttle.new(rl.table, :audit_flood, 3)
    now = System.os_time(:millisecond)
    assert Runlight.Accounts.Throttle.take(throttle, "target", now)
    assert Runlight.Accounts.Throttle.take(throttle, "target", now)
    for i <- 0..10_049, do: Runlight.Accounts.Throttle.take(throttle, "made-up-#{i}", now)
    assert Runlight.Accounts.Throttle.take(throttle, "target", now)
    refute Runlight.Accounts.Throttle.take(throttle, "target", now), "the target's earlier tries still count"
  end

  test "audit 2026-10-23: yesterday's salt leaves memory when it leaves the store, on the first hit after midnight" do
    {rl, clock} = harness(:sqlite, nil, at("2026-10-06T12:00:00Z"))
    hit(rl, JS.obj(k: "pageview", u: "https://example.com/"), "203.0.113.1")
    advance(clock, 13 * @hour)
    hit(rl, JS.obj(k: "pageview", u: "https://example.com/"), "203.0.113.9")
    cached = Runlight.State.get(rl.table, {:salts, "UTC"})
    assert cached.day == "2026-10-07"
    assert cached.yesterday == nil, "no visit was left open, so yesterday's salt is gone from here too"
  end

  defmodule Busy do
    @moduledoc false
    # A Db whose next few event inserts fail as a busy SQLite does.
    @behaviour Runlight.Db

    def new(inner, fails), do: %Db{module: __MODULE__, dialect: inner.dialect, state: %{inner: inner, fails: fails}}

    @impl Db
    def all(db, sql, params), do: Db.all(db.state.inner, sql, params)

    @impl Db
    def run(db, sql, params) do
      if sql =~ "INSERT INTO rl_events" and Agent.get_and_update(db.state.fails, &{&1, &1 - 1}) > 0,
        do: raise("SQLITE_BUSY: database is locked")

      Db.run(db.state.inner, sql, params)
    end

    @impl Db
    def affected(db, sql, params), do: Db.affected(db.state.inner, sql, params)
    @impl Db
    def transaction(db, fun), do: Db.transaction(db.state.inner, fun)
    @impl Db
    def exclusive(db, fun), do: Db.exclusive(db.state.inner, fun)
  end

  test "audit 2026-10-23: a hit tried again after the store was busy counts once" do
    {store, cleanup} = Stores.store(:sqlite)
    on_exit(cleanup)
    {:ok, fails} = Agent.start_link(fn -> 0 end)
    now = at("2026-10-06T12:00:00Z")

    rl =
      Runlight.new(
        store: Store.new(Busy.new(store.db, fails)),
        site: [hostnames: ["example.com"], timezone: "UTC"],
        now: fn -> now end
      )

    Runlight.init(rl)
    Agent.update(fails, fn _ -> 2 end)
    hit(rl, JS.obj(k: "pageview", u: "https://example.com/", i: "p1"), "203.0.113.1")
    Agent.update(fails, fn _ -> 1 end)
    hit(rl, JS.obj(k: "engagement", u: "https://example.com/", i: "p1", e: 5000), "203.0.113.1")
    [visit] = Store.all_rows(rl.store, "SELECT pageviews, engaged_ms FROM rl_sessions", [])
    assert JS.number(visit["pageviews"]) == 1
    assert JS.number(visit["engaged_ms"]) == 5000
    assert length(Store.all_rows(rl.store, "SELECT id FROM rl_events WHERE kind = 'pageview'", [])) == 1
  end

  test "audit 2026-10-23: a funnel over more visits than the cap counts the newest and says so" do
    {rl, clock} = harness(:sqlite, nil, at("2026-10-06T12:00:00Z"))

    for ip <- ["203.0.113.1", "203.0.113.2", "203.0.113.3"] do
      hit(rl, JS.obj(k: "pageview", u: "https://example.com/pricing"), ip)
      advance(clock, @minute)
    end

    routes = Runlight.routes(rl, token: "secret")

    Runlight.Routes.handle(
      routes,
      Request.new("https://example.com/runlight/api/funnels?site=default",
        method: "POST",
        headers: [{"authorization", "Bearer secret"}, {"content-type", "application/json"}],
        body:
          Jason.encode!(%{
            name: "F",
            steps: [%{kind: "page", match: "/pricing"}, %{kind: "page", match: "/thanks"}]
          })
      )
    )

    capped = Runlight.routes(%{rl | store: %{rl.store | funnel_visits: 2}}, token: "secret")
    [funnel] = Jason.decode!(api(capped, "/api/funnels?period=today").body)["funnels"]
    assert funnel["sampled"] == 2
    assert hd(funnel["steps"])["visits"] == 2

    roomy = Runlight.routes(%{rl | store: %{rl.store | funnel_visits: 10}}, token: "secret")
    refute Map.has_key?(hd(Jason.decode!(api(roomy, "/api/funnels?period=today").body)["funnels"]), "sampled")
  end

  test "audit 2026-10-23: a prop named __proto__ is kept" do
    {rl, _} = harness(:sqlite, nil, at("2026-10-06T12:00:00Z"))

    Runlight.collect(
      rl,
      Request.new("https://example.com/runlight/e",
        method: "POST",
        headers: [{"user-agent", @chrome}, {"x-forwarded-for", "203.0.113.1"}],
        body: ~s({"k":"event","u":"https://example.com/","n":"Odd","p":{"__proto__":"x","plain":"y"}})
      )
    )

    [row] = Store.all_rows(rl.store, "SELECT props FROM rl_events WHERE name = 'Odd'", [])
    assert Jason.decode!(row["props"]) == %{"__proto__" => "x", "plain" => "y"}
  end

  test "audit 2026-10-23: an automatic link event keeps its link without the query string or fragment" do
    {rl, _} = harness(:sqlite, nil, at("2026-10-06T12:00:00Z"))

    send_event = fn name, url ->
      hit(rl, JS.obj(k: "event", u: "https://example.com/", n: name, p: JS.obj(url: url)), "203.0.113.1")
    end

    send_event.("Outbound link", "https://other.example/reset?token=abc&email=a@b.example#top")
    send_event.("File download", "https://example.com/a.pdf?sig=x")
    send_event.("Signup", "https://example.com/?plan=pro")
    rows = Store.all_rows(rl.store, "SELECT name, props FROM rl_events ORDER BY name", [])

    assert Enum.map(rows, &[&1["name"], Jason.decode!(&1["props"])["url"]]) == [
             ["File download", "https://example.com/a.pdf"],
             ["Outbound link", "https://other.example/reset"],
             ["Signup", "https://example.com/?plan=pro"]
           ]
  end

  test "audit 2026-10-23: a local install's address cannot end in a newline" do
    assert Runlight.Safefetch.install_address?("http://localhost:3000/", true)
    assert Runlight.Safefetch.install_address?("http://127.0.0.1", true)
    refute Runlight.Safefetch.install_address?("http://localhost\n", true)
    refute Runlight.Safefetch.install_address?("http://127.0.0.1:8080\n", true)
  end
end

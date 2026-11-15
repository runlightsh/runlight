defmodule Runlight.ReviewTest do
  @moduledoc """
  The fixes from the review of 2026-11-14: nothing of a statement reaches an app's telemetry or a logged error,
  no deadline in the client on a statement, a connection with no address, a request the plugs cannot read, busy
  stores as these drivers word them, an icon looked up once, a forwarding header in any case, scrypt hashes made
  again, and OAuth paths told by the path alone.
  """
  use ExUnit.Case, async: false
  import Plug.Test
  import Plug.Conn

  alias Runlight.Accounts
  alias Runlight.Crypto
  alias Runlight.Db
  alias Runlight.Http.Request
  alias Runlight.Http.Response
  alias Runlight.Icon
  alias Runlight.JS
  alias Runlight.Store
  alias Runlight.Test.FakeFetcher
  alias Runlight.Test.Stores

  @moduletag timeout: 300_000

  @chrome "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
  @now 1_791_471_600_000

  defp instance(kind, url, opts \\ [], repo_opts \\ []) do
    {store, cleanup} = Stores.store(kind, url, repo_opts)
    on_exit(cleanup)

    rl =
      Runlight.new(
        Keyword.merge([store: store, site: [hostnames: ["example.com"], timezone: "UTC"], now: fn -> @now end], opts)
      )

    Runlight.init(rl)
    rl
  end

  defp hit(rl, body, headers \\ []) do
    Runlight.collect(
      rl,
      Request.new("https://example.com/runlight/e",
        method: "POST",
        headers: [{"user-agent", @chrome}, {"content-type", "text/plain;charset=UTF-8"}] ++ headers,
        body: JS.stringify(body),
        remote_address: "203.0.113.9"
      )
    )
  end

  # Everything a query event of any of the test repos carries, as text, sent to the test.
  def relay(_event, _measurements, metadata, test) do
    send(test, {:query, inspect({metadata[:query], metadata[:params], metadata[:cast_params]}, limit: :infinity)})
  end

  for {kind, url} <- Stores.kinds() do
    @kind kind
    @url url

    test "#{kind}: an app's telemetry handler is handed no salt, visitor hash, or password hash" do
      rl = instance(@kind, @url)
      name = "review-#{System.unique_integer([:positive])}"

      events =
        for repo <- [:sqlite_repo, :pg_repo, :my_repo], do: [:runlight, :test, repo, :query]

      :telemetry.attach_many(name, events, &__MODULE__.relay/4, self())
      on_exit(fn -> :telemetry.detach(name) end)

      hit(rl, JS.obj(k: "pageview", u: "https://example.com/", i: "p1"))
      acc = Accounts.new(rl, String.duplicate("s", 64))
      user = Accounts.set_password(acc, "owner@example.com", "a long password", @now)
      assert Accounts.sign_in(acc, "owner@example.com", "a long password")

      [salt] = Store.all_rows(rl.store, "SELECT salt FROM rl_salts", [])
      [visit] = Store.all_rows(rl.store, "SELECT visitor FROM rl_sessions", [])
      secrets = [salt["salt"], visit["visitor"], user["hash"], "owner@example.com"]
      assert Enum.all?(secrets, &(is_binary(&1) and &1 != ""))

      seen = collect_queries([])
      for text <- seen, secret <- secrets, do: refute(text =~ secret, "telemetry was handed #{secret}")
      assert seen == [], "no statement of Runlight's is an event at all"
    end

    test "#{kind}: a statement that fails is named by the database's words, never by its values" do
      rl = instance(@kind, @url)

      error =
        assert_raise(@kind |> Atom.to_string() |> driver_error(), fn ->
          Db.run(rl.store.db, "INSERT INTO rl_no_such_table (a) VALUES (?)", ["a-secret-value"])
        end)

      assert Exception.message(error) =~ "rl_no_such_table"
      refute Exception.message(error) =~ "a-secret-value"
    end

    test "#{kind}: a statement that runs past the repo's own timeout is left to finish" do
      # MySQL and MariaDB statements already ran inside a checkout with no deadline, and the helper that empties
      # their database between tests runs under the repo's own, so only the others get a short one here.
      mysql = @kind |> Atom.to_string() |> String.starts_with?(["mysql", "mariadb"])
      rl = instance(@kind, @url, [], if(mysql, do: [], else: [timeout: 150]))

      slow =
        if @kind |> Atom.to_string() |> String.starts_with?("sqlite"),
          do:
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 4000000) SELECT COUNT(*) AS n FROM c",
          else:
            if(@kind |> Atom.to_string() |> String.starts_with?("postgres"),
              do: "SELECT pg_sleep(1) AS n",
              else: "SELECT SLEEP(1) AS n"
            )

      started = System.monotonic_time(:millisecond)
      assert [_] = Db.all(rl.store.db, slow, [])
      assert System.monotonic_time(:millisecond) - started > 150, "the statement was slow enough to tell"
      # The connection was not dropped for it.
      assert Store.setting(rl.store, "nothing") == nil
    end

    test "#{kind}: signing in hashes a scrypt password again as PBKDF2, and a wrong password changes nothing" do
      rl = instance(@kind, @url)
      acc = Accounts.new(rl, String.duplicate("s", 64))
      user = Accounts.set_password(acc, "owner@example.com", "a long password", 1)
      salt = :crypto.strong_rand_bytes(16)
      key = Crypto.scrypt("a long password", salt, 16, 8, 1, 32)
      old = "scrypt$16$8$1$#{Crypto.base64url(salt)}$#{Crypto.base64url(key)}"
      Db.run(rl.store.db, "UPDATE rl_users SET hash = ? WHERE id = ?", [old, user["id"]])

      assert Accounts.sign_in(acc, "owner@example.com", "a wrong password") == nil
      assert Accounts.by_id(acc, user["id"])["hash"] == old

      signed_in = Accounts.sign_in(acc, "owner@example.com", "a long password")
      assert signed_in["hash"] =~ ~r/\Apbkdf2\$600000\$/
      assert Accounts.by_id(acc, user["id"])["hash"] == signed_in["hash"]
      assert Accounts.sign_in(acc, "owner@example.com", "a long password")
    end
  end

  defp driver_error("sqlite" <> _), do: Exqlite.Error
  defp driver_error("postgres" <> _), do: Postgrex.Error
  defp driver_error(_), do: MyXQL.Error

  defp collect_queries(seen) do
    receive do
      {:query, text} -> collect_queries([text | seen])
    after
      50 -> seen
    end
  end

  for {kind, _} <- Stores.kinds(), kind in [:mysql, :mariadb] do
    @kind kind
    test "#{kind}: a connection lost after its mode was dropped never runs the statement on another" do
      url = Keyword.fetch!(Stores.kinds(), @kind)
      mode_on = "SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')"
      {store, cleanup} = Stores.store(@kind, url, after_connect: {MyXQL, :query!, [mode_on, []]})
      on_exit(cleanup)
      Store.migrate(store)
      {:ok, killer} = MyXQL.start_link(Stores.parse(url))

      # Inside one checkout, as a statement and the mode it runs under are: the session is killed between the two.
      result =
        try do
          Db.exclusive(store.db, fn db ->
            [row] = Db.all(db, "SELECT CONNECTION_ID() AS id", [])
            MyXQL.query!(killer, "KILL #{JS.string(row["id"])}", [])
            Process.sleep(200)
            Db.all(db, "SELECT @@SESSION.sql_mode AS mode, ? AS v", ["a\\' , 'x') -- "])
          end)
        rescue
          error -> {:raised, error}
        end

      case result do
        {:raised, _} -> :ok
        [row] -> refute row["mode"] =~ "NO_BACKSLASH_ESCAPES", "the statement ran on a session that still had the mode"
      end

      # And the next statement, on a new connection, has the mode dropped again before it runs.
      value = "a\\' , 'x') -- \\\\ end"
      assert [row] = Db.all(store.db, "SELECT @@SESSION.sql_mode AS mode, ? AS v", [value])
      refute row["mode"] =~ "NO_BACKSLASH_ESCAPES"
      assert row["v"] == value
    end
  end

  test "a hit is tried again after the pool had no connection free, and after SQLite was busy" do
    busy = fn message ->
      error =
        try do
          raise message
        rescue
          e -> e
        end

      # busy?/1 is private: a hit whose first insert fails this way is counted when it is tried again.
      {store, cleanup} = Stores.store(:sqlite)
      on_exit(cleanup)
      {:ok, fails} = Agent.start_link(fn -> 1 end)
      db = Runlight.ReviewTest.Failing.new(store.db, fails, error)
      rl = Runlight.new(store: Store.new(db), site: [hostnames: ["example.com"], timezone: "UTC"], now: fn -> @now end)
      Runlight.init(rl)
      hit(rl, JS.obj(k: "pageview", u: "https://example.com/", i: "p1"))
      length(Store.all_rows(rl.store, "SELECT id FROM rl_events WHERE kind = 'pageview'", []))
    end

    queue =
      DBConnection.ConnectionError.exception(
        "connection not available and request was dropped from queue after 2000ms. This means requests are coming in"
      )

    assert busy.(queue) == 1
    assert busy.(Exqlite.Error.exception(message: "Database busy")) == 1
    assert busy.(Exqlite.Error.exception(message: "Database is busy")) == 1
    # Anything else is not tried again: the hit is lost, and said so in the log, never raised to the app.
    assert busy.(RuntimeError.exception("the disk is full")) == 0
  end

  defmodule Failing do
    @moduledoc false
    # A Db whose next few event inserts fail with a given error.
    @behaviour Runlight.Db

    def new(inner, fails, error),
      do: %Db{module: __MODULE__, dialect: inner.dialect, state: %{inner: inner, fails: fails, error: error}}

    @impl Db
    def all(db, sql, params), do: Db.all(db.state.inner, sql, params)

    @impl Db
    def run(db, sql, params) do
      if sql =~ "INSERT INTO rl_events" and Agent.get_and_update(db.state.fails, &{&1, &1 - 1}) > 0,
        do: raise(db.state.error)

      Db.run(db.state.inner, sql, params)
    end

    @impl Db
    def affected(db, sql, params), do: Db.affected(db.state.inner, sql, params)
    @impl Db
    def transaction(db, fun), do: Db.transaction(db.state.inner, fun)
    @impl Db
    def exclusive(db, fun), do: Db.exclusive(db.state.inner, fun)
  end

  test "a forwarding header named in any case reads its last entry, never the whole list" do
    for name <- ["x-forwarded-for", "X-Forwarded-For", " X-FORWARDED-FOR "] do
      rl = instance(:sqlite, nil, trust_proxy: name)

      request =
        Request.new("https://example.com/",
          headers: [{"x-forwarded-for", "198.51.100.1, 203.0.113.7"}],
          remote_address: "10.0.0.1"
        )

      assert Runlight.client_ip(rl, request) == "203.0.113.7", name
    end

    rl = instance(:sqlite, nil, trust_proxy: "CF-Connecting-IP")
    request = Request.new("https://example.com/", headers: [{"cf-connecting-ip", "203.0.113.8"}])
    assert Runlight.client_ip(rl, request) == "203.0.113.8"
  end

  test "an icon asked for many times at once is looked up once" do
    {fetcher, agent} =
      FakeFetcher.new(fn url, _ ->
        Process.sleep(50)

        {:ok,
         if(url == "https://1.1.1.1/favicon.ico",
           do: Response.new("icon", 200, [{"content-type", "image/x-icon"}]),
           else: Response.new("nope", 500)
         )}
      end)

    rl = instance(:sqlite, nil, fetcher: fetcher)

    icons =
      1..6
      |> Enum.map(fn _ -> Task.async(fn -> Icon.fetch_icon(rl, "https://1.1.1.1") end) end)
      |> Task.await_many(10_000)

    assert Enum.uniq(icons) == [%{body: "icon", type: "image/x-icon"}]
    assert Enum.map(FakeFetcher.requests(agent), & &1["url"]) == ["https://1.1.1.1/", "https://1.1.1.1/favicon.ico"]
  end

  test "an account kept to one site reads a report whose query names /oauth/, and is still kept from OAuth" do
    rl = instance(:sqlite, nil, secret: String.duplicate("k", 64))
    routes = Runlight.routes(rl, accounts: true, token: "secret")
    acc = routes.web.accounts
    Accounts.set_password(acc, "owner@example.com", "a long password", @now)
    viewer = Accounts.set_password(acc, "viewer@example.com", "a long password", @now, "viewer", "default")
    cookie = "#{Accounts.session_cookie()}=#{JS.encode_uri_component(Accounts.session_for(acc, viewer, @now))}"

    get = fn path ->
      Runlight.Routes.handle(routes, Request.new("https://example.com/runlight#{path}", headers: [{"cookie", cookie}]))
    end

    assert get.("/api/stats?site=default&filter=page:is:/oauth/callback").status == 200
    assert get.("/api/stats?site=default").status == 200
    # The consent page is not theirs to allow from: asked there, they are no owner.
    refute get.("/oauth/authorize?client_id=x").status == 200
  end

  describe "round two" do
    @gptbot "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)"

    defp events(rl, kind),
      do: Store.all_rows(rl.store, "SELECT * FROM rl_events WHERE kind = ? ORDER BY id", [kind])

    test "a short link past the tracker's limit for one address still redirects, and is not counted" do
      rl = instance(:sqlite, nil, rate_limit: 2)
      Runlight.Links.create(rl, "default", %{"url" => "https://example.org/deal", "slug" => "deal"})

      click = fn ip ->
        Runlight.link_handler(
          rl,
          Request.new("https://example.com/go/deal", headers: [{"user-agent", @chrome}], remote_address: ip)
        )
      end

      assert Enum.map(1..4, fn _ -> click.("203.0.113.5").status end) == [302, 302, 302, 302]
      assert length(events(rl, "click")) == 2
      # Another address has its own count, and one with no address is not limited.
      assert click.("203.0.113.6").status == 302
      for _ <- 1..3, do: click.("")
      assert length(events(rl, "click")) == 6
    end

    test "an AI fetch seen live is limited at ten times the tracker's limit, and a reported one is not" do
      rl = instance(:sqlite, nil, rate_limit: 1)

      fetch = fn opts ->
        Runlight.observe(
          rl,
          Request.new("https://example.com/post", headers: [{"user-agent", @gptbot}], remote_address: "203.0.113.5"),
          nil,
          opts
        )
      end

      assert Enum.map(1..11, fn _ -> fetch.([]) end) == List.duplicate(true, 10) ++ [false]
      assert fetch.(agent_ip: "")
      assert fetch.(agent_ip: "203.0.113.5")
      assert length(events(rl, "fetch")) == 12

      off = instance(:sqlite, nil, rate_limit: false)

      assert Enum.all?(1..30, fn _ ->
               Runlight.observe(
                 off,
                 Request.new("https://example.com/post",
                   headers: [{"user-agent", @gptbot}],
                   remote_address: "203.0.113.5"
                 )
               )
             end)
    end

    test "a newer day's salt is never deleted" do
      rl = instance(:sqlite, nil)
      for day <- ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"], do: Store.salt(rl.store, day, "s-" <> day)
      Store.drop_salts_except(rl.store, ["2026-10-07", "2026-10-06"])
      days = rl.store |> Store.all_rows("SELECT day FROM rl_salts ORDER BY day", []) |> Enum.map(& &1["day"])
      assert days == ["2026-10-06", "2026-10-07", "2026-10-08"]
    end

    test "a fetch is kept under the host a trusted proxy names, and a user agent given as text stands in for the header" do
      rl = instance(:sqlite, nil, site: [hostnames: ["example.com"], timezone: "UTC"])

      forwarded = fn from ->
        Request.new("https://internal.local/post",
          headers: [{"user-agent", @gptbot}, {"x-forwarded-host", "www.example.com:8443, proxy.local"}],
          remote_address: from
        )
      end

      # From a public address the header is the client's to write, so the fetch is for no site here.
      refute Runlight.observe(rl, forwarded.("8.8.8.8"))
      assert Runlight.observe(rl, forwarded.("10.0.0.5"))
      assert [fetch] = events(rl, "fetch")
      assert fetch["hostname"] == "example.com"

      # A logged user agent that no header could hold.
      logged = "Mozilla/5.0 (compatible; GPTBot/1.2)\n中文"
      assert Runlight.observe(rl, Request.new("https://example.com/b"), nil, agent_ip: "", user_agent: logged)
      refute Runlight.observe(rl, Request.new("https://example.com/c"), nil, agent_ip: "", user_agent: @chrome)
      assert length(events(rl, "fetch")) == 2
    end

    test "stored text loses U+0000, keeps whole characters at its limit, and reads half a pair as U+FFFD" do
      parse = fn fields ->
        Runlight.Payload.parse(JS.stringify(JS.obj([k: "event", u: "https://example.com/", n: "Signup"] ++ fields)))
      end

      page = Runlight.Payload.parse(JS.stringify(JS.obj(k: "pageview", u: "https://example.com/", t: "a\u0000b")))
      assert page.title == "ab"

      lone = Runlight.Payload.parse(~S({"k":"pageview","u":"https://example.com/","t":"a\ud83db"}))
      assert lone.title == "a�b"

      emoji = "\u{1F600}"
      value = String.duplicate("x", 499) <> emoji <> "y"
      assert parse.(p: JS.obj(plan: value)).props["plan"] == String.duplicate("x", 499) <> emoji

      assert parse.(p: JS.obj([{"\u0000", "skipped"}, {" a\u0000b ", "kept"}])).props |> Runlight.JS.Object.keys() == [
               "ab"
             ]

      assert parse.(s: String.duplicate("s", 70)).site == String.duplicate("s", 64)

      utm = Runlight.Sources.parse_page(Runlight.Url.new("https://example.com/?utm_source=a%00b"))
      assert utm.utm.source == "ab"
    end

    test "utm_source kit or convertkit is Kit, by email" do
      for alias_name <- ["kit", "Kit", "CONVERTKIT"] do
        page = Runlight.Sources.parse_page(Runlight.Url.new("https://example.com/?utm_source=#{alias_name}"))
        found = Runlight.Sources.attribute(page, "", ["example.com"])
        assert {found.source, found.channel} == {"Kit", "Email"}, alias_name
      end
    end

    test "a downloaded agent list stands in only while it is newer than the one that came with this version" do
      url = hd(Runlight.Assets.agent_range_urls())
      shipped = JS.date_parse(Runlight.Assets.agent_ranges_fetched_at())
      bundled = Runlight.AgentCheck.compile(Runlight.Assets.agent_range_lists()[url])
      mine = Runlight.AgentCheck.compile(["203.0.113.0/24"])

      in_use = fn saved ->
        rl = instance(:sqlite, nil)
        Store.set_setting(rl.store, "agent-ranges", JS.stringify(saved))
        Runlight.check(rl)
        Runlight.State.get(rl.table, :agent_ranges)[url]
      end

      lists = JS.obj([{url, ["203.0.113.0/24"]}])
      assert in_use.(JS.obj(at: shipped - 1, lists: lists)) == bundled
      assert in_use.(JS.obj(at: shipped + 1, lists: lists)) == mine
      assert in_use.(JS.obj(at: shipped + 1, lists: lists, fetched: JS.obj([{url, shipped - 1}]))) == bundled
      assert in_use.(JS.obj(at: 0, lists: lists, fetched: JS.obj([{url, shipped}]))) == mine
      # A record that keeps times, with none for this list, has no word that it is newer.
      assert in_use.(JS.obj(at: shipped + 1, lists: lists, fetched: JS.obj([]))) == bundled
    end

    test "an install whose site has no usable id or name is refused before anything is saved" do
      sites = fn site ->
        fn url, _ ->
          {:ok,
           if(String.ends_with?(url, "/api/sites"),
             do: Response.new(JS.stringify(JS.obj(sites: [site])), 200, [{"content-type", "application/json"}]),
             else: Response.new("{}", 404, [{"content-type", "application/json"}])
           )}
        end
      end

      connect = fn site ->
        rl = instance(:sqlite, nil, managed_sites: true, site: nil, fetcher: sites.(site))

        try do
          Runlight.add_site(rl, JS.obj(remote: JS.obj(url: "https://93.184.215.14/runlight", token: "rl_t")))
        rescue
          error in Runlight.SettingsError -> error.code
        end
      end

      assert connect.(JS.obj(id: "blog", name: 5)) == "connect_not_runlight"
      assert connect.(JS.obj(id: "", name: "Blog")) == "connect_not_runlight"
      assert connect.(JS.obj(id: String.duplicate("a", 65), name: "Blog")) == "connect_not_runlight"
      assert connect.(JS.obj(id: 7, name: "Blog")) == "connect_not_runlight"

      made = connect.(JS.obj(id: "blog", name: "  " <> String.duplicate("n", 90), hostnames: ["", "--blog.example"]))
      assert made["id"] == "blog.example"
      assert made["name"] == String.duplicate("n", 80)
    end

    test "only the first 512 characters of a user agent are read, and Safari's version is its first number" do
      long = @chrome <> String.duplicate(" x", 300) <> " GPTBot/1.2 bot"
      assert Runlight.Ua.ai_agent(long) == nil
      refute Runlight.Ua.bot?(long)
      assert Runlight.Ua.ai_agent(@gptbot)

      safari = fn version ->
        Runlight.Ua.parse_client(
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/#{version} Safari/605.1.15"
        )
      end

      for version <- ["18", "18.1.1", "18."] do
        assert %{browser: "Safari", browser_version: "18"} = safari.(version)
      end

      brands = String.duplicate("x", 600) <> ~s("Brave")
      assert Runlight.Ua.parse_client(@chrome, %{brands: brands}).browser == "Chrome"
    end

    test "a forwarded address loses its port and its brackets" do
      rl = instance(:sqlite, nil, trust_proxy: true)

      from = fn value ->
        Runlight.client_ip(rl, Request.new("https://example.com/", headers: [{"x-forwarded-for", value}]))
      end

      assert from.("203.0.113.7:51234") == "203.0.113.7"
      assert from.("[2001:db8::1]:443") == "2001:db8::1"
      assert from.("[2001:db8::1]") == "2001:db8::1"
      assert from.("2001:db8::1") == "2001:db8::1"
      assert from.("[2001:db8::1]x") == "[2001:db8::1]x"
      assert from.("198.51.100.1, 203.0.113.7:80") == "203.0.113.7"
    end

    test "an address longer than 320 characters is no email address" do
      assert Runlight.email?(String.duplicate("a", 308) <> "@example.com")
      refute Runlight.email?(String.duplicate("a", 309) <> "@example.com")
    end

    test "a link imported once and deleted since is left deleted" do
      rl = instance(:sqlite, nil)
      foreign = JS.obj(sourceId: "abc", slug: "deal", url: "https://example.org/deal", name: "Deal", createdAt: @now)
      history = JS.obj(clicks: [JS.obj(ts: @now - 1000)])
      assert %{status: "created"} = Runlight.Importers.write_link(rl, "default", "dub", foreign, history)
      id = Runlight.Importers.imported_link_id("dub", "abc")
      Runlight.Links.remove(rl, id)
      assert Store.link_by_id(rl.store, id) == nil
      assert Store.link_exists?(rl.store, id)
      assert %{status: "skipped"} = Runlight.Importers.write_link(rl, "default", "dub", foreign, history)
      assert length(events(rl, "click")) == 1, "its clicks were left as they were"
      refute Store.link_exists?(rl.store, "0" <> String.slice(id, 1..-1//1))
    end

    test "imported columns keep names, places, screens, and languages, and nothing that reads as an address or a user agent" do
      alias Runlight.Importers

      assert Importers.browser_name("chrome") == "Chrome"
      assert Importers.browser_name("arc browser") == "Arc browser"
      assert Importers.browser_name("203.0.113.7") == ""
      assert Importers.browser_name(@chrome) == ""
      assert Importers.system_name("HarmonyOS") == "HarmonyOS"
      assert Importers.system_name("2001:db8::1") == ""
      assert Importers.place_name("Montreal") == "Montreal"
      assert Importers.place_name("at 203.0.113.7") == ""
      assert Importers.place_name("Mozilla/5.0") == ""
      assert Importers.place_name(nil) == ""
      assert Importers.screen_size(" 1440x900 ") == "1440x900"
      assert Importers.screen_size("1440 by 900") == ""
      assert Importers.language_tag("pt-BR") == "pt-BR"
      assert Importers.language_tag("en-US,en;q=0.9") == ""

      row = fn time -> Importers.Visits.row_time(%{"time" => time}, "runlight") end
      assert row.("2024-05-01 12:00:00") == JS.date_parse("2024-05-01T12:00:00Z")
      assert row.("20240501") == :nan
      assert row.("1999-12-31T23:59:59Z") == :nan
      assert row.("2000-01-01T00:00:00Z") == 946_684_800_000
    end
  end

  for {kind, url} <- Stores.kinds(), not String.starts_with?(Atom.to_string(kind), "sqlite") do
    @kind kind
    @url url

    test "#{kind}: an event whose props the database cannot read as JSON counts as one with none" do
      rl = instance(@kind, @url)
      hit(rl, JS.obj(k: "pageview", u: "https://example.com/", i: "p1"))
      hit(rl, JS.obj(k: "event", u: "https://example.com/", i: "p1", n: "Signup", p: JS.obj(plan: "pro")))
      hit(rl, JS.obj(k: "event", u: "https://example.com/", i: "p1", n: "Signup", p: JS.obj(plan: "free")))
      # As another implementation could have written it: half a surrogate pair, escaped, which is valid JSON.
      [last] = Store.all_rows(rl.store, "SELECT id FROM rl_events WHERE kind = 'event' ORDER BY id DESC LIMIT 1", [])
      Db.run(rl.store.db, "UPDATE rl_events SET props = ? WHERE id = ?", [~S({"plan":"\ud83d"}), last["id"]])

      query = %{site: "default", from: @now - 3_600_000, to: @now + 3_600_000, filters: []}
      assert [key] = Store.event_prop_keys(rl.store, query, "Signup")
      assert {key["key"], key["events"]} == {"plan", 1}
      assert [value] = Store.event_prop_values(rl.store, query, "Signup", "plan", 10)
      assert {value["value"], value["events"]} == {"pro", 1}
    end
  end

  describe "the plugs" do
    defmodule Router do
      use Plug.Router

      plug(:match)
      plug(Runlight.Plug.Observer, instance: Runlight.ReviewTest.RL)
      plug(Runlight.Plug.LinkDomains, instance: Runlight.ReviewTest.RL)
      plug(Runlight.Plug.Links, instance: Runlight.ReviewTest.RL)
      plug(:dispatch)

      forward("/stats", to: Runlight.Plug, init_opts: [instance: Runlight.ReviewTest.RL, token: "secret"])
      match(_, do: send_resp(conn, 200, "the app"))
    end

    defp start do
      {store, cleanup} = Stores.store(:sqlite)
      on_exit(cleanup)

      start_supervised!(
        {Runlight,
         name: Runlight.ReviewTest.RL,
         store: store,
         site: [name: "example.com", hostnames: ["example.com"], timezone: "UTC"]}
      )

      Runlight.instance(Runlight.ReviewTest.RL)
    end

    defp call(conn), do: Router.call(%{conn | host: "example.com"}, Router.init([]))

    # The Host header as a client sent it, which Plug's own helper will not set.
    defp host_header(conn, host), do: %{conn | req_headers: [{"host", host} | conn.req_headers]}

    test "a connection with no address, as over a Unix socket, is answered, and counted" do
      rl = start()

      for peer <- [{:local, "/run/app.sock"}, {:local, ""}, :unspec, {:undefined, :any}] do
        assert call(%{conn(:get, "/about") | remote_ip: peer}).resp_body == "the app"
        assert call(%{conn(:get, "/stats/s.js") | remote_ip: peer}).status == 200
      end

      body = JS.stringify(JS.obj(k: "pageview", u: "https://example.com/", i: "p1"))

      sent =
        %{conn(:post, "/stats/e", body) | remote_ip: {:local, "/run/app.sock"}}
        |> put_req_header("user-agent", @chrome)
        |> put_req_header("content-type", "text/plain")
        |> put_req_header("x-forwarded-for", "203.0.113.20")
        |> call()

      assert sent.status == 202
      assert [_] = Store.all_rows(rl.store, "SELECT id FROM rl_events WHERE kind = 'pageview'", [])
    end

    test "a Host that makes no address stops neither the app's pages nor Runlight's" do
      start()

      for host <- ["1.2.3.4.5", "example.com:99999", "a%", "exa mple.com", "[", ""] do
        assert (conn(:get, "/about") |> host_header(host) |> call()).resp_body == "the app", host
        assert (conn(:get, "/go/nothing") |> host_header(host) |> call()).resp_body == "the app", host
        assert (conn(:get, "/stats/s.js") |> host_header(host) |> call()).status == 200, host
      end
    end

    test "a path starting // or /\\ never names the request's host" do
      for path <- ["//evil.example/stats/oauth/authorize", "/\\evil.example/stats/oauth/authorize"] do
        conn = %{conn(:get, "/") | request_path: path, host: "example.com"} |> host_header("example.com")
        {:ok, request, _} = Runlight.Plug.request(conn, 0)
        url = Runlight.Url.new(request.url)
        assert Runlight.Url.origin(url) == "http://example.com", path
        assert url.pathname =~ "evil.example"
      end

      # Nor does a Host with a name after an @, which an address reads as the host.
      conn = conn(:get, "/stats/") |> host_header("example.com@evil.example")
      {:ok, request, _} = Runlight.Plug.request(conn, 0)
      assert Runlight.Url.new(request.url).hostname == "localhost"
    end

    test "link domains that cannot be read stop no request, and are not asked for by every one" do
      rl = start()
      Runlight.forget_link_domains(rl)
      Store.run_sql(rl.store, "DROP TABLE rl_link_domains", [])

      assert call(conn(:get, "/about")).resp_body == "the app"
      assert %{domains: domains, at: at} = Runlight.State.get(rl.table, :link_domains)
      assert MapSet.size(domains) == 0
      assert call(conn(:get, "/about")).resp_body == "the app"
      assert %{at: ^at} = Runlight.State.get(rl.table, :link_domains), "the second request asked nothing"
      assert call(conn(:get, "/stats/s.js")).status == 200
    end

    test "a method no link answers goes to the app, on a link domain too" do
      rl = start()
      Store.add_link_domain(rl.store, "go.example.org", "default", @now)
      Runlight.forget_link_domains(rl)
      on = fn method -> Router.call(%{conn(method, "/nothing") | host: "go.example.org"}, Router.init([])) end

      assert on.(:get).status == 404
      for method <- ["TRACE", "TRACK", "CONNECT"], do: assert(on.(method).resp_body == "the app", method)
    end

    test "with no instance running, the app's pages are the app's and Runlight's say so" do
      assert call(conn(:get, "/about")).resp_body == "the app"
      assert call(conn(:get, "/go/deal")).resp_body == "the app"
      conn = call(conn(:get, "/stats/s.js"))
      assert conn.status == 503
      assert Jason.decode!(conn.resp_body)["code"] == "not_running"
    end

    test "a form with a file in it, read by the app's parsers, is answered without the file" do
      start()
      upload = %Plug.Upload{path: "/tmp/none", filename: "a.txt", content_type: "text/plain"}

      conn =
        %{
          conn(:post, "/stats/login")
          | body_params: %{"email" => "a@example.com", "file" => upload, "more" => [upload]}
        }
        |> put_req_header("content-type", "multipart/form-data; boundary=x")
        |> call()

      assert conn.status in 200..499
    end
  end
end

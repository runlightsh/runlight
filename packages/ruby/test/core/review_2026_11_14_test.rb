# frozen_string_literal: true

require "test_helper"
require "rack/mock"
require_relative "../support/core_test_case"

# The behaviour changed in the TypeScript after the review of 2026-11-14, as core-review.test.ts and
# auth-review.test.ts pin it there. What the fixtures and the conformance replay already cover is left to them.
class CoreReview20261114Test < CoreTestCase
  Json = Runlight::Json
  Request = Runlight::Http::Request
  SearchParams = Runlight::Http::SearchParams
  Write = Runlight::Importers::Write
  CHROME = Harness::CHROME_MAC

  def get(url, headers = {})
    Request.new(url, headers: { "user-agent" => CHROME }.merge(headers))
  end

  def fetches(t)
    t.store.db.all("SELECT hostname, name, title FROM rl_events WHERE kind = 'fetch' ORDER BY ts, hostname").map { |r| [r["hostname"].to_s, r["name"].to_s, r["title"].to_s] }
  end

  # A. Ingestion and core.

  on_every_database("a short link click past the trackers limit still redirects and is not counted") do |kind|
    t = Harness.new(kind, { "site" => { "hostnames" => ["example.com"] }, "rateLimit" => 2 })
    t.rl.links.create("default", { "url" => "https://example.org/", "slug" => "go" })
    click = ->(ip) { t.rl.link_handler.call(get("https://example.com/go/go", { "x-forwarded-for" => ip })) }
    3.times { assert_equal 302, click.call("203.0.113.5").status }
    assert_equal 2, t.count("SELECT COUNT(*) AS n FROM rl_events WHERE kind = 'click'"), "the third is redirected and left out"
    assert_equal 1, t.count("SELECT COUNT(*) AS n FROM rl_sessions"), "one visit, of two clicks"
    assert_equal 302, click.call("203.0.113.6").status
    assert_equal 3, t.count("SELECT COUNT(*) AS n FROM rl_events WHERE kind = 'click'"), "another address has its own count"
    # The same counter as tracker hits.
    t.track({ "k" => "pageview", "u" => "https://example.com/" }, { "ip" => "203.0.113.6" })
    t.track({ "k" => "pageview", "u" => "https://example.com/a" }, { "ip" => "203.0.113.6" })
    assert_equal 1, t.count("SELECT COUNT(*) AS n FROM rl_events WHERE kind = 'pageview'")
  end

  def test_an_ai_fetch_seen_live_is_limited_at_ten_times_the_rate_and_a_reported_one_never_is
    t = Harness.new("sqlite", { "site" => { "hostnames" => ["example.com"] }, "rateLimit" => 1 })
    bot = { "user-agent" => "GPTBot/1.2", "host" => "example.com", "x-forwarded-for" => "203.0.113.5" }
    seen = Array.new(11) { t.rl.observe(Request.new("https://example.com/post", headers: bot)) }
    assert_equal [true] * 10 + [false], seen
    assert t.rl.observe(Request.new("https://example.com/post", headers: bot.merge("x-forwarded-for" => "203.0.113.6"))), "another address"
    assert t.rl.observe(Request.new("https://example.com/post", headers: bot), nil, { "agentIp" => "" }), "a report is never limited, even with no address"
    off = Harness.new("sqlite", { "site" => { "hostnames" => ["example.com"] }, "rateLimit" => false })
    assert_equal [true] * 12, Array.new(12) { off.rl.observe(Request.new("https://example.com/post", headers: bot)) }
  end

  on_every_database("dropping old salts never deletes a newer days salt") do |kind|
    store = Databases.fresh(kind)
    store.migrate
    %w[2026-10-05 2026-10-06 2026-10-07 2026-10-08].each { |day| store.salt(day, "salt of #{day}") }
    # A process whose clock is a moment behind keeps the 6th and the 7th: the 8th, made by another, stays.
    store.drop_salts_except(%w[2026-10-07 2026-10-06])
    assert_nil store.salt_if_exists("2026-10-05")
    assert_equal ["salt of 2026-10-06", "salt of 2026-10-07", "salt of 2026-10-08"], %w[2026-10-06 2026-10-07 2026-10-08].map { |day| store.salt_if_exists(day) }
  end

  def test_an_ai_fetch_is_filed_under_the_host_a_trusted_proxy_names
    t = Harness.new("sqlite", { "sites" => [{ "id" => "a", "hostnames" => ["a.example"] }, { "id" => "b", "hostnames" => ["b.example"] }] })
    bot = { "user-agent" => "GPTBot/1.2", "host" => "internal:8080", "x-forwarded-host" => "www.b.example:443, proxy.internal" }
    # From a private address the proxy's word counts: its first name, without port or www.
    assert t.rl.observe(Request.new("http://internal:8080/post", headers: bot), nil, { "ip" => "10.0.0.5" })
    assert_equal ["b.example"], fetches(t).map(&:first)
    # Straight from the internet the header is the caller's own, and is not read.
    refute t.rl.observe(Request.new("http://internal:8080/post", headers: bot), nil, { "ip" => "93.184.215.14" })
    assert t.rl.observe(Request.new("http://a.example/post", headers: bot.merge("host" => "a.example")), nil, { "ip" => "93.184.215.14" })
    assert_equal %w[a.example b.example], fetches(t).map(&:first).sort
  end

  def test_observe_takes_the_user_agent_as_text_which_stands_in_for_the_header
    t = Harness.new("sqlite", { "site" => { "hostnames" => ["example.com"] } })
    logged = "Mozilla/5.0 (compatible; GPTBot/1.2)\n日本語"
    assert t.rl.observe(Request.new("https://example.com/post"), nil, { "agentIp" => "", "userAgent" => logged })
    refute t.rl.observe(Request.new("https://example.com/post", headers: { "user-agent" => "GPTBot/1.2" }), nil, { "agentIp" => "", "userAgent" => "curl/8" }),
           "the text given is the one read"
    routes = t.rl.routes({ "token" => "secret" })
    report = Request.new("https://example.com/runlight/api/observe", method: "POST", headers: { "authorization" => "Bearer secret", "content-type" => "application/json" },
                                                                    body: Json.encode({ "url" => "https://example.com/logged", "userAgent" => logged }))
    assert_equal 204, routes.handle(report).status
    assert_equal 2, fetches(t).length
  end

  def test_a_downloaded_agent_list_is_used_only_while_it_is_newer_than_the_one_that_shipped
    url = "https://openai.com/gptbot.json"
    shipped = Runlight::Importers::Client.parse_date(Runlight::AgentCheck.bundled["fetchedAt"])
    bundled_ip = "20.171.206.17"
    check = lambda do |saved|
      t = Harness.new("sqlite", { "site" => { "hostnames" => ["example.com"] } })
      t.now = [t.now, shipped + (10 * DAY)].max
      t.rl.init
      t.store.set_setting("agent-ranges", Json.encode(saved.call(t.now)))
      t.rl.check
      t.rl.observe(Request.new("https://example.com/post", headers: { "user-agent" => "GPTBot/1.2", "host" => "example.com" }), nil, { "agentIp" => bundled_ip })
      fetches(t)[0][2]
    end
    elsewhere = { url => ["192.0.2.0/24"] }
    assert_equal "verified", check.call(->(now) { { "at" => now, "lists" => elsewhere, "fetched" => { url => shipped - DAY } } }), "an older download gives way to the shipped list"
    assert_equal "verified", check.call(->(_now) { { "at" => shipped - DAY, "lists" => elsewhere } }), "a copy from before each list's time was kept goes by its own time"
    assert_equal "mismatch", check.call(->(now) { { "at" => now, "lists" => elsewhere, "fetched" => { url => now } } }), "a newer download stands in"
    assert_equal "mismatch", check.call(->(now) { { "at" => now, "lists" => elsewhere } })

    # Each successful download is given its time.
    fetcher = FakeFetcher.new { |_url, _init| Runlight::Http::Response.new(Json.encode({ "prefixes" => [{ "ipv4Prefix" => "192.0.2.0/24" }] }), status: 200) }
    t = Harness.new("sqlite", { "updateAgentRanges" => true, "fetcher" => fetcher })
    t.rl.check
    saved = Json.decode(t.store.setting("agent-ranges"))
    assert_equal saved["lists"].keys.sort, saved["fetched"].keys.sort
    assert_equal [t.now], saved["fetched"].values.uniq
  end

  def test_an_unusual_method_through_the_middleware_goes_to_the_app
    rl = Runlight.new(store: Runlight::Stores.sqlite(":memory:"), site: { hostnames: ["example.com"] })
    inner = ->(env) { [200, { "content-type" => "text/plain" }, ["app saw #{env["REQUEST_METHOD"]}"]] }
    app = Runlight::RackApp.new(inner, runlight: rl, base_path: "/runlight")
    %w[TRACE TRACK CONNECT].each do |method|
      ["/runlight/api/sites", "/go/abc", "/page"].each do |path|
        _status, _headers, body = app.call(Rack::MockRequest.env_for(path, method: method, "HTTP_HOST" => "example.com"))
        assert_equal ["app saw #{method}"], body.each.to_a, "#{method} #{path}"
      end
    end
    alone = Runlight::RackApp.new(runlight: rl, base_path: "/runlight")
    assert_equal 405, alone.call(Rack::MockRequest.env_for("/runlight/api/sites", method: "TRACE", "HTTP_HOST" => "example.com"))[0]
  end

  def test_the_icon_scan_reads_a_link_tag_of_bounded_length
    base = "https://example.com"
    assert_equal ["https://example.com/a.png"], Runlight::Icon.icon_links('<link rel="icon" href="/a.png">', base)
    assert_equal [], Runlight::Icon.icon_links("<link rel=\"icon\" #{"x" * 4001} href=\"/a.png\">", base), "past 4,000 characters it is no tag"
    assert_equal ["https://example.com/b.png"], Runlight::Icon.icon_links('<link rel="icon" <link rel="icon" href="/b.png">', base), "a tag ends before the next one starts"
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    assert_equal [], Runlight::Icon.icon_links("<link " * 30_000, base)
    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, :<, 2
  end

  def test_connecting_an_install_checks_the_site_it_names_before_anything_is_written
    answer = nil
    fetcher = FakeFetcher.new do |url, _init|
      url.end_with?("/api/token") ? Runlight::Http::Response.new("{}", status: 404) : Runlight::Http::Response.new(Json.encode({ "sites" => [answer] }), status: 200)
    end
    t = Harness.new("sqlite", { "managedSites" => true, "fetcher" => fetcher })
    connect = ->(site) { answer = site; t.rl.add_site({ "remote" => { "url" => "https://install.example.net/runlight", "token" => "rl_x" } }) }
    [{ "id" => "", "name" => "x" }, { "id" => "a" * 65, "name" => "x" }, { "id" => 7, "name" => "x" }, { "id" => "a", "name" => nil }, { "id" => "a" }, nil].each do |bad|
      error = assert_raises(Runlight::SettingsError) { connect.call(bad) }
      assert_equal "connect_not_runlight", error.code, bad.inspect
    end
    assert_equal [], t.store.sites, "nothing was written"
    assert_equal [], t.store.settings_starting_with("remote:")

    site = connect.call({ "id" => "blog", "name" => "  #{"n" * 100}  ", "hostnames" => ["", "--blog.example", 5] })
    assert_equal "blog.example", site["id"], "leading punctuation is left off the id"
    assert_equal "n" * 80, site["name"]
    assert_equal ["--blog.example"], t.rl.remote(site["id"])["hostnames"], "an empty hostname is no hostname"
    other = connect.call({ "id" => "other", "name" => "", "hostnames" => ["---"] })
    assert_equal "site", other["id"]
    assert_equal "site", other["name"]
  end

  def test_collect_never_raises_to_its_caller
    t = Harness.new("sqlite", { "site" => { "hostnames" => ["example.com"] } })
    t.rl.init
    t.store.define_singleton_method(:insert_session) { |_row| raise "the disk is full" }
    _out, err = capture_io { assert_nil t.track({ "k" => "pageview", "u" => "https://example.com/" }) }
    assert_includes err, "Runlight: could not record an event"
    assert_includes err, "the disk is full"
  end

  def test_a_user_agent_is_read_to_512_characters_and_safari_is_matched_in_linear_time
    ua = Runlight::Ua
    long = "#{CHROME} #{"x" * 500} GPTBot/1.2 bot"
    assert_nil ua.ai_agent(long), "an agent named past character 512 is not seen"
    refute ua.bot?(long)
    refute_nil ua.ai_agent("GPTBot/1.2")
    assert_equal "Chrome", ua.parse_client(long)["browser"]
    hints = { "brands" => "#{" " * 520}\"Brave\"" }
    assert_equal "Chrome", ua.parse_client(CHROME, hints)["browser"], "nor a brand past it"
    assert_equal "Brave", ua.parse_client(CHROME, { "brands" => '"Brave";v="1"' })["browser"]
    safari = ->(version) { ua.parse_client("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/#{version} Safari/605.1.15") }
    assert_equal [%w[Safari 18]] * 3, ["18", "18.1.1", "18.0"].map { |v| safari.call(v).values_at("browser", "browserVersion") }
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    ua.parse_client("Version/1#{"1." * 250}")
    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, :<, 1
    # The visitor hash still reads the whole user agent.
    t = Harness.new("sqlite", { "site" => { "hostnames" => ["example.com"] } })
    t.track({ "k" => "pageview", "u" => "https://example.com/" }, { "ua" => "#{CHROME} #{"x" * 500} one" })
    t.track({ "k" => "pageview", "u" => "https://example.com/" }, { "ua" => "#{CHROME} #{"x" * 500} two" })
    assert_equal 2, t.count("SELECT COUNT(DISTINCT visitor) AS n FROM rl_sessions")
  end

  def test_a_forwarded_address_is_read_without_its_port
    rl = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:"), "trustProxy" => true })
    read = ->(value) { rl.client_ip(Request.new("https://example.com/", headers: { "x-forwarded-for" => value })) }
    assert_equal "203.0.113.7", read.call("198.51.100.1, 203.0.113.7:51234")
    assert_equal "2001:db8::1", read.call("[2001:db8::1]:443")
    assert_equal "2001:db8::1", read.call("[2001:db8::1]")
    assert_equal "2001:db8::1", read.call("2001:db8::1")
    assert_equal "[2001:db8::1]x", read.call("[2001:db8::1]x"), "anything else is left as written"
    assert_equal "203.0.113.7", read.call("203.0.113.7")
  end

  def test_an_email_address_is_at_most_320_characters
    long = "#{"a" * 310}@example.com"
    assert Runlight::Core.email?("#{"a" * 308}@example.com")
    refute Runlight::Core.email?(long)
    store = Runlight::Stores.sqlite(":memory:")
    assert_raises(ArgumentError) { Runlight::Core.new({ "store" => store, "mail" => { "send" => ->(_m) {}, "from" => long } }) }
    accounts = Runlight::Accounts::Accounts.new(store, "k" * 64)
    store.migrate
    assert_equal "email_invalid", assert_raises(Runlight::Accounts::AccountError) { accounts.set_password(long, "a long password", 1) }.code
    assert_equal "email_invalid", assert_raises(Runlight::Accounts::AccountError) { accounts.invite(long, "admin", "jon@example.com", 1) }.code
  end

  # C. Store and importers.

  on_every_database("an event whose props the database cannot read as json counts as one with no props") do |kind|
    t = Harness.new(kind, { "site" => { "hostnames" => ["example.com"] } })
    t.track({ "k" => "pageview", "u" => "https://example.com/", "i" => "p1" })
    t.track({ "k" => "event", "u" => "https://example.com/", "i" => "p1", "n" => "Signup", "p" => { "plan" => "pro", "amount" => "12.5" } })
    visit = t.store.db.all("SELECT session, visitor FROM rl_events WHERE kind = 'event'")[0]
    # As an older version could have stored them: an escaped NUL, and half of a surrogate pair.
    ['{"plan":"a\u0000b","amount":"1"}', '{"plan":"\ud83d","amount":"1"}', '{"plan":"x\\\\\ud83d"}'].each_with_index do |props, i|
      t.store.db.run("INSERT INTO rl_events (site, ts, kind, visitor, session, pageview, path, hostname, name, props) VALUES ('default', ?, 'event', ?, ?, 'p1', '/', 'example.com', 'Signup', ?)",
                     [t.now + i + 1, visit["visitor"], visit["session"], props])
    end
    query = t.today
    keys = t.store.event_prop_keys(query, "Signup")
    assert_includes keys.map { |k| k["key"] }, "plan"
    values = t.store.event_prop_values(query, "Signup", "plan", 10)
    assert_includes values.map { |v| v["value"] }, "pro"
    goal = { "id" => "g" * 24, "site" => "default", "name" => "Signup", "kind" => "event", "match" => "Signup", "clickBy" => "", "valueMode" => "prop",
             "value" => 0, "valueProp" => "amount", "currency" => "USD", "createdAt" => t.now }
    totals = t.store.goal_totals(query, goal)
    assert_equal 4, totals["conversions"], "every event still counts"
    assert_operator totals["revenue"], :>=, 12.5
  end

  on_every_database("an import leaves a link it brought in once and that was deleted since as it is") do |kind|
    t = Harness.new(kind, { "site" => { "hostnames" => ["example.com"] } })
    t.rl.init
    foreign = { "sourceId" => "abc", "slug" => "sale", "name" => "Sale", "url" => "https://example.org/sale", "createdAt" => t.now }
    history = { "clicks" => [{ "ts" => t.now - 1000 }, { "ts" => t.now - 500 }] }
    assert_equal({ "status" => "created", "clicks" => 2 }, Write.write_link(t.rl, "default", "dub", foreign, history).slice("status", "clicks"))
    id = Write.imported_link_id("dub", "abc")
    assert t.store.link_exists(id)
    t.rl.links.remove(id)
    assert_nil t.store.link_by_id(id)
    assert t.store.link_exists(id), "a deleted link keeps its row"
    refute t.store.link_exists("f" * 24)
    assert_equal({ "status" => "skipped", "clicks" => 0 }, Write.write_link(t.rl, "default", "dub", foreign, history))
    assert_equal 2, t.count("SELECT COUNT(*) AS n FROM rl_events WHERE link = ?", [id]), "and its clicks"
  end

  def test_an_imported_link_brings_at_most_a_hundred_thousand_clicks
    assert_equal 100_000, Write::MAX_LINK_CLICKS
    t = Harness.new("sqlite", { "site" => { "hostnames" => ["example.com"] } })
    t.rl.init
    # Counted, not written: a hundred thousand rows are the database's to hold, not this test's to wait for.
    written = 0
    Runlight::Store::SqlStore.class_eval do
      alias_method :insert_event_for_real, :insert_event
      define_method(:insert_event) { |_event| written += 1 }
    end
    begin
      daily = Array.new(12) { |i| { "day" => "2026-09-#{format("%02d", i + 1)}", "clicks" => 10_000.9 } }
      result = Write.write_link(t.rl, "default", "bitly", { "sourceId" => "big", "slug" => "big", "url" => "https://example.org/" }, { "daily" => daily })
      assert_equal 100_000, result["clicks"]
      assert_equal 100_000, written
    ensure
      Runlight::Store::SqlStore.class_eval do
        alias_method :insert_event, :insert_event_for_real
        remove_method :insert_event_for_real
      end
    end
  end

  def test_imported_columns_keep_no_address_and_no_user_agent
    assert_equal ["Chrome", "Vivaldi", "", "", "", ""], ["chrome", "vivaldi", "Mozilla/5.0 (X11)", "203.0.113.9", "9front", "x" * 41].map { |n| Write.browser(n) }
    assert_equal ["macOS", "haiku", "", ""], ["Mac OS X", "haiku", "2001:db8::1", "Linux; rv:1"].map { |n| Write.system_name(n) }
    assert_equal ["Paris", "", "", "", "Mumbai Suburban"], ["Paris", "203.0.113.9", "fe80::1", "curl/8.4", "Mumbai Suburban"].map { |n| Write.place_name(n) }
    assert_equal ["1440x900", "", ""], [" 1440x900 ", "1440 by 900", "x"].map { |n| Write.screen_size(n) }
    assert_equal ["en", "pt-BR", "zh_Hant_TW", "", ""], ["en", " pt-BR ", "zh_Hant_TW", "english", "en-US,en;q=0.9"].map { |n| Write.language_tag(n) }
  end

  on_every_database("an imported row with a hostname no address can hold is kept under the sites own") do |kind|
    t = Harness.new(kind, { "site" => { "hostnames" => ["example.com"] } })
    rows = ["bad host.example", "example.com/path", "user@example.com", "shop.example.com"].each_with_index.map do |host, i|
      { "time" => "2026-09-0#{i + 1}T10:00:00Z", "visitor" => "v#{i}", "hostname" => host, "path" => "/p#{i}", "city" => "203.0.113.9", "screen" => "big", "language" => "en-GB" }
    end
    rows << { "time" => "19991231", "visitor" => "old", "hostname" => "example.com", "path" => "/old" }
    result = Runlight::Importers::Visits.import_csv_visits(t.rl, "default", rows)
    assert_equal 4, result["pageviews"]
    assert_equal 1, result["skipped"], "a time before 2000 is no time"
    hosts = t.store.db.all("SELECT hostname FROM rl_events WHERE kind = 'pageview' ORDER BY path").map { |r| r["hostname"].to_s }
    assert_equal ["example.com", "example.com", "example.com", "shop.example.com"], hosts
    assert_equal [["", "", "en-GB"]], t.store.db.all("SELECT DISTINCT city, screen, language FROM rl_sessions").map { |r| [r["city"].to_s, r["screen"].to_s, r["language"].to_s] }
  end
end

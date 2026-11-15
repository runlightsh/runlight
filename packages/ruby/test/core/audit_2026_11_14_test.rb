# frozen_string_literal: true

require "test_helper"
require "rack/mock"
require_relative "../support/core_test_case"

# The audit of 2026-11-14: what the Ruby port alone had wrong, and the checks carried over from the other ports.
class CoreAudit20261114Test < CoreTestCase
  Json = Runlight::Json
  Request = Runlight::Http::Request
  SearchParams = Runlight::Http::SearchParams
  Throttle = Runlight::Accounts::Throttle
  Accounts = Runlight::Accounts::Accounts
  Web = Runlight::Accounts::Web

  NOW = 1_791_288_000_000

  def setup
    super
    @now = NOW
  end

  def teardown
    Accounts.checks_per_minute = nil
    Accounts.instance_variable_get(:@checked).each_value(&:clear)
    super
  end

  # An install with accounts and its owner: the routes' handler, taking a request and the caller's address.
  def install(options = {})
    @rl = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:"), "secret" => "k" * 64, "now" => -> { @now } })
    routes = @rl.routes({ "token" => "app-token", "accounts" => true }.merge(options))
    @base = options["basePath"] || "/runlight"
    @handler = ->(request, ip = "203.0.113.9") { routes.handle(request, { "ip" => ip }) }
    @owner = cookies_of(@handler.call(form("/setup", { "code" => "app-token", "email" => "jon@example.com", "password" => "a long password", "again" => "a long password" })))
  end

  def req(path, method = "GET", headers = {}, body = "")
    Request.new("https://example.com#{@base}#{path}", method: method, headers: headers, body: body)
  end

  def form(path, fields, headers = {})
    req(path, "POST", { "content-type" => "application/x-www-form-urlencoded" }.merge(headers), SearchParams.new(fields).to_s)
  end

  def json(cookie, method, path, body = nil)
    req(path, method, { "cookie" => cookie, "content-type" => "application/json" }, body.nil? ? "" : Json.encode(body))
  end

  # Every cookie an answer sets, as a browser would send them back.
  def cookies_of(response)
    response.headers.get_set_cookie.map { |cookie| cookie.split(";").first }.join("; ")
  end

  def sign_in(password, ip, email = "jon@example.com", headers = {})
    @handler.call(form("/login", { "email" => email, "password" => password }, headers), ip)
  end

  # Finding 2. A password check holds Ruby's global lock, so a process checks only so many a minute.

  def test_a_process_checks_only_so_many_passwords_a_minute_and_known_browsers_have_their_own
    install
    Accounts.checks_per_minute = 3
    signed = sign_in("a long password", "203.0.113.1")
    assert_equal 303, signed.status
    known = cookies_of(signed)
    assert_equal 401, sign_in("a wrong password", "203.0.113.2").status
    assert_equal 401, sign_in("a wrong password", "203.0.113.3", "nobody@example.com").status
    busy = sign_in("a long password", "203.0.113.4")
    assert_equal 503, busy.status, "the minute's checks are spent, right password or wrong"
    assert_equal "5", busy.headers.get("retry-after")

    # A browser that signed in to the account before is not held up by strangers' tries, nor is someone signed in.
    assert_equal 303, sign_in("a long password", "203.0.113.5", "jon@example.com", { "cookie" => known }).status
    recheck = @handler.call(json(@owner, "POST", "/api/account/password", { "current" => "a wrong password", "next" => "another long password" }))
    assert_equal 400, recheck.status
    assert_equal "password_current_wrong", Json.decode(recheck.text)["code"]
    2.times { sign_in("a long password", "203.0.113.5", "jon@example.com", { "cookie" => known }) }
    assert_equal 503, sign_in("a long password", "203.0.113.5", "jon@example.com", { "cookie" => known }).status, "theirs runs out too"
    assert_equal 30, Accounts::CHECKS_PER_MINUTE
  end

  def test_an_ipv6_caller_is_counted_by_its_64_however_many_addresses_it_sends_from
    assert_equal "203.0.113.7", Web.address_key("203.0.113.7")
    assert_equal "203.0.113.7", Web.address_key("::ffff:203.0.113.7")
    assert_equal "2001:db8:1:2::/64", Web.address_key("2001:db8:1:2:aaaa:bbbb:cccc:dddd")
    assert_equal "2001:db8:1:2::/64", Web.address_key("[2001:db8:1:2::1]")
    assert_equal "fe80::/64", Web.address_key("fe80::1%eth0")
    assert_equal "not an address", Web.address_key("not an address")
    assert_equal "", Web.address_key("")

    install
    # Ten wrong tries at one account, each from another address of one /64, are that caller's ten.
    10.times { |i| assert_equal 401, sign_in("a wrong password", "2001:db8:1:2::#{(i + 1).to_s(16)}").status }
    assert_equal 429, sign_in("a wrong password", "2001:db8:1:2:ffff::1").status
    assert_equal 401, sign_in("a wrong password", "2001:db8:1:3::1").status, "another /64 is another caller"
  end

  # Finding 4. Nothing made from a caller's address is written anywhere.

  def test_signing_in_writes_nothing_made_from_the_callers_address
    install
    3.times { sign_in("a wrong password", "198.51.100.7") }
    assert_equal 303, sign_in("a long password", "198.51.100.7").status
    sign_in("a wrong password", "198.51.100.8", "nobody@example.com")
    kept = @rl.store.settings_starting_with("throttle:").map { |row| row["key"] }
    assert_equal [], kept.reject { |key| key.start_with?("throttle:account:") }, "only the counts kept per account"
    assert_equal 2, kept.length, "one for each email tried"
  end

  def test_a_count_kept_in_memory_counts_and_runs_out_like_one_in_the_database
    store = Runlight::Stores.sqlite(":memory:")
    store.migrate
    throttle = Throttle.new(store, "ip", 3, 1000, memory: true)
    3.times { assert throttle.take("203.0.113.7", NOW) }
    refute throttle.take("203.0.113.7", NOW)
    assert throttle.blocked("203.0.113.7", NOW)
    refute throttle.blocked("203.0.113.8", NOW)
    throttle.forgive("203.0.113.7", NOW)
    refute throttle.blocked("203.0.113.7", NOW)
    throttle.record_failure("203.0.113.7", NOW)
    assert throttle.blocked("203.0.113.7", NOW)
    refute throttle.blocked("203.0.113.7", NOW + 1000), "its window ended"
    throttle.record_failure("203.0.113.7", NOW)
    throttle.clear("203.0.113.7", NOW)
    assert throttle.take("203.0.113.7", NOW)
    refute Throttle.new(store, "ip", 3, 1000, memory: true).blocked("203.0.113.7", NOW), "each process counts on its own"
    assert_equal [], store.settings_starting_with("throttle"), "and nothing is written, not even a hashing key"
  end

  def test_a_count_taken_back_to_nothing_is_deleted
    store = Runlight::Stores.sqlite(":memory:")
    store.migrate
    throttle = Throttle.new(store, "account", 3)
    assert throttle.take("jon@example.com", NOW)
    assert throttle.take("jon@example.com", NOW)
    throttle.forgive("jon@example.com", NOW)
    assert_equal 1, store.settings_starting_with("throttle:account:").length
    throttle.forgive("jon@example.com", NOW)
    assert_equal [], store.settings_starting_with("throttle:account:")
  end

  def test_what_earlier_versions_kept_under_a_hash_of_an_address_is_cleared_at_start
    store = Runlight::Stores.sqlite(":memory:")
    store.migrate
    live = Json.encode({ "count" => 2, "until" => NOW + 60_000 })
    store.set_setting("throttle:ip:AAAAAAAAAAAAAAAAAAAAAA", live)
    store.set_setting("throttle:address:BBBBBBBBBBBBBBBBBBBBBB", live)
    store.set_setting("throttle:account:CCCCCCCCCCCCCCCCCCCCCC", live)
    store.set_setting("oauth-registrations", Json.encode({ "window" => 1, "counts" => { "abcdef0123456789" => 3 } }))
    Runlight::Core.new({ "store" => store, "now" => -> { @now } }).init
    assert_equal ["throttle:account:CCCCCCCCCCCCCCCCCCCCCC"], store.settings_starting_with("throttle:").map { |row| row["key"] }
    assert_nil store.setting("oauth-registrations")
  end

  def test_counts_that_have_run_out_go_within_the_hour_without_a_scheduled_check
    store = Runlight::Stores.sqlite(":memory:")
    rl = Runlight::Core.new({ "store" => store, "now" => -> { @now } })
    rl.init
    over = -> { store.set_setting("throttle:account:#{SecureRandom.hex(11)}", Json.encode({ "count" => 2, "until" => @now - 1 })) }
    over.call
    store.set_setting("throttle-key:2020-01-01", "a key of a day long gone")
    rl.idle
    assert_equal [], store.settings_starting_with("throttle"), "cleared once an answer is sent"
    over.call
    @now += 59 * 60_000
    rl.idle
    assert_equal 1, store.settings_starting_with("throttle:").length, "at most once an hour"
    @now += 60_000
    rl.idle
    assert_equal [], store.settings_starting_with("throttle:")
  end

  def test_registering_an_app_counts_the_address_in_memory_alone
    install
    register = lambda do |ip|
      @handler.call(req("/oauth/register", "POST", { "content-type" => "application/json" },
                        Json.encode({ "client_name" => "An app", "redirect_uris" => ["https://app.example/cb"] })), ip)
    end
    10.times { assert_equal 201, register.call("198.51.100.7").status }
    assert_equal 429, register.call("198.51.100.7").status
    assert_equal 201, register.call("198.51.100.8").status
    assert_nil @rl.store.setting("oauth-registrations")
    @now += 60_000
    assert_equal 201, register.call("198.51.100.7").status, "a new minute"
  end

  # Carried over from the other ports.

  # Middleware asks for the link domains on every request of the app behind it. With the analytics database
  # away, the app's requests go on, and the database is asked again only every five seconds.
  def test_an_app_behind_runlight_keeps_answering_while_the_analytics_database_is_away
    store = Runlight::Stores.sqlite(":memory:")
    rl = Runlight::Core.new({ "store" => store, "site" => { "hostnames" => ["example.com"] }, "now" => -> { @now } })
    rl.init
    asked = 0
    store.define_singleton_method(:link_domains) { asked += 1; raise "the database is away" }
    rl.forget_link_domains
    app = Rack::MockRequest.new(Runlight::RackApp.new(->(_env) { [200, { "content-type" => "text/plain" }, ["the app"]] }, runlight: rl, base_path: "/runlight"))
    _out, err = capture_io do
      3.times { assert_equal "the app", app.get("/contact", "HTTP_HOST" => "example.com").body }
      assert_equal 1, asked, "not asked again for every request"
      @now += 4999
      assert_equal "the app", app.get("/contact", "HTTP_HOST" => "example.com").body
      assert_equal 1, asked
      @now += 1
      assert_equal "the app", app.get("/contact", "HTTP_HOST" => "example.com").body
      assert_equal 2, asked, "asked again five seconds on"
    end
    assert_equal 1, err.scan("could not read the link domains").length, "said once"
  end

  def test_link_domains_known_before_the_database_went_away_are_still_link_domains
    store = Runlight::Stores.sqlite(":memory:")
    rl = Runlight::Core.new({ "store" => store, "site" => { "hostnames" => ["example.com"] }, "now" => -> { @now } })
    rl.init
    store.add_link_domain("go.example.com", "default", @now)
    check = Request.new("https://go.example.com/.well-known/runlight-link-domain", headers: { "host" => "go.example.com" })
    assert_equal 200, rl.link_domain_response(check).status
    store.define_singleton_method(:link_domains) { raise "the database is away" }
    @now += 30_000
    capture_io do
      assert_equal 200, rl.link_domain_response(check).status
      assert_nil rl.link_domain_response(Request.new("https://example.com/contact", headers: { "host" => "example.com" }))
    end
  end

  # The request's URL is the scheme and Host with the path after them. A path that starts with two slashes,
  # or a slash and a backslash, is still a path: it never names the host, so it cannot choose the origin the
  # consent form's Origin check compares with.
  def test_a_request_target_never_supplies_the_host
    ["//evil.example/runlight/oauth/authorize", "/\\evil.example/runlight/oauth/authorize", "///evil.example", "https://evil.example/x"].each do |target|
      env = Rack::MockRequest.env_for("/", "HTTP_HOST" => "stats.example.com")
      env["PATH_INFO"] = target
      url = Runlight::Http::Url.new(Request.from_rack(env).url)
      assert_equal "http://stats.example.com", url.origin, target
      assert_equal "stats.example.com", url.host, target
    end
    env = Rack::MockRequest.env_for("/", "HTTP_HOST" => "stats.example.com")
    env["SCRIPT_NAME"] = ""
    env["PATH_INFO"] = "//evil.example/runlight/oauth/authorize"
    env["REQUEST_METHOD"] = "POST"
    env["CONTENT_TYPE"] = "application/x-www-form-urlencoded"
    env["HTTP_ORIGIN"] = "http://evil.example"
    install
    answer = @handler.call(Request.from_rack(env))
    assert_equal 404, answer.status, "and it is no path of Runlight's"
  end

  # An account kept to one site allows no apps. The refusal looks at the path after the base, so a base path
  # or a query that happens to hold "/oauth/" neither sets it off nor gets around it.
  def test_an_account_kept_to_one_site_is_refused_at_oauth_by_the_path_after_the_base
    install({ "basePath" => "/oauth/stats" })
    @rl.store.db.run("INSERT INTO rl_users (id, email, hash, role, created_at, site) SELECT ?, ?, hash, 'member', created_at, 'default' FROM rl_users",
                     ["a" * 24, "mo@example.com"])
    member = cookies_of(sign_in("a long password", "203.0.113.20", "mo@example.com"))
    refute_equal "", member
    assert_equal 200, @handler.call(req("/api/stats?note=/oauth/", "GET", { "cookie" => member })).status, "a path under a base that holds /oauth/ is read"
    registered = @handler.call(req("/oauth/register", "POST", { "content-type" => "application/json" },
                                   Json.encode({ "client_name" => "An app", "redirect_uris" => ["https://app.example/cb"] })))
    query = SearchParams.new({ "response_type" => "code", "client_id" => Json.decode(registered.text)["client_id"], "redirect_uri" => "https://app.example/cb",
                               "code_challenge" => "a" * 43, "code_challenge_method" => "S256" }).to_s
    assert_equal 200, @handler.call(req("/oauth/authorize?#{query}", "GET", { "cookie" => @owner })).status, "the owner is asked"
    refused = @handler.call(req("/oauth/authorize?#{query}", "GET", { "cookie" => member }))
    assert_equal 403, refused.status, "the account kept to a site is told it connects no apps, not sent to sign in again"
    assert_includes refused.text, "Your account only has access to one site"
    allowed = @handler.call(form("/oauth/authorize", SearchParams.new(query).each.to_h.merge("decision" => "allow"), { "cookie" => member, "origin" => "https://example.com" }))
    refute_match(/code=/, allowed.headers.get("location").to_s)
  end
end

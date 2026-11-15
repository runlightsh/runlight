# frozen_string_literal: true

require "test_helper"
require_relative "../support/core_test_case"

# The route, account, OAuth, MCP, and standalone server changes made after the review of 2026-11-14, as
# auth-review.test.ts pins them in the TypeScript.
class CoreReviewRoutes20261114Test < CoreTestCase
  Json = Runlight::Json
  Request = Runlight::Http::Request
  SearchParams = Runlight::Http::SearchParams
  Lockout = Runlight::Accounts::Lockout
  Crypto = Runlight::Accounts::Crypto

  NOW = 1_791_288_000_000
  PASSWORD = "a long password"

  def setup
    super
    @now = NOW
  end

  # An install with accounts, its owner, and a member kept to the one site.
  def install(options = {})
    @rl = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:"), "secret" => "k" * 64, "now" => -> { @now },
                               "site" => { "hostnames" => ["example.com"] } })
    routes = @rl.routes({ "token" => "app-token", "accounts" => true }.merge(options))
    @handler = ->(request, ip = "203.0.113.9") { routes.handle(request, { "ip" => ip }) }
    @owner = cookies_of(@handler.call(form("/setup", { "code" => "app-token", "email" => "jon@example.com", "password" => PASSWORD, "again" => PASSWORD })))
    @rl.store.db.run("INSERT INTO rl_users (id, email, hash, role, created_at, site) SELECT ?, ?, hash, 'member', created_at, 'default' FROM rl_users",
                     ["a" * 24, "mo@example.com"])
    @member = cookies_of(@handler.call(form("/login", { "email" => "mo@example.com", "password" => PASSWORD }), "203.0.113.20"))
  end

  def req(path, method = "GET", headers = {}, body = "", host: "example.com")
    Request.new("https://#{host}/runlight#{path}", method: method, headers: headers, body: body)
  end

  def form(path, fields, headers = {})
    req(path, "POST", { "content-type" => "application/x-www-form-urlencoded" }.merge(headers), SearchParams.new(fields).to_s)
  end

  def json(cookie, method, path, body = nil, host: "example.com")
    req(path, method, { "cookie" => cookie, "content-type" => "application/json" }, body.nil? ? "" : Json.encode(body), host: host)
  end

  def cookies_of(response)
    response.headers.get_set_cookie.map { |cookie| cookie.split(";").first }.join("; ")
  end

  def code_of(response)
    Json.decode(response.text)["code"]
  end

  # B1, B2, B3. An account kept to one site is not taken at its word about where the app lives.

  def test_an_account_kept_to_one_site_needs_the_apps_own_address_configured
    install
    assert_equal [400, "origin_needed"], @handler.call(json(@member, "POST", "/api/link-domains", { "domain" => "go.example.net" })).then { |r| [r.status, code_of(r)] }
    assert_equal [400, "origin_needed"], @handler.call(json(@member, "POST", "/api/reports", { "email" => "mo@example.com" })).then { |r| [r.status, code_of(r)] }
    assert_equal 201, @handler.call(json(@owner, "POST", "/api/reports?site=default", { "email" => "jon@example.com" })).status, "the owner is unaffected"

    picked = @handler.call(json(@member, "POST", "/api/pick", { "origin" => "https://evil.example" }))
    assert_equal [403, "pick_own"], [picked.status, code_of(picked)]
    assert_equal "Your account can only pick from this dashboard's own address", Json.decode(picked.text)["error"]
    assert_equal 200, @handler.call(json(@member, "POST", "/api/pick", { "origin" => "https://example.com" })).status, "the address its request came to"
    assert_equal 200, @handler.call(json(@owner, "POST", "/api/pick?site=default", { "origin" => "https://hub.example" })).status

    install({ "origin" => "https://stats.example.com" })
    made = @handler.call(json(@member, "POST", "/api/reports", { "email" => "mo@example.com" }, host: "evil.example"))
    assert_equal 201, made.status
    assert_equal ["https://stats.example.com/runlight"], @rl.store.reports("default").map { |r| r["origin"] }, "the configured address, whatever the Host"
    assert_equal 403, @handler.call(json(@member, "POST", "/api/pick", { "origin" => "https://evil.example" }, host: "evil.example")).status
    assert_equal 200, @handler.call(json(@member, "POST", "/api/pick", { "origin" => "https://stats.example.com" }, host: "evil.example")).status
  end

  # B4, B5, B6, B7. Lengths are checked before a pattern reads the text.

  def test_long_addresses_and_domains_are_refused_before_a_pattern_runs
    install
    long = "#{"a" * 310}@example.com"
    assert_equal [400, "email_invalid"], @handler.call(json(@owner, "POST", "/api/reports?site=default", { "email" => long })).then { |r| [r.status, code_of(r)] }
    assert_equal [400, "test_email"], @handler.call(json(@owner, "POST", "/api/mail/test", { "to" => long })).then { |r| [r.status, code_of(r)] }
    assert_equal [400, "email_invalid"], @handler.call(json(@owner, "POST", "/api/people", { "email" => long, "role" => "viewer", "allSites" => true })).then { |r| [r.status, code_of(r)] }
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    ["#{"a." * 200}com", "https://#{"x" * 250}", "go.example.net#{"." * 100_000}"].each do |domain|
      refused = @handler.call(json(@owner, "POST", "/api/link-domains?site=default", { "domain" => domain }))
      assert_equal [400, "domain_invalid"], [refused.status, code_of(refused)]
    end
    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started, :<, 2
    assert_equal "go.example.net", Runlight::Routes.host_name("WWW.go.example.net...:443".sub(":443", "")), "final dots still go"
    assert_equal "example.com", Runlight::Routes.host_name("example.com.#{"." * 50_000}")
  end

  # B8, B9, B10. A body past a route's cap is refused there.

  def test_bodies_past_each_routes_cap_get_a_413
    install
    big = "x" * 65_537
    %w[/oauth/register /oauth/authorize /oauth/token].each do |path|
      refused = @handler.call(req(path, "POST", { "content-type" => "application/json" }, big))
      assert_equal 413, refused.status, path
      assert_equal({ "error" => "invalid_request", "error_description" => "Send a smaller body" }, Json.decode(refused.text))
      assert_equal "*", refused.headers.get("access-control-allow-origin")
    end
    by_length = @handler.call(req("/oauth/token", "POST", { "content-type" => "application/json", "content-length" => "70000" }, "{}"))
    assert_equal 413, by_length.status, "by its declared length too"

    %w[/login /login/code /invite].each do |path|
      refused = @handler.call(form(path, { "email" => big }))
      assert_equal [413, { "error" => "Send a smaller body", "code" => "body_too_large" }], [refused.status, Json.decode(refused.text)], path
    end
    ["/api/account/password", "/api/account/2fa/start", "/api/people"].each do |path|
      assert_equal [413, "body_too_large"], @handler.call(json(@owner, "POST", path, { "x" => big })).then { |r| [r.status, code_of(r)] }, path
    end
    managed = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:"), "secret" => "k" * 64, "managedSites" => true })
    routes = managed.routes({ "token" => "app-token", "accounts" => true })
    owner = cookies_of(routes.handle(form("/setup", { "code" => "app-token", "email" => "jon@example.com", "password" => PASSWORD, "again" => PASSWORD })))
    site = managed.add_site({ "hostnames" => ["example.com"] })
    refused = routes.handle(json(owner, "DELETE", "/api/sites/#{site["id"]}", { "password" => big }))
    assert_equal [413, "body_too_large"], [refused.status, code_of(refused)]
    refute_nil managed.site(site["id"])

    mcp = ->(body) { @handler.call(req("/mcp", "POST", { "authorization" => "Bearer app-token", "content-type" => "application/json" }, body)) }
    refused = mcp.call("[#{" " * 1_048_576}]")
    assert_equal 413, refused.status
    assert_equal({ "jsonrpc" => "2.0", "id" => nil, "error" => { "code" => -32_600, "message" => "Send a smaller message" } }, Json.decode(refused.text))
    unreadable = mcp.call("{")
    assert_equal [400, -32_700], [unreadable.status, Json.decode(unreadable.text)["error"]["code"]]
  end

  # B11, B12, B13.

  def test_oauth_takes_only_redirect_addresses_that_parse_and_tells_an_account_kept_to_one_site_so
    install
    register = lambda do |uris|
      @handler.call(req("/oauth/register", "POST", { "content-type" => "application/json" }, Json.encode({ "client_name" => "An <app>", "redirect_uris" => uris })))
    end
    refused = register.call(["https://[", "https://exa mple.com/cb"])
    assert_equal [400, "invalid_redirect_uri"], [refused.status, Json.decode(refused.text)["error"]]
    kept = Json.decode(register.call(["https://[", "https://app.example/cb"]).text)
    assert_equal ["https://app.example/cb"], kept["redirect_uris"], "one that does not parse is dropped from the list"

    # An app registered before those were refused: its address is in its list, and is still no address.
    payload = [Json.encode({ "n" => "Old app", "r" => ["https://["], "t" => @now })].pack("m0").tr("+/", "-_").delete("=")
    old = "#{payload}.#{Runlight::Hashing.hmac(@rl.store.setting("oauth-key"), payload)}"
    query = ->(client, redirect) { SearchParams.new({ "response_type" => "code", "client_id" => client, "redirect_uri" => redirect, "code_challenge" => "a" * 43, "code_challenge_method" => "S256" }).to_s }
    assert_equal 400, @handler.call(req("/oauth/authorize?#{query.call(old, "https://[")}", "GET", { "cookie" => @owner })).status
    assert_equal 400, @handler.call(form("/oauth/authorize", SearchParams.new(query.call(old, "https://[")).each.to_h.merge("decision" => "allow"), { "cookie" => @owner })).status

    told = @handler.call(req("/oauth/authorize?#{query.call(kept["client_id"], "https://app.example/cb")}", "GET", { "cookie" => @member }))
    assert_equal 403, told.status
    assert_includes told.text, "Your account only has access to one site, and only an owner of this Runlight can connect An &lt;app&gt;."
    @rl.store.db.run("UPDATE rl_users SET site = NULL, role = 'viewer' WHERE email = 'mo@example.com'")
    viewer = @handler.call(req("/oauth/authorize?#{query.call(kept["client_id"], "https://app.example/cb")}", "GET", { "cookie" => @member }))
    assert_equal 403, viewer.status
    refute_includes viewer.text, "only has access to one site", "a viewer of every site keeps the viewer's words"
  end

  # B14. The app's own check of who is asking reads the consent form, where the csrf field is.
  def test_the_authorize_callback_gets_the_consent_form_unread_each_time_it_is_asked
    rl = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:"), "site" => { "hostnames" => ["example.com"] }, "now" => -> { @now } })
    seen = []
    routes = rl.routes({ "csrf" => -> { "nonce-1" }, "authorize" => lambda do |request|
      seen << SearchParams.new(request.text).get("csrf") if request.method == "POST"
      true
    end })
    registered = routes.handle(req("/oauth/register", "POST", { "content-type" => "application/json" }, Json.encode({ "redirect_uris" => ["https://app.example/cb"] })))
    fields = { "response_type" => "code", "client_id" => Json.decode(registered.text)["client_id"], "redirect_uri" => "https://app.example/cb",
               "code_challenge" => "a" * 43, "code_challenge_method" => "S256", "csrf" => "nonce-1", "decision" => "allow" }
    allowed = routes.handle(form("/oauth/authorize", fields))
    assert_equal 303, allowed.status
    assert_match(/code=/, allowed.headers.get("location"))
    refute_empty seen
    assert_equal ["nonce-1"], seen.uniq
  end

  # B15. Wrong codes lock an account for longer each time.

  def test_a_lockout_doubles_from_fifteen_minutes_to_a_day_and_forgets_after_a_week
    store = Runlight::Stores.sqlite(":memory:")
    store.migrate
    lock = Lockout.new(store, "code", 5)
    min = 60_000
    at = NOW
    assert_equal [true] * 5 + [false], Array.new(6) { lock.take("u1", at) }
    lengths = [15, 30, 60, 120, 240, 480, 960, 1440, 1440].map { |m| m * min }
    lengths.each_with_index do |length, i|
      refute lock.take("u1", at + length - 1), "lock #{i + 1} lasts #{length / min} minutes"
      at += length
      # The lock is over: five more tries, and the fifth starts the next, longer one.
      assert_equal [true] * 5 + [false], Array.new(6) { lock.take("u1", at) }, "after lock #{i + 1}"
    end
    assert lock.take("u2", NOW), "each key on its own"
    refute lock.take("u1", at + 1)
    lock.clear("u1")
    assert lock.take("u1", at + 1), "a right code clears the key"

    # Before the fifth try the count starts again fifteen minutes after the first.
    fresh = Lockout.new(store, "fresh", 5)
    4.times { assert fresh.take("u", NOW) }
    assert_equal [true] * 5 + [false], Array.new(6) { fresh.take("u", NOW + (15 * min)) }
    # A week with no lock and no try, and the key is forgotten: the next lock is fifteen minutes again.
    week = 7 * 86_400_000
    locked_until = NOW + (30 * min)
    assert_equal [true] * 5 + [false], Array.new(6) { fresh.take("u", locked_until + week) }
    refute fresh.take("u", locked_until + week + (15 * min) - 1)
    assert fresh.take("u", locked_until + week + (15 * min))

    # Nothing kept is made from an address, what is kept is a hash, and a forgotten key is swept away.
    keys = store.settings_starting_with("lockout:").map { |row| row["key"] }
    assert(keys.all? { |key| key.match?(/\Alockout:(code|fresh):[a-f0-9]{32}\z/) })
    Lockout.sweep(store, NOW + (400 * 86_400_000))
    assert_equal [], store.settings_starting_with("lockout:")
  end

  def test_the_code_step_locks_after_five_wrong_codes_and_a_known_browser_counts_on_its_own
    install
    secret = Crypto.base32(Crypto.random_bytes(20))
    @rl.store.db.run("UPDATE rl_users SET totp_secret = ? WHERE email = 'jon@example.com'", [Crypto.seal_text(secret, "k" * 64)])
    pending = lambda do |cookie = nil|
      page = @handler.call(form("/login", { "email" => "jon@example.com", "password" => PASSWORD }, cookie.nil? ? {} : { "cookie" => cookie }))
      page.text[/name="pending" value="([^"]+)"/, 1]
    end
    code = ->(value, cookie = nil) { @handler.call(form("/login/code", { "pending" => pending.call(cookie), "code" => value }, cookie.nil? ? {} : { "cookie" => cookie })) }
    right = -> { Crypto.totp(secret, @now.div(30_000)) }

    # A browser that signed in before holds the account's mark.
    known = cookies_of(code.call(right.call))
    assert_includes known, "runlight_device="
    @now += 60_000
    assert_equal [401] * 5 + [429], Array.new(6) { code.call("000000").status }, "five wrong codes, then locked"
    assert_equal 429, code.call(right.call).status, "a right code too, while it is locked"
    signed = code.call(right.call, known)
    assert_equal 303, signed.status, "the known browser has its own count"
    @now += (15 * 60_000) - 1
    assert_equal 429, code.call("000000").status
    @now += 1
    assert_equal 401, code.call("000000").status, "fifteen minutes on, the first lock is over"
    assert_equal [401] * 4 + [429], Array.new(5) { code.call("000000").status }
    @now += (30 * 60_000) - 1
    assert_equal 429, code.call(right.call).status, "the second lock is thirty minutes"
    @now += 60_000
    assert_equal 303, code.call(right.call).status
    assert_equal [], @rl.store.settings_starting_with("lockout:code:"), "a right code clears its key, as the known browser's cleared its own"
  end

  # D. The standalone server.

  def standalone(options = {})
    store = Runlight::Stores.sqlite(":memory:")
    Runlight::Server::Standalone.new({ "store" => store, "secret" => "k" * 64, "now" => -> { @now } }.merge(options))
  end

  def test_the_servers_own_paths_are_kept_back_as_link_slugs
    server = standalone({ "token" => "t" * 40 })
    rl = server.runlight
    site = rl.add_site({ "hostnames" => ["example.com"] })
    # A link made before the slug was kept back keeps it, and can be changed.
    rl.store.insert_link({ "id" => "b" * 24, "site" => site["id"], "domain" => "", "slug" => "login", "name" => "Old", "url" => "https://example.org/", "createdAt" => @now, "updatedAt" => @now })
    assert_equal "login", rl.links.update("b" * 24, { "slug" => "login", "name" => "Still here" })["slug"]
    %w[logout setup invite healthz api mcp e embed pick-return].each do |slug|
      error = assert_raises(Runlight::LinkError) { rl.links.create(site["id"], { "url" => "https://example.org/", "slug" => slug }) }
      assert_equal ["link_reserved", { "slug" => slug }], [error.code, error.params]
    end
    assert_equal "go", rl.links.create(site["id"], { "url" => "https://example.org/", "slug" => "go" })["slug"]
    # A library install has no pages of its own there, and keeps nothing back.
    plain = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:") })
    assert_equal "login", plain.links.create("default", { "url" => "https://example.org/", "slug" => "login" })["slug"]
  end

  def test_the_server_reads_a_forwarded_host_only_where_proxy_headers_are_believed
    server = standalone({ "token" => "t" * 40, "url" => "https://stats.example.com" })
    site = server.runlight.add_site({ "hostnames" => ["example.com"] })
    server.runlight.store.add_link_domain("go.example.net", site["id"], @now)
    server.runlight.links.create(site["id"], { "url" => "https://example.org/", "slug" => "abc", "domain" => "go.example.net" })
    link = Request.new("https://go.example.net/abc", headers: { "host" => "go.example.net", "x-forwarded-host" => "stats.example.com", "user-agent" => Harness::CHROME_MAC })
    # Straight from the internet, naming the server's own host changes nothing: the link still answers.
    assert_equal 302, server.handle(link, { "ip" => "93.184.215.14" }).status
    # From a proxy on a private network the name is the proxy's word, and it is the dashboard's.
    refute_equal 302, server.handle(link, { "ip" => "10.0.0.5" }).status
  end

  def test_wrong_guesses_at_a_short_token_are_counted_per_address_and_a_long_one_counts_nothing
    assert_nil Runlight::Server::Standalone.short_warning("RUNLIGHT_TOKEN", "t" * 32)
    assert_nil Runlight::Server::Standalone.short_warning("RUNLIGHT_SECRET", nil)
    assert_equal "Runlight: WARNING: RUNLIGHT_TOKEN is only 8 characters long. Anyone who guesses it has the whole API, as the owner. " \
                 "Set it to 32 or more random characters, such as the output of: openssl rand -hex 32",
                 Runlight::Server::Standalone.short_warning("RUNLIGHT_TOKEN", "t" * 8)
    assert_includes Runlight::Server::Standalone.short_warning("RUNLIGHT_SECRET", "short"), "It signs every session and encrypts the saved mail and assistant keys"

    ask = lambda do |server, bearer, ip|
      server.handle(Request.new("https://stats.example.com/api/sites", headers: { "authorization" => "Bearer #{bearer}" }), { "ip" => ip }).status
    end
    short = standalone({ "token" => "shorttok" })
    assert_equal 200, ask.call(short, "shorttok", "198.51.100.7")
    assert_equal [401] * 10, Array.new(10) { ask.call(short, "wrong", "198.51.100.7") }
    assert_equal 401, ask.call(short, "shorttok", "198.51.100.7"), "ten wrong guesses, and that address is refused the right one too"
    assert_equal 200, ask.call(short, "shorttok", "198.51.100.8"), "another address is not"
    @now += 15 * 60_000
    assert_equal 200, ask.call(short, "shorttok", "198.51.100.7"), "fifteen minutes on"
    assert_equal [401] * 12, Array.new(12) { ask.call(short, "rl_#{"0" * 40}", "198.51.100.9") }
    assert_equal 200, ask.call(short, "shorttok", "198.51.100.9"), "a token made in Settings is never a guess at this one"
    assert_equal [], short.runlight.store.settings_starting_with("throttle:"), "and nothing made from an address is written"

    long = standalone({ "token" => "t" * 40 })
    assert_equal [401] * 12, Array.new(12) { ask.call(long, "wrong", "198.51.100.7") }
    assert_equal 200, ask.call(long, "t" * 40, "198.51.100.7"), "a long token counts nothing"
  end
end

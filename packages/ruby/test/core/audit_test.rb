# frozen_string_literal: true

require "test_helper"
require_relative "../support/core_test_case"
require_relative "../routes/make"

# The audit of 2026-10-16, as audit.test.ts, hostname-suggestions.test.ts, journeys.test.ts, oauth.test.ts, and
# accounts.test.ts test it, through the routes.
class CoreAuditTest < CoreTestCase
  Json = Runlight::Json

  def get(routes, path)
    response = routes.handle(RoutesMake.owner("/runlight#{path}", "GET"))
    assert_equal 200, response.status, "#{path}: #{response.text}"
    Json.decode(response.text)
  end

  on_every_database("hostname suggestions respect visits filters dates and sites without counting totals") do |kind|
    t = Harness.new(kind, { "sites" => [
      { "id" => "a", "hostnames" => ["a.example.com", "b.example.com", "old.example.com", "event.example.com"] },
      { "id" => "other", "hostnames" => ["private.example.com"] },
    ] })
    t.track({ "k" => "pageview", "u" => "https://old.example.com/", "i" => "old" })
    t.advance(DAY)
    t.track({ "k" => "pageview", "u" => "https://b.example.com/pricing", "i" => "b" })
    t.track({ "k" => "pageview", "u" => "https://a.example.com/", "i" => "a" }, { "ip" => "203.0.113.2" })
    t.track({ "k" => "pageview", "u" => "https://a.example.com/", "i" => "a2" }, { "ip" => "203.0.113.3" })
    t.track({ "k" => "event", "u" => "https://event.example.com/", "n" => "Signup" }, { "ip" => "203.0.113.4" })
    t.track({ "k" => "pageview", "u" => "https://private.example.com/", "i" => "private" })
    routes = t.rl.routes({ "token" => "secret" })
    path = "/api/breakdown?site=a&period=today&dimension=hostname&suggestions=1"
    t.store.define_singleton_method(:breakdown) { |*| raise "Suggestions must not calculate breakdown totals" }
    assert_equal [{ "value" => "a.example.com" }, { "value" => "b.example.com" }], get(routes, path)["rows"]
    assert_equal [{ "value" => "a.example.com" }], get(routes, "#{path}&limit=1")["rows"]
    assert_equal [{ "value" => "b.example.com" }], get(routes, "#{path}&filter=#{Runlight::Js.encode_uri_component("page:is:/pricing")}")["rows"]
    assert_equal [], get(routes, "#{path}&filter=#{Runlight::Js.encode_uri_component("page:is:/missing")}")["rows"]
    assert_equal 401, routes.handle(RoutesMake.req("/runlight#{path}")).status
  end

  on_every_database("hostname suggestions step through hostnames in the order they are sorted in") do |kind|
    # A locale's own order puts blog-staging after blog. where byte order puts it before, so suggestions taken
    # one after another in byte order must compare in byte order too, or one is skipped (Postgres on Linux).
    t = Harness.new(kind, { "sites" => [{ "id" => "a", "hostnames" => ["blog.example.com", "blog-staging.example.com", "shop.example.com"] }] })
    t.track({ "k" => "pageview", "u" => "https://blog.example.com/", "i" => "a" }, { "ip" => "203.0.113.2" })
    t.track({ "k" => "pageview", "u" => "https://blog-staging.example.com/", "i" => "b" }, { "ip" => "203.0.113.3" })
    t.track({ "k" => "pageview", "u" => "https://shop.example.com/", "i" => "c" }, { "ip" => "203.0.113.4" })
    rows = get(t.rl.routes({ "token" => "secret" }), "/api/breakdown?site=a&period=today&dimension=hostname&suggestions=1")["rows"]
    assert_equal %w[blog-staging.example.com blog.example.com shop.example.com], rows.map { |r| r["value"] }
  end

  def test_a_journeys_start_end_and_through_take_a_page_as_written_as_filters_do
    t = Harness.new("sqlite")
    t.rl.init
    t.track({ "k" => "pageview", "u" => "https://example.com/café", "i" => "a" })
    t.advance(30_000)
    t.track({ "k" => "pageview", "u" => "https://example.com/pricing", "i" => "b" })
    routes = t.rl.routes({ "token" => "secret" })
    enc = Runlight::Js.method(:encode_uri_component)
    ["start=#{enc.call("/café")}", "start=#{enc.call("/caf%C3%A9")}", "end=#{enc.call("/pricing")}&start=#{enc.call("/café")}", "through=#{enc.call("0:/café")}"].each do |query|
      assert_equal 1, get(routes, "/api/journeys?period=today&#{query}")["visits"], query
    end
  end

  def test_paging_takes_whole_numbers_only_and_anything_else_is_the_default
    t = Harness.new("sqlite")
    t.rl.init
    12.times { |i| t.track({ "k" => "pageview", "u" => "https://example.com/p#{i}", "i" => "i#{i}" }, { "ip" => "203.0.113.#{10 + i}" }) }
    routes = t.rl.routes({ "token" => "secret" })
    rows = ->(query) { get(routes, "/api/breakdown?period=today&dimension=page&#{query}")["rows"].map { |r| r["value"] } }
    assert_equal 3, rows.call("limit=3").length
    assert_equal 10, rows.call("limit=2.5").length, "a fraction is the default"
    assert_equal 10, rows.call("limit=abc&page=2.5").length
    assert_equal 10, rows.call("limit=-3&page=0").length
    assert_equal rows.call("limit=3"), rows.call("limit=3&page=1e20"), "a number past the safe range is page 1"
    assert_equal rows.call("limit=3&page=2"), rows.call("limit=3&page=2.0")
    assert_equal 12, rows.call("limit=1e3").length
    assert_equal 12, rows.call("limit=99999").length, "capped at a thousand"
  end

  def test_event_property_values_take_a_whole_limit_too
    t = Harness.new("sqlite")
    t.rl.init
    t.track({ "k" => "event", "u" => "https://example.com/", "n" => "Buy", "p" => { "plan" => "pro" } })
    routes = t.rl.routes({ "token" => "secret" })
    assert_equal 1, get(routes, "/api/event-props?period=today&event=Buy&limit=2.5")["rows"].length
  end

  def test_a_sites_agents_key_is_kept_sealed_and_one_kept_as_plain_text_before_still_works_and_is_sealed_when_read
    rl = RoutesMake.runlight({ "site" => { "hostnames" => ["example.com"] }, "secret" => "s" * 32 })
    rl.init
    key = Runlight::OAuth.agents_key(rl, "default")
    stored = rl.store.setting("observe-key:default")
    refute_includes stored, key, "not in the database as it is"
    routes = rl.routes({ "token" => "owner" })
    observe = lambda do |bearer|
      routes.handle(RoutesMake.owner("/runlight/api/observe", "POST", { "url" => "https://example.com/", "userAgent" => "Mozilla/5.0 (compatible; GPTBot/1.2)" }, bearer))
    end
    assert_equal 204, observe.call(key).status
    # A key from before, kept as it was.
    rl.store.set_setting("observe-key:default", "rlo_legacykeylegacykey00")
    assert_equal 204, observe.call("rlo_legacykeylegacykey00").status
    assert_equal "rlo_legacykeylegacykey00", Runlight::OAuth.agents_key(rl, "default"), "shown as it was"
    refute_includes rl.store.setting("observe-key:default"), "rlo_legacy", "and sealed now"
    assert_equal 204, observe.call("rlo_legacykeylegacykey00").status, "still working"
    assert_equal 401, observe.call("rlo_wrongkeywrongkeywron").status
    refute_equal key, Runlight::OAuth.agents_key(rl, "default", true), "replacing it still makes a new one"
  end

  def test_a_key_sealed_under_a_secret_the_server_no_longer_has_is_replaced
    rl = RoutesMake.runlight({ "site" => { "hostnames" => ["example.com"] }, "secret" => "s" * 32 })
    rl.init
    rl.store.set_setting("observe-key:default", Runlight::Mail::Secret.seal("rlo_gone", "another secret entirely, long enough"))
    key = Runlight::OAuth.agents_key(rl, "default")
    assert_match(/\Arlo_/, key)
    refute_equal "rlo_gone", key
    assert_equal key, Runlight::OAuth.agents_key(rl, "default")
  end

  def test_oauth_json_answers_say_not_to_sniff
    rl = RoutesMake.runlight({ "site" => { "hostnames" => ["example.com"] } })
    response = rl.routes({ "token" => "secret" }).handle(RoutesMake.req("/runlight/.well-known/oauth-authorization-server"))
    assert_equal 200, response.status
    assert_equal "nosniff", response.headers.get("x-content-type-options")
  end

  def test_a_site_deleted_takes_its_own_accounts_and_invitations_with_it
    rl = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:"), "managedSites" => true, "secret" => "k" * 64 })
    routes = rl.routes({ "token" => "app-token", "accounts" => true })
    owner = ->(method, path, body = nil) { routes.handle(RoutesMake.owner("/runlight#{path}", method, body, "app-token")) }
    site = Json.decode(owner.call("POST", "/api/sites", { "hostnames" => "gone.example.com" }).text)["site"]
    accounts = routes.instance_variable_get(:@web).accounts
    now = rl.now
    accounts.set_password("owner@example.com", "a long password", now)
    accounts.set_password("gone@example.com", "a long password", now, "viewer", site["id"])
    accounts.invite("invited@example.com", "member", "owner@example.com", now, site["id"])
    assert_equal 200, owner.call("DELETE", "/api/sites/#{site["id"]}").status
    assert_equal ["owner@example.com"], accounts.list.map { |u| u["email"] }
    assert_equal [], accounts.invites(now)
  end

  # An app with accounts, a hub of two sites, and a member kept to the first, signed in.
  def one_site_member
    rl = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:"), "managedSites" => true, "secret" => "k" * 64 })
    routes = rl.routes({ "token" => "app-token", "accounts" => true })
    owner = ->(method, path, body = nil) { routes.handle(RoutesMake.owner("/runlight#{path}", method, body, "app-token")) }
    %w[blog.example.com shop.example.com].each { |host| assert_equal 201, owner.call("POST", "/api/sites", { "hostnames" => host }).status }
    routes.instance_variable_get(:@web).accounts.set_password("member@example.com", "a long password", rl.now, "member", "blog.example.com")
    login = routes.handle(Runlight::Http::Request.new("https://example.com/runlight/login", method: "POST",
                                                      headers: { "content-type" => "application/x-www-form-urlencoded" },
                                                      body: Runlight::Http::SearchParams.new({ "email" => "member@example.com", "password" => "a long password" }).to_s))
    assert_equal 303, login.status
    cookie = (login.headers.get("set-cookie") || "").split(";").first
    member = lambda do |method, path, body = nil|
      headers = { "cookie" => cookie }
      headers["content-type"] = "application/json" unless body.nil?
      routes.handle(Runlight::Http::Request.new("https://example.com/runlight#{path}", method: method, headers: headers, body: body.nil? ? "" : Json.encode(body)))
    end
    [rl, owner, member]
  end

  def test_an_account_kept_to_one_site_may_rename_it_but_never_move_it
    _, _, member = one_site_member
    moved = member.call("PATCH", "/api/sites/blog.example.com", { "hostnames" => "elsewhere.example.com" })
    assert_equal [403, "site_domains"], [moved.status, Json.decode(moved.text)["code"]]
    emptied = member.call("PATCH", "/api/sites/blog.example.com", { "name" => "Blog", "hostnames" => [] })
    assert_equal [403, "site_domains"], [emptied.status, Json.decode(emptied.text)["code"]], "a list left empty is still a list"
    renamed = member.call("PATCH", "/api/sites/blog.example.com", { "name" => "The Blog" })
    assert_equal 200, renamed.status, renamed.text
    assert_equal "The Blog", Json.decode(renamed.text)["site"]["name"]
    assert_equal 404, member.call("PATCH", "/api/sites/shop.example.com", { "name" => "Mine now" }).status
  end

  def test_an_account_kept_to_one_site_sees_no_mail_fields
    rl, owner, member = one_site_member
    assert_equal 200, owner.call("PUT", "/api/mail", { "service" => "resend", "apiKey" => "re_live_key", "from" => "reports@example.com" }).status
    seen_by_owner = Json.decode(owner.call("GET", "/api/mail").text)
    assert_equal "resend", seen_by_owner["service"]
    refute_empty seen_by_owner["saved"], "the owner sees which fields are saved"
    seen = member.call("GET", "/api/mail")
    assert_equal 200, seen.status
    answer = Json.decode(seen.text)
    assert_equal({}, answer["fields"])
    assert_equal [], answer["saved"]
    assert_equal "resend", answer["service"]
    refute_nil rl
  end
end

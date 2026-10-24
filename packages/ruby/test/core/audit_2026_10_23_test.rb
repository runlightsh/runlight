# frozen_string_literal: true

require "test_helper"
require_relative "../support/core_test_case"
require_relative "../routes/make"

# The audit of 2026-10-23, as audit.test.ts, accounts.test.ts, and safefetch.test.ts test it.
class CoreAudit20261023Test < CoreTestCase
  Json = Runlight::Json
  Request = Runlight::Http::Request
  SearchParams = Runlight::Http::SearchParams

  def account_req(path, method = "GET", headers = {}, body = "")
    Request.new("https://example.com/runlight#{path}", method: method, headers: headers, body: body)
  end

  def form_post(path, fields, headers = {})
    account_req(path, "POST", { "content-type" => "application/x-www-form-urlencoded" }.merge(headers), SearchParams.new(fields).to_s)
  end

  def cookie_of(response)
    (response.headers.get("set-cookie") || "").split(";").first.to_s
  end

  # An install with accounts: its owner, and a member who joined by invite.
  def with_member
    rl = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:"), "secret" => "k" * 64 })
    routes = rl.routes({ "token" => "app-token", "accounts" => true })
    handler = ->(r) { routes.handle(r) }
    json = lambda do |cookie, method, path, body = nil|
      handler.call(account_req(path, method, { "cookie" => cookie, "content-type" => "application/json" }, body.nil? ? "" : Json.encode(body)))
    end
    owner = cookie_of(handler.call(form_post("/setup", { "code" => "app-token", "email" => "jon@example.com", "password" => "a long password", "again" => "a long password" })))
    link = Json.decode(json.call(owner, "POST", "/api/people", { "allSites" => true, "email" => "mo@example.com", "role" => "member" }).text)["link"]
    code = Runlight::Http::Url.new(link).search_params.get("code")
    member = cookie_of(handler.call(form_post("/invite", { "code" => code, "password" => "a long password", "again" => "a long password" })))
    { "rl" => rl, "handler" => handler, "json" => json, "owner" => owner, "member" => member }
  end

  def sign_in(handler, headers = {})
    handler.call(form_post("/login", { "email" => "mo@example.com", "password" => "a long password", "next" => "/runlight/" }, headers))
  end

  def test_a_member_sees_and_revokes_only_the_tokens_they_made_and_cannot_replace_a_sites_agents_key
    app = with_member
    json = app["json"]
    owner = app["owner"]
    member = app["member"]
    make = ->(cookie, name) { Json.decode(json.call(cookie, "POST", "/api/tokens", { "name" => name }).text)["token"]["id"] }
    owners = make.call(owner, "Owner's")
    mine = make.call(member, "Member's")
    listed = ->(cookie) { Json.decode(json.call(cookie, "GET", "/api/tokens").text)["tokens"].map { |t| t["id"] }.sort }
    assert_equal [mine], listed.call(member)
    assert_equal [owners, mine].sort, listed.call(owner), "the owner sees every token"
    assert_equal 404, json.call(member, "DELETE", "/api/tokens/#{owners}").status, "the owner's token is not the member's to revoke"
    assert_equal [owners, mine].sort, listed.call(owner)
    assert_equal 200, json.call(member, "DELETE", "/api/tokens/#{mine}").status
    assert_equal 403, json.call(member, "POST", "/api/observe-key/new?site=default", {}).status
    assert_equal 200, json.call(owner, "POST", "/api/observe-key/new?site=default", {}).status
  end

  def test_signing_out_ends_the_accounts_sessions_everywhere_and_only_from_the_dashboards_own_pages
    app = with_member
    handler = app["handler"]
    json = app["json"]
    member = app["member"]
    other = cookie_of(sign_in(handler))
    assert_equal 200, json.call(other, "GET", "/api/account").status
    cross_site = handler.call(account_req("/logout", "GET", { "cookie" => member, "sec-fetch-site" => "cross-site" }))
    assert_equal 403, cross_site.status, "another site cannot sign anyone out"
    assert_equal 200, json.call(other, "GET", "/api/account").status
    out = handler.call(account_req("/logout", "GET", { "cookie" => member, "sec-fetch-site" => "same-origin" }))
    assert_equal 303, out.status
    assert_equal 401, json.call(member, "GET", "/api/account").status, "the cookie copied before stops working"
    assert_equal 401, json.call(other, "GET", "/api/account").status, "and so does the one in the other browser"
    back = cookie_of(sign_in(handler))
    assert_equal 200, json.call(back, "GET", "/api/account").status, "signing in again works"
  end

  def test_the_sign_in_forms_take_a_post_only_from_their_own_pages
    handler = with_member["handler"]
    %w[cross-site same-site].each do |site|
      refused = sign_in(handler, { "sec-fetch-site" => site })
      assert_equal 403, refused.status, site
      assert_nil refused.headers.get("set-cookie"), "#{site}: no session is planted"
    end
    assert_equal 303, sign_in(handler, { "sec-fetch-site" => "same-origin" }).status
  end

  def test_a_new_password_can_take_back_the_tokens_the_account_made
    app = with_member
    json = app["json"]
    json.call(app["member"], "POST", "/api/tokens", { "name" => "Kept" })
    fresh = cookie_of(json.call(app["member"], "POST", "/api/account/password", { "current" => "a long password", "next" => "another long password" }))
    kept = json.call(fresh, "GET", "/api/tokens")
    assert_equal 200, kept.status, kept.text
    assert_equal 1, Json.decode(kept.text)["tokens"].length, "kept unless asked"
    latest = cookie_of(json.call(fresh, "POST", "/api/account/password", { "current" => "another long password", "next" => "a third long password", "revokeTokens" => true }))
    assert_equal 0, Json.decode(json.call(latest, "GET", "/api/tokens").text)["tokens"].length
  end

  # The ceiling is lowered for the test, since each new count reads every other: the same flood, past it by half.
  def test_a_flood_of_made_up_names_cannot_reset_the_count_of_one_close_to_its_limit
    accounts = Runlight::Accounts::Accounts
    ceiling = accounts::MAX_THROTTLED
    accounts.send(:remove_const, :MAX_THROTTLED)
    accounts.const_set(:MAX_THROTTLED, 100)
    store = Runlight::Stores.sqlite(":memory:")
    store.migrate
    throttle = Runlight::Accounts::Throttle.new(store, "account", 3)
    now = Harness::START
    assert throttle.take("target", now)
    assert throttle.take("target", now)
    150.times { |i| throttle.take("made-up-#{i}", now) }
    assert_operator store.settings_starting_with("throttle:account:").length, :<=, 100, "the ceiling holds"
    assert throttle.take("target", now)
    refute throttle.take("target", now), "the target's earlier tries still count"
  ensure
    accounts.send(:remove_const, :MAX_THROTTLED)
    accounts.const_set(:MAX_THROTTLED, ceiling)
  end

  def test_yesterdays_salt_leaves_memory_when_it_leaves_the_store_on_the_first_hit_after_midnight
    t = Harness.new("sqlite")
    t.track({ "k" => "pageview", "u" => "https://example.com/" })
    t.advance(13 * HOUR)
    t.track({ "k" => "pageview", "u" => "https://example.com/" }, { "ip" => "203.0.113.9" })
    cached = t.rl.instance_variable_get(:@salts)["UTC"]
    assert_equal "2026-10-07", cached["day"]
    assert_nil cached["yesterday"], "no visit was left open, so yesterday's salt is gone from here too"
  end

  def test_a_hit_tried_again_after_the_store_was_busy_counts_once
    t = Harness.new("sqlite")
    store = t.store
    insert = store.method(:insert_event)
    fail = 2
    store.define_singleton_method(:insert_event) do |row|
      fail -= 1
      raise "SQLITE_BUSY: database is locked" if fail >= 0

      insert.call(row)
    end
    t.track({ "k" => "pageview", "u" => "https://example.com/", "i" => "p1" })
    fail = 1
    t.track({ "k" => "engagement", "u" => "https://example.com/", "i" => "p1", "e" => 5000 })
    visit = store.db.all("SELECT pageviews, engaged_ms FROM rl_sessions")[0]
    assert_equal 1, visit["pageviews"].to_i
    assert_equal 5000, visit["engaged_ms"].to_i
    assert_equal 1, store.db.all("SELECT id FROM rl_events WHERE kind = 'pageview'").length
  end

  def test_a_funnel_over_more_visits_than_the_cap_counts_the_newest_and_says_so
    t = Harness.new("sqlite", { "site" => { "hostnames" => ["example.com"] } })
    t.store.funnel_visits = 2
    %w[203.0.113.1 203.0.113.2 203.0.113.3].each do |ip|
      t.track({ "k" => "pageview", "u" => "https://example.com/pricing" }, { "ip" => ip })
      t.advance(MIN)
    end
    routes = t.rl.routes({ "token" => "secret" })
    made = routes.handle(RoutesMake.owner("/runlight/api/funnels?site=default", "POST",
                                          { "name" => "F", "steps" => [{ "kind" => "page", "match" => "/pricing" }, { "kind" => "page", "match" => "/thanks" }] }))
    assert_equal 201, made.status, made.text
    funnels = -> { Json.decode(routes.handle(RoutesMake.owner("/runlight/api/funnels?period=today")).text)["funnels"] }
    funnel = funnels.call[0]
    assert_equal 2, funnel["sampled"]
    assert_equal 2, funnel["steps"][0]["visits"]
    t.store.funnel_visits = 10
    refute funnels.call[0].key?("sampled")
  end

  def test_a_prop_named_proto_is_kept
    t = Harness.new("sqlite")
    t.track({ "k" => "event", "u" => "https://example.com/", "n" => "Odd", "p" => { "__proto__" => "x", "plain" => "y" } })
    row = t.store.db.all("SELECT props FROM rl_events WHERE name = 'Odd'")[0]
    assert_equal({ "__proto__" => "x", "plain" => "y" }, Json.decode(row["props"]))
  end

  def test_an_automatic_link_event_keeps_its_link_without_the_query_string_or_fragment
    t = Harness.new("sqlite")
    t.track({ "k" => "event", "u" => "https://example.com/", "n" => "Outbound link", "p" => { "url" => "https://other.example/reset?token=abc&email=a@b.example#top" } })
    t.track({ "k" => "event", "u" => "https://example.com/", "n" => "File download", "p" => { "url" => "https://example.com/a.pdf?sig=x" } })
    t.track({ "k" => "event", "u" => "https://example.com/", "n" => "Signup", "p" => { "url" => "https://example.com/?plan=pro" } })
    rows = t.store.db.all("SELECT name, props FROM rl_events ORDER BY name")
    assert_equal [
      ["File download", "https://example.com/a.pdf"],
      ["Outbound link", "https://other.example/reset"],
      ["Signup", "https://example.com/?plan=pro"],
    ], rows.map { |r| [r["name"], Json.decode(r["props"])["url"]] }
  end

  def test_ipv4_inside_translated_and_nat64_addresses_is_read_and_only_global_unicast_is_public
    %w[::ffff:0:808:808 64:ff9b::808:808].each { |ip| assert Runlight::Safefetch.public_address?(ip), ip }
    %w[::ffff:0:7f00:1 64:ff9b:1::7f00:1 fec0::1 2001:20::1 3fff::1 100::1].each { |ip| refute Runlight::Safefetch.public_address?(ip), ip }
    assert Runlight::Safefetch.metadata_address?("::ffff:0:a9fe:a9fe")
  end

  def test_an_importer_for_a_hosted_service_still_asks_only_public_addresses
    asked = []
    fetcher = Object.new
    fetcher.define_singleton_method(:fetch) do |url, _init|
      asked << url
      Runlight::Http::Response.new("{}", status: 200)
    end
    client = Runlight::Importers::Client.new(fetcher, ->(_ms) {})
    %w[https://10.0.0.1/api https://[::1]/api http://api.example.com/api].each do |url|
      error = assert_raises(Runlight::Importers::ImportError) { client.get_json(url) }
      assert_equal "unreachable", error.code, url
    end
    assert_equal [], asked, "nothing was sent to any of them"
  end

  def test_a_scrypt_cost_past_what_scrypt_allows_matches_nothing
    made = Runlight::Accounts::Crypto.hash_password("a long password")
    _, _, _, _, salt, key = made.split("$")
    %w[1048576$1$1 65536$1$1].each do |cost|
      refute Runlight::Accounts::Crypto.check_password("a long password", "scrypt$#{cost}$#{salt}$#{key}"), cost
    end
  end
end

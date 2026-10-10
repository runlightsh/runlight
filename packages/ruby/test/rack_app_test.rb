# frozen_string_literal: true

require "test_helper"
require "rack/mock"
require "rack/lint"
require "rack/method_override"

# Runlight::RackApp on its own and as middleware in front of a plain Rack app: Runlight's paths, short links,
# AI agent fetches, bodies left for the app, and the work that runs once an answer is sent.
class RackAppTest < Minitest::Test
  TOKEN = "rack-test-token"
  SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"

  def setup
    @now = 1_791_000_000_000
    @store = Runlight::Stores.sqlite(":memory:")
    @rl = Runlight.new(store: @store, site: { name: "Example", hostnames: ["example.com"] }, now: -> { @now })
    @inner = lambda do |env|
      [200, { "content-type" => "text/plain" }, ["app saw #{env["REQUEST_METHOD"]} #{env["PATH_INFO"]} #{env["rack.input"]&.read}"]]
    end
    @app = Rack::MockRequest.new(Rack::Lint.new(Runlight::RackApp.new(@inner, runlight: @rl, base_path: "/runlight", token: TOKEN)))
  end

  def test_runlight_paths_are_answered_and_the_rest_reach_the_app
    tracker = @app.get("/runlight/s.js", "HTTP_HOST" => "example.com")
    assert_equal 200, tracker.status
    assert_match(/javascript/, tracker.headers["content-type"])

    page = @app.post("/contact", "HTTP_HOST" => "example.com", "CONTENT_TYPE" => "text/plain", input: "hello")
    assert_equal "app saw POST /contact hello", page.body

    assert_equal 401, @app.get("/runlight/api/sites", "HTTP_HOST" => "example.com").status
    sites = @app.get("/runlight/api/sites", "HTTP_HOST" => "example.com", "HTTP_AUTHORIZATION" => "Bearer #{TOKEN}")
    assert_equal 200, sites.status
  end

  def test_a_pageview_is_recorded_and_an_ai_agent_fetch_of_an_app_page_is_observed
    event = Runlight::Json.encode({ "k" => "pageview", "u" => "https://example.com/pricing", "r" => "" })
    answer = @app.post("/runlight/e", "HTTP_HOST" => "example.com", "CONTENT_TYPE" => "text/plain", input: event,
                                      "HTTP_USER_AGENT" => SAFARI, "REMOTE_ADDR" => "203.0.113.9")
    assert_equal 202, answer.status
    page = @app.get("/docs", "HTTP_HOST" => "example.com", "HTTP_USER_AGENT" => "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)")
    assert_equal "app saw GET /docs ", page.body
    kinds = @store.db.all("SELECT kind, path FROM rl_events ORDER BY kind").map { |row| [row["kind"], row["path"]] }
    assert_equal [["fetch", "/docs"], ["pageview", "/pricing"]], kinds
  end

  def test_a_short_link_redirects_on_the_apps_own_domain
    @rl.links.create("default", { "slug" => "launch", "url" => "https://example.org/launch" })
    answer = @app.get("/go/launch", "HTTP_HOST" => "example.com", "HTTP_USER_AGENT" => SAFARI)
    assert_includes [301, 302, 307, 308], answer.status
    assert_equal "https://example.org/launch", answer.headers["location"]
  end

  def test_a_link_domain_is_answered_before_the_app_and_the_apps_own_host_reaches_the_app
    @rl.init
    @store.add_link_domain("go.example.com", "default", @now)
    @rl.forget_link_domains
    @rl.links.create("default", { "slug" => "launch", "url" => "https://example.org/launch", "domain" => "go.example.com" })
    answer = @app.get("/launch", "HTTP_HOST" => "go.example.com", "HTTP_USER_AGENT" => SAFARI)
    assert_includes [301, 302, 307, 308], answer.status
    assert_equal "https://example.org/launch", answer.headers["location"]
    assert_equal "app saw GET /launch ", @app.get("/launch", "HTTP_HOST" => "example.com", "HTTP_USER_AGENT" => SAFARI).body
  end

  # A database that cannot be reached, for every statement.
  class DownDb
    def dialect = "sqlite"
    def all(*) = raise("could not connect to server")
    def run(*) = raise("could not connect to server")
    def exclusive = raise("could not connect to server")
    def transaction = raise("could not connect to server")
  end

  def test_the_app_still_answers_when_runlight_cannot_reach_its_database
    rl = Runlight.new(store: Runlight::Stores.from_db(DownDb.new), site: { hostnames: ["example.com"] })
    middleware = Runlight::RackApp.new(@inner, runlight: rl, base_path: "/runlight", token: TOKEN)
    app = Rack::MockRequest.new(middleware)
    _, err = capture_io do
      page = app.get("/products", "HTTP_HOST" => "example.com", "HTTP_USER_AGENT" => SAFARI)
      assert_equal "app saw GET /products ", page.body
      middleware.instance_variable_get(:@warming)&.join
      assert_equal 500, app.get("/runlight/api/sites", "HTTP_HOST" => "example.com", "HTTP_AUTHORIZATION" => "Bearer #{TOKEN}").status
    end
    assert_match(/could not connect/, err)
  end

  def test_a_host_header_no_url_can_hold_still_reaches_the_app
    @rl.init
    ["exa mple.com", "[", "a@b", "example.com:99999", "%zz"].each do |host|
      env = Rack::MockRequest.env_for("/products", "HTTP_HOST" => host)
      status, _, body = Runlight::RackApp.new(@inner, runlight: @rl, base_path: "/runlight", token: TOKEN).call(env)
      text = +""
      body.each { |chunk| text << chunk }
      assert_equal [200, "app saw GET /products "], [status, text], host
    end
    request = Runlight::Http::Request.from_rack(Rack::MockRequest.env_for("/x", "HTTP_HOST" => "a@b", "SERVER_NAME" => "example.com"))
    assert_equal "http://example.com/x", request.url
    assert_equal "a@b", request.headers.get("host"), "the header is kept as it came"
  end

  def test_the_apps_requests_do_not_wait_for_runlight_to_make_its_tables
    started = Queue.new
    go = Queue.new
    @store.define_singleton_method(:migrate) do |*args|
      started << 1
      go.pop
      super(*args)
    end
    assert_equal "app saw GET /products ", @app.get("/products", "HTTP_HOST" => "example.com").body
    started.pop
    refute @rl.ready?, "init runs beside the app's requests"
    assert_equal "app saw GET /pricing ", @app.get("/pricing", "HTTP_HOST" => "example.com").body
    go << 1
    Timeout.timeout(5) { sleep 0.01 until @rl.ready? }
  end

  def test_init_runs_once_however_many_threads_ask_at_once
    migrations = Queue.new
    @store.define_singleton_method(:migrate) do |*args|
      migrations << 1
      sleep 0.05
      super(*args)
    end
    Array.new(6) { Thread.new { @rl.init } }.each(&:join)
    assert_equal 1, migrations.size
    assert @rl.ready?
  end

  # Behind Rack::MethodOverride a form on another page could send POST with _method=DELETE, and a DELETE needs
  # no JSON. It is answered as the POST the browser sent.
  def test_a_method_override_is_answered_as_the_post_the_browser_sent
    signed_in = Runlight::RackApp.new(@inner, runlight: @rl, base_path: "/runlight", authorize: ->(_r) { true })
    app = Rack::MockRequest.new(Rack::MethodOverride.new(signed_in))
    answer = app.post("/runlight/api/tokens/#{"a" * 24}", "HTTP_HOST" => "example.com",
                                                          "CONTENT_TYPE" => "application/x-www-form-urlencoded", input: "_method=DELETE")
    assert_equal 415, answer.status
    assert_equal "send_json", Runlight::Json.decode(answer.body)["code"]
  end

  def test_oauth_discovery_at_the_sites_root_is_answered_before_the_app
    %w[/.well-known/oauth-authorization-server /.well-known/openid-configuration /.well-known/oauth-protected-resource].each do |path|
      answer = @app.get(path, "HTTP_HOST" => "example.com")
      assert_equal 200, answer.status, path
      document = Runlight::Json.decode(answer.body)
      assert_equal "http://example.com/runlight", document["issuer"] || document["authorization_servers"][0], path
    end
    assert_equal "app saw GET /.well-known/security.txt ", @app.get("/.well-known/security.txt", "HTTP_HOST" => "example.com").body
  end

  def test_alone_it_answers_everything_and_a_head_has_no_body
    alone = Rack::MockRequest.new(Runlight::RackApp.new(runlight: @rl, base_path: "/runlight", token: TOKEN))
    assert_equal 404, alone.get("/elsewhere", "HTTP_HOST" => "example.com").status
    head = alone.request("HEAD", "/elsewhere", "HTTP_HOST" => "example.com")
    assert_equal 404, head.status
    assert_equal "", head.body
  end

  # A request body that never ends, as a chunked upload with no Content-Length can be, counting what is read.
  class Endless
    attr_reader :read_bytes

    def initialize
      @read_bytes = 0
    end

    def read(length = nil, buffer = nil)
      raise "read without a length would never end" if length.nil?

      @read_bytes += length
      chunk = "x" * length
      buffer ? buffer.replace(chunk) : chunk
    end

    def rewind; end
  end

  def post(path, input, headers = {})
    env = Rack::MockRequest.env_for(path, { method: "POST", "HTTP_HOST" => "example.com", "CONTENT_TYPE" => "text/plain" }.merge(headers))
    env["rack.input"] = input
    Runlight::RackApp.new(runlight: @rl, base_path: "/runlight", token: TOKEN).call(env)
  end

  def test_a_body_past_its_limit_is_answered_413_after_reading_one_byte_past_it
    collect = Endless.new
    status, headers, body = post("/runlight/e", collect)
    assert_equal 413, status
    assert_equal "close", headers["connection"]
    assert_equal({ "error" => "That request is too large" }, Runlight::Json.decode(body.join))
    assert_operator collect.read_bytes, :<=, (16 * 1024) + 1, "the collect endpoint reads at most 16 KB and a byte"

    api = Endless.new
    status, = post("/runlight/api/links/import", api, "HTTP_AUTHORIZATION" => "Bearer #{TOKEN}")
    assert_equal 413, status
    assert_operator api.read_bytes, :<=, (10 * 1024 * 1024) + 1, "everything else reads at most 10 MB and a byte"
  end

  def test_a_content_length_past_the_limit_is_refused_unread_and_one_under_it_is_not_trusted
    declared = Endless.new
    status, = post("/runlight/e", declared, "CONTENT_LENGTH" => (2 * 1024 * 1024 * 1024).to_s)
    assert_equal 413, status
    assert_equal 0, declared.read_bytes

    lying = Endless.new
    status, = post("/runlight/e", lying, "CONTENT_LENGTH" => "10")
    assert_equal 413, status
    assert_operator lying.read_bytes, :<=, (16 * 1024) + 1

    event = Runlight::Json.encode({ "k" => "pageview", "u" => "https://example.com/", "r" => "" })
    status, = post("/runlight/e", StringIO.new(event), "CONTENT_LENGTH" => event.bytesize.to_s, "HTTP_USER_AGENT" => SAFARI,
                                                         "REMOTE_ADDR" => "203.0.113.9")
    assert_equal 202, status, "a body within the limit is read whole"
  end

  def test_the_routes_as_a_rack_app_cap_the_body_too
    env = Rack::MockRequest.env_for("/runlight/e", method: "POST", "HTTP_HOST" => "example.com")
    env["rack.input"] = Endless.new
    status, = @rl.routes({ base_path: "/runlight" }).call(env)
    assert_equal 413, status
  end

  def test_the_routes_as_a_rack_app_run_the_later_work_once_the_answer_is_sent
    ran = []
    @rl.later { ran << :later }
    env = Rack::MockRequest.env_for("/runlight/s.js", "HTTP_HOST" => "example.com")
    status, _, body = @rl.routes({ base_path: "/runlight" }).call(env)
    assert_equal 200, status
    assert_empty ran, "not before the answer is sent"
    body.each { |_| nil }
    body.close
    assert_equal [:later], ran
  end
end

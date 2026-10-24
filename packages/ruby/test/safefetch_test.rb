# frozen_string_literal: true

require "test_helper"
require "socket"

# Ports safefetch.test.ts, replays the address checks in the outbound fixture, and covers each hop's checks.
class SafefetchTest < Minitest::Test
  Safefetch = Runlight::Safefetch
  Response = Runlight::Http::Response
  FetchError = Runlight::Http::FetchError
  PrivateAddressError = Runlight::PrivateAddressError

  # A DNS stand-in.
  def dns(names)
    ->(name) { names[name] || [] }
  end

  def test_link_local_and_cloud_metadata_addresses_are_told_apart_from_loopback_and_private_ones
    ["169.254.169.254", "169.254.0.1", "100.100.100.200", "fe80::1", "fe80::a9fe:a9fe", "fd00:ec2::254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe",
     "64:ff9b::a9fe:a9fe", "::ffff:0:a9fe:a9fe"].each { |ip| assert Safefetch.metadata_address?(ip), ip }
    ["127.0.0.1", "::1", "10.0.0.5", "192.168.1.20", "fd00::1", "fd00:ec2::253", "93.184.215.14", "not an address"].each do |ip|
      refute Safefetch.metadata_address?(ip), ip
    end
    assert Safefetch.metadata_host?("metadata.google.internal")
    assert Safefetch.metadata_host?("[fd00:ec2::254]")
    assert Safefetch.metadata_host?("169.254.169.254")
    refute Safefetch.metadata_host?("localhost"), "a model on this computer is fine"
    refute Safefetch.metadata_host?("192.168.1.20")
  end

  def test_only_addresses_on_the_public_internet_count_as_public
    ["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:82a::200e", "::ffff:0:808:808", "64:ff9b::808:808"].each do |ip|
      assert Safefetch.public_address?(ip), ip
    end
    [
      "127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
      "::1", "::", "fe80::1", "fd00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::a00:1",
      "2002:a00:1::", "2001:db8::1", "2001:0:4136:e378::1", "[::1]", "not an address", "1.2.3", "1.2.3.256",
      # IPv4-translated loopback, local-use NAT64, the old site-local, ORCHID, the newer documentation prefix, and discard.
      "::ffff:0:7f00:1", "64:ff9b:1::7f00:1", "fec0::1", "2001:20::1", "3fff::1", "100::1",
    ].each do |ip|
      refute Safefetch.public_address?(ip), ip
    end
  end

  def test_address_checks_match_type_script
    Fixtures.load("outbound")["ips"].each do |c|
      assert_equal c["public"], Safefetch.public_address?(c["ip"]), c["ip"]
    end
  end

  def test_a_public_fetch_never_reaches_the_installs_own_network_however_the_address_is_written
    # Something listening locally, which none of these may reach.
    inside = TCPServer.new("127.0.0.1", 0)
    port = inside.addr[1]
    begin
      ["http://127.0.0.1:#{port}/", "https://127.0.0.1:#{port}/", "https://[::1]:#{port}/", "https://[::ffff:127.0.0.1]:#{port}/",
       "https://localhost:#{port}/", "https://LOCALHOST.:#{port}/", "https://app.localhost:#{port}/"].each do |url|
        assert_raises(PrivateAddressError, "#{url} should be refused") { Safefetch.public_fetch(url, { "timeoutMs" => 2000 }) }
      end
      assert_nil inside.wait_readable(0), "nothing connected"
      assert Safefetch.resolves_privately?("localhost")
      refute Safefetch.resolves_privately?("name.that.does.not.resolve.invalid")
      assert_equal [], Safefetch.public_addresses("name.that.does.not.resolve.invalid")
      assert_equal ["8.8.8.8"], Safefetch.public_addresses("8.8.8.8")
      assert_equal [], Safefetch.public_addresses("localhost")
    ensure
      inside.close
    end
  end

  def test_the_checked_addresses_are_pinned
    fetcher = FakeFetcher.new { |_url, _init| Response.new("ok") }
    answer = Safefetch.public_fetch("https://Example.com/icon", {
                                      "timeoutMs" => 2000, "headers" => { "user-agent" => "Runlight" }, "maxBytes" => 10,
                                      "lookup" => dns({ "example.com" => ["93.184.215.14", "2606:4700::1111"] }),
                                    }, fetcher)
    assert_equal "ok", answer.text
    assert_equal ["example.com:443:93.184.215.14,[2606:4700::1111]"], fetcher.inits[0]["resolve"]
    assert_equal "manual", fetcher.inits[0]["redirect"]
    assert_equal 10, fetcher.inits[0]["maxBytes"]
    assert_equal({ "method" => "GET", "url" => "https://example.com/icon", "headers" => { "user-agent" => "Runlight" }, "body" => "" }, fetcher.requests[0])

    literal = FakeFetcher.new { |_url, _init| Response.new("ok") }
    Safefetch.public_fetch("https://93.184.215.14:8443/", { "timeoutMs" => 2000, "lookup" => dns({}) }, literal)
    refute literal.inits[0].key?("resolve"), "an address needs no pin"
  end

  def test_a_name_with_any_private_address_is_refused
    fetcher = FakeFetcher.new { |_url, _init| Response.new("ok") }
    { "inside.example" => ["10.0.0.5"], "mixed.example" => ["93.184.215.14", "169.254.169.254"], "mapped.example" => ["::ffff:127.0.0.1"] }.each do |name, addresses|
      error = assert_raises(PrivateAddressError, "#{name} should be refused") do
        Safefetch.public_fetch("https://#{name}/", { "timeoutMs" => 2000, "lookup" => dns({ name => addresses }) }, fetcher)
      end
      assert_equal "#{name} is not a public address", error.message
    end
    assert_equal [], fetcher.requests
    assert_raises(FetchError) { Safefetch.public_fetch("https://nowhere.example/", { "timeoutMs" => 2000, "lookup" => dns({}) }, fetcher) }
  end

  def test_redirects_are_followed_by_hand_under_the_same_rules
    lookup = dns({ "a.example" => ["93.184.215.14"], "b.example" => ["1.1.1.1"], "inside.example" => ["192.168.0.2"] })
    hops = ->(answers) { FakeFetcher.new { |_url, _init| answers.shift || Response.new("end") } }

    fetcher = hops.call([Response.redirect("/next", status: 301), Response.redirect("https://b.example/last", status: 302), Response.new("done")])
    answer = Safefetch.public_fetch("https://a.example/", { "timeoutMs" => 2000, "redirects" => 3, "lookup" => lookup }, fetcher)
    assert_equal "done", answer.text
    assert_equal ["https://a.example/", "https://a.example/next", "https://b.example/last"], fetcher.requests.map { |r| r["url"] }
    assert_equal ["b.example:443:1.1.1.1"], fetcher.inits[2]["resolve"]

    fetcher = hops.call([Response.redirect("https://b.example/", status: 302)])
    assert_equal 302, Safefetch.public_fetch("https://a.example/", { "timeoutMs" => 2000, "lookup" => lookup }, fetcher).status,
                 "a redirect past the last comes back as it is"

    { "https://10.0.0.1/" => "10.0.0.1", "https://inside.example/" => "inside.example", "http://b.example/" => "http://b.example/",
      "https://[fe80::1]/" => "fe80::1" }.each do |location, what|
      error = assert_raises(PrivateAddressError, "#{location} should be refused") do
        Safefetch.public_fetch("https://a.example/", { "timeoutMs" => 2000, "redirects" => 3, "lookup" => lookup }, hops.call([Response.redirect(location)]))
      end
      assert_equal "#{what} is not a public address", error.message
    end
  end

  def test_running_out_of_time_says_so
    fetcher = FakeFetcher.new { |_url, _init| raise FetchError.new("Operation timed out", timed_out: true) }
    error = assert_raises(FetchError, "should time out") do
      Safefetch.public_fetch("https://a.example/", { "timeoutMs" => 2000, "lookup" => dns({ "a.example" => ["1.1.1.1"] }) }, fetcher)
    end
    assert error.timed_out?
    assert_equal "The operation was aborted due to timeout", error.message
    refused = FakeFetcher.new { |_url, _init| raise FetchError, "Connection refused" }
    error = assert_raises(FetchError) do
      Safefetch.public_fetch("https://a.example/", { "timeoutMs" => 2000, "lookup" => dns({ "a.example" => ["1.1.1.1"] }) }, refused)
    end
    assert_equal "Connection refused", error.message
  end

  def test_another_install_is_only_fetched_at_a_public_https_address_with_no_redirect_followed
    ["https://example.com/runlight", "https://example.com"].each { |url| assert Safefetch.install_address?(url, false), url }
    ["http://127.0.0.1:4100/runlight", "http://localhost", "http://example.com", "ftp://example.com"].each { |url| refute Safefetch.install_address?(url, false), url }
    # Only code allows an install on this machine, and then only at these two names.
    ["http://127.0.0.1:4100/runlight", "http://localhost", "http://localhost:3000/runlight"].each { |url| assert Safefetch.install_address?(url, true), url }
    ["http://10.0.0.1", "http://localhost.example.com", "http://localhost@example.com", "http://127.0.0.1:80@example.com"].each do |url|
      refute Safefetch.install_address?(url, true), url
    end

    asked = []
    inside = FakeFetcher.new do |url, init|
      asked << [url, init["redirect"]]
      Response.new("", status: 302, headers: { "location" => "http://169.254.169.254/" })
    end
    ["http://127.0.0.1:4100/api/sites", "https://127.0.0.1:4100/api/sites", "https://localhost:4100/api/sites", "https://169.254.169.254/latest/meta-data/"].each do |url|
      assert_raises(PrivateAddressError, url) { Safefetch.owner_fetch(url, { "timeoutMs" => 2000 }, inside) }
    end
    assert_equal [], asked, "nothing on this machine was asked"
    # Allowed in code, a local install is asked, and its redirect is handed back, not followed.
    assert_equal 302, Safefetch.owner_fetch("http://127.0.0.1:4100/api/sites", { "timeoutMs" => 2000 }, inside, true).status
    assert_equal [["http://127.0.0.1:4100/api/sites", "manual"]], asked
  end

  # A server on a local port that answers each request with its name, and counts them.
  def local_server(name)
    server = TCPServer.new("127.0.0.1", 0)
    seen = Queue.new
    thread = Thread.new do
      loop do
        client = server.accept
        seen << client.gets.to_s
        while (line = client.gets) && line != "\r\n"; end
        client.write("HTTP/1.1 200 OK\r\ncontent-length: #{name.bytesize}\r\nconnection: close\r\n\r\n#{name}")
        client.close
      end
    rescue IOError
      nil
    end
    [server, seen, thread]
  end

  def test_a_pinned_request_never_goes_through_a_proxy_from_the_environment
    target, = local_server("target")
    proxy, through_proxy = local_server("proxy")
    port = target.addr[1]
    saved = ENV.to_h.slice("http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY")
    ENV["http_proxy"] = ENV["HTTP_PROXY"] = "http://127.0.0.1:#{proxy.addr[1]}"
    ENV.delete("no_proxy")
    ENV.delete("NO_PROXY")
    fetcher = Runlight::Http::NetFetcher.new
    answer = fetcher.fetch("http://site.example:#{port}/", { "resolve" => ["site.example:#{port}:127.0.0.1"], "timeoutMs" => 3000 })
    assert_equal "target", answer.text
    assert_equal 0, through_proxy.size
    assert_equal "proxy", fetcher.fetch("http://site.example:#{port}/", { "timeoutMs" => 3000 }).text, "unpinned, the proxy still applies"
  ensure
    %w[http_proxy HTTP_PROXY no_proxy NO_PROXY].each { |k| saved&.key?(k) ? ENV[k] = saved[k] : ENV.delete(k) }
    target&.close
    proxy&.close
  end

  def test_a_pin_that_cannot_be_applied_refuses_rather_than_fetching_unpinned
    target, seen = local_server("target")
    port = target.addr[1]
    fetcher = Runlight::Http::NetFetcher.new
    [["elsewhere.example:#{port}:127.0.0.1"], ["localhost:#{port + 1}:127.0.0.1"]].each do |pin|
      assert_raises(FetchError, pin.first) { fetcher.fetch("http://localhost:#{port}/", { "resolve" => pin, "timeoutMs" => 3000 }) }
    end
    assert_equal 0, seen.size
  ensure
    target&.close
  end

  # A server on a local port that records each request and answers it as `answer` says, with a status, headers,
  # and a body.
  def service_server(&answer)
    server = TCPServer.new("127.0.0.1", 0)
    seen = []
    Thread.new do
      loop do
        client = server.accept
        method, path = client.gets.to_s.split(" ")
        headers = {}
        while (line = client.gets) && line != "\r\n"
          name, value = line.chomp.split(":", 2)
          headers[name.downcase] = value.to_s.strip
        end
        body = headers["content-length"].to_i.positive? ? client.read(headers["content-length"].to_i) : ""
        seen << { "method" => method, "url" => path, "body" => body, "authorization" => headers["authorization"].to_s,
                  "type" => headers["content-type"].to_s }
        status, sent, text = answer.call(path, server.addr[1])
        lines = sent.merge("content-length" => text.bytesize, "connection" => "close").map { |k, v| "#{k}: #{v}\r\n" }.join
        client.write("HTTP/1.1 #{status} X\r\n#{lines}\r\n#{text}")
        client.close
      end
    rescue IOError
      nil
    end
    [server, seen]
  end

  def test_a_services_redirects_are_followed_only_while_each_one_stays_off_link_local_and_metadata_addresses
    server, seen = service_server do |path, port|
      case path
      when "/metadata" then [302, { "location" => "http://169.254.169.254/latest/meta-data/" }, ""]
      when "/metadata-v6" then [307, { "location" => "http://[fd00:ec2::254]/" }, ""]
      when "/see-other" then [303, { "location" => "/landed" }, ""]
      when "/keep" then [307, { "location" => "/landed" }, ""]
      when "/elsewhere" then [307, { "location" => "http://localhost:#{port}/landed" }, ""]
      when "/loop" then [302, { "location" => "/loop" }, ""]
      else [200, {}, "ok"]
      end
    end
    base = "http://127.0.0.1:#{server.addr[1]}"
    ask = { "method" => "POST", "headers" => { "authorization" => "Bearer key", "content-type" => "application/json" }, "body" => "{}" }

    # A service on this computer is fine; a redirect to a metadata address is refused before it is asked.
    error = assert_raises(Runlight::MetadataAddressError) { Safefetch.service_fetch("#{base}/metadata", ask) }
    assert_equal "169.254.169.254", error.host
    assert_equal "169.254.169.254 is a link-local or cloud metadata address, which Runlight never connects to", error.message
    assert_equal "fd00:ec2::254", assert_raises(Runlight::MetadataAddressError) { Safefetch.service_fetch("#{base}/metadata-v6", ask) }.host
    assert_raises(Runlight::MetadataAddressError) { Safefetch.service_fetch("http://169.254.169.254/v1/models", {}) }
    assert_equal %w[/metadata /metadata-v6], seen.map { |r| r["url"] }, "nothing was asked at the metadata address"

    # Followed as fetch follows them on the same origin: a 303 goes on as a GET with no body, and a 307 keeps both.
    seen.clear
    assert_equal "ok", Safefetch.service_fetch("#{base}/see-other", ask).text
    assert_equal({ "method" => "GET", "url" => "/landed", "body" => "", "authorization" => "Bearer key", "type" => "" }, seen[1])
    seen.clear
    Safefetch.service_fetch("#{base}/keep", ask)
    assert_equal({ "method" => "POST", "url" => "/landed", "body" => "{}", "authorization" => "Bearer key", "type" => "application/json" }, seen[1])
    seen.clear
    error = assert_raises(Runlight::RedirectRefusedError) { Safefetch.service_fetch("#{base}/elsewhere", ask) }
    assert_equal 1, seen.length, "nothing was sent to the other origin"
    assert_equal "127.0.0.1:#{server.addr[1]}", error.host
    assert_equal "http://localhost:#{server.addr[1]}", error.to

    # Past the last redirect, the redirect comes back as it is.
    seen.clear
    assert_equal 302, Safefetch.service_fetch("#{base}/loop", { "redirects" => 2 }).status
    assert_equal 3, seen.length

    # The AI assistant and a mail webhook refuse such a redirect with the address it led to.
    refused = assert_raises(Runlight::AssistantError) do
      Runlight::Assistant.list_models({ "provider" => "custom", "baseUrl" => "#{base}/metadata#", "key" => "" })
    end
    assert_equal ["address_refused", { "host" => "169.254.169.254" }], [refused.code, refused.params]
    message = { "to" => "me@example.com", "from" => "reports@example.com", "subject" => "Hi", "html" => "<p>Hi</p>", "text" => "Hi" }
    mailed = assert_raises(Runlight::Mail::MailError) do
      Runlight::Mail::Transports.deliver({ "service" => "webhook", "url" => "http://localhost:#{server.addr[1]}/metadata" }, message)
    end
    assert_equal "address_refused", mailed.code
    assert_equal({ "host" => "169.254.169.254" }, mailed.params)
    assert_equal "169.254.169.254 is a link-local or cloud metadata address, which Runlight never connects to", mailed.message
  ensure
    server&.close
  end

  def test_a_services_redirect_to_another_origin_is_refused_with_no_second_request
    server, seen = service_server do |path, port|
      case path
      when "/307" then [307, { "location" => "http://localhost:#{port}/landed" }, ""]
      when "/308" then [308, { "location" => "http://127.0.0.1:#{port + 1}/landed" }, ""]
      when "/scheme" then [308, { "location" => "ftp://127.0.0.1/landed" }, ""]
      else [200, {}, "ok"]
      end
    end
    base = "http://127.0.0.1:#{server.addr[1]}"
    keys = { "authorization" => "Bearer k", "proxy-authorization" => "Basic k", "cookie" => "a=b", "x-api-key" => "k", "api-key" => "k",
             "x-postmark-server-token" => "k", "content-type" => "application/json" }

    %w[/307 /308].each do |path|
      seen.clear
      error = assert_raises(Runlight::RedirectRefusedError) do
        Safefetch.service_fetch("#{base}#{path}", { "method" => "POST", "headers" => keys, "body" => "{\"private\":true}" })
      end
      assert_equal 1, seen.length, "#{path}: neither the key headers nor the body reached the other origin"
      assert_match(/\Alocalhost|\A127\.0\.0\.1/, error.host)
      assert_equal "#{error.host} redirected to #{error.to}. Runlight sends a service's key and request only to the address it was set up with, so set it up with that address instead", error.message
    end
    assert_equal "ftp:", assert_raises(Runlight::RedirectRefusedError) { Safefetch.service_fetch("#{base}/scheme", {}) }.to

    # Each service says so, with the address it was sent to.
    seen.clear
    refused = assert_raises(Runlight::AssistantError) do
      Runlight::Assistant.list_models({ "provider" => "anthropic", "baseUrl" => "#{base}/307#", "key" => "k" })
    end
    assert_equal "redirect_refused", refused.code
    assert_equal({ "host" => "127.0.0.1:#{server.addr[1]}", "to" => "http://localhost:#{server.addr[1]}" }, refused.params)
    assert_equal 1, seen.length
    message = { "to" => "me@example.com", "from" => "reports@example.com", "subject" => "Hi", "html" => "<p>Hi</p>", "text" => "Hi" }
    seen.clear
    mailed = assert_raises(Runlight::Mail::MailError) do
      Runlight::Mail::Transports.deliver({ "service" => "webhook", "url" => "#{base}/307" }, message)
    end
    assert_equal "redirect_refused", mailed.code
    assert_equal({ "host" => "127.0.0.1:#{server.addr[1]}", "to" => "http://localhost:#{server.addr[1]}" }, mailed.params)
    assert_equal 1, seen.length
  ensure
    server&.close
  end

  # A server that answers 200 and then writes without end until the other side hangs up, counting what it wrote.
  def endless_server
    server = TCPServer.new("127.0.0.1", 0)
    sent = Queue.new
    Thread.new do
      client = server.accept
      while (line = client.gets) && line != "\r\n"
        # the request
      end
      client.write("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n")
      chunk = "x" * 65_536
      loop { client.write(chunk) && sent << chunk.bytesize }
    rescue IOError, SystemCallError
      nil
    ensure
      client&.close
    end
    [server, sent]
  end

  def test_an_answer_without_end_is_read_only_so_far_and_cut_off
    server, sent = endless_server
    cap = 64 * 1024
    answer = Safefetch.service_fetch("http://127.0.0.1:#{server.addr[1]}/", { "timeoutMs" => 5000, "maxBytes" => cap + 1, "truncate" => true })
    assert_equal 200, answer.status
    assert_equal cap + 1, answer.text.bytesize
    assert_raises(Runlight::Http::BodyTooLong) { Runlight::Body.read_text_capped(answer, cap) }
    sleep 0.2
    total = 0
    total += sent.pop until sent.empty?
    assert_operator total, :<, 8 * 1024 * 1024, "the connection was cut off long before the end of an endless answer"
  ensure
    server&.close
  end

  def test_a_model_a_mail_service_and_a_link_domain_are_read_only_so_far
    big = ->(extra) { Runlight::Http::Response.new(%({"data":[{"id":"m"}],"pad":"#{"x" * extra}"}), status: 200) }
    seen = []
    fetcher = Object.new
    fetcher.define_singleton_method(:fetch) { |_url, init = {}| seen << init; big.call(5 * 1024 * 1024) }
    # Over 4 MiB, the model's list is unreadable, as it is when it is not JSON; under, it is read.
    listed = assert_raises(Runlight::AssistantError) do
      Runlight::Assistant.list_models({ "provider" => "custom", "baseUrl" => "http://127.0.0.1:9/v1", "key" => "" }, fetcher)
    end
    assert_equal "assistant_no_models", listed.code
    assert_equal [4 * 1024 * 1024 + 1], seen.map { |init| init["maxBytes"] }
    assert_equal [true], seen.map { |init| init["truncate"] }
    small = Object.new
    small.define_singleton_method(:fetch) { |_url, _init = {}| big.call(10) }
    assert_equal ["m"], Runlight::Assistant.list_models({ "provider" => "custom", "baseUrl" => "http://127.0.0.1:9/v1", "key" => "" }, small).map { |m| m["id"] }

    # A mail service's error is read up to 64 KiB; past it the service has no say, and a good answer is never read.
    message = { "to" => "me@example.com", "from" => "reports@example.com", "subject" => "Hi", "html" => "<p>Hi</p>", "text" => "Hi" }
    errors = lambda do |text|
      fetch = Object.new
      fetch.define_singleton_method(:fetch) { |_url, init = {}| (seen << init) && Runlight::Http::Response.new(text, status: 500) }
      Runlight::Mail::Transports.deliver({ "service" => "resend", "apiKey" => "re_1" }, message, fetch)
    rescue Runlight::Mail::MailError => e
      e.params["detail"]
    end
    seen.clear
    assert_equal "500 no good", errors.call(%({"message":"no good"}))
    assert_equal "500", errors.call(%({"message":"#{"x" * 70_000}"}))
    assert_equal [65_537, 65_537], seen.map { |init| init["maxBytes"] }
  end

  # A fetcher that reaches the network, as far as service_fetch can tell, which records what it is asked.
  class RecordingNet < Runlight::Http::NetFetcher
    attr_reader :asked

    def initialize
      super
      @asked = []
    end

    def fetch(url, init = {})
      @asked << [url, init]
      Runlight::Http::Response.new("ok")
    end
  end

  def test_a_service_is_fetched_from_the_address_its_name_was_checked_at
    answers = {
      "llm.internal" => ["10.0.0.5"], "both.example.org" => ["10.0.0.6", "fd00::6"], "evil.example.org" => ["10.0.0.7", "169.254.169.254"],
      "meta6.example.org" => ["fd00:ec2::254"], "gone.example.org" => [],
    }
    saved = Safefetch.instance_variable_get(:@resolver)
    Safefetch.resolver = ->(name) { answers.fetch(name) { raise SocketError, "no" } }
    net = RecordingNet.new

    # Private and local addresses stay allowed (a model or a mail relay is often there), and the connection is
    # pinned to what was checked, which also keeps it off any proxy from the environment.
    assert_equal "ok", Safefetch.service_fetch("http://llm.internal:11434/v1/models", {}, net).text
    assert_equal ["llm.internal:11434:10.0.0.5"], net.asked.last[1]["resolve"]
    Safefetch.service_fetch("https://both.example.org/", {}, net)
    assert_equal ["both.example.org:443:10.0.0.6,[fd00::6]"], net.asked.last[1]["resolve"]
    Safefetch.service_fetch("http://127.0.0.1:8080/", {}, net)
    assert_equal ["127.0.0.1:8080:127.0.0.1"], net.asked.last[1]["resolve"]
    reached = net.asked.length

    # Any metadata address among a name's, or none that resolves, is refused before anything is sent.
    assert_raises(Runlight::MetadataAddressError) { Safefetch.service_fetch("https://evil.example.org/", {}, net) }
    assert_raises(Runlight::MetadataAddressError) { Safefetch.service_fetch("https://meta6.example.org/", {}, net) }
    unreachable = assert_raises(Runlight::Http::FetchError) { Safefetch.service_fetch("https://gone.example.org/", {}, net) }
    assert_equal "Could not look up gone.example.org", unreachable.message
    assert_equal reached, net.asked.length

    # A fetcher a test or an app supplies is not held to a lookup that may have nowhere to go.
    fake = Object.new
    fake.define_singleton_method(:fetch) { |_url, _init = {}| Runlight::Http::Response.new("fake") }
    assert_equal "fake", Safefetch.service_fetch("https://gone.example.org/", {}, fake).text
    assert_raises(Runlight::MetadataAddressError) { Safefetch.service_fetch("https://evil.example.org/", {}, fake) }
  ensure
    Safefetch.resolver = saved
  end

  def test_a_name_pinned_to_several_addresses_connects_to_the_one_that_listens
    server = TCPServer.new("127.0.0.1", 0)
    Thread.new do
      loop do
        client = server.accept
        while (line = client.gets) && line != "\r\n"
          # the request
        end
        client.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
        client.close
      end
    rescue IOError
      nil
    end
    port = server.addr[1]
    # Nothing listens on ::1 at that port, as on a host whose localhost leads with IPv6 and a server on IPv4.
    answer = Runlight::Http::NetFetcher.new.fetch("http://localhost:#{port}/", { "resolve" => ["localhost:#{port}:[::1],127.0.0.1"], "timeoutMs" => 3000 })
    assert_equal "ok", answer.text
  ensure
    server&.close
  end
end

# frozen_string_literal: true

require "test_helper"

# NetFetcher's redirects, as http/fetcher.py's tests hold Python's: credentials go no further than their origin,
# and nothing follows from https to http.
class HttpFetcherTest < Minitest::Test
  Fetcher = Runlight::Http::NetFetcher
  Headers = Runlight::Http::Headers
  Response = Runlight::Http::Response

  # A fetcher whose requests are answered from a table of url => [status, location], recording what each carried.
  class Scripted < Fetcher
    attr_reader :seen

    def initialize(routes)
      super()
      @routes = routes
      @seen = []
    end

    private

    def once(url, method, headers, body, _init, _deadline)
      @seen << { "url" => url, "method" => method, "headers" => headers.to_h, "body" => body }
      status, location = @routes.fetch(url) { [200, nil] }
      Response.new("", status: status, headers: location ? { "location" => [location] } : {})
    end
  end

  CREDENTIALS = { "authorization" => "Bearer secret", "cookie" => "a=b", "proxy-authorization" => "Basic x", "x-api-key" => "key", "x-keep" => "kept" }.freeze

  def test_a_redirect_to_another_origin_drops_every_credential_and_keeps_the_rest
    net = Scripted.new("https://a.example.com/start" => [307, "https://b.example.com/next"])
    net.fetch("https://a.example.com/start", { "method" => "POST", "body" => "x", "headers" => CREDENTIALS })
    assert_equal CREDENTIALS.keys.sort, net.seen[0]["headers"].keys.sort
    assert_equal ["x-keep"], net.seen[1]["headers"].keys, "only what is not a credential goes on"
    assert_equal ["POST", "x"], net.seen[1].values_at("method", "body"), "a 307 still carries its body"
  end

  def test_a_redirect_to_another_port_or_scheme_of_the_same_host_is_another_origin
    net = Scripted.new("http://a.example.com/start" => [302, "http://a.example.com:8080/next"], "http://a.example.com:8080/next" => [302, "https://a.example.com/last"])
    net.fetch("http://a.example.com/start", { "headers" => CREDENTIALS })
    assert_equal [CREDENTIALS.length, 1, 1], net.seen.map { |s| s["headers"].length }
  end

  def test_a_redirect_within_one_origin_keeps_the_credentials
    net = Scripted.new("https://a.example.com/start" => [302, "/next"])
    net.fetch("https://a.example.com/start", { "headers" => CREDENTIALS })
    assert_equal ["https://a.example.com/start", "https://a.example.com/next"], net.seen.map { |s| s["url"] }
    assert_equal [CREDENTIALS.length, CREDENTIALS.length], net.seen.map { |s| s["headers"].length }
  end

  def test_a_redirect_from_https_to_http_is_refused_before_anything_is_sent_there
    net = Scripted.new("https://a.example.com/start" => [301, "http://a.example.com/plain"])
    error = assert_raises(Runlight::Http::FetchError) { net.fetch("https://a.example.com/start", { "headers" => CREDENTIALS }) }
    assert_match(/https to http/, error.message)
    assert_equal ["https://a.example.com/start"], net.seen.map { |s| s["url"] }
  end

  def test_a_redirect_from_http_to_https_still_follows_and_a_manual_redirect_is_handed_back
    net = Scripted.new("http://a.example.com/start" => [301, "https://a.example.com/start"])
    assert_equal 200, net.fetch("http://a.example.com/start", {}).status
    manual = Scripted.new("https://a.example.com/start" => [301, "http://a.example.com/plain"])
    assert_equal 301, manual.fetch("https://a.example.com/start", { "redirect" => "manual" }).status
  end
end

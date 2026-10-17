# frozen_string_literal: true

require "test_helper"

# Replays conformance/url.json: URLs, query strings, and numbers read and written as JavaScript does.
class UrlTest < Minitest::Test
  def fixture
    Fixtures.conformance("url")
  end

  def test_urls
    cases = fixture["urls"].map { |c| [c["input"], nil, c["expect"]] } +
            fixture["relative"].map { |c| [c["input"], c["base"], c["expect"]] }
    cases.each do |input, base, expect|
      url = Runlight::Http::Url.parse(input, base)
      if expect.nil?
        assert_nil url, "#{input.inspect} should not parse"
        next
      end
      refute_nil url, "#{input.inspect} should parse"
      got = {
        "href" => url.href, "protocol" => url.protocol, "username" => url.username, "password" => url.password,
        "hostname" => url.hostname, "port" => url.port, "host" => url.host, "origin" => url.origin,
        "pathname" => url.pathname, "search" => url.search, "hash" => url.hash
      }
      assert_equal expect, got, input.inspect
    end
  end

  # As new URL() reads them in Node: a host that ends in a number is an address or no host at all.
  def test_an_ipv4_host_with_an_invalid_octal_digit_or_more_than_four_parts_is_no_host
    {
      "https://1.2.3.4.5/" => nil, "https://09.0.0.1/" => nil, "https://08/" => nil, "https://a.b.5/" => nil,
      "https://0x7f.1/" => "127.0.0.1", "https://017.0.0.1/" => "15.0.0.1", "https://1.2.3.4./" => "1.2.3.4",
      "https://127.1/" => "127.0.0.1", "https://1.2.3.4.example.com/" => "1.2.3.4.example.com", "https://0/" => "0.0.0.0", "https://00/" => "0.0.0.0"
    }.each do |input, hostname|
      url = Runlight::Http::Url.parse(input)
      if hostname.nil? then assert_nil url, input
      else assert_equal hostname, url&.hostname, input
      end
    end
  end

  def test_queries
    fixture["queries"].each do |c|
      params = Runlight::Http::SearchParams.new(c["input"])
      assert_equal c["pairs"], params.map { |name, value| [name, value] }, c["input"]
      assert_equal c["string"], params.to_s, c["input"]
    end
    fixture["written"].each do |c|
      params = Runlight::Http::SearchParams.new
      c["pairs"].each { |name, value| params.append(name, value) }
      assert_equal c["string"], params.to_s
    end
  end

  def test_numbers
    fixture["numbers"].each do |c|
      n = c["n"].is_a?(String) ? Float(c["n"]) : c["n"]
      n = n.to_f if n.is_a?(Integer) && n.abs >= 2**53
      assert_equal c["text"], Runlight::Json.number(n), c["n"].to_s
      assert_equal c["text"], Runlight::Json.number(n.to_f), c["n"].to_s if n.is_a?(Integer)
    end
  end

  def test_json_matches_javascript
    value = { "a" => [], "b" => {}, "c" => 1.0, "d" => 0.5, "e" => "/café \u{1F600}", "f" => Float::NAN, "g" => Runlight::UNDEFINED }
    assert_equal "{\"a\":[],\"b\":{},\"c\":1,\"d\":0.5,\"e\":\"/café \u{1F600}\",\"f\":null}", Runlight::Json.encode(value)
    assert_equal "\" \\n\\u0001\"", Runlight::Json.encode(" \n\x01")
    assert_equal "{\n  \"a\": [\n    1,\n    {}\n  ],\n  \"b\": {}\n}", Runlight::Json.encode({ "a" => [1, {}], "b" => {} }, pretty: true)
  end
end

# frozen_string_literal: true

require "test_helper"

# The port of the SDK's agentcheck.test.ts: AI agents' addresses checked against the lists their companies publish.
class AgentCheckTest < Minitest::Test
  AgentCheck = Runlight::AgentCheck
  AGENTS = Runlight::Data::Agents::AI_AGENTS

  def test_addresses_ipv4_ipv6_ipv4_written_as_ipv6_brackets_and_zones_and_junk
    assert_equal [4, 0x14abce11], AgentCheck.parse_address("20.171.206.17")
    assert_equal [4, 0x14abce11], AgentCheck.parse_address(" ::ffff:20.171.206.17 ")
    assert_equal [4, 0x14abce11], AgentCheck.parse_address("::ffff:14ab:ce11")
    assert_equal [6, (0x26001f2803658000 << 64) | 1], AgentCheck.parse_address("[2600:1f28:365:8000::1]")
    assert_equal [6, (0xfe80 << 112) | 1], AgentCheck.parse_address("fe80::1%eth0")
    assert_equal [6, 0], AgentCheck.parse_address("::")
    ["", "unknown", "256.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4x", "1::2::3", "12345::", ":1::", "1:2:3:4:5:6:7:8:9", "::ffff:1.2.3.256", "-"].each do |junk|
      assert_nil AgentCheck.parse_address(junk), junk
    end
  end

  def test_ranges_prefixes_of_any_length_both_families_and_host_bits_past_the_length_ignored
    list = ["20.171.206.0/24", "34.162.230.222/32", "10.1.2.3/8", "2600:1f28:365:8000::/56", "0.0.0.0/0"]
    assert AgentCheck.in_ranges?("20.171.206.255", list[0, 1])
    refute AgentCheck.in_ranges?("20.171.207.0", list[0, 1])
    assert AgentCheck.in_ranges?("34.162.230.222", list[1, 1])
    refute AgentCheck.in_ranges?("34.162.230.223", list[1, 1])
    assert AgentCheck.in_ranges?("10.200.0.1", list[2, 1]), "10.1.2.3/8 covers all of 10/8"
    assert AgentCheck.in_ranges?("2600:1f28:365:80ff:ffff::1", list[3, 1])
    refute AgentCheck.in_ranges?("2600:1f28:365:8100::1", list[3, 1])
    refute AgentCheck.in_ranges?("20.171.206.1", list[3, 1]), "an IPv4 address is never in an IPv6 prefix"
    assert AgentCheck.in_ranges?("203.0.113.9", list[4..]), "/0 covers every IPv4 address"
    refute AgentCheck.in_ranges?("not an address", list)
  end

  def test_published_lists_the_shape_every_company_uses_and_anything_else_refused_whole
    assert_equal ["20.171.206.0/24", "2600:1f28::/56"],
                 AgentCheck.read_range_list({ "creationTime" => "x", "prefixes" => [{ "ipv4Prefix" => "20.171.206.0/24" }, { "ipv6Prefix" => " 2600:1f28::/56 " }] })
    [nil, [], "x", {}, { "prefixes" => [] }, { "prefixes" => "1.2.3.0/24" }, { "prefixes" => [{ "ipv4Prefix" => "1.2.3.0" }] },
     { "prefixes" => [{ "ipv4Prefix" => "1.2.3.0/33" }] }, { "prefixes" => [{ "ipv4Prefix" => "2600::/56" }] },
     { "prefixes" => [{ "ipv6Prefix" => "1.2.3.0/24" }] }, { "prefixes" => [{ "ipv4Prefix" => "1.2.3.0/24" }, { "other" => "x" }] }].each do |bad|
      assert_nil AgentCheck.read_range_list(bad), Runlight::Json.encode(bad)
    end
    assert_nil AgentCheck.read_range_list({ "prefixes" => Array.new(20_001) { { "ipv4Prefix" => "1.2.3.0/24" } } })
  end

  def test_an_agent_checks_out_does_not_or_has_nothing_to_check_against
    gptbot = AGENTS.find { |a| a["name"] == "GPTBot" }
    meta = AGENTS.find { |a| a["name"] == "meta-externalagent" }
    lists = AgentCheck.bundled["lists"]
    assert_equal "verified", AgentCheck.check_agent(gptbot, "20.171.206.17", lists)
    assert_equal "mismatch", AgentCheck.check_agent(gptbot, "198.51.100.23", lists)
    assert_equal "", AgentCheck.check_agent(gptbot, "", lists), "no address"
    assert_equal "", AgentCheck.check_agent(gptbot, "garbage", lists)
    assert_equal "", AgentCheck.check_agent(meta, "157.240.0.1", lists), "Meta publishes no list"
    assert_equal "", AgentCheck.check_agent(gptbot, "20.171.206.17", {}), "a list that is missing is nothing to check against"
    claude = AGENTS.find { |a| a["name"] == "ClaudeBot" }
    ccbot = AGENTS.find { |a| a["name"] == "CCBot" }
    assert_equal "verified", AgentCheck.check_agent(claude, "216.73.216.10", lists)
    assert_equal "verified", AgentCheck.check_agent(ccbot, "2600:1f28:365:8000::5", lists)
  end

  def test_every_agent_with_a_list_has_it_bundled_and_every_bundled_list_is_read_whole
    AGENTS.each do |agent|
      next if agent["ranges"].nil?

      refute_empty AgentCheck.bundled["lists"][agent["ranges"]].to_a, "#{agent["name"]}: #{agent["ranges"]}"
    end
    without = AGENTS.select { |a| a["ranges"].nil? }.map { |a| a["company"] }.uniq
    assert_equal ["Meta", "Amazon", "ByteDance", "Cohere", "You.com", "Diffbot", "Timpi"], without
    AgentCheck.bundled["lists"].each do |url, list|
      again = AgentCheck.read_range_list({ "prefixes" => list.map { |p| p.include?(":") ? { "ipv6Prefix" => p } : { "ipv4Prefix" => p } } })
      assert_equal list, again, url
    end
  end

  def test_a_download_is_read_whole_or_not_at_all
    url = "https://openai.com/gptbot.json"
    good = FakeFetcher.new { |_u, _i| Runlight::Http::Response.json({ "prefixes" => [{ "ipv4Prefix" => "192.0.2.0/24" }] }) }
    assert_equal ["192.0.2.0/24"], AgentCheck.download_range_list(url, good)
    assert_equal "application/json", good.requests[0]["headers"]["accept"]
    [
      ->(_u, _i) { Runlight::Http::Response.new("Not found", status: 404) },
      ->(_u, _i) { Runlight::Http::Response.new("<html>", status: 200) },
      ->(_u, _i) { Runlight::Http::Response.new("{}", status: 200, headers: { "content-length" => "4000001" }) },
      ->(_u, _i) { Runlight::Http::Response.new("x" * 4_000_001, status: 200) },
      ->(_u, _i) { raise Runlight::Http::BodyTooLong, "Body over 4000000 bytes" },
      ->(_u, _i) { raise Runlight::Http::FetchError, "fetch failed" },
    ].each_with_index do |answer, i|
      assert_nil AgentCheck.download_range_list(url, FakeFetcher.new(&answer)), "answer #{i}"
    end
  end
end

"""The port of the TypeScript SDK's agentcheck.test.ts: reading addresses and prefixes, the published lists, and
the check an AI agent's fetch gets."""

from __future__ import annotations

from runlight import assets
from runlight.agentcheck import check_agent, in_ranges, parse_address, read_range_list
from runlight.data.agents import AI_AGENTS


def test_addresses_ipv4_ipv6_ipv4_written_as_ipv6_brackets_and_zones_and_junk() -> None:
    assert parse_address("20.171.206.17") == (4, 0x14ABCE11)
    assert parse_address(" ::ffff:20.171.206.17 ") == (4, 0x14ABCE11)
    assert parse_address("::ffff:14ab:ce11") == (4, 0x14ABCE11)
    assert parse_address("[2600:1f28:365:8000::1]") == (6, 0x26001F2803658000 << 64 | 1)
    assert parse_address("fe80::1%eth0") == (6, 0xFE80 << 112 | 1)
    assert parse_address("::") == (6, 0)
    for junk in ["", "unknown", "256.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4x", "1::2::3", "12345::", ":1::", "1:2:3:4:5:6:7:8:9", "::ffff:1.2.3.256", "-"]:
        assert parse_address(junk) is None, junk


def test_ranges_prefixes_of_any_length_both_families_and_host_bits_past_the_length_ignored() -> None:
    ranges = ["20.171.206.0/24", "34.162.230.222/32", "10.1.2.3/8", "2600:1f28:365:8000::/56", "0.0.0.0/0"]
    assert in_ranges("20.171.206.255", ranges[0:1])
    assert not in_ranges("20.171.207.0", ranges[0:1])
    assert in_ranges("34.162.230.222", ranges[1:2])
    assert not in_ranges("34.162.230.223", ranges[1:2])
    assert in_ranges("10.200.0.1", ranges[2:3]), "10.1.2.3/8 covers all of 10/8"
    assert in_ranges("2600:1f28:365:80ff:ffff::1", ranges[3:4])
    assert not in_ranges("2600:1f28:365:8100::1", ranges[3:4])
    assert not in_ranges("20.171.206.1", ranges[3:4]), "an IPv4 address is never in an IPv6 prefix"
    assert in_ranges("203.0.113.9", ranges[4:]), "/0 covers every IPv4 address"
    assert not in_ranges("not an address", ranges)


def test_published_lists_the_shape_every_company_uses_and_anything_else_refused_whole() -> None:
    assert read_range_list({"creationTime": "x", "prefixes": [{"ipv4Prefix": "20.171.206.0/24"}, {"ipv6Prefix": " 2600:1f28::/56 "}]}) == ["20.171.206.0/24", "2600:1f28::/56"]
    bad = [
        None, [], "x", {}, {"prefixes": []}, {"prefixes": "1.2.3.0/24"}, {"prefixes": [{"ipv4Prefix": "1.2.3.0"}]},
        {"prefixes": [{"ipv4Prefix": "1.2.3.0/33"}]}, {"prefixes": [{"ipv4Prefix": "2600::/56"}]}, {"prefixes": [{"ipv6Prefix": "1.2.3.0/24"}]},
        {"prefixes": [{"ipv4Prefix": "1.2.3.0/24"}, {"other": "x"}]},
    ]  # fmt: skip
    for body in bad:
        assert read_range_list(body) is None, body
    assert read_range_list({"prefixes": [{"ipv4Prefix": "1.2.3.0/24"}] * 20_001}) is None


def test_an_agent_checks_out_does_not_or_has_nothing_to_check_against() -> None:
    gptbot = next(a for a in AI_AGENTS if a["name"] == "GPTBot")
    meta = next(a for a in AI_AGENTS if a["name"] == "meta-externalagent")
    lists = assets.AGENT_RANGES["lists"]
    assert check_agent(gptbot, "20.171.206.17", lists) == "verified"
    assert check_agent(gptbot, "198.51.100.23", lists) == "mismatch"
    assert check_agent(gptbot, "", lists) == "", "no address"
    assert check_agent(gptbot, "garbage", lists) == ""
    assert check_agent(meta, "157.240.0.1", lists) == "", "Meta publishes no list"
    assert check_agent(gptbot, "20.171.206.17", {}) == "", "a list that is missing is nothing to check against"


def test_every_agent_with_a_list_has_it_bundled_and_every_bundled_list_is_read_whole() -> None:
    lists = assets.AGENT_RANGES["lists"]
    for agent in AI_AGENTS:
        if agent.get("ranges"):
            assert lists.get(agent["ranges"]), f"{agent['name']}: {agent['ranges']}"
    for url, prefixes in lists.items():
        again = read_range_list({"prefixes": [{"ipv6Prefix": p} if ":" in p else {"ipv4Prefix": p} for p in prefixes]})
        assert again == prefixes, url


def test_the_agents_without_a_list_are_the_ones_typescript_leaves_without() -> None:
    assert sorted(a["name"] for a in AI_AGENTS if not a.get("ranges")) == sorted(
        ["meta-externalfetcher", "meta-externalagent", "Amazonbot", "Bytespider", "cohere-ai", "YouBot", "Diffbot", "Timpibot"]
    )

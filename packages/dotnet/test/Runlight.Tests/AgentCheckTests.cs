using System;
using System.Collections.Generic;
using System.Linq;
using Runlight.Data;
using Xunit;

namespace Runlight.Tests;

/// <summary>The AI agent address check, as agentcheck.test.ts tests it.</summary>
public sealed class AgentCheckTests
{
    private static AgentCheck.Address V4(uint n) => new(4, n);

    private static AgentCheck.Address V6(UInt128 n) => new(6, n);

    [Fact]
    public void Addresses_IPv4_IPv6_IPv4_written_as_IPv6_brackets_and_zones_and_junk()
    {
        Assert.Equal(V4(0x14abce11), AgentCheck.ParseAddress("20.171.206.17"));
        Assert.Equal(V4(0x14abce11), AgentCheck.ParseAddress(" ::ffff:20.171.206.17 "));
        Assert.Equal(V4(0x14abce11), AgentCheck.ParseAddress("::ffff:14ab:ce11"));
        Assert.Equal(V6(((UInt128)0x26001f2803658000ul << 64) | 1), AgentCheck.ParseAddress("[2600:1f28:365:8000::1]"));
        Assert.Equal(V6(((UInt128)0xfe80u << 112) | 1), AgentCheck.ParseAddress("fe80::1%eth0"));
        Assert.Equal(V6(UInt128.Zero), AgentCheck.ParseAddress("::"));
        foreach (string junk in new[] { "", "unknown", "256.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4x", "1::2::3", "12345::", ":1::", "1:2:3:4:5:6:7:8:9", "::ffff:1.2.3.256", "-" })
        {
            Assert.True(AgentCheck.ParseAddress(junk) == null, junk);
        }
    }

    [Fact]
    public void Ranges_prefixes_of_any_length_both_families_and_host_bits_past_the_length_ignored()
    {
        string[] list = ["20.171.206.0/24", "34.162.230.222/32", "10.1.2.3/8", "2600:1f28:365:8000::/56", "0.0.0.0/0"];
        IReadOnlyList<string> Only(int i) => [list[i]];
        Assert.True(AgentCheck.InRanges("20.171.206.255", Only(0)));
        Assert.False(AgentCheck.InRanges("20.171.207.0", Only(0)));
        Assert.True(AgentCheck.InRanges("34.162.230.222", Only(1)));
        Assert.False(AgentCheck.InRanges("34.162.230.223", Only(1)));
        Assert.True(AgentCheck.InRanges("10.200.0.1", Only(2)), "10.1.2.3/8 covers all of 10/8");
        Assert.True(AgentCheck.InRanges("2600:1f28:365:80ff:ffff::1", Only(3)));
        Assert.False(AgentCheck.InRanges("2600:1f28:365:8100::1", Only(3)));
        Assert.False(AgentCheck.InRanges("20.171.206.1", Only(3)), "an IPv4 address is never in an IPv6 prefix");
        Assert.True(AgentCheck.InRanges("203.0.113.9", Only(4)), "/0 covers every IPv4 address");
        Assert.False(AgentCheck.InRanges("2600::1", Only(4)), "nor is an IPv6 address in an IPv4 prefix");
        Assert.True(AgentCheck.InRanges("2001:db8::1", ["::/0"]), "::/0 covers every IPv6 address");
        Assert.False(AgentCheck.InRanges("not an address", list));
    }

    [Fact]
    public void Published_lists_the_shape_every_company_uses_and_anything_else_refused_whole()
    {
        Assert.Equal(
            ["20.171.206.0/24", "2600:1f28::/56"],
            AgentCheck.ReadRangeList(Json.Parse("{\"creationTime\":\"x\",\"prefixes\":[{\"ipv4Prefix\":\"20.171.206.0/24\"},{\"ipv6Prefix\":\" 2600:1f28::/56 \"}]}"))!);
        string[] bad =
        [
            "null", "[]", "\"x\"", "{}", "{\"prefixes\":[]}", "{\"prefixes\":\"1.2.3.0/24\"}", "{\"prefixes\":[{\"ipv4Prefix\":\"1.2.3.0\"}]}",
            "{\"prefixes\":[{\"ipv4Prefix\":\"1.2.3.0/33\"}]}", "{\"prefixes\":[{\"ipv4Prefix\":\"2600::/56\"}]}", "{\"prefixes\":[{\"ipv6Prefix\":\"1.2.3.0/24\"}]}",
            "{\"prefixes\":[{\"ipv4Prefix\":\"1.2.3.0/24\"},{\"other\":\"x\"}]}",
        ];
        foreach (string json in bad)
        {
            Assert.True(AgentCheck.ReadRangeList(Json.Parse(json)) == null, json);
        }
        var many = new JsObject { ["prefixes"] = Enumerable.Range(0, 20_001).Select(_ => (object?)new JsObject { ["ipv4Prefix"] = "1.2.3.0/24" }).ToList() };
        Assert.Null(AgentCheck.ReadRangeList(many));
    }

    [Fact]
    public void An_agent_checks_out_does_not_or_has_nothing_to_check_against()
    {
        var gptbot = Lists.AiAgents.First(a => a.Str("name") == "GPTBot");
        var meta = Lists.AiAgents.First(a => a.Str("name") == "meta-externalagent");
        var lists = AgentCheck.Bundled;
        Assert.Equal("verified", AgentCheck.Check(gptbot, "20.171.206.17", lists));
        Assert.Equal("mismatch", AgentCheck.Check(gptbot, "198.51.100.23", lists));
        Assert.Equal("", AgentCheck.Check(gptbot, "", lists)); // no address
        Assert.Equal("", AgentCheck.Check(gptbot, "garbage", lists));
        Assert.Equal("", AgentCheck.Check(meta, "157.240.0.1", lists)); // Meta publishes no list
        Assert.Equal("", AgentCheck.Check(gptbot, "20.171.206.17", new Dictionary<string, IReadOnlyList<string>>())); // a list that is missing is nothing to check against
        var claudebot = Lists.AiAgents.First(a => a.Str("name") == "ClaudeBot");
        var ccbot = Lists.AiAgents.First(a => a.Str("name") == "CCBot");
        Assert.Equal("verified", AgentCheck.Check(claudebot, "216.73.216.10", lists));
        Assert.Equal("verified", AgentCheck.Check(ccbot, "2600:1f28:365:8000::5", lists));
    }

    [Fact]
    public void Every_agent_with_a_list_has_it_bundled_and_every_bundled_list_is_read_whole()
    {
        foreach (var agent in Lists.AiAgents)
        {
            if (agent.Str("ranges") is { } url)
            {
                Assert.True(AgentCheck.Bundled.TryGetValue(url, out var list) && list.Count > 0, agent.Str("name") + ": " + url);
            }
        }
        foreach (string name in new[] { "meta-externalfetcher", "meta-externalagent", "Amazonbot", "Bytespider", "cohere-ai", "YouBot", "Diffbot" })
        {
            Assert.Null(Lists.AiAgents.First(a => a.Str("name") == name).Str("ranges"));
        }
        foreach (var (url, list) in AgentCheck.Bundled)
        {
            Assert.True(list.SequenceEqual(AgentCheck.ReadRangeList(AgentCheck.AsPublished(list.Cast<object?>())) ?? []), url);
        }
        Assert.Matches("^[0-9]{4}-[0-9]{2}-[0-9]{2}\\z", AgentCheck.BundledFetchedAt);
    }
}

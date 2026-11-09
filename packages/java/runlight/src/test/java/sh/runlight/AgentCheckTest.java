package sh.runlight;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import sh.runlight.data.Agents;
import sh.runlight.http.BodyTooLong;
import sh.runlight.http.FetchError;
import sh.runlight.http.Headers;
import sh.runlight.http.Response;

/** The port of agentcheck.test.ts: addresses, prefixes, published lists, and the check. */
class AgentCheckTest {
  private static AgentCheck.Address v4(long n) {
    return new AgentCheck.Address(4, BigInteger.valueOf(n));
  }

  private static AgentCheck.Address v6(String hex) {
    return new AgentCheck.Address(6, new BigInteger(hex, 16));
  }

  private static Map<String, Object> agent(String name) {
    for (Map<String, Object> agent : Agents.AI_AGENTS) {
      if (agent.get("name").equals(name)) {
        return agent;
      }
    }
    throw new AssertionError(name);
  }

  @Test
  void addressesIpv4Ipv6Ipv4WrittenAsIpv6BracketsAndZonesAndJunk() {
    assertEquals(v4(0x14abce11L), AgentCheck.parseAddress("20.171.206.17"));
    assertEquals(v4(0x14abce11L), AgentCheck.parseAddress(" ::ffff:20.171.206.17 "));
    assertEquals(v4(0x14abce11L), AgentCheck.parseAddress("::ffff:14ab:ce11"));
    assertEquals(
        v6("26001f2803658000" + "0000000000000001"),
        AgentCheck.parseAddress("[2600:1f28:365:8000::1]"));
    assertEquals(v6("fe80" + "0".repeat(27) + "1"), AgentCheck.parseAddress("fe80::1%eth0"));
    assertEquals(v6("0"), AgentCheck.parseAddress("::"));
    for (String junk :
        List.of(
            "",
            "unknown",
            "256.1.1.1",
            "1.2.3",
            "1.2.3.4.5",
            "01.2.3.4x",
            "1::2::3",
            "12345::",
            ":1::",
            "1:2:3:4:5:6:7:8:9",
            "::ffff:1.2.3.256",
            "-")) {
      assertNull(AgentCheck.parseAddress(junk), junk);
    }
    assertNull(AgentCheck.parseAddress(null));
  }

  @Test
  void rangesPrefixesOfAnyLengthBothFamiliesAndHostBitsPastTheLengthIgnored() {
    List<String> list =
        List.of(
            "20.171.206.0/24",
            "34.162.230.222/32",
            "10.1.2.3/8",
            "2600:1f28:365:8000::/56",
            "0.0.0.0/0");
    assertTrue(AgentCheck.inRanges("20.171.206.255", list.subList(0, 1)));
    assertFalse(AgentCheck.inRanges("20.171.207.0", list.subList(0, 1)));
    assertTrue(AgentCheck.inRanges("34.162.230.222", list.subList(1, 2)));
    assertFalse(AgentCheck.inRanges("34.162.230.223", list.subList(1, 2)));
    assertTrue(AgentCheck.inRanges("10.200.0.1", list.subList(2, 3)), "10.1.2.3/8 covers 10/8");
    assertTrue(AgentCheck.inRanges("2600:1f28:365:80ff:ffff::1", list.subList(3, 4)));
    assertFalse(AgentCheck.inRanges("2600:1f28:365:8100::1", list.subList(3, 4)));
    assertFalse(
        AgentCheck.inRanges("20.171.206.1", list.subList(3, 4)),
        "an IPv4 address is never in an IPv6 prefix");
    assertTrue(AgentCheck.inRanges("203.0.113.9", list.subList(4, 5)), "/0 covers all IPv4");
    assertFalse(AgentCheck.inRanges("not an address", list));
  }

  @Test
  void publishedListsTheShapeEveryCompanyUsesAndAnythingElseRefusedWhole() {
    assertEquals(
        List.of("20.171.206.0/24", "2600:1f28::/56"),
        AgentCheck.readRangeList(
            Json.parse(
                "{\"creationTime\":\"x\",\"prefixes\":[{\"ipv4Prefix\":\"20.171.206.0/24\"},"
                    + "{\"ipv6Prefix\":\" 2600:1f28::/56 \"}]}")));
    for (String bad :
        List.of(
            "null",
            "[]",
            "\"x\"",
            "{}",
            "{\"prefixes\":[]}",
            "{\"prefixes\":\"1.2.3.0/24\"}",
            "{\"prefixes\":[{\"ipv4Prefix\":\"1.2.3.0\"}]}",
            "{\"prefixes\":[{\"ipv4Prefix\":\"1.2.3.0/33\"}]}",
            "{\"prefixes\":[{\"ipv4Prefix\":\"2600::/56\"}]}",
            "{\"prefixes\":[{\"ipv6Prefix\":\"1.2.3.0/24\"}]}",
            "{\"prefixes\":[{\"ipv4Prefix\":\"1.2.3.0/24\"},{\"other\":\"x\"}]}")) {
      assertNull(AgentCheck.readRangeList(Json.parse(bad)), bad);
    }
    List<Object> many = new ArrayList<>();
    for (int i = 0; i < 20_001; i++) {
      many.add(Json.object("ipv4Prefix", "1.2.3.0/24"));
    }
    assertNull(AgentCheck.readRangeList(Json.object("prefixes", many)));
  }

  @Test
  void aDownloadIsReadOnlyWhenItIsAListAndNeverThrows() {
    String body = "{\"prefixes\":[{\"ipv4Prefix\":\"192.0.2.0/24\"}]}";
    RecordingFetcher fetcher = new RecordingFetcher(new Response(body, 200));
    assertEquals(
        List.of("192.0.2.0/24"),
        AgentCheck.downloadRangeList(fetcher, "https://openai.com/gptbot.json"));
    assertEquals("application/json", fetcher.inits.get(0).headers.get("accept"));
    assertEquals("follow", fetcher.inits.get(0).redirect);
    assertNull(AgentCheck.downloadRangeList(new RecordingFetcher(new Response(body, 404)), "u"));
    assertNull(
        AgentCheck.downloadRangeList(
            new RecordingFetcher(new Response(body, 200, Headers.of("content-length", "4000001"))),
            "u"));
    assertNull(
        AgentCheck.downloadRangeList(new RecordingFetcher(new Response("<html>", 200)), "u"));
    assertNull(AgentCheck.downloadRangeList(new RecordingFetcher("timeout"), "u"));
    assertNull(
        AgentCheck.downloadRangeList(
            (url, init) -> {
              throw new BodyTooLong("too long");
            },
            "u"));
    assertNull(
        AgentCheck.downloadRangeList(
            (url, init) -> {
              throw new FetchError("refused");
            },
            "u"));
  }

  @Test
  void anAgentChecksOutDoesNotOrHasNothingToCheckAgainst() {
    Map<String, Object> gptbot = agent("GPTBot");
    Map<String, Object> meta = agent("meta-externalagent");
    Map<String, List<String>> lists = AgentCheck.bundled();
    assertEquals("verified", AgentCheck.checkAgent(gptbot, "20.171.206.17", lists));
    assertEquals("mismatch", AgentCheck.checkAgent(gptbot, "198.51.100.23", lists));
    assertEquals("", AgentCheck.checkAgent(gptbot, "", lists), "no address");
    assertEquals("", AgentCheck.checkAgent(gptbot, "garbage", lists));
    assertEquals("", AgentCheck.checkAgent(meta, "157.240.0.1", lists), "Meta has no list");
    assertEquals(
        "", AgentCheck.checkAgent(gptbot, "20.171.206.17", Map.of()), "a missing list is nothing");
    assertEquals("verified", AgentCheck.checkAgent(agent("ClaudeBot"), "216.73.216.10", lists));
    assertEquals("verified", AgentCheck.checkAgent(agent("CCBot"), "2600:1f28:365:8000::5", lists));
  }

  @Test
  void everyAgentWithAListHasItBundledAndEveryBundledListIsReadWhole() {
    Map<String, List<String>> lists = AgentCheck.bundled();
    for (Map<String, Object> agent : Agents.AI_AGENTS) {
      if (agent.get("ranges") instanceof String url) {
        assertNotNull(lists.get(url), agent.get("name") + ": " + url);
        assertFalse(lists.get(url).isEmpty(), agent.get("name") + ": " + url);
      }
    }
    for (Map.Entry<String, List<String>> entry : lists.entrySet()) {
      assertEquals(
          entry.getValue(),
          AgentCheck.readPrefixes(new ArrayList<Object>(entry.getValue())),
          entry.getKey());
    }
    List<String> without = new ArrayList<>();
    for (Map<String, Object> agent : Agents.AI_AGENTS) {
      if (!agent.containsKey("ranges")) {
        without.add((String) agent.get("company"));
      }
    }
    assertEquals(
        List.of("Meta", "Meta", "Amazon", "ByteDance", "Cohere", "You.com", "Diffbot", "Timpi"),
        without);
  }
}

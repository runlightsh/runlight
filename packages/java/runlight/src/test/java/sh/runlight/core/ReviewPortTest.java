package sh.runlight.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import sh.runlight.Json;
import sh.runlight.Runlight;
import sh.runlight.Ua;
import sh.runlight.http.Headers;
import sh.runlight.http.Request;
import sh.runlight.http.Response;

/**
 * Behaviour brought over from the TypeScript review that the shared fixtures do not replay: limits
 * on link clicks and AI agent fetches, salts, the host and user agent of a fetch, agent lists, and
 * forwarded addresses.
 */
class ReviewPortTest {
  private static final String GPTBOT =
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";

  private static Harness harness(Runlight.Options options) {
    Harness t =
        new Harness(
            "sqlite",
            options.site(Json.object("hostnames", List.of("example.com"), "timezone", "UTC")));
    t.rl.init();
    return t;
  }

  private static long count(Harness t, String kind) {
    return (long)
        t.store()
            .db()
            .all("SELECT COUNT(*) AS n FROM rl_events WHERE kind = ?", List.of(kind))
            .get(0)
            .get("n");
  }

  private static List<String> column(Harness t, String column, String kind) {
    List<String> out = new ArrayList<>();
    for (Map<String, Object> row :
        t.store()
            .db()
            .all(
                "SELECT " + column + " AS v FROM rl_events WHERE kind = ? ORDER BY id",
                List.of(kind))) {
      out.add((String) row.get("v"));
    }
    return out;
  }

  @Test
  void aLinkClickedPastTheTrackersLimitStillRedirectsAndIsNotCounted() {
    Harness t = harness(new Runlight.Options().rateLimit(2L));
    String site = (String) t.rl.sites().get(0).get("id");
    t.rl.links.create(site, Json.object("url", "https://example.com/pricing", "slug", "p"));
    Request click =
        new Request(
            "https://example.com/go/p",
            "GET",
            Headers.of(
                "host",
                "example.com",
                "user-agent",
                Harness.CHROME_MAC,
                "x-forwarded-for",
                "203.0.113.9"),
            "");
    for (int i = 0; i < 4; i++) {
      Response answer = t.rl.linkHandler().apply(click);
      assertEquals(302, answer.status());
      assertEquals("https://example.com/pricing", answer.headers().get("location"));
    }
    assertEquals(2, count(t, "click"), "two counted, the rest only redirected");
    // An address nobody knows is not limited.
    Request unknown =
        new Request(
            "https://example.com/go/p",
            "GET",
            Headers.of("host", "example.com", "user-agent", Harness.CHROME_MAC),
            "");
    for (int i = 0; i < 3; i++) {
      assertEquals(302, t.rl.linkHandler().apply(unknown).status());
    }
    assertEquals(5, count(t, "click"));
  }

  private static Request fetch(String address) {
    return new Request(
        "https://example.com/post",
        "GET",
        Headers.of("host", "example.com", "user-agent", GPTBOT, "x-forwarded-for", address),
        "");
  }

  @Test
  void aiAgentFetchesSeenLiveAreLimitedToTenTimesTheTrackersLimitAnAddress() {
    Harness t = harness(new Runlight.Options().rateLimit(1L));
    int kept = 0;
    for (int i = 0; i < 14; i++) {
      kept += t.rl.observe(fetch("20.171.206.17")) ? 1 : 0;
    }
    assertEquals(10, kept);
    assertEquals(10, count(t, "fetch"));
    assertTrue(t.rl.observe(fetch("20.171.206.18")), "another address has its own count");
    // A log reader's report names the agent's address, even as none, and is never limited.
    for (int i = 0; i < 12; i++) {
      assertTrue(t.rl.observe(fetch("20.171.206.17"), null, Map.of("agentIp", "")));
    }
    assertEquals(23, count(t, "fetch"));
    // With no limit on hits there is none on fetches.
    Harness open = harness(new Runlight.Options().rateLimit(false));
    for (int i = 0; i < 30; i++) {
      assertTrue(open.rl.observe(fetch("20.171.206.17")));
    }
  }

  @Test
  void aNewerDaysSaltIsNeverDeleted() {
    Harness t = harness(new Runlight.Options());
    for (String day : List.of("2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08")) {
      t.store().salt(day, "salt-" + day);
    }
    // A process whose clock is a moment behind keeps the 6th and 7th; the 8th is not its to drop.
    t.store().dropSaltsExcept(List.of("2026-10-07", "2026-10-06"));
    assertNull(t.store().saltIfExists("2026-10-05"));
    assertEquals("salt-2026-10-06", t.store().saltIfExists("2026-10-06"));
    assertEquals("salt-2026-10-07", t.store().saltIfExists("2026-10-07"));
    assertEquals("salt-2026-10-08", t.store().saltIfExists("2026-10-08"));
  }

  @Test
  void aFetchIsFiledUnderTheHostAProxyNamesOnlyWhereProxiesAreBelieved() {
    Harness t = harness(new Runlight.Options());
    Request proxied =
        new Request(
            "http://10.0.0.5:8080/post",
            "GET",
            Headers.of(
                "host",
                "10.0.0.5:8080",
                "user-agent",
                GPTBOT,
                "x-forwarded-host",
                "www.example.com:443, cdn.example.net"),
            new byte[0],
            "10.0.0.2");
    assertTrue(t.rl.observe(proxied));
    assertEquals(List.of("example.com"), column(t, "hostname", "fetch"));
    // Straight from the internet the header is the client's to write, so it names nothing.
    Request direct = proxied.withRemoteAddress("8.8.8.8");
    assertFalse(t.rl.observe(direct), "10.0.0.5 is no site's host");
    assertEquals(1, count(t, "fetch"));
  }

  @Test
  void aLoggedUserAgentIsGivenAsTextSoOneNoHeaderCouldHoldStillRecords() {
    Harness t = harness(new Runlight.Options());
    Request page =
        new Request("https://example.com/post", "GET", Headers.of("host", "example.com"), "");
    assertFalse(t.rl.observe(page), "no user agent, no agent");
    assertTrue(
        t.rl.observe(page, null, Map.of("agentIp", "", "userAgent", GPTBOT + "\n你好 injected")));
    assertEquals(List.of("GPTBot"), column(t, "name", "fetch"));
    // The text given stands in for the header, not beside it.
    Request browser =
        new Request(
            "https://example.com/post",
            "GET",
            Headers.of("host", "example.com", "user-agent", GPTBOT),
            "");
    assertFalse(
        t.rl.observe(browser, null, Map.of("agentIp", "", "userAgent", Harness.CHROME_MAC)));
  }

  @Test
  void aDownloadedAgentListStandsOnlyWhileItIsNewerThanTheOneThatShipped() {
    Harness t = harness(new Runlight.Options());
    String list = (String) Ua.aiAgent(GPTBOT).get("ranges");
    Runnable seen =
        () ->
            t.rl.observe(
                new Request(
                    "https://example.com/post",
                    "GET",
                    Headers.of("host", "example.com", "user-agent", GPTBOT),
                    ""),
                null,
                Map.of("agentIp", "198.51.100.23"));
    long shipped = sh.runlight.AgentCheck.bundledAt();
    assertTrue(shipped > 0);
    // Saved before this version's list was fetched, with only a time for them all.
    t.store()
        .setSetting(
            "agent-ranges",
            Json.stringify(
                Json.object(
                    "at", shipped - 1, "lists", Json.object(list, Json.array("198.51.100.0/24")))));
    t.rl.check();
    seen.run();
    // Downloaded since, each list with its own time.
    t.store()
        .setSetting(
            "agent-ranges",
            Json.stringify(
                Json.object(
                    "at",
                    shipped - 1,
                    "lists",
                    Json.object(list, Json.array("198.51.100.0/24")),
                    "fetched",
                    Json.object(list, shipped + 1))));
    t.rl.check();
    seen.run();
    assertEquals(List.of("mismatch", "verified"), column(t, "title", "fetch"));
  }

  @Test
  void aForwardedAddressLosesItsPortAndItsBrackets() {
    Harness t = harness(new Runlight.Options().trustProxy(true));
    Map<String, String> cases =
        Map.of(
            "203.0.113.7:51234", "203.0.113.7",
            "[2001:db8::1]:443", "2001:db8::1",
            "[2001:db8::1]", "2001:db8::1",
            "2001:db8::1", "2001:db8::1",
            "203.0.113.7", "203.0.113.7",
            "[2001:db8::1]x", "[2001:db8::1]x");
    for (Map.Entry<String, String> c : cases.entrySet()) {
      Request request =
          new Request(
              "https://example.com/",
              "GET",
              Headers.of("x-forwarded-for", "1.1.1.1, " + c.getKey()),
              "");
      assertEquals(c.getValue(), t.rl.clientIp(request), c.getKey());
    }
  }

  @Test
  void collectNeverThrowsToItsCaller() {
    WatchedDb watched = new WatchedDb(sh.runlight.store.Databases.fresh("sqlite").db());
    Harness t =
        new Harness(
            new sh.runlight.store.SqlStore(watched),
            new Runlight.Options()
                .site(Json.object("hostnames", List.of("example.com"), "timezone", "UTC")));
    t.rl.init();
    watched.before =
        sql -> {
          throw new IllegalStateException("the disk is full");
        };
    t.send(Json.object("k", "pageview", "u", "https://example.com/"));
    watched.before = null;
    assertEquals(0, count(t, "pageview"));
  }
}

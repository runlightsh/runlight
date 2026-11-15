package sh.runlight.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import sh.runlight.Json;
import sh.runlight.Runlight;
import sh.runlight.accounts.Throttle;
import sh.runlight.http.Headers;
import sh.runlight.http.Request;
import sh.runlight.http.Response;
import sh.runlight.store.Databases;
import sh.runlight.store.SqlStore;

/**
 * What middleware on every request of an app must never do: take the app's own pages down with the
 * analytics database. And what an app that never runs the scheduled check must still not keep.
 */
class OutageTest {
  private static Request on(String host, String path) {
    return new Request("https://" + host + path, "GET", Headers.of("host", host), "");
  }

  @Test
  void aDatabaseThatIsDownMakesNoRequestALinkDomainsAndIsLeftAloneForAFewSeconds() {
    WatchedDb watched = new WatchedDb(Databases.fresh("sqlite").db());
    Harness t =
        new Harness(
            new SqlStore(watched),
            new Runlight.Options()
                .site(Json.object("hostnames", List.of("example.com"), "timezone", "UTC")));
    t.rl.init();
    String site = (String) t.rl.sites().get(0).get("id");
    t.store().addLinkDomain("go.example.com", site, t.now);
    t.rl.links.create(
        site,
        Json.object("url", "https://example.com/pricing", "slug", "p", "domain", "go.example.com"));
    Response found = t.rl.linkDomainResponse(on("go.example.com", "/p"));
    assertNotNull(found);
    assertEquals(302, found.status());

    // Past the half minute the domains are remembered for, with the database gone.
    t.advance(31_000);
    AtomicInteger asked = new AtomicInteger();
    watched.before =
        sql -> {
          asked.incrementAndGet();
          throw new IllegalStateException("connect ECONNREFUSED 127.0.0.1:5432");
        };
    // The domains last read stand, so the app's own pages are still told apart and passed on.
    assertNull(t.rl.linkDomainResponse(on("example.com", "/pricing")), "passed on to the app");
    assertNull(t.rl.linkDomainResponse(on("example.com", "/")));
    assertEquals(1, asked.get(), "asked once, and not again by the next request");
    t.advance(4_000);
    assertNull(t.rl.linkDomainResponse(on("example.com", "/pricing")));
    assertEquals(1, asked.get(), "nor for a few seconds");
    t.advance(2_000);
    assertNull(t.rl.linkDomainResponse(on("example.com", "/pricing")));
    assertEquals(2, asked.get(), "then asked again");

    // Back up: the link domain answers again.
    watched.before = null;
    Response back = t.rl.linkDomainResponse(on("go.example.com", "/p"));
    assertNotNull(back);
    assertEquals(302, back.status());

    // A server that never read them has none to stand, and passes everything on.
    WatchedDb down = new WatchedDb(Databases.fresh("sqlite").db());
    Harness cold =
        new Harness(
            new SqlStore(down),
            new Runlight.Options()
                .site(Json.object("hostnames", List.of("example.com"), "timezone", "UTC")));
    down.before =
        sql -> {
          throw new IllegalStateException("connect ECONNREFUSED 127.0.0.1:5432");
        };
    assertNull(cold.rl.linkDomainResponse(on("go.example.com", "/p")));
    assertNull(cold.rl.linkDomainResponse(on("example.com", "/")));
  }

  private static List<String> keys(SqlStore store, String prefix) {
    List<String> out = new ArrayList<>();
    for (Map<String, Object> setting : store.settingsStartingWith(prefix)) {
      out.add((String) setting.get("key"));
    }
    return out;
  }

  @Test
  void signInCountsMadeFromAnAddressGoWithTheFirstVisitOfALaterDayWithoutAnyScheduledCheck() {
    Harness t =
        new Harness(
            "sqlite",
            new Runlight.Options()
                .site(Json.object("hostnames", List.of("example.com"), "timezone", "UTC")));
    t.rl.init();
    assertTrue(new Throttle(t.store(), "ip", 30).take("203.0.113.7", t.now));
    assertTrue(new Throttle(t.store(), "address", 10).take("jon@example.com\n203.0.113.7", t.now));
    assertEquals(2, keys(t.store(), "throttle:").size());
    assertEquals(1, keys(t.store(), "throttle-key:").size());

    // Nobody signs in again and check() is never called; visits alone carry the days on.
    Runnable visit =
        () ->
            t.send(
                Json.object("k", "pageview", "u", "https://example.com/"),
                Json.object("ip", "198.51.100.4"));
    t.advance(Harness.DAY);
    visit.run();
    assertEquals(List.of(), keys(t.store(), "throttle:"), "the counts whose window ended");
    t.advance(Harness.DAY);
    visit.run();
    assertEquals(List.of(), keys(t.store(), "throttle-key:"), "and the key they were made with");
  }
}

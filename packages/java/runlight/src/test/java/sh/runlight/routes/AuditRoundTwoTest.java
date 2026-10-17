package sh.runlight.routes;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static sh.runlight.core.Harness.DAY;
import static sh.runlight.routes.Make.body;
import static sh.runlight.routes.Make.owner;
import static sh.runlight.routes.Make.req;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import sh.runlight.Env;
import sh.runlight.Json;
import sh.runlight.OAuth;
import sh.runlight.Routes;
import sh.runlight.Runlight;
import sh.runlight.core.Harness;
import sh.runlight.http.Response;
import sh.runlight.store.Databases;

/** The route-level checks of the 2026-10-16 audit: hostname suggestions, paging, journeys, keys. */
class AuditRoundTwoTest {
  static List<String> kinds() {
    return Databases.kinds();
  }

  @BeforeEach
  void setUp() {
    Make.clearEnv();
  }

  @AfterEach
  void tearDown() {
    Env.reset();
    Databases.cleanup();
  }

  private static Map<String, Object> view(String site, String kind, String url, String id) {
    return Json.object("s", site, "k", kind, "u", url, "i", id);
  }

  private static Routes routes(Harness t) {
    return t.rl.routes(new Routes.Options().token("secret"));
  }

  private static List<Object> hostnames(Response response) {
    return Make.column(body(response).get("rows"), "value");
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void hostnameSuggestionsRespectVisitsFiltersDatesAndSites(String kind) {
    Harness t =
        new Harness(
            kind,
            new Runlight.Options()
                .sites(
                    List.of(
                        Json.object(
                            "id",
                            "a",
                            "hostnames",
                            List.of(
                                "a.example.com",
                                "b.example.com",
                                "old.example.com",
                                "event.example.com")),
                        Json.object("id", "other", "hostnames", List.of("private.example.com")))));
    t.send(view("a", "pageview", "https://old.example.com/", "old"));
    t.advance(DAY);
    t.send(view("a", "pageview", "https://b.example.com/pricing", "b"));
    t.send(view("a", "pageview", "https://a.example.com/", "a"), Json.object("ip", "203.0.113.2"));
    t.send(view("a", "pageview", "https://a.example.com/", "a2"), Json.object("ip", "203.0.113.3"));
    t.send(
        Json.object("s", "a", "k", "event", "u", "https://event.example.com/", "n", "Signup"),
        Json.object("ip", "203.0.113.4"));
    t.send(view("other", "pageview", "https://private.example.com/", "private"));
    Routes routes = routes(t);
    String path = "/runlight/api/breakdown?site=a&period=today&dimension=hostname&suggestions=1";
    assertEquals(List.of("a.example.com", "b.example.com"), hostnames(routes.handle(owner(path))));
    assertEquals(List.of("a.example.com"), hostnames(routes.handle(owner(path + "&limit=1"))));
    assertEquals(
        List.of("b.example.com"),
        hostnames(
            routes.handle(
                owner(path + "&filter=" + sh.runlight.Js.encodeURIComponent("page:is:/pricing")))));
    assertEquals(
        List.of(),
        hostnames(
            routes.handle(
                owner(path + "&filter=" + sh.runlight.Js.encodeURIComponent("page:is:/missing")))));
    assertEquals(401, routes.handle(req(path)).status());
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void hostnameSuggestionsStepThroughHostnamesInTheOrderTheyAreSortedIn(String kind) {
    // A locale's own order puts blog-staging after blog, where byte order puts it before, so
    // suggestions taken one after another in byte order must compare in byte order too, or one is
    // skipped.
    Harness t =
        new Harness(
            kind,
            new Runlight.Options()
                .sites(
                    List.of(
                        Json.object(
                            "id",
                            "a",
                            "hostnames",
                            List.of(
                                "blog.example.com",
                                "blog-staging.example.com",
                                "shop.example.com")))));
    t.send(
        view("a", "pageview", "https://blog.example.com/", "a"), Json.object("ip", "203.0.113.2"));
    t.send(
        view("a", "pageview", "https://blog-staging.example.com/", "b"),
        Json.object("ip", "203.0.113.3"));
    t.send(
        view("a", "pageview", "https://shop.example.com/", "c"), Json.object("ip", "203.0.113.4"));
    assertEquals(
        List.of("blog-staging.example.com", "blog.example.com", "shop.example.com"),
        hostnames(
            routes(t)
                .handle(
                    owner(
                        "/runlight/api/breakdown?site=a&period=today&dimension=hostname&suggestions=1"))));
  }

  @Test
  void pagingTakesWholeNumbersAndAnythingElseIsTheDefault() {
    Harness t = new Harness("sqlite");
    Routes routes = routes(t);
    for (String query :
        List.of("limit=2.5", "page=1e20", "limit=-3&page=0", "limit=abc&page=2.5")) {
      assertEquals(
          200,
          routes
              .handle(owner("/runlight/api/breakdown?period=7d&dimension=page&" + query))
              .status(),
          query);
    }
    t.send(view("default", "pageview", "https://example.com/a", "a"));
    t.advance(31 * 60_000L);
    t.send(view("default", "pageview", "https://example.com/b", "b"));
    List<Object> all =
        Make.column(
            body(routes.handle(owner("/runlight/api/breakdown?period=today&dimension=page")))
                .get("rows"),
            "value");
    assertEquals(2, all.size());
    List<Object> fraction =
        Make.column(
            body(routes.handle(
                    owner("/runlight/api/breakdown?period=today&dimension=page&limit=1.5")))
                .get("rows"),
            "value");
    assertEquals(all, fraction, "a fraction is the default limit, not a rounded one");
    List<Object> second =
        Make.column(
            body(routes.handle(
                    owner("/runlight/api/breakdown?period=today&dimension=page&limit=1&page=2")))
                .get("rows"),
            "value");
    assertEquals(List.of(all.get(1)), second);
  }

  @Test
  void aJourneysStartEndAndThroughTakeAPageAsWrittenAsFiltersDo() {
    Harness t = new Harness("sqlite");
    Routes routes = routes(t);
    t.send(view("default", "pageview", "https://example.com/café", "a"));
    t.advance(30_000);
    t.send(view("default", "pageview", "https://example.com/pricing", "b"));
    for (String query :
        List.of(
            "start=" + sh.runlight.Js.encodeURIComponent("/café"),
            "start=" + sh.runlight.Js.encodeURIComponent("/caf%C3%A9"),
            "end="
                + sh.runlight.Js.encodeURIComponent("/pricing")
                + "&start="
                + sh.runlight.Js.encodeURIComponent("/café"),
            "through=" + sh.runlight.Js.encodeURIComponent("0:/café"))) {
      Map<String, Object> answer =
          body(routes.handle(owner("/runlight/api/journeys?period=today&" + query)));
      assertEquals(1L, ((Number) answer.get("visits")).longValue(), query);
    }
  }

  @Test
  void aSitesAgentsKeyIsKeptSealedAndOneKeptAsPlainTextBeforeStillWorksAndIsSealedWhenRead() {
    Runlight rl =
        Make.runlight(
            new Runlight.Options()
                .site(Json.object("hostnames", List.of("example.com")))
                .secret("s".repeat(32)));
    rl.init();
    Routes routes = rl.routes(new Routes.Options().token("owner"));
    String key = OAuth.agentsKey(rl, "default", false);
    String stored = rl.store.setting("observe-key:default");
    assertFalse(stored.contains(key), "not in the database as it is");
    java.util.function.Function<String, Response> observe =
        bearer ->
            routes.handle(
                owner(
                    "/runlight/api/observe",
                    "POST",
                    Json.object(
                        "url",
                        "https://example.com/",
                        "userAgent",
                        "Mozilla/5.0 (compatible; GPTBot/1.2)"),
                    bearer));
    assertEquals(204, observe.apply(key).status());
    // A key from before, kept as it was.
    rl.store.setSetting("observe-key:default", "rlo_legacykeylegacykey00");
    assertEquals(204, observe.apply("rlo_legacykeylegacykey00").status());
    assertEquals(
        "rlo_legacykeylegacykey00", OAuth.agentsKey(rl, "default", false), "shown as it was");
    assertFalse(rl.store.setting("observe-key:default").contains("rlo_legacy"), "and sealed now");
    assertEquals(204, observe.apply("rlo_legacykeylegacykey00").status(), "still working");
    assertEquals(401, observe.apply("rlo_wrongkeywrongkeywron").status());
    // One sealed under a secret the server no longer has is replaced, not shown.
    rl.store.setSetting(
        "observe-key:default", sh.runlight.mail.Secret.seal("rlo_gone", "another secret entirely"));
    String again = OAuth.agentsKey(rl, "default", false);
    assertTrue(again.startsWith("rlo_") && !again.equals("rlo_gone"));
  }

  private static Harness utcSite(String kind) {
    return new Harness(
        kind,
        new Runlight.Options()
            .site(Json.object("hostnames", List.of("example.com"), "timezone", "UTC")));
  }

  private static void buildAll(Harness t) {
    for (int made = t.rl.buildRollups(); made > 0; made = t.rl.buildRollups()) {
      // Until every day that can be is built.
    }
  }

  private static List<Object> goalRows(Routes routes) {
    List<Object> out = new java.util.ArrayList<>();
    for (Object g :
        sh.runlight.Js.list(
            body(routes.handle(owner("/runlight/api/goals?period=7d&compare=off"))).get("goals"))) {
      out.add(
          List.of(
              sh.runlight.Js.get(g, "name"),
              sh.runlight.Js.get(g, "conversions"),
              sh.runlight.Js.get(g, "visitors")));
    }
    return out;
  }

  private static List<Object> eventRows(Routes routes) {
    List<Object> out = new java.util.ArrayList<>();
    for (Object r :
        sh.runlight.Js.list(
            body(routes.handle(owner("/runlight/api/breakdown?period=7d&dimension=event")))
                .get("rows"))) {
      out.add(List.of(sh.runlight.Js.get(r, "value"), sh.runlight.Js.get(r, "events")));
    }
    return out;
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void renamingAClickGoalKeepsItsConversionsOnBuiltDaysEvenOntoANameWithEventsOfItsOwn(
      String kind) {
    Harness t = utcSite(kind);
    t.advance(-3 * 24 * Harness.HOUR);
    for (int i = 0; i < 3; i++) {
      Map<String, Object> ip = Json.object("ip", "203.0.113." + (60 + i));
      t.send(view("default", "pageview", "https://example.com/", "c" + i), ip);
      t.send(
          Json.object("k", "event", "u", "https://example.com/", "i", "c" + i, "n", "Buy click"),
          ip);
      // One visit also sends a plain event under the name the goal is renamed to.
      if (i == 0) {
        t.send(
            Json.object("k", "event", "u", "https://example.com/", "i", "c" + i, "n", "Purchase"),
            ip);
      }
      t.advance(Harness.HOUR);
    }
    t.advance(3 * 24 * Harness.HOUR - 3 * Harness.HOUR);
    Routes routes = routes(t);
    Map<String, Object> goal =
        Json.object(
            "id",
            "0".repeat(23) + "c",
            "site",
            "default",
            "name",
            "Buy click",
            "kind",
            "click",
            "match",
            "button.buy",
            "clickBy",
            "selector",
            "valueMode",
            "none",
            "value",
            0L,
            "valueProp",
            "",
            "currency",
            "USD",
            "createdAt",
            t.now);
    t.store().saveGoal(goal);
    buildAll(t);
    assertEquals(List.of(List.of("Buy click", 3L, 3L)), goalRows(routes));
    for (String name : List.of("Checkout click", "Purchase")) {
      Map<String, Object> before = t.store().goals("default").get(0);
      Map<String, Object> after = new java.util.LinkedHashMap<>(before);
      after.put("name", name);
      t.store().saveGoal(after, before);
      assertEquals(
          List.of(List.of(name, name.equals("Purchase") ? 4L : 3L, 3L)),
          goalRows(routes),
          "renamed to " + name);
      // Days built again where both names met, then every built day reads the same as the raw
      // events.
      buildAll(t);
      List<Object> goals = goalRows(routes);
      List<Object> events = eventRows(routes);
      t.store().clearRollups("default");
      assertEquals(goals, goalRows(routes), "rollups agree with the raw events for " + name);
      assertEquals(events, eventRows(routes), "and so do the events for " + name);
      buildAll(t);
    }
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void aHeaderLongerThanItsColumnIsCutToFitSoTheDaysRollupStillBuilds(String kind) {
    Harness t = utcSite(kind);
    t.advance(-2 * 24 * Harness.HOUR);
    String platform = "\"" + "Windows ".repeat(400) + "\"";
    t.send(
        view("default", "pageview", "https://example.com/" + "a".repeat(1500), "long1"),
        Json.object(
            "ip",
            "203.0.113.70",
            // A browser whose user agent names no system, so the platform hint is what is stored.
            "ua",
            "Mozilla/5.0 (Unknown) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
            "headers",
            Json.object(
                "sec-ch-ua-platform",
                platform,
                "sec-ch-ua",
                "\"" + "B".repeat(3000) + "\";v=\"1\"")));
    t.advance(2 * 24 * Harness.HOUR);
    Map<String, Object> row = t.store().db().all("SELECT os, entry_path FROM rl_sessions").get(0);
    int os = ((String) row.get("os")).length();
    assertTrue(os > 50 && os <= 100, "os is " + os + " characters");
    assertTrue(((String) row.get("entry_path")).length() <= 1000);
    int built = 0;
    for (int made = t.rl.buildRollups(); made > 0; made = t.rl.buildRollups()) {
      built += made;
    }
    assertTrue(built >= 1, "the day builds");
    Map<String, Object> stats =
        body(routes(t).handle(owner("/runlight/api/stats?period=7d&compare=off")));
    assertEquals(1L, ((Number) ((Map<?, ?>) stats.get("stats")).get("visits")).longValue());
  }
}

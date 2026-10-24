package sh.runlight.routes;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static sh.runlight.routes.Make.body;
import static sh.runlight.routes.Make.owner;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import sh.runlight.Env;
import sh.runlight.Js;
import sh.runlight.Json;
import sh.runlight.Routes;
import sh.runlight.Runlight;
import sh.runlight.core.Harness;
import sh.runlight.core.WatchedDb;
import sh.runlight.http.Headers;
import sh.runlight.http.Request;
import sh.runlight.http.Response;
import sh.runlight.http.SearchParams;
import sh.runlight.http.Url;
import sh.runlight.store.Databases;
import sh.runlight.store.SqlStore;

/** The checks of the 2026-10-23 audit, as audit.test.ts has them. */
class AuditRoundThreeTest {
  @BeforeEach
  void setUp() {
    Make.clearEnv();
  }

  @AfterEach
  void tearDown() {
    Env.reset();
    Databases.cleanup();
  }

  private static Request accountReq(String path, String method, Headers headers, String body) {
    return new Request("https://example.com/runlight" + path, method, headers, body);
  }

  private static Request formPost(Map<String, String> extra, String path, String... fields) {
    SearchParams params = new SearchParams();
    for (int i = 0; i + 1 < fields.length; i += 2) {
      params.append(fields[i], fields[i + 1]);
    }
    Headers headers = Headers.of("content-type", "application/x-www-form-urlencoded");
    extra.forEach(headers::set);
    return accountReq(path, "POST", headers, params.toString());
  }

  private static String cookieFrom(Response response) {
    String cookie = response.headers().get("set-cookie");
    return (cookie == null ? "" : cookie).split(";")[0];
  }

  /** An install with accounts: its owner, and a member who joined by invite. */
  private static final class WithMember {
    final Routes routes;
    final String owner;
    final String member;

    WithMember() {
      Runlight rl =
          new Runlight(
              new Runlight.Options().store(Databases.fresh("sqlite")).secret("k".repeat(64)));
      routes = rl.routes(new Routes.Options().token("app-token").accounts(true));
      owner =
          cookieFrom(
              routes.handle(
                  formPost(
                      Map.of(),
                      "/setup",
                      "code",
                      "app-token",
                      "email",
                      "jon@example.com",
                      "password",
                      "a long password",
                      "again",
                      "a long password")));
      Url invite =
          new Url(
              (String)
                  body(json(
                          owner,
                          "POST",
                          "/api/people",
                          Json.object(
                              "allSites", true, "email", "mo@example.com", "role", "member")))
                      .get("link"));
      member =
          cookieFrom(
              routes.handle(
                  formPost(
                      Map.of(),
                      "/invite",
                      "code",
                      invite.searchParams().get("code"),
                      "password",
                      "a long password",
                      "again",
                      "a long password")));
    }

    Response json(String cookie, String method, String path, Object body) {
      return routes.handle(
          accountReq(
              path,
              method,
              Headers.of("cookie", cookie, "content-type", "application/json"),
              body == null ? "" : Json.stringify(body)));
    }

    Response signIn(Map<String, String> headers) {
      return routes.handle(
          formPost(
              headers,
              "/login",
              "email",
              "mo@example.com",
              "password",
              "a long password",
              "next",
              "/runlight/"));
    }

    String make(String cookie, String name) {
      return (String)
          Js.get(
              body(json(cookie, "POST", "/api/tokens", Json.object("name", name))).get("token"),
              "id");
    }

    List<String> listed(String cookie) {
      List<String> ids = new ArrayList<>();
      for (Object token : Js.list(body(json(cookie, "GET", "/api/tokens", null)).get("tokens"))) {
        ids.add((String) Js.get(token, "id"));
      }
      Collections.sort(ids);
      return ids;
    }
  }

  private static List<String> sorted(String... ids) {
    List<String> out = new ArrayList<>(List.of(ids));
    Collections.sort(out);
    return out;
  }

  @Test
  void aMemberSeesAndRevokesOnlyTheTokensTheyMadeAndCannotReplaceASitesAgentsKey() {
    WithMember t = new WithMember();
    String owners = t.make(t.owner, "Owner's");
    String mine = t.make(t.member, "Member's");
    assertEquals(List.of(mine), t.listed(t.member));
    assertEquals(sorted(owners, mine), t.listed(t.owner), "the owner sees every token");
    assertEquals(
        404,
        t.json(t.member, "DELETE", "/api/tokens/" + owners, null).status(),
        "the owner's token is not the member's to revoke");
    assertEquals(sorted(owners, mine), t.listed(t.owner));
    assertEquals(200, t.json(t.member, "DELETE", "/api/tokens/" + mine, null).status());
    assertEquals(
        403, t.json(t.member, "POST", "/api/observe-key/new?site=default", Json.object()).status());
    assertEquals(
        200, t.json(t.owner, "POST", "/api/observe-key/new?site=default", Json.object()).status());
  }

  @Test
  void signingOutEndsTheAccountsSessionsEverywhereAndOnlyFromTheDashboardsOwnPages() {
    WithMember t = new WithMember();
    String other = cookieFrom(t.signIn(Map.of()));
    assertEquals(200, t.json(other, "GET", "/api/account", null).status());
    Response crossSite =
        t.routes.handle(
            accountReq(
                "/logout",
                "GET",
                Headers.of("cookie", t.member, "sec-fetch-site", "cross-site"),
                ""));
    assertEquals(403, crossSite.status(), "another site cannot sign anyone out");
    assertEquals(200, t.json(other, "GET", "/api/account", null).status());
    Response out =
        t.routes.handle(
            accountReq(
                "/logout",
                "GET",
                Headers.of("cookie", t.member, "sec-fetch-site", "same-origin"),
                ""));
    assertEquals(303, out.status());
    assertEquals(
        401,
        t.json(t.member, "GET", "/api/account", null).status(),
        "the cookie copied before stops working");
    assertEquals(
        401,
        t.json(other, "GET", "/api/account", null).status(),
        "and so does the one in the other browser");
    String back = cookieFrom(t.signIn(Map.of()));
    assertEquals(200, t.json(back, "GET", "/api/account", null).status(), "signing in again works");
  }

  @Test
  void theSignInFormsTakeAPostOnlyFromTheirOwnPages() {
    WithMember t = new WithMember();
    for (String site : List.of("cross-site", "same-site")) {
      Response refused = t.signIn(Map.of("sec-fetch-site", site));
      assertEquals(403, refused.status(), site);
      assertNull(refused.headers().get("set-cookie"), site + ": no session is planted");
    }
    assertEquals(303, t.signIn(Map.of("sec-fetch-site", "same-origin")).status());
  }

  @Test
  void aNewPasswordCanTakeBackTheTokensTheAccountMade() {
    WithMember t = new WithMember();
    t.make(t.member, "Kept");
    String fresh =
        cookieFrom(
            t.json(
                t.member,
                "POST",
                "/api/account/password",
                Json.object("current", "a long password", "next", "another long password")));
    Response kept = t.json(fresh, "GET", "/api/tokens", null);
    assertEquals(200, kept.status(), kept.text());
    assertEquals(1, Js.list(body(kept).get("tokens")).size(), "kept unless asked");
    String latest =
        cookieFrom(
            t.json(
                fresh,
                "POST",
                "/api/account/password",
                Json.object(
                    "current",
                    "another long password",
                    "next",
                    "a third long password",
                    "revokeTokens",
                    true)));
    assertEquals(0, t.listed(latest).size());
  }

  @Test
  void yesterdaysSaltLeavesMemoryWhenItLeavesTheStoreOnTheFirstHitAfterMidnight()
      throws ReflectiveOperationException {
    Harness t = new Harness("sqlite");
    t.send(Json.object("k", "pageview", "u", "https://example.com/"));
    t.advance(13 * Harness.HOUR);
    t.send(
        Json.object("k", "pageview", "u", "https://example.com/"),
        Json.object("ip", "203.0.113.9"));
    Field field = Runlight.class.getDeclaredField("salts");
    field.setAccessible(true);
    Object cached = ((Map<?, ?>) field.get(t.rl)).get("UTC");
    Method day = cached.getClass().getDeclaredMethod("day");
    Method yesterday = cached.getClass().getDeclaredMethod("yesterday");
    day.setAccessible(true);
    yesterday.setAccessible(true);
    assertEquals("2026-10-07", day.invoke(cached));
    assertNull(
        yesterday.invoke(cached),
        "no visit was left open, so yesterday's salt is gone from here too");
  }

  @Test
  void aHitTriedAgainAfterTheStoreWasBusyCountsOnce() {
    WatchedDb watched = new WatchedDb(Databases.fresh("sqlite").db());
    Harness t = new Harness(new SqlStore(watched), new Runlight.Options());
    t.rl.init();
    AtomicInteger fail = new AtomicInteger(2);
    watched.before =
        sql -> {
          if (sql.contains("INSERT INTO rl_events") && fail.getAndDecrement() > 0) {
            throw new IllegalStateException("SQLITE_BUSY: database is locked");
          }
        };
    t.send(Json.object("k", "pageview", "u", "https://example.com/", "i", "p1"));
    fail.set(1);
    t.send(Json.object("k", "engagement", "u", "https://example.com/", "i", "p1", "e", 5000));
    watched.before = null;
    List<Map<String, Object>> visits =
        t.store().db().all("SELECT pageviews, engaged_ms FROM rl_sessions");
    assertEquals(1, visits.size());
    assertEquals(1L, Js.asLong(visits.get(0).get("pageviews")));
    assertEquals(5000L, Js.asLong(visits.get(0).get("engaged_ms")));
    assertEquals(1, t.store().db().all("SELECT id FROM rl_events WHERE kind = 'pageview'").size());
  }

  @Test
  void aFunnelOverMoreVisitsThanTheCapCountsTheNewestAndSaysSo() {
    Harness t = new Harness("sqlite");
    t.store().funnelVisits = 2;
    for (String ip : List.of("203.0.113.1", "203.0.113.2", "203.0.113.3")) {
      t.send(
          Json.object("k", "pageview", "u", "https://example.com/pricing"), Json.object("ip", ip));
      t.advance(Harness.MIN);
    }
    Routes routes = t.rl.routes(new Routes.Options().token("secret"));
    routes.handle(
        owner(
            "/runlight/api/funnels?site=default",
            "POST",
            Json.object(
                "name",
                "F",
                "steps",
                List.of(
                    Json.object("kind", "page", "match", "/pricing"),
                    Json.object("kind", "page", "match", "/thanks")))));
    Object funnel =
        Js.list(body(routes.handle(owner("/runlight/api/funnels?period=today"))).get("funnels"))
            .get(0);
    assertEquals(2L, Js.asLong(Js.get(funnel, "sampled")));
    assertEquals(2L, Js.asLong(Js.get(Js.list(Js.get(funnel, "steps")).get(0), "visits")));
    t.store().funnelVisits = 10;
    Object again =
        Js.list(body(routes.handle(owner("/runlight/api/funnels?period=today"))).get("funnels"))
            .get(0);
    assertFalse(Js.map(again).containsKey("sampled"));
  }

  @Test
  void anAutomaticLinkEventKeepsItsLinkWithoutTheQueryStringOrFragment() {
    Harness t = new Harness("sqlite");
    t.send(
        Json.object(
            "k",
            "event",
            "u",
            "https://example.com/",
            "n",
            "Outbound link",
            "p",
            Json.object("url", "https://other.example/reset?token=abc&email=a@b.example#top")));
    t.send(
        Json.object(
            "k",
            "event",
            "u",
            "https://example.com/",
            "n",
            "File download",
            "p",
            Json.object("url", "https://example.com/a.pdf?sig=x")));
    t.send(
        Json.object(
            "k",
            "event",
            "u",
            "https://example.com/",
            "n",
            "Signup",
            "p",
            Json.object("url", "https://example.com/?plan=pro")));
    List<List<Object>> rows = new ArrayList<>();
    for (Map<String, Object> r :
        t.store().db().all("SELECT name, props FROM rl_events ORDER BY name")) {
      rows.add(List.of(r.get("name"), Js.get(Json.parse((String) r.get("props")), "url")));
    }
    assertEquals(
        List.of(
            List.of("File download", "https://example.com/a.pdf"),
            List.of("Outbound link", "https://other.example/reset"),
            List.of("Signup", "https://example.com/?plan=pro")),
        rows);
  }
}

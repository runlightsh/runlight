package sh.runlight.accounts;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import sh.runlight.Env;
import sh.runlight.Js;
import sh.runlight.Json;
import sh.runlight.Routes;
import sh.runlight.Runlight;
import sh.runlight.http.Headers;
import sh.runlight.http.Request;
import sh.runlight.http.Response;
import sh.runlight.http.SearchParams;
import sh.runlight.http.Url;
import sh.runlight.store.Databases;

/** accounts.test.ts's route-level tests: an app with routes(accounts: true). */
class RoutesAccountsTest {
  static List<String> kinds() {
    return Databases.kinds();
  }

  @AfterEach
  void tearDown() {
    Env.reset();
    Databases.cleanup();
  }

  private static Request req(String path) {
    return req(path, "GET", Headers.of(), "");
  }

  private static Request req(String path, String method, Headers headers, String body) {
    return new Request("https://example.com" + path, method, headers, body);
  }

  private static Request form(String path, String cookie, String... fields) {
    SearchParams params = new SearchParams();
    for (int i = 0; i + 1 < fields.length; i += 2) {
      params.append(fields[i], fields[i + 1]);
    }
    Headers headers = Headers.of("content-type", "application/x-www-form-urlencoded");
    if (!cookie.isEmpty()) {
      headers.set("cookie", cookie);
    }
    return req(path, "POST", headers, params.toString());
  }

  private static String cookieOf(Response response) {
    String cookie = response.headers().get("set-cookie");
    return (cookie == null ? "" : cookie).split(";")[0];
  }

  private static Map<String, Object> body(Response response) {
    return Js.map(Json.parse(response.text()));
  }

  private interface JsonCall {
    Response call(String cookie, String method, String path, Object body);
  }

  private interface Join {
    String call(String by, String email, String role);
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void anAppWithAccountsOnMakesItsFirstAccountWithItsTokenThenInvitesPeopleByRole(String kind) {
    Runlight rl =
        new Runlight(new Runlight.Options().store(Databases.fresh(kind)).secret("k".repeat(64)));
    Routes routes = rl.routes(new Routes.Options().token("app-token").accounts(true));
    Function<Request, Response> handler = routes::handle;
    JsonCall json =
        (cookie, method, path, body) ->
            handler.apply(
                req(
                    "/runlight" + path,
                    method,
                    Headers.of("cookie", cookie, "content-type", "application/json"),
                    body == null ? "" : Json.stringify(body)));

    // Nobody yet: the dashboard sends you to set up, which asks for the app's token.
    Response start = handler.apply(req("/runlight/"));
    assertEquals(303, start.status());
    assertEquals("/runlight/setup", start.headers().get("location"));
    String page = handler.apply(req("/runlight/setup")).text();
    assertTrue(page.contains("RUNLIGHT_TOKEN"));
    assertTrue(page.contains("action=\"/runlight/setup\""));
    assertTrue(page.contains("href=\"/runlight/auth.css\""));
    Response wrong =
        handler.apply(
            form(
                "/runlight/setup",
                "",
                "code",
                "guess",
                "email",
                "jon@example.com",
                "password",
                "a long password",
                "again",
                "a long password"));
    assertEquals(403, wrong.status());
    Response made =
        handler.apply(
            form(
                "/runlight/setup",
                "",
                "code",
                "app-token",
                "email",
                "jon@example.com",
                "password",
                "a long password",
                "again",
                "a long password"));
    assertEquals(303, made.status());
    assertEquals("/runlight/", made.headers().get("location"));
    assertTrue(
        made.headers().get("set-cookie").contains("Path=/runlight;"),
        "the session is for Runlight's paths only");
    String owner = cookieOf(made);
    assertEquals(
        "/runlight/login",
        handler.apply(req("/runlight/setup")).headers().get("location"),
        "setup closes once there is an account");

    // Signed in, the dashboard and its API answer; signed out, they do not.
    Headers asOwner = Headers.of("cookie", owner);
    assertEquals(200, handler.apply(req("/runlight/", "GET", asOwner, "")).status());
    assertTrue(
        handler.apply(req("/runlight/", "GET", asOwner, "")).text().contains("data-accounts=\"\""));
    assertEquals(401, handler.apply(req("/runlight/api/sites")).status());
    assertEquals(200, handler.apply(req("/runlight/api/sites", "GET", asOwner, "")).status());
    assertEquals(
        200,
        handler
            .apply(
                req(
                    "/runlight/api/sites",
                    "GET",
                    Headers.of("authorization", "Bearer app-token"),
                    ""))
            .status(),
        "a script's token still works");
    assertEquals(
        "owner",
        Js.get(body(json.call(owner, "GET", "/api/account", null)).get("account"), "role"));

    // The owner invites a member, who joins with their own password.
    Map<String, Object> sent =
        body(
            json.call(
                owner,
                "POST",
                "/api/people",
                Json.object("allSites", true, "email", "mo@example.com", "role", "member")));
    assertEquals(false, sent.get("emailed"), "no mail service here, so the link is for passing on");
    Url link = new Url((String) sent.get("link"));
    assertEquals("/runlight/invite", link.pathname);
    assertTrue(handler.apply(req(link.pathname + link.search)).text().contains("as a member"));
    Response joined =
        handler.apply(
            form(
                "/runlight/invite",
                "",
                "code",
                link.searchParams().get("code"),
                "password",
                "another long one",
                "again",
                "another long one"));
    assertEquals(303, joined.status());
    String member = cookieOf(joined);

    // A member changes a site's settings, but not people, the mail service, or the assistant's
    // settings.
    assertEquals(
        201,
        json.call(
                member,
                "POST",
                "/api/goals",
                Json.object("name", "Signup", "kind", "page", "match", "/thanks"))
            .status());
    assertEquals(403, json.call(member, "GET", "/api/people", null).status());
    assertEquals(
        "admin_only", body(json.call(member, "PUT", "/api/mail", Json.object())).get("code"));
    assertEquals(403, json.call(member, "PUT", "/api/assistant", Json.object()).status());

    // Signing out ends the session; signing in again with the password starts one.
    Response out = handler.apply(req("/runlight/logout"));
    assertEquals("/runlight/login", out.headers().get("location"));
    assertEquals("/runlight/login", handler.apply(req("/runlight/")).headers().get("location"));
    Response back =
        handler.apply(
            form(
                "/runlight/login",
                "",
                "email",
                "mo@example.com",
                "password",
                "another long one",
                "next",
                "/runlight/?period=7d"));
    assertEquals(303, back.status());
    assertEquals("/runlight/?period=7d", back.headers().get("location"));
    Response elsewhere =
        handler.apply(
            form(
                "/runlight/login",
                "",
                "email",
                "mo@example.com",
                "password",
                "another long one",
                "next",
                "//evil.example/"));
    assertEquals("/runlight/", elsewhere.headers().get("location"), "never sent off the app");
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void anAccountKeptToOneSiteSeesNoMailFieldsCannotMoveItAndGoesWhenTheSiteIsDeleted(String kind) {
    Runlight rl =
        new Runlight(
            new Runlight.Options()
                .store(Databases.fresh(kind))
                .secret("k".repeat(64))
                .managedSites(true));
    rl.init();
    String alpha = (String) rl.addSite(Json.object("hostnames", "alpha.example.com")).get("id");
    Routes routes = rl.routes(new Routes.Options().token("app-token").accounts(true));
    Accounts accounts = new Accounts(rl.store, "k".repeat(64));
    long now = rl.now();
    accounts.setPassword("owner@example.com", "a long password", now);
    accounts.setPassword("mo@example.com", "another long one", now, "member", alpha);
    accounts.invite("later@example.com", "viewer", "owner@example.com", now, alpha);
    String member =
        cookieOf(
            routes.handle(
                form(
                    "/runlight/login",
                    "",
                    "email",
                    "mo@example.com",
                    "password",
                    "another long one",
                    "next",
                    "/runlight/")));
    JsonCall call =
        (cookie, method, path, body) ->
            routes.handle(
                req(
                    "/runlight" + path,
                    method,
                    cookie.isEmpty()
                        ? Headers.of(
                            "authorization", "Bearer app-token", "content-type", "application/json")
                        : Headers.of("cookie", cookie, "content-type", "application/json"),
                    body == null ? "" : Json.stringify(body)));
    assertEquals(
        200,
        call.call(
                "",
                "PUT",
                "/api/mail",
                Json.object(
                    "service", "resend", "apiKey", "re_live_key", "from", "reports@example.com"))
            .status());
    Map<String, Object> owners = body(call.call("", "GET", "/api/mail", null));
    assertEquals(List.of("apiKey"), owners.get("saved"), "the owner sees which keys are saved");
    // An account kept to one site learns which service sends the reports, and nothing besides.
    Response mail = call.call(member, "GET", "/api/mail", null);
    assertEquals(200, mail.status());
    assertEquals(Map.of(), body(mail).get("fields"));
    assertEquals(List.of(), body(mail).get("saved"));
    assertEquals("resend", body(mail).get("service"));

    // It may rename the site, as a hub may, never move it.
    Response moved =
        call.call(
            member, "PATCH", "/api/sites/" + alpha, Json.object("hostnames", List.of("x.example")));
    assertEquals(403, moved.status());
    assertEquals("site_domains", body(moved).get("code"));
    assertEquals(
        List.of("alpha.example.com"),
        Js.list(rl.site(alpha).get("hostnames")),
        "and the site stays where it was");

    // Deleting the site takes its accounts and invitations with it, and no one else's.
    assertEquals(200, call.call("", "DELETE", "/api/sites/" + alpha, null).status());
    assertEquals(List.of("owner@example.com"), emails(accounts));
    assertEquals(List.of(), accounts.invites(now));
  }

  private static List<Object> emails(Accounts accounts) {
    List<Object> out = new java.util.ArrayList<>();
    for (Map<String, Object> user : accounts.list()) {
      out.add(user.get("email"));
    }
    return out;
  }

  @Test
  void invitesGoWithWhoeverSentThem() {
    Runlight rl =
        new Runlight(
            new Runlight.Options().store(Databases.fresh("sqlite")).secret("k".repeat(64)));
    Function<Request, Response> handler =
        rl.routes(new Routes.Options().token("app-token").accounts(true))::handle;
    JsonCall json =
        (cookie, method, path, body) ->
            handler.apply(
                req(
                    "/runlight" + path,
                    method,
                    Headers.of("cookie", cookie, "content-type", "application/json"),
                    body == null ? "" : Json.stringify(body)));
    String owner = cookieOf(handler.apply(setup("app-token")));
    Join join =
        (by, email, role) -> {
          Map<String, Object> sent =
              body(
                  json.call(
                      by,
                      "POST",
                      "/api/people",
                      Json.object("allSites", true, "email", email, "role", role)));
          return new Url((String) sent.get("link")).searchParams().get("code");
        };
    Function<String, Response> accept =
        code ->
            handler.apply(
                form(
                    "/runlight/invite",
                    "",
                    "code",
                    code,
                    "password",
                    "a long password",
                    "again",
                    "a long password"));
    String admin = cookieOf(accept.apply(join.call(owner, "ada@example.com", "admin")));
    Object adminId =
        Js.get(body(json.call(admin, "GET", "/api/account", null)).get("account"), "id");

    // Made a member: what they sent stops working.
    String fromAda = join.call(admin, "eve@example.com", "admin");
    assertEquals(
        200,
        json.call(owner, "PATCH", "/api/people/" + adminId, Json.object("role", "member"))
            .status());
    assertEquals(410, handler.apply(req("/runlight/invite?code=" + fromAda)).status());
    assertEquals(410, accept.apply(fromAda).status());

    // Removed: the same.
    json.call(owner, "PATCH", "/api/people/" + adminId, Json.object("role", "admin"));
    String again = join.call(admin, "eve@example.com", "admin");
    assertEquals(200, json.call(owner, "DELETE", "/api/people/" + adminId, null).status());
    assertEquals(410, accept.apply(again).status());
    assertEquals(List.of(), body(json.call(owner, "GET", "/api/people", null)).get("invites"));

    // An invite left from before, whose sender is no longer an admin, is refused when used.
    String second = cookieOf(accept.apply(join.call(owner, "bo@example.com", "admin")));
    String fromBo = join.call(second, "zed@example.com", "admin");
    rl.store
        .db()
        .run("UPDATE rl_users SET role = 'viewer' WHERE email = ?", List.of("bo@example.com"));
    assertEquals(410, accept.apply(fromBo).status());
    assertEquals(
        410,
        handler.apply(req("/runlight/invite?code=" + fromBo)).status(),
        "and it is gone afterwards");
  }

  private static Request setup(String code) {
    return form(
        "/runlight/setup",
        "",
        "code",
        code,
        "email",
        "jon@example.com",
        "password",
        "a long password",
        "again",
        "a long password");
  }

  @Test
  void
      inDevelopmentOrLeftOpenOnPurposeTheFirstAccountNeedsNoProofInProductionWithoutATokenSetupStaysShut() {
    Env.override("RUNLIGHT_TOKEN", null);
    Env.override("RUNLIGHT_SECRET", null);
    Env.override("NODE_ENV", "development");
    Routes dev =
        new Runlight(new Runlight.Options().store(Databases.fresh("sqlite")))
            .routes(new Routes.Options().accounts(true));
    String page = dev.handle(req("/runlight/setup")).text();
    assertFalse(page.contains("RUNLIGHT_TOKEN"));
    assertEquals(303, dev.handle(setup("")).status());

    Env.override("NODE_ENV", "production");
    Routes open =
        new Runlight(new Runlight.Options().store(Databases.fresh("sqlite")))
            .routes(new Routes.Options().token(null).accounts(true));
    assertEquals(
        200,
        open.handle(req("/runlight/setup")).status(),
        "token: null leaves setup open, as it leaves everything");
    Routes prod =
        new Runlight(new Runlight.Options().store(Databases.fresh("sqlite")).secret("k".repeat(64)))
            .routes(new Routes.Options().accounts(true));
    Response shut = prod.handle(req("/runlight/setup"));
    assertEquals(403, shut.status());
    assertTrue(shut.text().contains("Set RUNLIGHT_TOKEN"));
    assertEquals(403, prod.handle(setup("")).status());
  }
}

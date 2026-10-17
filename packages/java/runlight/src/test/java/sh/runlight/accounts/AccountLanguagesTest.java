package sh.runlight.accounts;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import sh.runlight.Env;
import sh.runlight.Fixtures;
import sh.runlight.Js;
import sh.runlight.Json;
import sh.runlight.Routes;
import sh.runlight.Runlight;
import sh.runlight.http.Headers;
import sh.runlight.http.Request;
import sh.runlight.http.Response;
import sh.runlight.http.SearchParams;
import sh.runlight.store.Stores;

/**
 * account-languages.test.ts: the account and OAuth pages in the browser's language, and in English,
 * byte for byte, as they were.
 */
class AccountLanguagesTest {
  private static final String FRENCH = "fr-FR,fr;q=0.9,en;q=0.8";

  @AfterEach
  void tearDown() {
    Env.reset();
  }

  private static Request req(String path, String language) {
    return req(path, "GET", language, Headers.of(), "");
  }

  private static Request req(
      String path, String method, String language, Headers headers, String body) {
    if (language != null) {
      headers.set("accept-language", language);
    }
    return new Request("https://example.com" + path, method, headers, body);
  }

  private static Request form(String path, String language, String... fields) {
    SearchParams params = new SearchParams();
    for (int i = 0; i + 1 < fields.length; i += 2) {
      params.append(fields[i], fields[i + 1]);
    }
    return req(
        path,
        "POST",
        language,
        Headers.of("content-type", "application/x-www-form-urlencoded"),
        params.toString());
  }

  private static String cookieOf(Response response) {
    String cookie = response.headers().get("set-cookie");
    return (cookie == null ? "" : cookie).split(";")[0];
  }

  private static void assertMatches(String regex, String text) {
    assertTrue(Pattern.compile(regex).matcher(text).find(), regex + " in " + text);
  }

  @Test
  void englishAccountPagesAreTheOnesTheOtherImplementationsAreCheckedAgainstByteForByte() {
    Map<String, Object> fixture = Fixtures.load("pages");
    assertEquals(fixture.get("js"), Pages.AUTH_JS);
    assertEquals(fixture.get("js"), Pages.authJs("en"));
    assertEquals(
        fixture.get("js"), Pages.authJs("xx"), "a language Runlight does not speak is English");
    for (Map<String, Object> c : Fixtures.cases(fixture, "pages")) {
      String base = (String) c.get("base");
      Map<String, Object> opts = Js.map(c.get("opts"));
      String html =
          switch ((String) c.get("fn")) {
            case "loginPage" -> Pages.loginPage(base, opts, "en");
            case "codePage" -> Pages.codePage(base, opts, "en");
            case "invitePage" -> Pages.invitePage(base, opts, "en");
            case "inviteGonePage" -> Pages.inviteGonePage(base, "en");
            case "setupPage" -> Pages.setupPage(base, opts, "en");
            case "setupLockedPage" -> Pages.setupLockedPage(base, "en");
            default -> Pages.setupNeedsTokenPage(base, "en");
          };
      assertEquals(c.get("html"), html, c.get("fn") + " at \"" + base + "\", asked for in English");
    }
  }

  @Test
  void everyAccountPageComesOutInFrenchWhenAsked() {
    String[][] cases = {
      {
        "sign in",
        Pages.loginPage("/runlight", Json.object("forgot", "https://runlight.sh/docs"), "fr"),
        "Se connecter"
      },
      {
        "the code step",
        Pages.codePage("/runlight", Json.object("pending", "p", "next", "/"), "fr"),
        "Saisissez votre code"
      },
      {
        "an invite",
        Pages.invitePage(
            "/runlight",
            Json.object(
                "code",
                "c",
                "email",
                "a@example.com",
                "role",
                "viewer",
                "host",
                "stats.example.com"),
            "fr"),
        "Rejoindre Runlight"
      },
      {
        "an invite that is gone",
        Pages.inviteGonePage("/runlight", "fr"),
        "Cette invitation ne fonctionne plus"
      },
      {
        "setup",
        Pages.setupPage("/runlight", Json.object("code", "", "askCode", true), "fr"),
        "Créez votre compte"
      },
      {"setup locked", Pages.setupLockedPage("/runlight", "fr"), "Terminez la configuration"},
      {
        "setup needing a token",
        Pages.setupNeedsTokenPage("/runlight", "fr"),
        "Terminez la configuration"
      },
    };
    for (String[] c : cases) {
      assertMatches("<html lang=\"fr\">", c[1]);
      assertTrue(c[1].contains("<h1>" + c[2] + "</h1>"), c[0]);
      assertTrue(c[1].contains("<title>" + c[2] + " | Runlight</title>"), c[0]);
      assertTrue(
          c[1].contains("<script src=\"/runlight/auth.js?lang=fr\"></script>"),
          c[0] + " loads the French script");
      assertTrue(c[1].contains("aria-label=\"Changer de thème\""), c[0]);
    }
    String invite =
        Pages.invitePage(
            "",
            Json.object(
                "code",
                "c",
                "email",
                "a@example.com",
                "role",
                "member",
                "host",
                "stats.example.com",
                "site",
                "<Blog>"),
            "fr");
    assertTrue(
        invite.contains(
            "Votre rôle : membre, qui peut modifier les réglages de &lt;Blog&gt; uniquement."),
        "the role is French too, and the site name stays escaped");
    assertTrue(
        Pages.loginPage("", Json.object("forgot", "https://x.example/?a=1&b=2"), "fr")
            .contains(
                "<a href=\"https://x.example/?a=1&amp;b=2\" target=\"_blank\" rel=\"noopener\">la documentation explique"));
    // The script's words: show and hide, the theme, and the strength meter.
    String script = Pages.authJs("fr");
    for (String words :
        List.of(
            "\"Afficher le mot de passe\"",
            "\"Masquer le mot de passe\"",
            "\"Thème : réglage de l’appareil\"",
            "\"Thème : sombre\"",
            "[\"Trop court\", \"Faible\", \"Moyen\", \"Bon\", \"Fort\"]")) {
      assertTrue(script.contains(words), words);
    }
    assertFalse(script.contains("Show password"));
  }

  @Test
  void aValueWithMarkupInItStaysEscapedOnEveryLanguage() {
    for (String lang : List.of("en", "fr", "xx")) {
      String login =
          Pages.loginPage(
              "", Json.object("error", "<b>bad</b>", "email", "\"><i>", "forgot", "x"), lang);
      assertTrue(login.contains("&lt;b&gt;bad&lt;/b&gt;"), lang);
      assertFalse(login.contains("<b>bad"), lang);
      assertFalse(login.contains("<i>"), lang);
    }
  }

  @Test
  void theAccountRoutesAnswerInTheBrowsersLanguageAndInEnglishAsBeforeWithoutOne() {
    Runlight rl =
        new Runlight(
            new Runlight.Options().store(Stores.sqlite(":memory:")).secret("k".repeat(64)));
    Routes routes = rl.routes(new Routes.Options().token("app-token").accounts(true));

    String setup = routes.handle(req("/runlight/setup", FRENCH)).text();
    assertMatches("<html lang=\"fr\">", setup);
    assertMatches("<h1>Créez votre compte</h1>", setup);
    String english = routes.handle(req("/runlight/setup", "en-GB,fr;q=0.5")).text();
    assertEquals(
        english,
        routes.handle(req("/runlight/setup", null)).text(),
        "English asked for is English as it always was");
    assertMatches("<html lang=\"en\">", english);
    assertMatches("<script src=\"/runlight/auth\\.js\"></script>", english);
    assertEquals(
        english,
        routes.handle(req("/runlight/setup", "xx-YY")).text(),
        "a language Runlight does not speak is English");

    assertMatches(
        "Ce n’est pas le RUNLIGHT_TOKEN de cette application\\.",
        routes
            .handle(
                form(
                    "/runlight/setup",
                    FRENCH,
                    "code",
                    "guess",
                    "email",
                    "jon@example.com",
                    "password",
                    "a long password",
                    "again",
                    "a long password"))
            .text());
    assertMatches(
        "Utilisez un mot de passe d’au moins 10 caractères\\.",
        routes
            .handle(
                form(
                    "/runlight/setup",
                    FRENCH,
                    "code",
                    "app-token",
                    "email",
                    "jon@example.com",
                    "password",
                    "short",
                    "again",
                    "short"))
            .text());
    assertMatches(
        "role=\"alert\">Use a password of at least 10 characters</p>",
        routes
            .handle(
                form(
                    "/runlight/setup",
                    null,
                    "code",
                    "app-token",
                    "email",
                    "jon@example.com",
                    "password",
                    "short",
                    "again",
                    "short"))
            .text());

    String owner =
        cookieOf(
            routes.handle(
                form(
                    "/runlight/setup",
                    null,
                    "code",
                    "app-token",
                    "email",
                    "jon@example.com",
                    "password",
                    "a long password",
                    "again",
                    "a long password")));
    Response wrong =
        routes.handle(
            form(
                "/runlight/login",
                FRENCH,
                "email",
                "jon@example.com",
                "password",
                "not the password"));
    assertEquals(401, wrong.status());
    assertMatches("Cet e-mail et ce mot de passe ne correspondent à aucun compte\\.", wrong.text());
    assertMatches(
        "Ce lien de connexion a expiré\\.",
        routes.handle(req("/runlight/login/link?ticket=nope", FRENCH)).text());

    Map<String, Object> sent =
        Js.map(
            Json.parse(
                routes
                    .handle(
                        req(
                            "/runlight/api/people",
                            "POST",
                            null,
                            Headers.of("cookie", owner, "content-type", "application/json"),
                            Json.stringify(
                                Json.object(
                                    "allSites",
                                    true,
                                    "email",
                                    "mo@example.com",
                                    "role",
                                    "viewer"))))
                    .text()));
    sh.runlight.http.Url link = new sh.runlight.http.Url((String) sent.get("link"));
    String invite = routes.handle(req(link.pathname + link.search, FRENCH)).text();
    assertMatches(
        "Votre rôle : lecteur, qui peut lire les statistiques de tous les sites\\.", invite);
    String mismatch =
        routes
            .handle(
                form(
                    "/runlight/invite",
                    FRENCH,
                    "code",
                    link.searchParams().get("code"),
                    "password",
                    "a long password",
                    "again",
                    "another one"))
            .text();
    assertMatches("Les deux mots de passe ne sont pas identiques\\.", mismatch);
    assertMatches(
        "<h1>Cette invitation ne fonctionne plus</h1>",
        routes.handle(req("/runlight/invite?code=nope", FRENCH)).text());

    // The script comes in the language its page asked for, and in English at its old address.
    assertEquals(Pages.AUTH_JS, routes.handle(req("/runlight/auth.js", FRENCH)).text());
    assertEquals(Pages.authJs("fr"), routes.handle(req("/runlight/auth.js?lang=fr", null)).text());

    Routes locked =
        new Runlight(new Runlight.Options().store(Stores.sqlite(":memory:")).secret("k".repeat(64)))
            .routes(new Routes.Options().accounts(true));
    Response page = locked.handle(req("/runlight/setup", FRENCH));
    assertEquals(403, page.status());
    assertMatches("<h1>Terminez la configuration</h1>", page.text());
  }

  @Test
  void theOauthConsentPageAndItsMessagesComeOutInFrenchWhenAsked() {
    Runlight rl =
        new Runlight(
            new Runlight.Options()
                .store(Stores.sqlite(":memory:"))
                .sites(
                    List.of(
                        Json.object("id", "a", "name", "Site A", "hostnames", List.of("a.com")),
                        Json.object("id", "b", "name", "Site B", "hostnames", List.of("b.com")))));
    Routes routes = rl.routes(new Routes.Options().token("secret"));
    String callback = "https://claude.ai/api/mcp/auth_callback";
    Response registered =
        routes.handle(
            req(
                "/runlight/oauth/register",
                "POST",
                null,
                Headers.of("content-type", "application/json"),
                Json.stringify(
                    Json.object("client_name", "Claude", "redirect_uris", List.of(callback)))));
    String clientId = (String) Js.map(Json.parse(registered.text())).get("client_id");
    SearchParams p = new SearchParams();
    p.append("response_type", "code");
    p.append("client_id", clientId);
    p.append("redirect_uri", callback);
    p.append("code_challenge", "a".repeat(43));
    p.append("code_challenge_method", "S256");
    String params = p.toString();
    java.util.function.BiFunction<String, String, Request> get =
        (query, language) ->
            req(
                "/runlight/oauth/authorize?" + query,
                "GET",
                language,
                Headers.of("authorization", "Bearer secret"),
                "");

    String consent = routes.handle(get.apply(params, FRENCH)).text();
    assertMatches("<html lang=\"fr\">", consent);
    assertMatches("<title>Connecter Claude \\| Runlight</title>", consent);
    assertMatches("<h1>Connecter Claude</h1>", consent);
    assertMatches("<strong>Claude</strong> veut lire vos statistiques Runlight", consent);
    assertMatches("Autoriser vous renvoie vers <strong>claude\\.ai</strong>\\.", consent);
    assertTrue(
        consent.contains(
            "<option value=\"\">Tous les sites</option><option value=\"a\">Site A uniquement</option>"),
        consent);
    assertTrue(
        consent.contains(
            "class=\"ghost\">Refuser</button><button type=\"submit\" name=\"decision\" value=\"allow\">Autoriser</button>"));
    String english = routes.handle(get.apply(params, null)).text();
    assertMatches("<html lang=\"en\">", english);
    assertMatches("<h1>Connect Claude</h1>", english);
    assertMatches(
        "<strong>Claude</strong> wants to read your Runlight stats so it can answer questions about them\\.",
        english);

    String manage = routes.handle(get.apply(params + "&scope=manage", FRENCH)).text();
    assertTrue(
        manage.contains(
            "Son jeton apparaît dans Réglages, MCP &amp; API, où le supprimer déconnecte Claude."),
        manage);
    Response signedOut =
        routes.handle(req("/runlight/oauth/authorize?" + params, "GET", FRENCH, Headers.of(), ""));
    assertEquals(401, signedOut.status());
    assertMatches("<h1>Connectez-vous d’abord</h1>", signedOut.text());
    String unknown = routes.handle(get.apply(params.replace(clientId, "nope"), FRENCH)).text();
    assertTrue(
        unknown.contains(
            "<h1>Cette application n’est pas enregistrée</h1><p>Recommencez la connexion depuis l’application.</p>"),
        unknown);
    Response forged =
        routes.handle(
            req(
                "/runlight/oauth/authorize",
                "POST",
                FRENCH,
                Headers.of(
                    "authorization",
                    "Bearer secret",
                    "origin",
                    "https://evil.example",
                    "content-type",
                    "application/x-www-form-urlencoded"),
                params + "&decision=allow"));
    assertEquals(403, forged.status());
    assertMatches("<h1>Cette demande vient d’un autre site</h1>", forged.text());
  }

  @Test
  void theSetupLockedPageNamesTheSetupFileInEveryLanguage() {
    String english = Pages.setupLockedPage("", true, "en");
    assertTrue(
        english.contains(
            "Open the setup link in the file setup.txt in Runlight's data folder (<code>runlight setup</code> prints it too), which carries a one-time code, to create the first account."));
    assertMatches("<html lang=\"en\">", english);
    String french = Pages.setupLockedPage("", true, "fr");
    assertMatches("<html lang=\"fr\">", french);
    assertMatches("<h1>Terminez la configuration</h1>", french);
    assertTrue(french.contains("setup.txt"));
    assertTrue(french.contains("<code>runlight setup</code>"));
    assertFalse(french.contains("Open the setup link"));
    assertFalse(french.equals(Pages.setupLockedPage("", false, "fr")));
  }
}

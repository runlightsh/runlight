package sh.runlight;

import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.function.BiPredicate;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import sh.runlight.CodedError.SettingsError;
import sh.runlight.http.Headers;
import sh.runlight.http.Request;
import sh.runlight.http.Response;
import sh.runlight.http.SearchParams;
import sh.runlight.http.Url;
import sh.runlight.mail.Secret;
import sh.runlight.store.SqlStore;

/**
 * OAuth for the MCP server, so apps that connect only through OAuth (the Claude and ChatGPT web
 * connectors) can reach it. Runlight is both the resource and the authorization server:
 *
 * <ul>
 *   <li>/.well-known/oauth-protected-resource names the MCP endpoint and this server.
 *   <li>/.well-known/oauth-authorization-server lists the endpoints below.
 *   <li>POST /oauth/register lets a client register itself (public clients, no secret).
 *   <li>/oauth/authorize asks the signed-in owner to allow the client, every site or one.
 *   <li>POST /oauth/token swaps the one-time code, checked with PKCE, for a token.
 * </ul>
 *
 * <p>The token is an ordinary API token, so it appears in Settings, API and AI, beside the others,
 * and deleting it there disconnects the app. It reads stats, or with the "manage" scope (asked for
 * by a Runlight hub) it also changes one site's settings. With the "cms" scope (asked for by the
 * WordPress, Drupal, and Craft plugins) it is the site's dashboard key, which only opens its
 * read-only dashboard in the CMS, and the answer also carries the site's agents key, so connecting
 * fills in the plugin's settings.
 */
public final class OAuth {
  private OAuth() {}

  /**
   * What OAuth needs of the Runlight it serves; the core's Runlight provides it. The sites are the
   * SiteRow maps (id, name, and the rest), and {@code site} and {@code remote} return null where
   * the TypeScript's give undefined.
   */
  public interface Install {
    /** Makes the tables, once. */
    void init();

    /** The clock, in milliseconds. */
    long now();

    SqlStore store();

    /** The secret that seals the keys kept in the database, or null when there is none. */
    String secret();

    /** The address a request came from, as the Runlight reads it (trusting a proxy or not). */
    String clientIp(Request request, Map<String, Object> context);

    List<Map<String, Object>> sites();

    Map<String, Object> site(String id);

    /** The connected install a site is read from, or null for a site of this install's own. */
    Object remote(String id);

    /** Whether sites are added, changed, and deleted in the dashboard. */
    default boolean managedSites() {
      return false;
    }

    /** Adds a site, when sites are managed in the dashboard; a SettingsError when it cannot. */
    default Map<String, Object> addSite(Map<String, Object> input) {
      throw new SettingsError("Sites are set in code", "sites_in_code");
    }
  }

  /**
   * What the routes pass: the Runlight, the routes' base, and how to tell who is asking.
   *
   * <p>isOwner says whether the request comes from the signed-in owner. signIn is where to send
   * someone to sign in, when there is such a page (the standalone server's). isReader says whether
   * the request comes from someone signed in who may only read, such as a viewer. accountOf names
   * the account a request comes from, where the app has accounts. tokenMade notes who made a token,
   * and answers false when they can no longer make one, which takes it back. csrf gives the token
   * the consent form sends back in its csrf field, for the app's own check of where it comes from.
   */
  public static final class Context {
    public final Install runlight;
    public final String base;
    public final Predicate<Request> isOwner;
    public String signIn;
    public Predicate<Request> isReader;
    public Function<Request, String> accountOf;
    public BiPredicate<Map<String, Object>, String> tokenMade;
    public Supplier<String> csrf;

    public Context(Install runlight, String base, Predicate<Request> isOwner) {
      this.runlight = runlight;
      this.base = base;
      this.isOwner = isOwner;
    }
  }

  private static final List<String> SCOPES = List.of("read", "manage", "cms");

  /**
   * The key a CMS plugin reports AI agents reading a site's pages with: made on first ask, or a new
   * one that replaces it. It is kept sealed with the server's secret, as the mail service's keys
   * are, so a copied database alone cannot report for the site; one kept before as plain text is
   * sealed the next time it is read.
   */
  public static String agentsKey(Install runlight, String site, boolean replace) {
    String name = "observe-key:" + site;
    if (!replace) {
      String made = Secret.seal("rlo_" + Hash.randomId(20), runlight.secret());
      String stored = runlight.store().settingOrAdd(name, () -> made);
      String key = openAgentsKey(runlight, stored);
      if (key != null && stored.startsWith("rlo_")) {
        runlight.store().setSetting(name, Secret.seal(key, runlight.secret()));
      }
      // One sealed under a secret the server no longer has cannot be shown or checked, so it is
      // replaced.
      if (key != null) {
        return key;
      }
    }
    String key = "rlo_" + Hash.randomId(20);
    runlight.store().setSetting(name, Secret.seal(key, runlight.secret()));
    return key;
  }

  /**
   * A site's agents key as kept in its setting: sealed, or plain text from before keys were sealed.
   * Null when it cannot be opened.
   */
  public static String openAgentsKey(Install runlight, String stored) {
    return stored.startsWith("rlo_") ? stored : Secret.unseal(stored, runlight.secret());
  }

  /** A redirect address's host as a site's domains are kept: lowercase, with no port and no www. */
  private static String siteHost(String redirect) {
    return TRAILING_DOTS
        .matcher(Js.lower(new Url(redirect).hostname))
        .replaceFirst("")
        .replaceFirst("^www\\.", "");
  }

  public static final long CODE_MS = 5 * 60_000L;

  /**
   * An app stored before client ids were signed, which never finished connecting within a day, is
   * removed.
   */
  public static final long UNUSED_CLIENT_MS = 86_400_000L;

  /** Registrations one address may make a minute. */
  public static final int REGISTRATIONS_PER_MINUTE = 10;

  /** The longest client id, which carries the app's name and redirect addresses. */
  public static final int MAX_CLIENT_ID = 2048;

  private static final Pattern STORED_ID = Pattern.compile("^[a-f0-9]{32}\\z");
  private static final Pattern SIGNED_ID =
      Pattern.compile("^([A-Za-z0-9_-]{1,2000})\\.([a-f0-9]{64})\\z");
  private static final Pattern CHALLENGE = Pattern.compile("^[A-Za-z0-9_-]{43,128}\\z");
  private static final Pattern HTTPS = Pattern.compile("^https://[^/]+");
  private static final Pattern LOOPBACK =
      Pattern.compile("^http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?/");
  private static final Pattern TRAILING_DOTS = Pattern.compile("\\.+$");
  private static final Pattern SPACES = Pattern.compile("[" + Js.SPACE + "]+");

  /** Per install, the per-address limit on registrations. */
  private static final Map<Install, RateLimit> REGISTRATIONS = new WeakHashMap<>();

  private static RateLimit registrations(Install runlight) {
    synchronized (REGISTRATIONS) {
      // The clock holds the install weakly, or the limit would keep its own key alive.
      WeakReference<Install> install = new WeakReference<>(runlight);
      return REGISTRATIONS.computeIfAbsent(
          runlight,
          k ->
              new RateLimit(
                  REGISTRATIONS_PER_MINUTE,
                  () -> {
                    Install held = install.get();
                    return held == null ? 0 : held.now();
                  }));
    }
  }

  private static String base64url(String text) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(Js.utf8(text));
  }

  private static String fromBase64url(String text) {
    return Js.decodeUtf8(Base64.getUrlDecoder().decode(text));
  }

  /**
   * The key client ids are signed with, made on first use and kept in the database for every
   * process.
   */
  private static String clientKey(Install runlight) {
    // Written only if no other request wrote one first, so every process signs with the same key.
    return runlight.store().settingOrAdd("oauth-key", () -> Hash.randomId(32));
  }

  /** The app a client id names (client), and where to note that it connected (usedKey). */
  private record Found(Map<String, Object> client, String usedKey) {}

  /**
   * The app a client id names, and where to note that it connected. A new id carries the app's name
   * and addresses, signed, so registering stores nothing and a flood of registrations fills
   * nothing. Ids from before that were stored.
   */
  private static Found clientFor(Install runlight, String id) {
    if (STORED_ID.matcher(id).find()) {
      String stored = runlight.store().setting("oauth-client:" + id);
      return stored != null && !stored.isEmpty()
          ? new Found(Js.map(Json.parse(stored)), "oauth-client:" + id)
          : null;
    }
    Matcher parts = SIGNED_ID.matcher(id);
    if (!parts.find() || id.length() > MAX_CLIENT_ID) {
      return null;
    }
    if (!constantTimeEqual(parts.group(2), Hash.hmac(clientKey(runlight), parts.group(1)))) {
      return null;
    }
    Object meta = Json.parse(fromBase64url(parts.group(1)));
    String usedKey = "oauth-used:" + Hash.sha256(id);
    String used = runlight.store().setting(usedKey);
    Map<String, Object> client =
        Json.object(
            "name",
            Js.get(meta, "n"),
            "redirects",
            Js.get(meta, "r"),
            "createdAt",
            Js.get(meta, "t"));
    if (used != null && !used.isEmpty()) {
      client.put("usedAt", Js.num(Js.toNumber(used)));
    }
    return new Found(client, usedKey);
  }

  private static boolean constantTimeEqual(String a, String b) {
    return a.length() == b.length()
        && MessageDigest.isEqual(
            a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
  }

  private static String esc(String value) {
    StringBuilder out = new StringBuilder(value.length());
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '&' -> out.append("&amp;");
        case '<' -> out.append("&lt;");
        case '>' -> out.append("&gt;");
        case '"' -> out.append("&quot;");
        case '\'' -> out.append("&#39;");
        default -> out.append(c);
      }
    }
    return out.toString();
  }

  private static String esc(Object value) {
    return esc(Js.string(value));
  }

  private static Headers cors(Headers headers) {
    headers.set("access-control-allow-origin", "*");
    headers.set(
        "access-control-allow-headers", "authorization, content-type, mcp-protocol-version");
    headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
    return headers;
  }

  private static Response json(Object body, int status) {
    return new Response(
        Json.stringify(body),
        status,
        cors(
            Headers.of(
                "content-type",
                "application/json; charset=utf-8",
                "cache-control",
                "no-store",
                "x-content-type-options",
                "nosniff")));
  }

  private static Response json(Object body) {
    return json(body, 200);
  }

  private static Response oauthError(String error, String description, int status) {
    return json(Json.object("error", error, "error_description", description), status);
  }

  private static Response oauthError(String error, String description) {
    return oauthError(error, description, 400);
  }

  /** base64url of SHA-256, as PKCE's S256 method compares. */
  public static String s256(String verifier) {
    return Base64.getUrlEncoder()
        .withoutPadding()
        .encodeToString(Hash.sha256Bytes(Js.utf8(verifier)));
  }

  /** Redirect addresses a client may register: https, or a local app's own loopback address. */
  private static boolean allowedRedirect(String value) {
    return HTTPS.matcher(value).find() || LOOPBACK.matcher(value).find();
  }

  /** The URL that a 401 from the MCP endpoint points clients at, to start OAuth. */
  public static String resourceMetadataUrl(String origin, String base) {
    return origin + base + "/.well-known/oauth-protected-resource";
  }

  private static Response noStoreRedirect(String location) {
    return new Response("", 303, Headers.of("location", location, "cache-control", "no-store"));
  }

  /** Answers the OAuth paths with no request context, or returns null for anything else. */
  public static Response oauthResponse(Context ctx, Request request, String path, Url url) {
    return oauthResponse(ctx, request, path, url, Map.of());
  }

  /**
   * Answers the OAuth paths, or returns null for anything else. {@code path} is relative to the
   * routes' base; the two well-known documents are also answered at the site's root ({@code
   * /.well-known/...}) for clients that look there.
   *
   * @param context the request context (ip and the rest) the Runlight reads the client's address
   *     from
   */
  public static Response oauthResponse(
      Context ctx, Request request, String path, Url url, Map<String, Object> context) {
    Install runlight = ctx.runlight;
    String base = ctx.base;
    String issuer = url.origin() + base;
    String known = path;
    String method = request.method();
    if (method.equals("OPTIONS")
        && (known.startsWith("/.well-known/oauth-")
            || known.startsWith("/.well-known/openid-configuration")
            || path.startsWith("/oauth/"))) {
      return new Response("", 204, cors(new Headers()));
    }

    if (known.startsWith("/.well-known/oauth-protected-resource")) {
      return json(
          Json.object(
              "resource",
              issuer + "/mcp",
              "authorization_servers",
              List.of(issuer),
              "scopes_supported",
              SCOPES,
              "bearer_methods_supported",
              List.of("header")));
    }
    if (known.startsWith("/.well-known/oauth-authorization-server")
        || known.startsWith("/.well-known/openid-configuration")) {
      return json(
          Json.object(
              "issuer",
              issuer,
              "authorization_endpoint",
              issuer + "/oauth/authorize",
              "token_endpoint",
              issuer + "/oauth/token",
              "registration_endpoint",
              issuer + "/oauth/register",
              "response_types_supported",
              List.of("code"),
              "grant_types_supported",
              List.of("authorization_code"),
              "code_challenge_methods_supported",
              List.of("S256"),
              "token_endpoint_auth_methods_supported",
              List.of("none"),
              "scopes_supported",
              SCOPES));
    }

    if (path.equals("/oauth/register") && method.equals("POST")) {
      runlight.init();
      if (!registrations(runlight).allow(runlight.clientIp(request, context))) {
        return oauthError(
            "invalid_client_metadata",
            "Too many registrations from this address. Wait a minute and try again.",
            429);
      }
      Json.Parsed parsed = Json.tryParse(request.text());
      Object body = parsed.ok() ? parsed.value() : null;
      Object uris = body == null ? Json.UNDEFINED : Js.get(body, "redirect_uris");
      List<String> redirects = new ArrayList<>();
      if (uris instanceof List<?> list) {
        for (Object uri : list) {
          String text = Js.string(uri);
          if (allowedRedirect(text) && redirects.size() < 10) {
            redirects.add(text);
          }
        }
      }
      if (redirects.isEmpty()) {
        return oauthError("invalid_redirect_uri", "Register at least one https redirect address");
      }
      Object name = body == null ? Json.UNDEFINED : Js.get(body, "client_name");
      return register(
          runlight, Js.string(name == null || name == Json.UNDEFINED ? "An app" : name), redirects);
    }

    if (path.equals("/oauth/authorize") && (method.equals("GET") || method.equals("POST"))) {
      return authorize(ctx, request, url, base);
    }

    if (path.equals("/oauth/token") && method.equals("POST")) {
      return token(ctx, request);
    }

    return null;
  }

  private static Response authorize(Context ctx, Request request, Url url, String base) {
    Install runlight = ctx.runlight;
    runlight.init();
    Messages.Translator t = Messages.translator(Messages.acceptedLanguage(request));
    String lang = t.lang();
    boolean post = request.method().equals("POST");
    SearchParams form = post ? new SearchParams(request.text()) : url.searchParams();
    String clientId = orEmpty(form.get("client_id"));
    Found found = clientFor(runlight, clientId);
    Map<String, Object> client = found == null ? null : found.client();
    String redirect = orEmpty(form.get("redirect_uri"));
    // Without a known client and one of its own addresses there is nowhere safe to send an answer.
    if (client == null
        || !(client.get("redirects") instanceof List<?> redirects)
        || !redirects.contains(redirect)) {
      return page(
          lang,
          t.html("oauth.unregisteredTitle"),
          "<p>" + t.html("oauth.startAgain") + "</p>",
          400);
    }
    Function<Map<String, String>, Response> back =
        params -> {
          Url to = new Url(redirect);
          SearchParams query = to.searchParams();
          for (Map.Entry<String, String> e : params.entrySet()) {
            query.set(e.getKey(), e.getValue());
          }
          String state = form.get("state");
          if (state != null && !state.isEmpty()) {
            query.set("state", state);
          }
          to.setSearchParams(query);
          return noStoreRedirect(to.href());
        };
    String name = Js.string(client.get("name"));
    // Anyone can register an app with any address, so until an owner has allowed it once, a
    // request it got wrong ends on a page here rather than sending a visitor who is not signed in
    // on to it.
    Function<Map<String, String>, Response> refuse =
        params ->
            Js.truthy(client.get("usedAt"))
                ? back.apply(params)
                : page(
                    lang,
                    t.html("oauth.unsupportedTitle"),
                    "<p>"
                        + t.html(
                            "oauth.unsupported",
                            Map.of(
                                "app",
                                esc(name),
                                "error",
                                esc(
                                    params.containsKey("error_description")
                                        ? params.get("error_description")
                                        : params.get("error"))))
                        + "</p>",
                    400);
    if (!"code".equals(form.get("response_type"))) {
      return refuse.apply(ordered("error", "unsupported_response_type"));
    }
    String challenge = orEmpty(form.get("code_challenge"));
    if (!"S256".equals(form.get("code_challenge_method")) || !CHALLENGE.matcher(challenge).find()) {
      return refuse.apply(
          ordered("error", "invalid_request", "error_description", "PKCE with S256 is required"));
    }
    List<String> scopes = List.of(SPACES.split(orEmpty(form.get("scope")), -1));
    boolean cms = scopes.contains("cms");
    boolean manage = !cms && scopes.contains("manage");
    // A CMS plugin is for the site it runs on: one of the sites counting its admin's domain, or a
    // new one for it.
    String host = siteHost(redirect);
    // As the tracker counts: a site that lists the domain, or the only site here when it lists
    // none, which counts any.
    List<Map<String, Object>> local = new ArrayList<>();
    for (Map<String, Object> s : runlight.sites()) {
      if (runlight.remote(Js.string(s.get("id"))) == null) {
        local.add(s);
      }
    }
    List<Map<String, Object>> counting = new ArrayList<>();
    if (local.size() == 1
        && !(local.get(0).get("hostnames") instanceof List<?> listed && !listed.isEmpty())) {
      counting.add(local.get(0));
    } else {
      for (Map<String, Object> s : local) {
        if (s.get("hostnames") instanceof List<?> hostnames && hostnames.contains(host)) {
          counting.add(s);
        }
      }
    }

    if (!ctx.isOwner.test(request)) {
      // Someone signed in who may only read would be sent to sign in again and again.
      if (ctx.isReader != null && ctx.isReader.test(request)) {
        return page(
            lang,
            t.html("oauth.viewerTitle"),
            "<p>" + t.html("oauth.viewer", Map.of("app", esc(name))) + "</p>",
            403);
      }
      // The site stays, since on the way in it only says which one to offer first.
      SearchParams kept = new SearchParams();
      for (Map.Entry<String, String> e : form.entries()) {
        if (!e.getKey().equals("decision")) {
          kept.append(e.getKey(), e.getValue());
        }
      }
      String here = url.pathname + "?" + kept;
      if (ctx.signIn != null && !ctx.signIn.isEmpty()) {
        return noStoreRedirect(ctx.signIn + "?next=" + Js.encodeURIComponent(here));
      }
      String home = base.isEmpty() ? "/" : base;
      return page(
          lang,
          t.html("oauth.signInTitle"),
          "<p>"
              + t.html(
                  "oauth.signIn",
                  Map.of(
                      "link",
                      "<a href=\"" + esc(home) + "\">" + esc(url.host() + home) + "</a>",
                      "app",
                      esc(name)))
              + "</p>",
          401);
    }

    if (!post) {
      StringBuilder hidden = new StringBuilder();
      for (String k :
          List.of(
              "response_type",
              "client_id",
              "redirect_uri",
              "code_challenge",
              "code_challenge_method",
              "state",
              "scope",
              "resource")) {
        if (form.get(k) != null) {
          hidden
              .append("<input type=\"hidden\" name=\"")
              .append(k)
              .append("\" value=\"")
              .append(esc(form.get(k)))
              .append("\">");
        }
      }
      if (ctx.csrf != null) {
        hidden
            .append("<input type=\"hidden\" name=\"csrf\" value=\"")
            .append(esc(ctx.csrf.get()))
            .append("\">");
      }
      // The app names itself, so the page also shows where the answer goes, which it cannot fake.
      String sendsTo =
          "<p class=\"note\">"
              + t.html(
                  "oauth.sendsTo",
                  Map.of("host", "<strong>" + esc(new Url(redirect).host()) + "</strong>"))
              + "</p>";
      List<Map<String, Object>> sites = runlight.sites();
      String buttons =
          "<div class=\"buttons\"><button type=\"submit\" name=\"decision\" value=\"deny\""
              + " class=\"ghost\">"
              + t.html("oauth.deny")
              + "</button><button type=\"submit\" name=\"decision\""
              + " value=\"allow\">"
              + t.html("oauth.allow")
              + "</button></div></form>";
      String formStart = "<form method=\"post\" action=\"" + esc(base) + "/oauth/authorize\">";
      if (cms) {
        if (counting.isEmpty() && !runlight.managedSites()) {
          return page(
              lang,
              t.html("oauth.addSiteTitle"),
              "<p>"
                  + t.html(
                      "oauth.addSite",
                      Map.of("host", "<strong>" + esc(host) + "</strong>", "app", esc(name)))
                  + "</p>",
              400);
        }
        StringBuilder choices = new StringBuilder();
        for (Map<String, Object> s : counting) {
          choices
              .append("<option value=\"")
              .append(esc(s.get("id")))
              .append("\">")
              .append(esc(s.get("name")))
              .append("</option>");
        }
        if (runlight.managedSites() && counting.isEmpty()) {
          choices
              .append("<option value=\"new\">")
              .append(t.html("oauth.newSite", Map.of("host", esc(host))))
              .append("</option>");
        }
        return page(
            lang,
            t.html("oauth.connectTitle", Map.of("app", esc(name))),
            "<p>"
                + t.html(
                    "oauth.cmsIntro",
                    Map.of(
                        "app", "<strong>" + esc(name) + "</strong>",
                        "host", "<strong>" + esc(host) + "</strong>"))
                + "</p>\n"
                + "<p>"
                + t.html("oauth.cmsDetail")
                + "</p>\n"
                + sendsTo
                + "\n"
                + formStart
                + hidden
                + "\n"
                + "<label>"
                + t.html("app.site")
                + "<select name=\"site\">"
                + choices
                + "</select></label>\n"
                + "<p class=\"note\">"
                + t.html("oauth.cmsNote", Map.of("app", esc(name)))
                + "</p>\n"
                + buttons,
            200);
      }
      if (manage) {
        // Changing settings is for one site at a time, so there is no "every site" here.
        String wanted = orEmpty(form.get("site"));
        StringBuilder choices = new StringBuilder();
        for (Map<String, Object> s : sites) {
          String id = Js.string(s.get("id"));
          if (runlight.remote(id) == null) {
            choices
                .append("<option value=\"")
                .append(esc(id))
                .append('"')
                .append(id.equals(wanted) ? " selected" : "")
                .append('>')
                .append(esc(s.get("name")))
                .append("</option>");
          }
        }
        return page(
            lang,
            t.html("oauth.connectTitle", Map.of("app", esc(name))),
            "<p>"
                + t.html("oauth.manageIntro", Map.of("app", "<strong>" + esc(name) + "</strong>"))
                + "</p>\n"
                + "<p>"
                + t.html("oauth.manageDetail")
                + "</p>\n"
                + sendsTo
                + "\n"
                + formStart
                + hidden
                + "\n"
                + "<label>"
                + t.html("app.site")
                + "<select name=\"site\">"
                + choices
                + "</select></label>\n"
                + "<p class=\"note\">"
                + t.html("oauth.manageNote", Map.of("app", esc(name)))
                + "</p>\n"
                + buttons,
            200);
      }
      StringBuilder options = new StringBuilder();
      for (Map<String, Object> s : sites) {
        options
            .append("<option value=\"")
            .append(esc(s.get("id")))
            .append("\">")
            .append(t.html("oauth.siteOnly", Map.of("site", esc(s.get("name")))))
            .append("</option>");
      }
      return page(
          lang,
          t.html("oauth.connectTitle", Map.of("app", esc(name))),
          "<p>"
              + t.html("oauth.readIntro", Map.of("app", "<strong>" + esc(name) + "</strong>"))
              + "</p>\n"
              + sendsTo
              + "\n"
              + formStart
              + hidden
              + "\n"
              + "<label>"
              + t.html("oauth.readSites")
              + "<select name=\"site\"><option value=\"\">"
              + t.html("tokens.allSites")
              + "</option>"
              + (sites.size() > 1 ? options : "")
              + "</select></label>\n"
              + "<p class=\"note\">"
              + t.html("oauth.readNote")
              + "</p>\n"
              + buttons,
          200);
    }
    // The consent form posts here from this page only; a form from another site is refused.
    String origin = request.headers().get("origin");
    if (origin != null && !origin.isEmpty() && !origin.equals(url.origin())) {
      return page(
          lang, t.html("oauth.anotherSiteTitle"), "<p>" + t.html("oauth.startAgain") + "</p>", 403);
    }
    if (!"allow".equals(form.get("decision"))) {
      return back.apply(ordered("error", "access_denied"));
    }
    String site = orEmpty(form.get("site"));
    if (cms) {
      if (site.equals("new")) {
        try {
          site =
              !counting.isEmpty()
                  ? Js.string(counting.get(0).get("id"))
                  : runlight.managedSites()
                      ? Js.string(
                          runlight.addSite(Json.object("hostnames", List.of(host))).get("id"))
                      : "";
        } catch (SettingsError | RangeError error) {
          // Such as an address, which a site cannot count by: there is no new site to make.
          return back.apply(
              ordered("error", "invalid_request", "error_description", error.getMessage()));
        }
      } else {
        String picked = site;
        if (counting.stream().noneMatch(s -> picked.equals(s.get("id")))) {
          site = "";
        }
      }
      if (site.isEmpty()) {
        return back.apply(
            ordered(
                "error",
                "invalid_request",
                "error_description",
                "Pick a site that counts " + host));
      }
    }
    if (!site.isEmpty() && runlight.site(site) == null) {
      return back.apply(ordered("error", "invalid_request", "error_description", "Unknown site"));
    }
    if (manage && (site.isEmpty() || runlight.remote(site) != null)) {
      return back.apply(
          ordered("error", "invalid_request", "error_description", "Pick the site to manage"));
    }
    String code = Hash.randomId(32);
    String by = ctx.accountOf == null ? null : ctx.accountOf.apply(request);
    Map<String, Object> grant =
        Json.object(
            "client",
            clientId,
            "redirect",
            redirect,
            "challenge",
            challenge,
            "site",
            site,
            "scope",
            cms ? "cms" : manage ? "manage" : "read",
            "expires",
            runlight.now() + CODE_MS);
    if (by != null && !by.isEmpty()) {
      grant.put("by", by);
    }
    runlight.store().setSetting("oauth-code:" + Hash.sha256(code), Json.stringify(grant));
    return back.apply(ordered("code", code));
  }

  private static Response token(Context ctx, Request request) {
    Install runlight = ctx.runlight;
    runlight.init();
    String contentType = request.headers().get("content-type");
    String type = Js.trim((contentType == null ? "" : contentType).split(";", -1)[0]);
    SearchParams form =
        type.equals("application/json")
            ? jsonForm(request.text())
            : new SearchParams(request.text());
    if (!"authorization_code".equals(form.get("grant_type"))) {
      return oauthError("unsupported_grant_type", "Only authorization_code is supported");
    }
    String key = "oauth-code:" + Hash.sha256(orEmpty(form.get("code")));
    // A code works once: it is gone before anything else is checked, and of two swaps at once only
    // one gets it.
    String stored = runlight.store().takeSetting(key);
    Map<String, Object> grant =
        stored != null && !stored.isEmpty() ? Js.map(Json.parse(stored)) : null;
    if (grant == null || Js.asDouble(grant.get("expires")) < runlight.now()) {
      return oauthError("invalid_grant", "The code has expired or was already used");
    }
    if (!Js.same(grant.get("client"), form.get("client_id"))
        || !Js.same(grant.get("redirect"), form.get("redirect_uri"))) {
      return oauthError("invalid_grant", "The code was issued to another app");
    }
    if (!Js.same(s256(orEmpty(form.get("code_verifier"))), grant.get("challenge"))) {
      return oauthError("invalid_grant", "The code verifier does not match");
    }
    // The first row an app gets here: it has connected, so a request it gets wrong may go back to
    // it.
    Found found = clientFor(runlight, Js.string(grant.get("client")));
    Map<String, Object> client = found == null ? Map.of() : found.client();
    if (found != null && !Js.truthy(found.client().get("usedAt"))) {
      boolean storedClient = found.usedKey().startsWith("oauth-client:");
      Map<String, Object> used = new LinkedHashMap<>(found.client());
      used.put("usedAt", runlight.now());
      runlight
          .store()
          .setSetting(
              found.usedKey(), storedClient ? Json.stringify(used) : Long.toString(runlight.now()));
    }
    String secret = "rl_" + Hash.randomId(20);
    String scope =
        "cms".equals(grant.get("scope"))
            ? "cms"
            : "manage".equals(grant.get("scope")) ? "manage" : "read";
    Object clientName = client.get("name");
    Map<String, Object> row =
        Json.object(
            "id",
            Hash.randomId(),
            "name",
            Js.slice(Js.string(clientName == null ? "An app" : clientName) + " (OAuth)", 0, 100),
            "site",
            grant.get("site"),
            "scope",
            // A CMS plugin's token is the site's dashboard key, which only opens its read-only
            // dashboard there.
            scope.equals("cms") ? "embed" : scope,
            "hash",
            Hash.sha256(secret),
            "hint",
            Js.slice(secret, -4),
            "createdAt",
            runlight.now(),
            "lastUsedAt",
            null);
    runlight.store().insertToken(row);
    // Someone removed, or no longer an owner, between allowing the app and its swapping the code
    // gets nothing.
    Object by = grant.get("by");
    if (Js.truthy(by) && ctx.tokenMade != null && !ctx.tokenMade.test(row, Js.string(by))) {
      runlight.store().deleteToken((String) row.get("id"));
      return oauthError("invalid_grant", "Whoever allowed this app can no longer connect it");
    }
    // A hub's own address, from where it asked to be sent back, so the picker only ever sends
    // choices there.
    if (scope.equals("manage")) {
      runlight
          .store()
          .setSetting(
              "token-origin:" + row.get("id"), new Url(Js.string(grant.get("redirect"))).origin());
    }
    // A CMS plugin gets the site's agents key too, so connecting fills in every key its settings
    // ask for.
    if (scope.equals("cms")) {
      String site = Js.string(grant.get("site"));
      return json(
          Json.object(
              "access_token",
              secret,
              "token_type",
              "Bearer",
              "scope",
              scope,
              "site",
              site,
              "agents_key",
              agentsKey(runlight, site, false)));
    }
    // site is not part of OAuth, but a hub needs to know which site it was given.
    Map<String, Object> answer =
        Json.object("access_token", secret, "token_type", "Bearer", "scope", scope);
    if (Js.truthy(grant.get("site"))) {
      answer.put("site", grant.get("site"));
    }
    return json(answer);
  }

  private static String orEmpty(String value) {
    return value == null ? "" : value;
  }

  /** An ordered map of name and value pairs. */
  private static Map<String, String> ordered(String... pairs) {
    Map<String, String> out = new LinkedHashMap<>();
    for (int i = 0; i + 1 < pairs.length; i += 2) {
      out.put(pairs[i], pairs[i + 1]);
    }
    return out;
  }

  /**
   * {@code new URLSearchParams(Object.entries(await request.json() ?? {}))}, each value as String()
   * writes it.
   */
  private static SearchParams jsonForm(String text) {
    Json.Parsed parsed = Json.tryParse(text);
    SearchParams form = new SearchParams();
    if (!parsed.ok() || parsed.value() == null) {
      return form;
    }
    Object body = parsed.value();
    if (body instanceof Map<?, ?> map) {
      for (Map.Entry<String, Object> e : Js.entries(map)) {
        form.append(e.getKey(), Js.string(e.getValue()));
      }
    } else if (body instanceof List<?> list) {
      for (int i = 0; i < list.size(); i++) {
        form.append(Integer.toString(i), Js.string(list.get(i)));
      }
    } else if (body instanceof String s) {
      for (int i = 0; i < s.length(); i++) {
        form.append(Integer.toString(i), String.valueOf(s.charAt(i)));
      }
    }
    return form;
  }

  /**
   * Registers a client by signing its name and addresses into its id, so nothing is stored until an
   * owner allows it and the app swaps its code.
   */
  private static Response register(Install runlight, String name, List<String> redirects) {
    long now = runlight.now();
    SqlStore store = runlight.store();
    // Apps stored before ids were signed, which never connected, and codes nobody exchanged are
    // cleared away.
    for (Map<String, Object> entry : store.settingsStartingWith("oauth-client:")) {
      Object client = Json.parse((String) entry.get("value"));
      if (!Js.truthy(Js.get(client, "usedAt"))
          && now - Js.asDouble(Js.get(client, "createdAt")) >= UNUSED_CLIENT_MS) {
        store.setSetting((String) entry.get("key"), null);
      }
    }
    for (Map<String, Object> entry : store.settingsStartingWith("oauth-code:")) {
      Object expires = Js.get(Json.parse((String) entry.get("value")), "expires");
      if (Js.asDouble(expires == null || expires == Json.UNDEFINED ? 0L : expires) < now) {
        store.setSetting((String) entry.get("key"), null);
      }
    }
    String trimmed = Js.slice(Js.trim(name), 0, 80);
    String clientName = trimmed.isEmpty() ? "An app" : trimmed;
    String payload =
        base64url(Json.stringify(Json.object("n", clientName, "r", redirects, "t", now)));
    String id = payload + "." + Hash.hmac(clientKey(runlight), payload);
    if (id.length() > MAX_CLIENT_ID) {
      return oauthError("invalid_client_metadata", "Register fewer or shorter redirect addresses");
    }
    return json(
        Json.object(
            "client_id",
            id,
            "client_name",
            clientName,
            "redirect_uris",
            redirects,
            "token_endpoint_auth_method",
            "none",
            "grant_types",
            List.of("authorization_code"),
            "response_types",
            List.of("code")),
        201);
  }

  private static final String STYLE =
      "<style>:root{color-scheme:light dark;--page:#f4f4f5;--card:#fff;--ink:#111827;"
          + "--muted:#4b5563;--line:#e5e7eb}@media (prefers-color-scheme:dark){:root{--page:#09090b;"
          + "--card:#141417;--ink:#fafafa;--muted:#a1a1aa;--line:#27272a}}body{margin:0;"
          + "min-height:100vh;display:grid;place-items:center;background:var(--page);"
          + "color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\","
          + "Helvetica,Arial,sans-serif}main{width:min(440px,calc(100% - 32px));padding:28px;"
          + "background:var(--card);border:1px solid var(--line);border-radius:14px}"
          + "h1{font-size:20px;margin:0 0 12px}p{margin:0 0 16px;color:var(--muted)}"
          + "p strong{color:var(--ink)}a{color:inherit}label{display:block;margin:0 0 14px;"
          + "font-size:13px;font-weight:600}select{display:block;width:100%;height:40px;"
          + "margin-top:6px;padding:0 36px 0 12px;border:1px solid var(--line);border-radius:8px;"
          + "background:var(--card) url(\"data:image/svg+xml,%3Csvg"
          + " xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4'"
          + " fill='none' stroke='%238a8a93' stroke-width='1.6' stroke-linecap='round'"
          + " stroke-linejoin='round'/%3E%3C/svg%3E\") right 12px center/14px no-repeat;"
          + "color:var(--ink);font:inherit;font-weight:400;appearance:none;cursor:pointer}"
          + ".note{font-size:13px}.buttons{display:flex;justify-content:flex-end;gap:8px}"
          + "button{height:40px;padding:0 18px;border:0;border-radius:8px;background:var(--ink);"
          + "color:var(--card);font:inherit;font-weight:600;cursor:pointer}"
          + "button.ghost{background:none;color:var(--ink);border:1px solid var(--line)}</style>";

  private static Response page(String lang, String title, String body, int status) {
    return new Response(
        "<!doctype html><html lang=\""
            + lang
            + "\"><head><meta charset=\"utf-8\"><meta name=\"viewport\""
            + " content=\"width=device-width,initial-scale=1\"><meta name=\"robots\""
            + " content=\"noindex\"><title>"
            + title
            + " | Runlight</title>\n"
            + STYLE
            + "</head><body><main><h1>"
            + title
            + "</h1>"
            + body
            + "</main></body></html>",
        status,
        Headers.of(
            "content-type",
            "text/html; charset=utf-8",
            "cache-control",
            "no-store",
            // No form-action rule: browsers apply it to the redirect back to the app after Allow.
            "content-security-policy",
            "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none';"
                + " frame-ancestors 'none'",
            "x-frame-options",
            "DENY",
            // same-origin, not no-referrer: under no-referrer a form post carries Origin: null,
            // which the consent check refuses.
            "referrer-policy",
            "same-origin"));
  }
}

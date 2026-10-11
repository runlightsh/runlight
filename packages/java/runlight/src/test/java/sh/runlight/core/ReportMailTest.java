package sh.runlight.core;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static sh.runlight.core.Harness.utc;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import sh.runlight.Fixtures;
import sh.runlight.Hash;
import sh.runlight.Js;
import sh.runlight.Json;
import sh.runlight.RecordingFetcher;
import sh.runlight.Reports;
import sh.runlight.Routes;
import sh.runlight.Runlight;
import sh.runlight.http.Response;
import sh.runlight.mail.AppMailer;
import sh.runlight.mail.MailError;
import sh.runlight.mail.Transports;
import sh.runlight.routes.Make;
import sh.runlight.store.SqlStore;
import sh.runlight.store.Stores;

/**
 * The mail service's settings and the reports sent through it, as mail.test.ts and audit.test.ts
 * test them without routes, and the app's own mailer, through the routes as mail.test.ts tests it.
 */
class ReportMailTest {
  private int status = 200;
  private final RecordingFetcher fetcher =
      new RecordingFetcher((url, init) -> new Response(status == 200 ? "{}" : "nope", status));

  private Runlight runlight(AtomicLong now, Runlight.Options options) {
    return new Runlight(options.store(Stores.sqlite(":memory:")).now(now::get).fetcher(fetcher));
  }

  private static Runlight.Options example(String timezone) {
    return new Runlight.Options()
        .site(
            Json.object(
                "name", "Example", "hostnames", List.of("example.com"), "timezone", timezone));
  }

  /** A report as the routes add one: a period already due counts as sent. */
  private static void addReport(Runlight rl, String email, String frequency, String lang) {
    Map<String, Object> site = rl.site("default");
    Map<String, Object> due =
        Reports.lastPeriod(frequency, rl.now(), (String) site.get("timezone"));
    Map<String, Object> r = new LinkedHashMap<>();
    r.put("id", Hash.randomId());
    r.put("site", "default");
    r.put("email", email);
    r.put("frequency", frequency);
    r.put("lang", lang);
    r.put("token", Hash.randomId(16));
    r.put("origin", "https://stats.example.com/runlight");
    r.put("lastPeriod", rl.now() >= Js.asLong(due.get("dueAt")) ? due.get("key") : "");
    r.put("lastSentAt", null);
    r.put("createdAt", rl.now());
    rl.store.insertReport(r);
  }

  private static MailError mailError(Executable fn) {
    return assertThrows(MailError.class, fn);
  }

  private static Map<String, Object> counts(long sent, long failed) {
    return Json.object("sent", sent, "failed", failed);
  }

  private Map<String, Object> body(int index) {
    return Js.map(Json.parse((String) fetcher.requests.get(index).get("body")));
  }

  @Test
  void reportsGoOutOncePerPeriodRetryAfterAFailureAndKeepKeysFromTheBrowser() {
    AtomicLong now = new AtomicLong(utc(2026, 10, 8, 15));
    Runlight rl = runlight(now, example("America/Toronto").secret("s3cret"));
    rl.init();

    MailError badFrom =
        mailError(
            () ->
                rl.saveMailSettings(
                    Json.object(
                        "service", "resend", "apiKey", "re_live_key", "from", "not an address")));
    assertEquals("mail_from", badFrom.code(), "a code the dashboard says in its own language");
    Fixtures.assertJson(Map.of(), badFrom.params());
    MailError noKey =
        mailError(
            () ->
                rl.saveMailSettings(
                    Json.object("service", "resend", "apiKey", "", "from", "reports@example.com")));
    assertEquals("mail_field", noKey.code());
    Fixtures.assertJson(Json.object("field", "apiKey"), noKey.params());
    assertEquals(
        "mail_service",
        mailError(() -> rl.saveMailSettings(Json.object("service", "pigeon"))).code());
    rl.saveMailSettings(
        Json.object(
            "service",
            "resend",
            "apiKey",
            "re_live_key",
            "from",
            "reports@example.com",
            "fromName",
            "Runlight"));
    String stored = rl.store.setting("mail");
    assertTrue(stored.startsWith("v1:"));
    assertFalse(stored.contains("re_live_key"), "the key is encrypted at rest");
    Fixtures.assertJson(
        Json.object(
            "service",
            "resend",
            "apiKey",
            "re_live_key",
            "from",
            "reports@example.com",
            "fromName",
            "Runlight",
            "source",
            "dashboard"),
        rl.mailSettings());
    // Saving again with the key left blank keeps it.
    rl.saveMailSettings(
        Json.object("service", "resend", "apiKey", "", "from", "reports@example.com"));
    assertEquals("re_live_key", rl.mailSettings().get("apiKey"));

    addReport(rl, "jon@example.com", "weekly", "fr");
    Fixtures.assertJson(
        counts(0, 0), rl.sendReports(), "a report added on a Wednesday waits for the next Monday");
    assertEquals(0, fetcher.requests.size());
    now.addAndGet(7 * 86_400_000L);
    status = 500;
    Fixtures.assertJson(counts(0, 1), rl.sendReports());
    status = 200;
    fetcher.requests.clear();
    Fixtures.assertJson(counts(1, 0), rl.sendReports(), "a failed send is tried again");
    Map<String, Object> body = body(0);
    assertEquals("https://api.resend.com/emails", fetcher.requests.get(0).get("url"));
    assertEquals("jon@example.com", Js.list(body.get("to")).get(0));
    assertEquals("Example : 0 personne la semaine dernière", body.get("subject"));
    String html = (String) body.get("html");
    assertTrue(html.contains("du 5 oct. au 11 oct. 2026"), html);
    assertTrue(
        html.contains("0 personne a visité le site la semaine dernière."),
        "French counts zero as one");
    Map<String, Object> headers = Js.map(body.get("headers"));
    assertTrue(
        ((String) headers.get("List-Unsubscribe"))
            .matches("^<https://stats\\.example\\.com/runlight/unsubscribe/[a-f0-9]{32}>\\z"));
    assertEquals("List-Unsubscribe=One-Click", headers.get("List-Unsubscribe-Post"));
    assertTrue(
        ((String) body.get("text")).contains("https://stats.example.com/runlight/?site=default"));
    Fixtures.assertJson(counts(0, 0), rl.sendReports(), "the same period never goes twice");
    now.addAndGet(7 * 86_400_000L);
    Fixtures.assertJson(counts(1, 0), rl.sendReports(), "the next week does");
    Fixtures.assertJson(Json.object("ok", true, "reports", counts(0, 0)), rl.check());
  }

  @Test
  void aReportAddedBeforeMondays8amStillGetsLastWeeks() {
    // Monday 5 October 2026, 7:00 in Toronto: last week is over and not yet due.
    AtomicLong now = new AtomicLong(utc(2026, 10, 5, 11));
    Runlight rl = runlight(now, example("America/Toronto"));
    rl.saveMailSettings(
        Json.object("service", "resend", "apiKey", "re_1", "from", "reports@example.com"));
    addReport(rl, "jon@example.com", "weekly", "en");
    addReport(rl, "jon@example.com", "monthly", "en");
    Fixtures.assertJson(counts(0, 0), rl.sendReports());
    now.addAndGet(2 * 3_600_000L);
    Fixtures.assertJson(counts(1, 0), rl.sendReports());
    assertTrue(((String) body(0).get("subject")).contains("last week"));
  }

  @Test
  void noMailServiceSendsNothingAndSayingSoIsAnError() {
    AtomicLong now = new AtomicLong(utc(2026, 10, 12, 15));
    Runlight rl = runlight(now, new Runlight.Options());
    rl.init();
    addReport(rl, "jon@example.com", "weekly", "en");
    rl.store.db().run("UPDATE rl_reports SET last_period = ''");
    Fixtures.assertJson(counts(0, 0), rl.sendReports());
    assertEquals(
        "mail_unset",
        mailError(
                () ->
                    rl.sendMail(
                        Json.object("to", "a@b.co", "subject", "s", "html", "h", "text", "t")))
            .code());
  }

  @Test
  void aMailServiceInCodeIsShownAndCannotBeChanged() {
    AtomicLong now = new AtomicLong(0);
    Runlight rl =
        runlight(
            now,
            new Runlight.Options()
                .mail(
                    Json.object(
                        "service", "resend", "apiKey", "re_code", "from", "r@example.com")));
    Fixtures.assertJson(
        Json.object(
            "service", "resend", "apiKey", "re_code", "from", "r@example.com", "source", "code"),
        rl.mailSettings());
    assertEquals("mail_in_code", mailError(() -> rl.saveMailSettings(null)).code());
    rl.sendMail(
        Json.object("to", "jon@example.com", "subject", "Hi", "html", "<p>Hi</p>", "text", "Hi"));
    assertEquals("r@example.com", body(0).get("from"));
  }

  @Test
  void aSavedSmtpPasswordIsKeptOnlyWhileTheServerItGoesToStaysTheSame() {
    AtomicLong now = new AtomicLong(0);
    Runlight rl = runlight(now, new Runlight.Options().secret("k".repeat(32)));
    rl.saveMailSettings(smtp("smtp.example.com", "hunter2-long", "r@example.com"));
    rl.saveMailSettings(smtp("smtp.example.com", "", "reports@example.com"));
    assertEquals(
        "hunter2-long", rl.mailSettings().get("password"), "same server, blank field: kept");
    rl.saveMailSettings(smtp("evil.example", "", "reports@example.com"));
    Object password = rl.mailSettings().get("password");
    assertEquals("", password == null ? "" : password, "a new host needs the password typed again");
    rl.saveMailSettings(null);
    assertNull(rl.mailSettings());
  }

  private static Map<String, Object> smtp(String host, String password, String from) {
    return Json.object(
        "service",
        "smtp",
        "host",
        host,
        "port",
        "587",
        "security",
        "starttls",
        "username",
        "me",
        "from",
        from,
        "password",
        password);
  }

  @Test
  void aKeySealedWithAnotherSecretReadsAsNoMailService() {
    SqlStore store = Stores.sqlite(":memory:");
    Runlight one = new Runlight(new Runlight.Options().store(store).secret("one"));
    one.saveMailSettings(
        Json.object("service", "resend", "apiKey", "re_1", "from", "r@example.com"));
    Runlight two = new Runlight(new Runlight.Options().store(store).secret("two"));
    assertNull(two.mailSettings());
  }

  @Test
  void theAppsOwnMailerSendsUntilAServiceSavedInTheDashboardTakesItsPlace() {
    AtomicLong now = new AtomicLong(utc(2026, 10, 5, 12));
    List<Map<String, Object>> sent = new ArrayList<>();
    AtomicReference<String> fail = new AtomicReference<>("");
    Runlight rl =
        runlight(
            now,
            example("UTC")
                .mail(
                    new AppMailer(
                        m -> {
                          if (!fail.get().isEmpty()) {
                            throw new IllegalStateException(fail.get());
                          }
                          sent.add(m);
                        },
                        "site@example.com",
                        "Example",
                        "WordPress (WP Mail SMTP)")));
    Routes routes = rl.routes(new Routes.Options().token("t"));
    MailCall call =
        (method, path, body) -> routes.handle(Make.owner("/runlight" + path, method, body, "t"));

    Map<String, Object> app = Make.body(call.call("GET", "/api/mail", null));
    Fixtures.assertJson(
        Json.object(
            "source",
            "app",
            "service",
            "",
            "from",
            "site@example.com",
            "fromName",
            "Example",
            "fields",
            Map.of(),
            "saved",
            List.of(),
            "app",
            Json.object(
                "via",
                "WordPress (WP Mail SMTP)",
                "from",
                "site@example.com",
                "fromName",
                "Example",
                "replaced",
                false)),
        Json.object(
            "source",
            app.get("source"),
            "service",
            app.get("service"),
            "from",
            app.get("from"),
            "fromName",
            app.get("fromName"),
            "fields",
            app.get("fields"),
            "saved",
            app.get("saved"),
            "app",
            app.get("app")));

    Map<String, Object> test = Json.object("to", "jon@example.com");
    assertEquals(200, call.call("POST", "/api/mail/test", test).status());
    assertEquals(1, sent.size());
    Fixtures.assertJson(
        List.of("jon@example.com", "site@example.com", "Example"),
        List.of(sent.get(0).get("to"), sent.get(0).get("from"), sent.get(0).get("fromName")));
    assertTrue(
        ((String) sent.get(0).get("text")).contains("WordPress (WP Mail SMTP)"),
        "the test names the app's mailer");

    // Reports go through it too, with the unsubscribe headers.
    assertEquals(
        201,
        call.call(
                "POST",
                "/api/reports",
                Json.object("email", "jon@example.com", "frequency", "weekly"))
            .status());
    now.addAndGet(7 * 86_400_000L);
    Fixtures.assertJson(counts(1, 0), rl.sendReports());
    Map<String, Object> headers = Js.map(sent.get(1).get("headers"));
    assertTrue(
        ((String) headers.get("List-Unsubscribe"))
            .matches("^<https://example\\.com/runlight/unsubscribe/[a-f0-9]{32}>\\z"));
    assertEquals("List-Unsubscribe=One-Click", headers.get("List-Unsubscribe-Post"));

    // A failure comes back as a mail error naming the mailer.
    fail.set("SMTP connect() failed");
    Response failed = call.call("POST", "/api/mail/test", test);
    assertEquals(400, failed.status());
    Fixtures.assertJson(
        Json.object(
            "error",
            "WordPress (WP Mail SMTP) could not send it: SMTP connect() failed",
            "code",
            "mail_app_failed",
            "params",
            Json.object("via", "WordPress (WP Mail SMTP)", "detail", "SMTP connect() failed")),
        Make.body(failed));
    fail.set("");

    // A service saved in the dashboard takes its place.
    assertEquals(
        200,
        call.call(
                "PUT",
                "/api/mail",
                Json.object(
                    "service", "resend", "apiKey", "re_live_key", "from", "reports@example.com"))
            .status());
    Map<String, Object> replaced = Make.body(call.call("GET", "/api/mail", null));
    Fixtures.assertJson(
        List.of(
            "dashboard",
            "resend",
            "reports@example.com",
            Json.object(
                "via",
                "WordPress (WP Mail SMTP)",
                "from",
                "site@example.com",
                "fromName",
                "Example",
                "replaced",
                true)),
        List.of(
            replaced.get("source"),
            replaced.get("service"),
            replaced.get("from"),
            replaced.get("app")));
    assertEquals(200, call.call("POST", "/api/mail/test", test).status());
    assertEquals(1, fetcher.requests.size(), "through the saved service");
    assertEquals(2, sent.size(), "and not the app's mailer");

    // Removing it goes back to the app's mailer.
    assertEquals(200, call.call("DELETE", "/api/mail", null).status());
    assertEquals("app", Make.body(call.call("GET", "/api/mail", null)).get("source"));
    assertEquals(200, call.call("POST", "/api/mail/test", test).status());
    assertEquals(3, sent.size());
  }

  @Test
  void theAppsMailerNeedsAFromAddressAndWithoutOneTheAnswerHasNoApp() {
    IllegalArgumentException noFrom =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                runlight(
                    new AtomicLong(0),
                    new Runlight.Options().mail(new AppMailer(m -> {}, "", "Drupal"))));
    assertTrue(noFrom.getMessage().contains("from address"), noFrom.getMessage());
    Runlight rl = runlight(new AtomicLong(0), new Runlight.Options());
    Map<String, Object> answer =
        Make.body(
            rl.routes(new Routes.Options().token("t"))
                .handle(Make.owner("/runlight/api/mail", "GET", null, "t")));
    assertNull(answer.get("source"));
    assertFalse(answer.containsKey("app"), "an install without an app mailer answers as before");
  }

  @Test
  void anAppsMailerWithNoViaIsNamedWithNothingRatherThanNull() {
    Runlight rl =
        runlight(
            new AtomicLong(0),
            new Runlight.Options().mail(new AppMailer(m -> {}, "site@example.com", null)));
    assertEquals("", rl.mailSettings().get("via"));
    Map<String, Object> answer =
        Make.body(
            rl.routes(new Routes.Options().token("t"))
                .handle(Make.owner("/runlight/api/mail", "GET", null, "t")));
    assertEquals("", Js.map(answer.get("app")).get("via"));
    assertThrows(NullPointerException.class, () -> new AppMailer(null, "site@example.com", "X"));
  }

  @Test
  void mailServicesNamesTheServicesSettingsOffersAndASavedOneNotAmongThemCountsAsNone() {
    IllegalArgumentException unknown =
        assertThrows(
            IllegalArgumentException.class,
            () ->
                runlight(
                    new AtomicLong(0),
                    new Runlight.Options().mailServices(List.of("resend", "pigeon"))));
    assertEquals(
        "Runlight: mailServices names \"pigeon\", which is not a mail service",
        unknown.getMessage());

    SqlStore store = Stores.sqlite(":memory:");
    Runlight every = new Runlight(new Runlight.Options().store(store).secret("s"));
    assertEquals(Transports.SERVICES, every.mailServices);
    every.saveMailSettings(
        Json.object(
            "service",
            "smtp",
            "host",
            "smtp.example.com",
            "port",
            "587",
            "security",
            "starttls",
            "from",
            "r@example.com"));
    assertEquals("smtp", every.mailSettings().get("service"));

    List<Map<String, Object>> sent = new ArrayList<>();
    Runlight fewer =
        new Runlight(
            new Runlight.Options()
                .store(store)
                .secret("s")
                .mailServices(List.of("webhook", "resend"))
                .mail(new AppMailer(sent::add, "site@example.com", "Drupal")));
    // Kept in the order Settings lists every service.
    assertEquals(List.of("resend", "webhook"), column(fewer.mailServices));
    // The SMTP server saved earlier is no longer offered, so the app's mailer sends.
    assertEquals("app", fewer.mailSettings().get("source"));
    fewer.sendMail(Json.object("to", "me@example.com", "subject", "Hi", "html", "", "text", "Hi"));
    assertEquals(1, sent.size());
    MailError refused =
        mailError(
            () ->
                fewer.saveMailSettings(
                    Json.object(
                        "service",
                        "smtp",
                        "host",
                        "smtp.example.com",
                        "port",
                        "587",
                        "from",
                        "r@example.com")));
    assertEquals("SMTP is not offered here. Pick another mail service", refused.getMessage());
    assertEquals("mail_service", refused.code());
    assertEquals(Json.object("service", "smtp"), refused.params());
    MailError pick =
        mailError(
            () ->
                fewer.saveMailSettings(Json.object("service", "pigeon", "from", "r@example.com")));
    assertEquals("Pick a mail service", pick.getMessage());
    assertEquals(Map.of(), pick.params());
    Map<String, Object> answer =
        Make.body(
            fewer
                .routes(new Routes.Options().token("t"))
                .handle(Make.owner("/runlight/api/mail", "GET", null, "t")));
    assertEquals(List.of("resend", "webhook"), column(Js.list(answer.get("services"))));

    // None at all offers none.
    Runlight none =
        new Runlight(
            new Runlight.Options().store(Stores.sqlite(":memory:")).mailServices(List.of()));
    assertEquals(List.of(), none.mailServices);
  }

  private static List<Object> column(List<?> services) {
    List<Object> ids = new ArrayList<>();
    for (Object s : services) {
      ids.add(Js.map(s).get("id"));
    }
    return ids;
  }

  /** A JSON request to the routes, with the owner's token. */
  @FunctionalInterface
  private interface MailCall {
    Response call(String method, String path, Object body);
  }
}

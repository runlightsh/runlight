package sh.runlight;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;
import java.util.function.Supplier;
import org.junit.jupiter.api.Test;
import sh.runlight.http.FetchError;
import sh.runlight.http.FetchInit;
import sh.runlight.http.Response;
import sh.runlight.mail.MailError;
import sh.runlight.mail.Transports;

/**
 * Ports safefetch.test.ts, replays the address checks in outbound.json, and covers each hop's
 * checks.
 */
class SafefetchTest {
  /** A DNS stand-in. */
  private static Function<String, List<String>> dns(Map<String, List<String>> names) {
    return name -> names.getOrDefault(name, List.of());
  }

  private static Map<String, Object> init(Object... more) {
    Map<String, Object> init = Json.object("timeoutMs", 2000L);
    init.putAll(Json.object(more));
    return init;
  }

  @Test
  void linkLocalAndCloudMetadataAddressesAreToldApartFromLoopbackAndPrivateOnes() {
    for (String ip :
        List.of(
            "169.254.169.254",
            "169.254.0.1",
            "100.100.100.200",
            "fe80::1",
            "fe80::a9fe:a9fe",
            "fd00:ec2::254",
            "::ffff:169.254.169.254",
            "::ffff:a9fe:a9fe",
            "64:ff9b::a9fe:a9fe")) {
      assertTrue(Safefetch.metadataAddress(ip), ip);
    }
    for (String ip :
        List.of(
            "127.0.0.1",
            "::1",
            "10.0.0.5",
            "192.168.1.20",
            "fd00::1",
            "fd00:ec2::253",
            "93.184.215.14",
            "not an address")) {
      assertFalse(Safefetch.metadataAddress(ip), ip);
    }
    assertTrue(Safefetch.metadataHost("metadata.google.internal", null));
    assertTrue(Safefetch.metadataHost("[fd00:ec2::254]", null));
    assertTrue(Safefetch.metadataHost("169.254.169.254", null));
    assertFalse(Safefetch.metadataHost("localhost", null), "a model on this computer is fine");
    assertFalse(Safefetch.metadataHost("192.168.1.20", null));
    assertTrue(
        Safefetch.metadataHost("sneaky.example", name -> List.of("93.184.215.14", "169.254.1.1")),
        "any address the name gives");
  }

  @Test
  void onlyAddressesOnThePublicInternetCountAsPublic() {
    for (String ip :
        List.of("93.184.215.14", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:82a::200e")) {
      assertTrue(Safefetch.publicAddress(ip), ip);
    }
    for (String ip :
        List.of(
            "127.0.0.1",
            "10.0.0.1",
            "172.16.5.4",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fe80::1",
            "fd00::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "::ffff:7f00:1",
            "::ffff:169.254.169.254",
            "64:ff9b::a00:1",
            "2002:a00:1::",
            "2001:db8::1",
            "2001:0:4136:e378::1",
            "[::1]",
            "not an address",
            "1.2.3",
            "1.2.3.256")) {
      assertFalse(Safefetch.publicAddress(ip), ip);
    }
  }

  @Test
  void addressChecksMatchTypeScript() {
    List<Map<String, Object>> cases = Fixtures.cases(Fixtures.load("outbound"), "ips");
    assertTrue(cases.size() > 50);
    for (Map<String, Object> c : cases) {
      assertEquals(
          c.get("public"), Safefetch.publicAddress((String) c.get("ip")), (String) c.get("ip"));
    }
  }

  @Test
  void aPublicFetchNeverReachesTheInstallsOwnNetworkHoweverTheAddressIsWritten()
      throws IOException {
    // Something listening locally, which none of these may reach.
    try (ServerSocket inside = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
      int port = inside.getLocalPort();
      for (String url :
          List.of(
              "http://127.0.0.1:" + port + "/",
              "https://127.0.0.1:" + port + "/",
              "https://[::1]:" + port + "/",
              "https://[::ffff:127.0.0.1]:" + port + "/",
              "https://localhost:" + port + "/",
              "https://LOCALHOST.:" + port + "/",
              "https://app.localhost:" + port + "/")) {
        assertThrows(
            PrivateAddressError.class,
            () -> Safefetch.publicFetch(url, init(), null),
            url + " should be refused");
      }
      inside.setSoTimeout(1);
      assertThrows(SocketTimeoutException.class, inside::accept, "nothing connected");
    }
    assertTrue(Safefetch.resolvesPrivately("localhost"));
    assertFalse(Safefetch.resolvesPrivately("name.that.does.not.resolve.invalid"));
    assertEquals(List.of(), Safefetch.publicAddresses("name.that.does.not.resolve.invalid"));
    assertEquals(List.of("8.8.8.8"), Safefetch.publicAddresses("8.8.8.8"));
    assertEquals(List.of(), Safefetch.publicAddresses("localhost"));
  }

  @Test
  void theCheckedAddressesArePinned() {
    RecordingFetcher fetcher = new RecordingFetcher((url, init) -> new Response("ok", 200));
    Response answer =
        Safefetch.publicFetch(
            "https://Example.com/icon",
            init(
                "headers",
                Map.of("user-agent", "Runlight"),
                "maxBytes",
                10L,
                "lookup",
                dns(Map.of("example.com", List.of("93.184.215.14", "2606:4700::1111")))),
            fetcher);
    assertEquals("ok", answer.text());
    assertEquals(
        List.of("example.com:443:93.184.215.14,[2606:4700::1111]"), fetcher.inits.get(0).resolve);
    assertEquals("manual", fetcher.inits.get(0).redirect);
    assertEquals(10L, fetcher.inits.get(0).maxBytes);
    assertFalse(fetcher.inits.get(0).truncate);
    assertTrue(fetcher.inits.get(0).timeoutMs <= 2000);
    Fixtures.assertJson(
        Json.object(
            "method",
            "GET",
            "url",
            "https://example.com/icon",
            "headers",
            Json.object("user-agent", "Runlight"),
            "body",
            ""),
        fetcher.requests.get(0));

    RecordingFetcher literal = new RecordingFetcher((url, init) -> new Response("ok", 200));
    Safefetch.publicFetch("https://93.184.215.14:8443/", init("lookup", dns(Map.of())), literal);
    assertEquals(List.of(), literal.inits.get(0).resolve, "an address needs no pin");
    assertNull(literal.inits.get(0).maxBytes);
  }

  @Test
  void aNameWithAnyPrivateAddressIsRefused() {
    RecordingFetcher fetcher = new RecordingFetcher((url, init) -> new Response("ok", 200));
    Map<String, List<String>> names =
        Map.of(
            "inside.example", List.of("10.0.0.5"),
            "mixed.example", List.of("93.184.215.14", "169.254.169.254"),
            "mapped.example", List.of("::ffff:127.0.0.1"));
    for (Map.Entry<String, List<String>> entry : names.entrySet()) {
      String name = entry.getKey();
      PrivateAddressError error =
          assertThrows(
              PrivateAddressError.class,
              () ->
                  Safefetch.publicFetch(
                      "https://" + name + "/",
                      init("lookup", dns(Map.of(name, entry.getValue()))),
                      fetcher));
      assertEquals(name + " is not a public address", error.getMessage());
    }
    assertEquals(List.of(), fetcher.requests);
    assertThrows(
        FetchError.class,
        () ->
            Safefetch.publicFetch(
                "https://nowhere.example/", init("lookup", dns(Map.of())), fetcher));
  }

  @Test
  void anInstallIsFetchedOnlyOnThePublicInternetOrAsHttpOnThisMachineWhenAllowed() {
    RecordingFetcher fetcher = new RecordingFetcher((url, init) -> new Response("ok", 200));
    Map<String, Object> post =
        init("method", "POST", "body", "{}", "headers", Map.of("content-type", "application/json"));
    assertEquals(
        "ok", Safefetch.installFetch("https://hub.example/x", post, false, fetcher).text());
    assertEquals("POST", fetcher.inits.get(0).method);
    assertEquals("{}", fetcher.inits.get(0).bodyText());
    assertEquals(List.of("hub.example:443:93.184.215.14"), fetcher.inits.get(0).resolve);
    // Trying things out on one machine: plain http to localhost and 127.0.0.1, only when allowed.
    for (String local : List.of("http://localhost:4100/runlight", "http://127.0.0.1/api")) {
      assertTrue(Safefetch.installAddress(local, true), local);
      assertFalse(Safefetch.installAddress(local, false), local);
      assertEquals("ok", Safefetch.installFetch(local, init(), true, fetcher).text(), local);
      assertThrows(
          PrivateAddressError.class,
          () -> Safefetch.installFetch(local, init(), false, fetcher),
          local);
    }
    assertEquals(List.of(), fetcher.inits.get(2).resolve, "a local address is not pinned");
    for (String refused :
        List.of(
            "http://hub.example/",
            "https://localhost/",
            "https://127.0.0.1/",
            "http://169.254.169.254/latest/meta-data",
            "http://10.0.0.1/",
            "http://localhost.evil.example/")) {
      assertThrows(
          PrivateAddressError.class,
          () -> Safefetch.installFetch(refused, init(), true, fetcher),
          refused);
    }
    fetcher.dns = name -> List.of("10.0.0.5");
    assertThrows(
        PrivateAddressError.class,
        () -> Safefetch.installFetch("https://inside.example/", init(), false, fetcher),
        "a name for a private address");
    assertEquals(3, fetcher.requests.size(), "nothing refused was sent");

    RecordingFetcher redirected =
        hops(Response.redirect("http://169.254.169.254/latest/meta-data", 302));
    assertEquals(
        302,
        Safefetch.installFetch("https://hub.example/", init("redirects", 5L), false, redirected)
            .status(),
        "a redirect comes back as it is, never followed");
    assertEquals(1, redirected.requests.size());
    RecordingFetcher posted = hops(Response.redirect("/elsewhere", 307));
    assertEquals(
        307,
        Safefetch.publicFetch(
                "https://hub.example/", init("method", "POST", "redirects", 3L), posted)
            .status(),
        "only a GET follows redirects");
  }

  /** A fetcher answering with these, in turn, then "end". */
  private static RecordingFetcher hops(Response... answers) {
    java.util.Deque<Response> left = new java.util.ArrayDeque<>(List.of(answers));
    return new RecordingFetcher(
        (url, init) -> left.isEmpty() ? new Response("end", 200) : left.poll());
  }

  @Test
  void redirectsAreFollowedByHandUnderTheSameRules() {
    Function<String, List<String>> lookup =
        dns(
            Map.of(
                "a.example", List.of("93.184.215.14"),
                "b.example", List.of("1.1.1.1"),
                "inside.example", List.of("192.168.0.2")));
    RecordingFetcher fetcher =
        hops(
            Response.redirect("/next", 301),
            Response.redirect("https://b.example/last", 302),
            new Response("done", 200));
    Response answer =
        Safefetch.publicFetch(
            "https://a.example/", init("redirects", 3L, "lookup", lookup), fetcher);
    assertEquals("done", answer.text());
    assertEquals(
        List.of("https://a.example/", "https://a.example/next", "https://b.example/last"),
        fetcher.urls());
    assertEquals(List.of("b.example:443:1.1.1.1"), fetcher.inits.get(2).resolve);

    RecordingFetcher once = hops(Response.redirect("https://b.example/", 302));
    assertEquals(
        302,
        Safefetch.publicFetch("https://a.example/", init("lookup", lookup), once).status(),
        "a redirect past the last comes back as it is");

    Map<String, String> refused =
        Map.of(
            "https://10.0.0.1/", "10.0.0.1",
            "https://inside.example/", "inside.example",
            "http://b.example/", "http://b.example/",
            "https://[fe80::1]/", "fe80::1");
    for (Map.Entry<String, String> entry : refused.entrySet()) {
      PrivateAddressError error =
          assertThrows(
              PrivateAddressError.class,
              () ->
                  Safefetch.publicFetch(
                      "https://a.example/",
                      init("redirects", 3L, "lookup", lookup),
                      hops(Response.redirect(entry.getKey(), 302))));
      assertEquals(entry.getValue() + " is not a public address", error.getMessage());
    }
  }

  @Test
  void runningOutOfTimeSaysSo() {
    Function<String, List<String>> lookup = dns(Map.of("a.example", List.of("1.1.1.1")));
    FetchError error =
        assertThrows(
            FetchError.class,
            () ->
                Safefetch.publicFetch(
                    "https://a.example/", init("lookup", lookup), new RecordingFetcher("timeout")));
    assertTrue(error.timedOut());
    assertEquals("The operation was aborted due to timeout", error.getMessage());
    FetchError refused =
        assertThrows(
            FetchError.class,
            () ->
                Safefetch.publicFetch(
                    "https://a.example/", init("lookup", lookup), new RecordingFetcher("network")));
    assertEquals("Could not connect", refused.getMessage());
    assertFalse(refused.timedOut());
  }

  /** One request the service test's server was sent. */
  private record Seen(String method, String url, String body, String authorization, String type) {}

  @Test
  void aServicesRedirectsAreFollowedOnlyWhileEachOneStaysOffLinkLocalAndMetadataAddresses()
      throws IOException {
    List<Seen> seen = new CopyOnWriteArrayList<>();
    HttpServer server =
        HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
    int port = server.getAddress().getPort();
    server.createContext(
        "/",
        exchange -> {
          String body =
              new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
          String path = exchange.getRequestURI().getPath();
          String authorization = exchange.getRequestHeaders().getFirst("authorization");
          String type = exchange.getRequestHeaders().getFirst("content-type");
          seen.add(
              new Seen(
                  exchange.getRequestMethod(),
                  path,
                  body,
                  authorization == null ? "" : authorization,
                  type == null ? "" : type));
          Map<String, Object> redirects =
              Json.object(
                  "/metadata", List.of(302, "http://169.254.169.254/latest/meta-data/"),
                  "/metadata-v6", List.of(307, "http://[fd00:ec2::254]/"),
                  "/see-other", List.of(303, "/landed"),
                  "/keep", List.of(307, "/landed"),
                  "/elsewhere", List.of(307, "http://localhost:" + port + "/landed"),
                  "/loop", List.of(302, "/loop"));
          if (redirects.get(path) instanceof List<?> to) {
            exchange.getResponseHeaders().set("location", (String) to.get(1));
            exchange.sendResponseHeaders((Integer) to.get(0), -1);
          } else {
            byte[] ok = "ok".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, ok.length);
            exchange.getResponseBody().write(ok);
          }
          exchange.close();
        });
    server.start();
    String base = "http://127.0.0.1:" + port;
    Supplier<FetchInit> ask =
        () ->
            new FetchInit()
                .method("POST")
                .header("authorization", "Bearer key")
                .header("content-type", "application/json")
                .body("{}")
                .timeoutMs(5000);
    try {
      // A service on this computer is fine; a redirect to a metadata address is refused before it
      // is asked.
      MetadataAddressError v4 =
          assertThrows(
              MetadataAddressError.class,
              () -> Safefetch.serviceFetch(base + "/metadata", ask.get(), null));
      assertEquals("169.254.169.254", v4.host());
      MetadataAddressError v6 =
          assertThrows(
              MetadataAddressError.class,
              () -> Safefetch.serviceFetch(base + "/metadata-v6", ask.get(), null));
      assertEquals("fd00:ec2::254", v6.host());
      assertThrows(
          MetadataAddressError.class,
          () -> Safefetch.serviceFetch("http://169.254.169.254/v1/models", new FetchInit(), null));
      // Followed as fetch follows them: a 303 goes on as a GET with no body, a 307 keeps both, and
      // the key goes no further than the origin it was meant for.
      seen.clear();
      assertEquals("ok", Safefetch.serviceFetch(base + "/see-other", ask.get(), null).text());
      assertEquals(new Seen("GET", "/landed", "", "Bearer key", ""), seen.get(1));
      seen.clear();
      Safefetch.serviceFetch(base + "/keep", ask.get(), null);
      assertEquals(
          new Seen("POST", "/landed", "{}", "Bearer key", "application/json"), seen.get(1));
      seen.clear();
      Safefetch.serviceFetch(base + "/elsewhere", ask.get(), null);
      assertEquals(new Seen("POST", "/landed", "{}", "", "application/json"), seen.get(1));
      // Past the last redirect, the redirect comes back as it is.
      seen.clear();
      assertEquals(302, Safefetch.serviceFetch(base + "/loop", new FetchInit(), 2, null).status());
      assertEquals(3, seen.size());
      // The AI assistant and a mail webhook refuse such a redirect with the address it led to.
      AssistantError assistant =
          assertThrows(
              AssistantError.class,
              () ->
                  Assistant.listModels(
                      Json.object("provider", "custom", "baseUrl", base + "/metadata#", "key", ""),
                      null));
      assertEquals("address_refused", assistant.code());
      assertEquals(Json.object("host", "169.254.169.254"), assistant.params());
      MailError mail =
          assertThrows(
              MailError.class,
              () ->
                  Transports.send(
                      Json.object(
                          "service", "webhook", "url", "http://localhost:" + port + "/metadata"),
                      Json.object(
                          "to",
                          "me@example.com",
                          "from",
                          "reports@example.com",
                          "subject",
                          "Hi",
                          "html",
                          "<p>Hi</p>",
                          "text",
                          "Hi"),
                      null));
      assertEquals("address_refused", mail.code());
      assertEquals(
          "169.254.169.254 is a link-local or cloud metadata address, which Runlight never connects to",
          mail.getMessage());
    } finally {
      server.stop(0);
    }
  }
}

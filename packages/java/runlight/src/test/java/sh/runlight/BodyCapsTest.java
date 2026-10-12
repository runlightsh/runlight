package sh.runlight;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import sh.runlight.http.Response;
import sh.runlight.mail.MailError;
import sh.runlight.mail.Transports;

/** An answer from a model, a mail service, or a link domain is read only so far. */
class BodyCapsTest {
  /**
   * A server whose every answer never ends, and how much of it was written before the reader let
   * go.
   */
  private static final class Endless implements AutoCloseable {
    final ServerSocket server;
    final AtomicLong written = new AtomicLong();

    Endless(int status) throws IOException {
      server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
      Thread.ofVirtual()
          .start(
              () -> {
                try {
                  while (true) {
                    Socket client = server.accept();
                    Thread.ofVirtual().start(() -> serve(client, status));
                  }
                } catch (IOException e) {
                  // Closed.
                }
              });
    }

    private void serve(Socket client, int status) {
      try (client) {
        byte[] request = new byte[8192];
        client.getInputStream().read(request);
        OutputStream out = client.getOutputStream();
        out.write(
            ("HTTP/1.1 "
                    + status
                    + " X\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n")
                .getBytes(StandardCharsets.US_ASCII));
        byte[] chunk = ("{\"x\":\"" + "a".repeat(65_536)).getBytes(StandardCharsets.US_ASCII);
        // Far more than any cap, so only a reader that stops can end it.
        for (int i = 0; i < 2048; i++) {
          out.write(chunk);
          written.addAndGet(chunk.length);
        }
      } catch (IOException e) {
        // The reader let go.
      }
    }

    String base() {
      return "http://127.0.0.1:" + server.getLocalPort();
    }

    @Override
    public void close() throws IOException {
      server.close();
    }
  }

  private static final Map<String, Object> MESSAGE =
      Json.object(
          "to", "me@example.com",
          "from", "reports@example.com",
          "subject", "Hi",
          "html", "<p>Hi</p>",
          "text", "Hi");

  @Test
  void aModelsListAndAnswerAreReadOnlySoFar() throws Exception {
    try (Endless model = new Endless(200)) {
      AssistantError none =
          assertThrows(
              AssistantError.class,
              () ->
                  Assistant.listModels(
                      Json.object("provider", "custom", "baseUrl", model.base() + "/v1", "key", ""),
                      null));
      assertEquals("assistant_no_models", none.code());
      assertTrue(model.written.get() < 32L * 1024 * 1024, "the list of models: " + model.written);
    }
    try (Endless model = new Endless(200)) {
      Map<String, Object> settings =
          Json.object(
              "provider", "custom", "model", "m", "baseUrl", model.base() + "/v1", "key", "");
      try {
        Assistant.chat(
            settings,
            java.util.List.of(Json.object("role", "user", "content", "How many visitors?")),
            Json.object(
                "site", Json.object("id", "default", "name", "Site", "timezone", "UTC"),
                "today", "2026-10-06",
                "view", "today",
                "language", "en"),
            (path, headers) -> new Response("{}", 200),
            null);
      } catch (AssistantError expected) {
        // An answer past the cap is unreadable, so there is nothing in it to use.
      }
      assertTrue(model.written.get() < 32L * 1024 * 1024, "a model's answer: " + model.written);
    }
  }

  @Test
  void aMailServicesErrorIsReadOnlySoFarAndABodyNobodyReadsIsLetGo() throws Exception {
    try (Endless service = new Endless(500)) {
      MailError refused =
          assertThrows(
              MailError.class,
              () ->
                  Transports.send(
                      Json.object("service", "webhook", "url", service.base() + "/hook"),
                      MESSAGE,
                      null));
      assertEquals("mail_refused", refused.code());
      assertTrue(
          service.written.get() < 32L * 1024 * 1024, "a mail service's error: " + service.written);
    }
    try (Endless service = new Endless(200)) {
      Transports.send(
          Json.object("service", "webhook", "url", service.base() + "/hook"), MESSAGE, null);
      assertTrue(
          service.written.get() < 32L * 1024 * 1024, "a body nobody reads: " + service.written);
    }
  }
}

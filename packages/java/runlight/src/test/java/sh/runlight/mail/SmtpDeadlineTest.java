package sh.runlight.mail;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import sh.runlight.Json;

/**
 * A mail server that takes the message's first bytes and then stops reading. A socket's timeout
 * holds its reads only, so the send used to wait on its write for as long as the server kept the
 * connection open, and the scheduled check that sends reports waited with it.
 */
class SmtpDeadlineTest {
  /** Answers as a relay does up to DATA, then reads nothing more and keeps the connection. */
  private static ServerSocket deafAfterData() throws IOException {
    ServerSocket server = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
    Thread thread =
        new Thread(
            () -> {
              try (Socket socket = server.accept()) {
                OutputStream out = socket.getOutputStream();
                BufferedReader in =
                    new BufferedReader(
                        new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                out.write("220 ready\r\n".getBytes(StandardCharsets.US_ASCII));
                for (String line = in.readLine(); line != null; line = in.readLine()) {
                  boolean data = line.equals("DATA");
                  out.write(
                      (data ? "354 go on\r\n" : "250 ok\r\n").getBytes(StandardCharsets.US_ASCII));
                  out.flush();
                  if (data) {
                    Thread.sleep(30_000);
                    return;
                  }
                }
              } catch (IOException e) {
                // The client gave up.
              } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
              }
            },
            "deaf-smtp");
    thread.setDaemon(true);
    thread.start();
    return server;
  }

  @Test
  void aServerThatStopsReadingTheMessageCannotHoldTheSendPastItsDeadline() throws IOException {
    try (ServerSocket server = deafAfterData()) {
      long started = System.nanoTime();
      MailError error =
          assertThrows(
              MailError.class,
              () ->
                  Smtp.send(
                      Json.object(
                          "service",
                          "smtp",
                          "host",
                          "127.0.0.1",
                          "port",
                          Integer.toString(server.getLocalPort()),
                          "security",
                          "none"),
                      Json.object(
                          "from",
                          "reports@example.com",
                          "to",
                          "jon@example.com",
                          "subject",
                          "A long one",
                          "text",
                          "plain",
                          // Far more than the kernel will take on a connection nobody reads from.
                          "html",
                          "x".repeat(48 * 1024 * 1024)),
                      "reports@example.com",
                      1000,
                      null,
                      null));
      assertEquals("mail_slow", error.code(), error.getMessage());
      assertTrue(
          System.nanoTime() - started < 15_000_000_000L, "given up at the deadline, not held");
    }
  }
}

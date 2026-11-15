package sh.runlight.http;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

/**
 * What a server can no longer do to the default Fetcher: send headers without end, which maxBytes
 * never held, and stop reading, which the timeout never held.
 */
class JdkFetcherLimitsTest {
  @FunctionalInterface
  private interface Serve {
    void serve(Socket socket, OutputStream out) throws IOException;
  }

  /** A server on 127.0.0.1 that reads each request's head and then does as {@code serve} says. */
  private static ServerSocket server(Serve serve) throws IOException {
    ServerSocket server = new ServerSocket(0, 5, InetAddress.getLoopbackAddress());
    Thread thread =
        new Thread(
            () -> {
              while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                  InputStream in = socket.getInputStream();
                  // Up to the blank line that ends the head.
                  int run = 0;
                  while (run < 4) {
                    int b = in.read();
                    if (b < 0) {
                      break;
                    }
                    run = b == '\r' || b == '\n' ? run + 1 : 0;
                  }
                  serve.serve(socket, socket.getOutputStream());
                } catch (IOException e) {
                  // The client hung up, as it does once it has had enough.
                }
              }
            },
            "limits-server");
    thread.setDaemon(true);
    thread.start();
    return server;
  }

  private static byte[] ascii(String text) {
    return text.getBytes(StandardCharsets.US_ASCII);
  }

  private static String url(ServerSocket server) {
    return "http://127.0.0.1:" + server.getLocalPort() + "/";
  }

  @Test
  void headersWithoutEndAreRefusedLongBeforeTheTimeout() throws IOException {
    AtomicLong sent = new AtomicLong();
    byte[] line = ascii("x-filler: " + "a".repeat(1000) + "\r\n");
    try (ServerSocket endless =
        server(
            (socket, out) -> {
              out.write(ascii("HTTP/1.1 200 OK\r\n"));
              for (; ; ) {
                out.write(line);
                sent.addAndGet(line.length);
              }
            })) {
      long started = System.nanoTime();
      FetchError error =
          assertThrows(
              FetchError.class,
              () -> new JdkFetcher().fetch(url(endless), new FetchInit().timeoutMs(20_000)));
      assertFalse(error.timedOut(), error.getMessage());
      assertTrue(error.getMessage().contains("headers are over"), error.getMessage());
      assertTrue(System.nanoTime() - started < 10_000_000_000L, "refused at once");
    }
  }

  @Test
  void interimAnswersAndTrailersCountTowardTheHeadToo() throws IOException {
    byte[] interim = ascii("HTTP/1.1 103 Early Hints\r\nlink: <" + "a".repeat(1000) + ">\r\n\r\n");
    try (ServerSocket hints =
        server(
            (socket, out) -> {
              for (; ; ) {
                out.write(interim);
              }
            })) {
      FetchError error =
          assertThrows(
              FetchError.class,
              () -> new JdkFetcher().fetch(url(hints), new FetchInit().timeoutMs(20_000)));
      assertTrue(error.getMessage().contains("headers are over"), error.getMessage());
    }
    byte[] trailer = ascii("x-trailer: " + "a".repeat(1000) + "\r\n");
    try (ServerSocket trailers =
        server(
            (socket, out) -> {
              out.write(
                  ascii("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n"));
              for (; ; ) {
                out.write(trailer);
              }
            })) {
      FetchError error =
          assertThrows(
              FetchError.class,
              () -> new JdkFetcher().fetch(url(trailers), new FetchInit().timeoutMs(20_000)));
      assertTrue(error.getMessage().contains("headers are over"), error.getMessage());
    }
  }

  @Test
  void aHeadWithinTheLimitAndABodyOfManyChunksStillArrive() throws IOException {
    try (ServerSocket fine =
        server(
            (socket, out) -> {
              StringBuilder answer = new StringBuilder("HTTP/1.1 200 OK\r\n");
              for (int i = 0; i < 40; i++) {
                answer.append("x-h").append(i).append(": ").append("b".repeat(1000)).append("\r\n");
              }
              answer.append("transfer-encoding: chunked\r\n\r\n");
              // More chunk sizes than the head could hold, were they counted against it.
              for (int i = 0; i < 30_000; i++) {
                answer.append("1\r\nz\r\n");
              }
              answer.append("0\r\nx-last: 1\r\n\r\n");
              out.write(ascii(answer.toString()));
              out.flush();
            })) {
      Response answer = new JdkFetcher().fetch(url(fine), new FetchInit().timeoutMs(20_000));
      assertEquals(200, answer.status());
      assertEquals(30_000, answer.bytes().length);
      assertEquals("b".repeat(1000), answer.headers().get("x-h39"));
    }
  }

  @Test
  void aServerThatStopsReadingCannotHoldARequestPastItsTimeout() throws IOException {
    try (ServerSocket deaf =
        server(
            (socket, out) -> {
              // The head was read; the body never is, and the connection stays open.
              try {
                Thread.sleep(30_000);
              } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
              }
            })) {
      // Far more than the kernel will take on a connection nobody reads from.
      byte[] body = new byte[64 * 1024 * 1024];
      long started = System.nanoTime();
      FetchError error =
          assertThrows(
              FetchError.class,
              () ->
                  new JdkFetcher()
                      .fetch(url(deaf), new FetchInit().method("POST").body(body).timeoutMs(500)));
      assertTrue(error.timedOut(), error.getMessage());
      assertTrue(
          System.nanoTime() - started < 10_000_000_000L, "given up at the timeout, not held");
    }
  }
}

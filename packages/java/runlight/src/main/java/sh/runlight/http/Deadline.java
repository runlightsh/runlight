package sh.runlight.http;

import java.io.IOException;
import java.net.Socket;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Closes a connection once its deadline has passed. A socket's own timeout holds only its reads and
 * its connect; a write to a peer that has stopped reading waits for as long as the peer keeps the
 * connection open, which is for good. Closing the socket from here ends that write with an error,
 * so a request or a mail never outlasts the time it was given, whichever way it is held up.
 *
 * <p>The socket to give is the plain one, under any TLS: closing that never waits on a write in
 * progress, as closing a TLS socket can.
 */
public final class Deadline {
  private Deadline() {}

  private static final ScheduledThreadPoolExecutor TIMER = timer();

  private static ScheduledThreadPoolExecutor timer() {
    ScheduledThreadPoolExecutor made =
        new ScheduledThreadPoolExecutor(
            1,
            work -> {
              Thread thread = new Thread(work, "runlight-deadline");
              thread.setDaemon(true);
              return thread;
            });
    // A watch taken back leaves nothing behind, since nearly every one is.
    made.setRemoveOnCancelPolicy(true);
    return made;
  }

  /**
   * Closes {@code socket} at {@code deadline}, a time on {@link System#nanoTime()}, unless the
   * watch is cancelled first. Cancel it when the work is done.
   */
  public static ScheduledFuture<?> closeAt(Socket socket, long deadline) {
    return TIMER.schedule(
        () -> {
          try {
            socket.close();
          } catch (IOException e) {
            // Already gone.
          }
        },
        Math.max(0, deadline - System.nanoTime()),
        TimeUnit.NANOSECONDS);
  }
}

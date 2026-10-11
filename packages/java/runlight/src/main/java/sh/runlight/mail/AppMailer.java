package sh.runlight.mail;

import java.util.Map;
import java.util.Objects;

/**
 * A mailer of the app's own, such as a CMS's, that sends each message itself. Given as the mail
 * option, it sends while no service is saved in the dashboard.
 *
 * @param send sends one message, a map shaped as {@link Transports} describes
 * @param from the address messages come from
 * @param fromName the name they come from, or null
 * @param via what the dashboard calls it, such as "WordPress (WP Mail SMTP)"; "" when null
 */
public record AppMailer(Sender send, String from, String fromName, String via) {

  /** The name is kept only when there is one, and a missing via is "". */
  public AppMailer {
    Objects.requireNonNull(send, "Runlight: the app's mailer needs send");
    if (fromName != null && fromName.isEmpty()) {
      fromName = null;
    }
    if (via == null) {
      via = "";
    }
  }

  /** An AppMailer with no name to send from. */
  public AppMailer(Sender send, String from, String via) {
    this(send, from, null, via);
  }

  /** Sends one message: to, from, fromName (only when set), subject, html, text, and headers. */
  @FunctionalInterface
  public interface Sender {
    /** A MailError passes through as it is; any other failure is said as the mailer's. */
    void send(Map<String, Object> message) throws Exception;
  }
}

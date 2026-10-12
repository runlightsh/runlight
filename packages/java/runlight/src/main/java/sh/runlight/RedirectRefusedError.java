package sh.runlight;

/**
 * Refused before anything was sent there, because a service's redirect led to another origin, and
 * the request carries the service's key and a body.
 */
public final class RedirectRefusedError extends RuntimeException {
  private static final long serialVersionUID = 1L;

  private final String host;
  private final String to;

  public RedirectRefusedError(String host, String to) {
    super(
        host
            + " redirected to "
            + to
            + ". Runlight sends a service's key and request only to the address it was set up with,"
            + " so set it up with that address instead");
    this.host = host;
    this.to = to;
  }

  /** The host that redirected, with its port when it has one. */
  public String host() {
    return host;
  }

  /** The origin redirected to, or its protocol when that is not http or https. */
  public String to() {
    return to;
  }
}

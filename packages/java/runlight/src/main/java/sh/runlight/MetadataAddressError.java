package sh.runlight;

/**
 * Refused before anything was fetched, because the address is link-local or a cloud's metadata
 * service.
 */
public final class MetadataAddressError extends RuntimeException {
  private static final long serialVersionUID = 1L;

  private final String host;

  public MetadataAddressError(String host) {
    super(host + " is a link-local or cloud metadata address, which Runlight never connects to");
    this.host = host;
  }

  /** The host refused, without brackets around an IPv6 address. */
  public String host() {
    return host;
  }
}

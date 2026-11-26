package sh.runlight;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The SDK's version and the HTTP API's, the dashboard's and tracker's files, and the Runlight icon
 * and email logo, read from the assets scripts/java-assets.mts copies from the TypeScript SDK, so
 * the two always serve and report the same.
 */
public final class Version {
  private Version() {}

  private static final Map<String, byte[]> FILES = new ConcurrentHashMap<>();
  private static volatile Map<String, Object> build;
  private static volatile byte[] logo;

  /**
   * Everything in assets/build.json: the versions, the asset hashes, the icon, and the email logo.
   */
  public static Map<String, Object> build() {
    Map<String, Object> current = build;
    if (current == null) {
      current = Js.map(Json.parse(asset("build.json")));
      build = current;
    }
    return current;
  }

  public static String version() {
    return (String) build().get("version");
  }

  /** Bumped when the HTTP API changes shape, so the dashboard and the hub can tell. */
  public static long apiVersion() {
    return Js.asLong(build().get("apiVersion"));
  }

  /** The Runlight mark for the dashboard's tab, as a data URL. */
  public static String runlightIcon() {
    return (String) build().get("icon");
  }

  /**
   * The mark as a 96 pixel PNG, the same drawing as the website's header and the Mac app's icon,
   * decoded from base64 the first time it is asked for. Each install serves it at {@code
   * <base>/logo.png}, without signing in, for its emails.
   */
  public static byte[] logoPng() {
    byte[] current = logo;
    if (current == null) {
      current = Base64.getDecoder().decode((String) build().get("logoPng"));
      logo = current;
    }
    return current;
  }

  /**
   * The mark for emails: the PNG at the sending install's own /logo.png, shown at 48 pixels.
   * Opening an email fetches it from that install and from nowhere else; a client that blocks
   * images shows the word Runlight.
   *
   * @param home the install's address with its base path, such as https://example.com/runlight
   */
  public static String emailLogo(String home) {
    String src =
        (home.replaceAll("/+\\z", "") + "/logo.png")
            .replace("&", "&amp;")
            .replace("\"", "&quot;")
            .replace("<", "&lt;")
            .replace(">", "&gt;");
    return "<img src=\""
        + src
        + "\" width=\"48\" height=\"48\" alt=\"Runlight\" style=\"display:block;width:48px;height:48px;margin:0 0 24px;border:0;outline:none;text-decoration:none;font:700 16px/48px -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#6b7280\">";
  }

  /** One of the assets as text. */
  public static String asset(String name) {
    return new String(assetBytes(name), StandardCharsets.UTF_8);
  }

  /** One of the assets as bytes, read once. */
  public static byte[] assetBytes(String name) {
    return FILES.computeIfAbsent(
        name,
        key -> {
          try (InputStream in = Version.class.getResourceAsStream("assets/" + key)) {
            if (in == null) {
              throw new IllegalStateException(
                  "Runlight: the asset " + key + " is missing; run scripts/java-assets.mts.");
            }
            return in.readAllBytes();
          } catch (IOException e) {
            throw new UncheckedIOException(e);
          }
        });
  }
}

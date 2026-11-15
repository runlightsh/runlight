package sh.runlight;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import sh.runlight.http.Url;

/**
 * What the tracker sends, after validation. Anything malformed is dropped.
 *
 * <p>A payload is an object with kind (pageview, event, or engagement), site, url (a {@link Url}),
 * referrer, title, screenWidth and screenHeight (a number or null), language, name, props (an
 * object of strings, or null), pageviewId, engagedMs, and scroll (a number or null).
 */
public final class Payload {
  private Payload() {}

  public static final int MAX_BODY = 8 * 1024;

  /** One engagement ping covers at most the 30 minutes a session can idle. */
  private static final long MAX_ENGAGED_MS = 30 * 60 * 1000;

  private static final int MAX_PROPS = 30;

  private static final Pattern ID = Pattern.compile("^[a-z0-9]+\\z", Pattern.CASE_INSENSITIVE);

  /** A string as it came, cut to max UTF-16 units: for a URL, which the parser then encodes. */
  private static String str(Object value, int max) {
    return value instanceof String s ? Js.slice(s, 0, max) : "";
  }

  /**
   * Text as every database can keep it: without U+0000, which Postgres refuses, and with half a
   * surrogate pair (which is no character) as U+FFFD.
   */
  public static String tidy(String text) {
    StringBuilder out = null;
    int length = text.length();
    for (int i = 0; i < length; i++) {
      char c = text.charAt(i);
      boolean pair =
          Character.isHighSurrogate(c)
              && i + 1 < length
              && Character.isLowSurrogate(text.charAt(i + 1));
      boolean lone = Character.isSurrogate(c) && !pair;
      if (c == 0 || lone) {
        if (out == null) {
          out = new StringBuilder(length).append(text, 0, i);
        }
        if (lone) {
          out.append('\uFFFD');
        }
      } else if (out != null) {
        out.append(c);
        if (pair) {
          out.append(text.charAt(i + 1));
        }
      }
      if (pair) {
        i++;
      }
    }
    return out == null ? text : out.toString();
  }

  /**
   * Tidied text cut to max characters (code points), so a character such as an emoji is never cut
   * in half.
   */
  public static String cleanText(String text, int max) {
    String clean = tidy(text);
    if (clean.length() <= max) {
      return clean;
    }
    return clean.codePointCount(0, clean.length()) <= max
        ? clean
        : clean.substring(0, clean.offsetByCodePoints(0, max));
  }

  /** A string the tracker sent, as it is stored. */
  private static String stored(Object value, int max) {
    return value instanceof String s ? cleanText(s, max) : "";
  }

  private static Long integer(Object value, long min, long max) {
    if (!Js.isFinite(value)) {
      return null;
    }
    double rounded = Js.round(((Number) value).doubleValue());
    return (long) Math.min(max, Math.max(min, rounded));
  }

  private static Map<String, Object> props(Object value) {
    if (!(value instanceof Map<?, ?> map)) {
      return null;
    }
    Map<String, Object> out = new LinkedHashMap<>();
    int count = 0;
    for (Map.Entry<String, Object> entry : Js.entries(map)) {
      if (count >= MAX_PROPS) {
        break;
      }
      String k = cleanText(Js.trim(tidy(entry.getKey())), 60);
      if (k.isEmpty()) {
        continue;
      }
      Object raw = entry.getValue();
      String text;
      if (raw instanceof String s) {
        text = cleanText(s, 500);
      } else if (raw instanceof Number && Js.isFinite(raw)) {
        text = Js.string(raw);
      } else if (raw instanceof Boolean) {
        text = Js.string(raw);
      } else {
        continue;
      }
      // A prop named __proto__ is kept like any other rather than lost.
      out.put(k, text);
      count++;
    }
    return count > 0 ? out : null;
  }

  /**
   * The events the tracker sends on its own for a link that was followed, each with the link as
   * url.
   */
  private static final Set<String> LINK_EVENTS = Set.of("Outbound link", "File download");

  private static final Pattern QUERY_OR_FRAGMENT = Pattern.compile("[?#].*\\z", Pattern.DOTALL);

  /**
   * An automatic link event's url without its query string or fragment, as page paths are kept,
   * since tokens and email addresses ride in them. Done here rather than in the tracker, which has
   * no bytes to spare, and so a tracker cached from before is held to it too.
   */
  private static Map<String, Object> linkProps(String name, Map<String, Object> given) {
    if (given == null || !LINK_EVENTS.contains(name) || !(given.get("url") instanceof String url)) {
      return given;
    }
    given.put("url", QUERY_OR_FRAGMENT.matcher(url).replaceFirst(""));
    return given;
  }

  /** The tracker's body read, or null when anything about it is malformed. */
  public static Map<String, Object> parsePayload(String text) {
    if (text.length() > MAX_BODY) {
      return null;
    }
    // However deep a body nests, only its top is read, so what is deeper is left out, not refused.
    Json.Parsed parsed = Json.tryParseShallow(text);
    if (!parsed.ok() || !(parsed.value() instanceof Map<?, ?>)) {
      return null;
    }
    Map<String, Object> body = Js.map(parsed.value());

    Object kind = body.get("k");
    if (!"pageview".equals(kind) && !"event".equals(kind) && !"engagement".equals(kind)) {
      return null;
    }

    Url url = Url.parse(str(body.get("u"), 2048));
    if (url == null) {
      return null;
    }
    if (!url.protocol.equals("http:") && !url.protocol.equals("https:")) {
      return null;
    }

    String name = Js.trim(stored(body.get("n"), 120));
    if (kind.equals("event") && name.isEmpty()) {
      return null;
    }

    String pageviewId = str(body.get("i"), 32);
    if (!pageviewId.isEmpty() && !ID.matcher(pageviewId).matches()) {
      return null;
    }
    if (kind.equals("engagement") && pageviewId.isEmpty()) {
      return null;
    }

    Long engaged = kind.equals("engagement") ? integer(body.get("e"), 0, MAX_ENGAGED_MS) : null;
    return Json.object(
        "kind", kind,
        "site", stored(body.get("s"), 64),
        "url", url,
        "referrer", str(body.get("r"), 2048),
        "title", stored(body.get("t"), 500),
        "screenWidth", integer(body.get("w"), 0, 20000),
        "screenHeight", integer(body.get("h"), 0, 20000),
        "language", stored(body.get("l"), 35),
        "name", name,
        "props", kind.equals("event") ? linkProps(name, props(body.get("p"))) : null,
        "pageviewId", pageviewId,
        "engagedMs", engaged == null ? 0L : engaged,
        "scroll", integer(body.get("d"), 0, 100));
  }
}

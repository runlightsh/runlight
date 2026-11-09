package sh.runlight;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import sh.runlight.http.FetchInit;
import sh.runlight.http.Fetcher;
import sh.runlight.http.Response;

/**
 * Checks a request that names an AI agent against the addresses that agent's company publishes.
 * Every list is in the same shape, {"prefixes": [{"ipv4Prefix": "a.b.c.d/n"} or {"ipv6Prefix":
 * "x::/n"}]}.
 *
 * <p>The answer is "verified" when the address is in the list, "mismatch" when the company
 * publishes a list and the address is not in it, and "" when there is nothing to check against: no
 * list for that agent, or no usable address. The address is only compared, never kept.
 *
 * <p>The port of the TypeScript SDK's agentcheck.ts.
 */
public final class AgentCheck {
  private AgentCheck() {}

  /**
   * A list of more prefixes than this, or a reply bigger than MAX_LIST_BYTES, is not one we read.
   */
  public static final int MAX_PREFIXES = 20_000;

  public static final long MAX_LIST_BYTES = 4_000_000L;

  private static final Pattern DECIMAL = Pattern.compile("^[0-9]{1,3}\\z");
  private static final Pattern HEX_TEXT = Pattern.compile("^[0-9a-fA-F:.]+\\z");
  private static final Pattern GROUP = Pattern.compile("^[0-9a-fA-F]{1,4}\\z");
  private static final BigInteger FFFF = BigInteger.valueOf(0xffff);
  private static final BigInteger LOW_32 = BigInteger.valueOf(0xffffffffL);

  /** An address as the check reads it: its family, 4 or 6, and its value. */
  public record Address(int v, BigInteger n) {}

  /** A prefix such as 20.171.206.0/24: its family, its base address, and its length. */
  private record Prefix(int v, BigInteger base, int bits) {}

  private static Long ipv4(String text) {
    String[] parts = text.split("\\.", -1);
    if (parts.length != 4) {
      return null;
    }
    long n = 0;
    for (String part : parts) {
      if (!DECIMAL.matcher(part).find()) {
        return null;
      }
      int value = Integer.parseInt(part);
      if (value > 255) {
        return null;
      }
      n = n * 256 + value;
    }
    return n;
  }

  private static BigInteger ipv6(String text) {
    if (!HEX_TEXT.matcher(text).find() || text.split("::", -1).length > 2) {
      return null;
    }
    // A dotted IPv4 tail ("::ffff:1.2.3.4") stands for the last two groups.
    String groups = text;
    int colon = text.lastIndexOf(':');
    if (text.indexOf('.') >= 0) {
      Long tail = ipv4(text.substring(colon + 1));
      if (tail == null) {
        return null;
      }
      groups =
          text.substring(0, colon + 1)
              + Long.toHexString(tail >>> 16)
              + ":"
              + Long.toHexString(tail & 0xffff);
    }
    int split = groups.indexOf("::");
    String head = split < 0 ? groups : groups.substring(0, split);
    String rest = split < 0 ? null : groups.substring(split + 2);
    List<String> left = head.isEmpty() ? List.of() : List.of(head.split(":", -1));
    List<String> right = rest == null || rest.isEmpty() ? List.of() : List.of(rest.split(":", -1));
    int missing = 8 - left.size() - right.size();
    if (rest == null ? missing != 0 : missing < 1) {
      return null;
    }
    List<String> all = new ArrayList<>(left);
    if (rest != null) {
      all.addAll(Collections.nCopies(missing, "0"));
    }
    all.addAll(right);
    BigInteger n = BigInteger.ZERO;
    for (String group : all) {
      if (!GROUP.matcher(group).find()) {
        return null;
      }
      n = n.shiftLeft(16).or(BigInteger.valueOf(Integer.parseInt(group, 16)));
    }
    return n;
  }

  /**
   * An address as the check reads it: surrounding space, [brackets], and an IPv6 zone ("%eth0") are
   * ignored, and an IPv4 address written as IPv6 (::ffff:1.2.3.4) is read as IPv4. Null when it is
   * not one.
   */
  public static Address parseAddress(String text) {
    if (text == null) {
      return null;
    }
    String s = Js.trim(text);
    if (s.startsWith("[") && s.endsWith("]") && s.length() >= 2) {
      s = s.substring(1, s.length() - 1);
    }
    int zone = s.indexOf('%');
    if (zone != -1) {
      s = s.substring(0, zone);
    }
    if (s.isEmpty()) {
      return null;
    }
    if (s.indexOf(':') < 0) {
      Long n = ipv4(s);
      return n == null ? null : new Address(4, BigInteger.valueOf(n));
    }
    BigInteger n = ipv6(s);
    if (n == null) {
      return null;
    }
    if (n.shiftRight(32).equals(FFFF)) {
      return new Address(4, n.and(LOW_32));
    }
    return new Address(6, n);
  }

  /**
   * A prefix such as 20.171.206.0/24 or 2600:1f28::/56, or null. Bits past the length are ignored.
   */
  private static Prefix parsePrefix(String text) {
    int slash = text.indexOf('/');
    if (slash == -1) {
      return null;
    }
    String bitsText = text.substring(slash + 1);
    if (!DECIMAL.matcher(bitsText).find()) {
      return null;
    }
    int bits = Integer.parseInt(bitsText);
    String head = text.substring(0, slash);
    if (head.indexOf(':') >= 0) {
      BigInteger n = ipv6(head);
      if (n == null || bits > 128) {
        return null;
      }
      return new Prefix(6, n, bits);
    }
    Long n = ipv4(head);
    if (n == null || bits > 32) {
      return null;
    }
    return new Prefix(4, BigInteger.valueOf(n), bits);
  }

  private static boolean covers(Prefix prefix, Address address) {
    if (prefix.v() != address.v()) {
      return false;
    }
    int shift = (prefix.v() == 4 ? 32 : 128) - prefix.bits();
    return address.n().shiftRight(shift).equals(prefix.base().shiftRight(shift));
  }

  /**
   * The prefixes in a published list, or null when the reply is not a list in the expected shape
   * (not an object, no prefixes, an entry that is not a prefix, or too many). One bad entry rejects
   * the whole list, so a half broken download never replaces a good copy.
   */
  public static List<String> readRangeList(Object body) {
    if (!(body instanceof Map<?, ?> object)) {
      return null;
    }
    if (!(object.get("prefixes") instanceof List<?> prefixes)
        || prefixes.isEmpty()
        || prefixes.size() > MAX_PREFIXES) {
      return null;
    }
    List<String> out = new ArrayList<>();
    for (Object entry : prefixes) {
      if (!(entry instanceof Map<?, ?> fields)) {
        return null;
      }
      Object v4 = fields.get("ipv4Prefix");
      Object v6 = fields.get("ipv6Prefix");
      String text = v4 instanceof String s ? s : v6 instanceof String s ? s : null;
      if (text == null) {
        return null;
      }
      Prefix prefix = parsePrefix(Js.trim(text));
      if (prefix == null || (v4 instanceof String) != (prefix.v() == 4)) {
        return null;
      }
      out.add(Js.trim(text));
    }
    return out;
  }

  /** A saved list of prefix strings read back as readRangeList reads a download, or null. */
  public static List<String> readPrefixes(Object list) {
    if (!(list instanceof List<?> items)) {
      return null;
    }
    List<Object> entries = new ArrayList<>();
    for (Object p : items) {
      String text = Js.string(p);
      entries.add(Json.object(text.indexOf(':') >= 0 ? "ipv6Prefix" : "ipv4Prefix", p));
    }
    return readRangeList(Json.object("prefixes", entries));
  }

  /**
   * Downloads one published list. Null when it cannot be fetched or read; the caller keeps what it
   * had.
   */
  public static List<String> downloadRangeList(Fetcher fetcher, String url, long timeoutMs) {
    try {
      Response response =
          fetcher.fetch(
              url,
              new FetchInit()
                  .header("accept", "application/json")
                  .header("user-agent", "Runlight (+https://runlight.sh)")
                  .redirect("follow")
                  .timeoutMs(timeoutMs)
                  .maxBytes(MAX_LIST_BYTES));
      if (!response.ok()) {
        return null;
      }
      String given = response.headers().get("content-length");
      double length = given == null ? 0 : Js.toNumber(given);
      if (length > MAX_LIST_BYTES) {
        return null;
      }
      String text = response.text();
      if (text.length() > MAX_LIST_BYTES) {
        return null;
      }
      Json.Parsed parsed = Json.tryParse(text);
      return parsed.ok() ? readRangeList(parsed.value()) : null;
    } catch (RuntimeException error) {
      return null;
    }
  }

  /** {@link #downloadRangeList(Fetcher, String, long)} with a 15 second timeout. */
  public static List<String> downloadRangeList(Fetcher fetcher, String url) {
    return downloadRangeList(fetcher, url, 15_000L);
  }

  /**
   * Parsed prefixes, kept per list (the very list, not an equal one) so a list is read once however
   * many requests it checks. Lists are replaced at most daily, so a bound this size only ever drops
   * ones no longer in use.
   */
  private static final Map<List<String>, List<Prefix>> COMPILED =
      Collections.synchronizedMap(new IdentityHashMap<>());

  private static List<Prefix> prefixesOf(List<String> list) {
    List<Prefix> parsed = COMPILED.get(list);
    if (parsed == null) {
      if (COMPILED.size() >= 256) {
        COMPILED.clear();
      }
      parsed = new ArrayList<>();
      for (String text : list) {
        Prefix p = parsePrefix(text);
        if (p != null) {
          parsed.add(p);
        }
      }
      COMPILED.put(list, parsed);
    }
    return parsed;
  }

  /** Whether {@code ip} is inside any of the prefixes. False for an address that cannot be read. */
  public static boolean inRanges(String ip, List<String> list) {
    Address address = parseAddress(ip);
    if (address == null) {
      return false;
    }
    for (Prefix p : prefixesOf(list)) {
      if (covers(p, address)) {
        return true;
      }
    }
    return false;
  }

  /**
   * The check for one request that names {@code agent}, made from {@code ip} (see the top of this
   * file): "verified", "mismatch", or "".
   */
  public static String checkAgent(
      Map<String, Object> agent, String ip, Map<String, List<String>> lists) {
    Object ranges = agent.get("ranges");
    List<String> list = ranges instanceof String url ? lists.get(url) : null;
    if (list == null || parseAddress(ip) == null) {
      return "";
    }
    return inRanges(ip, list) ? "verified" : "mismatch";
  }

  private static volatile Map<String, List<String>> bundled;

  /**
   * The lists that came with this version, from assets/agent-ranges.json: each list's URL and its
   * prefixes.
   */
  public static Map<String, List<String>> bundled() {
    Map<String, List<String>> current = bundled;
    if (current == null) {
      Map<String, Object> file = Js.map(Json.parse(Version.asset("agent-ranges.json")));
      Map<String, List<String>> lists = new LinkedHashMap<>();
      for (Map.Entry<String, Object> entry : Js.map(file.get("lists")).entrySet()) {
        lists.put(entry.getKey(), List.copyOf(Js.strings(Js.list(entry.getValue()))));
      }
      current = Collections.unmodifiableMap(lists);
      bundled = current;
    }
    return current;
  }
}

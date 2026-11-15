package sh.runlight;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * JSON written exactly as JavaScript's JSON.stringify writes it, and read as JSON.parse reads it,
 * so answers match the TypeScript SDK byte for byte.
 *
 * <p>Values are plain Java: {@code null}, {@link Boolean}, a number ({@link Long} for a whole
 * number JavaScript holds exactly, {@link Double} otherwise; any {@link Number} is written), {@link
 * String}, a {@link List} for an array and a {@link Map} with string keys for an object. {@link
 * #UNDEFINED} is JavaScript's undefined: an object field holding it is left out and an array item
 * holding it is written null, as JSON.stringify does. Objects are written with array-index keys
 * first in ascending order, then the rest as inserted, which is JavaScript's own property order.
 */
public final class Json {
  private Json() {}

  /** JavaScript's undefined. */
  public static final Object UNDEFINED = Undefined.VALUE;

  /** The text of {@code JSON.parse} failing, with where it stopped. */
  public static final class JsonException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    public JsonException(String message) {
      super(message);
    }
  }

  /** JSON.stringify(value). */
  public static String stringify(Object value) {
    StringBuilder out = new StringBuilder();
    write(out, value, null);
    return out.toString();
  }

  /** JSON.stringify(value, null, indent), indent being spaces. */
  public static String stringify(Object value, int indent) {
    if (indent <= 0) {
      return stringify(value);
    }
    StringBuilder out = new StringBuilder();
    write(out, value, " ".repeat(Math.min(indent, 10)));
    return out.toString();
  }

  /** An ordered object from name and value pairs: {@code Json.object("a", 1, "b", "x")}. */
  public static Map<String, Object> object(Object... pairs) {
    Map<String, Object> map = new LinkedHashMap<>();
    for (int i = 0; i + 1 < pairs.length; i += 2) {
      map.put((String) pairs[i], pairs[i + 1]);
    }
    return map;
  }

  /** A mutable array of these items. */
  public static List<Object> array(Object... items) {
    List<Object> list = new ArrayList<>(items.length);
    for (Object item : items) {
      list.add(item);
    }
    return list;
  }

  /** JSON.parse(text). Throws {@link JsonException} where JSON.parse throws a SyntaxError. */
  public static Object parse(String text) {
    return parse(text, false);
  }

  private static Object parse(String text, boolean shallow) {
    Parser parser = new Parser(text, shallow);
    parser.space();
    Object value = parser.value();
    parser.space();
    if (parser.at < text.length()) {
      throw new JsonException("Unexpected non-whitespace character after JSON");
    }
    return value;
  }

  /** What {@link #tryParse} read: whether it parsed, and the value. */
  public record Parsed(boolean ok, Object value) {}

  /** JSON.parse inside a try: never throws. */
  public static Parsed tryParse(String text) {
    try {
      return new Parsed(true, parse(text));
    } catch (JsonException e) {
      return new Parsed(false, null);
    }
  }

  /**
   * As {@link #tryParse}, for a body whose depths are never read, such as a tracker hit: an object
   * or array nested past {@link #MAX_DEPTH} is checked to be JSON and left out as null, rather than
   * refused, so the rest reads as JSON.parse reads it however deep some part of it goes.
   */
  public static Parsed tryParseShallow(String text) {
    try {
      return new Parsed(true, parse(text, true));
    } catch (JsonException e) {
      return new Parsed(false, null);
    }
  }

  /** A number as JavaScript's String(number) writes it. */
  public static String number(double n) {
    if (Double.isNaN(n)) {
      return "NaN";
    }
    if (Double.isInfinite(n)) {
      return n > 0 ? "Infinity" : "-Infinity";
    }
    if (n == 0) {
      return "0";
    }
    if (n == Math.rint(n) && Math.abs(n) < 1e15) {
      return Long.toString((long) n);
    }
    // Double.toString gives the shortest digits that read back (JDK 19 and newer), as JavaScript
    // chooses them; only the layout differs.
    BigDecimal decimal = new BigDecimal(Double.toString(Math.abs(n))).stripTrailingZeros();
    String digits = decimal.unscaledValue().toString();
    int k = digits.length();
    // The value is 0.digits times 10 to the power p.
    int p = k - decimal.scale();
    StringBuilder out = new StringBuilder();
    if (n < 0) {
      out.append('-');
    }
    if (k <= p && p <= 21) {
      out.append(digits).append("0".repeat(p - k));
    } else if (0 < p && p <= 21) {
      out.append(digits, 0, p).append('.').append(digits, p, k);
    } else if (-6 < p && p <= 0) {
      out.append("0.").append("0".repeat(-p)).append(digits);
    } else {
      int e = p - 1;
      out.append(digits.charAt(0));
      if (k > 1) {
        out.append('.').append(digits, 1, k);
      }
      out.append('e').append(e >= 0 ? '+' : '-').append(Math.abs(e));
    }
    return out.toString();
  }

  /** A number as JSON.stringify writes it: NaN and the infinities as null. */
  public static String jsonNumber(Number n) {
    if (n instanceof Long || n instanceof Integer || n instanceof Short || n instanceof Byte) {
      long v = n.longValue();
      if (Math.abs(v) <= (1L << 53)) {
        return Long.toString(v);
      }
      return number((double) v);
    }
    double d = n.doubleValue();
    if (Double.isNaN(d) || Double.isInfinite(d)) {
      return "null";
    }
    return number(d);
  }

  /** An object or array being written: what is left of it, and whether anything was written. */
  private static final class Open {
    final Iterator<?> rest;
    final boolean object;
    boolean any;

    Open(Iterator<?> rest, boolean object) {
      this.rest = rest;
      this.object = object;
    }
  }

  /**
   * Writes a value. What is open is kept in a list rather than in calls, so a value nested however
   * deep is written without a call for each level.
   */
  private static void write(StringBuilder out, Object root, String indent) {
    List<Open> open = new ArrayList<>();
    Object value = root;
    while (true) {
      while (value instanceof JsonValue j) {
        value = j.toJson();
      }
      if (value instanceof Object[] array) {
        value = List.of(array);
      }
      if (value == null || value == UNDEFINED) {
        out.append("null");
      } else if (value instanceof Boolean b) {
        out.append(b ? "true" : "false");
      } else if (value instanceof Number n) {
        out.append(jsonNumber(n));
      } else if (value instanceof CharSequence s) {
        quote(out, s.toString());
      } else if (value instanceof Map<?, ?> map) {
        out.append('{');
        open.add(new Open(Js.entries(map).iterator(), true));
      } else if (value instanceof Collection<?> list) {
        out.append('[');
        open.add(new Open(list.iterator(), false));
      } else {
        quote(out, value.toString());
      }
      // On to the next value of whatever is open, closing what has none left.
      boolean found = false;
      while (!found) {
        if (open.isEmpty()) {
          return;
        }
        Open top = open.get(open.size() - 1);
        String key = null;
        Object next = null;
        while (!found && top.rest.hasNext()) {
          Object item = top.rest.next();
          if (top.object) {
            Map.Entry<?, ?> entry = (Map.Entry<?, ?>) item;
            // A field holding undefined is left out, as JSON.stringify leaves it.
            if (entry.getValue() == UNDEFINED) {
              continue;
            }
            key = (String) entry.getKey();
            next = entry.getValue();
          } else {
            next = item;
          }
          found = true;
        }
        if (!found) {
          open.remove(open.size() - 1);
          if (top.any && indent != null) {
            out.append('\n').append(indent.repeat(open.size()));
          }
          out.append(top.object ? '}' : ']');
          continue;
        }
        if (top.any) {
          out.append(',');
        }
        top.any = true;
        if (indent != null) {
          out.append('\n').append(indent.repeat(open.size()));
        }
        if (top.object) {
          quote(out, key);
          out.append(indent == null ? ":" : ": ");
        }
        value = next;
      }
    }
  }

  /** A string as JSON.stringify quotes it, a lone surrogate written as an escape. */
  public static String quote(String text) {
    StringBuilder out = new StringBuilder(text.length() + 2);
    quote(out, text);
    return out.toString();
  }

  private static void quote(StringBuilder out, String text) {
    out.append('"');
    int length = text.length();
    for (int i = 0; i < length; i++) {
      char c = text.charAt(i);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\b' -> out.append("\\b");
        case '\f' -> out.append("\\f");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (c < 0x20) {
            out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
          } else if (Character.isHighSurrogate(c)) {
            if (i + 1 < length && Character.isLowSurrogate(text.charAt(i + 1))) {
              out.append(c).append(text.charAt(++i));
            } else {
              out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
            }
          } else if (Character.isLowSurrogate(c)) {
            out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
          } else {
            out.append(c);
          }
        }
      }
    }
    out.append('"');
  }

  /** A value that writes itself as a JSON value. */
  public interface JsonValue {
    Object toJson();
  }

  /**
   * The deepest arrays and objects may nest. Reading a value takes no calls, however deep it goes,
   * and neither does writing one back (stringify, and String() of an array), so those can never run
   * a thread's stack out. The limit is for whatever else walks a value it was handed, a call a
   * level: two hundred levels take a few tens of kilobytes of stack, where the 5,000 once allowed
   * ran out a megabyte. Nothing Runlight reads nests a tenth as deep.
   */
  public static final int MAX_DEPTH = 200;

  private static final class Parser {
    private final String text;
    private int at;

    /** Whether what nests past the limit is left out as null rather than refused. */
    private final boolean shallow;

    Parser(String text, boolean shallow) {
      this.text = text;
      this.shallow = shallow;
    }

    void space() {
      while (at < text.length()) {
        char c = text.charAt(at);
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
          at++;
        } else {
          break;
        }
      }
    }

    JsonException error() {
      return new JsonException(
          at >= text.length()
              ? "Unexpected end of JSON input"
              : "Unexpected token in JSON at position " + at);
    }

    /** The value at the cursor: an object or array's own values are read from a list, not calls. */
    Object value() {
      // The objects and arrays still open, outermost first, and beside each object the key whose
      // value is being read.
      List<Object> open = new ArrayList<>();
      List<String> keys = new ArrayList<>();
      while (true) {
        if (at >= text.length()) {
          throw error();
        }
        char c = text.charAt(at);
        Object done;
        if (c == '{' || c == '[') {
          if (open.size() >= MAX_DEPTH && !shallow) {
            throw new JsonException("Maximum call stack size exceeded");
          }
          at++;
          space();
          if (at < text.length() && text.charAt(at) == (c == '{' ? '}' : ']')) {
            at++;
            done = kept(open.size(), c == '{' ? new LinkedHashMap<String, Object>() : list());
          } else {
            open.add(c == '{' ? new LinkedHashMap<String, Object>() : list());
            keys.add(c == '{' ? key() : null);
            space();
            continue;
          }
        } else {
          done = scalar(c);
        }
        // The value read goes into whatever is open, which may close in turn.
        while (true) {
          if (open.isEmpty()) {
            return done;
          }
          int last = open.size() - 1;
          Object into = open.get(last);
          boolean object = into instanceof Map<?, ?>;
          if (object) {
            Js.map(into).put(keys.get(last), done);
          } else {
            Js.list(into).add(done);
          }
          space();
          if (at < text.length() && text.charAt(at) == ',') {
            at++;
            space();
            if (object) {
              keys.set(last, key());
              space();
            }
            break;
          }
          if (at < text.length() && text.charAt(at) == (object ? '}' : ']')) {
            at++;
            open.remove(last);
            keys.remove(last);
            done = kept(last, into);
            continue;
          }
          throw error();
        }
      }
    }

    private static List<Object> list() {
      return new ArrayList<>();
    }

    /** An object or array as it is kept: null when it is nested past the limit and left out. */
    private static Object kept(int depth, Object value) {
      return depth >= MAX_DEPTH ? null : value;
    }

    /** An object's next key, with the cursor left after its colon. */
    private String key() {
      if (at >= text.length() || text.charAt(at) != '"') {
        throw error();
      }
      String key = string();
      space();
      if (at >= text.length() || text.charAt(at) != ':') {
        throw error();
      }
      at++;
      return key;
    }

    private Object scalar(char c) {
      switch (c) {
        case '"' -> {
          return string();
        }
        case 't' -> {
          return literal("true", true);
        }
        case 'f' -> {
          return literal("false", false);
        }
        case 'n' -> {
          return literal("null", null);
        }
        default -> {
          if (c == '-' || (c >= '0' && c <= '9')) {
            return number();
          }
          throw error();
        }
      }
    }

    Object literal(String word, Object value) {
      if (text.startsWith(word, at)) {
        at += word.length();
        return value;
      }
      throw error();
    }

    Object number() {
      int start = at;
      if (text.charAt(at) == '-') {
        at++;
      }
      if (at >= text.length()) {
        throw error();
      }
      char c = text.charAt(at);
      if (c == '0') {
        at++;
      } else if (c >= '1' && c <= '9') {
        while (at < text.length() && Character.isDigit(text.charAt(at)) && text.charAt(at) < 128) {
          at++;
        }
      } else {
        throw error();
      }
      boolean whole = true;
      if (at < text.length() && text.charAt(at) == '.') {
        whole = false;
        at++;
        int digits = at;
        while (at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9') {
          at++;
        }
        if (at == digits) {
          throw error();
        }
      }
      if (at < text.length() && (text.charAt(at) == 'e' || text.charAt(at) == 'E')) {
        whole = false;
        at++;
        if (at < text.length() && (text.charAt(at) == '+' || text.charAt(at) == '-')) {
          at++;
        }
        int digits = at;
        while (at < text.length() && text.charAt(at) >= '0' && text.charAt(at) <= '9') {
          at++;
        }
        if (at == digits) {
          throw error();
        }
      }
      String literal = text.substring(start, at);
      return Js.num(
          whole && literal.length() < 17
              ? (Object) Long.parseLong(literal)
              : Double.parseDouble(literal));
    }

    String string() {
      at++;
      StringBuilder out = new StringBuilder();
      while (true) {
        if (at >= text.length()) {
          throw new JsonException("Unterminated string in JSON at position " + at);
        }
        char c = text.charAt(at++);
        if (c == '"') {
          return out.toString();
        }
        if (c < 0x20) {
          at--;
          throw error();
        }
        if (c != '\\') {
          out.append(c);
          continue;
        }
        if (at >= text.length()) {
          throw error();
        }
        char e = text.charAt(at++);
        switch (e) {
          case '"' -> out.append('"');
          case '\\' -> out.append('\\');
          case '/' -> out.append('/');
          case 'b' -> out.append('\b');
          case 'f' -> out.append('\f');
          case 'n' -> out.append('\n');
          case 'r' -> out.append('\r');
          case 't' -> out.append('\t');
          case 'u' -> {
            if (at + 4 > text.length()) {
              throw error();
            }
            int code = 0;
            for (int i = 0; i < 4; i++) {
              int d = Character.digit(text.charAt(at + i), 16);
              if (d < 0 || text.charAt(at + i) > 127) {
                throw error();
              }
              code = code * 16 + d;
            }
            at += 4;
            out.append((char) code);
          }
          default -> {
            at--;
            throw error();
          }
        }
      }
    }
  }
}

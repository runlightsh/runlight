package sh.runlight.db;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A Db whose tables and indexes start with a prefix of the app's choosing in place of {@code rl_},
 * such as {@code wp_rl_} inside WordPress, so two apps sharing one database each keep a set of
 * their own. Runlight's SQL names every table and index {@code rl_} and something, and those names
 * alone are rewritten on the way through, in each statement and in the names a schema check
 * compares as text. A store given a prefix puts one in front of its Db, so the accounts and
 * importers that reach the Db through the store follow it too.
 */
public final class Prefixed implements Db {
  /**
   * A name in a statement, and short enough that the longest index name stays inside MySQL's 64.
   */
  private static final Pattern VALID = Pattern.compile("[A-Za-z_][A-Za-z0-9_]{0,31}");

  private static final Pattern NAME = Pattern.compile("\\brl_(?=[a-z])");

  private final Db inner;
  private final String prefix;

  /**
   * @throws IllegalArgumentException for a prefix that is not up to 32 letters, digits, and
   *     underscores, or that starts with a digit
   */
  public Prefixed(Db inner, String prefix) {
    if (prefix == null || !VALID.matcher(prefix).matches()) {
      throw new IllegalArgumentException(
          "Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit");
    }
    this.inner = inner;
    this.prefix = prefix;
  }

  /** The Db underneath, whose names are {@code rl_}. */
  public Db inner() {
    return inner;
  }

  /** What every table and index name starts with here. */
  public String prefix() {
    return prefix;
  }

  /** A statement with each of Runlight's names under the prefix. */
  public String sql(String sql) {
    return NAME.matcher(sql).replaceAll(Matcher.quoteReplacement(prefix));
  }

  @Override
  public String dialect() {
    return inner.dialect();
  }

  @Override
  public List<Map<String, Object>> all(String sql, List<?> params) {
    return inner.all(sql(sql), params);
  }

  @Override
  public void run(String sql, List<?> params) {
    inner.run(sql(sql), params);
  }

  @Override
  public long affected(String sql, List<?> params) {
    return inner.affected(sql(sql), params);
  }

  @Override
  public <T> T transaction(Function<Db, T> fn) {
    return inner.transaction(db -> fn.apply(wrap(db)));
  }

  @Override
  public <T> T exclusive(Function<Db, T> fn) {
    return inner.exclusive(db -> fn.apply(wrap(db)));
  }

  private Db wrap(Db db) {
    return db == inner ? this : new Prefixed(db, prefix);
  }

  @Override
  public boolean metered() {
    return inner.metered();
  }

  @Override
  public void close() {
    inner.close();
  }
}

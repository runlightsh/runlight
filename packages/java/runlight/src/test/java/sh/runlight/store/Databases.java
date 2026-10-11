package sh.runlight.store;

import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import sh.runlight.Hash;
import sh.runlight.db.Connect;
import sh.runlight.db.Db;

/**
 * The databases the store tests run on: SQLite always; Postgres when RUNLIGHT_TEST_PG holds a
 * connection string (each test gets a schema of its own); MySQL 8.4 and MariaDB 11.4 when
 * RUNLIGHT_TEST_MYSQL is set. RUNLIGHT_TEST_MYSQL may hold the URLs, separated by spaces or commas;
 * any other value means the two local test servers. Each MySQL test gets a database of its own.
 * SQLite, Postgres, and the first MySQL server each run once more with the tables under another
 * prefix, as kinds ending in "+prefix".
 */
public final class Databases {
  private Databases() {}

  public static final Map<String, String> MYSQL_URLS =
      Map.of(
          "mysql", "mysql://root:runlight@127.0.0.1:33084/runlight_test_java",
          "mariadb", "mysql://root:runlight@127.0.0.1:33114/runlight_test_java");

  /** The table prefix the "+prefix" kinds use in place of rl_, as WordPress would give one. */
  public static final String TEST_PREFIX = "wp_rl_";

  private static final String PLUS_PREFIX = "+prefix";

  private static final List<Runnable> CLEANUPS = new ArrayList<>();

  /**
   * Every kind of database at hand: sqlite, then postgres and the MySQL servers when set, then
   * sqlite, postgres, and the first MySQL server again with their tables under TEST_PREFIX.
   */
  public static List<String> kinds() {
    List<String> kinds = plainKinds();
    List<String> prefixed = new ArrayList<>();
    for (String kind : kinds) {
      if (kind.equals("sqlite") || kind.equals("postgres") || kind.equals("mysql")) {
        prefixed.add(kind + PLUS_PREFIX);
      }
    }
    kinds.addAll(prefixed);
    return kinds;
  }

  /** Every kind of database at hand, each with its tables under rl_. */
  public static List<String> plainKinds() {
    List<String> kinds = new ArrayList<>();
    kinds.add("sqlite");
    if (pgUrl() != null) {
      kinds.add("postgres");
    }
    kinds.addAll(mysqlUrls().keySet());
    return kinds;
  }

  /** The kinds other than SQLite, each with its tables under rl_. */
  public static List<String> servers() {
    List<String> kinds = plainKinds();
    kinds.remove("sqlite");
    return kinds;
  }

  /** The kind of database without "+prefix". */
  public static String base(String kind) {
    return kind.endsWith(PLUS_PREFIX)
        ? kind.substring(0, kind.length() - PLUS_PREFIX.length())
        : kind;
  }

  /** The table prefix a kind's stores use. */
  public static String prefix(String kind) {
    return kind.endsWith(PLUS_PREFIX) ? TEST_PREFIX : SqlStore.PREFIX;
  }

  public static String pgUrl() {
    String url = System.getenv("RUNLIGHT_TEST_PG");
    if (url == null || url.isEmpty()) {
      return null;
    }
    // Set to anything but a URL (such as 1), the local server the port's tests use.
    return url.contains("://") ? url : "postgres://joncphillips@127.0.0.1:5432/runlight_test_java";
  }

  public static Map<String, String> mysqlUrls() {
    String value = System.getenv("RUNLIGHT_TEST_MYSQL");
    Map<String, String> out = new LinkedHashMap<>();
    if (value == null || value.isEmpty()) {
      return out;
    }
    List<String> urls = new ArrayList<>();
    for (String part : value.split("[\\s,]+")) {
      if (part.contains("://")) {
        urls.add(part);
      }
    }
    if (urls.isEmpty()) {
      out.put("mysql", MYSQL_URLS.get("mysql"));
      out.put("mariadb", MYSQL_URLS.get("mariadb"));
      return out;
    }
    for (int i = 0; i < urls.size(); i++) {
      out.put(i == 0 ? "mysql" : "mysql" + i, urls.get(i));
    }
    return out;
  }

  /** A fresh, empty store of a kind, dropped by cleanup(). */
  public static SqlStore fresh(String kind) {
    String prefix = prefix(kind);
    kind = base(kind);
    if (kind.equals("sqlite")) {
      return Stores.sqlite(":memory:", prefix);
    }
    if (kind.equals("postgres")) {
      String name = pgSchema();
      SqlStore store = Stores.postgres(pgUrl(), 120_000, name, 10, prefix);
      CLEANUPS.add(store::close);
      return store;
    }
    SqlStore store = Stores.mysql(mysqlDatabase(mysqlUrls().get(kind)), 120_000, 10, prefix);
    CLEANUPS.add(store::close);
    return store;
  }

  /**
   * A database of its own on a MySQL server, made empty for one test and dropped by cleanup(), so
   * tables another test made (accounts, say) never show up in it.
   */
  public static String mysqlDatabase(String url) {
    String name = "rl_test_" + HexFormat.of().formatHex(Hash.randomBytes(5));
    Db admin = Connect.mysql(url, 0);
    admin.run("CREATE DATABASE `" + name + "`");
    CLEANUPS.add(
        () -> {
          admin.run("DROP DATABASE IF EXISTS `" + name + "`");
          admin.close();
        });
    return url.replaceFirst("^([a-z]+://[^/?#]*)(/[^?#]*)?", "$1/" + name);
  }

  /** A schema of its own in the Postgres test database, dropped by cleanup(). */
  public static String pgSchema() {
    String name = "rl_test_" + HexFormat.of().formatHex(Hash.randomBytes(5));
    Db admin = Connect.postgres(pgUrl(), 0, null);
    admin.run("CREATE SCHEMA " + name);
    CLEANUPS.add(
        () -> {
          admin.run("DROP SCHEMA " + name + " CASCADE");
          admin.close();
        });
    return name;
  }

  /** Drops what the tests made, newest first, so each store closes before its database goes. */
  public static void cleanup() {
    while (!CLEANUPS.isEmpty()) {
      Runnable fn = CLEANUPS.remove(CLEANUPS.size() - 1);
      try {
        fn.run();
      } catch (RuntimeException e) {
        System.err.println("cleanup: " + e.getMessage());
      }
    }
  }
}

package sh.runlight.db;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.attribute.PosixFilePermissions;
import java.sql.Connection;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import sh.runlight.Js;

/**
 * Opens the database a store keeps its tables in, set up per connection as the TypeScript drivers
 * set up theirs. Tables are prefixed {@code rl_}, so the database can be the app's own. The JDBC
 * driver is the app's: sqlite-jdbc, PostgreSQL's, MySQL Connector/J, or MariaDB Connector/J.
 */
public final class Connect {
  private Connect() {}

  /** A SQLite file, or ":memory:", with the pragmas stores/sqlite.ts sets. */
  public static JdbcDb sqlite(String path) {
    return new JdbcDb(
        "sqlite",
        new JdbcDb.Pool(
            () -> {
              boolean made = false;
              if (!path.isEmpty() && !path.equals(":memory:") && !path.startsWith("file:")) {
                // A file in a folder that is not there yet gets the folder, as a fresh app's data/
                // often is, for the owner and group alone as the file is.
                File parent = new File(path).getAbsoluteFile().getParentFile();
                if (parent != null && !parent.isDirectory()) {
                  List<File> missing = new ArrayList<>();
                  for (File f = parent; f != null && !f.exists(); f = f.getParentFile()) {
                    missing.add(f);
                  }
                  parent.mkdirs();
                  for (File folder : missing) {
                    ownerAndGroup(folder, "rwxrwx---");
                  }
                }
                made = !new File(path).exists();
              }
              Properties props = new Properties();
              // better-sqlite3 waits up to five seconds for a lock from the moment it opens.
              props.setProperty("busy_timeout", "5000");
              Connection connection = open("jdbc:sqlite:" + path, props);
              // Before WAL is turned on, so the -wal and -shm files SQLite makes later follow it.
              if (made) {
                ownerAndGroup(new File(path), "rw-rw----");
              }
              try (Statement statement = connection.createStatement()) {
                statement.execute("PRAGMA journal_mode = WAL");
                statement.execute("PRAGMA synchronous = NORMAL");
                statement.execute("PRAGMA busy_timeout = 5000");
                // Deleted rows, such as a day's salt once it is gone, are overwritten where that
                // costs no extra writes, so they do not linger in the file's free space.
                statement.execute("PRAGMA secure_delete = FAST");
              }
              return connection;
            }),
        0);
  }

  /**
   * Postgres from a URL like postgres://user:pass@host:5432/db?sslmode=require. {@code
   * statementTimeout} stops any one statement after that many milliseconds; 0 turns it off. It is
   * set when the connection starts, so {@code RESET statement_timeout} comes back to it. {@code
   * schema}, when given, is the search path.
   */
  public static JdbcDb postgres(String url, long statementTimeout, String schema) {
    return postgres(url, statementTimeout, schema, JdbcDb.Pool.MAX);
  }

  /** As {@link #postgres(String, long, String)}, with at most {@code max} connections open. */
  public static JdbcDb postgres(String url, long statementTimeout, String schema, int max) {
    Parts parts = parts(url);
    return new JdbcDb(
        "postgres",
        new JdbcDb.Pool(
            () -> {
              Properties props = credentials(parts);
              String sslmode = parts.query().get("sslmode");
              if (sslmode != null) {
                props.setProperty("sslmode", sslmode);
              }
              // Settings in the URL's own `options`, as pg takes them, come first.
              StringBuilder options = new StringBuilder();
              String own = parts.query().get("options");
              if (own != null) {
                options.append(own);
              }
              if (statementTimeout > 0) {
                options
                    .append(options.length() > 0 ? " " : "")
                    .append("-c statement_timeout=")
                    .append(statementTimeout);
              }
              if (schema != null) {
                options
                    .append(options.length() > 0 ? " " : "")
                    .append("-c search_path=")
                    .append(option(schema));
              }
              if (options.length() > 0) {
                props.setProperty("options", options.toString());
              }
              // A connection waits at most 10 seconds for the server.
              props.setProperty("connectTimeout", "10");
              return open(
                  "jdbc:postgresql://"
                      + parts.host()
                      + ":"
                      + (parts.port() > 0 ? parts.port() : 5432)
                      + "/"
                      + parts.database(),
                  props);
            },
            max),
        0);
  }

  /**
   * MySQL 8.0.20 or MariaDB 11.4 and later from a URL like mysql://user:pass@host:3306/db (or
   * mariadb://). The session is utf8mb4 with the server's own SQL mode less NO_BACKSLASH_ESCAPES
   * and with IGNORE_SPACE added, as mysql2 asks for it. Runlight's tables carry their own binary
   * collation, so text compares and sorts by code point. {@code statementTimeout} is set per
   * connection; 0 turns it off.
   */
  public static JdbcDb mysql(String url, long statementTimeout) {
    return mysql(url, statementTimeout, JdbcDb.Pool.MAX);
  }

  /** As {@link #mysql(String, long)}, with at most {@code max} connections open. */
  public static JdbcDb mysql(String url, long statementTimeout, int max) {
    boolean maria = url.toLowerCase(Locale.ROOT).startsWith("mariadb:");
    Parts parts = parts(url);
    return new JdbcDb(
        "mysql",
        new JdbcDb.Pool(
            () -> {
              Properties props = credentials(parts);
              String address =
                  "//"
                      + parts.host()
                      + ":"
                      + (parts.port() > 0 ? parts.port() : 3306)
                      + "/"
                      + parts.database();
              String jdbc = mysqlDriver(maria, address);
              if (jdbc.startsWith("jdbc:mysql:")) {
                props.setProperty("characterEncoding", "UTF-8");
                props.setProperty("connectTimeout", "10000");
              } else {
                props.setProperty("connectTimeout", "10000");
              }
              Connection connection = open(jdbc, props);
              try (Statement statement = connection.createStatement()) {
                statement.execute("SET NAMES utf8mb4");
                // NO_BACKSLASH_ESCAPES reads a backslash as text, so a quote in a value could end
                // it
                // early. Dropped wherever it sits in the server's own list.
                statement.execute(
                    "SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',NO_BACKSLASH_ESCAPES,', ','))");
                statement.execute(
                    "SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',IGNORE_SPACE')");
              }
              if (statementTimeout > 0) {
                JdbcDb.limitStatements(connection, statementTimeout);
              }
              return connection;
            },
            max),
        statementTimeout);
  }

  /** The JDBC URL for whichever MySQL driver the app has, MariaDB's for a mariadb:// URL first. */
  private static String mysqlDriver(boolean maria, String address) {
    String mysql = "jdbc:mysql:" + address;
    String mariadb = "jdbc:mariadb:" + address;
    String first = maria ? mariadb : mysql;
    String second = maria ? mysql : mariadb;
    return accepted(first) ? first : accepted(second) ? second : first;
  }

  private static boolean accepted(String url) {
    try {
      Driver driver = DriverManager.getDriver(url);
      return driver != null;
    } catch (SQLException e) {
      return false;
    }
  }

  /**
   * Picks the database from a URL's scheme: sqlite:, file:, postgres:, postgresql:, mysql:, or
   * mariadb:.
   */
  public static JdbcDb url(String url) {
    Matcher m = Pattern.compile("^([a-zA-Z][a-zA-Z0-9+.\\-]*):").matcher(url);
    String scheme = m.find() ? m.group(1).toLowerCase(Locale.ROOT) : "";
    return switch (scheme) {
      case "postgres", "postgresql" -> postgres(url, 120_000, null);
      case "mysql", "mariadb" -> mysql(url, 120_000);
      case "sqlite", "file" -> sqlite(url.replaceFirst("(?i)^(sqlite|file):(//)?", ""));
      default ->
          throw new IllegalArgumentException(
              "Runlight: DATABASE_URL must start with postgres://, mysql://, mariadb://, or sqlite:");
    };
  }

  /**
   * A database file just made is for its owner and group alone (0660), whatever the umask: the
   * visits in it are nobody else's to read, and a scheduled job running as another user of the same
   * group can still write to it. SQLite gives the -wal and -shm files it makes later the same mode.
   * Systems without such modes ignore it.
   */
  private static void ownerAndGroup(File file, String mode) {
    try {
      Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString(mode));
    } catch (IOException | UnsupportedOperationException | SecurityException e) {
      // Not a file this process may change, or a system with no such modes.
    }
  }

  private static Connection open(String url, Properties props) throws SQLException {
    return DriverManager.getConnection(url, props);
  }

  private static Properties credentials(Parts parts) {
    Properties props = new Properties();
    if (parts.user() != null) {
      props.setProperty("user", parts.user());
    }
    if (parts.password() != null) {
      props.setProperty("password", parts.password());
    }
    return props;
  }

  /** A value inside libpq's `options`, where a space or backslash is escaped with a backslash. */
  private static String option(String value) {
    return value.replaceAll("([\\\\\\s'])", "\\\\$1");
  }

  /** A database URL's parts. */
  record Parts(
      String host,
      int port,
      String user,
      String password,
      String database,
      Map<String, String> query) {}

  private static final Pattern URL =
      Pattern.compile(
          "^[a-zA-Z][a-zA-Z0-9+.\\-]*://(?:([^:@/]*)(?::([^@/]*))?@)?(\\[[^\\]]+\\]|[^:/?#]+)(?::(\\d+))?(?:/([^?#]*))?(?:\\?([^#]*))?");

  static Parts parts(String url) {
    Matcher m = URL.matcher(url);
    if (!m.find()) {
      throw new IllegalArgumentException("Runlight: the database URL could not be read");
    }
    Map<String, String> query = new LinkedHashMap<>();
    if (m.group(6) != null) {
      for (String pair : m.group(6).split("&")) {
        int at = pair.indexOf('=');
        String name = decode(at < 0 ? pair : pair.substring(0, at));
        String value = at < 0 ? "" : decode(pair.substring(at + 1));
        query.put(name, value);
      }
    }
    return new Parts(
        m.group(3),
        m.group(4) == null ? 0 : Integer.parseInt(m.group(4)),
        m.group(1) == null ? null : unescape(m.group(1)),
        m.group(2) == null ? null : unescape(m.group(2)),
        m.group(5) == null ? "" : unescape(m.group(5)),
        query);
  }

  /** A query value, + read as a space. */
  private static String decode(String text) {
    return unescape(text.replace("+", " "));
  }

  /** A part of the URL, percent-decoded. */
  private static String unescape(String text) {
    String decoded = Js.decodeURIComponent(text);
    return decoded == null ? text : decoded;
  }
}

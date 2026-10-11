package sh.runlight.store;

import javax.sql.DataSource;
import sh.runlight.db.Connect;
import sh.runlight.db.Db;
import sh.runlight.db.JdbcDb;

/**
 * The stores stores/sqlite.ts, stores/postgres.ts, and stores/mysql.ts make, over JDBC. Tables are
 * prefixed {@code rl_}, so the database can be the app's own, and a database made by the TypeScript
 * SDK opens here. Each one also takes a {@code prefix} to use in place of {@code rl_}: what every
 * table and index name starts with, so two apps sharing one database each keep a set of their own,
 * up to 32 letters, digits, and underscores, not starting with a digit.
 */
public final class Stores {
  private Stores() {}

  /** Runlight's tables in a SQLite file (or ":memory:"), in WAL mode. Needs sqlite-jdbc. */
  public static SqlStore sqlite(String path) {
    return sqlite(path, SqlStore.PREFIX);
  }

  /** As {@link #sqlite(String)}, with its tables under {@code prefix} in place of {@code rl_}. */
  public static SqlStore sqlite(String path, String prefix) {
    return new SqlStore(Connect.sqlite(path), prefix);
  }

  /**
   * Runlight's tables in Postgres from a connection string, with statements stopped after two
   * minutes. Needs the PostgreSQL JDBC driver.
   */
  public static SqlStore postgres(String url) {
    return postgres(url, 120_000, null);
  }

  /**
   * Runlight's tables in Postgres from a connection string.
   *
   * @param statementTimeout the longest one statement may run, in milliseconds, 0 for no limit
   * @param schema the search path, or null for the server's
   */
  public static SqlStore postgres(String url, long statementTimeout, String schema) {
    return postgres(url, statementTimeout, schema, 10);
  }

  /**
   * As {@link #postgres(String, long, String)}, with at most {@code max} connections open; a
   * statement past that waits up to ten seconds for one. Default 10.
   */
  public static SqlStore postgres(String url, long statementTimeout, String schema, int max) {
    return postgres(url, statementTimeout, schema, max, SqlStore.PREFIX);
  }

  /**
   * As {@link #postgres(String, long, String, int)}, with its tables under {@code prefix} in place
   * of {@code rl_}.
   */
  public static SqlStore postgres(
      String url, long statementTimeout, String schema, int max, String prefix) {
    if (url == null || url.isEmpty()) {
      throw new IllegalArgumentException("Runlight: postgres() needs a url or a pool");
    }
    return new SqlStore(Connect.postgres(url, statementTimeout, schema, max), prefix);
  }

  /**
   * Runlight's tables in MySQL 8.4 or MariaDB 11.4 and later, from a mysql:// or mariadb:// URL.
   * Text is utf8mb4 with a binary collation, so it compares and sorts by code point. Needs MySQL
   * Connector/J or MariaDB Connector/J.
   */
  public static SqlStore mysql(String url) {
    return mysql(url, 120_000);
  }

  /** As {@link #mysql(String)}, with a statement timeout in milliseconds, 0 for none. */
  public static SqlStore mysql(String url, long statementTimeout) {
    return mysql(url, statementTimeout, 10);
  }

  /**
   * As {@link #mysql(String, long)}, with at most {@code max} connections open; a statement past
   * that waits up to ten seconds for one. Default 10.
   */
  public static SqlStore mysql(String url, long statementTimeout, int max) {
    return mysql(url, statementTimeout, max, SqlStore.PREFIX);
  }

  /**
   * As {@link #mysql(String, long, int)}, with its tables under {@code prefix} in place of {@code
   * rl_}.
   */
  public static SqlStore mysql(String url, long statementTimeout, int max, String prefix) {
    if (url == null || url.isEmpty()) {
      throw new IllegalArgumentException("Runlight: mysql() needs a url or a pool");
    }
    return new SqlStore(Connect.mysql(url, statementTimeout, max), prefix);
  }

  /**
   * Runlight's tables in the database behind the app's own DataSource (its pool), whichever of
   * SQLite, Postgres, MySQL, or MariaDB it is. Runlight borrows a connection per statement, or per
   * transaction, and gives it back.
   */
  public static SqlStore dataSource(DataSource dataSource) {
    return new SqlStore(JdbcDb.of(dataSource, JdbcDb.dialectOf(dataSource)));
  }

  /** As {@link #dataSource(DataSource)}, the dialect ("sqlite", "postgres", "mysql") named. */
  public static SqlStore dataSource(DataSource dataSource, String dialect) {
    return dataSource(dataSource, dialect, SqlStore.PREFIX);
  }

  /**
   * As {@link #dataSource(DataSource, String)}, with its tables under {@code prefix} in place of
   * {@code rl_}, such as {@code wp_rl_}. A null dialect is read from the DataSource's driver.
   */
  public static SqlStore dataSource(DataSource dataSource, String dialect, String prefix) {
    return new SqlStore(
        JdbcDb.of(dataSource, dialect != null ? dialect : JdbcDb.dialectOf(dataSource)), prefix);
  }

  /**
   * The store a DATABASE_URL names, as the standalone server picks one: postgres:// or
   * postgresql:// for Postgres, mysql:// or mariadb:// for MySQL, and sqlite: or file: followed by
   * a path for SQLite.
   */
  public static SqlStore url(String databaseUrl) {
    return url(databaseUrl, SqlStore.PREFIX);
  }

  /** As {@link #url(String)}, with its tables under {@code prefix} in place of {@code rl_}. */
  public static SqlStore url(String databaseUrl, String prefix) {
    return new SqlStore(Connect.url(databaseUrl), prefix);
  }

  /** A store over any Db. */
  public static SqlStore fromDb(Db db) {
    return new SqlStore(db);
  }

  /**
   * A store over any Db, with its tables under {@code prefix} in place of {@code rl_}. A Db that is
   * already prefixed keeps its own.
   */
  public static SqlStore fromDb(Db db, String prefix) {
    return new SqlStore(db, prefix);
  }
}

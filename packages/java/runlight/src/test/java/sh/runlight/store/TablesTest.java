package sh.runlight.store;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import sh.runlight.Js;
import sh.runlight.Json;
import sh.runlight.Routes;
import sh.runlight.Runlight;
import sh.runlight.db.Connect;
import sh.runlight.db.Db;
import sh.runlight.db.JdbcDb;
import sh.runlight.db.TablesBusyError;
import sh.runlight.http.Headers;
import sh.runlight.http.Request;
import sh.runlight.http.Response;

/**
 * tables.test.ts: a table prefix keeping a second set of tables in one database, new SQLite files
 * for their owner and group alone, and a limit on waiting for another process creating the tables.
 */
class TablesTest {
  private final List<Runnable> closes = new ArrayList<>();

  @TempDir Path dir;

  @AfterEach
  void tearDown() {
    while (!closes.isEmpty()) {
      try {
        closes.remove(closes.size() - 1).run();
      } catch (RuntimeException e) {
        System.err.println("cleanup: " + e.getMessage());
      }
    }
    Databases.cleanup();
    JdbcDb.lockWaitInTests(null);
  }

  /** SQLite, and Postgres and the first MySQL server when they are at hand. */
  static List<String> kinds() {
    List<String> kinds = new ArrayList<>();
    for (String kind : Databases.plainKinds()) {
      if (kind.equals("sqlite") || kind.equals("postgres") || kind.equals("mysql")) {
        kinds.add(kind);
      }
    }
    return kinds;
  }

  /** Every table and index name in the database, as each dialect lists them. */
  private static List<String> names(Db db) {
    String sql =
        switch (db.dialect()) {
          case "sqlite" ->
              "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'";
          case "postgres" ->
              "SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'i', 'S')";
          default ->
              "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()"
                  + " UNION SELECT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name <> 'PRIMARY'";
        };
    List<String> out = new ArrayList<>();
    for (Map<String, Object> row : db.all(sql)) {
      out.add(Js.string(row.get("name")));
    }
    out.sort(null);
    return out;
  }

  /**
   * Two stores over one database, one with its tables under rl_ and one under wp_rl_ (a new one
   * each time it is asked for), and a raw look at it.
   */
  private record Pair(SqlStore plain, Supplier<SqlStore> other, Db raw) {}

  private Pair pair(String kind) {
    Function<SqlStore, SqlStore> kept =
        store -> {
          closes.add(store::close);
          return store;
        };
    if (kind.equals("sqlite")) {
      String file = dir.resolve("shared.db").toString();
      SqlStore plain = kept.apply(Stores.sqlite(file));
      return new Pair(plain, () -> kept.apply(Stores.sqlite(file, "wp_rl_")), plain.db());
    }
    if (kind.equals("postgres")) {
      String schema = Databases.pgSchema();
      String url = Databases.pgUrl();
      SqlStore plain = kept.apply(Stores.postgres(url, 120_000, schema, 3));
      return new Pair(
          plain, () -> kept.apply(Stores.postgres(url, 120_000, schema, 3, "wp_rl_")), plain.db());
    }
    String url = Databases.mysqlDatabase(Databases.mysqlUrls().get(kind));
    SqlStore plain = kept.apply(Stores.mysql(url, 120_000, 3));
    return new Pair(plain, () -> kept.apply(Stores.mysql(url, 120_000, 3, "wp_rl_")), plain.db());
  }

  private static Map<String, Object> site(String id) {
    return Json.object(
        "id", id, "name", id, "hostnames", List.of(id + ".example"), "timezone", "UTC");
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void aPrefixKeepsASecondSetOfTablesBesideTheFirstInOneDatabase(String kind) {
    Pair pair = pair(kind);
    SqlStore other = pair.other().get();
    other.migrate();
    // A second process with the same prefix finds every table and index already there.
    pair.other().get().migrate();
    List<String> made = names(pair.raw());
    assertFalse(made.isEmpty());
    assertEquals(
        List.of(),
        made.stream().filter(name -> !name.startsWith("wp_rl_")).toList(),
        "every name is under the prefix");
    assertEquals(SqlStore.TABLES.stream().map(table -> "wp_rl_" + table).toList(), other.tables());
    assertEquals(
        List.of(),
        other.tables().subList(0, 15).stream().filter(table -> !made.contains(table)).toList(),
        "the store's 15 tables, listed for removing them");

    pair.plain().migrate();
    long plainTables =
        names(pair.raw()).stream()
            .filter(name -> name.startsWith(SqlStore.PREFIX))
            .filter(name -> SqlStore.TABLES.contains(name.substring(SqlStore.PREFIX.length())))
            .count();
    assertEquals(15, plainTables);
    pair.plain().upsertSite(site("first"), 1);
    other.upsertSite(site("second"), 1);
    assertEquals(List.of("first"), ids(pair.plain().sites()));
    assertEquals(List.of("second"), ids(other.sites()));
    assertEquals(
        "second",
        other.transaction(tx -> tx.sites().get(0).get("id")),
        "a transaction keeps the prefix");
    other.setSetting("k", "wp");
    assertNull(pair.plain().setting("k"));
    assertEquals("wp", other.setting("k"));
  }

  private static List<Object> ids(List<Map<String, Object>> sites) {
    return sites.stream().map(s -> s.get("id")).toList();
  }

  @Test
  void aTablePrefixIsLettersDigitsAndUnderscoresAndDoesNotStartWithADigit() {
    for (String prefix : List.of("1rl_", "rl-", "rl_; DROP TABLE x", "", "a".repeat(33))) {
      IllegalArgumentException error =
          assertThrows(
              IllegalArgumentException.class, () -> Stores.sqlite(":memory:", prefix), prefix);
      assertEquals(
          "Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit",
          error.getMessage());
    }
    for (String prefix : List.of("rl_", "wp_rl_", "_x", "A".repeat(32))) {
      assertEquals(prefix, Stores.sqlite(":memory:", prefix).prefix());
    }
    assertEquals(
        "wp_rl_",
        new SqlStore(Stores.sqlite(":memory:", "wp_rl_").db()).prefix(),
        "a store over a prefixed Db keeps its prefix");
    assertEquals(List.of("rl_meta", "rl_sites"), Stores.sqlite(":memory:").tables().subList(0, 2));
  }

  @Test
  void aNewSqliteFileIsForItsOwnerAndGroupAloneAndSoAreTheFilesSqliteMakesBesideIt()
      throws IOException {
    assumeTrue(
        dir.getFileSystem().supportedFileAttributeViews().contains("posix"),
        "Windows has no such modes");
    Path file = dir.resolve("data").resolve("mode.db");
    SqlStore store = Stores.sqlite(file.toString());
    store.migrate();
    store.setSetting("k", "v");
    assertEquals("rw-rw----", PosixFilePermissions.toString(Files.getPosixFilePermissions(file)));
    Path wal = Path.of(file + "-wal");
    assertTrue(Files.exists(wal));
    assertEquals("rw-rw----", PosixFilePermissions.toString(Files.getPosixFilePermissions(wal)));
    assertEquals(
        "rwxrwx---",
        PosixFilePermissions.toString(Files.getPosixFilePermissions(file.getParent())),
        "the folder the store made for it");
    store.close();
  }

  /**
   * A Db whose lock for creating tables is held by another process: exclusive() waits until it is
   * told to give up (busy) or go ahead.
   */
  private static final class Held implements Db {
    private final Db inner;
    private volatile String state = "wait";

    Held(Db inner) {
      this.inner = inner;
    }

    void release(String to) {
      state = to;
    }

    @Override
    public String dialect() {
      return inner.dialect();
    }

    @Override
    public List<Map<String, Object>> all(String sql, List<?> params) {
      return inner.all(sql, params);
    }

    @Override
    public void run(String sql, List<?> params) {
      inner.run(sql, params);
    }

    @Override
    public long affected(String sql, List<?> params) {
      return inner.affected(sql, params);
    }

    @Override
    public <T> T transaction(Function<Db, T> fn) {
      return inner.transaction(fn);
    }

    @Override
    public <T> T exclusive(Function<Db, T> fn) {
      while (state.equals("wait")) {
        try {
          Thread.sleep(20);
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
          throw new IllegalStateException(e);
        }
      }
      if (state.equals("busy")) {
        throw new TablesBusyError();
      }
      return inner.exclusive(fn);
    }

    @Override
    public void close() {
      inner.close();
    }
  }

  @Test
  void aTrackerHitWaitsAMomentAtMostWhileAnotherProcessCreatesTheTablesAndOtherRequestsHearWhy()
      throws Exception {
    Held db = new Held(Connect.sqlite(":memory:"));
    Runlight rl =
        new Runlight(
            new Runlight.Options()
                .store(new SqlStore(db))
                .site(Json.object("hostnames", List.of("example.com")))
                .now(() -> 1_791_288_000_000L));
    Routes routes = rl.routes(new Routes.Options().token("secret"));
    long started = System.currentTimeMillis();
    Response hit =
        routes.handle(
            new Request(
                "https://example.com/runlight/e",
                "POST",
                Headers.of(
                    "user-agent",
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
                    "x-forwarded-for",
                    "203.0.113.1"),
                Json.stringify(
                    Json.object("k", "pageview", "u", "https://example.com/", "i", "a1"))));
    assertEquals(202, hit.status());
    long waited = System.currentTimeMillis() - started;
    assertTrue(waited >= 9900 && waited < 12000, "the hit waited " + waited + "ms");
    // The other process gives up the wait: the request that waited answers 503, saying why.
    Request stats =
        new Request(
            "https://example.com/runlight/api/stats?period=today&compare=off",
            "GET",
            Headers.of("authorization", "Bearer secret"),
            "");
    CompletableFuture<Response> asked = CompletableFuture.supplyAsync(() -> routes.handle(stats));
    db.release("busy");
    Response answer = asked.get(10, TimeUnit.SECONDS);
    assertEquals(503, answer.status());
    assertEquals("30", answer.headers().get("retry-after"));
    assertEquals(
        Json.object(
            "error",
            "Runlight is creating or upgrading its tables. Try again in a minute.",
            "code",
            "tables_busy"),
        Json.parse(answer.text()));
    // Once the tables are there, hits are counted again.
    db.release("go");
    rl.init();
    Object visitors = Js.get(Js.get(Json.parse(routes.handle(stats).text()), "stats"), "visitors");
    assertEquals(
        0L, Js.asLong(visitors), "the hit that came while the tables were busy was dropped");
  }

  @Test
  void postgresWaitingForAnotherProcessCreatingTheTablesGivesUpAfterTheLockWait() {
    assumeTrue(Databases.pgUrl() != null, "RUNLIGHT_TEST_PG is not set");
    String schema = Databases.pgSchema();
    Db other = Connect.postgres(Databases.pgUrl(), 0, schema);
    closes.add(other::close);
    SqlStore store = Stores.postgres(Databases.pgUrl(), 120_000, schema, 2);
    closes.add(store::close);
    JdbcDb.lockWaitInTests(1_000L);
    // The lock every Runlight takes to create tables, held by another session in a transaction,
    // which keeps its connection.
    other.transaction(
        db -> {
          // Asked for again and again, as the stores do, since waiting on it could deadlock with
          // an index another test is building concurrently.
          Object ok = null;
          for (int i = 0; i < 1200 && !Js.truthy(ok); i++) {
            if (i > 0) {
              pause(50);
            }
            ok =
                db.all("SELECT pg_try_advisory_lock(?) AS ok", List.of(JdbcDb.MIGRATION_LOCK))
                    .get(0)
                    .get("ok");
          }
          assertTrue(Js.truthy(ok), "the lock, which another process held for a minute: " + ok);
          long started = System.currentTimeMillis();
          TablesBusyError error = assertThrows(TablesBusyError.class, store::migrate);
          assertEquals(
              "Runlight: another process is creating or upgrading the tables, and had not finished after 1 seconds. Try again in a minute.",
              error.getMessage());
          assertTrue(System.currentTimeMillis() - started < 5_000);
          db.all("SELECT pg_advisory_unlock(?) AS ok", List.of(JdbcDb.MIGRATION_LOCK));
          return null;
        });
    store.migrate();
  }

  private static void pause(long ms) {
    try {
      Thread.sleep(ms);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new IllegalStateException(e);
    }
  }

  @Test
  void anIndexLeftUnusableIsBuiltAgainUnderAPrefixThatItselfStartsRl() {
    assumeTrue(Databases.pgUrl() != null, "RUNLIGHT_TEST_PG is not set");
    String schema = Databases.pgSchema();
    Db admin = Connect.postgres(Databases.pgUrl(), 0, null);
    closes.add(admin::close);
    Supplier<SqlStore> open =
        () -> {
          SqlStore store = Stores.postgres(Databases.pgUrl(), 120_000, schema, 2, "rl_wp_");
          closes.add(store::close);
          return store;
        };
    open.get().migrate();
    // As a concurrent build stopped part way leaves it.
    String index = "'" + schema + ".rl_wp_events_site_ts'::regclass";
    try {
      admin.run("UPDATE pg_index SET indisvalid = false WHERE indexrelid = " + index);
    } catch (RuntimeException e) {
      assumeTrue(false, "marking an index unusable needs a superuser");
    }
    // The full pass, as the scheduled check makes it, goes over every index.
    open.get().migrate(true);
    assertEquals(
        List.of(Map.of("valid", true)),
        admin.all("SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = " + index));
  }

  @Test
  void mysqlWaitingForAnotherProcessCreatingTheTablesGivesUpAfterTheLockWait() {
    assumeTrue(Databases.mysqlUrls().containsKey("mysql"), "RUNLIGHT_TEST_MYSQL is not set");
    String url = Databases.mysqlDatabase(Databases.mysqlUrls().get("mysql"));
    Db other = Connect.mysql(url, 0);
    closes.add(other::close);
    SqlStore store = Stores.mysql(url, 120_000, 2);
    closes.add(store::close);
    JdbcDb.lockWaitInTests(1_000L);
    String name = "CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48))";
    // The lock every Runlight takes to create tables in this database, held by another session in a
    // transaction, which keeps its connection.
    other.transaction(
        db -> {
          db.all("SELECT GET_LOCK(" + name + ", 0) AS ok");
          long started = System.currentTimeMillis();
          assertThrows(TablesBusyError.class, store::migrate);
          assertTrue(System.currentTimeMillis() - started < 5_000);
          db.run("DO RELEASE_LOCK(" + name + ")");
          return null;
        });
    store.migrate();
  }
}

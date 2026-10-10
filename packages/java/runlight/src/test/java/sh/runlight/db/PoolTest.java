package sh.runlight.db;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** The pool a store opens for itself from a URL. */
class PoolTest {
  @Test
  void noMoreThanTheCapAreOpenAndTheNextWaitsForOneToComeFree() throws Exception {
    AtomicInteger opened = new AtomicInteger();
    JdbcDb.Pool pool =
        new JdbcDb.Pool(
            () -> {
              opened.incrementAndGet();
              return DriverManager.getConnection("jdbc:sqlite::memory:");
            },
            2,
            200);
    Connection first = pool.open();
    Connection second = pool.open();
    assertThrows(SQLException.class, pool::open, "past the cap, a wait that runs out fails");
    CompletableFuture<Connection> third =
        CompletableFuture.supplyAsync(
            () -> {
              try {
                return pool.open();
              } catch (SQLException e) {
                throw new IllegalStateException(e);
              }
            });
    assertThrows(TimeoutException.class, () -> third.get(50, TimeUnit.MILLISECONDS));
    pool.release(first, false);
    assertSame(first, third.get(5, TimeUnit.SECONDS), "an idle one is handed on");
    // A broken one is closed, which makes room for a new one.
    pool.release(second, true);
    assertTrue(second.isClosed());
    Connection fresh = pool.open();
    assertFalse(fresh.isClosed());
    assertEquals(3, opened.get());
    pool.release(fresh, false);
    pool.release(first, false);
    pool.close();
  }

  @Test
  void aFailedOpenGivesItsPlaceBack() throws Exception {
    AtomicInteger tries = new AtomicInteger();
    JdbcDb.Pool pool =
        new JdbcDb.Pool(
            () -> {
              if (tries.incrementAndGet() == 1) {
                throw new SQLException("refused");
              }
              return DriverManager.getConnection("jdbc:sqlite::memory:");
            },
            1,
            200);
    assertThrows(SQLException.class, pool::open);
    Connection connection = pool.open();
    pool.release(connection, true);
    pool.close();
  }
}

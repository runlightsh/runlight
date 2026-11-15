package sh.runlight.accounts;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import sh.runlight.store.Databases;
import sh.runlight.store.SqlStore;

/** The second-factor lockout: five tries, then locks that double from fifteen minutes to a day. */
class LockoutTest {
  private static final long NOW = 1_791_288_000_000L;
  private static final long MIN = 60_000L;
  private static final long HOUR = 60 * MIN;

  private static SqlStore store() {
    SqlStore store = Databases.fresh("sqlite");
    store.migrate();
    return store;
  }

  /** Uses up the tries from a time on, and says how many were taken. */
  private static int takeAll(Lockout lockout, String key, long at) {
    int taken = 0;
    while (taken < 20 && lockout.take(key, at)) {
      taken++;
    }
    return taken;
  }

  @Test
  void fiveTriesThenLocksThatDoubleUpToADay() {
    SqlStore store = store();
    Lockout lockout = new Lockout(store, "code");
    assertEquals(5, takeAll(lockout, "u1", NOW), "five tries, the fifth starting the lock");
    long[] locks = {
      15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR, 24 * HOUR, 24 * HOUR
    };
    long at = NOW;
    for (long lock : locks) {
      assertFalse(lockout.take("u1", at + lock - 1), "still locked a moment before " + lock);
      at += lock;
      assertEquals(5, takeAll(lockout, "u1", at), "five more once the lock of " + lock + " ends");
    }
    // Another key, and the same key under another name, count apart, in another instance too.
    assertTrue(new Lockout(store, "code").take("u2", NOW));
    assertTrue(new Lockout(store, "other").take("u1", NOW));
    assertFalse(new Lockout(store, "code").take("u1", at + 1), "shared through the database");
  }

  @Test
  void theCountStartsAgainFifteenMinutesAfterTheFirstTryAndARightCodeClearsIt() {
    Lockout lockout = new Lockout(store(), "code");
    for (int i = 0; i < 4; i++) {
      assertTrue(lockout.take("u1", NOW + i));
    }
    // Four tries and no lock: the window ends, and the count with it.
    assertEquals(5, takeAll(lockout, "u1", NOW + 15 * MIN));
    assertFalse(lockout.take("u1", NOW + 16 * MIN));
    lockout.clear("u1");
    assertEquals(5, takeAll(lockout, "u1", NOW + 16 * MIN), "cleared, and the first lock again");
    assertFalse(lockout.take("u1", NOW + 30 * MIN));
    assertTrue(lockout.take("u1", NOW + 31 * MIN), "fifteen minutes, not thirty");
  }

  @Test
  void aKeyIsForgottenAWeekAfterItsLastLockEndedAndSweptWithTheThrottles() {
    SqlStore store = store();
    Lockout lockout = new Lockout(store, "code");
    assertEquals(5, takeAll(lockout, "u1", NOW));
    assertEquals(5, takeAll(lockout, "u1", NOW + 15 * MIN));
    long week = 7 * 24 * HOUR;
    // The second lock, of thirty minutes, ended at 45 minutes; a week on the key is new again.
    Throttle.sweep(store, NOW + 45 * MIN + week - 1);
    assertEquals(1, store.settingsStartingWith("lockout:").size());
    Throttle.sweep(store, NOW + 45 * MIN + week);
    assertEquals(0, store.settingsStartingWith("lockout:").size());
    assertEquals(5, takeAll(lockout, "u1", NOW + 45 * MIN + week));
    assertFalse(lockout.take("u1", NOW + 45 * MIN + week + 14 * MIN));
    assertTrue(lockout.take("u1", NOW + 45 * MIN + week + 15 * MIN), "the first lock again");
  }
}

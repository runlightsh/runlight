package sh.runlight.accounts;

import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import sh.runlight.Js;
import sh.runlight.Json;
import sh.runlight.store.SqlStore;

/**
 * Counts wrong second-factor codes under a key and locks it for longer each time the tries run out:
 * five tries, then fifteen minutes, then thirty, then an hour, doubling up to a day. A right code
 * clears the key, and so does a week with no lock and no try. A lock always ends, at most a day
 * later, so nobody is shut out for good.
 *
 * <p>TypeScript keeps the counts in its process. Here they live in the database's settings, as
 * {@link Throttle}'s do, "lockout:&lt;name&gt;:&lt;id&gt;" holding {count, until, locks, forget},
 * so every process of an install shares them. The id is a hash of the key, which is an account's id
 * and never an address, so nothing here is made from one. A count is written back only if it is
 * still the one read, so a burst of tries at once cannot each read the same count and all get past
 * the limit.
 */
public final class Lockout {
  private static final String PREFIX = "lockout:";

  /** Locks shared by every lockout in the process, a key taking the one its hash picks. */
  private static final ReentrantLock[] STRIPES = new ReentrantLock[64];

  static {
    for (int i = 0; i < STRIPES.length; i++) {
      STRIPES[i] = new ReentrantLock();
    }
  }

  private final SqlStore store;
  private final String name;
  private final long limit;
  private final long windowMs;
  private final long longestMs;
  private final long forgetMs;
  private volatile boolean migrated;

  /** Five tries, a first lock of fifteen minutes, a longest of a day, forgotten after a week. */
  public Lockout(SqlStore store, String name) {
    this(store, name, 5, 15 * 60_000L, 86_400_000L, 7 * 86_400_000L);
  }

  public Lockout(
      SqlStore store, String name, long limit, long windowMs, long longestMs, long forgetMs) {
    this.store = store;
    this.name = name;
    this.limit = limit;
    this.windowMs = windowMs;
    this.longestMs = longestMs;
    this.forgetMs = forgetMs;
  }

  private String settingFor(String key) {
    // The counts live in the settings table, which a request that reached no other route has not
    // made yet.
    if (!migrated) {
      store.migrate();
      migrated = true;
    }
    return PREFIX + name + ":" + Crypto.base64url(Crypto.sha256(key)).substring(0, 22);
  }

  private static long field(Map<String, Object> entry, String key) {
    Object value = entry.get(key);
    return value == null ? 0 : Js.asLong(value);
  }

  /**
   * Counts a try before the code is checked, so a burst cannot get past the limit. False, counting
   * nothing, while the key is locked. The try that uses up the last one starts the lock.
   */
  public boolean take(String key, long now) {
    String setting = settingFor(key);
    ReentrantLock lock = STRIPES[Math.floorMod(setting.hashCode(), STRIPES.length)];
    lock.lock();
    try {
      while (true) {
        String saved = store.setting(setting);
        Map<String, Object> entry = saved == null ? null : Js.map(Json.tryParse(saved).value());
        if (entry != null && field(entry, "forget") <= now) {
          entry = null;
        }
        long count = entry == null ? 0 : field(entry, "count");
        long until = entry == null ? now + windowMs : field(entry, "until");
        long locks = entry == null ? 0 : field(entry, "locks");
        if (entry != null && count >= limit && until > now) {
          return false;
        }
        if (entry != null && until <= now) {
          count = 0;
          until = now + windowMs;
        }
        count++;
        if (count >= limit) {
          // Doubling stops well before it could overflow: the longest lock is reached first.
          long length = locks >= 40 ? longestMs : Math.min(windowMs << locks, longestMs);
          until = now + length;
          locks++;
        }
        String value =
            Json.stringify(
                Json.object(
                    "count", count, "until", until, "locks", locks, "forget", until + forgetMs));
        if (store.swapSetting(setting, saved, value)) {
          return true;
        }
      }
    } finally {
      lock.unlock();
    }
  }

  /** Forgets a key, for a code that turned out right. */
  public void clear(String key) {
    store.setSetting(settingFor(key), null);
  }

  /**
   * For the scheduled check, and the sweeps an app without one runs: deletes every lockout's keys
   * that are long forgotten.
   */
  public static void sweep(SqlStore store, long now) {
    for (Map<String, Object> setting : store.settingsStartingWith(PREFIX)) {
      Map<String, Object> entry = Js.map(Json.tryParse((String) setting.get("value")).value());
      if (entry == null || field(entry, "forget") <= now) {
        store.setSetting((String) setting.get("key"), null);
      }
    }
  }
}

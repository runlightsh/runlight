package sh.runlight.accounts;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import sh.runlight.Hash;
import sh.runlight.Js;
import sh.runlight.Json;
import sh.runlight.store.SqlStore;

/**
 * Counts failed sign-ins under a key and refuses more than a few in a while. Keys are hashed with a
 * key made on first use, so the counts never hold an address or an email as it was given.
 *
 * <p>TypeScript keeps the counts in its process. Here they live in the database's settings, as the
 * PHP port keeps them, "throttle:&lt;name&gt;:&lt;id&gt;" holding {count, until}, and the hashing
 * key as "throttle-key". Every process of an install, in any of the ports, then shares the same
 * counts.
 *
 * <p>Reading a count and writing it back take turns, so a burst of tries at once cannot each read
 * the same count and all get past the limit: within a process through a lock per key, and across
 * processes through the database's lock.
 */
public final class Throttle {
  private static final String KEY = "throttle-key";

  /** Locks shared by every throttle in the process, a key taking the one its hash picks. */
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

  /** Ten tries in fifteen minutes. */
  public Throttle(SqlStore store, String name) {
    this(store, name, 10);
  }

  public Throttle(SqlStore store, String name, long limit) {
    this(store, name, limit, 15 * 60_000L);
  }

  public Throttle(SqlStore store, String name, long limit, long windowMs) {
    this.store = store;
    this.name = name;
    this.limit = limit;
    this.windowMs = windowMs;
  }

  private String salt() {
    String saved = store.setting(KEY);
    if (saved != null && !saved.isEmpty()) {
      return saved;
    }
    // Made once: two processes making their own at once would count the same key apart.
    return store
        .db()
        .exclusive(
            db -> {
              String again = store.setting(KEY);
              if (again != null && !again.isEmpty()) {
                return again;
              }
              String made = Hash.randomId(16);
              store.setSetting(KEY, made);
              return made;
            });
  }

  /** Runs fn while no other try under the same id, in this process or another, reads or counts. */
  private <T> T turn(String id, Supplier<T> fn) {
    ReentrantLock lock = STRIPES[Math.floorMod((name + ":" + id).hashCode(), STRIPES.length)];
    lock.lock();
    try {
      return store.db().exclusive(db -> fn.get());
    } finally {
      lock.unlock();
    }
  }

  private String id(String key) {
    return Crypto.base64url(Crypto.hmac("SHA-256", salt(), key)).substring(0, 22);
  }

  private String prefix() {
    return "throttle:" + name + ":";
  }

  /** The count and end of the window kept for an id, as {count, until}, or null. */
  private long[] entry(String id) {
    String saved = store.setting(prefix() + id);
    Map<String, Object> entry = saved == null ? null : Js.map(Json.tryParse(saved).value());
    return entry == null ? null : new long[] {field(entry, "count"), field(entry, "until")};
  }

  private static long field(Map<String, Object> entry, String key) {
    Object value = entry.get(key);
    return value == null ? 0 : Js.asLong(value);
  }

  private void save(String id, long count, long until) {
    store.setSetting(prefix() + id, Json.stringify(Json.object("count", count, "until", until)));
  }

  public boolean blocked(String key, long now) {
    return isBlocked(id(key), now);
  }

  private boolean isBlocked(String id, long now) {
    long[] entry = entry(id);
    if (entry == null || entry[1] <= now) {
      return false;
    }
    return entry[0] >= limit;
  }

  /**
   * Counts a try before the slow check it guards, so a burst that arrives while earlier tries are
   * still being checked cannot get past the limit. False, counting nothing, when the key is already
   * at its limit. A try that turns out right is taken back with forgive().
   */
  public boolean take(String key, long now) {
    String id = id(key);
    return turn(
        id,
        () -> {
          if (isBlocked(id, now)) {
            return false;
          }
          count(id, now);
          return true;
        });
  }

  /** Takes back one counted try, for one that turned out right. */
  public void forgive(String key) {
    String id = id(key);
    turn(
        id,
        () -> {
          long[] entry = entry(id);
          if (entry != null && entry[0] > 0) {
            save(id, entry[0] - 1, entry[1]);
          }
          return null;
        });
  }

  public void fail(String key, long now) {
    String id = id(key);
    turn(
        id,
        () -> {
          count(id, now);
          return null;
        });
  }

  private void count(String id, long now) {
    long[] entry = entry(id);
    if (entry == null || entry[1] <= now) {
      save(id, 1, now + windowMs);
      prune(now);
      return;
    }
    save(id, entry[0] + 1, entry[1]);
  }

  private record Kept(String key, long until, boolean blocked) {}

  /**
   * Expired entries go first, then the oldest that are not blocked, and blocked ones last, so the
   * counts have a hard ceiling and a flood of made-up names cannot wipe out a real block. Run when
   * a new entry is made, since only then can there be more.
   */
  private void prune(long now) {
    List<Kept> entries = new ArrayList<>();
    for (Map<String, Object> setting : store.settingsStartingWith(prefix())) {
      String key = (String) setting.get("key");
      Map<String, Object> entry = Js.map(Json.tryParse((String) setting.get("value")).value());
      long until = entry == null ? 0 : field(entry, "until");
      if (until <= now) {
        store.setSetting(key, null);
        continue;
      }
      entries.add(new Kept(key, until, field(entry, "count") >= limit));
    }
    int size = entries.size();
    if (size <= Accounts.MAX_THROTTLED) {
      return;
    }
    // Oldest first: each entry's window started windowMs before its end.
    entries.sort(Comparator.comparingLong(Kept::until));
    for (boolean blocked : new boolean[] {false, true}) {
      for (Kept entry : entries) {
        if (size <= Accounts.MAX_THROTTLED) {
          return;
        }
        if (entry.blocked() == blocked) {
          store.setSetting(entry.key(), null);
          size--;
        }
      }
    }
  }

  public void clear(String key) {
    store.setSetting(prefix() + id(key), null);
  }
}

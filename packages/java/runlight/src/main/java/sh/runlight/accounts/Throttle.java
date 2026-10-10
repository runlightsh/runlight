package sh.runlight.accounts;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import java.util.function.UnaryOperator;
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
 * <p>A count is written back only if it is still the one read, so a burst of tries at once cannot
 * each read the same count and all get past the limit, in one process or across several. Tries
 * under the same key in one process take turns first, so they do not keep reading again.
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
  private volatile boolean migrated;

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
    // The counts live in the settings table, which a request that reached no other route has not
    // made yet.
    if (!migrated) {
      store.migrate();
      migrated = true;
    }
    String saved = store.setting(KEY);
    if (saved != null && !saved.isEmpty()) {
      return saved;
    }
    // Made once: of two processes making one at once, the first written is the one both use, or
    // they would count the same key apart.
    String made = Hash.randomId(16);
    return store.swapSetting(KEY, saved, made) ? made : store.setting(KEY);
  }

  /** Runs fn while no other try under the same id in this process reads or counts. */
  private static <T> T turn(String name, String id, Supplier<T> fn) {
    ReentrantLock lock = STRIPES[Math.floorMod((name + ":" + id).hashCode(), STRIPES.length)];
    lock.lock();
    try {
      return fn.get();
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
    return parse(store.setting(prefix() + id));
  }

  private static long[] parse(String saved) {
    Map<String, Object> entry = saved == null ? null : Js.map(Json.tryParse(saved).value());
    return entry == null ? null : new long[] {field(entry, "count"), field(entry, "until")};
  }

  private static long field(Map<String, Object> entry, String key) {
    Object value = entry.get(key);
    return value == null ? 0 : Js.asLong(value);
  }

  /**
   * Rewrites an id's entry as change makes it from the one kept (null leaving it be), and gives
   * back what was written, or null. The write only lands if the entry is still the one read, so a
   * try counted meanwhile, here or in another process, is read again rather than written over.
   */
  private long[] update(String id, UnaryOperator<long[]> change) {
    String key = prefix() + id;
    return turn(
        name,
        id,
        () -> {
          while (true) {
            String saved = store.setting(key);
            long[] next = change.apply(parse(saved));
            if (next == null) {
              return null;
            }
            String value = Json.stringify(Json.object("count", next[0], "until", next[1]));
            if (store.swapSetting(key, saved, value)) {
              return next;
            }
          }
        });
  }

  /** A try counted on an entry: the first of a new window when there is none or it has ended. */
  private long[] counted(long[] entry, long now) {
    return entry == null || entry[1] <= now
        ? new long[] {1, now + windowMs}
        : new long[] {entry[0] + 1, entry[1]};
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
    long[] made =
        update(
            id(key),
            entry ->
                entry != null && entry[1] > now && entry[0] >= limit ? null : counted(entry, now));
    if (made == null) {
      return false;
    }
    if (made[0] == 1) {
      prune(now);
    }
    return true;
  }

  /** Takes back one counted try, for one that turned out right. */
  public void forgive(String key) {
    update(
        id(key),
        entry -> entry != null && entry[0] > 0 ? new long[] {entry[0] - 1, entry[1]} : null);
  }

  public void fail(String key, long now) {
    long[] made = update(id(key), entry -> counted(entry, now));
    if (made[0] == 1) {
      prune(now);
    }
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

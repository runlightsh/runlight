package sh.runlight.accounts;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import sh.runlight.CodedError;
import sh.runlight.Json;
import sh.runlight.store.Databases;
import sh.runlight.store.SqlStore;

/** Accounts and the throttle on their own, on every database at hand. */
class AccountsTest {
  private static final long NOW = 1_791_288_000_000L;
  private static final String SECRET = "k".repeat(64);

  static List<String> kinds() {
    return Databases.kinds();
  }

  @AfterEach
  void tearDown() {
    Databases.cleanup();
  }

  private static SqlStore store(String kind) {
    SqlStore store = Databases.fresh(kind);
    store.migrate();
    return store;
  }

  private static String codeOf(Runnable fn) {
    try {
      fn.run();
      return "";
    } catch (AccountError error) {
      return error.code();
    }
  }

  private static List<Object> column(List<Map<String, Object>> rows, String key) {
    List<Object> out = new ArrayList<>();
    for (Map<String, Object> row : rows) {
      out.add(row.get(key));
    }
    return out;
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void siteAccountsCannotBecomeOwnersOrAdmins(String kind) {
    Accounts accounts = new Accounts(store(kind), SECRET);
    for (String role : List.of("owner", "admin")) {
      assertEquals(
          "role_scope",
          codeOf(
              () ->
                  accounts.setPassword(
                      "scoped@example.com", "a long password", NOW, role, "example.com")));
    }
    assertEquals(0, accounts.count());
    Map<String, Object> member =
        accounts.setPassword("scoped@example.com", "a long password", NOW, "member", "example.com");
    assertEquals("member", member.get("role"));
    assertEquals("example.com", member.get("site"));
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void theFirstAccountOwnsAndTheRestAreAdminsUnlessAsked(String kind) {
    Accounts accounts = new Accounts(store(kind), SECRET);
    assertEquals(0, accounts.count());
    Map<String, Object> owner = accounts.setPassword(" Jon@Example.com ", "a long password", NOW);
    assertEquals(
        List.of("id", "email", "hash", "role", "createdAt", "twoFactor", "recoveryLeft"),
        new ArrayList<>(owner.keySet()));
    assertEquals("jon@example.com", owner.get("email"));
    assertEquals("owner", owner.get("role"));
    assertTrue(((String) owner.get("id")).matches("[a-f0-9]{24}"));
    Map<String, Object> admin =
        accounts.setPassword("ada@example.com", "another long one", NOW + 1, "owner");
    assertEquals("admin", admin.get("role"), "a server has one owner");
    assertEquals(List.of("jon@example.com", "ada@example.com"), column(accounts.list(), "email"));
    assertEquals(Json.stringify(owner), Json.stringify(accounts.byId((String) owner.get("id"))));
    assertEquals(owner.get("id"), accounts.signIn("JON@example.com", "a long password").get("id"));
    assertNull(accounts.signIn("jon@example.com", "a wrong password"));
    assertNull(accounts.signIn("nobody@example.com", "a long password"));

    assertEquals(
        "email_invalid",
        codeOf(() -> accounts.setPassword("not an email", "a long password", NOW)));
    AccountError error =
        assertThrows(AccountError.class, () -> accounts.setPassword("x@example.com", "short", NOW));
    assertEquals("password_short", error.code());
    assertEquals(Map.of("min", "10"), error.params());
    assertEquals("Use a password of at least 10 characters", error.getMessage());
    assertInstanceOf(CodedError.class, error, "a RangeError in TypeScript, with a code");
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void rolesHandingOverAndRemoving(String kind) {
    Accounts accounts = new Accounts(store(kind), SECRET);
    String owner =
        (String) accounts.setPassword("jon@example.com", "a long password", NOW).get("id");
    Map<String, Object> admin = accounts.setPassword("ada@example.com", "a long password", NOW + 1);
    String adminId = (String) admin.get("id");
    assertEquals("owner_protected", codeOf(() -> accounts.setRole(owner, "admin")));
    assertEquals("owner_hand_over", codeOf(() -> accounts.setRole(adminId, "owner")));
    assertEquals("unknown_account", codeOf(() -> accounts.setRole("a".repeat(24), "viewer")));
    Map<String, Object> member = accounts.setRole(adminId, "member");
    assertEquals(
        new ArrayList<>(admin.keySet()),
        new ArrayList<>(member.keySet()),
        "the role changes in place");
    assertEquals("member", member.get("role"));
    assertEquals("owner_needs_admin", codeOf(() -> accounts.handOver(owner, adminId)));
    assertEquals("owner_hand_over", codeOf(() -> accounts.handOver(adminId, owner)));
    accounts.setRole(adminId, "admin");
    accounts.handOver(owner, adminId);
    assertEquals("admin", accounts.byId(owner).get("role"));
    assertEquals("owner", accounts.byId(adminId).get("role"));
    assertEquals("owner_protected", codeOf(() -> accounts.remove(adminId)));
    accounts.remove(owner);
    assertNull(accounts.byId(owner));
    assertEquals("unknown_account", codeOf(() -> accounts.remove(owner)));
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> inviteOf(Map<String, Object> made) {
    return (Map<String, Object>) made.get("invite");
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void invitesWorkOnceAndTheNewestLinkWins(String kind) {
    Accounts accounts = new Accounts(store(kind), SECRET);
    accounts.setPassword("jon@example.com", "a long password", NOW);
    Map<String, Object> made = accounts.invite(" Mo@Example.com", "member", "jon@example.com", NOW);
    Map<String, Object> first = inviteOf(made);
    String old = (String) made.get("code");
    assertEquals(
        List.of("id", "email", "role", "invitedBy", "createdAt", "expiresAt"),
        new ArrayList<>(first.keySet()));
    assertEquals("mo@example.com", first.get("email"));
    assertEquals(NOW + Accounts.INVITE_MS, first.get("expiresAt"));
    assertTrue(old.matches("[A-Za-z0-9_-]{32}"), old);
    Map<String, Object> again =
        accounts.invite("mo@example.com", "viewer", "jon@example.com", NOW + 5);
    Map<String, Object> second = inviteOf(again);
    String code = (String) again.get("code");
    assertNull(accounts.inviteByCode(old, NOW + 10), "asking again replaces the earlier invite");
    assertEquals(second, accounts.inviteByCode(code, NOW + 10));
    assertEquals(List.of(second), accounts.invites(NOW + 10));
    assertNull(accounts.inviteByCode("short", NOW));
    assertNull(accounts.inviteByCode(code, NOW + 5 + Accounts.INVITE_MS), "an invite runs out");
    AccountError error =
        assertThrows(
            AccountError.class,
            () -> accounts.invite("jon@example.com", "admin", "jon@example.com", NOW),
            "someone with an account is not invited");
    assertEquals("account_exists", error.code());
    assertEquals(Map.of("email", "jon@example.com"), error.params());
    Map<String, Object> user = accounts.acceptInvite(code, "another long one", NOW + 20);
    assertEquals("viewer", user.get("role"));
    assertEquals(List.of(), accounts.invites(NOW + 20));
    assertEquals(
        "invite_gone",
        codeOf(() -> accounts.acceptInvite(code, "another long one", NOW + 30)),
        "an invite works once");
    Map<String, Object> third =
        inviteOf(accounts.invite("zed@example.com", "admin", "jon@example.com", NOW));
    assertTrue(accounts.cancelInvite((String) third.get("id")));
    assertFalse(accounts.cancelInvite((String) third.get("id")));
    accounts.invite("old@example.com", "admin", "jon@example.com", NOW);
    assertEquals(
        List.of(),
        accounts.invites(NOW + Accounts.INVITE_MS),
        "expired invites are cleared on the way");
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void sessionsTicketsAndDevicesAreSignedAndEndWithTheirPassword(String kind) {
    Accounts accounts = new Accounts(store(kind), SECRET);
    Map<String, Object> user = accounts.setPassword("jon@example.com", "a long password", NOW);
    String session = accounts.sessionFor(user, NOW);
    String[] parts = session.split("\\.");
    String id = parts[0];
    String expires = parts[1];
    String signature = parts[2];
    assertEquals(user.get("id"), id);
    assertEquals(Long.toString(NOW + Accounts.SESSION_MS), expires);
    assertEquals(
        Crypto.signature(SECRET, id + "." + expires, (String) user.get("hash")),
        signature,
        "signed as TypeScript signs it");
    assertEquals(user, accounts.fromSession(session, NOW + 1));
    assertNull(accounts.fromSession(session, NOW + Accounts.SESSION_MS), "a session runs out");
    assertNull(accounts.fromSession(id + "." + expires + ".x", NOW));
    assertNull(accounts.fromSession("", NOW));
    assertNull(accounts.fromSession(id + ".later." + signature, NOW));

    String pending = accounts.pendingFor(user, NOW);
    assertEquals(user, accounts.fromPending(pending, NOW));
    assertNull(accounts.fromPending(session, NOW), "a session is not a code-step ticket");
    assertNull(accounts.fromPending(pending, NOW + 5 * 60_000));

    String device = accounts.deviceFor(user);
    assertTrue(accounts.trustsDevice(device, user));
    assertFalse(accounts.trustsDevice("", user));

    String link = accounts.linkFor(user, NOW);
    String earlier = accounts.linkFor(user, NOW - 1000);
    assertEquals(user, accounts.fromLink(link, NOW + 1));
    assertNull(accounts.fromLink(link, NOW + 2), "a link works once");
    assertNull(accounts.fromLink(earlier, NOW + 2), "and withdraws every link sent before it");

    Map<String, Object> changed =
        accounts.setPassword("jon@example.com", "a new long password", NOW);
    assertNull(
        accounts.fromSession(session, NOW + 1), "a new password signs out every other browser");
    assertFalse(accounts.trustsDevice(device, changed));
    assertNotNull(accounts.fromSession(accounts.sessionFor(changed, NOW), NOW + 1));
  }

  /** How many of these checks were accepted, all started together, each on its own thread. */
  private static int accepted(List<java.util.concurrent.Callable<Boolean>> checks)
      throws Exception {
    ExecutorService pool = Executors.newFixedThreadPool(checks.size());
    try {
      CountDownLatch go = new CountDownLatch(1);
      List<Future<Boolean>> answers = new ArrayList<>();
      for (java.util.concurrent.Callable<Boolean> check : checks) {
        answers.add(
            pool.submit(
                () -> {
                  go.await();
                  return check.call();
                }));
      }
      go.countDown();
      int count = 0;
      for (Future<Boolean> answer : answers) {
        if (answer.get()) {
          count++;
        }
      }
      return count;
    } finally {
      pool.shutdown();
    }
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void aCodeIsAcceptedOnceEvenByTwoProcessesCheckingItAtTheSameMoment(String kind)
      throws Exception {
    SqlStore store = store(kind);
    Accounts one = new Accounts(store, SECRET);
    // Another process on the same database: its own Accounts, with nothing shared in memory.
    Accounts other = new Accounts(store, SECRET);
    Map<String, Object> user = one.setPassword("owner@example.com", "a long password", NOW);
    String id = (String) user.get("id");
    String secret = one.startTwoFactor(id);
    List<String> recovery = one.confirmTwoFactor(id, Crypto.totp(secret, NOW / 30_000), NOW);

    long later = NOW + 60_000;
    String old = Crypto.totp(secret, later / 30_000);
    for (int round = 0; round < 5; round++) {
      long at = later + round * 30_000L;
      String fresh = Crypto.totp(secret, at / 30_000);
      assertEquals(
          1,
          accepted(
              List.of(
                  () -> one.checkSecondFactor(id, fresh, at),
                  () -> other.checkSecondFactor(id, fresh, at))),
          "round " + round + ": one of the two is accepted");
    }
    assertFalse(one.checkSecondFactor(id, old, later), "an older code stays refused");

    for (String used : recovery.subList(0, 3)) {
      assertEquals(
          1,
          accepted(
              List.of(
                  () -> one.checkSecondFactor(id, used, later),
                  () -> other.checkSecondFactor(id, used, later))),
          "a recovery code is crossed off once");
    }
    // Two different recovery codes at once: neither write loses the other's, though one may be
    // asked again.
    int pair =
        accepted(
            List.of(
                () -> one.checkSecondFactor(id, recovery.get(3), later),
                () -> other.checkSecondFactor(id, recovery.get(4), later)));
    assertEquals(7L - pair, one.byId(id).get("recoveryLeft"), "every code accepted is crossed off");
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void twoFactorCodesWorkOnceAndRecoveryCodesAreCrossedOff(String kind) {
    Accounts accounts = new Accounts(store(kind), SECRET);
    Map<String, Object> user = accounts.setPassword("jon@example.com", "a long password", NOW);
    String id = (String) user.get("id");
    String secret = accounts.startTwoFactor(id);
    assertTrue(secret.matches("[A-Z2-7]{32}"), secret);
    long step = NOW / 30_000;
    String wrong = Crypto.totp(secret, step).equals("000000") ? "111111" : "000000";
    assertNull(accounts.confirmTwoFactor(id, wrong, NOW));
    List<String> recovery = accounts.confirmTwoFactor(id, Crypto.totp(secret, step), NOW);
    assertEquals(10, recovery.size());
    assertTrue(recovery.get(0).matches("[a-z2-7]{4}-[a-z2-7]{4}"));
    Map<String, Object> on = accounts.byId(id);
    assertEquals(true, on.get("twoFactor"));
    assertEquals(10L, on.get("recoveryLeft"));
    assertNull(
        accounts.fromSession(accounts.sessionFor(user, NOW), NOW),
        "turning two-factor on ends other sessions");

    // The code that turned it on still signs in, once.
    assertTrue(accounts.checkSecondFactor(id, " " + Crypto.totp(secret, step) + " ", NOW));
    assertFalse(
        accounts.checkSecondFactor(id, Crypto.totp(secret, step), NOW), "a code works once");
    assertFalse(
        accounts.checkSecondFactor(id, Crypto.totp(secret, step - 1), NOW),
        "and an older one never");
    assertTrue(
        accounts.checkSecondFactor(id, Crypto.totp(secret, step + 1), NOW),
        "one step ahead, for a clock that drifts");
    assertTrue(accounts.checkSecondFactor(id, recovery.get(3).replace("-", "").toUpperCase(), NOW));
    assertFalse(
        accounts.checkSecondFactor(id, recovery.get(3), NOW), "a recovery code is crossed off");
    assertEquals(9L, accounts.byId(id).get("recoveryLeft"));
    List<String> fresh = accounts.newRecoveryCodes(id);
    assertFalse(accounts.checkSecondFactor(id, recovery.get(0), NOW));
    assertTrue(accounts.checkSecondFactor(id, fresh.get(0), NOW));
    accounts.disableTwoFactor(id);
    assertEquals(false, accounts.byId(id).get("twoFactor"));
    assertFalse(accounts.checkSecondFactor(id, fresh.get(1), NOW));

    accounts.startTwoFactor(id);
    accounts.cancelTwoFactorSetup(id);
    assertNull(
        accounts.confirmTwoFactor(id, Crypto.totp(secret, step), NOW),
        "a cancelled set-up confirms nothing");
  }

  @Test
  void anOldTableGainsRolesAndKeepsOneOwner() {
    SqlStore store = store("sqlite");
    store
        .db()
        .run(
            "CREATE TABLE rl_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, created_at BIGINT NOT NULL)");
    store
        .db()
        .run(
            "INSERT INTO rl_users VALUES ('b', 'b@example.com', 'x', 2), ('a', 'a@example.com', 'x', 1)");
    Accounts accounts = new Accounts(store, SECRET);
    List<List<Object>> roles = new ArrayList<>();
    for (Map<String, Object> u : accounts.list()) {
      roles.add(List.of(u.get("id"), u.get("role")));
    }
    assertEquals(List.of(List.of("a", "owner"), List.of("b", "admin")), roles);
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void signingInHashesAPasswordMadeAtTheOldCostAgainAndAWrongPasswordChangesNothing(String kind) {
    SqlStore store = store(kind);
    Accounts accounts = new Accounts(store, SECRET);
    Map<String, Object> user = accounts.setPassword("owner@example.com", "a long password", NOW);
    String id = (String) user.get("id");
    // Node's scrypt("a long password", "0123456789abcdef", 32) at N=16384, r=8, p=1.
    String old = "scrypt$MDEyMzQ1Njc4OWFiY2RlZg$4e4Ay7yg4Ogm37fyCe7QqI544HrAnZQaPJJBcP8RNmQ";
    store.db().run("UPDATE rl_users SET hash = ? WHERE id = ?", List.of(old, id));
    assertNull(accounts.signIn("owner@example.com", "a wrong password"));
    assertEquals(old, accounts.byId(id).get("hash"));
    Map<String, Object> signedIn = accounts.signIn("owner@example.com", "a long password");
    assertNotNull(signedIn);
    assertTrue(
        ((String) signedIn.get("hash")).startsWith("scrypt$32768$8$3$"),
        "made again at the new cost");
    assertEquals(signedIn.get("hash"), accounts.byId(id).get("hash"));
    assertNotNull(accounts.signIn("owner@example.com", "a long password"), "and it still signs in");
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void deletingASiteRemovesTheAccountsAndInvitationsKeptToItAndNoOneElse(String kind) {
    Accounts accounts = new Accounts(store(kind), SECRET);
    accounts.setPassword("owner@example.com", "a long password", NOW);
    accounts.setPassword("alpha@example.com", "a long password", NOW, "viewer", "alpha");
    accounts.setPassword("beta@example.com", "a long password", NOW, "member", "beta");
    accounts.invite("invited@example.com", "member", "owner@example.com", NOW, "alpha");
    accounts.invite("other@example.com", "member", "owner@example.com", NOW, "beta");
    accounts.forgetSite("alpha");
    List<Object> emails = column(accounts.list(), "email");
    Collections.sort(emails, (a, b) -> ((String) a).compareTo((String) b));
    assertEquals(List.of("beta@example.com", "owner@example.com"), emails);
    assertEquals(List.of("other@example.com"), column(accounts.invites(NOW), "email"));
  }

  @Test
  void aCountMadeBeforeMidnightUtcCarriesOnUntilItsWindowEnds() {
    SqlStore store = store("sqlite");
    long day = 86_400_000L;
    // Ten minutes before the next UTC day, in a window of fifteen.
    long late = NOW + day / 2 - 10 * 60_000L;
    Throttle throttle = new Throttle(store, "test", 3, 15 * 60_000L);
    throttle.fail("jon@example.com", late);
    throttle.fail("jon@example.com", late);
    throttle.fail("jon@example.com", late);
    long after = late + 12 * 60_000L;
    assertTrue(throttle.blocked("jon@example.com", after), "midnight does not lift a block");
    assertFalse(throttle.take("jon@example.com", after));
    throttle.forgive("jon@example.com", after);
    assertFalse(throttle.blocked("jon@example.com", after));
    assertTrue(throttle.take("jon@example.com", after), "and carries on counting under its own id");
    assertTrue(throttle.blocked("jon@example.com", after));
    throttle.clear("jon@example.com", after);
    assertFalse(throttle.blocked("jon@example.com", after));
    assertEquals(List.of(), keys(store, "throttle:test:"));
    assertFalse(throttle.blocked("jon@example.com", late + 20 * 60_000L));
  }

  @Test
  void aThrottleLooksOverItsEntriesOnlyWhenTheCeilingMayHaveBeenPassed() {
    SqlStore store = store("sqlite");
    Throttle throttle = new Throttle(store, "flood", 3, 60_000L);
    // Entries made by something else, expired, which a pruning pass would clear.
    store.migrate();
    store.setSetting("throttle:flood:stale", Json.stringify(Json.object("count", 1, "until", 1)));
    throttle.fail("a@example.com", NOW);
    assertEquals(1, keys(store, "throttle:flood:").size(), "the first new entry counts them");
    store.setSetting("throttle:flood:stale", Json.stringify(Json.object("count", 1, "until", 1)));
    throttle.fail("b@example.com", NOW + 1000);
    assertEquals(
        3, keys(store, "throttle:flood:").size(), "a new key within the window looks at nothing");
    throttle.fail("c@example.com", NOW + 61_000L);
    assertFalse(keys(store, "throttle:flood:").contains("throttle:flood:stale"), "once a window");
  }

  @Test
  void aFloodOfMadeUpNamesCannotResetTheCountOfOneCloseToItsLimit() {
    // The audit of 2026-10-23.
    SqlStore store = store("sqlite");
    Throttle throttle = new Throttle(store, "flood", 3);
    assertTrue(throttle.take("target", NOW));
    assertTrue(throttle.take("target", NOW));
    for (int i = 0; i < Accounts.MAX_THROTTLED + 50; i++) {
      throttle.take("made-up-" + i, NOW);
    }
    assertTrue(throttle.take("target", NOW));
    assertFalse(throttle.take("target", NOW), "the target's earlier tries still count");
    assertTrue(
        keys(store, "throttle:flood:").size() <= Accounts.MAX_THROTTLED, "the ceiling still holds");
  }

  @Test
  void theThrottleCountsBeforeTheCheckAndForgivesARightTry() {
    SqlStore store = store("sqlite");
    Throttle throttle = new Throttle(store, "test", 3, 1000);
    for (int i = 0; i < 3; i++) {
      assertTrue(throttle.take("jon@example.com", NOW));
    }
    assertTrue(throttle.blocked("jon@example.com", NOW));
    assertFalse(throttle.take("jon@example.com", NOW), "at its limit, nothing more is counted");
    assertFalse(throttle.blocked("ada@example.com", NOW));
    throttle.forgive("jon@example.com", NOW);
    assertFalse(throttle.blocked("jon@example.com", NOW));
    throttle.fail("jon@example.com", NOW);
    assertTrue(throttle.blocked("jon@example.com", NOW));
    assertFalse(throttle.blocked("jon@example.com", NOW + 1000), "a window ends");
    throttle.clear("jon@example.com", NOW);
    assertFalse(throttle.blocked("jon@example.com", NOW));
    for (Map<String, Object> setting : store.settingsStartingWith("throttle:")) {
      assertFalse(
          ((String) setting.get("key")).contains("jon"), "keys are hashed, never kept as given");
    }
    assertFalse(
        new Throttle(store, "other", 3, 1000).blocked("jon@example.com", NOW),
        "each throttle counts on its own");
    // Another request, with a throttle of its own, sees the same counts.
    throttle.fail("ada@example.com", NOW);
    throttle.fail("ada@example.com", NOW);
    throttle.fail("ada@example.com", NOW);
    assertTrue(new Throttle(store, "test", 3, 1000).blocked("ada@example.com", NOW));
    // A new entry clears expired ones.
    throttle.fail("zed@example.com", NOW + 2000);
    assertEquals(1, store.settingsStartingWith("throttle:test:").size());
    // Reading one whose window has ended clears it too.
    assertFalse(throttle.blocked("zed@example.com", NOW + 4000));
    assertEquals(0, store.settingsStartingWith("throttle:test:").size());
  }

  @Test
  void throttleIdsMadeFromAnAddressCannotBeTracedBackAfterADay() {
    SqlStore store = store("sqlite");
    long day = 86_400_000L;
    // An install from before keys rotated kept one key for good; it goes with the first new one.
    store.setSetting("throttle-key", "old");
    Throttle ips = new Throttle(store, "ip", 30);
    assertTrue(ips.take("203.0.113.7", NOW));
    String today = "throttle-key:2026-10-06";
    assertEquals(List.of(today), keys(store, "throttle-key"));
    String idToday = keys(store, "throttle:ip:").get(0);

    // The next day hashes with a new key, so the same address gets an id unlike yesterday's.
    assertTrue(ips.take("203.0.113.7", NOW + day));
    assertEquals(
        List.of(today, "throttle-key:2026-10-07"),
        keys(store, "throttle-key"),
        "yesterday's stays");
    assertFalse(keys(store, "throttle:ip:").contains(idToday), "yesterday's count has gone");

    // Two days on, the first key is gone, and the scheduled sweep clears every ended count.
    assertTrue(ips.take("203.0.113.7", NOW + 2 * day));
    assertFalse(keys(store, "throttle-key").contains(today));
    new Throttle(store, "address", 10).take("jon@example.com\n203.0.113.7", NOW + 2 * day);
    Throttle.sweep(store, NOW + 3 * day);
    assertEquals(List.of(), keys(store, "throttle:"));
    assertEquals(List.of("throttle-key:2026-10-08"), keys(store, "throttle-key"));
  }

  private static List<String> keys(SqlStore store, String prefix) {
    List<String> out = new ArrayList<>();
    for (Map<String, Object> setting : store.settingsStartingWith(prefix)) {
      out.add((String) setting.get("key"));
    }
    Collections.sort(out);
    return out;
  }

  @ParameterizedTest
  @MethodSource("kinds")
  void aBurstOfTriesAtOnceGetsNoMoreThanTheLimit(String kind) throws Exception {
    SqlStore store = store(kind);
    int tries = 40;
    CountDownLatch start = new CountDownLatch(1);
    AtomicInteger let = new AtomicInteger();
    List<Future<?>> done = new ArrayList<>();
    try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
      for (int i = 0; i < tries; i++) {
        // Each request makes its own throttle, as the server's handlers share only the store.
        Throttle throttle = new Throttle(store, "burst", 5, 60_000);
        done.add(
            pool.submit(
                () -> {
                  start.await();
                  if (throttle.take("jon@example.com", NOW)) {
                    let.incrementAndGet();
                  }
                  return null;
                }));
      }
      start.countDown();
      for (Future<?> one : done) {
        one.get();
      }
    }
    assertEquals(5, let.get());
    assertTrue(new Throttle(store, "burst", 5, 60_000).blocked("jon@example.com", NOW));
  }

  @Test
  void onlyAFewPasswordChecksRunAtOnceAndPastTheQueueTheRestAreTurnedAway() throws Exception {
    CountDownLatch running = new CountDownLatch(4);
    CountDownLatch release = new CountDownLatch(1);
    AtomicInteger ran = new AtomicInteger();
    List<Future<?>> done = new ArrayList<>();
    try (ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor()) {
      for (int i = 0; i < 4 + 64; i++) {
        done.add(
            pool.submit(
                () ->
                    Accounts.slot(
                        () -> {
                          running.countDown();
                          try {
                            release.await();
                          } catch (InterruptedException e) {
                            Thread.currentThread().interrupt();
                          }
                          return ran.incrementAndGet();
                        })));
      }
      running.await();
      long deadline = System.nanoTime() + 10_000_000_000L;
      while (Accounts.waitingChecks() < 64 && System.nanoTime() < deadline) {
        Thread.onSpinWait();
      }
      assertEquals(64, Accounts.waitingChecks());
      AccountError busy = assertThrows(AccountError.class, () -> Accounts.slot(() -> true));
      assertEquals("busy", busy.code());
      release.countDown();
      for (Future<?> one : done) {
        one.get();
      }
    }
    assertEquals(68, ran.get(), "everyone in the queue got their turn");
    assertEquals(0, Accounts.waitingChecks());
    assertTrue(Accounts.slot(() -> true), "and a check runs again once they have");
  }
}

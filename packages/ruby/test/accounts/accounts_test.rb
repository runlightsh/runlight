# frozen_string_literal: true

require "test_helper"

# Accounts and the throttle on their own, on every database at hand.
class AccountsAccountsTest < Minitest::Test
  Accounts = Runlight::Accounts::Accounts
  AccountError = Runlight::Accounts::AccountError
  Crypto = Runlight::Accounts::Crypto
  Throttle = Runlight::Accounts::Throttle

  NOW = 1_791_288_000_000
  SECRET = "k" * 64

  def store(kind)
    store = Databases.fresh(kind)
    store.migrate
    store
  end

  def code_of
    yield
    ""
  rescue AccountError => e
    e.code
  end

  def each_kind(&block)
    Databases.kinds.each do |kind|
      block.call(kind)
    rescue Minitest::Assertion => e
      raise e.class, "#{kind}: #{e.message}"
    end
  end

  def test_the_first_account_owns_and_the_rest_are_admins_unless_asked
    each_kind do |kind|
      accounts = Accounts.new(store(kind), SECRET)
      assert_equal 0, accounts.count
      owner = accounts.set_password(" Jon@Example.com ", "a long password", NOW)
      assert_equal %w[id email hash role createdAt twoFactor recoveryLeft], owner.keys
      assert_equal "jon@example.com", owner["email"]
      assert_equal "owner", owner["role"]
      assert_match(/\A[a-f0-9]{24}\z/, owner["id"])
      admin = accounts.set_password("ada@example.com", "another long one", NOW + 1, "owner")
      assert_equal "admin", admin["role"], "a server has one owner"
      assert_equal ["jon@example.com", "ada@example.com"], accounts.list.map { |u| u["email"] }
      assert_equal owner, accounts.by_id(owner["id"])
      assert_equal owner["id"], accounts.sign_in("JON@example.com", "a long password")["id"]
      assert_nil accounts.sign_in("jon@example.com", "a wrong password")
      assert_nil accounts.sign_in("nobody@example.com", "a long password")

      assert_equal "email_invalid", code_of { accounts.set_password("not an email", "a long password", NOW) }
      error = assert_raises(AccountError) { accounts.set_password("x@example.com", "short", NOW) }
      assert_equal "password_short", error.code
      assert_equal({ "min" => "10" }, error.params)
      assert_equal "Use a password of at least 10 characters", error.message
      assert_kind_of RangeError, error, "a RangeError in TypeScript"
    end
  end

  def test_roles_handing_over_and_removing
    each_kind do |kind|
      accounts = Accounts.new(store(kind), SECRET)
      owner = accounts.set_password("jon@example.com", "a long password", NOW)
      admin = accounts.set_password("ada@example.com", "a long password", NOW + 1)
      assert_equal "owner_protected", code_of { accounts.set_role(owner["id"], "admin") }
      assert_equal "owner_hand_over", code_of { accounts.set_role(admin["id"], "owner") }
      assert_equal "unknown_account", code_of { accounts.set_role("a" * 24, "viewer") }
      member = accounts.set_role(admin["id"], "member")
      assert_equal admin.keys, member.keys, "the role changes in place"
      assert_equal "member", member["role"]
      assert_equal "owner_needs_admin", code_of { accounts.hand_over(owner["id"], admin["id"]) }
      assert_equal "owner_hand_over", code_of { accounts.hand_over(admin["id"], owner["id"]) }
      accounts.set_role(admin["id"], "admin")
      accounts.hand_over(owner["id"], admin["id"])
      assert_equal "admin", accounts.by_id(owner["id"])["role"]
      assert_equal "owner", accounts.by_id(admin["id"])["role"]
      assert_equal "owner_protected", code_of { accounts.remove(admin["id"]) }
      accounts.remove(owner["id"])
      assert_nil accounts.by_id(owner["id"])
      assert_equal "unknown_account", code_of { accounts.remove(owner["id"]) }
    end
  end

  def test_invites_work_once_and_the_newest_link_wins
    each_kind do |kind|
      accounts = Accounts.new(store(kind), SECRET)
      accounts.set_password("jon@example.com", "a long password", NOW)
      made = accounts.invite(" Mo@Example.com", "member", "jon@example.com", NOW)
      first = made["invite"]
      old = made["code"]
      assert_equal %w[id email role invitedBy createdAt expiresAt], first.keys
      assert_equal "mo@example.com", first["email"]
      assert_equal NOW + Accounts::INVITE_MS, first["expiresAt"]
      assert_match(/\A[A-Za-z0-9_-]{32}\z/, old)
      made = accounts.invite("mo@example.com", "viewer", "jon@example.com", NOW + 5)
      second = made["invite"]
      code = made["code"]
      assert_nil accounts.invite_by_code(old, NOW + 10), "asking again replaces the earlier invite"
      assert_equal second, accounts.invite_by_code(code, NOW + 10)
      assert_equal [second], accounts.invites(NOW + 10)
      assert_nil accounts.invite_by_code("short", NOW)
      assert_nil accounts.invite_by_code(code, NOW + 5 + Accounts::INVITE_MS), "an invite runs out"
      error = assert_raises(AccountError, "someone with an account is not invited") { accounts.invite("jon@example.com", "admin", "jon@example.com", NOW) }
      assert_equal "account_exists", error.code
      assert_equal({ "email" => "jon@example.com" }, error.params)
      user = accounts.accept_invite(code, "another long one", NOW + 20)
      assert_equal "viewer", user["role"]
      assert_equal [], accounts.invites(NOW + 20)
      assert_equal "invite_gone", code_of { accounts.accept_invite(code, "another long one", NOW + 30) }, "an invite works once"
      third = accounts.invite("zed@example.com", "admin", "jon@example.com", NOW)["invite"]
      assert accounts.cancel_invite(third["id"])
      refute accounts.cancel_invite(third["id"])
      accounts.invite("old@example.com", "admin", "jon@example.com", NOW)
      assert_equal [], accounts.invites(NOW + Accounts::INVITE_MS), "expired invites are cleared on the way"
    end
  end

  def test_sessions_tickets_and_devices_are_signed_and_end_with_their_password
    each_kind do |kind|
      accounts = Accounts.new(store(kind), SECRET)
      user = accounts.set_password("jon@example.com", "a long password", NOW)
      session = accounts.session_for(user, NOW)
      id, expires, signature = session.split(".")
      assert_equal user["id"], id
      assert_equal (NOW + Accounts::SESSION_MS).to_s, expires
      assert_equal Crypto.signature(SECRET, "#{id}.#{expires}", user["hash"]), signature, "signed as TypeScript signs it"
      assert_equal user, accounts.from_session(session, NOW + 1)
      assert_nil accounts.from_session(session, NOW + Accounts::SESSION_MS), "a session runs out"
      assert_nil accounts.from_session("#{id}.#{expires}.x", NOW)
      assert_nil accounts.from_session("", NOW)
      assert_nil accounts.from_session("#{id}.later.#{signature}", NOW)

      pending = accounts.pending_for(user, NOW)
      assert_equal({ "user" => user, "real" => true }, accounts.from_pending(pending, NOW))
      assert_equal({ "user" => user, "real" => false }, accounts.from_pending(accounts.decoy_for(user, NOW), NOW))
      assert_nil accounts.from_pending(session, NOW), "a session is not a code-step ticket"
      assert_nil accounts.from_pending(pending, NOW + (5 * 60_000))

      device = accounts.device_for(user)
      assert accounts.trusts_device(device, user)
      refute accounts.trusts_device("", user)

      link = accounts.link_for(user, NOW)
      earlier = accounts.link_for(user, NOW - 1000)
      assert_equal user, accounts.from_link(link, NOW + 1)
      assert_nil accounts.from_link(link, NOW + 2), "a link works once"
      assert_nil accounts.from_link(earlier, NOW + 2), "and withdraws every link sent before it"

      changed = accounts.set_password("jon@example.com", "a new long password", NOW)
      assert_nil accounts.from_session(session, NOW + 1), "a new password signs out every other browser"
      refute accounts.trusts_device(device, changed)
      refute_nil accounts.from_session(accounts.session_for(changed, NOW), NOW + 1)
    end
  end

  def test_two_factor_codes_work_once_and_recovery_codes_are_crossed_off
    each_kind do |kind|
      accounts = Accounts.new(store(kind), SECRET)
      user = accounts.set_password("jon@example.com", "a long password", NOW)
      secret = accounts.start_two_factor(user["id"])
      assert_match(/\A[A-Z2-7]{32}\z/, secret)
      step = NOW / 30_000
      wrong = Crypto.totp(secret, step) == "000000" ? "111111" : "000000"
      assert_nil accounts.confirm_two_factor(user["id"], wrong, NOW)
      recovery = accounts.confirm_two_factor(user["id"], Crypto.totp(secret, step), NOW)
      assert_equal 10, recovery.length
      assert_match(/\A[a-z2-7]{4}-[a-z2-7]{4}\z/, recovery[0])
      on = accounts.by_id(user["id"])
      assert on["twoFactor"]
      assert_equal 10, on["recoveryLeft"]
      assert_nil accounts.from_session(accounts.session_for(user, NOW), NOW), "turning two-factor on ends other sessions"

      # The code that turned it on still signs in, once.
      assert accounts.check_second_factor(user["id"], " #{Crypto.totp(secret, step)} ", NOW)
      refute accounts.check_second_factor(user["id"], Crypto.totp(secret, step), NOW), "a code works once"
      refute accounts.check_second_factor(user["id"], Crypto.totp(secret, step - 1), NOW), "and an older one never"
      assert accounts.check_second_factor(user["id"], Crypto.totp(secret, step + 1), NOW), "one step ahead, for a clock that drifts"
      assert accounts.check_second_factor(user["id"], recovery[3].delete("-").upcase, NOW)
      refute accounts.check_second_factor(user["id"], recovery[3], NOW), "a recovery code is crossed off"
      assert_equal 9, accounts.by_id(user["id"])["recoveryLeft"]
      fresh = accounts.new_recovery_codes(user["id"])
      refute accounts.check_second_factor(user["id"], recovery[0], NOW)
      assert accounts.check_second_factor(user["id"], fresh[0], NOW)
      accounts.disable_two_factor(user["id"])
      refute accounts.by_id(user["id"])["twoFactor"]
      refute accounts.check_second_factor(user["id"], fresh[1], NOW)

      accounts.start_two_factor(user["id"])
      accounts.cancel_two_factor_setup(user["id"])
      assert_nil accounts.confirm_two_factor(user["id"], Crypto.totp(secret, step), NOW), "a cancelled set-up confirms nothing"
    end
  end

  def test_an_old_table_gains_roles_and_keeps_one_owner
    store = store("sqlite")
    store.db.run("CREATE TABLE rl_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, hash TEXT NOT NULL, created_at BIGINT NOT NULL)")
    store.db.run("INSERT INTO rl_users VALUES ('b', 'b@example.com', 'x', 2), ('a', 'a@example.com', 'x', 1)")
    accounts = Accounts.new(store, SECRET)
    assert_equal [%w[a owner], %w[b admin]], accounts.list.map { |u| [u["id"], u["role"]] }
  end

  # A store on a SQLite file in a folder of its own, which several connections (and processes) can share.
  def sqlite_file
    Dir.mktmpdir("runlight-turns-") do |dir|
      path = File.join(dir, "turns.sqlite3")
      Runlight::Stores.sqlite(path).migrate(true)
      yield path
    end
  end

  # Runs the block in several processes at once, each with a store of its own on the file, and gives back
  # what each returned. A process that raised sends its error back, so the test fails with it.
  def in_processes(path, count)
    readers = count.times.map do
      reader, writer = IO.pipe
      fork do
        reader.close
        answer = begin
          [:ok, yield(Runlight::Stores.sqlite(path))]
        rescue Exception => e
          [:error, "#{e.class}: #{e.message}\n#{e.backtrace&.first(5)&.join("\n")}"]
        end
        writer.write(Marshal.dump(answer))
        writer.close
        exit!(0)
      end
      writer.close
      reader
    end
    answers = readers.map { |r| r.read.then { |data| data.empty? ? [:error, "the process sent nothing back"] : Marshal.load(data) } }
    Process.waitall
    answers.map { |kind, value| kind == :ok ? value : flunk("A process failed: #{value}") }
  end

  def test_a_sign_in_link_opened_at_once_from_several_processes_lets_one_in
    skip "no fork here" unless Process.respond_to?(:fork)

    sqlite_file do |path|
      user = Accounts.new(Runlight::Stores.sqlite(path), SECRET).set_password("jon@example.com", "a long password", NOW)
      link = Accounts.new(Runlight::Stores.sqlite(path), SECRET).link_for(user, NOW)
      results = in_processes(path, 8) do |store|
        accounts = Accounts.new(store, SECRET)
        accounts.count
        sleep 0.2 # every process ready before any opens the link
        Array.new(5) { accounts.from_link(link, NOW + 1) ? 1 : 0 }.sum
      end
      assert_equal 1, results.sum
    end
  end

  def test_the_tables_are_made_once_however_many_threads_ask_at_once
    store = store("sqlite")
    accounts = Accounts.new(store, SECRET)
    made = Queue.new
    db = store.db
    db.define_singleton_method(:exclusive) do |&block|
      made << 1
      sleep 0.05
      super(&block)
    end
    Array.new(6) { Thread.new { accounts.count } }.each(&:join)
    assert_equal 1, made.size
  end

  def test_the_throttle_lets_no_more_tries_through_at_once_than_its_limit
    skip "no fork here" unless Process.respond_to?(:fork)

    sqlite_file do |path|
      Throttle.new(Runlight::Stores.sqlite(path), "code", 5).blocked("acct", NOW) # the hashing key, made once
      results = in_processes(path, 4) do |store|
        throttle = Throttle.new(store, "code", 5)
        sleep 0.2
        passed = Queue.new
        Array.new(3) { Thread.new { 5.times { passed << 1 if throttle.take("acct", NOW) } } }.each(&:join)
        passed.size
      end
      assert_equal 5, results.sum
    end
    each_kind do |kind|
      next if kind == "sqlite"

      store = store(kind)
      passed = Queue.new
      Array.new(4) { Thread.new { throttle = Throttle.new(store, "code", 5); 5.times { passed << 1 if throttle.take("acct", NOW) } } }.each(&:join)
      assert_equal 5, passed.size
    ensure
      Databases.cleanup
    end
  end

  def test_the_throttle_counts_before_the_check_and_forgives_a_right_try
    store = store("sqlite")
    throttle = Throttle.new(store, "test", 3, 1000)
    3.times { assert throttle.take("jon@example.com", NOW) }
    assert throttle.blocked("jon@example.com", NOW)
    refute throttle.take("jon@example.com", NOW), "at its limit, nothing more is counted"
    refute throttle.blocked("ada@example.com", NOW)
    throttle.forgive("jon@example.com", NOW)
    refute throttle.blocked("jon@example.com", NOW)
    throttle.record_failure("jon@example.com", NOW)
    assert throttle.blocked("jon@example.com", NOW)
    refute throttle.blocked("jon@example.com", NOW + 1000), "a window ends"
    throttle.clear("jon@example.com", NOW)
    refute throttle.blocked("jon@example.com", NOW)
    store.settings_starting_with("throttle:").each do |row|
      refute_includes row["key"], "jon", "keys are hashed, never kept as given"
    end
    refute Throttle.new(store, "other", 3, 1000).blocked("jon@example.com", NOW), "each throttle counts on its own"
    # Another request, with a throttle of its own, sees the same counts.
    3.times { throttle.record_failure("ada@example.com", NOW) }
    assert Throttle.new(store, "test", 3, 1000).blocked("ada@example.com", NOW)
    # A new entry clears expired ones.
    throttle.record_failure("zed@example.com", NOW + 2000)
    assert_equal 1, store.settings_starting_with("throttle:test:").length
  end

  def test_nothing_the_throttle_keeps_from_an_address_lasts_past_a_day
    store = store("sqlite")
    store.set_setting("throttle-key", "a key from before keys were made per day")
    midnight = NOW + 12 * 3_600_000
    throttle = Throttle.new(store, "ip", 3)
    keys = -> { store.settings_starting_with("throttle-key").map { |r| r["key"] }.sort }
    3.times { throttle.record_failure("203.0.113.7", midnight - 60_000) }
    assert_equal ["throttle-key:2026-10-06"], keys.call, "one hashing key a UTC day, and the old one goes"
    before = store.settings_starting_with("throttle:ip:").map { |r| r["key"] }
    # A window that crosses midnight goes on, under the new day's key.
    assert throttle.take("203.0.113.8", midnight + 60_000)
    assert throttle.blocked("203.0.113.7", midnight + 60_000)
    refute throttle.take("203.0.113.7", midnight + 60_000)
    assert_equal ["throttle-key:2026-10-06", "throttle-key:2026-10-07"], keys.call
    refute_includes store.settings_starting_with("throttle:ip:").map { |r| r["key"] }, before[0], "a count moves to the new day's id"
    # Once the windows are over, the scheduled check leaves nothing behind but today's key.
    Throttle.sweep(store, midnight + 16 * 60_000)
    assert_equal [], store.settings_starting_with("throttle:")
    assert_equal ["throttle-key:2026-10-07"], keys.call
    refute throttle.blocked("203.0.113.7", midnight + 16 * 60_000)
    # A count that has run out is gone as soon as it is read.
    throttle.record_failure("203.0.113.9", midnight + 20 * 60_000)
    refute throttle.blocked("203.0.113.9", midnight + 40 * 60_000)
    assert_equal [], store.settings_starting_with("throttle:")
    # The scheduled check sweeps them too.
    rl = Runlight::Core.new({ "store" => store, "now" => -> { midnight + (3 * 86_400_000) + 3_600_000 } })
    throttle.record_failure("203.0.113.10", midnight + 2 * 86_400_000)
    rl.check
    assert_equal [], store.settings_starting_with("throttle:")
    assert_equal [], keys.call
  end

  def test_only_a_few_passwords_are_checked_at_once_and_past_a_queue_the_rest_are_told_to_wait
    gate = Queue.new
    started = Queue.new
    held = Array.new(4 + 64) do
      Thread.new do
        Accounts.slot do
          started << true
          gate.pop
        end
      end
    end
    4.times { started.pop }
    deadline = Time.now + 10
    Thread.pass until Accounts.instance_variable_get(:@waiting) == 64 || Time.now > deadline
    assert started.empty?, "four checking, and the rest waiting"
    assert_equal "busy", code_of { Accounts.slot { flunk "never run" } }, "sixty-four waiting, so the next is told to wait"
    68.times { gate << true }
    held.each(&:join)
    assert_equal 64, started.length, "and the waiting ones each got a turn"
    assert_equal :ran, Accounts.slot { :ran }, "and once they are done, checks go on"
  end
end

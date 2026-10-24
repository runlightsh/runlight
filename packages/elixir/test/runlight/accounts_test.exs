defmodule Runlight.AccountsTest do
  @moduledoc "Accounts as packages/sdk/test/accounts.test.ts checks them: owners, roles, invites, sessions, two-factor, and the throttle."
  use ExUnit.Case, async: true

  alias Runlight.AccountError
  alias Runlight.Accounts
  alias Runlight.Accounts.Throttle
  alias Runlight.Crypto
  alias Runlight.Test.Stores

  setup do
    {store, cleanup} = Stores.store(:sqlite)
    on_exit(cleanup)
    rl = Runlight.new(store: store, now: fn -> 1_791_288_000_000 end)
    Runlight.init(rl)
    {:ok, rl: rl, acc: Accounts.new(rl, String.duplicate("s", 64))}
  end

  test "the first account is the owner, later ones admins, and the owner is protected", %{acc: acc} do
    owner = Accounts.set_password(acc, " Owner@Example.com ", "a long password", 1)
    assert owner["role"] == "owner" and owner["email"] == "owner@example.com"
    admin = Accounts.set_password(acc, "admin@example.com", "a long password", 2)
    assert admin["role"] == "admin"
    assert Accounts.sign_in(acc, "OWNER@example.com", "a long password")["id"] == owner["id"]
    assert Accounts.sign_in(acc, "owner@example.com", "wrong password!") == nil
    assert Accounts.sign_in(acc, "nobody@example.com", "a long password") == nil

    assert_raise AccountError, ~r/at least 10/, fn -> Accounts.set_password(acc, "x@example.com", "short", 3) end
    assert_raise AccountError, fn -> Accounts.set_role(acc, owner["id"], "viewer") end
    assert_raise AccountError, fn -> Accounts.remove(acc, owner["id"]) end
    assert Accounts.set_role(acc, admin["id"], "viewer")["role"] == "viewer"
    assert_raise AccountError, ~r/admin first/, fn -> Accounts.hand_over(acc, owner["id"], admin["id"]) end
    Accounts.set_role(acc, admin["id"], "admin")
    Accounts.hand_over(acc, owner["id"], admin["id"])
    assert Accounts.by_id(acc, admin["id"])["role"] == "owner"
    assert Accounts.by_id(acc, owner["id"])["role"] == "admin"
  end

  test "invites work once and replace earlier ones", %{acc: acc} do
    Accounts.set_password(acc, "owner@example.com", "a long password", 1)
    %{code: first} = Accounts.invite(acc, "new@example.com", "member", "owner@example.com", 10)
    %{code: second} = Accounts.invite(acc, "new@example.com", "viewer", "owner@example.com", 11)
    assert Accounts.invite_by_code(acc, first, 12) == nil
    assert Accounts.invite_by_code(acc, second, 12)["role"] == "viewer"
    user = Accounts.accept_invite(acc, second, "another long one", 13)
    assert user["role"] == "viewer"
    assert_raise AccountError, ~r/expired/, fn -> Accounts.accept_invite(acc, second, "another long one", 14) end

    assert_raise AccountError, ~r/already has an account/, fn ->
      Accounts.invite(acc, "new@example.com", "admin", "o", 15)
    end
  end

  test "invites go with whoever sent them: removed, made a member, or no longer allowed when the link is used",
       %{acc: acc} do
    Accounts.set_password(acc, "owner@example.com", "a long password", 1)
    accept = fn code -> Accounts.accept_invite(acc, code, "a long password", 20) end
    %{code: code} = Accounts.invite(acc, "ada@example.com", "admin", "owner@example.com", 10)
    ada = accept.(code)

    # Made a member: what they sent stops working.
    %{code: from_ada} = Accounts.invite(acc, "eve@example.com", "admin", "ada@example.com", 11)
    Accounts.set_role(acc, ada["id"], "member")
    assert Accounts.invite_by_code(acc, from_ada, 12) == nil

    # Removed: the same.
    Accounts.set_role(acc, ada["id"], "admin")
    %{code: again} = Accounts.invite(acc, "eve@example.com", "admin", "ada@example.com", 13)
    Accounts.remove(acc, ada["id"])
    assert_raise AccountError, ~r/expired/, fn -> accept.(again) end
    assert Accounts.invites(acc, 14) == []

    # An invite left from before, whose sender is no longer an admin, is refused when used, and is gone afterwards.
    %{code: code} = Accounts.invite(acc, "bo@example.com", "admin", "owner@example.com", 15)
    accept.(code)
    %{code: from_bo} = Accounts.invite(acc, "zed@example.com", "admin", "bo@example.com", 16)
    Runlight.Db.run(acc.store.db, "UPDATE rl_users SET role = 'viewer' WHERE email = ?", ["bo@example.com"])
    assert_raise AccountError, ~r/expired/, fn -> accept.(from_bo) end
    assert Accounts.invite_by_code(acc, from_bo, 17) == nil
  end

  test "only a few password checks run at once, and past a full queue sign-in is busy", %{rl: rl, acc: acc} do
    Accounts.set_password(acc, "owner@example.com", "a long password", 1)
    holder = spawn(fn -> Process.sleep(:infinity) end)
    for n <- 1..4, do: :ets.insert(rl.table, {{:accounts_checking, n}, holder})
    for _ <- 1..64, do: :ets.insert(rl.table, {{:accounts_waiting, make_ref()}, holder})

    assert_raise AccountError, ~r/busy/, fn -> Accounts.sign_in(acc, "owner@example.com", "a long password") end
    assert_raise AccountError, ~r/busy/, fn -> Accounts.sign_in(acc, "nobody@example.com", "a long password") end

    # Whatever a process held when it died is given back.
    ref = Process.monitor(holder)
    Process.exit(holder, :kill)
    assert_receive {:DOWN, ^ref, :process, ^holder, :killed}
    assert Accounts.sign_in(acc, "owner@example.com", "a long password")["email"] == "owner@example.com"
  end

  test "sessions follow the password and two-factor", %{acc: acc} do
    user = Accounts.set_password(acc, "owner@example.com", "a long password", 1)
    now = 1_791_288_000_000
    session = Accounts.session_for(acc, user, now)
    assert Accounts.from_session(acc, session, now)["id"] == user["id"]
    assert Accounts.from_session(acc, session, now + Accounts.session_ms()) == nil
    assert Accounts.from_session(acc, session <> "x", now) == nil

    secret = Accounts.start_two_factor(acc, user["id"])
    codes = Accounts.confirm_two_factor(acc, user["id"], Crypto.totp(secret, div(now, 30_000)), now)
    assert length(codes) == 10
    # Turning it on ends the session made before.
    assert Accounts.from_session(acc, session, now) == nil
    # A code works once, and a recovery code is crossed off.
    code = Crypto.totp(secret, div(now, 30_000) + 1)
    assert Accounts.check_second_factor(acc, user["id"], code, now)
    refute Accounts.check_second_factor(acc, user["id"], code, now)
    assert Accounts.check_second_factor(acc, user["id"], String.upcase(hd(codes)), now)
    refute Accounts.check_second_factor(acc, user["id"], hd(codes), now)
    assert Accounts.by_id(acc, user["id"])["recoveryLeft"] == 9

    pending = Accounts.pending_for(acc, user, now)
    assert Accounts.from_pending(acc, pending, now)["id"] == user["id"]
    assert Accounts.from_pending(acc, pending <> "x", now) == nil
    link = Accounts.link_for(acc, Accounts.by_id(acc, user["id"]), now)
    assert Accounts.from_link(acc, link, now)
    assert Accounts.from_link(acc, link, now) == nil
  end

  test "the throttle counts, forgives, and clears", %{rl: rl} do
    t = Throttle.new(rl.table, :test, 3)
    for _ <- 1..3, do: assert(Throttle.take(t, "k", 0))
    refute Throttle.take(t, "k", 0)
    Throttle.forgive(t, "k")
    assert Throttle.take(t, "k", 0)
    assert Throttle.take(t, "k", 15 * 60_000)
    Throttle.clear(t, "k")
    refute Throttle.blocked?(t, "k", 15 * 60_000)
  end

  test "the throttle keeps at most 10,000 keys, and a flood of new ones leaves a real block", %{rl: rl} do
    t = Throttle.new(rl.table, :flood, 3)
    keys = fn -> length(:ets.match_object(rl.table, {{:throttle, :flood, :_}, :_})) end
    for _ <- 1..3, do: Throttle.fail(t, "real", 0)
    assert Throttle.blocked?(t, "real", 0)
    Throttle.fail(t, "gone", 0)
    Throttle.clear(t, "gone")
    for n <- 1..10_050, do: Throttle.fail(t, "made-up #{n}", 0)
    # Past the ceiling, those with the fewest tries go, down to nine tenths of it, and the last 50 come after.
    assert keys.() == 9_050
    assert Throttle.blocked?(t, "real", 0)
    refute Throttle.blocked?(t, "made-up 1", 0) or Throttle.blocked?(t, "made-up 50", 0)
    # Expired keys go first, and the count starts again from what is left.
    for n <- 1..951, do: Throttle.fail(t, "later #{n}", 15 * 60_000)
    assert keys.() == 951
  end

  test "a code is accepted once, even by two processes", %{rl: rl, acc: acc} do
    user = Accounts.set_password(acc, "owner@example.com", "a long password", 1)
    now = 1_791_288_000_000
    secret = Accounts.start_two_factor(acc, user["id"])
    codes = Accounts.confirm_two_factor(acc, user["id"], Crypto.totp(secret, div(now, 30_000)), now)

    # Another Accounts on the same database, with no lock in common with the first.
    other = Accounts.new(Runlight.new(store: rl.store, now: fn -> now end), String.duplicate("s", 64))

    both = fn code, at ->
      [acc, other]
      |> Task.async_stream(&Accounts.check_second_factor(&1, user["id"], code, at), timeout: 30_000)
      |> Enum.map(&elem(&1, 1))
    end

    for round <- 1..5 do
      at = now + round * 30_000
      code = Crypto.totp(secret, div(at, 30_000))
      assert Enum.count(both.(code, at), & &1) == 1, "TOTP round #{round}"
    end

    for code <- Enum.take(codes, 3) do
      assert Enum.count(both.(code, now), & &1) == 1, "recovery code #{code}"
    end

    assert Accounts.by_id(acc, user["id"])["recoveryLeft"] == 7
  end
end

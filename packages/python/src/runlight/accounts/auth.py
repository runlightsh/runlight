"""Accounts: who may sign in, their password hashes, two-factor, invites, and the signed cookie that keeps them
signed in. The standalone server always has them, and an app turns them on with routes({"accounts": True}).

A user is a dict with the TypeScript User's keys: id, email, hash, role ("owner", "admin", "member", or
"viewer"), createdAt, twoFactor (whether sign-in also asks for a code), recoveryLeft (recovery codes not yet
used), and signedOut when set (a mark signing out replaces, which every session is signed with). An invite has
id, email, role, invitedBy, createdAt, and expiresAt.
"""

from __future__ import annotations

import datetime as _dt
import re
import struct
import threading
import time as _time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, TypeVar

from .. import _js
from ..store.sql import upsert
from .crypto import (
    PASSWORD_SLOTS,
    base64url,
    check_password,
    hash_password,
    hex,
    hmac,
    random_bytes,
    same_text,
    seal_text,
    sha256,
    unseal_text,
    weaker_than_now,
)

if TYPE_CHECKING:
    from ..store import SqlStore

__all__ = [
    "INVITE_MS",
    "MIN_PASSWORD",
    "SESSION_COOKIE",
    "SESSION_MS",
    "AccountError",
    "Accounts",
    "Throttle",
    "base32",
    "check_password",
    "hash_password",
    "otpauth_uri",
    "totp",
]

T = TypeVar("T")


class AccountError(_js.RangeError):
    """A problem with an account change, to show the person making it. A RangeError in TypeScript, with a `code`
    and `params` the dashboard words in its own language."""

    def __init__(self, message: str, code: str, params: dict[str, str] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.params = {} if params is None else params


SESSION_COOKIE = "runlight_session"
# Thirty days, renewed on every sign-in.
SESSION_MS = 30 * 86_400_000
MIN_PASSWORD = 10
# The most sign-in keys the throttle remembers at once.
MAX_THROTTLED = 10_000

# The owner can do everything, and nobody else can remove them or change their role; they can hand ownership to
# an admin. An admin can do everything the owner can apart from that. A member changes sites, goals, links, and
# the rest, but not people, the mail service, the assistant's settings, or deleting a site. A viewer reads every
# site's stats and changes nothing.
ROLES = ("owner", "admin", "member", "viewer")


def role_from(value: Any) -> str:
    """A stored role read back; anything unknown reads as a viewer, the least it could be."""
    return value if isinstance(value, str) and value in ROLES else "viewer"


def may_invite(role: str) -> bool:
    """Whether a role may invite people. The owner and admins invite as admin, member, or viewer."""
    return role in ("owner", "admin")


# Two-factor: TOTP as authenticator apps expect it (RFC 6238): SHA-1, six digits, 30 seconds.
STEP_MS = 30_000
BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"


def base32(data: bytes) -> str:
    bits = 0
    value = 0
    out = []
    for byte in data:
        # Only the low bits are ever read, so the rest are dropped before they grow.
        value = ((value << 8) | byte) & 0xFFFF
        bits += 8
        while bits >= 5:
            out.append(BASE32[(value >> (bits - 5)) & 31])
            bits -= 5
    if bits > 0:
        out.append(BASE32[(value << (5 - bits)) & 31])
    return "".join(out)


def unbase32(text: str) -> bytes:
    """Bytes from base32, skipping anything that is not a base32 letter, as authenticator apps' secrets come."""
    bits = 0
    value = 0
    out = bytearray()
    for c in re.sub(r"=+\Z", "", text).upper():
        i = BASE32.find(c)
        if i < 0:
            continue
        value = ((value << 5) | i) & 0xFFFF
        bits += 5
        if bits >= 8:
            out.append((value >> (bits - 8)) & 255)
            bits -= 8
    return bytes(out)


def totp(secret: str, step: int) -> str:
    """The six-digit code for a secret at a time step. Raises ValueError for a secret with no base32 letters, as
    Web Crypto refuses an empty key."""
    mac = hmac("SHA-1", unbase32(secret), struct.pack(">Q", step))
    at = mac[-1] & 15
    n = ((mac[at] & 127) << 24) | (mac[at + 1] << 16) | (mac[at + 2] << 8) | mac[at + 3]
    return str(n % 1_000_000).rjust(6, "0")


def otpauth_uri(secret: str, email: str, host: str) -> str:
    """The address an authenticator app reads from the QR code."""
    label = _js.encode_uri_component(f"Runlight ({host}):{email}")
    issuer = _js.encode_uri_component(f"Runlight ({host})")
    return f"otpauth://totp/{label}?secret={secret}&issuer={issuer}&algorithm=SHA1&digits=6&period=30"


def recovery_codes() -> list[str]:
    """Ten one-use recovery codes, like "k7dq-2mfa"."""
    codes = []
    for _ in range(10):
        raw = base32(random_bytes(5)).lower()
        codes.append(f"{raw[0:4]}-{raw[4:8]}")
    return codes


def recovery_hash(code: str) -> str:
    """What a recovery code is kept as: SHA-256 of its letters and digits in lower case, so dashes and case do not
    matter."""
    return hex(sha256(re.sub(r"[^a-z0-9]", "", code, flags=re.I | re.ASCII).lower()))


def match_step(secret: str, code: str, now: int, after: int) -> int | None:
    """The time step a code matches, one step either side for clocks that drift, newer than `after`; else None."""
    current = int(now // STEP_MS)
    for step in (current, current - 1, current + 1):
        if step > after and totp(secret, step) == code:
            return step
    return None


def signature(secret: str, body: str, hash: str) -> str:  # noqa: A002
    """The signature on a session, sign-in, or device value: HMAC-SHA-256 of "body.hash" under the install's
    secret."""
    return base64url(hmac("SHA-256", secret, f"{body}.{hash}"))


# What passes for an email address, with JavaScript's \s.
_NOT_EMAIL = f"[^{_js.WHITESPACE}@<>\"]+"
EMAIL = re.compile(f"{_NOT_EMAIL}@{_NOT_EMAIL}\\.{_NOT_EMAIL}\\Z")

# How long an invite link works.
INVITE_MS = 7 * 86_400_000

_INVITE_CODE = re.compile(r"[A-Za-z0-9_-]{20,64}\Z")
_SIX_DIGITS = re.compile(r"[0-9]{6}\Z")


# Password checks for sign-ins that may wait at once, in this process, beyond the few that run (PASSWORD_SLOTS,
# which crypto holds every hash to). Past that a sign-in is refused at once rather than queued.
WAITING = 64
_checks = threading.BoundedSemaphore(PASSWORD_SLOTS + WAITING)


def _slot(fn: Callable[[], T]) -> T:
    """Runs a password check when there is room, so a flood of sign-ins cannot pile up without end. Past the
    queue's length it refuses at once, with an AccountError coded "busy"."""
    if not _checks.acquire(blocking=False):
        raise AccountError("Runlight is busy checking other sign-ins. Try again in a moment.", "busy")
    try:
        return fn()
    finally:
        _checks.release()


def _code_hash(code: str) -> str:
    return hex(sha256(code))


def _recovery_list(value: Any) -> list[str]:
    return _js.loads(_js.string(value)) if _js.truthy(value) else []


class Accounts:
    # A password checked against nothing, so a wrong email takes as long as a wrong password. Made when first
    # needed.
    _decoy: str | None = None

    def __init__(self, store: SqlStore, secret: str) -> None:
        self.store = store
        self.secret = secret
        self._ready = False

    def _turn(self, fn: Callable[[], T]) -> T:
        """Changes to who has an account take turns, across threads and processes, through the database's lock, so
        two owners demoting each other at once cannot leave none, and a double-clicked invite makes one."""
        return self.store.db.exclusive(lambda _db: fn())

    def _init(self) -> None:
        if self._ready:
            return
        from ..store import MYSQL_COLLATION

        # Several processes starting at once create the tables one at a time.
        def create(_db: Any) -> None:
            db = self.store.db
            # MySQL keys TEXT only by a prefix, so there the keyed columns are VARCHAR, in the binary collation the
            # store's tables use.
            my = db.dialect() == "mysql"

            def text(n: int) -> str:
                return f"VARCHAR({n})" if my else "TEXT"

            table = f" DEFAULT CHARSET=utf8mb4 COLLATE={MYSQL_COLLATION}" if my else ""
            db.run(
                f"CREATE TABLE IF NOT EXISTS rl_users (id {text(100)} PRIMARY KEY, email {text(320)} NOT NULL UNIQUE, "
                f"hash TEXT NOT NULL, created_at BIGINT NOT NULL){table}"
            )
            # Roles came later; a table from before them gains the column, and its accounts stay owners.
            columns = (
                db.all("PRAGMA table_info(rl_users)")
                if db.dialect() == "sqlite"
                else db.all(
                    "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'rl_users' "
                    f"AND table_schema = {'DATABASE()' if my else 'current_schema()'}"
                )
            )
            names = [_js.string(c.get("name", c.get("NAME", ""))) for c in columns]
            if "role" not in names:
                db.run(f"ALTER TABLE rl_users ADD COLUMN role {text(20)} NOT NULL DEFAULT 'owner'")
            # Two-factor came later still: the secret (sealed), one being set up, recovery code hashes, and the last
            # code's step. And the mark signing out replaces, later again.
            for name, kind in (
                ("totp_secret", "TEXT"),
                ("totp_pending", "TEXT"),
                ("totp_recovery", "TEXT"),
                ("totp_step", "BIGINT"),
                ("signed_out", "TEXT"),
            ):
                if name not in names:
                    db.run(f"ALTER TABLE rl_users ADD COLUMN {name} {kind}")
            db.run(
                f"CREATE TABLE IF NOT EXISTS rl_invites (id {text(100)} PRIMARY KEY, email {text(320)} NOT NULL UNIQUE, "
                f"role {text(20)} NOT NULL, code_hash {text(128)} NOT NULL UNIQUE, invited_by {text(100)} NOT NULL, "
                f"created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL){table}"
            )
            for table_name in ("rl_users", "rl_invites"):
                fields = db.all(f"PRAGMA table_info({table_name})") if db.dialect() == "sqlite" else db.all(
                    f"SELECT column_name AS name FROM information_schema.columns WHERE table_name = '{table_name}' AND table_schema = {'DATABASE()' if my else 'current_schema()'}")
                if not any(c.get("name", c.get("NAME")) == "site" for c in fields):
                    db.run(f"ALTER TABLE {table_name} ADD COLUMN site TEXT")
            # A server has one owner. One from before, with several, keeps the first and the rest become admins,
            # who can still do everything but remove the owner. Invites to join as an owner become invites as an
            # admin.
            owners = db.all("SELECT id FROM rl_users WHERE role = 'owner' ORDER BY created_at, id")
            for extra in owners[1:]:
                db.run("UPDATE rl_users SET role = 'admin' WHERE id = ?", [_js.string(extra["id"])])
            db.run("UPDATE rl_invites SET role = 'admin' WHERE role = 'owner'")

        self.store.db.exclusive(create)
        self._ready = True

    def _row(self, r: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": _js.string(r["id"]),
            "email": _js.string(r["email"]),
            "hash": _js.string(r["hash"]),
            "role": role_from(r.get("role")),
            **({"site": str(r["site"])} if r.get("site") is not None else {}),
            "createdAt": _js.number(r["created_at"]),
            "twoFactor": _js.truthy(r.get("totp_secret")),
            "recoveryLeft": len(_recovery_list(r.get("totp_recovery"))),
            **({"signedOut": _js.string(r["signed_out"])} if _js.truthy(r.get("signed_out")) else {}),
        }

    def _seal(self, text: str) -> str:
        """Seals a two-factor secret with the install's secret, so the database alone cannot make codes."""
        return seal_text(text, self.secret)

    def _unseal(self, sealed: str) -> str | None:
        return unseal_text(sealed, self.secret)

    def _first(self, sql: str, params: list[Any]) -> dict[str, Any] | None:
        rows = self.store.db.all(sql, params)
        return rows[0] if rows else None

    def start_two_factor(self, id: str) -> str:  # noqa: A002
        """Starts turning on two-factor: a new secret, kept aside until a code from it is confirmed."""
        self._init()
        secret = base32(random_bytes(20))
        self.store.db.run("UPDATE rl_users SET totp_pending = ? WHERE id = ?", [self._seal(secret), id])
        return secret

    def confirm_two_factor(self, id: str, code: str, now: int) -> list[str] | None:  # noqa: A002
        """Turns two-factor on once a code from the new secret checks out, and returns ten recovery codes, shown
        once."""
        self._init()
        row = self._first("SELECT totp_pending FROM rl_users WHERE id = ?", [id])
        secret = self._unseal(_js.string(row["totp_pending"])) if row is not None and _js.truthy(row.get("totp_pending")) else None
        step = match_step(secret, code, now, -1) if secret else None
        if step is None:
            return None
        recovery = recovery_codes()
        # The code that turned it on is not marked used, so signing in again at once with it works.
        self.store.db.run(
            "UPDATE rl_users SET totp_secret = ?, totp_pending = NULL, totp_recovery = ?, totp_step = NULL WHERE id = ?",
            [self._seal(secret), _js.dumps([recovery_hash(c) for c in recovery]), id],
        )
        return recovery

    def new_recovery_codes(self, id: str) -> list[str]:  # noqa: A002
        """New recovery codes in place of the old ones."""
        self._init()
        recovery = recovery_codes()
        self.store.db.run("UPDATE rl_users SET totp_recovery = ? WHERE id = ?", [_js.dumps([recovery_hash(c) for c in recovery]), id])
        return recovery

    def cancel_two_factor_setup(self, id: str) -> None:  # noqa: A002
        """Drops a set-up left half done, after too many wrong codes, so it must start again with the password."""
        self._init()
        self.store.db.run("UPDATE rl_users SET totp_pending = NULL WHERE id = ?", [id])

    def disable_two_factor(self, id: str) -> None:  # noqa: A002
        self._init()
        self.store.db.run(
            "UPDATE rl_users SET totp_secret = NULL, totp_pending = NULL, totp_recovery = NULL, totp_step = NULL WHERE id = ?", [id]
        )

    def check_second_factor(self, id: str, code: str, now: int) -> bool:  # noqa: A002
        """Checks a six-digit code, or a recovery code, for an account with two-factor on.
        A code works once: one already used, or older, is refused, and a recovery code is crossed off.
        One check at a time, so two sign-ins at once cannot both use the same code: TypeScript queues them per
        account in its process, and this takes the database's lock, which holds across threads and processes. The
        database has the last word too: the code is spent by an update that only applies if no other check has
        spent it first, for a database whose lock does not reach another process."""
        self._init()
        return self._turn(lambda: self._check_second_factor_now(id, code, now))

    def _check_second_factor_now(self, id: str, code: str, now: int) -> bool:  # noqa: A002
        row = self._first("SELECT totp_secret, totp_recovery, totp_step FROM rl_users WHERE id = ?", [id])
        if row is None or not _js.truthy(row.get("totp_secret")):
            return False
        given = _js.trim(code)
        digits = _js.SPACE.sub("", given)
        if _SIX_DIGITS.match(digits):
            secret = self._unseal(_js.string(row["totp_secret"]))
            after = -1 if row.get("totp_step") is None else int(_js.number(row["totp_step"]))
            step = match_step(secret, digits, now, after) if secret else None
            if step is None:
                return False
            # Only if no check since has used this step or a later one: of two at once, one moves it and the other
            # is refused.
            return self.store.db.affected("UPDATE rl_users SET totp_step = ? WHERE id = ? AND (totp_step IS NULL OR totp_step < ?)", [step, id, step]) == 1
        read = _js.string(row["totp_recovery"]) if _js.truthy(row.get("totp_recovery")) else None
        hashes = _recovery_list(row.get("totp_recovery"))
        wanted = recovery_hash(given)
        if wanted not in hashes:
            return False
        hashes.remove(wanted)
        # Only if the codes are still the ones read, so a code crossed off at the same moment elsewhere is not used
        # twice.
        return self.store.db.affected("UPDATE rl_users SET totp_recovery = ? WHERE id = ? AND totp_recovery = ?", [_js.dumps(hashes), id, read]) == 1

    def pending_for(self, user: dict[str, Any], now: int) -> str:
        """A short-lived ticket naming an account whose password checked out and
        which still owes a code. Signed like a session, so it cannot be made up."""
        return self._ticket("pending", user, now + 5 * 60_000)

    def from_pending(self, value: str, now: int) -> dict[str, Any] | None:
        """The account a code-step ticket names."""
        return self._from_ticket("pending", value, now)

    def link_for(self, user: dict[str, Any], now: int) -> str:
        """A ticket for a sign-in link sent by email, for fifteen minutes. A new password withdraws it."""
        return self._ticket("link", user, now + 15 * 60_000)

    def from_link(self, value: str, now: int) -> dict[str, Any] | None:
        """The account a sign-in link is for. A link works once: using it withdraws it, and every link sent
        before it. Uses take turns, so a link opened twice at once lets one in."""
        user = self._from_ticket("link", value, now)
        if user is None:
            return None
        expires = _js.number(value.split(".")[1])

        def use() -> dict[str, Any] | None:
            key = f"login-link-used:{user['id']}"
            used = self.store.setting(key)
            if expires <= _js.number(0 if used is None else used):
                return None
            self.store.set_setting(key, _js.string(expires))
            return user

        return self._turn(use)

    def _ticket(self, kind: str, user: dict[str, Any], expires: int) -> str:
        body = f"{user['id']}.{_js.string(expires)}"
        return f"{body}.{self._sign(f'{kind}.{body}', user['hash'])}"

    def _from_ticket(self, kind: str, value: str, now: int) -> dict[str, Any] | None:
        parts = value.split(".")
        id_ = parts[0]
        expires = parts[1] if len(parts) > 1 else ""
        signed = parts[2] if len(parts) > 2 else ""
        if not id_ or not expires or not signed or not (_js.number(expires) > now):
            return None
        user = self.by_id(id_)
        if user is None:
            return None
        return user if same_text(self._sign(f"{kind}.{id_}.{expires}", user["hash"]), signed) else None

    def count(self) -> int:
        self._init()
        row = self._first("SELECT COUNT(*) AS n FROM rl_users", [])
        return int(_js.number(row["n"] if row is not None else 0))

    def by_email(self, email: str) -> dict[str, Any] | None:
        self._init()
        row = self._first("SELECT * FROM rl_users WHERE email = ?", [_js.lower(_js.trim(email))])
        return self._row(row) if row is not None else None

    def by_id(self, id: str) -> dict[str, Any] | None:  # noqa: A002
        self._init()
        row = self._first("SELECT * FROM rl_users WHERE id = ?", [id])
        return self._row(row) if row is not None else None

    def list(self) -> list[dict[str, Any]]:
        self._init()
        return [self._row(r) for r in self.store.db.all("SELECT * FROM rl_users ORDER BY created_at, id")]

    def _find(self, id: str) -> dict[str, Any] | None:  # noqa: A002
        return next((u for u in self.list() if u["id"] == id), None)

    def set_role(self, id: str, role: str) -> dict[str, Any]:  # noqa: A002
        """Changes a role. The owner's never changes here, and nobody becomes the owner here: see hand_over()."""
        # The tables first: making them takes the same lock as a turn.
        self._init()

        def change() -> dict[str, Any]:
            user = self._find(id)
            if user is None:
                raise AccountError("Unknown account", "unknown_account")
            if user["role"] == "owner":
                raise AccountError("Only the owner can change their own role, by handing ownership to an admin", "owner_protected")
            if user.get("site") is not None and role == "admin":
                raise AccountError("An admin needs access to all sites", "role_scope")
            if role == "owner":
                raise AccountError("Ownership is handed over by the owner", "owner_hand_over")
            self.store.db.run("UPDATE rl_users SET role = ? WHERE id = ?", [role, id])
            # Someone who may no longer invite takes back the invites they sent, so nobody joins on their word.
            if not may_invite(role):
                self.store.db.run("DELETE FROM rl_invites WHERE invited_by = ?", [user["email"]])
            return {**user, "role": role}

        return self._turn(change)

    def hand_over(self, from_: str, to: str) -> None:
        """Makes an admin the owner, and the owner an admin."""
        self._init()

        def change() -> None:
            owner = self._find(from_)
            nxt = self._find(to)
            if owner is None or owner["role"] != "owner":
                raise AccountError("Only the owner can hand over ownership", "owner_hand_over")
            if nxt is None:
                raise AccountError("Unknown account", "unknown_account")
            if nxt.get("site") is not None or nxt["role"] != "admin":
                raise AccountError("Make them an admin first", "owner_needs_admin")
            self.store.db.run("UPDATE rl_users SET role = 'owner' WHERE id = ?", [to])
            self.store.db.run("UPDATE rl_users SET role = 'admin' WHERE id = ?", [from_])

        self._turn(change)

    def forget_site(self, site: str) -> None:
        """Removes the accounts and invitations kept to a site that was deleted. A site made later is often given the
        same id, from its domain, and they must not find their way into it."""
        self._init()

        def change() -> None:
            for user in [u for u in self.list() if u.get("site") == site]:
                self.store.db.run("DELETE FROM rl_users WHERE id = ?", [user["id"]])
                self.store.set_setting(f"login-link-used:{user['id']}", None)
            self.store.db.run("DELETE FROM rl_invites WHERE site = ?", [site])

        self._turn(change)

    def remove(self, id: str) -> None:  # noqa: A002
        """Removes an account. The owner cannot be removed."""
        # The tables first: making them takes the same lock as a turn.
        self._init()

        def change() -> None:
            user = self._find(id)
            if user is None:
                raise AccountError("Unknown account", "unknown_account")
            if user["role"] == "owner":
                raise AccountError("The owner cannot be removed", "owner_protected")
            self.store.db.run("DELETE FROM rl_users WHERE id = ?", [id])
            self.store.db.run("DELETE FROM rl_invites WHERE invited_by = ?", [user["email"]])
            self.store.set_setting(f"login-link-used:{id}", None)

        self._turn(change)

    def set_password(self, email: str, password: str, now: int, role: str | None = None, site: str | None = None) -> dict[str, Any]:
        """Makes an account, or sets a new password on an existing one. A new account is the owner when it is the
        first, and otherwise an admin unless a role is given, since a server has one owner."""
        self._init()
        if site is not None and (not site or role not in ("member", "viewer")):
            raise AccountError("Choose member or viewer for one site", "role_scope")
        address = _js.lower(_js.trim(email))
        if not EMAIL.match(address):
            raise AccountError("Enter an email address", "email_invalid")
        # The length in UTF-16 units, as TypeScript counts it.
        if _js.length(password) < MIN_PASSWORD:
            raise AccountError(f"Use a password of at least {MIN_PASSWORD} characters", "password_short", {"min": str(MIN_PASSWORD)})
        hashed = hash_password(password)
        existing = self.by_email(address)
        if existing is not None:
            self.store.db.run("UPDATE rl_users SET hash = ? WHERE id = ?", [hashed, existing["id"]])
            return {**existing, "hash": hashed}
        first = self.count() == 0
        given = role if role is not None else ("owner" if first else "admin")
        user = {
            "id": hex(random_bytes(12)),
            "email": address,
            "hash": hashed,
            "role": "admin" if given == "owner" and not first else given,
            "createdAt": now,
            "twoFactor": False,
            "recoveryLeft": 0,
            **({"site": site} if site is not None else {}),
        }
        self.store.db.run(
            "INSERT INTO rl_users (id, email, hash, role, created_at, site) VALUES (?, ?, ?, ?, ?, ?)",
            [user["id"], user["email"], user["hash"], user["role"], user["createdAt"], site],
        )
        return user

    def _invite_row(self, r: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": _js.string(r["id"]),
            "email": _js.string(r["email"]),
            "role": role_from(r.get("role")),
            **({"site": str(r["site"])} if r.get("site") is not None else {}),
            "invitedBy": _js.string(r["invited_by"]),
            "createdAt": _js.number(r["created_at"]),
            "expiresAt": _js.number(r["expires_at"]),
        }

    def invites(self, now: int) -> list[dict[str, Any]]:
        """Invites that still work, newest first. Expired ones are cleared on the way."""
        self._init()
        self.store.db.run("DELETE FROM rl_invites WHERE expires_at <= ?", [now])
        return [self._invite_row(r) for r in self.store.db.all("SELECT * FROM rl_invites ORDER BY created_at DESC, id")]

    def invite(self, email: str, role: str, invited_by: str, now: int, site: str | None = None) -> dict[str, Any]:
        """Invites someone to join with a role, and returns {invite, code}, the code for their link.
        Asking again replaces the earlier invite, so only the newest link works."""
        self._init()
        return self._turn(lambda: self._invite_now(email, role, invited_by, now, site))

    def _invite_now(self, email: str, role: str, invited_by: str, now: int, site: str | None = None) -> dict[str, Any]:
        if site is not None and (not site or role not in ("member", "viewer")):
            raise AccountError("Choose member or viewer for one site", "role_scope")
        address = _js.lower(_js.trim(email))
        if not EMAIL.match(address):
            raise AccountError("Enter an email address", "email_invalid")
        if self.by_email(address) is not None:
            raise AccountError(f"{address} already has an account", "account_exists", {"email": address})
        code = base64url(random_bytes(24))
        invite = {**({"site": site} if site is not None else {}), "id": hex(random_bytes(12)), "email": address, "role": role, "invitedBy": invited_by, "createdAt": now, "expiresAt": now + INVITE_MS}
        self.store.db.run("DELETE FROM rl_invites WHERE email = ?", [address])
        self.store.db.run(
            "INSERT INTO rl_invites (id, email, role, code_hash, invited_by, created_at, expires_at, site) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [invite["id"], invite["email"], invite["role"], _code_hash(code), invite["invitedBy"], invite["createdAt"], invite["expiresAt"], site],
        )
        return {"invite": invite, "code": code}

    def invite_by_code(self, code: str, now: int) -> dict[str, Any] | None:
        """The invite a link's code belongs to, while it still works."""
        self._init()
        if not _INVITE_CODE.match(code):
            return None
        row = self._first("SELECT * FROM rl_invites WHERE code_hash = ? AND expires_at > ?", [_code_hash(code), now])
        return self._invite_row(row) if row is not None else None

    def cancel_invite(self, id: str) -> bool:  # noqa: A002
        self._init()
        before = len(self.store.db.all("SELECT id FROM rl_invites WHERE id = ?", [id]))
        self.store.db.run("DELETE FROM rl_invites WHERE id = ?", [id])
        return before > 0

    def accept_invite(self, code: str, password: str, now: int) -> dict[str, Any]:
        """Turns an invite into an account with the password its person chose. The link then stops working. It takes a
        turn, so it cannot cross a removal of whoever sent it, and the sender must still be someone who may invite."""
        # The tables first: making them takes the same lock as a turn.
        self._init()

        # None for an invite that is gone. A turn that raises is rolled back here, so it returns instead, and an
        # invite whose sender may no longer invite stays deleted.
        def accept() -> dict[str, Any] | None:
            invite = self.invite_by_code(code, now)
            if invite is None:
                return None
            sender = self.by_email(invite["invitedBy"])
            if sender is None or sender.get("site") is not None or not may_invite(sender["role"]):
                self.store.db.run("DELETE FROM rl_invites WHERE id = ?", [invite["id"]])
                return None
            if self.by_email(invite["email"]) is not None:
                raise AccountError(f"{invite['email']} already has an account", "account_exists", {"email": invite["email"]})
            user = self.set_password(invite["email"], password, now, invite["role"], invite.get("site"))
            self.store.db.run("DELETE FROM rl_invites WHERE id = ?", [invite["id"]])
            return user

        user = self._turn(accept)
        if user is None:
            raise AccountError("This invite has expired or was already used. Ask for a new one.", "invite_gone")
        return user

    def sign_in(self, email: str, password: str) -> dict[str, Any] | None:
        """The account for an email and password, or None. Takes the same time either way. Only a few checks run at
        once; with too many waiting it raises an AccountError coded "busy"."""
        user = self.by_email(email)
        if user is None:
            if Accounts._decoy is None:
                Accounts._decoy = hash_password(hex(random_bytes(16)))
            decoy = Accounts._decoy
            _slot(lambda: check_password(password, decoy))
            return None
        if not _slot(lambda: check_password(password, user["hash"])):
            return None
        if not weaker_than_now(user["hash"]):
            return user
        # A hash from before the cost rose is made again now that the password is here, unless it changed meanwhile.
        hash_ = _slot(lambda: hash_password(password))
        self.store.db.run("UPDATE rl_users SET hash = ? WHERE id = ? AND hash = ?", [hash_, user["id"], user["hash"]])
        return self.by_id(user["id"]) or user

    def session_for(self, user: dict[str, Any], now: int) -> str:
        """A cookie value naming the user and when it expires, signed with the
        server's secret and the user's password hash, so changing a password
        signs out every other browser."""
        expires = now + SESSION_MS
        body = f"{user['id']}.{_js.string(expires)}"
        return f"{body}.{self._sign(body, self._session_key(user))}"

    def from_session(self, value: str, now: int) -> dict[str, Any] | None:
        """The signed-in user for a cookie value, or None."""
        parts = value.split(".")
        id_ = parts[0]
        expires = parts[1] if len(parts) > 1 else ""
        signed = parts[2] if len(parts) > 2 else ""
        if not id_ or not expires or not signed or not (_js.number(expires) > now):
            return None
        user = self.by_id(id_)
        if user is None:
            return None
        return user if same_text(self._sign(f"{id_}.{expires}", self._session_key(user)), signed) else None

    def end_sessions(self, id: str) -> None:  # noqa: A002
        """Ends every session an account has, in every browser, as signing out does."""
        self._init()
        self.store.db.run("UPDATE rl_users SET signed_out = ? WHERE id = ?", [hex(random_bytes(8)), id])

    def _session_key(self, user: dict[str, Any]) -> str:
        """What a session is signed with: the password hash, whether two-factor is on, and a mark that signing out
        replaces, so changing any of them ends other sessions."""
        signed_out = user.get("signedOut")
        return f"{user['hash']}{'.2fa' if user['twoFactor'] else ''}{f'.{signed_out}' if signed_out else ''}"

    def device_for(self, user: dict[str, Any]) -> str:
        """A long-lived mark for a browser that signed in to an account. With it, failed tries by others
        against that account cannot lock this browser out; the per-address limit still applies.
        A new password withdraws it."""
        return f"{user['id']}." + self._sign(f"device.{user['id']}", user["hash"])

    def trusts_device(self, value: str, user: dict[str, Any]) -> bool:
        parts = value.split(".")
        id_ = parts[0]
        signed = parts[1] if len(parts) > 1 else ""
        if id_ != user["id"] or not signed:
            return False
        return same_text(self._sign(f"device.{user['id']}", user["hash"]), signed)

    def _sign(self, body: str, hash: str) -> str:  # noqa: A002
        return signature(self.secret, body, hash)


class Throttle:
    """Counts failed sign-ins under a key and refuses more than a few in a while.
    Keys are hashed with a key made for the day, so the counts never hold an
    address or an email as it was given.

    TypeScript keeps the counts in its process. A Python app often runs several
    worker processes, so here they live in the database's settings, as the PHP
    port keeps them: "throttle:<name>:<id>" holding {count, until}, and the
    hashing key as "throttle-key:<UTC day>". Every process of an install then
    shares the same counts, and the two ports read each other's.

    Some ids come from an address, so none may last past a day: each UTC day
    has its own key, keys older than yesterday are deleted, and counts that ran
    out go when read, when a new count starts, and in the scheduled check. A
    window that crosses midnight starts again under the new day's key."""

    _KEY = "throttle-key:"
    # The one key kept before keys were made each day.
    _OLD_KEY = "throttle-key"

    def __init__(
        self, store: SqlStore, name: str, limit: int = 10, window_ms: int = 15 * 60_000, clock: Callable[[], int] | None = None
    ) -> None:
        self.store = store
        self.name = name
        self.limit = limit
        self.window_ms = window_ms
        # Milliseconds since the epoch, for forgive() and clear(), which are given no time.
        self._clock: Callable[[], int] = clock if clock is not None else (lambda: int(_time.time() * 1000))
        self._lock = threading.Lock()
        # Today's key once read, so each count does not read it again.
        self._salts: tuple[str, str] | None = None

    @staticmethod
    def _day(now: int) -> str:
        return _dt.datetime.fromtimestamp(now // 1000, _dt.UTC).strftime("%Y-%m-%d")

    def _salt(self, now: int) -> str:
        day = self._day(now)
        if self._salts is not None and self._salts[0] == day:
            return self._salts[1]
        key = self._KEY + day
        saved = self.store.setting(key)
        if not saved:
            from ..hash import random_id

            # Kept only if there is none yet, so two processes starting at once settle on one key.
            made = random_id(16)
            db = self.store.db
            db.run(upsert(db.dialect(), "rl_settings", ['"key"', "value"], ['"key"'], []), [key, made])
            saved = self.store.setting(key) or made
            if saved == made:
                Throttle.sweep(self.store, now)
        self._salts = (day, saved)
        return saved

    @staticmethod
    def sweep(store: SqlStore, now: int) -> None:
        """Deletes the counts of every throttle that have run out, the hashing keys older than yesterday, and the
        one key kept before there was one a day, so nothing an id was made from outlasts a day. The scheduled
        check runs it, and so does the first count of each day."""
        keep = {Throttle._KEY + Throttle._day(now), Throttle._KEY + Throttle._day(now - 86_400_000)}
        for setting in store.settings_starting_with(Throttle._KEY):
            if setting["key"] not in keep:
                store.set_setting(setting["key"], None)
        if store.setting(Throttle._OLD_KEY) is not None:
            store.set_setting(Throttle._OLD_KEY, None)
        for setting in store.settings_starting_with("throttle:"):
            ok, entry = _js.try_loads(setting["value"])
            if not ok or not isinstance(entry, dict) or int(_js.number(entry.get("until", 0))) <= now:
                store.db.run('DELETE FROM rl_settings WHERE "key" = ? AND value = ?', [setting["key"], setting["value"]])

    def _id(self, key: str, now: int) -> str:
        return base64url(hmac("SHA-256", self._salt(now), key))[:22]

    def _prefix(self) -> str:
        return f"throttle:{self.name}:"

    def _entry(self, id_: str, now: int) -> dict[str, int] | None:
        """A count still running. One that has run out is deleted as it is read."""
        key = self._prefix() + id_
        saved = self.store.setting(key)
        if saved is None:
            return None
        ok, entry = _js.try_loads(saved)
        if not ok or not isinstance(entry, dict) or int(_js.number(entry.get("until", 0))) <= now:
            self._drop(key, saved)
            return None
        return {"count": int(_js.number(entry.get("count", 0))), "until": int(_js.number(entry.get("until", 0)))}

    def _save(self, id_: str, entry: dict[str, int]) -> None:
        self.store.set_setting(self._prefix() + id_, _js.dumps(entry))

    def _turn(self, id_: str, make: bool, fn: Callable[[], T]) -> T:
        """Runs a read and a change of one entry as a single step, so a burst of tries at once cannot all find
        room under the limit: one thread at a time in this process, and a transaction holding the entry's row
        against other processes. SQLite's transaction holds the whole file; on Postgres and MySQL the row is
        locked, made first (empty, which reads as expired) when `make` asks and it is not there yet."""
        db = self.store.db

        def step(_db: Any) -> T:
            dialect = db.dialect()
            if dialect != "sqlite":
                key = self._prefix() + id_
                if make:
                    db.run(upsert(dialect, "rl_settings", ['"key"', "value"], ['"key"'], []), [key, "{}"])
                db.all('SELECT "key" FROM rl_settings WHERE "key" = ? FOR UPDATE', [key])
            return fn()

        with self._lock:
            return db.transaction(step)

    def blocked(self, key: str, now: int) -> bool:
        return self._blocked_now(self._id(key, now), now)

    def _blocked_now(self, id_: str, now: int) -> bool:
        entry = self._entry(id_, now)
        return entry is not None and entry["count"] >= self.limit

    def take(self, key: str, now: int) -> bool:
        """Counts a try before the slow check it guards, so a burst that arrives
        while earlier tries are still being checked cannot get past the limit.
        False, counting nothing, when the key is already at its limit. A try
        that turns out right is taken back with forgive(). The check and the
        count happen as one step, across threads and processes."""
        id_ = self._id(key, now)

        def step() -> tuple[bool, bool]:
            if self._blocked_now(id_, now):
                return False, False
            return True, self._count(id_, now)

        taken, made = self._turn(id_, True, step)
        if made:
            self._prune(now)
        return taken

    def forgive(self, key: str) -> None:
        """Takes back one counted try, for one that turned out right."""
        now = self._clock()
        id_ = self._id(key, now)

        def step() -> None:
            entry = self._entry(id_, now)
            if entry is not None and entry["count"] > 0:
                entry["count"] -= 1
                self._save(id_, entry)

        self._turn(id_, False, step)

    def fail(self, key: str, now: int) -> None:
        id_ = self._id(key, now)
        if self._turn(id_, True, lambda: self._count(id_, now)):
            self._prune(now)

    def _count(self, id_: str, now: int) -> bool:
        """Counts a try, and says whether that made a new entry."""
        entry = self._entry(id_, now)
        if entry is None:
            self._save(id_, {"count": 1, "until": now + self.window_ms})
            return True
        entry["count"] += 1
        self._save(id_, entry)
        return False

    def _drop(self, key: str, value: str) -> None:
        """Deletes an entry only if it still holds what was read, so a try counted since is never lost."""
        self.store.db.run('DELETE FROM rl_settings WHERE "key" = ? AND value = ?', [key, value])

    def _prune(self, now: int) -> None:
        """Expired entries go first, then those with the fewest tries, oldest first, down to nine tenths of the
        ceiling so this runs seldom. A flood of made-up names has one try each, so it cannot wipe out a block,
        or the count of a name someone is close to blocking. Run when a new entry is made, since only then can
        there be more."""
        entries = []
        for setting in self.store.settings_starting_with(self._prefix()):
            ok, entry = _js.try_loads(setting["value"])
            until = int(_js.number(entry.get("until", 0))) if ok and isinstance(entry, dict) else 0
            if until <= now:
                self._drop(setting["key"], setting["value"])
                continue
            count = int(_js.number(entry.get("count", 0))) if isinstance(entry, dict) else 0
            entries.append({"key": setting["key"], "value": setting["value"], "until": until, "count": count})
        if len(entries) <= MAX_THROTTLED:
            return
        # Each entry's window started window_ms before its end, so the earliest end is the oldest.
        entries.sort(key=lambda e: (e["count"], e["until"]))
        for entry in entries[: len(entries) - MAX_THROTTLED * 9 // 10]:
            self._drop(entry["key"], entry["value"])

    def clear(self, key: str) -> None:
        self.store.set_setting(self._prefix() + self._id(key, self._clock()), None)

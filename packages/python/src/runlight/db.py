"""The little a store needs from a database, for SQLite, Postgres, and MySQL or MariaDB.

SQL uses `?` placeholders on every dialect and is written for SQLite and Postgres. Each driver does per
connection what the TypeScript drivers do (stores/sqlite.ts, stores/postgres.ts, and stores/mysql.ts). A
connection is opened on first use, so a request that reads nothing never connects.

SQLite keeps one connection, shared by every thread under a lock, as better-sqlite3 has one. Postgres and
MySQL keep a pool of up to ten connections, as pg and mysql2 do: each statement borrows one and gives it back,
and a transaction or a lock keeps one on its thread until it ends, so a WSGI server's threads share a few
connections rather than each opening its own.
"""

from __future__ import annotations

import decimal
import inspect
import math
import os
import re
import sys
import threading
import time
import urllib.parse
from collections.abc import Callable, Sequence
from typing import Any, Protocol, TypeVar

from . import _js

T = TypeVar("T")

# Arbitrary but fixed, so every Runlight process takes the same lock to create tables.
MIGRATION_LOCK = 7_331_906

# One lock per MySQL database, so installs sharing a server do not wait on each other. Lock names are 64
# characters at most.
_MYSQL_LOCK = "CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48))"

# The longest a process waits for another one creating or upgrading the tables before it gives up.
LOCK_WAIT_MS = 30_000

_lock_wait = LOCK_WAIT_MS


def lock_wait_ms() -> int:
    """How long the stores wait for the lock for creating tables: LOCK_WAIT_MS, unless a test has set another."""
    return _lock_wait


def lock_wait_in_tests(ms: int | None) -> None:
    """For tests: the stores wait this long for the lock instead, or LOCK_WAIT_MS again with None."""
    global _lock_wait
    _lock_wait = LOCK_WAIT_MS if ms is None else ms


class TablesBusyError(Exception):
    """Another process held the lock for creating tables past LOCK_WAIT_MS, such as one building an index on a big
    table after an upgrade. The request that waited fails with this, rather than waiting for good."""

    def __init__(self, waited: int = LOCK_WAIT_MS) -> None:
        super().__init__(
            f"Runlight: another process is creating or upgrading the tables, and had not finished after {_js.js_round(waited / 1000)} seconds. Try again in a minute."
        )
        self.name = "TablesBusyError"


class Db(Protocol):
    """Rows come back as dicts keyed by column name. Numbers may arrive as text from some drivers, so the store
    casts what it reads, as the TypeScript store does."""

    def dialect(self) -> str:
        """"sqlite", "postgres", or "mysql"."""
        ...

    def all(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]: ...

    def run(self, sql: str, params: Sequence[Any] = ()) -> None: ...

    def transaction(self, fn: Callable[[Db], T]) -> T:
        """Runs `fn` in one transaction, committed when it returns and rolled back when it raises. A transaction
        already open is joined, not nested."""
        ...

    def exclusive(self, fn: Callable[[Db], T]) -> T:
        """Runs `fn` while holding a database-wide lock, so two processes starting at once do not race to create
        the same tables, and changes to accounts take turns across threads and processes."""
        ...

    def close(self) -> None: ...


def _value(value: Any) -> Any:
    """A value read from a driver as the store reads it: a decimal as a number."""
    if isinstance(value, decimal.Decimal):
        if value == value.to_integral_value():
            return int(value)
        return float(value)
    if isinstance(value, memoryview):
        return bytes(value)
    return value


def _pg_param(value: Any) -> Any:
    """A value sent to Postgres as pg sends it: as text of no stated type, which the server reads as the column
    or operator needs."""
    if value is None or isinstance(value, bytes):
        return value
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _js.number_text(value)
    return _js.well_formed(str(value))


def _param(value: Any) -> Any:
    """A value bound into a statement: a whole float as an int, so every database reads back the same number."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, float):
        return _js.whole(value)
    if isinstance(value, str):
        return _js.well_formed(value)
    return value


# How long a statement waits for a connection from a busy pool, in seconds, as the TypeScript pools wait.
POOL_WAIT = 10.0


class _Local(threading.local):
    # The connection a transaction or a lock holds on this thread, and whether it was left unfit for the pool.
    conn: Any = None
    broken: bool = False
    depth: int = 0


def _close_quietly(conn: Any) -> None:
    try:
        conn.close()
    except Exception:
        pass


class _BaseDb:
    _dialect = ""

    def __init__(self) -> None:
        self._lock = threading.RLock()

    def dialect(self) -> str:
        return self._dialect

    def affected(self, sql: str, params: Sequence[Any] = ()) -> int:
        """Runs an UPDATE or DELETE and says how many rows it matched. The store asks this of MySQL, which has
        no RETURNING."""
        raise NotImplementedError


def _owner_and_group(path: str, mode: int) -> None:
    """A database file just made is for its owner and group alone (0660), whatever the umask, and so is a folder
    made for it (0770): the visits in it are nobody else's to read, and a scheduled job running as another user of
    the same group can still write to it. SQLite gives the -wal and -shm files it makes later the same mode as the
    file. Systems without such modes ignore it."""
    try:
        os.chmod(path, mode)
    except OSError:
        # Not a file this process may change, or a system with no such modes.
        pass


class SqliteDb(_BaseDb):
    """SQLite through the standard library's sqlite3, with the pragmas stores/sqlite.ts sets: WAL, NORMAL
    synchronous, and a five second busy timeout."""

    _dialect = "sqlite"

    def __init__(self, path: str | Callable[[], Any], owned: bool = True) -> None:
        super().__init__()
        self._path = path
        self._conn: Any = None
        self._owned = owned
        self._depth = 0

    def connection(self) -> Any:
        if self._conn is None:
            import sqlite3

            if callable(self._path):
                conn = self._path()
            else:
                path = self._path
                made = False
                # A file in a folder that is not there yet gets the folder, as a fresh app's data/ often is.
                if path not in ("", ":memory:") and not path.startswith("file:"):
                    folder = os.path.dirname(path)
                    if folder and not os.path.isdir(folder):
                        os.makedirs(folder, exist_ok=True)
                        _owner_and_group(folder, 0o770)
                    made = not os.path.exists(path)
                conn = sqlite3.connect(
                    path, timeout=5, isolation_level=None, check_same_thread=False, uri=path.startswith("file:")
                )
                if made:
                    _owner_and_group(path, 0o660)
                conn.execute("PRAGMA journal_mode = WAL")
                conn.execute("PRAGMA synchronous = NORMAL")
                conn.execute("PRAGMA busy_timeout = 5000")
                # Deleted rows, such as a day's salt once it is gone, are overwritten where that costs no extra
                # writes, so they do not linger in the file's free space.
                conn.execute("PRAGMA secure_delete = FAST")
            conn.isolation_level = None
            self._conn = conn
        return self._conn

    def all(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        with self._lock:
            cursor = self.connection().execute(sql, [_param(p) for p in params])
            if cursor.description is None:
                return []
            names = [d[0] for d in cursor.description]
            return [dict(zip(names, row, strict=False)) for row in cursor.fetchall()]

    def run(self, sql: str, params: Sequence[Any] = ()) -> None:
        with self._lock:
            self.connection().execute(sql, [_param(p) for p in params])

    def affected(self, sql: str, params: Sequence[Any] = ()) -> int:
        with self._lock:
            return int(self.connection().execute(sql, [_param(p) for p in params]).rowcount)

    def transaction(self, fn: Callable[[Any], T]) -> T:
        with self._lock:
            if self._depth > 0:
                return fn(self)
            conn = self.connection()
            conn.execute("BEGIN IMMEDIATE")
            self._depth += 1
            try:
                result = fn(self)
            except BaseException:
                self._depth = 0
                try:
                    conn.execute("ROLLBACK")
                except Exception:
                    pass
                raise
            self._depth -= 1
            conn.execute("COMMIT")
            return result

    def exclusive(self, fn: Callable[[Any], T]) -> T:
        # A transaction begun IMMEDIATE takes the file's write lock at once, so another connection's turn, in this
        # process or any other, waits until this one is done: a code or a link read and crossed off in one turn
        # cannot also pass in another worker's.
        return self.transaction(fn)

    def close(self) -> None:
        with self._lock:
            if self._conn is not None and self._owned:
                try:
                    self._conn.close()
                except Exception:
                    pass
                self._conn = None


def number_placeholders(sql: str) -> str:
    """`?` placeholders to `$1, $2, ...`, leaving quoted text alone."""
    out = []
    n = 0
    quote = None
    for ch in sql:
        if quote:
            if ch == quote:
                quote = None
            out.append(ch)
        elif ch in ("'", '"'):
            quote = ch
            out.append(ch)
        elif ch == "?":
            n += 1
            out.append(f"${n}")
        else:
            out.append(ch)
    return "".join(out)


def mysql_text(sql: str, params: Sequence[Any] | None = None, escape: Callable[[Any], str] | None = None) -> str:
    """SQL written for SQLite and Postgres, as MySQL and MariaDB read it: a "quoted" identifier is quoted with
    backticks, and a backslash inside 'text' is doubled. With `params`, each `?` outside quotes becomes its value
    through `escape`, as mysql2 fills them in; without, the placeholders stay."""
    out = []
    n = 0
    quote = None
    esc = escape or mysql_escape
    for ch in sql:
        if quote is not None:
            if ch == quote:
                quote = None
                out.append("`" if ch == '"' else ch)
            elif quote == "'" and ch == "\\":
                out.append("\\\\")
            elif quote == '"' and ch == "`":
                out.append("``")
            else:
                out.append(ch)
        elif ch in ("'", '"', "`"):
            quote = ch
            out.append("`" if ch == '"' else ch)
        elif ch == "?" and params is not None:
            if n >= len(params):
                raise ValueError("Runlight: a statement has more placeholders than values")
            out.append(esc(params[n]))
            n += 1
        else:
            out.append(ch)
    if params is not None and n != len(params):
        raise ValueError("Runlight: a statement has more values than placeholders")
    return "".join(out)


_MYSQL_ESCAPES = {"\0": "\\0", "\x08": "\\b", "\t": "\\t", "\x1a": "\\Z", "\n": "\\n", "\r": "\\r", '"': '\\"', "'": "\\'", "\\": "\\\\"}
_MYSQL_ESCAPE = re.compile("[\0\x08\t\x1a\n\r\"'\\\\]")


def mysql_escape(value: Any) -> str:
    """A value as a MySQL literal, as mysql2's escape() writes the values Runlight binds."""
    if value is None:
        return "NULL"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _js.number_text(value)
    if isinstance(value, bytes):
        return "X'" + value.hex() + "'"
    text = _js.well_formed(str(value))
    return "'" + _MYSQL_ESCAPE.sub(lambda m: _MYSQL_ESCAPES[m.group(0)], text) + "'"


def _lost(error: BaseException) -> bool:
    """Whether an error says the connection is gone, rather than that the statement failed."""
    state = str(getattr(getattr(error, "diag", None), "sqlstate", "") or getattr(error, "sqlstate", "") or "")
    code = error.args[0] if error.args and isinstance(error.args[0], int) else 0
    return (
        state.startswith("08")
        or state in ("57P01", "57P02", "57P03")
        or code in (2006, 2013, 4031)
        or bool(
            re.search(
                r"server has gone away|lost connection|server closed the connection|no connection to the server|"
                r"terminating connection|connection is closed|the connection is lost",
                str(error),
                re.I,
            )
        )
    )


class _NetworkDb(_BaseDb):
    """A pool of connections, for Postgres and MySQL, as pg and mysql2 keep one: a statement borrows a connection
    and gives it back, and a transaction or a lock keeps one on its thread until it ends. At most `max` are open
    at once, so a server's threads share them rather than each keeping its own for good, and a busy pool is waited
    on for at most ten seconds."""

    def __init__(self, connect: Callable[[], Any] | None, conn: Any = None, max: int = 10) -> None:  # noqa: A002
        super().__init__()
        if max < 1:
            raise ValueError("Runlight: the database pool needs at least one connection")
        self._connect = connect
        self._given = conn
        self._local = _Local()
        self._slots = threading.BoundedSemaphore(max)
        self._idle: list[Any] = []
        # Which close() each open connection was opened after; one opened before the latest is not pooled again.
        self._generation = 0
        self._born: dict[int, int] = {}

    def _acquire(self) -> Any:
        if self._connect is None:
            raise RuntimeError("Runlight: the database connection is closed")
        if not self._slots.acquire(timeout=POOL_WAIT):
            raise RuntimeError(f"Runlight: no database connection came free within {POOL_WAIT:g} seconds")
        try:
            with self._lock:
                if self._idle:
                    return self._idle.pop()
                generation = self._generation
            conn = self._connect()
            with self._lock:
                self._born[id(conn)] = generation
            return conn
        except BaseException:
            self._slots.release()
            raise

    def _release(self, conn: Any, broken: bool) -> None:
        with self._lock:
            keep = not broken and self._born.get(id(conn)) == self._generation
            if keep:
                self._idle.append(conn)
            else:
                self._born.pop(id(conn), None)
        if not keep:
            _close_quietly(conn)
        self._slots.release()

    def _drop_idle(self) -> None:
        with self._lock:
            idle, self._idle = self._idle, []
            for conn in idle:
                self._born.pop(id(conn), None)
        for conn in idle:
            _close_quietly(conn)

    def connection(self) -> Any:
        """The app's own connection, or the one this thread's transaction or lock holds."""
        if self._given is not None:
            return self._given
        if self._local.conn is None:
            raise RuntimeError("Runlight: no database connection is held on this thread")
        return self._local.conn

    def _pinned(self, fn: Callable[[Any], T]) -> T:
        """Runs fn(conn) with a connection kept on this thread until it returns, for a transaction or a lock. One
        already kept is used again."""
        local = self._local
        if self._given is not None:
            return fn(self._given)
        if local.conn is not None:
            return fn(local.conn)
        conn = self._acquire()
        local.conn = conn
        local.broken = False
        try:
            return fn(conn)
        finally:
            broken = local.broken
            local.conn = None
            local.broken = False
            self._release(conn, broken)

    def _discard(self) -> None:
        """Marks the connection this thread holds as left in a state it could not undo, so it is closed rather than
        pooled again."""
        if self._given is None and self._local.conn is not None:
            self._local.broken = True

    def _borrowed(self, sql: str, params: Sequence[Any], fetch: bool | None) -> Any:
        conn = self._acquire()
        broken = True
        try:
            result = self._attempt(conn, sql, params, fetch)
            broken = False
            return result
        except Exception as error:
            broken = _lost(error)
            raise
        finally:
            self._release(conn, broken)

    def _execute(self, sql: str, params: Sequence[Any], fetch: bool | None) -> Any:
        if self._given is not None or self._local.conn is not None:
            # Inside a transaction or a lock, whose work would go with a lost connection, there is no second try.
            return self._attempt(self.connection(), sql, params, fetch)
        try:
            return self._borrowed(sql, params, fetch)
        except Exception as error:
            # A connection the server dropped (a restart, a failover, an idle timeout) is replaced, as a pool
            # replaces it, and the statement sent again: it never reached the server.
            if not _lost(error):
                raise
            name = "MySQL" if self._dialect == "mysql" else "Postgres"
            print(f"Runlight: a {name} connection was lost; it reconnects on the next query. {error}", file=sys.stderr)
            # Those idle beside it were most likely dropped too.
            self._drop_idle()
            return self._borrowed(sql, params, fetch)

    def _attempt(self, conn: Any, sql: str, params: Sequence[Any], fetch: bool | None) -> Any:
        raise NotImplementedError

    def all(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        return self._execute(sql, params, True)

    def run(self, sql: str, params: Sequence[Any] = ()) -> None:
        self._execute(sql, params, False)

    def affected(self, sql: str, params: Sequence[Any] = ()) -> int:
        return int(self._execute(sql, params, None))

    def _begin(self, conn: Any) -> None:
        raise NotImplementedError

    def transaction(self, fn: Callable[[Any], T]) -> T:
        if self._local.depth > 0:
            return fn(self)
        return self._pinned(lambda conn: self._transaction(conn, fn))

    def _transaction(self, conn: Any, fn: Callable[[Any], T]) -> T:
        local = self._local
        self._begin(conn)
        local.depth += 1
        try:
            result = fn(self)
        except BaseException:
            local.depth = 0
            try:
                self._raw(conn, "ROLLBACK")
            except Exception:
                # A connection still in its transaction must never be used again.
                self._discard()
            raise
        local.depth -= 1
        try:
            self._raw(conn, "COMMIT")
        except BaseException:
            try:
                self._raw(conn, "ROLLBACK")
            except Exception:
                self._discard()
            raise
        return result

    def _raw(self, conn: Any, sql: str) -> Any:
        raise NotImplementedError

    def exclusive(self, fn: Callable[[Any], T]) -> T:
        return self._pinned(lambda conn: self._locked(conn, fn))

    def _locked(self, conn: Any, fn: Callable[[Any], T]) -> T:
        raise NotImplementedError

    def close(self) -> None:
        """Closes the idle connections; those in use close when they are given back."""
        if self._given is not None:
            return
        with self._lock:
            self._generation += 1
        self._drop_idle()


class PostgresDb(_NetworkDb):
    """Postgres through psycopg 3, with `$n` placeholders as pg numbers them (stores/postgres.ts)."""

    _dialect = "postgres"

    def __init__(self, connect: Callable[[], Any] | None = None, conn: Any = None, max: int = 10) -> None:  # noqa: A002
        super().__init__(connect, conn, max)
        self._texts: dict[str, str] = {}

    def _text(self, sql: str) -> str:
        text = self._texts.get(sql)
        if text is None:
            text = number_placeholders(sql)
            if len(self._texts) < 500:
                self._texts[sql] = text
        return text

    def _attempt(self, conn: Any, sql: str, params: Sequence[Any], fetch: bool | None) -> Any:
        with conn.cursor() as cursor:
            cursor.execute(self._text(sql), [_pg_param(p) for p in params])
            if fetch is None:
                return cursor.rowcount
            if not fetch or cursor.description is None:
                return None
            names = [d.name for d in cursor.description]
            return [{n: _value(v) for n, v in zip(names, row, strict=False)} for row in cursor.fetchall()]

    def _raw(self, conn: Any, sql: str) -> Any:
        with conn.cursor() as cursor:
            cursor.execute(sql)

    def _begin(self, conn: Any) -> None:
        self._raw(conn, "BEGIN")

    def _locked(self, conn: Any, fn: Callable[[Any], T]) -> T:
        # Asked for again and again rather than waited on: a waiting statement would hold up an index being
        # built CONCURRENTLY by whoever has the lock, and the two would wait on each other for good.
        # Up to LOCK_WAIT_MS, so a request does not wait on a long index build for good.
        wait = lock_wait_ms()
        until = time.monotonic() + wait / 1000
        while not (self.all("SELECT pg_try_advisory_lock(?) AS ok", [MIGRATION_LOCK])[0].get("ok")):
            if time.monotonic() >= until:
                raise TablesBusyError(wait)
            time.sleep(0.1)
        try:
            return fn(self)
        finally:
            try:
                self.run("SELECT pg_advisory_unlock(?)", [MIGRATION_LOCK])
            except Exception:
                # A lost connection ends its session, and the lock with it.
                pass


class MysqlDb(_NetworkDb):
    """MySQL 8.0.20 or MariaDB 11.4 and later through PyMySQL. Each statement goes through mysql_text() first, with
    its values written in on the client, as mysql2 fills them in."""

    _dialect = "mysql"

    def __init__(
        self, connect: Callable[[], Any] | None = None, conn: Any = None, statement_timeout: int = 0, max: int = 10  # noqa: A002
    ) -> None:
        super().__init__(connect, conn, max)
        self._statement_timeout = statement_timeout
        self._mariadb: bool | None = None
        # An app's own connection too.
        if conn is not None:
            backslash_escapes_on(conn)

    def _attempt(self, conn: Any, sql: str, params: Sequence[Any], fetch: bool | None) -> Any:
        text = mysql_text(sql, [_param(p) for p in params])
        with conn.cursor() as cursor:
            count = cursor.execute(text)
            if fetch is None:
                return count
            if not fetch or cursor.description is None:
                return None
            names = [d[0] for d in cursor.description]
            return [{n: _value(v) for n, v in zip(names, row, strict=False)} for row in cursor.fetchall()]

    def _raw(self, conn: Any, sql: str) -> Any:
        with conn.cursor() as cursor:
            cursor.execute(sql)
            return cursor.fetchall()

    def _begin(self, conn: Any) -> None:
        # As Postgres does by default: each statement sees what was committed before it began, and InnoDB takes
        # no gap locks, so two writers to neighbouring rows do not deadlock.
        self._raw(conn, "SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
        self._raw(conn, "START TRANSACTION")

    def limit_statements(self, conn: Any, ms: int) -> None:
        """MySQL's statement timeout as a session setting, which MySQL and MariaDB name differently. MariaDB
        counts seconds and applies it to every statement; MySQL counts milliseconds and applies it to reads."""
        if self._mariadb is None:
            self._mariadb = is_mariadb(conn)
        _set_timeout(conn, ms, self._mariadb)

    def _locked(self, conn: Any, fn: Callable[[Any], T]) -> T:
        # Up to LOCK_WAIT_MS, so a request does not wait on a long index build for good.
        wait = lock_wait_ms()
        until = time.monotonic() + wait / 1000
        while True:
            left = max(1, min(5, math.ceil(until - time.monotonic())))
            rows = self._raw(conn, f"SELECT GET_LOCK({_MYSQL_LOCK}, {left}) AS ok")
            ok = rows[0][0] if rows else None
            if ok is None:
                raise RuntimeError("Runlight: MySQL refused the lock for creating tables")
            if int(ok) == 1:
                break
            # Not got in time: another process is creating the tables. Ask again, until the wait is up.
            if time.monotonic() >= until:
                raise TablesBusyError(wait)
        try:
            # An index on a big table takes a while to build, so the build may run past the statement timeout.
            if self._statement_timeout > 0:
                self.limit_statements(conn, 0)
            result = fn(self)
            if self._statement_timeout > 0:
                self.limit_statements(conn, self._statement_timeout)
            return result
        except BaseException:
            # The session may be left without its statement timeout, so the connection goes.
            try:
                self._raw(conn, f"DO RELEASE_LOCK({_MYSQL_LOCK})")
            except Exception:
                pass
            self._discard()
            raise
        finally:
            if not self._local.broken:
                try:
                    # A lost connection ends its session, and the lock with it.
                    self._raw(conn, f"DO RELEASE_LOCK({_MYSQL_LOCK})")
                except Exception:
                    pass


# The session's sql_mode as it was, less NO_BACKSLASH_ESCAPES, wherever it sits in the list.
_NO_BACKSLASH_ESCAPES_OFF = (
    "SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',NO_BACKSLASH_ESCAPES,', ','))"
)


def backslash_escapes_on(conn: Any) -> None:
    """Values are written in with backslash escapes, which a server set to NO_BACKSLASH_ESCAPES reads as text, so a
    quote could end the value early. Every connection drops that one mode."""
    with conn.cursor() as cursor:
        cursor.execute(_NO_BACKSLASH_ESCAPES_OFF)


def is_mariadb(conn: Any) -> bool:
    with conn.cursor() as cursor:
        cursor.execute("SELECT VERSION() AS v")
        return "mariadb" in str(cursor.fetchone()[0]).lower()


def _set_timeout(conn: Any, ms: int, mariadb: bool) -> None:
    with conn.cursor() as cursor:
        if mariadb:
            cursor.execute(f"SET SESSION max_statement_time = {_js.number_text(ms / 1000)}")
        else:
            cursor.execute(f"SET SESSION max_execution_time = {int(ms)}")


# Table prefixes

# What every table and index name starts with, unless a store is given another prefix in its place.
PREFIX = "rl_"

# Runlight's tables, after the prefix: the store's, and the sign-in accounts' two. An app dropping Runlight's tables
# drops these by name, never every table that starts with the prefix.
TABLES = (
    "meta", "sites", "salts", "sessions", "events", "links", "link_domains", "shares", "goals", "settings",
    "reports", "tokens", "funnels", "rollup_days", "rollups", "users", "invites",
)  # fmt: skip

# A name in a statement, and short enough that the longest index name stays inside MySQL's 64.
_PREFIX = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,31}\Z")
_NAMED = re.compile(r"\brl_(?=[a-z])")


class PrefixedDb:
    """A Db whose tables and indexes start with `prefix` in place of `rl_`, such as `wp_rl_` inside WordPress, so two
    apps sharing one database each keep a set of their own. Runlight's SQL names every table and index `rl_` and
    something, and those names alone are rewritten on the way through, in each statement and in the names a schema
    check compares as text. A store given a prefix puts one in front of its Db, so the accounts and importers that
    reach the Db through the store follow it too."""

    def __init__(self, inner: Any, prefix: str) -> None:
        if not isinstance(prefix, str) or not _PREFIX.match(prefix):
            raise ValueError("Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit")
        self.inner = inner
        self.prefix = prefix
        if hasattr(inner, "metered"):
            self.metered = inner.metered

    def _sql(self, text: str) -> str:
        return _NAMED.sub(lambda _m: self.prefix, text)

    def _wrap(self, db: Any) -> Any:
        return self if db is self.inner else PrefixedDb(db, self.prefix)

    def dialect(self) -> str:
        return self.inner.dialect()

    def all(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        return self.inner.all(self._sql(sql), params)

    def run(self, sql: str, params: Sequence[Any] = ()) -> None:
        self.inner.run(self._sql(sql), params)

    def affected(self, sql: str, params: Sequence[Any] = ()) -> int:
        return self.inner.affected(self._sql(sql), params)

    def transaction(self, fn: Callable[[Any], T]) -> T:
        return self.inner.transaction(lambda db: fn(self._wrap(db)))

    def exclusive(self, fn: Callable[[Any], T]) -> T:
        return self.inner.exclusive(lambda db: fn(self._wrap(db)))

    def close(self) -> None:
        self.inner.close()


def prefixed(inner: Any, prefix: str) -> PrefixedDb:
    """A Db whose tables and indexes start with `prefix` in place of `rl_`. See PrefixedDb."""
    return PrefixedDb(inner, prefix)


# Opening connections


def _parts(url: str) -> dict[str, Any]:
    parsed = urllib.parse.urlsplit(url)
    if not parsed.hostname:
        raise ValueError("Runlight: the database URL could not be read")
    return {
        "host": parsed.hostname,
        "port": parsed.port or 0,
        "user": urllib.parse.unquote(parsed.username) if parsed.username is not None else None,
        "password": urllib.parse.unquote(parsed.password) if parsed.password is not None else None,
        "database": urllib.parse.unquote(parsed.path.lstrip("/")),
        "query": dict(urllib.parse.parse_qsl(parsed.query)),
    }


def _option(value: str) -> str:
    """A value inside libpq's `options`, where a space or backslash is escaped with a backslash."""
    return re.sub(r"([\\\s'])", r"\\\1", value)


# TLS settings in a database URL. Anything else whose name starts with "ssl" is refused, never dropped, so a URL
# that asks for an encrypted connection never quietly gets a plain one.

# libpq's own, passed to it as they are.
_PG_TLS = (
    "sslmode",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "sslpassword",
    "sslcrl",
    "sslcrldir",
    "sslsni",
    "sslcompression",
    "sslcertmode",
    "sslnegotiation",
    "ssl_min_protocol_version",
    "ssl_max_protocol_version",
)


def _yes_no(name: str, value: str) -> bool:
    lowered = value.strip().lower()
    if lowered in ("true", "1", "yes", "on"):
        return True
    if lowered in ("false", "0", "no", "off"):
        return False
    raise ValueError(f"Runlight: the database URL's {name}={value} is not true or false")


def postgres_tls(query: dict[str, str]) -> dict[str, str]:
    """The libpq settings for a Postgres URL's TLS parameters. libpq's own go through as they are; the two that
    pg, the TypeScript driver, also reads are put in libpq's words: ssl=true (verify the server against the
    system's certificates) and sslmode=no-verify (encrypt, verify nothing). A sslmode of its own wins over ssl."""
    for name in query:
        if name not in _PG_TLS and name != "ssl" and name.lower().startswith("ssl"):
            raise ValueError(f"Runlight: the database URL's {name} is not a setting Runlight knows for Postgres")
    out = {name: value for name, value in query.items() if name in _PG_TLS}
    if "ssl" in query:
        on = _yes_no("ssl", query["ssl"])
        if "sslmode" not in out:
            out["sslmode"] = "verify-full" if on else "disable"
            if on:
                out.setdefault("sslrootcert", "system")
    if out.get("sslmode") == "no-verify":
        out["sslmode"] = "require"
    return out


def mysql_tls(query: dict[str, str]) -> dict[str, Any]:
    """PyMySQL's settings for a MySQL URL's TLS parameters: ssl (true, false, or mysql2's JSON with
    rejectUnauthorized), ssl-mode (DISABLED, PREFERRED, REQUIRED, VERIFY_CA, or VERIFY_IDENTITY, or libpq's
    disable, prefer, require, verify-ca, and verify-full), sslaccept (strict or accept_invalid_certs), and the
    files: ssl-ca (or sslrootcert), ssl-cert, and ssl-key. Names may use dashes or underscores. A CA file on its
    own verifies the server, as mysql2 does with one."""
    import ssl as _ssl

    mode: str | None = None
    files: dict[str, str] = {}
    for given, value in query.items():
        name = given.lower().replace("-", "_")
        if not name.startswith("ssl"):
            continue
        if name == "ssl":
            text = value.strip()
            if text.startswith("{"):
                ok, options = _js.try_loads(text)
                if not ok or not isinstance(options, dict) or any(k != "rejectUnauthorized" for k in options):
                    raise ValueError("Runlight: the database URL's ssl={...} may only hold rejectUnauthorized")
                mode = "verify_identity" if options.get("rejectUnauthorized", True) is not False else "required"
            else:
                mode = "verify_identity" if _yes_no(given, value) else "disabled"
        elif name in ("ssl_mode", "sslmode"):
            mode = {
                "disabled": "disabled",
                "disable": "disabled",
                "preferred": "preferred",
                "prefer": "preferred",
                "required": "required",
                "require": "required",
                "verify_ca": "verify_ca",
                "verify-ca": "verify_ca",
                "verify_identity": "verify_identity",
                "verify-full": "verify_identity",
            }.get(value.strip().lower())
            if mode is None:
                raise ValueError(f"Runlight: the database URL's {given}={value} is not a TLS mode MySQL has")
        elif name == "sslaccept":
            accept = {"strict": "verify_identity", "accept_invalid_certs": "required"}.get(value.strip().lower())
            if accept is None:
                raise ValueError(f"Runlight: the database URL's {given}={value} is not strict or accept_invalid_certs")
            mode = accept
        elif name in ("ssl_ca", "sslca", "sslrootcert"):
            files["ca"] = value
        elif name in ("ssl_cert", "sslcert"):
            files["cert"] = value
        elif name in ("ssl_key", "sslkey"):
            files["key"] = value
        else:
            raise ValueError(f"Runlight: the database URL's {given} is not a setting Runlight knows for MySQL")
    if mode is None and files:
        mode = "verify_identity"
    if mode is None or mode == "preferred":
        # The driver's own default.
        return {}
    if mode == "disabled":
        return {"ssl_disabled": True}
    context = _ssl.create_default_context(cafile=files.get("ca"))
    if mode == "required":
        context.check_hostname = False
        context.verify_mode = _ssl.CERT_NONE
    elif mode == "verify_ca":
        context.check_hostname = False
    if "cert" in files:
        context.load_cert_chain(files["cert"], keyfile=files.get("key"))
    return {"ssl": context}


def sqlite(path: str) -> SqliteDb:
    """A SQLite file, or ":memory:", with the pragmas stores/sqlite.ts sets."""
    return SqliteDb(path)


def postgres(url: str, statement_timeout: int = 120_000, schema: str | None = None, max: int = 10) -> PostgresDb:  # noqa: A002
    """Postgres from a URL like postgres://user:pass@host:5432/db?sslmode=verify-full, with libpq's TLS settings
    (postgres_tls() lists them). `statement_timeout` stops any
    one statement after that many milliseconds; 0 turns it off. `schema`, when given, is the search path. `max`
    is the most connections open at once."""
    try:
        import psycopg
    except ImportError:  # pragma: no cover
        raise ImportError('Runlight: the Postgres store needs psycopg 3. Install it with pip install "runlight[postgres]"') from None

    parts = _parts(url)
    tls = postgres_tls(parts["query"])

    def connect() -> Any:
        options = [parts["query"]["options"]] if "options" in parts["query"] else []
        if statement_timeout > 0:
            options.append(f"-c statement_timeout={statement_timeout}")
        if schema is not None:
            options.append(f"-c search_path={_option(schema)}")
        kwargs: dict[str, Any] = {
            "host": parts["host"],
            "port": parts["port"] or 5432,
            "dbname": parts["database"],
            "autocommit": True,
            "cursor_factory": psycopg.RawCursor,
            # A connection waits at most 10 seconds for the server, as the pool waits for a connection.
            "connect_timeout": 10,
        }
        if parts["user"] is not None:
            kwargs["user"] = parts["user"]
        if parts["password"] is not None:
            kwargs["password"] = parts["password"]
        kwargs.update(tls)
        if options:
            kwargs["options"] = " ".join(options)
        return psycopg.connect(**kwargs)

    return PostgresDb(connect, max=max)


def mysql(url: str, statement_timeout: int = 120_000, max: int = 10) -> MysqlDb:  # noqa: A002
    """MySQL 8.0.20 or MariaDB 11.4 and later from a URL like mysql://user:pass@host:3306/db (or mariadb://), with
    the TLS settings mysql_tls() lists, such as ?ssl-mode=VERIFY_IDENTITY. The
    session is utf8mb4, with IGNORE_SPACE added to the server's SQL mode as mysql2 asks for it. Runlight's tables
    carry their own binary collation, so text compares and sorts by code point. `max` is the most connections
    open at once."""
    try:
        import pymysql
    except ImportError:  # pragma: no cover
        raise ImportError('Runlight: the MySQL store needs PyMySQL. Install it with pip install "runlight[mysql]"') from None

    parts = _parts(re.sub(r"^mariadb:", "mysql:", url, flags=re.I))
    tls = mysql_tls(parts["query"])
    # An older PyMySQL has no ssl_disabled, and never tries TLS unless asked to.
    if "ssl_disabled" in tls and "ssl_disabled" not in inspect.signature(pymysql.connect).parameters:
        tls = {}

    def connect() -> Any:
        conn = pymysql.connect(
            host=parts["host"],
            port=parts["port"] or 3306,
            user=parts["user"] or "",
            password=parts["password"] or "",
            database=parts["database"] or None,
            charset="utf8mb4",
            autocommit=True,
            connect_timeout=10,
            client_flag=pymysql.constants.CLIENT.IGNORE_SPACE,
            **tls,
        )
        try:
            backslash_escapes_on(conn)
        except BaseException:
            conn.close()
            raise
        if statement_timeout > 0:
            _set_timeout(conn, statement_timeout, is_mariadb(conn))
        return conn

    return MysqlDb(connect, statement_timeout=statement_timeout, max=max)


def from_url(url: str) -> SqliteDb | PostgresDb | MysqlDb:
    """Picks the database from a URL's scheme: sqlite:, file:, postgres:, postgresql:, mysql:, or mariadb:."""
    scheme = url.split(":", 1)[0].lower() if ":" in url else ""
    if scheme in ("postgres", "postgresql"):
        return postgres(url)
    if scheme in ("mysql", "mariadb"):
        return mysql(url)
    if scheme in ("sqlite", "file"):
        return sqlite(re.sub(r"^(sqlite|file):(//)?", "", url, flags=re.I))
    raise ValueError("Runlight: DATABASE_URL must start with postgres://, mysql://, mariadb://, or sqlite:")


def quote_name(name: str, quote: str) -> str:
    return quote + name.replace(quote, quote + quote) + quote

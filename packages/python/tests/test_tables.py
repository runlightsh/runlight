"""Runlight's tables under another prefix beside the plain ones, new SQLite files for their owner and group alone, and
the wait for another process creating the tables, which has a limit (tables.test.ts)."""

from __future__ import annotations

import os
import sys
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from support.databases import mysql_urls, pg_url
from support.routes import req

from runlight import _js
from runlight import core as rl_core
from runlight import db as dbs
from runlight.store import PREFIX, TABLES, SqlStore, Stores, TablesBusyError

MYSQL = next(iter(mysql_urls()), None)


def _names(db: Any) -> list[str]:
    """Every table and index name in the database, as each dialect lists them."""
    dialect = db.dialect()
    if dialect == "sqlite":
        sql = "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
    elif dialect == "postgres":
        sql = "SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'i', 'S')"
    else:
        sql = (
            "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() "
            "UNION SELECT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name <> 'PRIMARY'"
        )
    return sorted(_js.string(row.get("name", row.get("NAME", ""))) for row in db.all(sql))


@contextmanager
def _shared(databases: Any, kind: str, tmp_path: Path) -> Iterator[tuple[SqlStore, Callable[[], SqlStore]]]:
    """Two stores over one database, one with its tables under rl_ and one under wp_rl_."""
    opened: list[SqlStore] = []

    def open_(prefix: str = PREFIX) -> SqlStore:
        if kind == "sqlite":
            made = Stores.sqlite(str(tmp_path / "shared.db"), prefix=prefix)
        elif kind == "postgres":
            made = Stores.postgres(where, prefix=prefix)
        else:
            made = Stores.mysql(where, prefix=prefix)
        opened.append(made)
        return made

    where = "" if kind == "sqlite" else databases.url(kind)
    try:
        yield open_(), lambda: open_("wp_rl_")
    finally:
        for store in opened:
            store.close()


KINDS = [
    pytest.param("sqlite"),
    pytest.param("postgres", marks=pytest.mark.skipif(pg_url() is None, reason="RUNLIGHT_TEST_PG is not set")),
    pytest.param(MYSQL or "mysql", marks=pytest.mark.skipif(MYSQL is None, reason="RUNLIGHT_TEST_MYSQL is not set")),
]


@pytest.mark.parametrize("kind", KINDS)
def test_a_prefix_keeps_a_second_set_of_tables_beside_the_first_in_one_database(databases: Any, kind: str, tmp_path: Path) -> None:
    with _shared(databases, kind, tmp_path) as (plain, open_other):
        raw = plain.db
        other = open_other()
        other.migrate()
        # A second process with the same prefix finds every table and index already there.
        open_other().migrate()
        made = _names(raw)
        assert made != []
        assert [name for name in made if not name.startswith("wp_rl_")] == [], "every name is under the prefix"
        assert other.tables() == [f"wp_rl_{table}" for table in TABLES]
        assert [table for table in other.tables()[:15] if table not in made] == [], "the store's 15 tables, listed for removing them"

        plain.migrate()
        plain_names = [name for name in _names(raw) if name.startswith(PREFIX)]
        assert len([name for name in plain_names if name[len(PREFIX) :] in TABLES]) == 15

        def site(id: str) -> dict[str, Any]:
            return {"id": id, "name": id, "hostnames": [f"{id}.example"], "timezone": "UTC"}

        plain.upsert_site(site("first"), 1)
        other.upsert_site(site("second"), 1)
        assert [s["id"] for s in plain.sites()] == ["first"]
        assert [s["id"] for s in other.sites()] == ["second"]
        assert other.transaction(lambda tx: tx.sites()[0]["id"]) == "second", "a transaction keeps the prefix"
        other.set_setting("k", "wp")
        assert plain.setting("k") is None
        assert other.setting("k") == "wp"


def test_a_table_prefix_is_letters_digits_and_underscores_and_does_not_start_with_a_digit() -> None:
    for prefix in ["1rl_", "rl-", "rl_; DROP TABLE x", "", "a" * 33]:
        with pytest.raises(ValueError, match="a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit"):
            Stores.sqlite(":memory:", prefix=prefix)
    for prefix in ["rl_", "wp_rl_", "_x", "A" * 32]:
        assert Stores.sqlite(":memory:", prefix=prefix).prefix == prefix
    assert SqlStore(Stores.sqlite(":memory:", prefix="wp_rl_").db).prefix == "wp_rl_", "a store over a prefixed Db keeps its prefix"
    assert Stores.sqlite(":memory:").tables()[:2] == ["rl_meta", "rl_sites"]


def test_the_accounts_tables_follow_the_prefix(tmp_path: Path) -> None:
    from runlight.accounts.auth import Accounts

    store = Stores.sqlite(str(tmp_path / "accounts.db"), prefix="wp_rl_")
    store.migrate()
    Accounts(store, "s3cret").set_password("owner@example.com", "a long enough password", 1_791_288_000_000)
    names = _names(dbs.sqlite(str(tmp_path / "accounts.db")))
    assert "wp_rl_users" in names and "wp_rl_invites" in names
    assert [name for name in names if name.startswith("rl_")] == []
    store.close()


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has no such modes")
def test_a_new_sqlite_file_is_for_its_owner_and_group_alone_and_so_are_the_files_sqlite_makes_beside_it(tmp_path: Path) -> None:
    file = tmp_path / "data" / "mode.db"
    store = Stores.sqlite(str(file))
    store.migrate()
    store.set_setting("k", "v")
    assert file.stat().st_mode & 0o777 == 0o660
    assert Path(f"{file}-wal").exists()
    assert Path(f"{file}-wal").stat().st_mode & 0o777 == 0o660
    assert file.parent.stat().st_mode & 0o777 == 0o770, "and so is the folder made for it"
    store.close()
    # A file that was there already keeps its mode.
    os.chmod(file, 0o640)
    again = Stores.sqlite(str(file))
    again.migrate()
    assert file.stat().st_mode & 0o777 == 0o640
    again.close()


class _Held:
    """A Db whose lock for creating tables another process holds: exclusive() waits until it is let go, then either
    gives up as a store does after its wait (busy) or goes ahead."""

    def __init__(self) -> None:
        self.inner = dbs.sqlite(":memory:")
        self.released = threading.Event()
        self.busy = False

    def dialect(self) -> str:
        return "sqlite"

    def all(self, sql: str, params: Any = ()) -> list[dict[str, Any]]:
        return self.inner.all(sql, params)

    def run(self, sql: str, params: Any = ()) -> None:
        self.inner.run(sql, params)

    def affected(self, sql: str, params: Any = ()) -> int:
        return self.inner.affected(sql, params)

    def transaction(self, fn: Callable[[Any], Any]) -> Any:
        return self.inner.transaction(lambda _db: fn(self))

    def exclusive(self, fn: Callable[[Any], Any]) -> Any:
        self.released.wait()
        if self.busy:
            raise TablesBusyError()
        return self.inner.exclusive(lambda _db: fn(self))

    def close(self) -> None:
        self.inner.close()


def test_a_tracker_hit_waits_a_moment_at_most_while_another_process_creates_the_tables(monkeypatch: pytest.MonkeyPatch) -> None:
    # Ten seconds in the SDK; shorter here.
    monkeypatch.setattr(rl_core, "TRACKER_WAIT_MS", 500)
    db = _Held()
    rl = rl_core.Runlight(store=SqlStore(db), site={"hostnames": ["example.com"]}, now=lambda: 1_791_288_000_000)
    routes = rl.routes(token="secret")
    started = time.monotonic()
    hit = routes.handle(
        req(
            "/runlight/e",
            "POST",
            {
                "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
                "x-forwarded-for": "203.0.113.1",
            },
            _js.dumps({"k": "pageview", "u": "https://example.com/", "i": "a1"}),
        )
    )
    assert hit.status == 202
    waited = time.monotonic() - started
    assert 0.45 <= waited < 2, f"the hit waited {waited:.2f}s"
    # The other process gives up the wait: the request that waited answers 503, saying why.
    answers: list[Any] = []
    asked = threading.Thread(target=lambda: answers.append(routes.handle(req("/runlight/api/stats?period=today", "GET", {"authorization": "Bearer secret"}))))
    asked.start()
    db.busy = True
    db.released.set()
    asked.join(10)
    answer = answers[0]
    assert answer.status == 503
    assert answer.headers.get("retry-after") == "30"
    assert _js.loads(answer.text()) == {"error": "Runlight is creating or upgrading its tables. Try again in a minute.", "code": "tables_busy"}
    # Once the tables are there, hits are counted again.
    db.busy = False
    rl.init()
    stats = _js.loads(routes.handle(req("/runlight/api/stats?period=today&compare=off", "GET", {"authorization": "Bearer secret"})).text())
    assert stats["stats"]["visitors"] == 0, "the hit that came while the tables were busy was dropped"


def test_a_ready_process_counts_a_hit_without_waiting() -> None:
    rl = rl_core.Runlight(store=Stores.sqlite(":memory:"), site={"hostnames": ["example.com"]}, now=lambda: 1_791_288_000_000)
    routes = rl.routes(token="secret")
    hit = req(
        "/runlight/e",
        "POST",
        {"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", "x-forwarded-for": "203.0.113.1"},
        _js.dumps({"k": "pageview", "u": "https://example.com/", "i": "a1"}),
    )
    assert routes.handle(hit).status == 202
    stats = _js.loads(routes.handle(req("/runlight/api/stats?period=today&compare=off", "GET", {"authorization": "Bearer secret"})).text())
    assert stats["stats"]["visitors"] == 1


@pytest.mark.skipif(pg_url() is None, reason="RUNLIGHT_TEST_PG is not set")
def test_postgres_waiting_for_another_process_creating_the_tables_gives_up_after_the_lock_wait(databases: Any) -> None:
    url = databases.url("postgres")
    # Another session, held on its own connection, so the lock stays where it was taken.
    other = dbs.postgres(pg_url() or "", max=1)
    dbs.lock_wait_in_tests(1_000)
    try:
        # The lock every Runlight takes to create tables. Asked for again and again, as the stores do, since another
        # process's migration may hold it a moment.
        while not other.all("SELECT pg_try_advisory_lock(?) AS ok", [dbs.MIGRATION_LOCK])[0]["ok"]:
            time.sleep(0.05)
        started = time.monotonic()
        with pytest.raises(TablesBusyError, match="had not finished after 1 seconds"):
            Stores.postgres(url).migrate()
        assert time.monotonic() - started < 5
        other.run("SELECT pg_advisory_unlock(?)", [dbs.MIGRATION_LOCK])
        dbs.lock_wait_in_tests(None)
        store = Stores.postgres(url)
        store.migrate()
        store.close()
    finally:
        dbs.lock_wait_in_tests(None)
        other.close()


@pytest.mark.skipif(MYSQL is None, reason="RUNLIGHT_TEST_MYSQL is not set")
def test_mysql_waiting_for_another_process_creating_the_tables_gives_up_after_the_lock_wait(databases: Any) -> None:
    url = databases.url(MYSQL or "")
    # Another session, held on its own connection, so the lock stays where it was taken.
    other = dbs.mysql(url, max=1)
    store = Stores.mysql(url)
    lock = "CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48))"
    dbs.lock_wait_in_tests(1_000)
    try:
        assert int(other.all(f"SELECT GET_LOCK({lock}, 0) AS ok")[0]["ok"]) == 1
        started = time.monotonic()
        with pytest.raises(TablesBusyError, match="had not finished after 1 seconds"):
            store.migrate()
        assert time.monotonic() - started < 5
        other.run(f"DO RELEASE_LOCK({lock})")
        store.migrate()
    finally:
        dbs.lock_wait_in_tests(None)
        other.close()
        store.close()


@pytest.mark.skipif(pg_url() is None, reason="RUNLIGHT_TEST_PG is not set")
def test_postgres_an_index_left_unusable_is_built_again_under_a_prefix_that_itself_starts_rl(databases: Any) -> None:
    url = databases.url("postgres")
    admin = dbs.postgres(url)
    first = Stores.postgres(url, prefix="rl_wp_")
    try:
        first.migrate()
        # As a concurrent build stopped part way leaves it.
        admin.run("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'rl_wp_events_site_ts'::regclass")
        # A full migrate goes over every index, as the scheduled check and the migrate command do; a plain one takes a
        # database at the current version on trust.
        again = Stores.postgres(url, prefix="rl_wp_")
        again.migrate(True)
        again.close()
        assert admin.all("SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = 'rl_wp_events_site_ts'::regclass") == [{"valid": True}]
    finally:
        first.close()
        admin.close()

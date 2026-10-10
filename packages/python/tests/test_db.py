"""The Db drivers: placeholders, values, transactions, and the lock, on every database."""

from __future__ import annotations

import threading
import time
from typing import Any

import pytest

from runlight import db as dbs
from support.databases import kinds


@pytest.mark.parametrize("kind", kinds())
def test_round_trip(databases, kind: str) -> None:
    db = databases.db(kind)
    text = "VARCHAR(50)" if kind.startswith("mysql") or kind == "mariadb" else "TEXT"
    db.run(f"CREATE TABLE rl_t (id {text} PRIMARY KEY, n BIGINT, x REAL, note {text})")
    db.run("INSERT INTO rl_t (id, n, x, note) VALUES (?, ?, ?, ?)", ["a", 5, 1.5, "it's a \\ back?"])
    db.run("INSERT INTO rl_t (id, n, x, note) VALUES (?, ?, ?, ?)", ["b", 2**40, 2.0, None])
    rows = db.all("SELECT id, n, x, note FROM rl_t WHERE n > ? ORDER BY id", [1])
    assert [r["id"] for r in rows] == ["a", "b"]
    assert rows[0]["note"] == "it's a \\ back?"
    assert int(rows[1]["n"]) == 2**40
    assert float(rows[0]["x"]) == 1.5
    total = db.all("SELECT SUM(n) AS s FROM rl_t")[0]["s"]
    assert int(total) == 2**40 + 5

    def fail(d):
        d.run("DELETE FROM rl_t")
        raise RuntimeError("no")

    with pytest.raises(RuntimeError):
        db.transaction(fail)
    assert len(db.all("SELECT id FROM rl_t")) == 2
    db.transaction(lambda d: d.run("DELETE FROM rl_t WHERE id = ?", ["a"]))
    assert len(db.all("SELECT id FROM rl_t")) == 1
    assert db.exclusive(lambda d: 7) == 7


def test_mysql_text() -> None:
    assert dbs.mysql_text('SELECT "a" FROM t WHERE x = ? AND y = \'\\\'', ["it's"]) == (
        "SELECT `a` FROM t WHERE x = 'it\\'s' AND y = '\\\\'".replace("x = 'it\\'s'", "x = 'it\\'s'")
    )
    assert dbs.number_placeholders("a = ? AND b = '?' AND c = ?") == "a = $1 AND b = '?' AND c = $2"


class _Cursor:
    description = None
    rowcount = 0

    def __enter__(self) -> _Cursor:
        return self

    def __exit__(self, *_: object) -> None:
        pass

    def execute(self, sql: str, params: object = None) -> int:
        time.sleep(0.001)
        return 0

    def fetchall(self) -> list[object]:
        return []


class _Connection:
    closed = False

    def cursor(self) -> _Cursor:
        return _Cursor()

    def close(self) -> None:
        self.closed = True


def _many_threads(db: Any, n: int = 200) -> None:
    """A request on a thread of its own, n at once, as a threading server starts them."""
    start = threading.Barrier(n)

    def one() -> None:
        start.wait()
        db.run("SELECT 1")
        db.transaction(lambda d: d.run("SELECT 2"))

    threads = [threading.Thread(target=one) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def test_threads_share_a_pool_of_connections_and_close_them() -> None:
    opened: list[_Connection] = []

    def connect() -> _Connection:
        conn = _Connection()
        opened.append(conn)
        return conn

    db = dbs.PostgresDb(connect, max=10)
    _many_threads(db)
    assert 1 <= len(opened) <= 10, "connections do not grow with threads"
    assert not any(c.closed for c in opened), "and the ones open are used again"
    _many_threads(db)
    assert len(opened) <= 10
    db.close()
    assert all(c.closed for c in opened)


@pytest.mark.parametrize("kind", [k for k in kinds() if k != "sqlite"])
def test_a_real_pool_stays_bounded(databases, kind: str) -> None:
    db = databases.db(kind)
    db.all("SELECT 1 AS one")
    opened: list[Any] = []
    connect = db._connect

    def counted() -> Any:
        conn = connect()
        opened.append(conn)
        return conn

    db._connect = counted
    _many_threads(db, 100)
    assert len(opened) <= 10

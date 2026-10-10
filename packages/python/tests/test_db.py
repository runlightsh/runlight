"""The Db drivers: placeholders, values, transactions, and the lock, on every database."""

from __future__ import annotations

import ssl
import threading
import time
from typing import Any

import pytest

from runlight import db as dbs
from support.databases import kinds, mysql_urls, pg_url


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


def test_postgres_url_tls_settings_reach_libpq_or_are_refused() -> None:
    assert dbs.postgres_tls({"sslmode": "verify-full", "sslrootcert": "/ca.pem", "sslcert": "/c.pem", "sslkey": "/k.pem", "x": "1"}) == {
        "sslmode": "verify-full",
        "sslrootcert": "/ca.pem",
        "sslcert": "/c.pem",
        "sslkey": "/k.pem",
    }
    # As pg, the TypeScript driver, reads them.
    assert dbs.postgres_tls({"ssl": "true"}) == {"sslmode": "verify-full", "sslrootcert": "system"}
    assert dbs.postgres_tls({"ssl": "0"}) == {"sslmode": "disable"}
    assert dbs.postgres_tls({"ssl": "true", "sslmode": "require"}) == {"sslmode": "require"}
    assert dbs.postgres_tls({"sslmode": "no-verify"}) == {"sslmode": "require"}
    with pytest.raises(ValueError, match="sslca"):
        dbs.postgres_tls({"sslca": "/ca.pem"})
    with pytest.raises(ValueError, match="ssl=maybe"):
        dbs.postgres_tls({"ssl": "maybe"})
    with pytest.raises(ValueError, match="sslfactory"):
        dbs.postgres("postgres://u@127.0.0.1/db?sslfactory=x")


def test_mysql_url_tls_settings_become_a_tls_context_or_are_refused() -> None:
    assert dbs.mysql_tls({"charset": "utf8"}) == {}
    assert dbs.mysql_tls({"ssl-mode": "PREFERRED"}) == {}
    assert dbs.mysql_tls({"ssl-mode": "DISABLED"}) == {"ssl_disabled": True}
    assert dbs.mysql_tls({"ssl": "false"}) == {"ssl_disabled": True}
    for query in ({"ssl": "true"}, {"ssl_mode": "verify_identity"}, {"sslmode": "verify-full"}, {"sslaccept": "strict"}, {"ssl": '{"rejectUnauthorized":true}'}):
        context = dbs.mysql_tls(query)["ssl"]
        assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname, query
    ca = dbs.mysql_tls({"ssl-mode": "VERIFY_CA"})["ssl"]
    assert ca.verify_mode == ssl.CERT_REQUIRED and not ca.check_hostname
    for query in ({"ssl-mode": "REQUIRED"}, {"sslaccept": "accept_invalid_certs"}, {"ssl": '{"rejectUnauthorized":false}'}):
        context = dbs.mysql_tls(query)["ssl"]
        assert context.verify_mode == ssl.CERT_NONE and not context.check_hostname, query
    with pytest.raises(ValueError, match="ssl-crl"):
        dbs.mysql_tls({"ssl-crl": "/crl.pem"})
    with pytest.raises(ValueError, match="sometimes"):
        dbs.mysql_tls({"ssl-mode": "sometimes"})
    with pytest.raises(ValueError, match="rejectUnauthorized"):
        dbs.mysql_tls({"ssl": '{"ca":"..."}'})
    with pytest.raises(ValueError, match="ssl_crl"):
        dbs.mysql("mysql://root@127.0.0.1/db?ssl_crl=x")


def _with(url: str, param: str) -> str:
    return url + ("&" if "?" in url else "?") + param


@pytest.mark.skipif(pg_url() is None, reason="RUNLIGHT_TEST_PG is not set")
def test_a_postgres_url_that_asks_for_tls_gets_it_or_fails() -> None:
    url = pg_url() or ""
    plain = dbs.postgres(_with(url, "sslmode=disable"))
    assert plain.all("SELECT 1 AS one")[0]["one"] == 1
    plain.close()
    # A server without TLS refuses a URL that requires it, rather than the URL quietly connecting in the clear.
    asked = dbs.postgres(_with(url, "sslmode=require"))
    try:
        on = asked.all("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()")[0]["ssl"]
    except Exception as error:  # noqa: BLE001
        assert "ssl" in str(error).lower()
    else:
        assert on, "connected over TLS"
    finally:
        asked.close()


@pytest.mark.parametrize("name", list(mysql_urls()))
def test_a_mysql_url_that_asks_for_tls_gets_it_or_fails(name: str) -> None:
    asked = dbs.mysql(_with(mysql_urls()[name], "ssl-mode=REQUIRED"))
    try:
        rows = asked.all("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
    except Exception as error:  # noqa: BLE001
        assert "ssl" in str(error).lower()
    else:
        assert rows and list(rows[0].values())[1], "connected over TLS"
    finally:
        asked.close()

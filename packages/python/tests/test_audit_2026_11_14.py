"""The 2026-11-14 review's fixes that are the Python port's own: its servers, adapters, and drivers."""

from __future__ import annotations

import asyncio
import math
import socket
import threading
import time
from typing import Any
from wsgiref.simple_server import make_server

import pytest
from support.databases import mysql_urls
from support.routes import clear_env

from runlight import Runlight, _js, core
from runlight import db as dbs
from runlight.accounts.auth import Accounts, Throttle, match_step, recovery_hash, totp
from runlight.asgi import RunlightMiddleware as AsgiMiddleware
from runlight.asgi import to_request as asgi_request
from runlight.http import Request, Response
from runlight.payload import parse_payload
from runlight.serve import Front, request_url
from runlight.server import cli
from runlight.store import Stores
from runlight.wsgi import RunlightMiddleware as WsgiMiddleware
from runlight.wsgi import to_request as wsgi_request

NOW = 1_791_288_000_000
DAY = 86_400_000
CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
CHATGPT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot"


@pytest.fixture(autouse=True)
def _no_env():
    with clear_env():
        yield


def make(**more: Any) -> Runlight:
    return Runlight(store=Stores.sqlite(":memory:"), site={"hostnames": ["example.com"]}, **more)


# The standalone server.


def _serve(app: Any, handler: Any = cli._QuietHandler, server: Any = cli._ThreadingServer) -> Any:
    httpd = make_server("127.0.0.1", 0, app, server_class=server, handler_class=handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def test_the_standalone_server_drops_headers_named_with_underscores_so_none_adds_to_a_proxys() -> None:
    seen: dict[str, Any] = {}

    def app(environ: Any, start_response: Any) -> list[bytes]:
        seen.update(environ)
        start_response("200 OK", [("content-type", "text/plain")])
        return [b"ok"]

    httpd = _serve(app)
    try:
        with socket.create_connection(("127.0.0.1", httpd.server_address[1]), timeout=5) as client:
            client.sendall(
                b"GET / HTTP/1.0\r\nHost: example.com\r\nX-Forwarded-For: 203.0.113.9\r\nX_Forwarded_For: 198.51.100.7\r\n"
                b"X_Real_IP: 198.51.100.7\r\nCF_Connecting_IP: 198.51.100.7\r\nX_Forwarded_Host: evil.example\r\nX-Real-IP: 203.0.113.9\r\n\r\n"
            )
            assert client.makefile("rb").read().endswith(b"ok")
    finally:
        httpd.shutdown()
        httpd.server_close()
    assert seen["HTTP_X_FORWARDED_FOR"] == "203.0.113.9"
    assert seen["HTTP_X_REAL_IP"] == "203.0.113.9"
    assert "HTTP_CF_CONNECTING_IP" not in seen and "HTTP_X_FORWARDED_HOST" not in seen
    # So the address Runlight reads is the one the proxy wrote.
    rl = make()
    assert rl.client_ip(wsgi_request({**seen, "REMOTE_ADDR": "127.0.0.1"})) == "203.0.113.9"


def test_a_request_gets_a_thread_once_its_head_and_a_short_body_are_whole() -> None:
    arrived = cli._arrived
    head = b"POST /e HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\n\r\n"
    assert not arrived(head[:20], 16384, 16384), "half a head"
    assert not arrived(head, 16384, 16384), "a head whose short body has not come"
    assert not arrived(head + b"1234", 16384, 16384)
    assert arrived(head + b"12345", 16384, 16384)
    assert arrived(b"GET / HTTP/1.1\r\nHost: a\r\n\r\n", 16384, 16384), "no body to wait for"
    assert arrived(b"GET / HTTP/1.0\n\n", 16384, 16384)
    assert arrived(b"POST / HTTP/1.1\r\ncontent-length: 20000\r\n\r\n", 16384, 16384), "a long body is read on its thread"
    assert arrived(b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n", 16384, 16384)
    assert arrived(b"x" * 16384, 16384, 16384), "a head past the most looked at is the handler's to refuse"
    # A length inside the body is not the head's.
    assert arrived(b"POST / HTTP/1.1\r\nHost: a\r\n\r\nContent-Length: 5\r\n", 16384, 16384)


def test_a_body_sent_a_few_bytes_at_a_time_loses_its_thread_within_seconds_however_long_it_says_it_is() -> None:
    import select

    read: list[bytes] = []

    class Handler(cli._QuietHandler):
        # Far past the test: only the pace can end the request.
        timeout = 20
        request_seconds = 30.0
        grace_seconds = 0.3
        pace = 4096

    def echo(environ: Any, start_response: Any) -> list[bytes]:
        body = environ["wsgi.input"].read(int(environ.get("CONTENT_LENGTH") or 0))
        read.append(body)
        start_response("200 OK", [("content-type", "text/plain")])
        return [b"read"]

    httpd = _serve(echo, Handler)
    port = httpd.server_address[1]
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=5) as slow:
            slow.sendall(b"POST / HTTP/1.0\r\nContent-Length: 1000000\r\n\r\n")
            started = time.monotonic()
            try:
                while not select.select([slow], [], [], 0.05)[0] and time.monotonic() - started < 5:
                    slow.sendall(b"x")
                answer = slow.makefile("rb").read()
            except (ConnectionResetError, BrokenPipeError):
                # A byte sent after the server hung up: hung up all the same.
                answer = b""
            assert answer == b"" or answer.startswith(b"HTTP/1.0 500")
            assert time.monotonic() - started < 3, "cut off by its pace, long before the deadline"
        assert read == []
        # One that keeps the pace is read whole.
        with socket.create_connection(("127.0.0.1", port), timeout=5) as quick:
            quick.sendall(b"POST / HTTP/1.0\r\nContent-Length: 40000\r\n\r\n" + b"y" * 40000)
            assert quick.makefile("rb").read().endswith(b"read")
        assert read == [b"y" * 40000]
    finally:
        httpd.shutdown()
        httpd.server_close()


# The adapters.


class _Down:
    """A database that cannot be reached."""

    def dialect(self) -> str:
        return "sqlite"

    def __getattr__(self, name: str) -> Any:
        def away(*args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("the database is away")

        return away


def test_a_database_that_is_down_never_fails_the_apps_own_requests(capsys: pytest.CaptureFixture[str]) -> None:
    clock = {"now": NOW}
    rl = Runlight(store=Stores.sqlite(":memory:"), site={"hostnames": ["example.com"]}, now=lambda: clock["now"])
    rl.init()
    rl.store.add_link_domain("go.example.org", "default", NOW)
    front = Front(rl, routes=object())
    page = Request("https://example.com/about", "GET", {"host": "example.com"})
    link = Request("https://go.example.org/nothing", "GET", {"host": "go.example.org"})
    assert front.link_domain(page) is None
    assert front.link_domain(link) is not None and front.link_domain(link).status == 404  # type: ignore[union-attr]

    # The database goes away, and the half minute the domains were kept for runs out.
    working = rl.store.db
    asked: list[int] = []

    class Away(_Down):
        def all(self, *args: Any, **kwargs: Any) -> Any:
            asked.append(1)
            raise RuntimeError("the database is away")

    rl.store.db = Away()
    clock["now"] += 31_000
    assert front.link_domain(page) is None, "the app's page goes on"
    assert len(asked) == 1
    assert "could not read the link domains" in capsys.readouterr().err
    # It is left alone for five seconds, not asked again by every request, and the domains last read stand.
    clock["now"] += 4_000
    assert front.link_domain(page) is None
    assert front.no_link_domain(page) is True
    assert front.no_link_domain(link) is False
    assert len(asked) == 1
    clock["now"] += 1_000
    assert front.link_domain(page) is None
    assert len(asked) == 2
    # Back again: read once, then kept for half a minute as before.
    rl.store.db = working
    clock["now"] += 5_000
    assert front.link_domain(page) is None
    assert rl.link_domain_known(page) is False
    clock["now"] += 29_000
    assert rl.link_domain_known(page) is False
    clock["now"] += 1_000
    assert rl.link_domain_known(page) is None

    def hello(environ: Any, start_response: Any) -> list[bytes]:
        start_response("200 OK", [("content-type", "text/plain")])
        return [b"the app"]

    # A Runlight that never had its tables at all: every page of the app still answers.
    down = Runlight(store=Stores.sqlite(":memory:"), site={"hostnames": ["example.com"]})
    down.store.db = _Down()
    statuses: list[str] = []
    middleware = WsgiMiddleware(hello, down, routes=object())
    for method in ("GET", "POST"):
        body = middleware({"REQUEST_METHOD": method, "PATH_INFO": "/about", "HTTP_HOST": "example.com", "wsgi.url_scheme": "https"}, lambda status, headers: statuses.append(status))
        assert b"".join(body) == b"the app"
    assert statuses == ["200 OK", "200 OK"]


def test_a_method_no_route_answers_goes_to_the_app() -> None:
    def hello(environ: Any, start_response: Any) -> list[bytes]:
        start_response("200 OK", [("content-type", "text/plain")])
        return [environ["REQUEST_METHOD"].encode()]

    rl = make()
    rl.init()
    rl.store.add_link_domain("go.example.org", "default", NOW)
    statuses: list[str] = []
    for app, host, path in ((hello, "go.example.org", "/x"), (hello, "example.com", "/runlight/api/stats"), (None, "example.com", "/runlight/api/stats")):
        for method in ("TRACE", "TRACK", "CONNECT"):
            middleware = WsgiMiddleware(app, rl, routes=rl.routes({"token": "t"}))
            body = middleware({"REQUEST_METHOD": method, "PATH_INFO": path, "HTTP_HOST": host, "wsgi.url_scheme": "https"}, lambda status, headers: statuses.append(status))
            assert b"".join(body) == (method.encode() if app else b"")
    assert statuses == ["200 OK"] * 6 + ["405 Method Not Allowed"] * 3
    asgi = AsgiMiddleware(_hello, runlight=rl, routes=rl.routes({"token": "t"}))
    assert _asgi(asgi, "/runlight/api/stats", method="TRACE") == (200, b"the app")
    assert _asgi(AsgiMiddleware(None, runlight=rl, routes=rl.routes({"token": "t"})), "/runlight/api/stats", method="TRACE")[0] == 405


class _Counting:
    """An executor that counts what it is given."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.jobs: list[str] = []

    def submit(self, fn: Any, *args: Any, **kwargs: Any) -> Any:
        self.jobs.append(getattr(fn, "__name__", repr(fn)))
        return self.inner.submit(fn, *args, **kwargs)


def _asgi(application: Any, path: str, headers: dict[str, str] | None = None, raw: bytes | None = None, loop_threads: list[str] | None = None, method: str = "GET") -> tuple[int, bytes]:
    scope = {
        "type": "http",
        "method": method,
        "scheme": "https",
        "path": path,
        "raw_path": raw if raw is not None else path.encode(),
        "root_path": "",
        "query_string": b"",
        "headers": [(b"host", b"example.com"), *((k.encode(), v.encode()) for k, v in (headers or {}).items())],
        "client": ("203.0.113.9", 50000),
        "server": ("example.com", 443),
    }
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    async def run() -> None:
        if loop_threads is not None:
            # The loop's own threads, which the app's code shares: Runlight must not take one.
            loop = asyncio.get_running_loop()
            default = loop.run_in_executor

            def watched(executor: Any, fn: Any, *args: Any) -> Any:
                if executor is None:
                    loop_threads.append(getattr(fn, "__name__", repr(fn)))
                return default(executor, fn, *args)

            loop.run_in_executor = watched  # type: ignore[method-assign]
        await application(scope, receive, send)

    asyncio.run(run())
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    return status, b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")


async def _hello(scope: Any, receive: Any, send: Any) -> None:
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
    await send({"type": "http.response.body", "body": b"the app"})


def test_under_asgi_the_apps_own_requests_take_no_thread_and_runlights_work_has_threads_of_its_own() -> None:
    rl = make()
    middleware = AsgiMiddleware(_hello, runlight=rl, routes=rl.routes({"token": "t"}), threads=3)
    assert middleware.executor._max_workers == 3
    counting = _Counting(middleware.executor)
    middleware.executor = counting  # type: ignore[assignment]
    loop_threads: list[str] = []

    # The first request reads the link domains, on one of Runlight's threads.
    assert _asgi(middleware, "/about", {"user-agent": CHROME}, loop_threads=loop_threads) == (200, b"the app")
    assert counting.jobs == ["link_domain"]
    # After that a page of the app's needs no thread at all, for half a minute.
    counting.jobs.clear()
    for path in ("/about", "/pricing", "/go", "/runlightish"):
        assert _asgi(middleware, path, {"user-agent": CHROME}, loop_threads=loop_threads) == (200, b"the app")
    assert counting.jobs == []
    # A page fetched by an AI agent is recorded, a short link looked up, and the routes answered, on Runlight's.
    assert _asgi(middleware, "/about", {"user-agent": CHATGPT}, loop_threads=loop_threads)[0] == 200
    assert counting.jobs == ["watch"]
    assert len(rl.store.db.all("SELECT 1 FROM rl_events WHERE kind = 'fetch'")) == 1
    counting.jobs.clear()
    assert _asgi(middleware, "/go/none", {"user-agent": CHROME}, loop_threads=loop_threads) == (200, b"the app")
    assert counting.jobs == ["short_link"]
    counting.jobs.clear()
    assert _asgi(middleware, "/runlight/s.js", loop_threads=loop_threads)[0] == 200
    assert counting.jobs == ["answer", "idle"]
    assert loop_threads == [], "never one of the loop's own, which the app's code runs on"
    middleware.executor.inner.shutdown()

    # A link domain added since is seen once the half minute is up, or at once by the process that added it.
    assert rl.link_domain_known(Request("https://example.com/", "GET", {"host": "example.com"})) is False
    rl.forget_link_domains()
    assert rl.link_domain_known(Request("https://example.com/", "GET", {"host": "example.com"})) is None


def test_a_request_target_never_names_the_host() -> None:
    for target in ("//evil.example/runlight/oauth/authorize", "/\\evil.example/x", "\\\\evil.example/x", "///evil.example/x", "/\t/evil.example/x"):
        url = request_url("https", "example.com", target)
        assert url.startswith("https://example.com/"), target
    assert request_url("https", "example.com", "//evil.example/runlight/oauth/authorize") == "https://example.com//evil.example/runlight/oauth/authorize"
    assert request_url("https", "example.com", "/a?next=//b") == "https://example.com/a?next=//b"
    assert request_url("http", "example.com:8080", "/a") == "http://example.com:8080/a"

    scope = {"type": "http", "method": "POST", "scheme": "https", "path": "//evil.example/runlight/oauth/authorize", "raw_path": b"//evil.example/runlight/oauth/authorize", "query_string": b"", "headers": [(b"host", b"example.com")]}
    assert asgi_request(scope).url == "https://example.com//evil.example/runlight/oauth/authorize"
    for environ in ({"RAW_URI": "//evil.example/runlight/oauth/authorize"}, {"PATH_INFO": "//evil.example/runlight/oauth/authorize"}):
        request = wsgi_request({"REQUEST_METHOD": "GET", "HTTP_HOST": "example.com", "wsgi.url_scheme": "https", **environ})
        assert request.url == "https://example.com//evil.example/runlight/oauth/authorize"

    # So a consent form posted from another site, at a target that names that site, is still another site's:
    # the routes see their own host, and the path is not theirs at all.
    rl = make()
    routes = rl.routes({"token": "t"})
    posted = Request(
        request_url("https", "example.com", "//evil.example/runlight/oauth/authorize"),
        "POST",
        {"host": "example.com", "origin": "https://evil.example", "authorization": "Bearer t", "content-type": "application/x-www-form-urlencoded"},
        "decision=allow",
    )
    assert routes.handle(posted).status == 404


# JSON.


def test_a_number_past_the_largest_double_reads_as_infinity_as_json_parse_reads_it() -> None:
    huge = "1" + "0" * 400
    assert _js.loads(f"[{huge}, -{huge}]") == [math.inf, -math.inf]
    assert _js.try_loads(f'{{"a":{huge}}}') == (True, {"a": math.inf})
    assert _js.loads("[9007199254740993, 18446744073709551616]") == [9007199254740992, 18446744073709551616.0]
    # The tracker's body: the width is dropped, as TypeScript drops Infinity, and the hit is kept.
    hit = parse_payload(f'{{"k":"pageview","u":"https://example.com/","w":{huge},"h":{huge}}}')
    assert hit is not None and hit["screenWidth"] is None and hit["screenHeight"] is None
    event = parse_payload(f'{{"k":"event","n":"Signup","u":"https://example.com/","p":{{"plan":"pro","n":{huge}}}}}')
    assert event is not None and event["props"] == {"plan": "pro"}


def test_a_tracker_hit_with_such_a_number_is_counted_and_nothing_is_logged(capsys: pytest.CaptureFixture[str]) -> None:
    rl = make()
    routes = rl.routes({"token": "t"})
    body = '{"k":"pageview","u":"https://example.com/","w":1' + "0" * 400 + "}"
    answer = routes.handle(Request("https://example.com/runlight/e", "POST", {"user-agent": CHROME}, body, "203.0.113.9"))
    assert answer.status == 202
    assert len(rl.store.db.all("SELECT 1 FROM rl_events WHERE kind = 'pageview'")) == 1
    registered = routes.handle(
        Request("https://example.com/runlight/oauth/register", "POST", {"content-type": "application/json"}, '{"redirect_uris":["https://app.example/cb"],"x":1' + "0" * 400 + "}", "203.0.113.9")
    )
    assert registered.status == 201
    assert capsys.readouterr().err == ""


# The database.


def test_a_pool_with_no_connection_free_is_a_database_too_busy_so_a_tracker_hit_is_tried_again(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dbs, "POOL_WAIT", 0.01)
    db = dbs.PostgresDb(lambda: object(), max=1)
    held = db._acquire()
    with pytest.raises(RuntimeError) as waited:
        db._acquire()
    db._release(held, True)
    assert core._busy(waited.value)
    assert not core._busy(RuntimeError("syntax error"))

    # And collect() goes on to record the hit once a connection is free.
    rl = make(rateLimit=False)
    record = rl._record
    tries: list[int] = []

    def busy_once(*args: Any) -> None:
        tries.append(1)
        if len(tries) == 1:
            raise waited.value
        record(*args)

    monkeypatch.setattr(rl, "_record", busy_once)
    monkeypatch.setattr(core.time, "sleep", lambda seconds: None)
    rl.collect(Request("https://example.com/runlight/e", "POST", {"user-agent": CHROME}, '{"k":"pageview","u":"https://example.com/"}', "203.0.113.9"))
    assert len(tries) == 2
    assert len(rl.store.db.all("SELECT 1 FROM rl_events")) == 1


class _Cursor:
    def __init__(self, conn: _Session) -> None:
        self.conn = conn
        self.description = None

    def __enter__(self) -> _Cursor:
        return self

    def __exit__(self, *args: Any) -> None:
        pass

    def execute(self, sql: str) -> int:
        self.conn.ran.append(sql)
        return 0

    def fetchall(self) -> list[Any]:
        return []


class _Session:
    """A MySQL connection as PyMySQL's: it knows the id of the session it is in, which changes when it connects again."""

    def __init__(self) -> None:
        self.session = 1
        self.ran: list[str] = []

    def thread_id(self) -> int:
        return self.session

    def cursor(self) -> _Cursor:
        return _Cursor(self)


def test_a_mysql_connection_that_connects_again_drops_no_backslash_escapes_again_before_any_value_is_written_in() -> None:
    reset = dbs._NO_BACKSLASH_ESCAPES_OFF
    conn = _Session()
    db = dbs.MysqlDb(conn=conn)
    assert conn.ran == [reset], "an app's own connection has the mode dropped when it is handed over"
    db.run("INSERT INTO t (a) VALUES (?)", ["it's"])
    db.all("SELECT ? AS a", ["\\"])
    assert conn.ran[1:] == ["INSERT INTO t (a) VALUES ('it\\'s')", "SELECT '\\\\' AS a"], "and not again while the session is the same"
    # ping(reconnect=True), or the app connecting again: a new session, with the server's modes as they come.
    conn.session = 2
    conn.ran.clear()
    db.run("INSERT INTO t (a) VALUES (?)", ["\\' OR 1=1 -- "])
    assert conn.ran == [reset, "INSERT INTO t (a) VALUES ('\\\\\\' OR 1=1 -- ')"]
    conn.ran.clear()
    db.run("DELETE FROM t WHERE a = ?", ["x"])
    assert conn.ran == ["DELETE FROM t WHERE a = 'x'"]

    # A pooled connection is new each time the pool connects, and each has the mode dropped before its first statement.
    made: list[_Session] = []

    def connect() -> _Session:
        made.append(_Session())
        return made[-1]

    pool = dbs.MysqlDb(connect)
    pool.run("DELETE FROM t WHERE a = ?", ["x"])
    assert made[0].ran == [reset, "DELETE FROM t WHERE a = 'x'"]

    # A driver that does not say which session it is in is asked to drop the mode every time.
    class Silent(_Session):
        thread_id = None  # type: ignore[assignment]

    silent = Silent()
    quiet = dbs.MysqlDb(conn=silent)
    quiet.run("DELETE FROM t WHERE a = ?", ["x"])
    quiet.run("DELETE FROM t WHERE a = ?", ["y"])
    assert silent.ran == [reset, reset, "DELETE FROM t WHERE a = 'x'", reset, "DELETE FROM t WHERE a = 'y'"]


def test_the_mysql_driver_is_told_to_drop_the_mode_each_time_it_connects(monkeypatch: pytest.MonkeyPatch) -> None:
    pymysql = pytest.importorskip("pymysql")
    given: dict[str, Any] = {}

    def connect(**kwargs: Any) -> _Session:
        given.update(kwargs)
        return _Session()

    monkeypatch.setattr(pymysql, "connect", connect)
    db = dbs.mysql("mysql://root@127.0.0.1/db", statement_timeout=0)
    db.run("DELETE FROM t WHERE a = ?", ["x"])
    assert given["init_command"] == dbs._NO_BACKSLASH_ESCAPES_OFF
    assert given["charset"] == "utf8mb4"


@pytest.mark.parametrize("name", list(mysql_urls()))
def test_a_real_mysql_session_set_to_no_backslash_escapes_after_a_reconnect_still_reads_a_value_as_a_value(name: str) -> None:
    import pymysql

    parts = dbs._parts(mysql_urls()[name].replace("mariadb:", "mysql:"))
    conn = pymysql.connect(host=parts["host"], port=parts["port"] or 3306, user=parts["user"] or "", password=parts["password"] or "", database=parts["database"] or None, charset="utf8mb4", autocommit=True)
    try:
        db = dbs.MysqlDb(conn=conn)
        value = "\\' UNION SELECT 'injected' -- "
        assert db.all("SELECT ? AS v", [value]) == [{"v": value}]
        # The app's connection drops and comes back, on a server whose sessions start with NO_BACKSLASH_ESCAPES.
        before = conn.thread_id()
        conn.close()
        conn.ping(reconnect=True)
        assert conn.thread_id() != before
        with conn.cursor() as cursor:
            cursor.execute("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')")
        assert db.all("SELECT ? AS v", [value]) == [{"v": value}]
        assert "NO_BACKSLASH_ESCAPES" not in str(db.all("SELECT @@SESSION.sql_mode AS m")[0]["m"])

        # The pool's own connections have it dropped by the driver itself, whenever it connects.
        pool = dbs.mysql(mysql_urls()[name])
        own = pool._connect()
        with own.cursor() as cursor:
            cursor.execute("SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',NO_BACKSLASH_ESCAPES')")
        own.close()
        own.ping(reconnect=True)
        with own.cursor() as cursor:
            cursor.execute("SELECT @@SESSION.sql_mode")
            assert "NO_BACKSLASH_ESCAPES" not in str(cursor.fetchone()[0])
        own.close()
    finally:
        conn.close()


# Accounts.


def test_sign_in_counts_made_from_an_address_go_without_a_scheduled_check() -> None:
    clock = {"now": NOW}
    store = Stores.sqlite(":memory:")
    rl = Runlight(store=store, site={"hostnames": ["example.com"]}, now=lambda: clock["now"])
    rl.init()
    throttle = Throttle(store, "ip", 3, 15 * 60_000, clock=lambda: clock["now"])
    assert throttle.take("203.0.113.7", clock["now"]) is True
    rows = lambda: [s["key"] for s in store.settings_starting_with("throttle")]  # noqa: E731
    assert len(rows()) == 2, "the count and the day's key"

    # A count that starts sets a timer for when its window ends, which deletes it then, and stops when none is left.
    timer = throttle._timer
    assert timer is not None and timer.daemon and timer.interval == 15 * 60 + 1
    assert throttle.take("203.0.113.8", clock["now"]) is True
    assert throttle._timer is timer, "one timer, however many counts"
    timer.cancel()
    clock["now"] += 10 * 60_000
    assert throttle.take("203.0.113.9", clock["now"]) is True
    clock["now"] += 6 * 60_000
    throttle._swept()
    assert len([k for k in rows() if k.startswith("throttle:ip:")]) == 1, "the two that ran out are gone"
    again = throttle._timer
    assert again is not None and again is not timer, "and it waits for the one that is left"
    again.cancel()
    clock["now"] += 15 * 60_000
    throttle._swept()
    assert [k for k in rows() if k.startswith("throttle:")] == []
    assert throttle._timer is None

    # A process that starts deletes what an earlier one left behind: counts that ran out, and keys older than yesterday.
    assert throttle.take("203.0.113.7", clock["now"]) is True
    throttle._timer.cancel()  # type: ignore[union-attr]
    assert len(rows()) == 2
    clock["now"] += 3 * DAY
    Runlight(store=store, site={"hostnames": ["example.com"]}, now=lambda: clock["now"]).init()
    assert rows() == []

    # And so does the first tracker hit of a day, in a process that has run since before the count was made.
    assert throttle.take("203.0.113.7", clock["now"]) is True
    throttle._timer.cancel()  # type: ignore[union-attr]
    clock["now"] += 2 * DAY
    hit = Request("https://example.com/runlight/e", "POST", {"user-agent": CHROME}, '{"k":"pageview","u":"https://example.com/"}', "203.0.113.9")
    rl.collect(hit)
    assert rows() == []

    # A timer that finds the database gone says nothing and stops.
    store.close()
    store.db._path = "/nowhere/at/all/runlight.db"
    throttle._swept()


def test_codes_are_compared_in_full_and_still_work_once(databases: Any) -> None:
    secret = "JBSWY3DPEHPK3PXP"
    step = NOW // 30_000
    assert match_step(secret, totp(secret, step), NOW, -1) == step
    assert match_step(secret, totp(secret, step - 1), NOW, -1) == step - 1
    assert match_step(secret, totp(secret, step), NOW, step) is None, "a code already used"
    assert match_step(secret, "000000" if totp(secret, step) != "000000" else "111111", NOW, step - 2) is None
    assert match_step(secret, "", NOW, -1) is None

    store = Stores.sqlite(":memory:")
    store.migrate()
    accounts = Accounts(store, "k" * 64)
    user = accounts.set_password("jon@example.com", "a long password", NOW)
    pending = accounts.start_two_factor(user["id"])
    codes = accounts.confirm_two_factor(user["id"], totp(pending, step), NOW)
    assert codes is not None and len(codes) == 10
    assert accounts.check_second_factor(user["id"], "zzzz-zzzz", NOW) is False
    assert accounts.check_second_factor(user["id"], codes[3].upper(), NOW) is True
    assert accounts.check_second_factor(user["id"], codes[3], NOW) is False, "a recovery code works once"
    assert accounts.by_id(user["id"])["recoveryLeft"] == 9  # type: ignore[index]
    left = _js.loads(store.db.all("SELECT totp_recovery FROM rl_users")[0]["totp_recovery"])
    assert recovery_hash(codes[3]) not in left and recovery_hash(codes[4]) in left


def test_an_account_kept_to_one_site_is_refused_oauth_by_the_path_after_the_base_not_by_any_oauth_in_the_address() -> None:
    from runlight.http import SearchParams

    # Mounted where the base itself holds /oauth/, which a test of the whole address would take for the consent page.
    base = "/oauth/stats"
    rl = Runlight({"store": Stores.sqlite(":memory:"), "secret": "k" * 64, "site": {"hostnames": ["example.com"]}})
    routes = rl.routes({"token": "app-token", "accounts": True, "basePath": base})

    def ask(path: str, method: str = "GET", headers: dict[str, str] | None = None, body: str = "") -> Response:
        return routes.handle(Request(f"https://example.com{base}{path}", method, headers or {}, body))

    def form(path: str, fields: dict[str, str]) -> str:
        answer = ask(path, "POST", {"content-type": "application/x-www-form-urlencoded"}, SearchParams(fields).to_string())
        cookies = answer.headers.get_set_cookie()
        return (cookies[0] if cookies else "").split(";")[0]

    owner = form("/setup", {"code": "app-token", "email": "jon@example.com", "password": "a long password", "again": "a long password"})
    made = ask("/api/people", "POST", {"cookie": owner, "content-type": "application/json"}, _js.dumps({"site": "default", "email": "mo@example.com", "role": "member"}))
    assert made.status == 201, made.text()
    code = SearchParams(_js.loads(made.text())["link"].split("?", 1)[1]).get("code") or ""
    member = form("/invite", {"code": code, "password": "a long password", "again": "a long password"})
    assert member

    # Their own site's numbers and settings are theirs, whatever the base is called.
    assert ask("/api/stats?period=today", "GET", {"cookie": member}).status == 200
    assert ask("/api/stats?period=today&note=/oauth/", "GET", {"cookie": member}).status == 200
    assert ask("/api/goals", "POST", {"cookie": member, "content-type": "application/json"}, '{"name":"Signup","kind":"event","match":"Signup"}').status == 201
    assert routes._can_read(Request(f"https://example.com{base}/api/goals", "POST", {"cookie": member})) is True
    # The consent page is not: an account kept to one site connects no apps.
    assert routes._can_read(Request(f"https://example.com{base}/oauth/authorize", "GET", {"cookie": member})) is False
    assert routes._can_read(Request(f"https://example.com{base}/oauth/authorize", "GET", {"cookie": owner})) is True

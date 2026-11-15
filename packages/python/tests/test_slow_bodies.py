"""A request body that stalls or drips in never holds a thread or a worker for good, wherever Runlight reads it: the
standalone server, the WSGI adapter, Django under WSGI, and the ASGI adapter. Each is answered 408."""

from __future__ import annotations

import asyncio
import io
import select
import socket
import threading
import time
from typing import Any
from wsgiref.simple_server import make_server

import pytest

from runlight import Runlight, serve
from runlight.asgi import RunlightMiddleware as AsgiMiddleware
from runlight.server import cli, standalone
from runlight.store import Stores
from runlight.wsgi import RunlightMiddleware as WsgiMiddleware

TIMED_OUT = b"HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n"
CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"


def make() -> Runlight:
    return Runlight(store=Stores.sqlite(":memory:"), site={"hostnames": ["example.com"]})


# The standalone server.


class Quick(cli._ThreadingServer):
    """The server with its waits cut short, and few threads, so a test sees them run out."""

    threads = 2
    head_seconds = 0.5
    grace_seconds = 0.3
    body_seconds = 1.5
    pace = 4096


def serving(app: Any, server: Any = Quick) -> Any:
    # Port 0: whichever port is free.
    httpd = make_server("127.0.0.1", 0, app, server_class=server, handler_class=cli._QuietHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def echo(environ: Any, start_response: Any) -> list[bytes]:
    # As Runlight's own adapter: a body longer than its path may take is refused unread.
    length = int(environ.get("CONTENT_LENGTH") or 0)
    body = b"" if length > serve.body_limit(environ["PATH_INFO"]) else environ["wsgi.input"].read(length)
    start_response("200 OK", [("content-type", "text/plain")])
    return [str(len(body)).encode()]


def answer_of(connection: socket.socket, wait: float = 5.0) -> bytes:
    connection.settimeout(wait)
    out = b""
    try:
        while True:
            piece = connection.recv(65536)
            if not piece:
                return out
            out += piece
    except (ConnectionResetError, BrokenPipeError):
        return out


def ask(port: int, request: bytes) -> bytes:
    with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
        connection.sendall(request)
        return answer_of(connection)


def test_bodies_that_stall_or_drip_never_take_a_thread_and_are_answered_408() -> None:
    httpd = serving(echo)
    port = httpd.server_address[1]
    held: list[socket.socket] = []
    try:
        # More stalled uploads than there are threads: each declares a body and then sends nothing more, or a
        # byte now and then, whatever length it says it is.
        for i in range(6):
            connection = socket.create_connection(("127.0.0.1", port), timeout=5)
            length = (10, 5_000, 200_000, 9_000_000, 20, 1_000_000)[i]
            connection.sendall(f"POST /api/links/import HTTP/1.1\r\nHost: a\r\nContent-Length: {length}\r\n\r\n".encode() + b"x" * (i % 2))
            held.append(connection)
        time.sleep(0.1)
        # While they wait, every thread is free: requests are answered at once.
        started = time.monotonic()
        for _ in range(4):
            assert ask(port, b"POST / HTTP/1.0\r\nContent-Length: 2\r\n\r\nhi").endswith(b"\r\n\r\n2")
        assert time.monotonic() - started < 0.25

        # One of them keeps dripping, a byte every few hundredths of a second: never idle, and never fast enough.
        dripper = held[2]
        answers: dict[int, bytes] = {}
        started = time.monotonic()
        try:
            while not select.select([dripper], [], [], 0.03)[0] and time.monotonic() - started < 5:
                dripper.sendall(b"x")
        except (ConnectionResetError, BrokenPipeError):
            pass
        cut = time.monotonic() - started
        for i, connection in enumerate(held):
            answers[i] = answer_of(connection)
        assert all(answer == TIMED_OUT for answer in answers.values()), answers
        assert cut < 1.2, "given up on as soon as it fell behind the pace, long before the body's whole time"
        assert time.monotonic() - started < 3
    finally:
        for connection in held:
            connection.close()
        httpd.shutdown()
        httpd.server_close()


def test_a_body_has_a_total_time_however_steadily_it_comes() -> None:
    class Patient(Quick):
        # No pace to fall behind: only the body's whole time can end it.
        pace = 1
        grace_seconds = 0.1
        body_seconds = 0.8

    httpd = serving(echo, Patient)
    port = httpd.server_address[1]
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=5) as steady:
            steady.sendall(b"POST / HTTP/1.1\r\nHost: a\r\nContent-Length: 100000\r\n\r\n")
            started = time.monotonic()
            try:
                # A hundred bytes every twentieth of a second: well over the pace, and never done in time.
                while not select.select([steady], [], [], 0.05)[0] and time.monotonic() - started < 5:
                    steady.sendall(b"y" * 100)
            except (ConnectionResetError, BrokenPipeError):
                pass
            assert 0.7 < time.monotonic() - started < 2.5
            assert answer_of(steady) in (TIMED_OUT, b"")
        # A body that arrives inside its time, in pieces, is read whole.
        with socket.create_connection(("127.0.0.1", port), timeout=5) as pieces:
            pieces.sendall(b"POST / HTTP/1.0\r\nContent-Length: 300000\r\n\r\n")
            for _ in range(3):
                pieces.sendall(b"z" * 100_000)
                time.sleep(0.05)
            assert answer_of(pieces).endswith(b"\r\n\r\n300000")
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_a_head_that_never_ends_a_body_with_no_length_and_too_much_held_at_once() -> None:
    class Small(Quick):
        buffered_most = 300_000

    httpd = serving(echo, Small)
    port = httpd.server_address[1]
    try:
        started = time.monotonic()
        assert ask(port, b"POST / HTTP/1.1\r\nHost: a\r\nContent-Le") == TIMED_OUT
        assert time.monotonic() - started < 2
        with socket.create_connection(("127.0.0.1", port), timeout=5) as silent:
            assert answer_of(silent) == b"", "one that sent nothing is closed with nothing said"
        # Nothing says how much of a chunked body to wait for, so it is refused at once.
        started = time.monotonic()
        chunked = ask(port, b"POST / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n")
        assert chunked.startswith(b"HTTP/1.1 411 Length Required\r\nConnection: close\r\n") and time.monotonic() - started < 0.5
        # A body longer than its path may take is refused by its length, with none of it waited for.
        started = time.monotonic()
        with socket.create_connection(("127.0.0.1", port), timeout=5) as huge:
            huge.sendall(b"POST /e HTTP/1.0\r\nContent-Length: 20000\r\n\r\n")
            assert answer_of(huge).endswith(b"\r\n\r\n0"), "handed on at once; the app reads nothing of it"
            assert time.monotonic() - started < 0.4
        # Requests still arriving hold only so much memory between them; past it a body is turned away.
        first = socket.create_connection(("127.0.0.1", port), timeout=5)
        second = socket.create_connection(("127.0.0.1", port), timeout=5)
        try:
            for connection in (first, second):
                connection.sendall(b"POST /api/links/import HTTP/1.1\r\nHost: a\r\nContent-Length: 400000\r\n\r\n" + b"x" * 200_000)
            turned_away = [answer_of(first, 3), answer_of(second, 3)]
            assert any(answer.startswith(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 30\r\n") for answer in turned_away), turned_away
        finally:
            first.close()
            second.close()
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_the_standalone_server_answers_runlights_own_routes_through_it() -> None:
    server = standalone.create_server({"store": Stores.sqlite(":memory:"), "secret": "s" * 64, "setupCode": "setup-code"})
    server.runlight.init()
    httpd = serving(standalone.wsgi_app(server))
    port = httpd.server_address[1]
    try:
        assert ask(port, b"GET /healthz HTTP/1.0\r\n\r\n").endswith(b"ok")
        body = b'{"k":"pageview","u":"https://example.com/"}'
        hit = b"POST /e HTTP/1.1\r\nHost: stats.example.com\r\nUser-Agent: " + CHROME.encode() + b"\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n"
        # The body comes a moment after the head, as from a slow phone: waited for, then answered as ever.
        with socket.create_connection(("127.0.0.1", port), timeout=5) as late:
            late.sendall(hit)
            time.sleep(0.15)
            late.sendall(body)
            assert answer_of(late).startswith(b"HTTP/1.0 202")
        with socket.create_connection(("127.0.0.1", port), timeout=5) as never:
            never.sendall(hit + body[:10])
            assert answer_of(never) == TIMED_OUT
    finally:
        httpd.shutdown()
        httpd.server_close()


# The WSGI adapter, under any server.


class Dripping(io.RawIOBase):
    """A request body as a server hands it over: a little at a time, for as long as it is asked."""

    def __init__(self, piece: bytes, every: float, reads: list[float] | None = None) -> None:
        self.piece = piece
        self.every = every
        self.reads = reads if reads is not None else []

    def readable(self) -> bool:
        return True

    def read(self, size: int = -1) -> bytes:
        time.sleep(self.every)
        self.reads.append(time.monotonic())
        return self.piece[:size]


def wsgi_ask(middleware: Any, environ: dict[str, Any]) -> tuple[str, bytes]:
    statuses: list[str] = []
    body = middleware(
        {"REQUEST_METHOD": "POST", "HTTP_HOST": "example.com", "wsgi.url_scheme": "https", "REMOTE_ADDR": "203.0.113.9", **environ},
        lambda status, headers: statuses.append(status),
    )
    return statuses[0], b"".join(body)


def test_the_wsgi_adapter_gives_up_on_a_body_that_drips_in(monkeypatch: pytest.MonkeyPatch) -> None:
    def hello(environ: Any, start_response: Any) -> list[bytes]:
        start_response("200 OK", [("content-type", "text/plain")])
        return [b"the app"]

    rl = make()
    middleware = WsgiMiddleware(hello, rl, routes=rl.routes({"token": "t"}))
    monkeypatch.setattr(serve, "BODY_SECONDS", 0.3)
    drip = Dripping(b"x", 0.02)
    started = time.monotonic()
    status, body = wsgi_ask(middleware, {"PATH_INFO": "/runlight/api/links/import", "CONTENT_LENGTH": "100000", "wsgi.input": drip, "HTTP_AUTHORIZATION": "Bearer t"})
    assert (status, body) == ("408 Request Timeout", b"")
    assert 0.25 < time.monotonic() - started < 1.5, "the body's whole time, not one wait for each byte of it"
    assert len(drip.reads) < 60

    # With no length given (chunked, as the server decodes it) it is the same.
    status, _ = wsgi_ask(middleware, {"PATH_INFO": "/runlight/e", "wsgi.input_terminated": True, "wsgi.input": Dripping(b"x", 0.02)})
    assert status == "408 Request Timeout"
    # A read the server itself times out is a body that came too slowly, never an error page.

    class TimesOut(io.RawIOBase):
        def read(self, size: int = -1) -> bytes:
            raise TimeoutError("timed out")

    status, _ = wsgi_ask(middleware, {"PATH_INFO": "/runlight/e", "CONTENT_LENGTH": "10", "wsgi.input": TimesOut()})
    assert status == "408 Request Timeout"

    # A body that comes in time, in pieces, is read whole; and the app's own bodies are never read here at all.
    monkeypatch.setattr(serve, "BODY_SECONDS", 5.0)
    whole = b'{"k":"pageview","u":"https://example.com/"}'
    status, _ = wsgi_ask(middleware, {"PATH_INFO": "/runlight/e", "CONTENT_LENGTH": str(len(whole)), "wsgi.input": io.BufferedReader(io.BytesIO(whole)), "HTTP_USER_AGENT": CHROME})
    assert status == "202 Accepted"
    assert len(rl.store.db.all("SELECT 1 FROM rl_events")) == 1
    untouched = Dripping(b"x", 0.0)
    assert wsgi_ask(middleware, {"PATH_INFO": "/upload", "CONTENT_LENGTH": "100000", "wsgi.input": untouched}) == ("200 OK", b"the app")
    assert untouched.reads == []


def test_django_under_wsgi_gives_up_on_a_body_that_drips_in(monkeypatch: pytest.MonkeyPatch) -> None:
    pytest.importorskip("django")
    from runlight.django import _TooLarge, to_request

    class Slow:
        method = "POST"
        path = "/runlight/api/links/import"
        scheme = "https"
        META = {"CONTENT_LENGTH": "100000", "REMOTE_ADDR": "203.0.113.9"}
        headers: dict[str, str] = {}

        def __init__(self) -> None:
            self.reads = 0

        def get_full_path(self) -> str:
            return self.path

        def get_host(self) -> str:
            return "example.com"

        def read(self, size: int) -> bytes:
            self.reads += 1
            time.sleep(0.02)
            return b"x"

    monkeypatch.setattr(serve, "BODY_SECONDS", 0.3)
    slow = Slow()
    started = time.monotonic()
    with pytest.raises(serve.BodyTooSlow):
        to_request(slow)
    assert 0.25 < time.monotonic() - started < 1.5 and slow.reads < 60
    assert serve.too_slow().status == 408 and serve.too_slow().headers.get("connection") == "close"
    assert _TooLarge is not serve.BodyTooSlow


# The ASGI adapter.


def test_the_asgi_adapter_gives_up_on_a_body_that_stalls_or_drips_in(monkeypatch: pytest.MonkeyPatch) -> None:
    rl = make()
    middleware = AsgiMiddleware(None, runlight=rl, routes=rl.routes({"token": "t"}))
    monkeypatch.setattr(serve, "BODY_SECONDS", 0.3)

    def play(path: str, messages: Any) -> tuple[int, dict[str, str], bytes, float]:
        scope = {
            "type": "http",
            "method": "POST",
            "scheme": "https",
            "path": path,
            "raw_path": path.encode(),
            "query_string": b"",
            "headers": [(b"host", b"example.com"), (b"user-agent", CHROME.encode())],
            "client": ("203.0.113.9", 50000),
        }
        sent: list[dict[str, Any]] = []

        async def send(message: dict[str, Any]) -> None:
            sent.append(message)

        started = time.monotonic()
        asyncio.run(middleware(scope, messages, send))
        start = next(m for m in sent if m["type"] == "http.response.start")
        headers = {k.decode(): v.decode() for k, v in start["headers"]}
        return start["status"], headers, b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body"), time.monotonic() - started

    async def stalls() -> dict[str, Any]:
        await asyncio.sleep(3600)
        return {"type": "http.disconnect"}

    async def drips() -> dict[str, Any]:
        await asyncio.sleep(0.02)
        return {"type": "http.request", "body": b"x", "more_body": True}

    for receive in (stalls, drips):
        status, headers, body, took = play("/runlight/api/links/import", receive)
        assert (status, body) == (408, b"") and headers.get("connection") == "close", receive.__name__
        assert 0.25 < took < 1.5

    whole = [{"type": "http.request", "body": b'{"k":"pageview",', "more_body": True}, {"type": "http.request", "body": b'"u":"https://example.com/"}', "more_body": False}]

    async def arrives() -> dict[str, Any]:
        await asyncio.sleep(0.01)
        return whole.pop(0)

    assert play("/runlight/e", arrives)[0] == 202
    middleware.executor.shutdown()

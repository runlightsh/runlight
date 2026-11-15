"""Runlight in an ASGI app (FastAPI, Starlette, Quart, Django under ASGI, or plain ASGI).

    from runlight.asgi import RunlightMiddleware

    app.add_middleware(RunlightMiddleware, runlight=rl)   # Starlette and FastAPI
    application = RunlightMiddleware(application, runlight=rl)   # any ASGI app

Requests under the routes' base path (default /runlight), `{linkPath}/{slug}` (default /go) for a link that exists,
and every request to a link domain added in Settings are Runlight's; everything else goes on to the app, a slug
with no link included, so the app's own 404 page answers it, and a page fetched by a known AI agent is recorded on
the way (observe=False turns that off). Runlight's work is synchronous, like the database
drivers it uses, so each of its requests runs in a worker thread and never holds up the event loop. Those threads
are Runlight's own, a fixed few (`threads`, default 8), so a long report never takes one the app's own code
would run on. A request that is the app's needs none: whether it is Runlight's is decided on the event loop, and
only reading the link domains again, every half minute, takes a thread.

A body for one of Runlight's own paths is read here, no further than the path may take (413 past it) and for no
longer than a minute in all (serve.BODY_SECONDS), whatever the server's own limits: after it the answer is 408 with
Connection: close, and the server closes the connection. A request for the app goes on with its body unread, so a
slow body sent to the app's own routes is the app's and the server's to limit.
"""

from __future__ import annotations

import asyncio
import urllib.parse
from collections.abc import Awaitable, Callable, Mapping, MutableMapping
from concurrent.futures import Executor, ThreadPoolExecutor
from typing import Any, TypeVar

from .http import Request, Response
from . import serve
from .serve import UNSUPPORTED, Front, body_limit, header_pairs, request_url, too_large, too_slow

Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]
AsgiApp = Callable[[Scope, Receive, Send], Awaitable[None]]
T = TypeVar("T")

# The threads Runlight's own work runs on, unless `threads` says another number.
THREADS = 8


async def _in(executor: Executor | None, fn: Callable[..., T], *args: Any) -> T:
    """Runs fn(*args) on a thread of `executor` (the loop's own without one) and gives its answer."""
    return await asyncio.get_running_loop().run_in_executor(executor, fn, *args)


def _headers(scope: Mapping[str, Any]) -> list[tuple[str, str]]:
    out = []
    for name, value in scope.get("headers", []):
        key = name.decode("latin-1").lower()
        try:
            text = value.decode("utf-8")
        except UnicodeDecodeError:
            text = value.decode("latin-1")
        out.append((key, text))
    return out


def _raw_path(scope: Mapping[str, Any]) -> str:
    raw = scope.get("raw_path")
    root = scope.get("root_path", "")
    if raw:
        path = raw.decode("latin-1")
        if root and not path.startswith(root):
            path = urllib.parse.quote(root) + path
    else:
        path = scope.get("path", "/")
        if root and not path.startswith(root):
            path = root + path
        path = urllib.parse.quote(path, safe="/:@!$&'()*+,;=-._~%")
    query = scope.get("query_string", b"").decode("latin-1")
    return path + (f"?{query}" if query else "")


def to_request(scope: Mapping[str, Any], body: bytes = b"") -> Request:
    """An ASGI HTTP scope and its body as a Request."""
    headers = _headers(scope)
    named = dict(headers)
    forwarded = (named.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    scheme = forwarded or scope.get("scheme", "http")
    server = scope.get("server")
    host = named.get("host") or (f"{server[0]}:{server[1]}" if server else "localhost")
    client = scope.get("client")
    return Request(
        request_url(scheme, host, _raw_path(scope)),
        scope.get("method", "GET"),
        headers,
        body,
        str(client[0]) if client else "",
    )


class _TooLarge(Exception):
    pass


async def _read_body(receive: Receive, limit: int) -> bytes | None:
    """The whole body, or None when the client went away first. Raises _TooLarge past the limit."""
    chunks = []
    size = 0
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return None
        chunk = message.get("body", b"")
        size += len(chunk)
        if size > limit:
            raise _TooLarge()
        chunks.append(chunk)
        if not message.get("more_body"):
            return b"".join(chunks)


async def send_response(send: Send, response: Response, head: bool = False, executor: Executor | None = None) -> None:
    """Sends a Response over ASGI, streamed when Runlight streams it (exports), its pieces read on a thread of
    `executor`."""
    pairs = header_pairs(response)
    if not response.streamed and not any(name == "content-length" for name, _ in pairs):
        pairs.append(("content-length", str(len(response.content()))))
    headers = [(k.encode("latin-1"), v.encode("utf-8")) for k, v in pairs]
    await send({"type": "http.response.start", "status": response.status, "headers": headers})
    if head:
        await send({"type": "http.response.body", "body": b""})
        return
    if not response.streamed:
        await send({"type": "http.response.body", "body": response.content()})
        return
    chunks = iter(response.chunks())
    while True:
        chunk = await _in(executor, next, chunks, None)
        if chunk is None:
            break
        await send({"type": "http.response.body", "body": chunk, "more_body": True})
    await send({"type": "http.response.body", "body": b""})


class RunlightMiddleware:
    """An ASGI app that answers Runlight's requests and hands the rest to `app` (a 404 without one)."""

    def __init__(
        self,
        app: AsgiApp | None = None,
        runlight: Any = None,
        routes: Any = None,
        observe: bool = True,
        threads: int = THREADS,
        **routes_options: Any,
    ) -> None:
        if runlight is None:
            raise ValueError("Runlight: pass runlight=, the Runlight to serve")
        self.app = app
        self.runlight = runlight
        if routes is None:
            routes = runlight.routes(**routes_options)
        self.front = Front(runlight, routes, observe)
        # Runlight's own threads, apart from the loop's, which the app's code shares.
        self.executor = ThreadPoolExecutor(max(1, int(threads)), thread_name_prefix="runlight-asgi")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            if self.app is not None:
                await self.app(scope, receive, send)
            elif scope.get("type") == "lifespan":
                while True:
                    message = await receive()
                    if message["type"] == "lifespan.startup":
                        await send({"type": "lifespan.startup.complete"})
                    elif message["type"] == "lifespan.shutdown":
                        await send({"type": "lifespan.shutdown.complete"})
                        return
            return
        method = str(scope.get("method", "GET")).upper()
        head = method == "HEAD"
        bare = to_request(scope)
        front = self.front
        work = self.executor
        # A request that is the app's is told apart here, on the event loop, wherever that needs nothing read.
        linked = None if front.no_link_domain(bare) else await _in(work, front.link_domain, bare)
        if linked is not None:
            await send_response(send, linked, head, work)
            await _in(work, self.runlight.idle)
            return
        if front.is_short_link(bare):
            short = await _in(work, front.short_link, bare, self.app is not None)
            if short is not None:
                await send_response(send, short, head, work)
                await _in(work, self.runlight.idle)
                return
        path = urllib.parse.urlsplit(bare.url).path
        if not front.owns(method, path):
            if front.watches(bare):
                await _in(work, front.watch, bare)
            if self.app is not None:
                await self.app(scope, receive, send)
            elif method in UNSUPPORTED:
                await send_response(send, Response("", 405), head)
            else:
                await send_response(send, Response("Not found", 404, {"content-type": "text/plain; charset=utf-8"}), head)
            return
        body = b""
        if method not in ("GET", "HEAD"):
            try:
                # The whole body has a minute to come, however steadily it comes: a client that sends a little at
                # a time is answered 408, and the server closes its connection.
                read = await asyncio.wait_for(_read_body(receive, body_limit(path)), serve.BODY_SECONDS)
            except _TooLarge:
                await send_response(send, too_large(), head)
                return
            except asyncio.TimeoutError:
                await send_response(send, too_slow(), head)
                return
            if read is None:
                return
            body = read
        response = await _in(work, front.answer, to_request(scope, body))
        await send_response(send, response, head, work)
        await _in(work, self.runlight.idle)

def app(runlight: Any, routes: Any = None, **routes_options: Any) -> RunlightMiddleware:
    """Runlight on its own as an ASGI app, such as for uvicorn."""
    return RunlightMiddleware(None, runlight, routes, observe=False, **routes_options)

"""Runlight in a WSGI app (Flask, Django, Bottle, Pyramid, or plain WSGI), as the Node adapter (node.ts) serves it
from Node's http module.

    from runlight.wsgi import RunlightMiddleware

    application = RunlightMiddleware(application, rl)   # rl.routes() under /runlight, /go/{slug}, link domains

Requests under the routes' base path (default /runlight), `{linkPath}/{slug}` (default /go) for a link that
exists, and every request to a link domain added in Settings are Runlight's; everything else goes on to the app,
a slug with no link included, so the app's own 404 page answers it, and a page fetched by a known AI agent is
recorded on the way (observe=False turns that off). Without an app, anything else is a 404.
The work a request starts after answering (a retention change's deletions) runs once the answer is sent.

A request's body is read here only for Runlight's own paths, no further than the path may take (413 past it) and
for no longer than a minute in all (serve.BODY_SECONDS; 408 after it), so a body that drips in is given up on. The
clock is looked at each time a piece of the body comes, which is as often as the server's input hands pieces over:
a server whose reads wait with no timeout of their own (gunicorn's gthread and gevent workers, uWSGI without
socket-timeout or harakiri) can still be held by a client that stops sending, and so can the app's own views,
which Runlight never sees. Set that server's timeout, or put a proxy that buffers request bodies in front (nginx
does unless told otherwise); gunicorn's sync worker ends such a request itself after its --timeout.

WSGI names a header by putting underscores for its dashes, so a server that passes on a header named
X_Forwarded_For gives it in the same place as X-Forwarded-For, and a client could then add to the address a proxy in
front wrote. gunicorn, Django's own server, and Runlight's standalone server drop such headers; with another server
behind a proxy, check that it does too, or have the proxy drop them (nginx does unless told otherwise).
"""

from __future__ import annotations

import http
import urllib.parse
from collections.abc import Callable, Iterable, Iterator, Mapping
from typing import Any

from .http import Request, Response
from .serve import HOP_BY_HOP, UNSUPPORTED, BodyTooSlow, Front, body_limit, header_pairs, read_within, request_url, too_large, too_slow

WsgiApp = Callable[[Mapping[str, Any], Callable[..., Any]], Iterable[bytes]]



class BodyTooLarge(Exception):
    """A body past the limit, answered with 413."""


def _raw_path(environ: Mapping[str, Any]) -> str:
    """The path and query as the client sent them: RAW_URI or REQUEST_URI when the server keeps them, else
    SCRIPT_NAME and PATH_INFO (which WSGI gives as latin-1 text of the decoded bytes) percent-encoded again."""
    raw = environ.get("RAW_URI") or environ.get("REQUEST_URI")
    if raw:
        raw = str(raw)
        if raw.startswith(("http://", "https://")):
            parts = urllib.parse.urlsplit(raw)
            raw = parts.path + (f"?{parts.query}" if parts.query else "")
        return raw
    path = (str(environ.get("SCRIPT_NAME", "")) + str(environ.get("PATH_INFO", ""))).encode("latin-1", "replace")
    quoted = urllib.parse.quote(path, safe="/:@!$&'()*+,;=-._~%")
    query = str(environ.get("QUERY_STRING", ""))
    return quoted + (f"?{query}" if query else "")


def _host(environ: Mapping[str, Any]) -> str:
    host = environ.get("HTTP_HOST")
    if host:
        return str(host)
    name = str(environ.get("SERVER_NAME", "localhost"))
    port = str(environ.get("SERVER_PORT", ""))
    scheme = environ.get("wsgi.url_scheme", "http")
    if not port or (scheme == "https" and port == "443") or (scheme == "http" and port == "80"):
        return name
    return f"{name}:{port}"


def to_request(environ: Mapping[str, Any], with_body: bool = True) -> Request:
    """A WSGI environ as a Request. The URL is the one the browser asked for; the address is the connection's,
    since Runlight reads proxy headers itself, only when trustProxy allows. Raises BodyTooLarge for a body past
    the limit."""
    headers: list[tuple[str, str]] = []
    for key, value in environ.items():
        if key.startswith("HTTP_"):
            headers.append((key[5:].replace("_", "-").lower(), _text(value)))
    if environ.get("CONTENT_TYPE"):
        headers.append(("content-type", _text(environ["CONTENT_TYPE"])))
    if environ.get("CONTENT_LENGTH"):
        headers.append(("content-length", _text(environ["CONTENT_LENGTH"])))
    forwarded = (dict(headers).get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    scheme = forwarded or str(environ.get("wsgi.url_scheme", "http"))
    raw = _raw_path(environ)
    url = request_url(scheme, _host(environ), raw)
    method = str(environ.get("REQUEST_METHOD", "GET")).upper()
    body = b""
    if with_body and method not in ("GET", "HEAD"):
        body = _read_body(environ, body_limit(raw.split("?")[0]))
    return Request(url, method, headers, body, str(environ.get("REMOTE_ADDR", "")))


def _text(value: Any) -> str:
    """A header value as text: WSGI gives latin-1 text of the bytes sent, which are UTF-8 in practice."""
    text = str(value)
    try:
        return text.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text


def _reader(stream: Any) -> Callable[[int], bytes]:
    """How a body is read a piece at a time: what has come so far where the stream can give it (read1), so the
    clock is looked at as the body arrives, else read(n), which waits for all n."""
    read1 = getattr(stream, "read1", None)
    return read1 if callable(read1) else stream.read


def _read_body(environ: Mapping[str, Any], limit: int) -> bytes:
    """The body, read no further than `limit` (BodyTooLarge past it) and for no longer than serve.BODY_SECONDS in
    all (BodyTooSlow)."""
    stream = environ.get("wsgi.input")
    if stream is None:
        return b""
    length = environ.get("CONTENT_LENGTH")
    if length:
        try:
            size = int(length)
        except ValueError:
            size = 0
        if size > limit:
            raise BodyTooLarge()
        return read_within(_reader(stream), size) if size > 0 else b""
    if environ.get("wsgi.input_terminated") or "chunked" in str(environ.get("HTTP_TRANSFER_ENCODING", "")).lower():
        data = read_within(_reader(stream), limit + 1)
        if len(data) > limit:
            raise BodyTooLarge()
        return data
    return b""


def send(response: Response, start_response: Callable[..., Any], head: bool = False) -> Iterable[bytes]:
    """Starts a WSGI response and gives its body, streamed when Runlight streams it (exports)."""
    try:
        phrase = http.HTTPStatus(response.status).phrase
    except ValueError:
        phrase = "Unknown"
    # WSGI leaves the connection to the server, which refuses hop-by-hop headers (wsgiref answers 500 for one), so
    # the 413's "connection: close" is the server's to decide.
    pairs = [(name, value) for name, value in header_pairs(response) if name not in HOP_BY_HOP]
    if not response.streamed and not any(name == "content-length" for name, _ in pairs):
        pairs.append(("content-length", str(len(response.content()))))
    start_response(f"{response.status} {phrase}", pairs)
    if head:
        return []
    return response.chunks()


class _After:
    """A response body that runs `then` once the server has sent it."""

    def __init__(self, body: Iterable[bytes], then: Callable[[], None]) -> None:
        self._body = body
        self._then = then

    def __iter__(self) -> Iterator[bytes]:
        return iter(self._body)

    def close(self) -> None:
        try:
            close = getattr(self._body, "close", None)
            if close is not None:
                close()
        finally:
            self._then()


class RunlightMiddleware:
    """A WSGI app that answers Runlight's requests and hands the rest to `app` (a 404 without one)."""

    def __init__(
        self,
        app: WsgiApp | None,
        runlight: Any,
        routes: Any = None,
        observe: bool = True,
        **routes_options: Any,
    ) -> None:
        self.app = app
        self.runlight = runlight
        if routes is None:
            routes = runlight.routes(**routes_options)
        self.front = Front(runlight, routes, observe)

    def __call__(self, environ: Mapping[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        method = str(environ.get("REQUEST_METHOD", "GET")).upper()
        head = method == "HEAD"
        bare = to_request(environ, with_body=False)
        linked = self.front.link_domain(bare)
        if linked is not None:
            return _After(send(linked, start_response, head), self.runlight.idle)
        short = self.front.short_link(bare, self.app is not None)
        if short is not None:
            return _After(send(short, start_response, head), self.runlight.idle)
        path = urllib.parse.urlsplit(bare.url).path
        if not self.front.owns(method, path):
            self.front.watch(bare)
            if self.app is not None:
                return self.app(environ, start_response)
            if method in UNSUPPORTED:
                return send(Response("", 405), start_response, head)
            return send(Response("Not found", 404, {"content-type": "text/plain; charset=utf-8"}), start_response, head)
        try:
            request = to_request(environ)
        except BodyTooLarge:
            return send(too_large(), start_response, head)
        except BodyTooSlow:
            return send(too_slow(), start_response, head)
        response = self.front.answer(request)
        return _After(send(response, start_response, head), self.runlight.idle)


def app(runlight: Any, routes: Any = None, **routes_options: Any) -> RunlightMiddleware:
    """Runlight on its own as a WSGI app, such as for gunicorn: `gunicorn 'myapp:application'` with
    `application = runlight.wsgi.app(rl)`."""
    return RunlightMiddleware(None, runlight, routes, observe=False, **routes_options)

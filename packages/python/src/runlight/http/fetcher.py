"""Outgoing requests, the Python stand-in for JavaScript's fetch()."""

from __future__ import annotations

import http.client
import socket
import ssl
import time
import zlib
from typing import Any, Protocol

from .headers import Headers
from .message import Response
from .url import Url


# Headers that carry a credential, dropped when a redirect leaves the origin they were sent to.
_CREDENTIALS = ("authorization", "cookie", "proxy-authorization", "x-api-key")


class FetchError(Exception):
    """No answer came back: the connection was refused, timed out, or failed TLS. fetch() rejects with a
    TypeError then."""

    def __init__(self, message: str, timed_out: bool = False) -> None:
        super().__init__(message)
        self.timed_out = timed_out


class BodyTooLong(Exception):
    """A body longer than the reader allows."""


class Fetcher(Protocol):
    """Everything that calls another server (mail services, importers, connected installs, the assistant's
    providers, site icons) goes through one, so tests can pass a fake.

    `init` takes the keys fetch's init does, where they apply:
    - method: str, default GET
    - headers: a dict or Headers
    - body: str or bytes
    - redirect: "follow" (default) or "manual", which hands back the 3xx answer
    - timeoutMs: int, the whole request's limit, default 30000
    - maxBytes: int, stop reading past this and raise BodyTooLong
    - truncate: bool, with maxBytes, hand back the first maxBytes instead of raising (the start of a page)
    - resolve: a list of "host:port:address" pins, so a checked address is the one connected to

    Raises FetchError when no answer comes back. A Fetcher given pins connects to the pinned address and nowhere
    else, never through a proxy (which would look the name up again itself), and refuses a request it has no pin
    for rather than fetch it unpinned.
    """

    def fetch(self, url: str, init: dict[str, Any] | None = None) -> Response: ...


class _PinnedHTTPS(http.client.HTTPSConnection):
    """An HTTPS connection to a pinned address, with the name kept for the certificate and SNI."""

    def __init__(self, name: str, address: str, port: int, timeout: float, context: ssl.SSLContext) -> None:
        super().__init__(name, port, timeout=timeout, context=context)
        self._address = address
        self._context = context

    def connect(self) -> None:
        sock = socket.create_connection((self._address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, name: str, address: str, port: int, timeout: float) -> None:
        super().__init__(name, port, timeout=timeout)
        self._address = address

    def connect(self) -> None:
        self.sock = socket.create_connection((self._address, self.port), self.timeout)


class UrllibFetcher:
    """Fetches with the standard library's http.client: redirects followed (up to 20) unless asked not to, with
    credentials dropped when one leaves their origin and none from https to http, one
    deadline for the whole request, gzip and deflate bodies decoded, and pins honoured. It connects directly, never
    through a proxy from HTTP_PROXY, HTTPS_PROXY, or the system's settings, so a pinned address is always the one
    connected to."""

    def fetch(self, url: str, init: dict[str, Any] | None = None) -> Response:
        init = init or {}
        method = str(init.get("method") or "GET").upper()
        headers = init.get("headers")
        headers = headers if isinstance(headers, Headers) else Headers(headers)
        body = init.get("body")
        data = body.encode("utf-8") if isinstance(body, str) else body
        max_bytes = init.get("maxBytes")
        truncate = bool(init.get("truncate"))
        follow = init.get("redirect", "follow") != "manual"
        timeout = int(init.get("timeoutMs") or 30_000) / 1000
        deadline = time.monotonic() + timeout
        pins = list(init.get("resolve") or [])
        for _ in range(21):
            status, answer, location, received = self._once(url, method, headers, data, max_bytes, truncate, deadline, pins)
            if follow and location is not None and status in (301, 302, 303, 307, 308):
                target = Url.parse(location, url)
                if target is None or target.protocol not in ("http:", "https:"):
                    raise FetchError("fetch failed")
                here = Url(url)
                # Never from an encrypted address to a plain one, where anything still sent could be read on the way.
                if here.protocol == "https:" and target.protocol == "http:":
                    raise FetchError("fetch failed: a redirect from https to http")
                # Credentials are for the address they were given to, so they go no further than its origin, as
                # fetch() drops them.
                if target.origin != here.origin:
                    headers = headers.copy()
                    for name in _CREDENTIALS:
                        headers.delete(name)
                if status == 303 or (status in (301, 302) and method == "POST"):
                    method = "GET" if method != "HEAD" else method
                    data = None
                    headers = headers.copy()
                    headers.delete("content-type")
                    headers.delete("content-length")
                url = target.href
                continue
            return Response(received, status, answer)
        raise FetchError("fetch failed: too many redirects")

    def _once(
        self,
        url: str,
        method: str,
        headers: Headers,
        data: bytes | None,
        max_bytes: int | None,
        truncate: bool,
        deadline: float,
        pins: list[str],
    ) -> tuple[int, Headers, str | None, bytes]:
        parsed = Url.parse(url)
        if parsed is None or parsed.protocol not in ("http:", "https:"):
            raise FetchError("fetch failed")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise FetchError("The operation was aborted due to timeout", True)
        port = int(parsed.port or (443 if parsed.protocol == "https:" else 80))
        name = parsed.hostname.strip("[]")
        address = None
        for pin in pins:
            host, _, rest = str(pin).partition(":")
            pin_port, _, pinned = rest.partition(":")
            if host.lower() == name.lower() and pin_port == str(port):
                # A pin may list several addresses ("a,[b]"), as curl's does; the first is the one connected to.
                address = pinned.split(",")[0].strip("[]")
                break
        # A request pinned to checked addresses goes nowhere else: one the pins do not cover is refused.
        if pins and not address:
            raise FetchError(f"fetch failed: {name} is not pinned to an address")
        try:
            if parsed.protocol == "https:":
                context = ssl.create_default_context()
                if address is not None:
                    conn: http.client.HTTPConnection = _PinnedHTTPS(name, address, port, remaining, context)
                else:
                    conn = http.client.HTTPSConnection(name, port, timeout=remaining, context=context)
            elif address is not None:
                conn = _PinnedHTTP(name, address, port, remaining)
            else:
                conn = http.client.HTTPConnection(name, port, timeout=remaining)
            path = (parsed.pathname or "/") + parsed.search
            conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            if not headers.has("host"):
                conn.putheader("Host", parsed.host)
            if not headers.has("accept-encoding"):
                conn.putheader("Accept-Encoding", "gzip, deflate")
            if not headers.has("accept"):
                conn.putheader("Accept", "*/*")
            for header, value in headers.pairs():
                conn.putheader(header, value)
            if data is not None and method not in ("GET", "HEAD"):
                if not headers.has("content-length"):
                    conn.putheader("Content-Length", str(len(data)))
                conn.endheaders(data)
            else:
                conn.endheaders()
            response = conn.getresponse()
            answer = Headers()
            for header, value in response.getheaders():
                answer.append(header, value)
            encoding = (answer.get("content-encoding") or "").lower().strip()
            decoder = None
            if encoding == "gzip":
                decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
            elif encoding == "deflate":
                decoder = zlib.decompressobj()
            received = bytearray()

            def over() -> bool:
                """Whether the body ran past the cap: cut at it with `truncate`, and otherwise refused."""
                if max_bytes is None or len(received) <= max_bytes:
                    return False
                if truncate:
                    del received[max_bytes:]
                    return True
                raise BodyTooLong(f"Body over {max_bytes} bytes")

            if method != "HEAD":
                cut = False
                while not cut:
                    if time.monotonic() > deadline:
                        raise FetchError("The operation was aborted due to timeout", True)
                    chunk = response.read1(65536) if hasattr(response, "read1") else response.read(65536)
                    if not chunk:
                        break
                    if decoder is not None:
                        # Inflated no further than one byte past the cap, so a small body that inflates without end
                        # stops where a plain one would. Short of that, the whole chunk went in.
                        chunk = decoder.decompress(chunk) if max_bytes is None else decoder.decompress(chunk, max_bytes - len(received) + 1)
                    received += chunk
                    cut = over()
                if decoder is not None and not cut:
                    received += decoder.flush()
                    over()
            conn.close()
            if decoder is not None:
                answer.delete("content-encoding")
                answer.delete("content-length")
            return response.status, answer, answer.get("location"), bytes(received)
        except (TimeoutError, socket.timeout):
            raise FetchError("The operation was aborted due to timeout", True) from None
        except BodyTooLong:
            raise
        except FetchError:
            raise
        except (OSError, http.client.HTTPException, zlib.error) as error:
            raise FetchError(f"fetch failed: {error}") from None

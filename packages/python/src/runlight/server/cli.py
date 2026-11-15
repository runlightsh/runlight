"""`runlight`: the standalone server and its commands, the Python counterpart of `npx runlight.sh` (packages/server's
cli.ts). Settings come from the environment:

    PORT              where to listen (3000)
    HOST              which address to listen on (0.0.0.0)
    DATA_DIR          where the SQLite file and the secret live (./runlight-data)
    DATABASE_URL      a postgres://, mysql://, or mariadb:// URL, to use that database instead of SQLite
    RUNLIGHT_SECRET   signs sessions and encrypts saved keys (made and kept in DATA_DIR if unset)
    RUNLIGHT_TOKEN    also accepted as a bearer token on the API
    RUNLIGHT_URL      the dashboard's public address, which can never become a link domain
    TRUST_PROXY       unset believes forwarded addresses only from a private network; "false" never,
                      "true" from anywhere, or the one header a CDN sets, such as cf-connecting-ip
    RUNLIGHT_GEO      city (the default), country, off, or the path to an MMDB file
    RUNLIGHT_AGENT_RANGES  on (the default) downloads the AI agents' published address lists daily; off
                      keeps the lists that came with this version
    CRON_SECRET       lets a scheduler run the check over HTTP, at POST /api/check
    RUNLIGHT_OBSERVE_KEY  one key for every site's AI agent reports
"""

from __future__ import annotations

import collections
import io
import re
import selectors
import signal
import socket
import sys
import threading
import time
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import IO, Any
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from ..env import env_value
from .secret import secret_in, short_warning

HELP = """Runlight {version}, privacy friendly web analytics for any number of sites.

Usage:
  runlight                      Start the server
  runlight password <email>     Make an account, or give one a new password
  runlight check                Run the scheduled check once, and fetch this month's location data
  runlight migrate              Create or update Runlight's tables
  runlight agents --log <file>  Count AI agents from a web server's access log
  runlight --version            Print the version

Settings are environment variables. PORT (3000) and HOST (0.0.0.0) set where it
listens. DATA_DIR (./runlight-data) holds the SQLite file and the secret, and
DATABASE_URL switches to Postgres, MySQL, or MariaDB. RUNLIGHT_SECRET signs
sessions and encrypts saved keys, RUNLIGHT_TOKEN also works as a bearer token
on the API. Forwarded addresses count only from a proxy on this computer or a
private network; TRUST_PROXY=false ignores them, and behind a CDN that connects
from public addresses, TRUST_PROXY names its header, such as cf-connecting-ip.
RUNLIGHT_URL is the dashboard's public address, such as
https://stats.example.com, which short links can never take over.
RUNLIGHT_GEO picks where locations come from when no platform header gives
them. It is city by default, which downloads DB-IP's free city database into
DATA_DIR and refreshes it each month. Set it to country for a smaller file, to
off, or to the path of your own MMDB file.
RUNLIGHT_AGENT_RANGES=off stops the daily download of the address lists AI
companies publish, which AI agent fetches are checked against; the lists that
came with this version are used instead.

Docs: https://runlight.sh/docs/python/
"""

AGENTS_HELP = """Count AI agents on a site that has only the script tag, from its web server's log.

Usage:
  runlight agents --log /var/log/nginx/access.log --to https://stats.example.com --key rlo_...

  --log <file>    The access log, in nginx or Apache's combined format, or Caddy's JSON
  --to <url>      Your Runlight, as its dashboard address (or RUNLIGHT_URL)
  --key <key>     The site's agents key from Settings, Install (or RUNLIGHT_OBSERVE_KEY)
  --site <url>    The site's address, such as https://example.com, when the log has no host in it
  --follow        Keep running and send fetches as they happen
  --state <file>  Remember where it stopped, so the next run, or a restarted --follow, starts there.
                  Only one run at a time can use it.

Docs: https://runlight.sh/docs/python/#ai-agents-from-a-log
"""


def _version() -> str:
    from ..version import VERSION

    return VERSION


class Settings:
    """The server's settings, from the environment."""

    def __init__(self) -> None:
        self.data_dir = Path(env_value("DATA_DIR") or "./runlight-data").resolve()
        self._store: Any = None

    def store(self) -> Any:
        from ..store import Stores

        if self._store is None:
            url = env_value("DATABASE_URL")
            if url and re.match(r"(postgres(ql)?|mysql|mariadb)://", url, re.I):
                self._store = Stores.url(url)
            else:
                self.data_dir.mkdir(parents=True, exist_ok=True)
                self._store = Stores.sqlite(str(self.data_dir / "runlight.db"))
        return self._store

    def where(self) -> str:
        database = env_value("DATABASE_URL") or ""
        if re.match(r"postgres(ql)?://", database):
            return "Postgres"
        if database.startswith("mysql://"):
            return "MySQL"
        if database.startswith("mariadb://"):
            return "MariaDB"
        return str(self.data_dir / "runlight.db")

    def secret(self) -> str:
        """RUNLIGHT_SECRET, or one made on first run and kept beside the data, readable only by this user."""
        given = env_value("RUNLIGHT_SECRET")
        if given:
            return given
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return secret_in(self.data_dir)

    def url(self) -> str | None:
        url = env_value("RUNLIGHT_URL")
        if url and not re.fullmatch(r"https?://[^/?#]+/?", url):
            raise ValueError("Set RUNLIGHT_URL to the dashboard's address only, such as https://stats.example.com")
        return url

    def trust_proxy(self) -> bool | str | None:
        """TRUST_PROXY: "false" with nothing in front, "true" for a CDN that connects from public addresses, or the
        one header your proxy sets, such as cf-connecting-ip behind Cloudflare. Unset stays None, so the library's
        default applies: forwarding headers count only from a private address. Anything else is a mistake, said so
        rather than guessed at, since "0" or "off" read as on would let any client choose its address."""
        given = env_value("TRUST_PROXY")
        value = (given or "").strip().lower()
        if not value:
            return None
        if value in ("true", "1", "yes", "on"):
            return True
        if value in ("false", "0", "no", "off"):
            return False
        if value in ("x-forwarded-for", "x-real-ip", "cf-connecting-ip"):
            return value
        raise ValueError(f'Set TRUST_PROXY to true, false, or the header your proxy sets (x-forwarded-for, x-real-ip, or cf-connecting-ip), not "{given}"')

    def agent_ranges(self) -> bool:
        """RUNLIGHT_AGENT_RANGES: on (the default) downloads the AI agents' published address lists once a day; off
        keeps the lists that came with this version."""
        value = env_value("RUNLIGHT_AGENT_RANGES")
        if value is None or value == "on":
            return True
        if value == "off":
            return False
        raise ValueError("Set RUNLIGHT_AGENT_RANGES to on or off")

    def geo(self) -> tuple[Any, Any]:
        """The DB-IP download (or None) and the lookup to use (or None)."""
        from .dbip import DbIp, file_lookup

        setting = env_value("RUNLIGHT_GEO") or "city"
        if setting in ("city", "country"):
            dbip = DbIp(str(self.data_dir / "geo"), setting)
            return dbip, dbip.lookup
        if setting == "off":
            return None, None
        return None, file_lookup(str(Path(setting).resolve()))

    def server(self, **more: Any) -> Any:
        from .standalone import create_server

        dbip, lookup = self.geo()
        options: dict[str, Any] = {
            "store": self.store(),
            "secret": self.secret(),
            "token": env_value("RUNLIGHT_TOKEN"),
            "url": self.url(),
            "trustProxy": self.trust_proxy(),
            "updateAgentRanges": self.agent_ranges(),
            "geoCredit": dbip is not None,
            "cronSecret": env_value("CRON_SECRET"),
            "observeKey": env_value("RUNLIGHT_OBSERVE_KEY"),
            **more,
        }
        if lookup is not None:
            options["geo"] = lookup
        server = create_server(options)
        server.dbip = dbip
        return server


def _agents(args: Sequence[str], out: IO[str], err: IO[str]) -> int:
    def flag(name: str) -> str | None:
        if f"--{name}" in args:
            at = list(args).index(f"--{name}")
            return args[at + 1] if at + 1 < len(args) else None
        return None

    if "--help" in args or "-h" in args:
        out.write(AGENTS_HELP)
        return 0
    log = flag("log")
    to = flag("to") or env_value("RUNLIGHT_URL")
    key = flag("key") or env_value("RUNLIGHT_OBSERVE_KEY")
    if not log or not to or not key:
        err.write(AGENTS_HELP)
        return 1
    from .agents import run_agents

    options: dict[str, Any] = {"log": str(Path(log).resolve()), "to": to, "key": key, "follow": "--follow" in args}
    site = flag("site")
    state = flag("state")
    if site:
        options["site"] = site
    if state:
        options["state"] = str(Path(state).resolve())
    result = run_agents(options)
    return result if isinstance(result, int) else 0


def _password(settings: Settings, email: str | None, out: IO[str]) -> int:
    from ..accounts.crypto import base64url, random_bytes

    if not email:
        raise ValueError("Name the account: runlight password you@example.com")
    server = settings.server()
    server.runlight.init()
    password = base64url(random_bytes(12))
    existed = server.accounts.by_email(email) is not None
    user = server.accounts.set_password(email, password, time.time_ns() // 1_000_000)
    # Someone at the server is who they say, so a lost authenticator is no longer in the way.
    reset = bool(user.get("twoFactor"))
    if reset:
        server.accounts.disable_two_factor(user["id"])
    made = "New password" if existed else f"Account made, as {'the owner' if user.get('role') == 'owner' else 'an admin'},"
    out.write(f"{made} for {email.strip().lower()}: {password}\n")
    if reset:
        out.write("Two-factor sign-in is now off for this account; turn it on again under Account.\n")
    out.write("Sign in, and change it by running this again whenever you like.\n")
    settings.store().close()
    return 0


class _Waiting:
    """A connection whose request is still arriving: what has come, and what its head says is still to come."""

    __slots__ = ("client", "since", "seen", "need", "body_at", "body_since")

    def __init__(self, client: Any, since: float) -> None:
        self.client = client
        self.since = since
        self.seen = bytearray()
        # How many bytes the whole request is, once its head says, and where its body starts and when it did.
        self.need: int | None = None
        self.body_at = 0
        self.body_since = 0.0


class _ThreadingServer(WSGIServer):
    """Answers each request on one of a fixed number of threads, so a flood of connections waits its turn rather
    than starting a thread, and holding memory, for every one. A connection takes a thread only once its whole
    request has arrived, body and all: one thread reads every connection that is still sending, so ones held open
    and idle, a head sent a byte at a time, and a body that stalls or drips in never use up the threads and keep
    everyone else waiting. A request that does not arrive in time is answered 408 and its connection closed, as
    Node's own server answers one: the head has `head_seconds`, and then the body has `body_seconds` in all and
    must keep a fair pace, `pace` bytes for each second after the first `grace_seconds`. What is held for the
    requests still arriving is `buffered_most` bytes at most; past that a body is answered 503. A body with no
    Content-Length (chunked) is answered 411, since nothing says how much of it to wait for."""

    threads = 64
    # How long a connection has to send the head of its request before it is answered 408 and closed.
    head_seconds = 10.0
    # How long the body then has to arrive, however steadily it comes.
    body_seconds = 60.0
    # After this long, a body is waited for only while it has sent this many bytes for each second since.
    grace_seconds = 5.0
    pace = 8 * 1024
    # The most connections kept waiting; past that the one waiting longest is closed.
    waiting_most = 1024
    # The head is looked at as far as this many bytes; past that the request is the handler's to refuse.
    head_peek = 16 * 1024
    # The most held in memory for requests still arriving, all together.
    buffered_most = 64 * 1024 * 1024

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._pool = ThreadPoolExecutor(self.threads, thread_name_prefix="runlight-http")
        self._arrived: collections.deque[tuple[Any, Any]] = collections.deque()
        self._arrived_lock = threading.Lock()
        # What was read of each request before it got its thread, for its handler to read first.
        self._read_ahead: dict[Any, bytes] = {}
        self._wake_read, self._wake_write = socket.socketpair()
        self._wake_read.setblocking(False)
        self._closing = False
        self._watcher = threading.Thread(target=self._watch, name="runlight-heads", daemon=True)
        self._watcher.start()

    def process_request(self, request: Any, client_address: Any) -> None:
        with self._arrived_lock:
            self._arrived.append((request, client_address))
        try:
            self._wake_write.send(b"x")
        except OSError:
            pass

    def _watch(self) -> None:
        """Reads each new connection until its whole request is there, then hands it to a thread. One thread reads
        every connection that is still sending."""
        selector = selectors.DefaultSelector()
        selector.register(self._wake_read, selectors.EVENT_READ, None)
        waiting: dict[Any, _Waiting] = {}
        held = 0

        def drop(connection: Any) -> None:
            nonlocal held
            state = waiting.pop(connection, None)
            if state is not None:
                held -= len(state.seen)
            try:
                selector.unregister(connection)
            except (KeyError, ValueError, OSError):
                pass

        def close(connection: Any, answer: bytes = b"") -> None:
            drop(connection)
            if answer:
                try:
                    connection.send(answer)
                except OSError:
                    # Gone already, or not taking anything: closed all the same.
                    pass
            self.shutdown_request(connection)

        def hand(connection: Any) -> None:
            state = waiting[connection]
            drop(connection)
            try:
                connection.setblocking(True)
            except OSError:
                self.shutdown_request(connection)
                return
            self._read_ahead[connection] = bytes(state.seen)
            self._pool.submit(self._answer, connection, state.client)

        def look(connection: Any) -> None:
            """Reads what has come. Hands the connection to a thread when its request is whole, answers it when it
            cannot be waited for, closes it if it hung up, else keeps it."""
            nonlocal held
            state = waiting[connection]
            try:
                data = connection.recv(65536)
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                close(connection)
                return
            if not data:
                # Hung up before the request was whole: nothing to answer.
                close(connection)
                return
            state.seen += data
            held += len(data)
            if state.need is None:
                read = _head(bytes(state.seen[: self.head_peek + 4]), self.head_peek)
                if read is None:
                    return
                if read == _NO_LENGTH:
                    close(connection, _LENGTH_REQUIRED)
                    return
                state.body_at, length = read
                state.need = state.body_at + length
                state.body_since = time.monotonic()
            if len(state.seen) >= state.need:
                hand(connection)
            elif held > self.buffered_most:
                close(connection, _BUSY)

        try:
            while not self._closing:
                for key, _ in selector.select(0.25 if waiting else 1.0):
                    if key.fileobj is self._wake_read:
                        try:
                            while self._wake_read.recv(4096):
                                pass
                        except OSError:
                            pass
                    elif key.fileobj in waiting:
                        look(key.fileobj)
                now = time.monotonic()
                for connection, state in list(waiting.items()):
                    if state.need is None:
                        if now - state.since > self.head_seconds:
                            # Said only to one that began a request; one that sent nothing is just closed.
                            close(connection, _TIMED_OUT if state.seen else b"")
                        continue
                    waited = now - state.body_since
                    body = len(state.seen) - state.body_at
                    if waited > self.body_seconds or (waited > self.grace_seconds and body < self.pace * (waited - self.grace_seconds)):
                        close(connection, _TIMED_OUT)
                with self._arrived_lock:
                    arrived = list(self._arrived)
                    self._arrived.clear()
                for connection, client in arrived:
                    # Past the most, the connection waiting longest goes, so new ones are not shut out by idle ones.
                    while len(waiting) >= self.waiting_most:
                        close(next(iter(waiting)))
                    try:
                        connection.setblocking(False)
                        selector.register(connection, selectors.EVENT_READ, None)
                        waiting[connection] = _Waiting(client, time.monotonic())
                    except (OSError, ValueError):
                        self.shutdown_request(connection)
        finally:
            for connection in list(waiting):
                close(connection)
            selector.close()

    def _answer(self, request: Any, client_address: Any) -> None:
        try:
            self.finish_request(request, client_address)
        except Exception:
            self.handle_error(request, client_address)
        finally:
            self._read_ahead.pop(request, None)
            self.shutdown_request(request)

    def server_close(self) -> None:
        super().server_close()
        # A server that could not take its port is closed before it was ever set up.
        if not hasattr(self, "_watcher"):
            return
        self._closing = True
        try:
            self._wake_write.send(b"x")
        except OSError:
            pass
        self._watcher.join(timeout=5)
        self._wake_read.close()
        self._wake_write.close()
        self._pool.shutdown(wait=False, cancel_futures=True)


_HEAD_END = re.compile(rb"\r?\n\r?\n")
_CONTENT_LENGTH = re.compile(rb"^content-length:[ \t]*([0-9]{1,18})[ \t]*\r?$", re.I | re.M)
_TRANSFER_ENCODING = re.compile(rb"^transfer-encoding:", re.I | re.M)
_NO_LENGTH = (-1, -1)

# What the one thread that reads requests answers itself, each closing the connection. The first is Node's own
# answer to a request that took too long to arrive, which the TypeScript server gives.
_TIMED_OUT = b"HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n"
_LENGTH_REQUIRED = b"HTTP/1.1 411 Length Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
_BUSY = b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 30\r\nContent-Length: 0\r\n\r\n"


def _head(seen: bytes, head_peek: int) -> tuple[int, int] | None:
    """What a request's head says, once it is whole: where its body starts and how many bytes of it to wait for.
    None while the head is still coming, and _NO_LENGTH for a body whose length it does not give. Nothing is
    waited for after a head past `head_peek`, which is the handler's to refuse, nor for a body longer than its
    path may take, which is refused by its length alone."""
    from ..serve import body_limit

    end = _HEAD_END.search(seen, 0, head_peek)
    if end is None:
        return (len(seen), 0) if len(seen) >= head_peek else None
    head = seen[: end.start() + 2]
    length = _CONTENT_LENGTH.search(head)
    if length is None:
        return _NO_LENGTH if _TRANSFER_ENCODING.search(head) else (end.end(), 0)
    target = head.split(b"\n", 1)[0].split(b" ")
    path = target[1].split(b"?", 1)[0].decode("latin-1") if len(target) > 1 else ""
    size = int(length.group(1))
    return (end.end(), size if size <= body_limit(path) else 0)


class _Deadline(io.RawIOBase):
    """A request's reads on its thread: first what was read before it got the thread, which is the whole request
    as its head describes it, and then the connection, for anything the head did not account for. Each such read
    is given only the time left before the deadline, and must keep a fair pace (`pace` bytes for every second
    after `grace`), so nothing sent a byte at a time keeps the thread."""

    def __init__(self, connection: socket.socket, idle: float, deadline: float, grace: float = 5.0, pace: int = 8 * 1024, ahead: bytes = b"") -> None:
        self._connection = connection
        self._idle = idle
        self._deadline = deadline
        self._grace = grace
        self._pace = pace
        self._began = time.monotonic()
        self._read = 0
        self._ahead = memoryview(ahead)

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: Any) -> int:
        if self._ahead:
            count = min(len(buffer), len(self._ahead))
            buffer[:count] = self._ahead[:count]
            self._ahead = self._ahead[count:]
            return count
        now = time.monotonic()
        left = self._deadline - now
        # When what has arrived so far stops being enough, if nothing more comes.
        fair = self._began + self._grace + self._read / self._pace - now
        if left <= 0 or fair <= 0:
            raise TimeoutError("The request took too long to arrive")
        self._connection.settimeout(min(left, self._idle, fair))
        count = self._connection.recv_into(buffer)
        self._read += count
        return count


class _QuietHandler(WSGIRequestHandler):
    # A connection that sends nothing for this long is closed, so idle ones do not hold a thread for good.
    timeout = 30
    # What a request's thread reads from the connection itself (more than its head said was coming) has this long.
    request_seconds = 60.0
    # After this long, such a read goes on only while this many bytes have come for each second since.
    grace_seconds = 5.0
    pace = 8 * 1024

    def setup(self) -> None:
        super().setup()
        ahead = getattr(self.server, "_read_ahead", {}).pop(self.connection, b"")
        self.rfile = io.BufferedReader(
            _Deadline(self.connection, float(self.timeout), time.monotonic() + self.request_seconds, self.grace_seconds, self.pace, ahead)
        )

    def get_environ(self) -> dict[str, Any]:
        # WSGI names a header by putting underscores for its dashes, so X_Forwarded_For would land in the same
        # place as X-Forwarded-For, after it, and a client could add to the address a proxy in front wrote. Such
        # names are dropped, as gunicorn and Django's own server drop them; no browser or proxy sends one.
        for name in {name for name in self.headers.keys() if "_" in name}:
            del self.headers[name]
        return super().get_environ()

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        pass


def _start(settings: Settings, out: IO[str]) -> int:
    from .standalone import wsgi_app

    server = settings.server()
    server.runlight.init()
    # Said at every start, loudly, and the server still runs: an install with a short one must keep working.
    for name in ("RUNLIGHT_SECRET", "RUNLIGHT_TOKEN"):
        warning = short_warning(name, env_value(name))
        if warning:
            print(f"\n{warning}\n", file=sys.stderr)
    port = int(env_value("PORT") or 3000)
    host = env_value("HOST") or "0.0.0.0"
    try:
        httpd = make_server(host, port, wsgi_app(server), server_class=_ThreadingServer, handler_class=_QuietHandler)
    except OSError as error:
        # A port already taken, or an address that cannot be listened on, is said in a line, like any other trouble
        # at start.
        raise RuntimeError(f"could not listen on {host}:{port}: {error.strerror or error}") from None
    shown = "localhost" if host in ("0.0.0.0", "::") else host
    out.write(f"Runlight {_version()} is listening on http://{shown}:{port}\n")
    out.write(f"Data: {settings.where()}\n")
    try:
        if server.accounts.count() == 0:
            out.write(f"\nNo account yet. Open this link to create the first one:\n  http://{shown}:{port}/setup?code={server.setup_code}\n\n")
    except Exception as error:
        # The server is up and answering; only the setup link could not be worked out, which /setup still serves.
        print(f"Runlight: could not check for a first account {error!r}", file=sys.stderr)
    out.flush()

    stop = threading.Event()

    # The scheduled check (salts, email reports, retention, and rollups) and this month's location data: now, then
    # every five minutes.
    def tick() -> None:
        while not stop.is_set():
            try:
                server.check()
            except Exception as error:
                print(f"Runlight: the scheduled check failed {error!r}", file=sys.stderr)
            if server.dbip is not None:
                try:
                    server.dbip.refresh(time.time_ns() // 1_000_000)
                except Exception as error:
                    print(f"Runlight: could not refresh location data {error!r}", file=sys.stderr)
            stop.wait(5 * 60)

    threading.Thread(target=tick, daemon=True).start()

    def finish(*_: Any) -> None:
        stop.set()
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, finish)
    signal.signal(signal.SIGINT, finish)
    httpd.serve_forever()
    settings.store().close()
    return 0


def run(args: Sequence[str], out: IO[str] | None = None, err: IO[str] | None = None) -> int:
    """Runs one command and returns the exit code."""
    out = out or sys.stdout
    err = err or sys.stderr
    command = args[0] if args else None
    rest = list(args[1:])
    try:
        if command in ("--help", "-h", "help"):
            out.write(HELP.format(version=_version()))
            return 0
        if command in ("--version", "-v"):
            out.write(f"{_version()}\n")
            return 0
        if command == "agents":
            return _agents(rest, out, err)
        settings = Settings()
        if command == "password":
            return _password(settings, rest[0] if rest else None, out)
        if command == "migrate":
            settings.store().migrate(True)
            out.write(f"Runlight's tables are ready in {settings.where()}.\n")
            return 0
        if command in ("check", "cron"):
            server = settings.server()
            result = server.check()
            if server.dbip is not None:
                server.dbip.refresh(time.time_ns() // 1_000_000)
            failed = result.get("reports", {}).get("failed", 0)
            if failed:
                err.write(f"Runlight: {failed} report{'s' if failed != 1 else ''} could not be sent.\n")
            return 0
        if command and command != "start":
            raise ValueError(f'Unknown command "{command}". Run runlight --help.')
        return _start(settings, out)
    except Exception as error:
        err.write(f"Runlight: {error}\n")
        return 1


def main() -> None:
    sys.exit(run(sys.argv[1:]))


if __name__ == "__main__":  # pragma: no cover
    main()


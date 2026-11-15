"""Location for servers with no platform headers (Cloudflare, Vercel, and
Netlify send their own, and those always win), from DB-IP's free databases
(CC BY 4.0, https://db-ip.com), or any MMDB file the owner points at.

The port of packages/server/src/geo.ts. Downloaded on first start and
refreshed each month; lookups read the open file a page at a time.

A download is used only once it is checked: its SHA-1 against the one DB-IP
publishes on its download page, and the file itself as a DB-IP database of
the kind asked for, no older than the one in use. That catches a damaged or
swapped file, and a download server serving something else. It is not a
signature: DB-IP publishes none, so whoever can change DB-IP's own page can
change both. A checksum that does not match always refuses the download.
Only when none can be read at all (the page is down, or no longer reads as
it did) is a download accepted on the other checks alone, with a warning,
so a change to that page does not stop location data everywhere.
"""

from __future__ import annotations

import datetime
import hashlib
import http.client
import os
import re
import ssl
import time
import zlib
from collections.abc import Callable, Iterator
from typing import Any

from .. import _js
from ..http import Fetcher, Url
from ..mmdb import Mmdb

GeoLookup = Callable[[str], "dict[str, Any] | None"]

_DISTRICT = re.compile(f"[{_js.WHITESPACE}]*\\([^)]*\\)[{_js.WHITESPACE}]*\\Z")


def city_name(name: str) -> str:
    """A city as people say it: DB-IP adds districts in brackets, as in "Toronto (Old Toronto)"."""
    return _js.trim(_DISTRICT.sub("", name, count=1))


def _at(value: Any, *path: str | int) -> Any:
    """value?.a?.b, through a record read from a database: None where a step is missing."""
    for key in path:
        if isinstance(value, dict) and isinstance(key, str) and key in value:
            value = value[key]
        elif isinstance(value, list) and isinstance(key, int) and 0 <= key < len(value):
            value = value[key]
        else:
            return None
    return value


def lookup_from(reader: Any) -> GeoLookup:
    """A lookup from anything with get(ip): the Mmdb reader, or a stand-in. DB-IP's records follow MaxMind's city
    layout, with names but no subdivision codes. A lookup that fails answers None."""

    def lookup(ip: str) -> dict[str, Any] | None:
        try:
            found = reader.get(ip)
        except Exception:
            return None
        country = _at(found, "country", "iso_code")
        if not _js.truthy(country):
            return None
        sub = _at(found, "subdivisions", 0)
        region = _at(sub, "iso_code")
        if region is None:
            region = _at(sub, "names", "en")
        city = _at(found, "city", "names", "en")
        city = "" if city is None else city
        return {"country": country, "region": "" if region is None else region, "city": city_name(city) if isinstance(city, str) else city}

    return lookup


def file_lookup(file: str) -> GeoLookup:
    """A lookup from an MMDB file the owner supplies, such as MaxMind's GeoLite2 City."""
    return lookup_from(Mmdb.open(file))


def month(ms: int) -> str:
    """"2026-10", the month DB-IP names each release after."""
    return (datetime.datetime(1970, 1, 1, tzinfo=datetime.UTC) + datetime.timedelta(milliseconds=ms)).strftime("%Y-%m")


DAY = 86_400_000
# A release is built at the start of its month and stands in until the next appears, so one is two months old at
# most.
OLDEST_BUILD = 100 * DAY
# Addresses any location database knows: Google's and Cloudflare's resolvers, over IPv4 and IPv6.
KNOWN = ("8.8.8.8", "1.1.1.1", "2001:4860:4860::8888")

# How long after a first failed try the next one waits, and the longest any waits.
FIRST_WAIT = 5 * 60_000
LONGEST_WAIT = 6 * 3_600_000

# The most a database may unpack to, several times the city file's size, so a bad download cannot fill the disk.
MOST_BYTES = 512 * 1024 * 1024
# The most the download itself may weigh, and the least a database unpacks to (the country one is 8 MB).
MOST_PACKED_BYTES = 256 * 1024 * 1024
FEWEST_BYTES = 1024 * 1024
# The most of DB-IP's download page that is read; it is about 25 KB.
MOST_PAGE_BYTES = 1024 * 1024

_MARKER = b"\xab\xcd\xefMaxMind.com"
_COUNTRY = re.compile(r"[A-Z]{2}\Z")


class _Refused(Exception):
    """Why a page or a download was not used, in words for the log. `status` is the answer's, when it had one."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class _Answer:
    """One answer to a GET: its status, a header, and its body a piece at a time."""

    def __init__(self, status: int, header: Callable[[str], str | None], pieces: Iterator[bytes], close: Callable[[], None]) -> None:
        self.status = status
        self.header = header
        self.pieces = pieces
        self.close = close


def _direct(url: str, timeout_ms: int) -> _Answer:
    """One GET straight to an https address, with the standard library: no redirect is followed, since none is
    ever asked of the connection, and the body is read as it comes, so a city database is never held in memory.
    Each read waits a minute at most, and the whole answer `timeout_ms`."""
    parsed = Url.parse(url)
    if parsed is None or parsed.protocol != "https:":
        raise _Refused("it is not an https address")
    until = time.monotonic() + timeout_ms / 1000
    conn = http.client.HTTPSConnection(parsed.hostname, int(parsed.port or 443), timeout=min(60.0, timeout_ms / 1000), context=ssl.create_default_context())
    try:
        conn.request("GET", (parsed.pathname or "/") + parsed.search, headers={"accept": "*/*", "user-agent": "Runlight (+https://runlight.sh)"})
        response = conn.getresponse()
    except (OSError, http.client.HTTPException) as error:
        conn.close()
        raise _Refused(f"the request failed: {error}") from None

    def pieces() -> Iterator[bytes]:
        while True:
            if time.monotonic() > until:
                raise _Refused("it took too long")
            try:
                piece = response.read(65536)
            except (OSError, http.client.HTTPException) as error:
                raise _Refused(f"the download failed: {error}") from None
            if not piece:
                return
            yield piece

    return _Answer(response.status, lambda name: response.getheader(name), pieces(), conn.close)


def _through(fetcher: Fetcher, url: str, timeout_ms: int, most: int) -> _Answer:
    """One GET through a Fetcher, told to follow no redirect and to read no further than `most`."""
    from ..http import BodyTooLong, FetchError

    try:
        response = fetcher.fetch(url, {"redirect": "manual", "timeoutMs": timeout_ms, "maxBytes": most})
    except BodyTooLong:
        raise _Refused(_page_too_long() if most == MOST_PAGE_BYTES else _download_too_long()) from None
    except FetchError as error:
        raise _Refused(f"the request failed: {error}") from None
    return _Answer(response.status, response.headers.get, iter(response.chunks()), lambda: None)


def _page_too_long() -> str:
    return f"it is more than {MOST_PAGE_BYTES // 1024} KB"


def _download_too_long() -> str:
    return f"the download is more than {MOST_PACKED_BYTES / 1024 / 1024:g} MB"


def published_checksum(page: str, mode: str) -> dict[str, str] | None:
    """The release and SHA-1 on DB-IP's download page for the MMDB file of one kind: the last SHA1SUM before the
    link to that file, and after the link to any other. None when the page does not read that way."""
    link = re.search(rf"download\.db-ip\.com/free/dbip-{re.escape(mode)}-lite-([0-9]{{4}}-[0-9]{{2}})\.mmdb\.gz", page)
    if link is None:
        return None
    before = page[: link.start()]
    other = before.rfind("download.db-ip.com/free/dbip-")
    card = before[other if other >= 0 else 0 :]
    sums = re.findall(r"SHA1SUM[\s\S]{0,200}?\b([0-9a-f]{40})\b", card, re.I | re.ASCII)
    return {"release": link.group(1), "sha1": sums[-1].lower()} if sums else None


def check_database(source: bytes | str, mode: str, now: int, in_use: int | float = 0) -> None:
    """Raises ValueError unless `source` (a database's bytes, or the path of its file) is a DB-IP database of the
    kind asked for that a lookup can be made in: of a believable size, its search tree inside the file, built
    lately and not before the one in use (`in_use`, a time in milliseconds, or 0 for none), and answering for
    addresses everyone knows."""
    size = len(source) if isinstance(source, bytes) else os.path.getsize(source)
    if size < FEWEST_BYTES:
        raise ValueError(f"it unpacks to {size} bytes, too few for a location database")
    try:
        reader = Mmdb(source) if isinstance(source, bytes) else Mmdb.open(source)
    except Exception as error:
        if "no metadata" in str(error):
            raise ValueError("it is not an MMDB file") from None
        raise ValueError(f"it does not open as an MMDB file: {error}") from None
    try:
        meta = reader.metadata
        major = meta.get("binary_format_major_version")
        if major != 2:
            raise ValueError(f"its format is version {_js.string(major)}, not 2")
        kind = meta.get("database_type")
        if not isinstance(kind, str) or kind.lower() != f"dbip-{mode}-lite":
            raise ValueError(f'it is a "{_js.string(kind)}" database, not DB-IP\'s {mode} one')
        if meta.get("ip_version") != 6:
            raise ValueError(f"it covers IP version {_js.string(meta.get('ip_version'))}, not 6")
        record_size = meta.get("record_size")
        if record_size not in (24, 28, 32):
            raise ValueError(f"its records are {_js.string(record_size)} bits")
        nodes = meta.get("node_count")
        if not _js.is_number(nodes) or not nodes > 0 or nodes * record_size / 4 + 16 > reader.marker_at:
            raise ValueError("its search tree does not fit in the file")
        epoch = meta.get("build_epoch")
        built = epoch * 1000 if _js.is_number(epoch) else None
        if built is None or not built <= now + 2 * DAY or built < now - OLDEST_BUILD:
            raise ValueError(f"it was built on {'no date' if built is None else _day(built)}")
        if built < in_use:
            raise ValueError("it is older than the database in use")
        for ip in KNOWN:
            try:
                found = reader.get(ip)
            except Exception:
                found = None
            code = _at(found, "country", "iso_code")
            if not isinstance(code, str) or not _COUNTRY.match(code):
                raise ValueError(f"it has no country for {ip}")
    finally:
        reader.close()


def _day(ms: int | float) -> str:
    try:
        return (datetime.datetime(1970, 1, 1, tzinfo=datetime.UTC) + datetime.timedelta(milliseconds=ms)).strftime("%Y-%m-%d")
    except (OverflowError, ValueError):
        return "no date"


class DbIp:
    """Keeps a DB-IP database current in `dir` and answers lookups from it, as the TS server's Geo does. `mode` is
    "city" or "country". `lookup` answers nothing until the first file opens, so startup never waits; refresh()
    opens the newest file on disk, then fetches this month's if it is missing, and is safe to call often.

    Requests go straight to DB-IP over https, read as they come, unless a `fetcher` is given (which holds each
    answer in memory, so it is for tests). Either way no redirect is followed."""

    def __init__(self, dir: str, mode: str, log: Callable[[str], None] = print, fetcher: Fetcher | None = None) -> None:
        self.dir = dir
        self.mode = mode
        self._log = log
        self._fetcher = fetcher
        self._reader: Mmdb | None = None
        self._loaded = ""
        # After a try that left this month's file missing: how long the next waits, and when it may start.
        self._wait = 0
        self._retry_at = 0
        os.makedirs(dir, exist_ok=True)

    @property
    def release(self) -> str:
        """The release in use for lookups, or "" before there is one."""
        return self._loaded

    def lookup(self, ip: str) -> dict[str, Any] | None:
        return lookup_from(self._reader)(ip) if self._reader is not None else None

    def _file(self, release: str) -> str:
        return os.path.join(self.dir, f"dbip-{self.mode}-lite-{release}.mmdb")

    def newest(self) -> str | None:
        """The newest release on disk, or None before the first download."""
        found = sorted(
            name for name in os.listdir(self.dir) if name.startswith(f"dbip-{self.mode}-lite-") and name.endswith(".mmdb")
        )
        return os.path.join(self.dir, found[-1]) if found else None

    def _open(self, file: str) -> None:
        reader = Mmdb.open(file)
        if self._reader is not None:
            self._reader.close()
        self._reader = reader
        self._loaded = os.path.basename(file)[-12:-5]

    def refresh(self, now: int) -> None:
        """Opens the newest file on disk, then fetches this month's if it is missing. Safe to call often: while the
        month's file is not published yet, or a download keeps failing, each try waits twice as long as the last,
        from five minutes up to six hours, so neither DB-IP nor the disk is asked for the whole file every few
        minutes."""
        current = month(now)
        if self._loaded == current:
            return
        newest = self.newest()
        if newest and os.path.basename(newest) != os.path.basename(self._file(self._loaded or "none")):
            self._open(newest)
        if os.path.isfile(self._file(current)):
            return
        if now < self._retry_at:
            return
        try:
            self._fetch(current, now)
        finally:
            if os.path.isfile(self._file(current)):
                self._wait = 0
            else:
                self._wait = min(self._wait * 2 or FIRST_WAIT, LONGEST_WAIT)
                self._retry_at = now + self._wait

    def _get(self, url: str, timeout_ms: int, most: int) -> _Answer:
        """One GET that goes nowhere but where it was sent: https, and no redirect followed."""
        answer = _direct(url, timeout_ms) if self._fetcher is None else _through(self._fetcher, url, timeout_ms, most)
        if answer.status != 200:
            answer.close()
            raise _Refused(f"it answered {answer.status}", answer.status)
        return answer

    def _published(self) -> dict[str, str]:
        """The release DB-IP's download page offers for this kind of database, and the SHA-1 it gives for the
        unpacked file."""
        url = f"https://db-ip.com/db/download/ip-to-{self.mode}-lite"
        try:
            answer = self._get(url, 30_000, MOST_PAGE_BYTES)
            try:
                page = bytearray()
                for piece in answer.pieces:
                    page += piece
                    if len(page) > MOST_PAGE_BYTES:
                        raise _Refused(_page_too_long())
            finally:
                answer.close()
        except Exception as error:
            raise _Refused(f"could not read DB-IP's checksums at {url}: {error}") from None
        found = published_checksum(page.decode("utf-8", "replace"), self.mode)
        if found is None:
            raise _Refused(f"found no checksum for the {self.mode} database at {url}")
        return found

    def _fetch(self, release: str, now: int) -> None:
        # A new month's file appears a day or so after the month starts; until then, last month's is current.
        today = datetime.datetime(1970, 1, 1, tzinfo=datetime.UTC) + datetime.timedelta(milliseconds=now)
        tries = [release, (today.replace(day=15) - datetime.timedelta(days=30)).strftime("%Y-%m")]
        # The page says which release there is and what it must hash to, so only that file is asked for. When the
        # page cannot be read, the newest release there is goes unchecked against it, and the log says so.
        published: dict[str, str] | None = None
        unchecked = ""
        try:
            published = self._published()
        except _Refused as error:
            unchecked = str(error)
        if published is not None and published["release"] not in tries:
            self._log(f"Runlight: location data was not updated: DB-IP offers the {published['release']} release, which is neither this month's nor last month's")
            return
        for name in [published["release"]] if published is not None else tries:
            if os.path.isfile(self._file(name)):
                if self._loaded != name:
                    self._open(self._file(name))
                return
            url = f"https://download.db-ip.com/free/dbip-{self.mode}-lite-{name}.mmdb.gz"
            partial = f"{self._file(name)}.partial.{os.getpid()}"
            try:
                self._save(url, partial, published["sha1"] if published is not None else None, now)
                os.replace(partial, self._file(name))
                self._open(self._file(name))
                # Older releases go once the new one opens.
                for old in os.listdir(self.dir):
                    if old.startswith(f"dbip-{self.mode}-lite-") and old != os.path.basename(self._file(name)):
                        try:
                            os.unlink(os.path.join(self.dir, old))
                        except OSError:
                            pass
                if published is None:
                    self._log(
                        f"Runlight: warning: location data from DB-IP ({name}) could not be checked against DB-IP's published checksum ({unchecked}). It was accepted as a DB-IP database of the right kind, without that check."
                    )
                self._log(f"Runlight: location data from DB-IP ({name}) is ready.")
                return
            except Exception as error:
                try:
                    os.unlink(partial)
                except OSError:
                    pass
                # Without the page to say which release there is, this month's not being out yet is no failure.
                if published is None and getattr(error, "status", None) == 404:
                    continue
                # Whatever went wrong, the database in use stays in use.
                self._log(f"Runlight: location data was not updated from {url}: {error}")
        if published is None:
            self._log(f"Runlight: location data was not updated: {unchecked}, and no release could be downloaded without them")

    def _save(self, url: str, partial: str, sha1: str | None, now: int) -> None:
        """Downloads one release to `partial`, unpacked, and raises unless it is fit to use: the published SHA-1's
        (when there is one to hold it to), and a DB-IP database of this kind no older than the one in use."""
        answer = self._get(url, 10 * 60_000, MOST_PACKED_BYTES)
        try:
            if _js.number(answer.header("content-length") or 0) > MOST_PACKED_BYTES:
                raise _Refused(_download_too_long())
            digest = hashlib.sha1(usedforsecurity=False)
            unpack = zlib.decompressobj(16 + zlib.MAX_WBITS)
            packed = 0
            unpacked = 0
            with open(partial, "wb") as out:
                for piece in answer.pieces:
                    packed += len(piece)
                    if packed > MOST_PACKED_BYTES:
                        raise _Refused(_download_too_long())
                    # Nothing may follow the end of the gzip stream: what is kept is what was hashed, and no more.
                    if unpack.eof:
                        if piece:
                            raise _Refused("incorrect header check: there is more after the end of the gzip data")
                        continue
                    while piece:
                        try:
                            data = unpack.decompress(piece, 1 << 20)
                        except zlib.error as error:
                            raise _Refused(f"it is not gzip data: {error}") from None
                        unpacked += len(data)
                        if unpacked > MOST_BYTES:
                            raise _Refused(f"the location data is more than {MOST_BYTES / 1024 / 1024:g} MB")
                        digest.update(data)
                        out.write(data)
                        piece = unpack.unconsumed_tail
                        if unpack.eof:
                            if unpack.unused_data:
                                raise _Refused("incorrect header check: there is more after the end of the gzip data")
                            break
            if not unpack.eof:
                raise _Refused("unexpected end of file: the gzip data is cut short")
        finally:
            answer.close()
        got = digest.hexdigest()
        if sha1 is not None and got != sha1:
            raise _Refused(f"its SHA-1 is {got}, and DB-IP publishes {sha1}")
        in_use = self._reader.metadata.get("build_epoch") if self._reader is not None else 0
        check_database(partial, self.mode, now, in_use * 1000 if _js.is_number(in_use) else 0)

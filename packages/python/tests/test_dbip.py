"""The DB-IP download: checked against the checksum DB-IP publishes and read as a DB-IP database before it is used,
as packages/server/test/geo.test.ts tests the TypeScript's. Nothing here reaches the network."""

from __future__ import annotations

import calendar
import gzip
import hashlib
import os
import re
from collections.abc import Callable
from typing import Any

import pytest
from support.fake_fetcher import FakeFetcher

from runlight.http import Response
from runlight.server import dbip as module
from runlight.server.dbip import DbIp, check_database, published_checksum


def utc(year: int, month: int, day: int, hour: int = 0) -> int:
    """Date.UTC, with months from 1."""
    return calendar.timegm((year, month, day, hour, 0, 0)) * 1000


def encode(value: Any) -> bytes:
    """MMDB's data format, enough of it to write a database: maps, strings, arrays, and unsigned integers."""

    def control(kind: int, size: int) -> bytes:
        if kind >= 8:
            if size >= 29:
                raise ValueError("too long for this writer")
            return bytes([size, kind - 7])
        if size < 29:
            return bytes([(kind << 5) | size])
        if size < 285:
            return bytes([(kind << 5) | 29, size - 29])
        return bytes([(kind << 5) | 30, (size - 285) >> 8, (size - 285) & 255])

    if isinstance(value, str):
        text = value.encode("utf-8")
        return control(2, len(text)) + text
    if isinstance(value, int):
        size = 2 if value < 0x10000 else 4 if value < 0x100000000 else 8
        return control(5 if size == 2 else 6 if size == 4 else 9, size) + value.to_bytes(size, "big")
    if isinstance(value, list):
        return control(11, len(value)) + b"".join(encode(v) for v in value)
    return control(7, len(value)) + b"".join(encode(k) + encode(v) for k, v in value.items())


US = {"country": {"iso_code": "US", "names": {"en": "United States"}}, "city": {"names": {"en": "Mountain View"}}}


def mmdb(meta: dict[str, Any] | None = None, record: Any = US, pad: int = 1024 * 1024) -> bytes:
    """A whole MMDB file of one megabyte or so, in which every address has the same record. `meta` overrides the
    metadata, and `record` the record (None leaves every address without one)."""
    # One node whose two records both point at the first thing in the data section, or at "no data".
    pointer = 1 if record is None else 1 + 16
    node = bytes([0, 0, pointer, 0, 0, pointer])
    data = encode(record if record is not None else {}) + bytes(pad)
    metadata = encode(
        {
            "binary_format_major_version": 2,
            "binary_format_minor_version": 0,
            "build_epoch": utc(2026, 10, 1, 2) // 1000,
            "database_type": "DBIP-City-Lite",
            "description": {"en": "A test database"},
            "ip_version": 6,
            "languages": ["en"],
            "node_count": 1,
            "record_size": 24,
            **(meta or {}),
        }
    )
    return node + bytes(16) + data + b"\xab\xcd\xefMaxMind.com" + metadata


def sha1(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()


def page(mode: str, release: str, checksum: str) -> str:
    """DB-IP's download page as it reads, with the CSV file's card before the MMDB file's."""
    return f"""<div class="card"><dl class="card-body"><dt>Format</dt><dd>CSV</dd><dt>MD5SUM</dt>
<dd class="small">93c945395f0bc2ceefea7dd55750417a</dd><dt>SHA1SUM</dt><dd class="small">e2061015c43ec91c94a12191a6a613279eb94c0c</dd></dl>
<a href='https://download.db-ip.com/free/dbip-{mode}-lite-{release}.csv.gz' class='btn'>Download CSV</a></div>
<div class="card"><dl class="card-body"><dt>Format</dt><dd>MMDB</dd><dt>MD5SUM</dt><dd class="small">5974b336a7409ec854f67eacd52c2061</dd>
<dt>SHA1SUM</dt>
					<dd class="small">{checksum}</dd></dl>
<a href='https://download.db-ip.com/free/dbip-{mode}-lite-{release}.mmdb.gz' class='btn'>Download MMDB</a></div>"""


PAGE = "https://db-ip.com/db/download/ip-to-city-lite"
OCTOBER = utc(2026, 10, 3, 3)
Answers = dict[str, Callable[[], Response]]


def file_url(release: str) -> str:
    return f"https://download.db-ip.com/free/dbip-city-lite-{release}.mmdb.gz"


class Geo:
    """A DbIp whose downloads are answered from `answers`, by URL, with every URL asked for and every line logged
    kept."""

    def __init__(self, tmp_path: Any, answers: Answers, name: str = "geo") -> None:
        self.dir = str(tmp_path / name)
        self.asked: list[str] = []
        self.lines: list[str] = []
        self.answers = answers

        def answer(url: str, init: dict[str, Any]) -> Response:
            self.asked.append(url)
            assert init.get("redirect") == "manual", "no redirect is ever followed"
            found = self.answers.get(url)
            return found() if found else Response("nope", 404)

        self.geo = DbIp(self.dir, "city", self.lines.append, FakeFetcher(answer))

    def files(self) -> list[str]:
        return sorted(os.listdir(self.dir))


def release(name: str, file: bytes, checksum: str | None = None) -> Answers:
    """Answers for one release: the page with `checksum` (the file's own by default), and the file, gzipped."""
    return {PAGE: lambda: Response(page("city", name, sha1(file) if checksum is None else checksum)), file_url(name): lambda: Response(gzip.compress(file))}


def test_a_download_whose_checksum_matches_db_ips_page_is_put_to_use(tmp_path: Any) -> None:
    file = mmdb()
    t = Geo(tmp_path, release("2026-10", file))
    t.geo.refresh(OCTOBER)
    assert t.asked == [PAGE, file_url("2026-10")]
    assert t.geo.release == "2026-10"
    assert t.geo.lookup("8.8.8.8") == {"country": "US", "region": "", "city": "Mountain View"}
    assert t.files() == ["dbip-city-lite-2026-10.mmdb"]
    with open(os.path.join(t.dir, "dbip-city-lite-2026-10.mmdb"), "rb") as kept:
        assert sha1(kept.read()) == sha1(file)
    assert "(2026-10) is ready" in "\n".join(t.lines)
    assert not any("warning" in line for line in t.lines)


def test_early_in_a_month_the_page_still_offers_last_months_release_and_that_is_the_one_fetched(tmp_path: Any) -> None:
    t = Geo(tmp_path, release("2026-09", mmdb({"build_epoch": utc(2026, 9, 1) // 1000})))
    t.geo.refresh(utc(2026, 10, 1, 3))
    assert t.asked == [PAGE, file_url("2026-09")]
    assert t.geo.release == "2026-09"
    t.geo.refresh(utc(2026, 10, 1, 4))
    assert t.asked[2:] == [PAGE], "later the page is read again, and the file on disk is not fetched twice"


def test_a_download_that_does_not_match_the_published_checksum_is_never_used_and_the_database_in_use_stays(tmp_path: Any) -> None:
    good = mmdb({"build_epoch": utc(2026, 9, 1) // 1000})
    t = Geo(tmp_path, release("2026-09", good))
    t.geo.refresh(utc(2026, 9, 20))
    assert t.geo.release == "2026-09"

    # October's file is not the one DB-IP's page describes: one byte differs.
    swapped = mmdb({}, {"country": {"iso_code": "ZZ"}})
    t.answers.update(release("2026-10", swapped, sha1(mmdb())))
    t.geo.refresh(OCTOBER)
    assert t.geo.release == "2026-09", "last month's is still in use"
    assert t.geo.lookup("8.8.8.8") == {"country": "US", "region": "", "city": "Mountain View"}
    assert t.files() == ["dbip-city-lite-2026-09.mmdb"], "nothing of the bad download is left"
    assert t.lines[-1] == f"Runlight: location data was not updated from {file_url('2026-10')}: its SHA-1 is {sha1(swapped)}, and DB-IP publishes {sha1(mmdb())}"

    # Bytes after the end of the gzip stream never reach the file: what is kept is what was hashed.
    october = mmdb()
    t.answers.update(release("2026-10", october))
    t.answers[file_url("2026-10")] = lambda: Response(gzip.compress(october) + b"extra")
    t.geo.refresh(OCTOBER + 6 * 3_600_000)
    assert t.asked[-1] == file_url("2026-10"), "it was asked for again"
    for name in t.files():
        with open(os.path.join(t.dir, name), "rb") as kept:
            assert sha1(kept.read()) in (sha1(good), sha1(october)), "only checked bytes are on disk"
    assert t.geo.release == "2026-09" and t.files() == ["dbip-city-lite-2026-09.mmdb"]


def test_when_no_checksum_can_be_read_at_all_the_newest_release_is_taken_on_its_structure_alone_with_a_warning(tmp_path: Any) -> None:
    file = mmdb()
    ways: list[tuple[str, Callable[[], Response], str]] = [
        ("the page is down", lambda: Response("no", 503), r"could not read DB-IP's checksums.*answered 503"),
        ("the page redirects", lambda: Response("", 302, {"location": "https://elsewhere.example/"}), r"answered 302"),
        ("the page has no checksum", lambda: Response(page("city", "2026-10", "")), r"found no checksum"),
        ("the page is for another database", lambda: Response(page("country", "2026-10", sha1(file))), r"found no checksum"),
        ("the page never ends", lambda: Response("x" * (2 * 1024 * 1024)), r"more than 1024 KB"),
    ]
    for i, (what, answer, why) in enumerate(ways):
        t = Geo(tmp_path, {**release("2026-10", file), PAGE: answer}, f"way{i}")
        t.geo.refresh(OCTOBER)
        assert t.asked == [PAGE, file_url("2026-10")], what
        assert t.geo.release == "2026-10", what
        assert t.files() == ["dbip-city-lite-2026-10.mmdb"], what
        warnings = [line for line in t.lines if "could not be checked against DB-IP's published checksum" in line]
        assert len(warnings) == 1, what
        assert warnings[0].startswith("Runlight: warning: location data from DB-IP (2026-10)"), what
        assert re.search(why, warnings[0]), what
        assert warnings[0].endswith("It was accepted as a DB-IP database of the right kind, without that check."), what

    # As before the page was read: this month's file, then last month's, and a month not out yet is no failure.
    early = Geo(tmp_path, {file_url("2026-09"): lambda: Response(gzip.compress(mmdb({"build_epoch": utc(2026, 9, 1) // 1000})))}, "early")
    early.geo.refresh(utc(2026, 10, 1, 3))
    assert early.asked == [PAGE, file_url("2026-10"), file_url("2026-09")]
    assert early.geo.release == "2026-09"
    assert [line[:50] for line in early.lines] == ["Runlight: warning: location data from DB-IP (2026-", "Runlight: location data from DB-IP (2026-09) is re"]

    # The other checks still hold: what is not a DB-IP city database is not used, checksum or no checksum.
    wrong = Geo(tmp_path, {file_url("2026-10"): lambda: Response(gzip.compress(mmdb({"database_type": "GeoLite2-City"})))}, "wrong")
    wrong.geo.refresh(OCTOBER)
    assert wrong.geo.release == ""
    assert wrong.files() == []
    assert re.search(r'not updated from .*2026-10\.mmdb\.gz: it is a "GeoLite2-City" database', "\n".join(wrong.lines))
    assert re.search(r"not updated: could not read DB-IP's checksums.*and no release could be downloaded without them", wrong.lines[-1])
    assert not any("warning" in line for line in wrong.lines), "the warning is for a download that was accepted"


def test_a_page_that_is_read_is_held_to_a_release_it_does_not_offer_is_not_fetched_and_a_mismatch_is_never_a_fallback(tmp_path: Any) -> None:
    file = mmdb()
    old = Geo(tmp_path, {**release("2026-10", file), PAGE: lambda: Response(page("city", "2026-05", sha1(file)))}, "old")
    old.geo.refresh(OCTOBER)
    assert old.asked == [PAGE]
    assert old.geo.release == ""
    assert old.lines == ["Runlight: location data was not updated: DB-IP offers the 2026-05 release, which is neither this month's nor last month's"]

    # A good October file is on offer, but the page describes another: refused, with no try at last month's.
    mismatch = Geo(tmp_path, {**release("2026-09", file), **release("2026-10", file, "0" * 40)}, "mismatch")
    mismatch.geo.refresh(OCTOBER)
    assert mismatch.asked == [PAGE, file_url("2026-10")]
    assert mismatch.geo.release == ""
    assert mismatch.files() == []
    assert re.search(r"its SHA-1 is [0-9a-f]{40}, and DB-IP publishes 0{40}", "\n".join(mismatch.lines))
    assert not any("warning" in line for line in mismatch.lines)


def test_a_download_that_redirects_is_not_gzip_or_is_too_large_is_refused(tmp_path: Any) -> None:
    file = mmdb()
    packed = gzip.compress(file)
    ways: list[tuple[str, Callable[[], Response], str]] = [
        ("a redirect", lambda: Response("", 301, {"location": "http://download.db-ip.com/x"}), r"answered 301"),
        ("not gzip", lambda: Response(file), r"(?i)header|gzip"),
        ("cut short", lambda: Response(packed[:300]), r"(?i)unexpected end"),
        ("a length past the limit", lambda: Response(packed, 200, {"content-length": str(300 * 1024 * 1024)}), r"more than 256 MB"),
    ]
    for i, (what, answer, said) in enumerate(ways):
        t = Geo(tmp_path, {**release("2026-10", file), file_url("2026-10"): answer}, f"bad{i}")
        t.geo.refresh(OCTOBER)
        assert t.geo.release == "", what
        assert re.search(said, "\n".join(t.lines)), (what, t.lines)
        assert t.files() == [], what


def test_a_download_past_its_limits_is_stopped_as_it_comes(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    # The limits themselves are too large to reach in a test, so they are made small: packed, then unpacked.
    file = mmdb()
    monkeypatch.setattr(module, "MOST_PACKED_BYTES", 500)
    t = Geo(tmp_path, release("2026-10", file), "packed")
    t.geo.refresh(OCTOBER)
    assert t.geo.release == "" and t.files() == [] and "the download is more than" in t.lines[-1]
    monkeypatch.setattr(module, "MOST_PACKED_BYTES", 256 * 1024 * 1024)
    monkeypatch.setattr(module, "MOST_BYTES", 2 * 1024 * 1024)
    big = Geo(tmp_path, release("2026-10", mmdb(pad=3 * 1024 * 1024)), "unpacked")
    big.geo.refresh(OCTOBER)
    assert big.geo.release == "" and big.files() == [] and "the location data is more than 2 MB" in big.lines[-1]


def test_a_file_with_the_right_checksum_is_still_read_as_a_db_ip_database_before_it_is_used(tmp_path: Any) -> None:
    def refused(file: bytes, in_use: int = 0) -> str:
        try:
            check_database(file, "city", OCTOBER, in_use)
            return ""
        except ValueError as error:
            return str(error)

    assert refused(mmdb()) == ""
    assert "too few" in refused(mmdb({}, US, 1000))
    assert "not an MMDB file" in refused(bytes(2 * 1024 * 1024))
    assert '"GeoLite2-City" database' in refused(mmdb({"database_type": "GeoLite2-City"}))
    assert "not DB-IP's city one" in refused(mmdb({"database_type": "DBIP-Country-Lite"}))
    assert "version 3" in refused(mmdb({"binary_format_major_version": 3}))
    assert "IP version 4" in refused(mmdb({"ip_version": 4}))
    assert re.search("20 bits|does not open", refused(mmdb({"record_size": 20})))
    assert re.search("search tree does not fit|does not open", refused(mmdb({"node_count": 900_000})))
    assert "built on 2026-05-01" in refused(mmdb({"build_epoch": utc(2026, 5, 1) // 1000}))
    assert "built on 2026-12-01" in refused(mmdb({"build_epoch": utc(2026, 12, 1) // 1000}))
    assert "older than the database in use" in refused(mmdb(), utc(2026, 10, 2))
    assert "no country for 8.8.8.8" in refused(mmdb({}, None))
    assert "no country for 8.8.8.8" in refused(mmdb({}, {"city": {"names": {"en": "Nowhere"}}}))
    assert "no country for 8.8.8.8" in refused(mmdb({}, {"country": {"iso_code": "us"}}))
    # The same file read from disk, as a download is, passes or fails the same way.
    path = tmp_path / "check.mmdb"
    path.write_bytes(mmdb())
    check_database(str(path), "city", OCTOBER)
    with pytest.raises(ValueError, match="not DB-IP's country one"):
        check_database(str(path), "country", OCTOBER)

    # And through a download: the page vouches for a file that is not a city database, so it is not used.
    wrong = mmdb({"database_type": "DBIP-Country-Lite"})
    t = Geo(tmp_path, release("2026-10", wrong))
    t.geo.refresh(OCTOBER)
    assert t.geo.release == ""
    assert t.files() == []


def test_the_checksum_read_from_db_ips_page_is_the_mmdb_files_not_the_csv_files() -> None:
    checksum = "09eea8433fe3eed71984fd6aac9d8ab3d9ca51f0"
    assert published_checksum(page("country", "2026-11", checksum.upper()), "country") == {"release": "2026-11", "sha1": checksum}
    assert published_checksum(page("country", "2026-11", checksum), "city") is None
    assert published_checksum(page("city", "2026-11", "abc"), "city") is None, "the CSV file's checksum never stands in"
    assert published_checksum("<html></html>", "city") is None


def test_a_failed_download_leaves_lookups_empty_and_the_folder_clean_and_is_tried_again_later(tmp_path: Any) -> None:
    t = Geo(tmp_path, {})
    t.geo.refresh(utc(2026, 10, 1, 3))
    assert t.asked == [PAGE, file_url("2026-10"), file_url("2026-09")], "the checksum comes first; with none, this month's file and then last month's"
    assert t.geo.lookup("8.8.8.8") is None
    assert t.files() == []
    t.geo.refresh(utc(2026, 10, 1, 4))
    assert len(t.asked) == 6, "tried again on the next check"
    assert "not updated: could not read DB-IP's checksums" in t.lines[-1]


def test_a_file_that_keeps_being_missing_or_bad_is_asked_for_less_and_less_often_up_to_every_six_hours(tmp_path: Any) -> None:
    t = Geo(tmp_path, {})
    start = utc(2026, 10, 1, 3)
    # The server checks every five minutes; each try asks for the checksum, this month's file, and last month's.
    tries: list[int] = []
    for at in range(0, 24 * 60 + 1, 5):
        before = len(t.asked)
        t.geo.refresh(start + at * 60_000)
        if len(t.asked) > before:
            tries.append(at)
    assert tries[:8] == [0, 5, 15, 35, 75, 155, 315, 635], "each wait is twice the last"
    assert tries[8:] == [995, 1355], "and none is longer than six hours"
    assert len(t.asked) == len(tries) * 3


def test_a_new_process_opens_what_is_on_disk_before_it_asks_for_anything(tmp_path: Any) -> None:
    first = Geo(tmp_path, release("2026-09", mmdb({"build_epoch": utc(2026, 9, 1) // 1000})))
    first.geo.refresh(utc(2026, 9, 20))
    again = Geo(tmp_path, {})
    again.geo.refresh(OCTOBER)
    assert again.geo.release == "2026-09" and again.geo.lookup("1.1.1.1") == {"country": "US", "region": "", "city": "Mountain View"}
    assert again.files() == ["dbip-city-lite-2026-09.mmdb"], "a file from before is kept and used while nothing newer can be had"


def test_the_servers_own_requests_follow_no_redirect_and_take_only_https() -> None:
    with pytest.raises(Exception, match="not an https address"):
        module._direct("http://download.db-ip.com/free/x.mmdb.gz", 1000)

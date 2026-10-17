"""The 2026-10-16 audit's fixes, as the TypeScript tests for them (ingest, rollups, counting, journeys, hostname
suggestions, mail, oauth, assistant, accounts, audit, and time tests) test them."""

from __future__ import annotations

import calendar
import re
import threading
from typing import Any
from urllib.parse import quote

import pytest
from support.databases import store_kinds
from support.routes import clear_env
from support.store import DAY, HOUR, MIN, NOW, store

from runlight import Runlight, _js
from runlight import db as dbs
from runlight.accounts import SESSION_COOKIE
from runlight.http import Request
from runlight.oauth import agents_key
from runlight.store import SqlStore, Stores
from runlight.time import local_date, start_of

KINDS = store_kinds()
AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
UNKNOWN_AGENT = "Mozilla/5.0 (Unknown) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"


@pytest.fixture(autouse=True)
def _no_env():
    with clear_env():
        yield


class Site:
    """A Runlight with a clock the test moves, sending tracker hits and reading the API as its owner."""

    def __init__(self, st: SqlStore | None = None, now: int = NOW, **options: Any) -> None:
        self.now = now
        options.setdefault("site", {"hostnames": ["example.com"], "timezone": "UTC"})
        self.rl = Runlight({"store": st or Stores.sqlite(":memory:"), "now": lambda: self.now, **options})
        self.routes = self.rl.routes({"token": "secret"})
        self.rl.init()

    def advance(self, ms: int) -> None:
        self.now += ms

    def send(self, body: dict[str, Any], ip: str = "203.0.113.1", ua: str = AGENT, headers: dict[str, str] | None = None) -> None:
        site = body.pop("s", None)
        if site is not None:
            body["s"] = site
        self.rl.collect(Request("https://example.com/runlight/e", "POST", {"user-agent": ua, "x-forwarded-for": ip, **(headers or {})}, _js.dumps(body)))

    def call(self, path: str, method: str = "GET", body: Any = None, headers: dict[str, str] | None = None) -> Any:
        given = {"authorization": "Bearer secret", **(headers or {})}
        if body is not None:
            given["content-type"] = "application/json"
        return self.routes.handle(Request(f"https://example.com/runlight{path}", method, given, "" if body is None else _js.dumps(body)))

    def get(self, path: str) -> Any:
        response = self.call(path)
        assert response.status == 200, f"{path}: {response.status} {response.text()}"
        return _js.loads(response.text())

    def days(self) -> list[str]:
        return [r["day"] for r in self.rl.store.db.all("SELECT day FROM rl_salts ORDER BY day")]


# Salts


def test_a_salt_lasts_its_day_and_past_midnight_only_while_a_visit_that_began_that_day_goes_on() -> None:
    t = Site()
    t.send({"k": "pageview", "u": "https://example.com/", "i": "s1"})
    for i in range(3):
        t.advance(24 * 60 * MIN)
        t.send({"k": "pageview", "u": "https://example.com/", "i": f"s{i + 2}"})
    t.rl.check()
    # October 9th at noon UTC: no visit from the 8th is still going, so only today's salt is left.
    assert t.days() == ["2026-10-09"]

    # A visit that runs past midnight keeps its day's salt until it ends, and stays one visit.
    t.advance(11 * 60 * MIN + 50 * MIN)  # 23:50 on the 9th
    t.send({"k": "pageview", "u": "https://example.com/late", "i": "m1"})
    t.advance(20 * MIN)  # 00:10 on the 10th
    t.send({"k": "pageview", "u": "https://example.com/later", "i": "m2"})
    t.rl.check()
    assert t.days() == ["2026-10-09", "2026-10-10"], "the visit is still going"
    t.advance(31 * MIN)  # idle for half an hour: the visit has ended
    t.rl.check()
    assert t.days() == ["2026-10-10"]
    # Noon on the 9th, and the one across midnight, which belongs to the 9th where it began.
    stats = t.get("/api/stats?from=2026-10-09&to=2026-10-10&compare=off")["stats"]
    assert [stats["visits"], stats["pageviews"]] == [2, 3], "the visit across midnight is one visit"


def test_each_sites_timezone_keeps_the_salts_its_own_visits_need() -> None:
    # Toronto is still on the 9th when UTC reaches the 10th.
    t = Site(
        site=None,
        sites=[
            {"id": "utc", "name": "UTC", "hostnames": ["example.com"], "timezone": "UTC"},
            {"id": "to", "name": "Toronto", "hostnames": ["example.org"], "timezone": "America/Toronto"},
        ],
    )
    t.advance(-12 * 60 * MIN + 2 * 60 * MIN)  # 02:00 UTC on the 6th, 22:00 on the 5th in Toronto
    t.rl.check()
    for day in t.days():
        assert day in ("2026-10-05", "2026-10-06"), day
    t.send({"k": "pageview", "u": "https://example.org/", "i": "to1"})
    t.send({"k": "pageview", "u": "https://example.com/", "i": "utc1"})
    t.rl.check()
    assert t.days() == ["2026-10-05", "2026-10-06"], "today in each timezone"


# Stored text, rollups, and goals


def test_a_header_longer_than_its_column_is_cut_to_fit_so_the_days_rollup_still_builds() -> None:
    t = Site()
    t.advance(-2 * DAY)
    long = '"' + "Windows " * 400 + '"'
    t.send(
        {"k": "pageview", "u": f"https://example.com/{'a' * 1500}", "i": "long1"},
        ip="203.0.113.70",
        ua=UNKNOWN_AGENT,
        headers={"sec-ch-ua-platform": long, "sec-ch-ua": f'"{"B" * 3000}";v="1"'},
    )
    t.advance(2 * DAY)
    row = t.rl.store.db.all("SELECT os, entry_path FROM rl_sessions")[0]
    assert 50 < len(row["os"]) <= 100, f"os is {len(row['os'])} characters"
    assert len(row["entry_path"]) <= 1000
    built = 0
    while True:
        made = t.rl.build_rollups()
        if made <= 0:
            break
        built += made
    assert built >= 1, "the day builds"
    assert t.get("/api/stats?period=7d&compare=off")["stats"]["visits"] == 1


@pytest.mark.parametrize("kind", KINDS)
def test_renaming_a_click_goal_keeps_its_conversions_on_built_days_even_onto_a_name_with_events_of_its_own(databases: Any, kind: str) -> None:
    t = Site(Stores.from_db(databases.db(kind)), site={"hostnames": ["example.com"], "timezone": "UTC"})
    t.rl.store.migrate()
    t.advance(-3 * DAY)
    for i in range(3):
        ip = f"203.0.113.{60 + i}"
        t.send({"k": "pageview", "u": "https://example.com/", "i": f"c{i}"}, ip=ip)
        t.send({"k": "event", "u": "https://example.com/", "i": f"c{i}", "n": "Buy click"}, ip=ip)
        # One visit also sends a plain event under the name the goal is renamed to.
        if i == 0:
            t.send({"k": "event", "u": "https://example.com/", "i": f"c{i}", "n": "Purchase"}, ip=ip)
        t.advance(HOUR)
    t.advance(3 * DAY - 3 * HOUR)
    goal = {
        "id": "c".rjust(24, "0"), "site": "default", "name": "Buy click", "kind": "click", "match": "button.buy", "clickBy": "selector",
        "valueMode": "none", "value": 0, "valueProp": "", "currency": "USD", "createdAt": t.now,
    }  # fmt: skip
    t.rl.store.save_goal(goal)

    def build() -> None:
        while t.rl.build_rollups() > 0:
            pass

    build()

    def read() -> dict[str, Any]:
        return {
            "goals": [[g["name"], g["conversions"], g["visitors"]] for g in t.get("/api/goals?period=7d&compare=off")["goals"]],
            "events": [[r["value"], r["events"]] for r in t.get("/api/breakdown?period=7d&dimension=event")["rows"]],
        }

    assert read()["goals"] == [["Buy click", 3, 3]]
    for name in ("Checkout click", "Purchase"):
        before = t.rl.store.goals("default")[0]
        t.rl.store.save_goal({**before, "name": name}, before)
        assert read()["goals"] == [[name, 4 if name == "Purchase" else 3, 3]], f"renamed to {name}"
        # Days built again where both names met, then every built day read the same as the raw events.
        build()
        built = read()
        t.rl.store.clear_rollups("default")
        assert built == read(), f"rollups agree with the raw events after renaming to {name}"
        build()


@pytest.mark.parametrize("kind", [k for k in KINDS if k.startswith("mysql")][:1] or ["none"])
def test_on_mysql_two_processes_building_one_day_at_once_add_its_rows_once(databases: Any, kind: str) -> None:
    if kind == "none":
        pytest.skip("RUNLIGHT_TEST_MYSQL is not set")
    url = databases.url(kind)
    one = Site(Stores.from_db(dbs.mysql(url)), now=NOW - 3 * DAY)
    for i in range(5):
        one.send({"k": "pageview", "u": f"https://example.com/p{i}"}, ip=f"203.0.113.{80 + i}")
    other = Stores.from_db(dbs.mysql(url))
    start = calendar.timegm((2026, 10, 3, 0, 0, 0)) * 1000
    for round_ in range(5):
        results: list[Any] = []

        def build(s: SqlStore) -> None:
            try:
                s.build_rollup_day("default", "2026-10-03", start, start + DAY)
                results.append(None)
            except Exception as error:
                results.append(error)

        threads = [threading.Thread(target=build, args=(s,)) for s in (one.rl.store, other)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        assert any(r is None for r in results), f"one of them builds it: {results!r}"
        totals = one.rl.store.db.all("SELECT COUNT(*) AS n, SUM(visits) AS visits FROM rl_rollups WHERE site = 'default' AND day = '2026-10-03' AND dim = ''")[0]
        assert [int(totals["n"]), int(totals["visits"])] == [1, 5], f"round {round_}"


def _session_row(id_: str, started_at: int) -> dict[str, Any]:
    return {
        "id": id_, "site": "default", "visitor": "v1", "startedAt": started_at, "hostname": "example.com", "referrerHost": "", "referrerPath": "",
        "source": "", "channel": "Direct", "utmSource": "", "utmMedium": "", "utmCampaign": "", "utmTerm": "", "utmContent": "", "country": "",
        "region": "", "city": "", "browser": "", "browserVersion": "", "os": "", "osVersion": "", "device": "", "screen": "", "language": "",
    }  # fmt: skip


@pytest.mark.parametrize("kind", KINDS)
def test_two_visits_opened_for_one_visitor_at_once_by_two_processes_settle_on_one(databases: Any, kind: str) -> None:
    s = store(databases, kind)
    s.insert_session(_session_row("bbbb", NOW))
    s.insert_session(_session_row("aaaa", NOW))
    # Each process asks after opening its own; both settle on the same one, and the other is gone.
    one = s.settle_open_session("default", ["v1"], NOW - 60_000, {"id": "bbbb", "visitor": "v1"})
    other = s.settle_open_session("default", ["v1"], NOW - 60_000, {"id": "aaaa", "visitor": "v1"})
    assert [one["id"], other["id"]] == ["aaaa", "aaaa"]
    assert [r["id"] for r in s.db.all("SELECT id FROM rl_sessions")] == ["aaaa"]


@pytest.mark.parametrize("kind", KINDS)
def test_a_visit_open_is_one_that_began_in_the_stretch_and_was_going_since(databases: Any, kind: str) -> None:
    s = store(databases, kind)
    s.insert_session(_session_row("a", NOW - 2 * HOUR))
    s.db.run("UPDATE rl_sessions SET last_at = ? WHERE id = 'a'", [NOW - 10 * MIN])
    assert s.visit_open(["default"], NOW - 3 * HOUR, NOW - HOUR, NOW - 30 * MIN) is True, "still going 30 minutes ago"
    assert s.visit_open(["default"], NOW - 3 * HOUR, NOW - HOUR, NOW - 5 * MIN) is False, "but not since"
    assert s.visit_open(["other"], NOW - 3 * HOUR, NOW - HOUR, NOW - 30 * MIN) is False
    assert s.visit_open(["default"], NOW - HOUR, NOW, NOW - 30 * MIN) is False, "it began before the stretch"


@pytest.mark.parametrize("kind", KINDS)
def test_hostname_suggestions_respect_visits_filters_dates_and_sites_without_counting_totals(databases: Any, kind: str) -> None:
    t = Site(
        Stores.from_db(databases.db(kind)),
        site=None,
        sites=[
            {"id": "a", "hostnames": ["a.example.com", "b.example.com", "old.example.com", "event.example.com"]},
            {"id": "other", "hostnames": ["private.example.com"]},
        ],
    )
    t.send({"k": "pageview", "u": "https://old.example.com/", "i": "old", "s": "a"})
    t.advance(DAY)
    t.send({"k": "pageview", "u": "https://b.example.com/pricing", "i": "b", "s": "a"})
    t.send({"k": "pageview", "u": "https://a.example.com/", "i": "a", "s": "a"}, ip="203.0.113.2")
    t.send({"k": "pageview", "u": "https://a.example.com/", "i": "a2", "s": "a"}, ip="203.0.113.3")
    t.send({"k": "event", "u": "https://event.example.com/", "n": "Signup", "s": "a"}, ip="203.0.113.4")
    t.send({"k": "pageview", "u": "https://private.example.com/", "i": "private", "s": "other"})
    path = "/api/breakdown?site=a&period=today&dimension=hostname&suggestions=1"

    def refuse(*_: Any) -> Any:
        raise AssertionError("Suggestions must not calculate breakdown totals")

    t.rl.store.breakdown = refuse  # type: ignore[method-assign]
    assert t.get(path)["rows"] == [{"value": "a.example.com"}, {"value": "b.example.com"}]
    assert t.get(f"{path}&limit=1")["rows"] == [{"value": "a.example.com"}]
    assert t.get(f"{path}&filter={quote('page:is:/pricing', safe='')}")["rows"] == [{"value": "b.example.com"}]
    assert t.get(f"{path}&filter={quote('page:is:/missing', safe='')}")["rows"] == []
    denied = t.routes.handle(Request(f"https://example.com/runlight{path}", "GET", {}))
    assert denied.status == 401


@pytest.mark.parametrize("kind", KINDS)
def test_hostname_suggestions_step_through_hostnames_in_the_order_they_are_sorted_in(databases: Any, kind: str) -> None:
    # A locale's own order puts blog-staging after blog. where byte order puts it before, so suggestions taken one
    # after another in byte order must compare in byte order too, or one is skipped (Postgres on Linux).
    t = Site(Stores.from_db(databases.db(kind)), site=None, sites=[{"id": "a", "hostnames": ["blog.example.com", "blog-staging.example.com", "shop.example.com"]}])
    t.send({"k": "pageview", "u": "https://blog.example.com/", "i": "a", "s": "a"}, ip="203.0.113.2")
    t.send({"k": "pageview", "u": "https://blog-staging.example.com/", "i": "b", "s": "a"}, ip="203.0.113.3")
    t.send({"k": "pageview", "u": "https://shop.example.com/", "i": "c", "s": "a"}, ip="203.0.113.4")
    rows = t.get("/api/breakdown?site=a&period=today&dimension=hostname&suggestions=1")["rows"]
    assert [r["value"] for r in rows] == ["blog-staging.example.com", "blog.example.com", "shop.example.com"]


# Reports


def test_a_journeys_start_end_and_through_take_a_page_as_written_as_filters_do() -> None:
    t = Site()
    t.send({"k": "pageview", "u": "https://example.com/café", "i": "a"})
    t.advance(30_000)
    t.send({"k": "pageview", "u": "https://example.com/pricing", "i": "b"})
    for query in (
        f"start={quote('/café', safe='')}",
        f"start={quote('/caf%C3%A9', safe='')}",
        f"end={quote('/pricing', safe='')}&start={quote('/café', safe='')}",
        f"through={quote('0:/café', safe='')}",
    ):
        assert t.get(f"/api/journeys?period=today&{query}")["visits"] == 1, query


def test_n_months_back_from_a_months_last_days_stays_in_that_month_and_paging_takes_whole_numbers() -> None:
    t = Site()
    t.rl.set_retention("default", 6)
    for now, cutoff in (
        (calendar.timegm((2026, 8, 31, 12, 0, 0)), calendar.timegm((2026, 2, 28, 12, 0, 0))),
        (calendar.timegm((2026, 8, 30, 12, 0, 0)), calendar.timegm((2026, 2, 28, 12, 0, 0))),
        (calendar.timegm((2028, 8, 31, 12, 0, 0)), calendar.timegm((2028, 2, 29, 12, 0, 0))),
        (calendar.timegm((2026, 10, 6, 12, 0, 0)), calendar.timegm((2026, 4, 6, 12, 0, 0))),
    ):
        t.now = now * 1000
        assert t.rl.retention_cutoff("default") == cutoff * 1000, now
    for query in ("limit=2.5", "page=1e20", "limit=-3&page=0", "limit=abc&page=2.5"):
        assert t.call(f"/api/breakdown?period=7d&dimension=page&{query}").status == 200, query


def test_a_day_where_clocks_fall_back_across_midnight_begins_at_the_first_midnight() -> None:
    # Amman in 2019, Gaza and Hebron in 2020, an hour each, and three hours at Casey station in 2019.
    for date, zone in (("2019-10-25", "Asia/Amman"), ("2020-10-24", "Asia/Gaza"), ("2020-10-24", "Asia/Hebron"), ("2019-03-17", "Antarctica/Casey")):
        start = start_of(date, zone)
        assert local_date(start, zone) == date, zone
        assert local_date(start - 1, zone) < date, f"{zone}: the moment before is the day before"


def test_a_csv_value_with_a_semicolon_or_a_tab_is_quoted_so_no_locale_splits_a_formula_out_of_it() -> None:
    from runlight.zip import csv_row

    assert csv_row(["x;=1+1", "a\tb", "=1+1", "plain"]) == "\"x;=1+1\",\"a\tb\",'=1+1,plain"


# Mail, agents keys, the assistant, and accounts


def test_a_test_email_goes_at_most_once_a_minute_through_each_mail_service() -> None:
    sent: list[dict[str, Any]] = []
    t = Site(secret="k" * 64, mail={"from": "site@example.com", "via": "WordPress", "send": sent.append})
    first = t.call("/api/mail/test", "POST", {"to": "jon@example.com"})
    assert first.status == 200, first.text()
    again = t.call("/api/mail/test", "POST", {"to": "jon@example.com"})
    assert [again.status, _js.loads(again.text())["code"]] == [429, "test_soon"]
    assert len(sent) == 1
    t.advance(60_000)
    assert t.call("/api/mail/test", "POST", {"to": "jon@example.com"}).status == 200
    assert len(sent) == 2


def test_a_test_email_that_failed_can_be_tried_again_at_once() -> None:
    def fail(message: dict[str, Any]) -> None:
        raise RuntimeError("SMTP connect() failed")

    t = Site(secret="k" * 64, mail={"from": "site@example.com", "via": "WordPress", "send": fail})
    assert t.call("/api/mail/test", "POST", {"to": "jon@example.com"}).status == 400
    assert t.call("/api/mail/test", "POST", {"to": "jon@example.com"}).status == 400, "not held up for a minute"


def test_a_sites_agents_key_is_kept_sealed_and_one_kept_as_plain_text_before_still_works_and_is_sealed_when_read() -> None:
    t = Site(secret="s" * 32)
    rl = t.rl
    key = agents_key(rl, "default")
    stored = rl.store.setting("observe-key:default")
    assert key not in stored, "not in the database as it is"

    def observe(bearer: str) -> int:
        return t.routes.handle(
            Request(
                "https://example.com/runlight/api/observe",
                "POST",
                {"authorization": f"Bearer {bearer}", "content-type": "application/json"},
                _js.dumps({"url": "https://example.com/", "userAgent": "Mozilla/5.0 (compatible; GPTBot/1.2)"}),
            )
        ).status

    assert observe(key) == 204
    # A key from before, kept as it was.
    rl.store.set_setting("observe-key:default", "rlo_legacykeylegacykey00")
    assert observe("rlo_legacykeylegacykey00") == 204
    assert agents_key(rl, "default") == "rlo_legacykeylegacykey00", "shown as it was"
    assert "rlo_legacy" not in rl.store.setting("observe-key:default"), "and sealed now"
    assert observe("rlo_legacykeylegacykey00") == 204, "still working"
    assert observe("rlo_wrongkeywrongkeywron") == 401


def test_oauth_json_answers_are_not_sniffed() -> None:
    t = Site(secret="s" * 32)
    answer = t.routes.handle(Request("https://example.com/runlight/.well-known/oauth-authorization-server", "GET", {}))
    assert answer.status == 200
    assert answer.headers.get("x-content-type-options") == "nosniff"


def _scoped(t: Site, role: str = "member") -> str:
    accounts = t.routes.web.accounts
    now = t.now
    accounts.set_password("owner@example.com", "a long password", now)
    user = accounts.set_password("one@example.com", "a long password", now, role, "default")
    return f"{SESSION_COOKIE}={accounts.session_for(user, now)}"


def test_an_account_kept_to_one_site_may_rename_it_but_never_change_its_domains_and_sees_no_mail_fields() -> None:
    t = Site(secret="k" * 64)
    t.routes = t.rl.routes({"token": "secret", "accounts": True})
    cookie = _scoped(t)

    def patch(body: Any) -> Any:
        return t.routes.handle(Request("https://example.com/runlight/api/sites/default", "PATCH", {"cookie": cookie, "content-type": "application/json"}, _js.dumps(body)))

    moved = patch({"hostnames": ["elsewhere.example.org"]})
    assert [moved.status, _js.loads(moved.text())["code"]] == [403, "site_domains"]
    assert patch({"name": "Renamed"}).status == 200
    assert t.rl.site("default")["hostnames"] == ["example.com"]
    mail = t.routes.handle(Request("https://example.com/runlight/api/mail", "GET", {"cookie": cookie}))
    assert mail.status == 200
    assert _js.loads(mail.text())["fields"] == {}


def test_deleting_a_site_through_the_routes_removes_the_accounts_kept_to_it() -> None:
    t = Site(secret="k" * 64, site=None, managedSites=True)
    t.routes = t.rl.routes({"token": "secret", "accounts": True})
    site = t.rl.add_site({"name": "Alpha", "hostnames": ["alpha.example.org"]})["id"]
    accounts = t.routes.web.accounts
    accounts.set_password("owner@example.com", "a long password", t.now)
    accounts.set_password("alpha@example.com", "a long password", t.now, "viewer", site)
    accounts.invite("invited@example.com", "member", "owner@example.com", t.now, site)
    removed = t.call(f"/api/sites/{site}", "DELETE", headers={"authorization": "Bearer secret", "content-type": "application/json"})
    assert removed.status == 200, removed.text()
    assert [u["email"] for u in accounts.list()] == ["owner@example.com"]
    assert accounts.invites(t.now) == []


def test_the_ipv4_parser_refuses_a_part_with_a_bad_octal_digit_and_more_than_four_parts_as_new_url_does() -> None:
    from runlight.http import Url

    for host in ("1.2.3.4.5", "089.1.1.1", "08", "1.2.3.09", "256.1.1.1", "1.2.3.4.5."):
        assert Url.parse(f"http://{host}/") is None, host
    for host, want in (("0x7f.1", "127.0.0.1"), ("01.1", "1.0.0.1"), ("1.2.3.4.", "1.2.3.4"), ("0x", "0.0.0.0"), ("1.2.3.0x", "1.2.3.0")):
        url = Url.parse(f"http://{host}/")
        assert url is not None and url.hostname == want, host
    assert Url.parse("http://1.2.3.4.example.com/") is not None, "a name that only starts with numbers is a name"
    assert re.match(r"^\d", "1.2.3.4.example.com")


def test_sites_added_in_the_dashboard_are_kept_in_the_order_localecompare_gives() -> None:
    names = ["Zeta", "alpha", "Éclair", "eclair", "Beta", "_x", "10", "9 lives", "a b", "ab"]
    t = Site(site=None, managedSites=True)
    for i, name in enumerate(names):
        t.rl.add_site({"name": name, "hostnames": [f"s{i}.example.com"]})
    assert [s["name"] for s in t.rl.sites] == ["_x", "10", "9 lives", "a b", "ab", "alpha", "Beta", "eclair", "Éclair", "Zeta"]

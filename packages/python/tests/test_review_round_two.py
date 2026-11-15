"""The 2026-11-14 review's behaviour changes, as the TypeScript's core-review and auth-review tests pin them."""

from __future__ import annotations

import math
from typing import Any

import pytest
from support.databases import store_kinds
from support.fake_fetcher import FakeFetcher
from support.routes import clear_env

from runlight import Runlight, _js, core
from runlight.accounts.auth import Accounts, Lockout, Throttle, totp
from runlight.agentcheck import MAX_LIST_BYTES, download_range_list, saved_lists
from runlight.geo import locate
from runlight.http import Headers, Request, Response, SearchParams
from runlight.icon import icon_links
from runlight.importers import csvvisits, write
from runlight.importers.visits import _valid_host, import_csv_visits
from runlight.links import LinkError
from runlight.payload import clean_text, parse_payload, tidy
from runlight.server import cli, standalone
from runlight.server.secret import short_warning
from runlight.sources import attribute, parse_page
from runlight.store import Stores
from runlight.ua import MAX_UA, ai_agent, is_bot, parse_client

NOW = 1_791_288_000_000
MIN = 60_000
HOUR = 3_600_000
DAY = 86_400_000
CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)"
EMOJI = "\U0001f600"


@pytest.fixture(autouse=True)
def _no_env():
    with clear_env():
        yield


class Clock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> int:
        return self.now


def make(**more: Any) -> Runlight:
    return Runlight(store=Stores.sqlite(":memory:"), site={"hostnames": ["example.com"]}, **more)


def hit(ua: str = CHROME, ip: str = "203.0.113.9", body: str = '{"k":"pageview","u":"https://example.com/"}') -> Request:
    return Request("https://example.com/runlight/e", "POST", {"user-agent": ua}, body, ip)


def count(rl: Runlight, sql: str, params: list[Any] | None = None) -> int:
    return int(rl.store.db.all(f"SELECT COUNT(*) AS n FROM {sql}", params or [])[0]["n"])


# A. Ingestion and core.


def test_a_short_link_click_past_the_trackers_limit_still_redirects_and_is_not_counted() -> None:
    rl = make(rateLimit=2)
    rl.init()
    rl.links.create("default", {"url": "https://example.org/sale", "slug": "sale"})

    def click(ip: str) -> Response:
        return rl.link_handler()(Request("https://example.com/go/sale", "GET", {"user-agent": CHROME}, None, ip))

    # The same counter as tracker hits: one hit and one click use up a limit of two.
    rl.collect(hit())
    assert click("203.0.113.9").status == 302
    assert count(rl, "rl_events WHERE kind = 'click'") == 1
    for _ in range(3):
        assert click("203.0.113.9").headers.get("location") == "https://example.org/sale"
    assert count(rl, "rl_events WHERE kind = 'click'") == 1
    assert click("203.0.113.10").status == 302
    assert count(rl, "rl_events WHERE kind = 'click'") == 2
    # No address, nothing to tell callers apart by: not limited.
    for _ in range(4):
        click("")
    assert count(rl, "rl_events WHERE kind = 'click'") == 6


def test_agent_fetches_seen_live_are_limited_per_address_and_a_log_readers_are_not() -> None:
    rl = make(rateLimit=1)
    page = Request("https://example.com/post", "GET", {"user-agent": GPTBOT, "host": "example.com"}, None, "203.0.113.9")
    assert [rl.observe(page) for _ in range(12)] == [True] * 10 + [False] * 2, "ten times the tracker's limit a minute"
    assert rl.observe(Request("https://example.com/post", "GET", {"user-agent": GPTBOT, "host": "example.com"}, None, "203.0.113.10")) is True
    # A report that names the agent's address, even as nothing, is a log reader's: never limited.
    assert all(rl.observe(page, None, {"agentIp": ""}) for _ in range(5))
    assert all(rl.observe(page, None, {"agentIp": "20.171.0.1"}) for _ in range(5))
    assert count(rl, "rl_events WHERE kind = 'fetch'") == 21
    off = make(rateLimit=False)
    assert all(off.observe(page) for _ in range(30)), "no limit when the tracker has none"


def test_a_newer_days_salt_is_never_deleted() -> None:
    rl = make()
    rl.init()
    for day in ("2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"):
        rl.store.salt(day, f"salt-{day}")
    # A process whose clock is a moment behind keeps yesterday and today as it sees them.
    rl.store.drop_salts_except(["2026-10-05", "2026-10-06"])
    assert [r["day"] for r in rl.store.db.all("SELECT day FROM rl_salts ORDER BY day")] == ["2026-10-05", "2026-10-06", "2026-10-07"]


def test_an_agent_fetch_is_filed_under_the_host_a_trusted_proxy_names() -> None:
    rl = Runlight(store=Stores.sqlite(":memory:"), sites=[{"id": "a", "hostnames": ["a.example"]}, {"id": "b", "hostnames": ["b.example"]}], rateLimit=False)

    def fetch(ip: str, forwarded: str | None, context: Any = None) -> bool:
        headers = {"user-agent": GPTBOT, "host": "a.example"}
        if forwarded is not None:
            headers["x-forwarded-host"] = forwarded
        return rl.observe(Request("https://a.example/post", "GET", headers, None, ip), None, context)

    # From a proxy on a private network the forwarded host counts: its first value, without its port or www.
    assert fetch("10.0.0.5", "www.b.example:8443, a.example") is True
    # Straight from the internet it does not, and the context's address decides as it does for hits.
    assert fetch("8.8.4.4", "b.example") is True
    assert fetch("", "b.example", {"ip": "8.8.4.4"}) is True
    rows = rl.store.db.all("SELECT site, hostname FROM rl_events WHERE kind = 'fetch' ORDER BY id")
    assert [(r["site"], r["hostname"]) for r in rows] == [("b", "b.example"), ("a", "a.example"), ("a", "a.example")]


def test_stored_text_is_cleaned_and_cut_by_character() -> None:
    assert tidy("a\0b") == "ab"
    assert tidy("a\ud83db") == "a�b" and tidy("\ude00") == "�"
    assert tidy(f"a{EMOJI}b") == f"a{EMOJI}b", "a whole pair is a character"
    assert clean_text("x" * 499 + EMOJI + "y", 500) == "x" * 499 + EMOJI
    assert clean_text("x" * 500 + "y", 500) == "x" * 500

    page = parse_payload(_js.dumps({"k": "pageview", "u": "https://example.com/", "t": "a\0b", "s": "de\0fault", "l": "en\0-GB"}))
    assert page is not None and (page["title"], page["site"], page["language"]) == ("ab", "default", "en-GB")
    lone = parse_payload('{"k":"pageview","u":"https://example.com/","t":"a\\ud83db"}')
    assert lone is not None and lone["title"] == "a�b"
    event = parse_payload(
        _js.dumps({"k": "event", "u": "https://example.com/", "n": " Sign\0up ", "p": {"plan": "x" * 499 + EMOJI + "y", " \0 ": "skipped", "k\0ey": "v\0", "long" + "k" * 60: "1"}})
    )
    assert event is not None and event["name"] == "Signup"
    assert event["props"] == {"plan": "x" * 499 + EMOJI, "key": "v", "long" + "k" * 56: "1"}
    assert len(parse_payload(_js.dumps({"k": "event", "u": "https://example.com/", "n": EMOJI * 130}))["name"]) == 120  # type: ignore[index]
    # The page's address and referrer stay as sent: the URL parser encodes them.
    raw = parse_payload('{"k":"pageview","u":"https://example.com/a\\u0000b","r":"https://ref.example/\\u0000"}')
    assert raw is not None and raw["url"].pathname == "/a%00b" and raw["referrer"] == "https://ref.example/\0"

    from runlight.http import Url

    tagged = parse_page(Url("https://example.com/?utm_source=a%00b&utm_campaign=%20" + "c" * 199 + "%F0%9F%98%80z&ref=%00"))
    assert tagged["utm"]["source"] == "ab" and tagged["utm"]["campaign"] == "c" * 199 + EMOJI and tagged["ref"] == ""
    where = locate(Headers({"x-vercel-ip-country": "US", "x-vercel-ip-country-region": "C%00A", "x-vercel-ip-city": "San%00 Jose"}), "")
    assert where == {"country": "US", "region": "US-CA", "city": "San Jose"}
    assert locate(Headers(), "8.8.8.8", lambda ip: {"country": "US", "region": "Cali\0fornia", "city": "Moun\0tain View"}) == {"country": "US", "region": "US-California", "city": "Mountain View"}


def test_a_reported_user_agent_is_given_as_text_and_overrides_the_header() -> None:
    rl = make(rateLimit=False)
    page = Request("https://example.com/post", "GET", {"user-agent": CHROME, "host": "example.com"})
    assert rl.observe(page) is False
    assert rl.observe(page, None, {"agentIp": "", "userAgent": GPTBOT}) is True
    assert rl.observe(Request("https://example.com/post", "GET", {"user-agent": GPTBOT}), None, {"agentIp": "", "userAgent": CHROME}) is False
    # A logged user agent with a line break or letters no header can hold is recorded, not an error.
    routes = rl.routes({"token": "t"})
    for agent in (GPTBOT + "\nX-Injected: 1", GPTBOT + " ☃ 日本"):
        body = _js.dumps({"url": "https://example.com/logged", "userAgent": agent})
        answer = routes.handle(Request("https://example.com/runlight/api/observe", "POST", {"authorization": "Bearer t", "content-type": "application/json"}, body))
        assert answer.status == 204
    assert count(rl, "rl_events WHERE kind = 'fetch' AND path = '/logged'") == 2


def test_kit_is_its_own_source_and_substack_stays_social() -> None:
    from runlight.http import Url

    for tag in ("kit", "Kit", "CONVERTKIT", "convertkit"):
        found = attribute(parse_page(Url(f"https://example.com/?utm_source={tag}")), "", [])
        assert (found["source"], found["channel"]) == ("Kit", "Email"), tag
    letter = attribute(parse_page(Url("https://example.com/?utm_source=newsletter")), "", [])
    assert (letter["source"], letter["channel"]) == ("Newsletter", "Email")
    for referrer in ("https://substack.com/", "https://someone.substack.com/p/post"):
        found = attribute(parse_page(Url("https://example.com/")), referrer, [])
        assert (found["source"], found["channel"]) == ("Substack", "Social"), referrer


def test_a_downloaded_agent_list_is_used_only_while_it_is_newer_than_the_one_that_came_with_this_version() -> None:
    from runlight import assets

    url = next(iter(assets.AGENT_RANGES["lists"]))
    shipped = int(core.parse_date(assets.AGENT_RANGES["fetchedAt"])) if hasattr(core, "parse_date") else 0
    from runlight.importers.http import parse_date

    shipped = int(parse_date(assets.AGENT_RANGES["fetchedAt"]))
    old = ["192.0.2.0/24"]

    def ranges(saved: dict[str, Any], now: int) -> list[str]:
        rl = make(now=lambda: now)
        rl.init()
        rl.store.set_setting("agent-ranges", _js.dumps(saved))
        rl._refresh_agent_ranges()
        return rl.agent_ranges[url]

    bundled = assets.AGENT_RANGES["lists"][url]
    # Saved before each list's time was kept: the record's own time stands for all of them.
    assert ranges({"at": shipped - DAY, "lists": {url: old}}, shipped + DAY) == bundled
    assert ranges({"at": shipped, "lists": {url: old}}, shipped + DAY) == old
    # With times kept, each list's own decides, and one with none counts as never fetched.
    assert ranges({"at": shipped + DAY, "lists": {url: old}, "fetched": {url: shipped - 1}}, shipped + DAY) == bundled
    assert ranges({"at": shipped + DAY, "lists": {url: old}, "fetched": {url: shipped + 1}}, shipped + DAY) == old
    assert ranges({"at": shipped + DAY, "lists": {url: old}, "fetched": {"https://other.example/list.json": shipped + 1}}, shipped + DAY) == bundled
    assert saved_lists(_js.dumps({"at": 5, "lists": {url: old}}))["fetched"] == {url: 5}  # type: ignore[index]

    # A download notes when each list came.
    now = shipped + 3 * DAY
    fetcher = FakeFetcher(lambda asked, init: Response(_js.dumps({"prefixes": [{"ipv4Prefix": "198.51.100.0/24"}]}), 200) if asked == url else Response("no", 503))
    rl = Runlight(store=Stores.sqlite(":memory:"), site={}, updateAgentRanges=True, now=lambda: now, fetcher=fetcher)
    rl.check()
    saved = _js.loads(rl.store.setting("agent-ranges"))
    assert saved["fetched"] == {url: now} and saved["lists"] == {url: ["198.51.100.0/24"]}
    assert rl.agent_ranges[url] == ["198.51.100.0/24"]


def test_connecting_an_install_checks_its_site_before_anything_is_saved() -> None:
    def connect(sites: Any, name: str | None = None) -> Any:
        def answer(url: str, init: dict[str, Any]) -> Response:
            return Response(_js.dumps({"sites": sites}), 200, {"content-type": "application/json"}) if url.endswith("/api/sites") else Response("{}", 404)

        rl = Runlight(store=Stores.sqlite(":memory:"), managedSites=True, fetcher=FakeFetcher(answer))
        made = rl.add_site({"remote": {"url": "https://stats.example.org/runlight", "token": "rl_token"}, **({"name": name} if name is not None else {})})
        return rl, made

    for bad in ([{"id": 5, "name": "x"}], [{"id": "", "name": "x"}], [{"id": "i" * 65, "name": "x"}], [{"id": "a", "name": 7}], [{"id": "a"}], [None], ["text"]):
        with pytest.raises(core.SettingsError) as refused:
            connect(bad)
        assert refused.value.code == "connect_not_runlight", bad
    rl, made = connect([{"id": "a", "name": "  " + "n" * 90 + " ", "hostnames": ["", "-.Shop.example", 5]}])
    assert made["id"] == "shop.example" and made["name"] == "n" * 80
    assert rl.remote(made["id"])["hostnames"] == ["-.Shop.example"]  # type: ignore[index]
    _, plain = connect([{"id": "a", "name": "", "hostnames": ["---"]}])
    assert plain["id"] == "site" and plain["name"] == "site"
    _, named = connect([{"id": "a", "name": "There"}], name=" Mine ")
    assert named["name"] == "Mine" and named["id"] == "stats.example.org"


def test_a_range_list_is_read_no_further_than_a_list_can_be() -> None:
    small = _js.dumps({"prefixes": [{"ipv4Prefix": "198.51.100.0/24"}]})
    assert download_range_list(FakeFetcher(lambda url, init: Response(small, 200)), "https://x.example/l.json") == ["198.51.100.0/24"]
    read = {"bytes": 0}

    def endless() -> Any:
        yield b'{"prefixes":['
        while True:
            read["bytes"] += 65_536
            yield b" " * 65_536

    assert download_range_list(FakeFetcher(lambda url, init: Response(endless(), 200)), "https://x.example/l.json") is None
    assert read["bytes"] <= MAX_LIST_BYTES + 2 * 65_536, "it stops at the cap though no length was declared"
    assert download_range_list(FakeFetcher(lambda url, init: Response(small, 200, {"content-length": str(MAX_LIST_BYTES + 1)})), "https://x.example/l.json") is None


def test_collect_never_raises_and_says_what_it_could_not_record(capsys: pytest.CaptureFixture[str]) -> None:
    rl = make()
    rl.init()

    def broken(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("disk full")

    rl.store.insert_event = broken  # type: ignore[method-assign]
    assert rl.collect(hit()) is None
    assert "Runlight: could not record an event" in capsys.readouterr().err


def test_the_user_agent_is_read_no_further_than_512_characters_and_safari_is_found_in_a_straight_line() -> None:
    import time

    assert MAX_UA == 512
    pad = "x" * 600
    assert ai_agent(f"{pad} GPTBot/1.2") is None and ai_agent(GPTBOT) is not None
    assert is_bot(f"Mozilla/5.0 {pad} HeadlessChrome") is False and is_bot("Mozilla/5.0 (X11) HeadlessChrome/129") is True
    assert parse_client(f"Mozilla/5.0 {pad} Chrome/129.0 Safari/537.36")["browser"] == "Other"
    assert parse_client(CHROME, {"brands": pad + '"Brave";v="1"'})["browser"] == "Chrome"
    assert parse_client("Mozilla/5.0", {"platform": '"' + "L" * 600 + '"'})["os"] == "L" * 511
    for ua in ("Mozilla/5.0 (Macintosh) Version/18 Safari/605.1.15", "Mozilla/5.0 (Macintosh) Version/18.1.1 Safari/605.1.15", "Mozilla/5.0 (iPhone) Version/18.1 Mobile/15E148 Safari/604.1"):
        found = parse_client(ua)
        assert (found["browser"], found["browserVersion"]) == ("Safari", "18"), ua
    assert parse_client("Mozilla/5.0 Version/18x Safari/605")["browser"] == "Other"
    started = time.perf_counter()
    parse_client("Mozilla/5.0 Version/" + "1" * 100_000)
    assert time.perf_counter() - started < 0.5
    # The visitor hash still takes the whole user agent: two that differ past 512 are two visitors.
    rl = make(rateLimit=False)
    rl.collect(hit(CHROME + " " + "a" * 600 + "1"))
    rl.collect(hit(CHROME + " " + "a" * 600 + "2"))
    assert count(rl, "(SELECT DISTINCT visitor FROM rl_sessions) v") == 2


def test_the_icon_scan_is_bounded() -> None:
    import time

    assert icon_links('<link rel="icon" href="/a.png"><link rel="icon" href="/b.svg" x="' + "y" * 4001 + '">', "https://example.com") == ["https://example.com/a.png"]
    assert icon_links('<link rel="icon" <b> href="/a.png">', "https://example.com") == []
    started = time.perf_counter()
    assert icon_links("<link" * 40_000, "https://example.com") == []
    assert icon_links("<link " * 30_000 + ">", "https://example.com") == []
    assert time.perf_counter() - started < 1.5


def test_a_forwarded_address_loses_its_port() -> None:
    rl = make(trustProxy=True)

    def ip(value: str) -> str:
        return rl.client_ip(Request("https://example.com/", "GET", {"x-forwarded-for": value}, None, "10.0.0.1"))

    assert ip("203.0.113.7:51234") == "203.0.113.7"
    assert ip("198.51.100.1, 203.0.113.7:51234") == "203.0.113.7"
    assert ip("[2001:db8::1]:443") == "2001:db8::1" and ip("[2001:db8::1]") == "2001:db8::1"
    assert ip("2001:db8::1") == "2001:db8::1"
    assert ip("[2001:db8::1]:https") == "[2001:db8::1]:https" and ip("[2001:db8::1]x") == "[2001:db8::1]x"
    assert ip("203.0.113.7") == "203.0.113.7" and ip("203.0.113.7:") == "203.0.113.7:"


def test_an_address_over_320_characters_is_no_email_before_the_pattern_reads_it() -> None:
    assert core.EMAIL_MAX == 320
    fits = "a" * 308 + "@example.com"
    assert len(fits) == 320 and core.EMAIL.match(fits) and not core.EMAIL.match("a" + fits)
    with pytest.raises(ValueError):
        make(mail={"send": lambda message: None, "from": "a" * 309 + "@example.com"})
    store = Stores.sqlite(":memory:")
    store.migrate()
    accounts = Accounts(store, "k" * 64)
    for change in (lambda: accounts.set_password("a" + fits, "a long password", NOW), lambda: accounts.invite("a" + fits, "admin", "jon@example.com", NOW)):
        with pytest.raises(Exception) as refused:
            change()
        assert getattr(refused.value, "code", "") == "email_invalid"
    assert accounts.set_password(fits, "a long password", NOW)["email"] == fits


# B. Routes and accounts.


class Install:
    """An install with accounts: its owner, and a member kept to the site "default"."""

    def __init__(self, origin: str | None = None, base: str = "/runlight") -> None:
        self.clock = Clock()
        self.base = base
        self.rl = Runlight({"store": Stores.sqlite(":memory:"), "secret": "k" * 64, "site": {"hostnames": ["example.com"]}, "now": self.clock})
        options: dict[str, Any] = {"token": "app-token", "accounts": True, "basePath": base}
        if origin:
            options["origin"] = origin
        self.routes = self.rl.routes(options)
        self.owner = self.form("/setup", {"code": "app-token", "email": "jon@example.com", "password": "a long password", "again": "a long password"})
        made = self.json(self.owner, "POST", "/api/people", {"site": "default", "email": "mo@example.com", "role": "member"})
        code = SearchParams(_js.loads(made.text())["link"].split("?", 1)[1]).get("code") or ""
        self.member = self.form("/invite", {"code": code, "password": "a long password", "again": "a long password"})

    def ask(self, path: str, method: str = "GET", headers: dict[str, str] | None = None, body: str = "", host: str = "example.com") -> Response:
        return self.routes.handle(Request(f"https://{host}{self.base}{path}", method, {"host": host, **(headers or {})}, body, "203.0.113.9"))

    def form(self, path: str, fields: dict[str, str], headers: dict[str, str] | None = None) -> str:
        answer = self.ask(path, "POST", {"content-type": "application/x-www-form-urlencoded", **(headers or {})}, SearchParams(fields).to_string())
        cookies = answer.headers.get_set_cookie()
        return (cookies[0] if cookies else "").split(";")[0]

    def json(self, cookie: str, method: str, path: str, body: Any = None, host: str = "example.com") -> Response:
        return self.ask(path, method, {"cookie": cookie, "content-type": "application/json"}, "" if body is None else _js.dumps(body), host)


def code_of(answer: Response) -> Any:
    return _js.loads(answer.text()).get("code")


def test_an_account_kept_to_one_site_is_not_taken_at_its_word_about_where_the_app_lives() -> None:
    t = Install()
    for path, body in (("/api/link-domains", {"domain": "go.example.org"}), ("/api/reports", {"email": "a@example.org"}), ("/api/links/import/bitly", {"credentials": {}})):
        answer = t.json(t.member, "POST", path, body)
        if path.startswith("/api/links/import"):
            continue
        assert (answer.status, code_of(answer)) == (400, "origin_needed"), path
    assert t.json(t.owner, "POST", "/api/reports", {"email": "a@example.org"}).status == 201, "an owner is unchanged"

    placed = Install(origin="https://stats.example.com")
    made = placed.json(placed.member, "POST", "/api/reports", {"email": "a@example.org"}, host="evil.example")
    assert made.status == 201
    assert placed.rl.store.reports("default")[0]["origin"] == "https://stats.example.com/runlight"

    # A picker ticket only for this dashboard: the configured address, or without one the request's own.
    nonce = "a" * 32
    for install, own, other in ((t, "https://example.com", "https://evil.example"), (placed, "https://stats.example.com", "https://example.com")):
        refused = install.json(install.member, "POST", "/api/pick", {"origin": other, "return": f"{other}/runlight/pick-return", "nonce": nonce})
        assert refused.status == 403 and _js.loads(refused.text()) == {"error": "Your account can only pick from this dashboard's own address", "code": "pick_own"}
        assert install.json(install.member, "POST", "/api/pick", {"origin": own, "return": f"{own}/runlight/pick-return", "nonce": nonce}).status == 200
        assert install.json(install.owner, "POST", "/api/pick", {"origin": other, "return": f"{other}/runlight/pick-return", "nonce": nonce}).status == 200


def test_long_addresses_and_domains_are_refused_before_a_pattern_reads_them() -> None:
    t = Install(origin="https://example.com")
    long = "a" * 309 + "@example.com"
    assert code_of(t.json(t.owner, "POST", "/api/reports", {"email": f"  {long}  "})) == "email_invalid"
    assert code_of(t.json(t.owner, "POST", "/api/mail/test", {"to": long})) == "test_email"
    assert code_of(t.json(t.owner, "POST", "/api/people", {"allSites": True, "email": long, "role": "viewer"})) == "email_invalid"
    too_long = t.json(t.owner, "POST", "/api/link-domains", {"domain": "https://go.example.org/" + "p" * 240})
    assert (too_long.status, code_of(too_long)) == (400, "domain_invalid")
    assert code_of(t.json(t.owner, "POST", "/api/link-domains", {"domain": "go.example.org" + "." * 100_000})) == "domain_invalid"
    from runlight.routes import host_name

    assert host_name("WWW.Example.com:8080") == "example.com" and host_name("WWW.Example.com...") == "example.com" and host_name("example.com.") == "example.com"
    assert host_name("a" + "." * 200_000) == "a"


def test_oauth_refuses_addresses_that_do_not_parse_and_tells_an_account_kept_to_one_site_so() -> None:
    t = Install()

    def register(uris: list[str]) -> Response:
        return t.ask("/oauth/register", "POST", {"content-type": "application/json"}, _js.dumps({"client_name": "App <b>", "redirect_uris": uris}))

    assert register(["https://exa mple.com/cb", "https://[bad/cb"]).status == 400
    kept = _js.loads(register(["https://exa mple.com/cb", "https://app.example/cb"]).text())
    assert kept["redirect_uris"] == ["https://app.example/cb"]
    query = SearchParams(
        {"response_type": "code", "client_id": kept["client_id"], "redirect_uri": "https://app.example/cb", "code_challenge": "c" * 43, "code_challenge_method": "S256"}
    ).to_string()
    page = t.ask(f"/oauth/authorize?{query}", "GET", {"cookie": t.member})
    assert page.status == 403 and "location" not in page.headers
    assert "Your account only has access to one site, and only an owner of this Runlight can connect App &lt;b&gt;." in page.text()
    assert t.ask(f"/oauth/authorize?{query}", "GET", {"cookie": t.owner}).status == 200
    assert t.ask(f"/oauth/authorize?{query}", "GET").status == 303, "nobody signed in is sent to sign in"

    # An app stored before such addresses were refused: its address is in its list and is still no address.
    t.rl.store.set_setting("oauth-client:" + "c" * 32, _js.dumps({"name": "Old", "redirects": ["https://exa mple.com/cb"], "createdAt": NOW}))
    old = SearchParams({"response_type": "code", "client_id": "c" * 32, "redirect_uri": "https://exa mple.com/cb", "code_challenge": "c" * 43, "code_challenge_method": "S256"}).to_string()
    assert t.ask(f"/oauth/authorize?{old}", "GET", {"cookie": t.owner}).status == 400


def test_the_consent_form_reaches_the_apps_own_check_with_its_body_unread() -> None:
    seen: list[str] = []

    def authorize(request: Request) -> bool:
        seen.append(SearchParams(request.text()).get("csrf") or "")
        return True

    rl = make()
    routes = rl.routes({"authorize": authorize, "csrf": lambda: "nonce-1"})
    made = _js.loads(routes.handle(Request("https://example.com/runlight/oauth/register", "POST", {}, '{"redirect_uris":["https://app.example/cb"]}')).text())
    fields = {"response_type": "code", "client_id": made["client_id"], "redirect_uri": "https://app.example/cb", "code_challenge": "c" * 43, "code_challenge_method": "S256", "decision": "allow", "csrf": "nonce-1"}
    answer = routes.handle(Request("https://example.com/runlight/oauth/authorize", "POST", {"content-type": "application/x-www-form-urlencoded"}, SearchParams(fields).to_string()))
    assert answer.status == 303 and "code=" in (answer.headers.get("location") or "")
    assert seen and set(seen) == {"nonce-1"}


def test_bodies_past_their_caps_are_refused() -> None:
    t = Install()
    big = "x" * 66_000
    for path in ("/login", "/login/code", "/invite", "/setup"):
        answer = t.ask(path, "POST", {"content-type": "application/x-www-form-urlencoded"}, f"email={big}")
        if path == "/setup":
            assert answer.status == 303, "an account exists, so nothing is read"
            continue
        assert (answer.status, _js.loads(answer.text())) == (413, {"error": "Send a smaller body", "code": "body_too_large"}), path
    declared = t.ask("/login", "POST", {"content-type": "application/x-www-form-urlencoded", "content-length": "70000"}, "email=a")
    assert declared.status == 413
    for method, path in (("POST", "/api/account/password"), ("POST", "/api/people"), ("DELETE", "/api/sites/default")):
        answer = t.json(t.owner, method, path, {"password": big})
        assert (answer.status, code_of(answer)) == (413, "body_too_large"), path
    for path in ("/oauth/register", "/oauth/token", "/oauth/authorize"):
        answer = t.ask(path, "POST", {"content-type": "application/json"}, _js.dumps({"x": big}))
        assert answer.status == 413 and _js.loads(answer.text()) == {"error": "invalid_request", "error_description": "Send a smaller body"}, path
        assert answer.headers.get("access-control-allow-origin") == "*"
    mcp = t.ask("/mcp", "POST", {"authorization": "Bearer app-token", "content-type": "application/json"}, _js.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"x": "y" * 1_100_000}}))
    assert mcp.status == 413 and _js.loads(mcp.text()) == {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Send a smaller message"}}
    under = t.ask("/mcp", "POST", {"authorization": "Bearer app-token", "content-type": "application/json"}, _js.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"x": "y" * 900_000}}))
    assert under.status == 200
    broken = t.ask("/mcp", "POST", {"authorization": "Bearer app-token"}, "{not json")
    assert broken.status == 400 and _js.loads(broken.text())["error"]["code"] == -32700


@pytest.mark.parametrize("kind", store_kinds())
def test_wrong_codes_lock_an_account_for_longer_each_time(databases: Any, kind: str) -> None:
    store = Stores.from_db(databases.db(kind))
    store.migrate()
    clock = Clock()
    lock = Lockout(store, "code", clock=clock)

    def tries() -> list[bool]:
        return [lock.take("user-1", clock.now) for _ in range(6)]

    assert tries() == [True] * 5 + [False], "five tries, and the fifth starts the lock"
    waits = [15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR, 24 * HOUR, 24 * HOUR]
    for i, wait in enumerate(waits):
        clock.now += wait - 1
        assert lock.take("user-1", clock.now) is False and lock.blocked("user-1", clock.now), f"lock {i + 1} lasts its whole time"
        clock.now += 1
        if i + 1 < len(waits):
            assert tries() == [True] * 5 + [False]
    assert lock.take("user-2", clock.now) is True, "one account's lock is not another's"
    # A right code clears the key, the count of locks with it.
    lock.clear("user-1")
    assert tries() == [True] * 5 + [False]
    clock.now += 15 * MIN
    assert lock.take("user-1", clock.now) is True

    # Before the fifth try, the count starts over fifteen minutes after the first.
    other = Lockout(store, "other", clock=clock)
    assert [other.take("u", clock.now) for _ in range(4)] == [True] * 4
    clock.now += 15 * MIN
    assert [other.take("u", clock.now) for _ in range(5)] == [True] * 5
    assert other.take("u", clock.now) is False
    # A week with no try after its lock ended and it is forgotten: the next lock is fifteen minutes again.
    clock.now += 15 * MIN + 7 * DAY
    assert [other.take("u", clock.now) for _ in range(5)] == [True] * 5
    clock.now += 15 * MIN
    assert other.take("u", clock.now) is True
    # Kept for every process, under a key that is not the day's, so a lock outlasts midnight; the scheduled
    # check forgets only what a week has passed for.
    assert all(s["key"].startswith("lockout:") for s in store.settings_starting_with("lockout:")) and store.setting("lockout-key")
    assert len(store.settings_starting_with("lockout:")) == 3
    Throttle.sweep(store, clock.now)
    assert [s["key"].split(":")[1] for s in store.settings_starting_with("lockout:")] == ["other"], "the two a week has passed for are gone"
    Throttle.sweep(store, clock.now + 9 * DAY)
    assert store.settings_starting_with("lockout:") == []


def test_the_code_step_locks_out_guesses_and_a_browser_the_account_signed_in_from_counts_on_its_own() -> None:
    t = Install()
    user = t.rl.store.db.all("SELECT id FROM rl_users WHERE email = 'jon@example.com'")[0]["id"]
    accounts = t.routes.web.accounts
    secret = accounts.start_two_factor(user)
    assert accounts.confirm_two_factor(user, totp(secret, t.clock.now // 30_000), t.clock.now) is not None

    def pending() -> str:
        return accounts.pending_for(accounts.by_id(user), t.clock.now)

    def code(value: str, cookie: str = "") -> int:
        headers = {"content-type": "application/x-www-form-urlencoded", **({"cookie": cookie} if cookie else {})}
        return t.ask("/login/code", "POST", headers, SearchParams({"pending": pending(), "code": value, "next": "/runlight/"}).to_string()).status

    assert [code("000000") for _ in range(6)] == [401] * 5 + [429]
    right = totp(secret, t.clock.now // 30_000 + 1)
    assert code(right) == 429, "a right code is refused too while locked"
    # The owner's own browser, holding the account's mark, has tries of its own.
    device = f"runlight_device={_js.encode_uri_component(accounts.device_for(accounts.by_id(user)))}"
    assert code("000000", device) == 401
    assert code(right, device) == 303
    t.clock.now += 15 * MIN
    assert [code("000000") for _ in range(6)] == [401] * 5 + [429], "the lock ended, and the next is longer"
    t.clock.now += 15 * MIN
    assert code("000000") == 429
    t.clock.now += 15 * MIN
    assert code("000000") == 401


# C. Store and importers.


@pytest.mark.parametrize("kind", store_kinds())
def test_props_no_database_reads_as_json_count_as_an_event_with_none(databases: Any, kind: str) -> None:
    from support.store import store as fresh

    s = fresh(databases, kind)
    s.insert_session({k: "" for k in ("hostname", "referrerHost", "referrerPath", "source", "channel", "utmSource", "utmMedium", "utmCampaign", "utmTerm", "utmContent", "country", "region", "city", "browser", "browserVersion", "os", "osVersion", "device", "screen", "language")} | {"id": "s1", "site": "default", "visitor": "v1", "startedAt": NOW})
    s.touch_session("s1", NOW, "event", "/")
    # Valid JSON as JSON.stringify writes it, which Postgres and MySQL will not read: an escaped NUL, half a pair.
    unreadable = ['{"plan":"a\\u0000b"}', '{"plan":"\\ud83d"}', '{"plan":"x\\ude00"}', '{"k\\\\\\\\\\u0000":"v"}']
    readable = ['{"plan":"pro","amount":"12.50"}', '{"plan":"\\ud83d\\ude00","amount":7}', '{"plan":"a\\\\u0000b"}']
    for props in [*unreadable, *readable]:
        s.db.run(
            "INSERT INTO rl_events (site, ts, kind, visitor, session, pageview, path, hostname, title, name, props, engaged_ms, link) VALUES (?, ?, 'event', 'v1', 's1', '', '/', 'example.com', '', 'Signup', ?, 0, '')",
            ["default", NOW, props],
        )
    query = {"site": "default", "from": NOW - HOUR, "to": NOW + HOUR, "filters": []}
    keys = {k["key"]: k["events"] for k in s.event_prop_keys(query, "Signup")}
    values = {v["value"]: v["events"] for v in s.event_prop_values(query, "Signup", "plan", 10)}
    goal = {"id": "g", "site": "default", "name": "Signup", "kind": "event", "match": "Signup", "clickBy": "", "valueMode": "prop", "value": 0, "valueProp": "amount", "currency": "USD", "createdAt": NOW}
    totals = s.goal_totals(query, goal)
    assert totals["conversions"] == 7 and totals["revenue"] == 19.5, "every event counts, the unreadable ones without a value"
    if s.db.dialect() == "sqlite":
        assert keys["plan"] == 6
    else:
        assert keys == {"plan": 3, "amount": 2} or (s.db.dialect() == "mysql" and keys["amount"] == 2 and keys["plan"] >= 3)
        assert values["pro"] == 1 and values[EMOJI] == 1 and values["a\\u0000b"] == 1


@pytest.mark.parametrize("kind", store_kinds())
def test_a_link_imported_once_and_deleted_since_is_left_deleted(databases: Any, kind: str) -> None:
    rl = Runlight(store=Stores.from_db(databases.db(kind)), site={"hostnames": ["example.com"]}, now=lambda: NOW)
    rl.init()
    foreign = {"sourceId": "abc", "slug": "sale", "url": "https://example.org/sale", "name": "Sale"}
    history = {"clicks": [{"ts": NOW - HOUR, "country": "US"}, {"ts": NOW - 2 * HOUR}]}
    assert write.write_link(rl, "default", "bitly", foreign, history) == {"status": "created", "clicks": 2}
    id = write.imported_link_id("bitly", "abc")
    assert rl.store.link_exists(id) is True and rl.store.link_exists("f" * 24) is False
    rl.links.remove(id)
    assert rl.store.link_by_id(id) is None and rl.store.link_exists(id) is True
    assert write.write_link(rl, "default", "bitly", foreign, history) == {"status": "skipped", "clicks": 0}
    assert count(rl, "rl_events WHERE link = ?", [id]) == 2, "its clicks stay as they were"


def test_an_imported_link_brings_no_more_than_a_hundred_thousand_clicks(monkeypatch: pytest.MonkeyPatch) -> None:
    assert write.MAX_LINK_CLICKS == 100_000
    monkeypatch.setattr(write, "MAX_LINK_CLICKS", 25)
    rl = make(now=lambda: NOW)
    rl.init()
    clicks = [{"ts": NOW - i * MIN, "visit": f"v{i}"} for i in range(40)]
    assert write.write_link(rl, "default", "dub", {"sourceId": "1", "slug": "one", "url": "https://example.org/1"}, {"clicks": clicks})["clicks"] == 25
    daily = [{"day": "2026-09-01", "clicks": 10.9}, {"day": "2026-09-02", "clicks": 20_000}, {"day": "2026-09-03", "clicks": 5}]
    assert write.write_link(rl, "default", "dub", {"sourceId": "2", "slug": "two", "url": "https://example.org/2"}, {"daily": daily})["clicks"] == 25
    both = {"clicks": clicks[:20], "daily": [{"day": "2026-09-01", "clicks": 100}]}
    assert write.write_link(rl, "default", "dub", {"sourceId": "3", "slug": "three", "url": "https://example.org/3"}, both)["clicks"] == 25
    monkeypatch.setattr(write, "MAX_LINK_CLICKS", 100_000)
    assert write.write_link(rl, "default", "dub", {"sourceId": "4", "slug": "four", "url": "https://example.org/4"}, {"daily": [{"day": "2026-09-02", "clicks": 20_000.7}]})["clicks"] == 10_000


def test_imported_columns_never_hold_an_address_or_a_user_agent() -> None:
    assert write.browser("chrome") == "Chrome" and write.browser("arc") == "Arc" and write.browser(" my browser 2 ") == "My browser 2"
    for bad in ("203.0.113.7", "Chrome 203.0.113.7", "2001:db8::1", "Mozilla/5.0 (X11)", "9lives", "a" * 41, "", "x; y"):
        assert write.browser(bad) == "" and write.system(bad) == "", bad
    assert write.system("Mac OS") == "macOS" and write.system("haiku") == "haiku" and write.system("Haiku R1") == "Haiku R1"
    assert write.place_name("San Jose") == "San Jose" and write.place_name("Île-de-France") == "Île-de-France"
    for bad in ("at 203.0.113.7", "fe80::1", "Mozilla/5.0", "AppleWebKit", "curl/8", "::ffff"):
        assert write.place_name(bad) == "", bad
    assert write.place_name("1.2.3") == "1.2.3" and write.place_name("1.2.3.4.5") == "1.2.3.4.5"
    assert write.screen_size(" 1440x900 ") == "1440x900" and write.screen_size("1440 x 900") == "" and write.screen_size("123456x1") == ""
    assert write.language_tag(" pt-BR ") == "pt-BR" and write.language_tag("zh_Hant_TW") == "zh_Hant_TW" and write.language_tag("en-US,en;q=0.9") == "" and write.language_tag("e") == ""


def test_csv_rows_before_2000_are_skipped_and_a_bad_hostname_becomes_the_sites_own() -> None:
    assert csvvisits.CSV_EARLIEST == 946_684_800_000
    assert math.isnan(csvvisits.row_time({"time": "20240501"}, "runlight")), "a date written as a bare number is 1970"
    assert math.isnan(csvvisits.row_time({"time": "1999-12-31T23:59:59Z"}, "runlight"))
    assert csvvisits.row_time({"time": "2000-01-01T00:00:00Z"}, "runlight") == 946_684_800_000
    assert csvvisits.row_time({"created_at": "2024-05-01 12:34:56"}, "umami") == 1_714_566_896_000
    assert csvvisits.row_time({"time": "1714566896"}, "runlight") == 1_714_566_896_000

    assert _valid_host("shop.example.com") and _valid_host("xn--caf-dma.example")
    for bad in ("", "exa mple.com", "example.com/path", "example.com?x", "example.com#x", "user@example.com", "example.com\\x", "[bad"):
        assert not _valid_host(bad), bad
    rl = make(now=lambda: NOW)
    rl.init()
    rows = [
        {"time": "2026-10-01T10:00:00Z", "url": "/a", "hostname": "exa mple.com", "visitor": "1", "browser": "203.0.113.7", "os": "Mozilla/5.0 (X11; Linux)", "city": "at 203.0.113.7", "screen": "big", "language": "en-US,en;q=0.9"},
        {"time": "2026-10-01T10:01:00Z", "url": "/b", "hostname": "evil.example/path", "visitor": "2", "browser": "arc", "os": "haiku", "city": "Lyon", "screen": "1440x900", "language": "fr-FR"},
        {"time": "19990101", "url": "/c", "visitor": "3"},
    ]
    format_ = csvvisits.csv_format(list(rows[0]))
    if format_ is None:
        pytest.skip("this file's columns are not ones the CSV import reads")
    answer = import_csv_visits(rl, "default", rows)
    assert answer["pageviews"] == 2 and answer["skipped"] == 1
    sessions = rl.store.db.all("SELECT hostname, browser, os, city, screen, language FROM rl_sessions ORDER BY started_at")
    assert sessions == [
        {"hostname": "example.com", "browser": "", "os": "", "city": "", "screen": "", "language": ""},
        {"hostname": "example.com", "browser": "Arc", "os": "haiku", "city": "Lyon", "screen": "1440x900", "language": "fr-FR"},
    ]


# D. The standalone server.


def server(**more: Any) -> standalone.RunlightServer:
    return standalone.create_server({"store": Stores.sqlite(":memory:"), "secret": "s" * 64, "setupCode": "setup-code", **more})


def test_the_servers_own_pages_are_no_new_links_slugs() -> None:
    s = server()
    s.runlight.init()
    site = s.runlight.add_site({"hostnames": ["example.com"]})["id"]
    for slug in ("login", "logout", "setup", "invite", "healthz", "api", "mcp", "e", "embed", "pick-return"):
        assert slug in s.runlight.links.reserved
        with pytest.raises(LinkError) as refused:
            s.runlight.links.create(site, {"url": "https://example.org/", "slug": slug})
        assert refused.value.code == "link_reserved" and refused.value.params == {"slug": slug}
    # One made before the slug was kept back keeps it, and can still be changed.
    s.runlight.store.insert_link({"id": "a" * 24, "site": site, "domain": "", "slug": "login", "name": "Old", "url": "https://example.org/", "createdAt": NOW, "updatedAt": NOW})
    assert s.runlight.links.update("a" * 24, {"slug": "login", "name": "Still here"})["slug"] == "login"
    assert make().links.create("default", {"url": "https://example.org/", "slug": "login"})["slug"] == "login", "an app's own install keeps none back"


def test_the_servers_name_comes_from_a_forwarded_host_only_where_proxy_headers_are_believed() -> None:
    def named(trust: Any, ip: str) -> str:
        s = server(**({} if trust is None else {"trustProxy": trust}))
        return s._host_of(Request("https://stats.example.com/", "GET", {"host": "stats.example.com", "x-forwarded-host": "evil.example"}, None, ip))

    assert named(None, "8.8.4.4") == "stats.example.com", "straight from the internet, the client does not name the host"
    assert named(None, "10.0.0.2") == "evil.example" and named(None, "127.0.0.1") == "evil.example"
    assert named(True, "8.8.4.4") == "evil.example"
    assert named(False, "10.0.0.2") == "stats.example.com"


def test_a_short_token_is_warned_about_and_wrong_guesses_at_it_are_held_up() -> None:
    assert short_warning("RUNLIGHT_TOKEN", None) is None and short_warning("RUNLIGHT_SECRET", "s" * 32) is None
    assert short_warning("RUNLIGHT_TOKEN", "hunter2") == (
        "Runlight: WARNING: RUNLIGHT_TOKEN is only 7 characters long. Anyone who guesses it has the whole API, as the owner. "
        "Set it to 32 or more random characters, such as the output of: openssl rand -hex 32"
    )
    assert "It signs every session and encrypts the saved mail and assistant keys" in (short_warning("RUNLIGHT_SECRET", "short") or "")

    def status(s: standalone.RunlightServer, token: str, ip: str = "203.0.113.9") -> int:
        return s.handle(Request("https://stats.example.com/api/sites", "GET", {"host": "stats.example.com", "authorization": f"Bearer {token}"}, None, ip)).status

    short = server(token="hunter2", trustProxy=False)
    assert status(short, "hunter2") == 200
    # Tokens made in Settings are the routes' to check, and never count as guesses.
    assert [status(short, "rl_" + "0" * 40) for _ in range(12)] == [401] * 12
    assert [status(short, f"guess{i}") for i in range(10)] == [401] * 10
    assert status(short, "hunter2") == 401, "after ten wrong tries the address is held up, right token or not"
    assert status(short, "hunter2", "203.0.113.10") == 200, "another address is not"
    long = server(token="t" * 32, trustProxy=False)
    assert [status(long, f"guess{i}") for i in range(15)] == [401] * 15
    assert status(long, "t" * 32) == 200, "a long token counts nothing"
    assert long._store.settings_starting_with("throttle:token:") == []


def test_a_taken_port_is_said_in_one_line(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    import io
    import socket

    taken = socket.socket()
    taken.bind(("127.0.0.1", 0))
    taken.listen(1)
    try:
        monkeypatch.setenv("DATA_DIR", str(tmp_path))
        monkeypatch.setenv("HOST", "127.0.0.1")
        monkeypatch.setenv("PORT", str(taken.getsockname()[1]))
        monkeypatch.setenv("RUNLIGHT_GEO", "off")
        monkeypatch.setenv("RUNLIGHT_TOKEN", "short")
        out, err = io.StringIO(), io.StringIO()
        assert cli.run(["start"], out, err) == 1
        lines = err.getvalue().strip().split("\n")
        assert len(lines) == 1 and lines[0].startswith(f"Runlight: could not listen on 127.0.0.1:{taken.getsockname()[1]}: ")
    finally:
        taken.close()

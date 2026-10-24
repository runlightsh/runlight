"""The 2026-10-23 audit's fixes, as the TypeScript tests named "audit 2026-10-23: ..." in audit.test.ts test them."""

from __future__ import annotations

from typing import Any

import pytest
from support.routes import clear_env
from support.store import HOUR, MIN, NOW

from runlight import Runlight, _js
from runlight.accounts import auth
from runlight.accounts.auth import Throttle
from runlight.http import Request, Response, SearchParams
from runlight.store import Stores

AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"


@pytest.fixture(autouse=True)
def _no_env():
    with clear_env():
        yield


def account_req(path: str, method: str = "GET", headers: dict[str, str] | None = None, body: str = "") -> Request:
    return Request(f"https://example.com/runlight{path}", method, headers or {}, body)


def form_post(path: str, fields: dict[str, str], headers: dict[str, str] | None = None) -> Request:
    return account_req(path, "POST", {"content-type": "application/x-www-form-urlencoded", **(headers or {})}, SearchParams(fields).to_string())


def cookie_from(response: Response) -> str:
    cookies = response.headers.get_set_cookie()
    return (cookies[0] if cookies else "").split(";")[0]


class WithMember:
    """An install with accounts: its owner, and a member who joined by invite."""

    def __init__(self) -> None:
        self.rl = Runlight({"store": Stores.sqlite(":memory:"), "secret": "k" * 64, "site": {"hostnames": ["example.com"]}})
        self.handler = self.rl.routes({"token": "app-token", "accounts": True}).handle
        self.owner = cookie_from(self.handler(form_post("/setup", {"code": "app-token", "email": "jon@example.com", "password": "a long password", "again": "a long password"})))
        made = self.json(self.owner, "POST", "/api/people", {"allSites": True, "email": "mo@example.com", "role": "member"})
        code = SearchParams(_js.loads(made.text())["link"].split("?", 1)[1]).get("code") or ""
        self.member = cookie_from(self.handler(form_post("/invite", {"code": code, "password": "a long password", "again": "a long password"})))

    def json(self, cookie: str, method: str, path: str, body: Any = None) -> Response:
        headers = {"cookie": cookie, "content-type": "application/json"}
        return self.handler(account_req(path, method, headers, "" if body is None else _js.dumps(body)))

    def sign_in(self, extra: dict[str, str] | None = None) -> Response:
        return self.handler(form_post("/login", {"email": "mo@example.com", "password": "a long password", "next": "/runlight/"}, extra))


def test_a_member_sees_and_revokes_only_the_tokens_they_made_and_cannot_replace_a_sites_agents_key() -> None:
    t = WithMember()

    def make(cookie: str, name: str) -> str:
        return _js.loads(t.json(cookie, "POST", "/api/tokens", {"name": name}).text())["token"]["id"]

    def listed(cookie: str) -> list[str]:
        return sorted(token["id"] for token in _js.loads(t.json(cookie, "GET", "/api/tokens").text())["tokens"])

    owners = make(t.owner, "Owner's")
    mine = make(t.member, "Member's")
    assert listed(t.member) == [mine]
    assert listed(t.owner) == sorted([owners, mine]), "the owner sees every token"
    assert t.json(t.member, "DELETE", f"/api/tokens/{owners}").status == 404, "the owner's token is not the member's to revoke"
    assert listed(t.owner) == sorted([owners, mine])
    assert t.json(t.member, "DELETE", f"/api/tokens/{mine}").status == 200
    assert t.json(t.member, "POST", "/api/observe-key/new?site=default", {}).status == 403
    assert t.json(t.owner, "POST", "/api/observe-key/new?site=default", {}).status == 200


def test_signing_out_ends_this_browsers_session_signing_out_everywhere_ends_them_all_and_only_from_the_dashboards_own_pages() -> None:
    t = WithMember()
    other = cookie_from(t.sign_in())
    cross_site = t.handler(account_req("/logout", headers={"cookie": t.member, "sec-fetch-site": "cross-site"}))
    assert cross_site.status == 403, "another site cannot sign anyone out"
    out = t.handler(account_req("/logout", headers={"cookie": t.member, "sec-fetch-site": "same-origin"}))
    assert out.status == 303
    assert "max-age=0" in (out.headers.get("set-cookie") or "").lower(), "this browser's cookie goes"
    assert t.json(other, "GET", "/api/account").status == 200, "the other browser stays signed in"

    third = cookie_from(t.sign_in())
    ended = t.json(other, "POST", "/api/account/sign-out-everywhere", {})
    assert ended.status == 200
    assert "max-age=0" in (ended.headers.get("set-cookie") or "").lower()
    assert t.json(other, "GET", "/api/account").status == 401, "the browser that asked is signed out"
    assert t.json(third, "GET", "/api/account").status == 401, "and so is every other"
    assert t.json(t.member, "GET", "/api/account").status == 401, "and a cookie copied before"
    back = cookie_from(t.sign_in())
    assert t.json(back, "GET", "/api/account").status == 200, "signing in again works"


def test_the_sign_in_forms_take_a_post_only_from_their_own_pages() -> None:
    t = WithMember()
    for site in ("cross-site", "same-site"):
        refused = t.sign_in({"sec-fetch-site": site})
        assert refused.status == 403, site
        assert refused.headers.get("set-cookie") is None, f"{site}: no session is planted"
    assert t.sign_in({"sec-fetch-site": "same-origin"}).status == 303


def test_a_new_password_can_take_back_the_tokens_the_account_made() -> None:
    t = WithMember()
    t.json(t.member, "POST", "/api/tokens", {"name": "Kept"})
    fresh = cookie_from(t.json(t.member, "POST", "/api/account/password", {"current": "a long password", "next": "another long password"}))
    kept = t.json(fresh, "GET", "/api/tokens")
    assert kept.status == 200, kept.text()
    assert len(_js.loads(kept.text())["tokens"]) == 1, "kept unless asked"
    latest = cookie_from(t.json(fresh, "POST", "/api/account/password", {"current": "another long password", "next": "a third long password", "revokeTokens": True}))
    assert _js.loads(t.json(latest, "GET", "/api/tokens").text())["tokens"] == []


def test_a_flood_of_made_up_names_cannot_reset_the_count_of_one_close_to_its_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    # The counts are in the database here, so the ceiling is lowered to keep the flood quick.
    monkeypatch.setattr(auth, "MAX_THROTTLED", 100)
    store = Stores.sqlite(":memory:")
    store.migrate()
    throttle = Throttle(store, "address", 3, clock=lambda: NOW)
    assert throttle.take("target", NOW) is True
    assert throttle.take("target", NOW) is True
    for i in range(105):
        throttle.take(f"made-up-{i}", NOW)
    assert len(store.settings_starting_with("throttle:address:")) <= 100
    assert throttle.take("target", NOW) is True
    assert throttle.take("target", NOW) is False, "the target's earlier tries still count"


class Site:
    """A Runlight with a clock the test moves, sending tracker hits and reading the API as its owner."""

    def __init__(self) -> None:
        self.now = NOW
        self.rl = Runlight({"store": Stores.sqlite(":memory:"), "now": lambda: self.now, "site": {"hostnames": ["example.com"], "timezone": "UTC"}})
        self.routes = self.rl.routes({"token": "secret"})
        self.rl.init()

    def advance(self, ms: int) -> None:
        self.now += ms

    def send(self, body: dict[str, Any], ip: str = "203.0.113.1") -> None:
        self.rl.collect(Request("https://example.com/runlight/e", "POST", {"user-agent": AGENT, "x-forwarded-for": ip}, _js.dumps(body)))

    def call(self, path: str, method: str = "GET", body: Any = None) -> Response:
        headers = {"authorization": "Bearer secret", **({"content-type": "application/json"} if body is not None else {})}
        return self.routes.handle(Request(f"https://example.com/runlight{path}", method, headers, "" if body is None else _js.dumps(body)))

    def get(self, path: str) -> Any:
        response = self.call(path)
        assert response.status == 200, f"{path}: {response.status} {response.text()}"
        return _js.loads(response.text())


def test_yesterdays_salt_leaves_memory_when_it_leaves_the_store_on_the_first_hit_after_midnight() -> None:
    t = Site()
    t.send({"k": "pageview", "u": "https://example.com/"})
    t.advance(13 * HOUR)
    t.send({"k": "pageview", "u": "https://example.com/"}, "203.0.113.9")
    cached = t.rl._salts["UTC"]
    assert cached["day"] == "2026-10-07"
    assert cached["yesterday"] is None, "no visit was left open, so yesterday's salt is gone from here too"


def test_a_hit_tried_again_after_the_store_was_busy_counts_once(monkeypatch: pytest.MonkeyPatch) -> None:
    t = Site()
    store = t.rl.store
    insert = store.insert_event
    fail = [2]

    def flaky(row: dict[str, Any]) -> Any:
        fail[0] -= 1
        if fail[0] >= 0:
            raise RuntimeError("database is locked")
        return insert(row)

    monkeypatch.setattr(store, "insert_event", flaky)
    monkeypatch.setattr("runlight.core.time.sleep", lambda _s: None)
    t.send({"k": "pageview", "u": "https://example.com/", "i": "p1"})
    fail[0] = 1
    t.send({"k": "engagement", "u": "https://example.com/", "i": "p1", "e": 5000})
    [visit] = store.db.all("SELECT pageviews, engaged_ms FROM rl_sessions")
    assert int(visit["pageviews"]) == 1
    assert int(visit["engaged_ms"]) == 5000
    assert len(store.db.all("SELECT id FROM rl_events WHERE kind = 'pageview'")) == 1


def test_a_funnel_over_more_visits_than_the_cap_counts_the_newest_and_says_so() -> None:
    t = Site()
    t.rl.store.funnel_visits = 2
    for ip in ("203.0.113.1", "203.0.113.2", "203.0.113.3"):
        t.send({"k": "pageview", "u": "https://example.com/pricing"}, ip)
        t.advance(MIN)
    made = t.call("/api/funnels?site=default", "POST", {"name": "F", "steps": [{"kind": "page", "match": "/pricing"}, {"kind": "page", "match": "/thanks"}]})
    assert made.status in (200, 201), made.text()
    [funnel] = t.get("/api/funnels?period=today")["funnels"]
    assert funnel["sampled"] == 2
    assert funnel["steps"][0]["visits"] == 2
    t.rl.store.funnel_visits = 10
    assert "sampled" not in t.get("/api/funnels?period=today")["funnels"][0]


def test_an_automatic_link_event_keeps_its_link_without_the_query_string_or_fragment() -> None:
    t = Site()
    t.send({"k": "event", "u": "https://example.com/", "n": "Outbound link", "p": {"url": "https://other.example/reset?token=abc&email=a@b.example#top"}})
    t.send({"k": "event", "u": "https://example.com/", "n": "File download", "p": {"url": "https://example.com/a.pdf?sig=x"}})
    t.send({"k": "event", "u": "https://example.com/", "n": "Signup", "p": {"url": "https://example.com/?plan=pro"}})
    rows = t.rl.store.db.all("SELECT name, props FROM rl_events ORDER BY name")
    assert [[r["name"], _js.loads(r["props"])["url"]] for r in rows] == [
        ["File download", "https://example.com/a.pdf"],
        ["Outbound link", "https://other.example/reset"],
        ["Signup", "https://example.com/?plan=pro"],
    ]

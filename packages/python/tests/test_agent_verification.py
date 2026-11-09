"""The AI agent address checks in ingest.test.ts: what observe() keeps for a fetch, the ai_agent breakdown's claimed
rows, and updateAgentRanges downloading the lists once a day through the Fetcher (a fake here, never the network)."""

from __future__ import annotations

import calendar
import json
from typing import Any

import pytest
from support.databases import store_kinds
from support.fake_fetcher import FakeFetcher

from runlight import Runlight
from runlight.http import Request, Response
from runlight.store import Stores

GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)"
META = "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)"


def page(ua: str, ip: str | None = None) -> Request:
    headers = {"user-agent": ua, "host": "example.com"}
    if ip:
        headers["x-forwarded-for"] = ip
    return Request("https://example.com/post", "GET", headers)


def agents(rl: Runlight) -> list[dict[str, Any]]:
    routes = rl.routes({"token": "t"})
    answer = routes.handle(Request("https://example.com/runlight/api/breakdown?period=today&dimension=ai_agent", "GET", {"authorization": "Bearer t"}))
    assert answer.status == 200
    return json.loads(answer.content())["rows"]


def titles(rl: Runlight) -> list[str]:
    return sorted(r["title"] for r in rl.store.db.all("SELECT title FROM rl_events WHERE kind = 'fetch'"))


@pytest.mark.parametrize("kind", store_kinds())
def test_an_ai_agents_address_is_checked_against_its_companys_list_and_only_the_answer_is_kept(databases: Any, kind: str) -> None:
    rl = Runlight({"store": Stores.from_db(databases.db(kind)), "site": {"hostnames": ["example.com"]}})
    rl.observe(page(GPTBOT, "20.171.206.17"))  # in OpenAI's published GPTBot list
    rl.observe(page(GPTBOT, "20.171.206.18"))
    rl.observe(page(GPTBOT, "198.51.100.23"))  # says GPTBot, comes from elsewhere
    rl.observe(page(GPTBOT))  # no address to check
    rl.observe(page(META, "157.240.0.1"))  # Meta publishes no list
    # A log reader's or plugin's report names the agent's address itself; it never stands in for the reporter's.
    rl.observe(Request("https://example.com/post", "GET", {"user-agent": GPTBOT, "x-forwarded-for": "198.51.100.40"}), None, {"agentIp": "20.171.206.99"})

    assert agents(rl) == [
        {"value": "GPTBot", "visitors": 0, "fetches": 3, "claimed": False},
        {"value": "GPTBot", "visitors": 0, "fetches": 2, "claimed": True},
        {"value": "meta-externalagent", "visitors": 0, "fetches": 1, "claimed": True},
    ]
    assert titles(rl) == ["", "", "mismatch", "verified", "verified", "verified"]
    dump = json.dumps(rl.store.db.all("SELECT * FROM rl_events"), default=str)
    for ip in ["20.171.206.17", "198.51.100.23", "157.240.0.1", "198.51.100.40", "20.171.206.99"]:
        assert ip not in dump, f"no address: {ip}"


def test_observe_reports_check_the_address_they_name_and_never_the_reporters() -> None:
    rl = Runlight({"store": Stores.sqlite(":memory:"), "site": {"hostnames": ["example.com"]}})
    routes = rl.routes({"token": "t", "observeKey": "agents"})

    def send(body: Any, remote: str = "") -> int:
        headers = {"authorization": "Bearer agents", "content-type": "application/json", "x-forwarded-for": "20.171.206.17"}
        return routes.handle(Request("https://example.com/runlight/api/observe", "POST", headers, json.dumps(body), remote)).status

    url = "https://example.com/post"
    assert send({"url": url, "userAgent": GPTBOT, "ip": "20.171.206.17"}) == 204
    assert send({"url": url, "userAgent": GPTBOT}) == 204, "no ip: nothing to check, whatever the reporter's own address"
    assert send({"url": url, "userAgent": GPTBOT, "ip": 351391249}) == 204, "an ip that is not text is no ip"
    assert send({"fetches": [{"url": url, "userAgent": GPTBOT, "ip": "198.51.100.23"}, {"url": url, "userAgent": GPTBOT, "ip": " [::ffff:20.171.206.11] "}]}) == 200
    assert send({"url": url, "userAgent": GPTBOT, "ip": "20.171.206.17" + " " * 200}) == 204, "cut to 100 characters, then trimmed"
    assert titles(rl) == ["", "", "mismatch", "verified", "verified", "verified"]


def _utc(*parts: int) -> int:
    return calendar.timegm((*parts, 0, 0, 0)[:6]) * 1000


def test_update_agent_ranges_downloads_once_a_day_keeps_a_good_copy_over_a_bad_download_and_shares_it_through_the_database() -> None:
    now = [_utc(2026, 11, 8, 12)]
    answer: list[Any] = [lambda url: Response.json({"prefixes": [{"ipv4Prefix": "192.0.2.0/24"}]})]
    fetcher = FakeFetcher(lambda url, init: answer[0](url))
    store = Stores.sqlite(":memory:")
    rl = Runlight({"store": store, "site": {}, "updateAgentRanges": True, "now": lambda: now[0], "fetcher": fetcher})
    asked = lambda: [r["url"] for r in fetcher.requests]  # noqa: E731

    rl.check()
    assert "https://openai.com/gptbot.json" in asked()
    first = fetcher.requests[0]
    assert first["method"] == "GET" and first["headers"]["user-agent"] == "Runlight (+https://runlight.sh)"
    assert fetcher.inits[0]["timeoutMs"] == 15_000 and fetcher.inits[0]["maxBytes"] == 4_000_000
    first_round = len(asked())
    rl.observe(page(GPTBOT, "192.0.2.7"))  # in the downloaded list
    rl.observe(page(GPTBOT, "20.171.206.17"))  # in the bundled list only, which the download replaced
    now[0] += 3_600_000
    rl.check()
    assert len(asked()) == first_round, "not again within the day"

    now[0] += 86_400_000
    answer[0] = lambda url: Response("<html>maintenance</html>", 200)
    rl.check()
    assert len(asked()) == first_round * 2, "a day later it tries again"
    rl.observe(page(GPTBOT, "192.0.2.8"))  # the bad download kept the good copy

    # Another process sharing the database uses the lists without downloading them.
    other_fetcher = FakeFetcher(lambda url, init: Response("{}"))
    other = Runlight({"store": store, "site": {}, "now": lambda: now[0], "fetcher": other_fetcher})
    other.check()
    assert other_fetcher.requests == []
    other.observe(page(GPTBOT, "192.0.2.9"))

    assert titles(rl) == ["mismatch", "verified", "verified", "verified"]
    saved = json.loads(store.setting("agent-ranges"))
    assert saved["at"] == now[0] and saved["lists"]["https://openai.com/gptbot.json"] == ["192.0.2.0/24"]


def test_a_failed_download_with_nothing_saved_still_waits_a_day_and_keeps_the_bundled_lists() -> None:
    now = [_utc(2026, 11, 8, 12)]
    fetcher = FakeFetcher(lambda url, init: Response("nope", 503))
    store = Stores.sqlite(":memory:")
    rl = Runlight({"store": store, "site": {}, "updateAgentRanges": True, "now": lambda: now[0], "fetcher": fetcher})
    rl.check()
    first_round = len(fetcher.requests)
    assert first_round > 0
    assert json.loads(store.setting("agent-ranges")) == {"at": now[0], "lists": {}}
    now[0] += 60_000
    rl.check()
    assert len(fetcher.requests) == first_round
    rl.observe(page(GPTBOT, "20.171.206.17"))
    assert titles(rl) == ["verified"]


def test_without_update_agent_ranges_runlight_never_downloads_the_lists() -> None:
    fetcher = FakeFetcher(lambda url, init: Response("{}"))
    rl = Runlight({"store": Stores.sqlite(":memory:"), "site": {}, "fetcher": fetcher})
    rl.check()
    assert fetcher.requests == []

"""Location from platform headers, with a lookup behind them, replayed from the TypeScript SDK. The MMDB cases of
the same fixture are the MMDB reader's tests."""

from __future__ import annotations

from support import fixtures

from runlight.geo import locate, location_from_headers
from runlight.http import Headers


def test_headers() -> None:
    for case in fixtures.load("geo")["headers"]:
        assert location_from_headers(Headers(case["headers"])) == case["location"], fixtures.label(case["headers"])


def test_locate() -> None:
    for case in fixtures.load("geo")["located"]:

        def lookup(ip: str, case: dict = case) -> dict | None:
            if case.get("throws"):
                raise RuntimeError("broken")
            return case["found"]

        got = locate(Headers(case["headers"]), case["ip"], None if case.get("noLookup") else lookup)
        assert got == case["location"], fixtures.label(case)


def test_a_hosting_platforms_location_headers_count_only_when_proxy_headers_are_trusted() -> None:
    import base64
    import calendar

    from runlight import Runlight, _js
    from runlight.http import Request
    from runlight.store import Stores

    def countries(trust_proxy: bool) -> list[str]:
        now = calendar.timegm((2026, 10, 6, 12, 0, 0)) * 1000
        rl = Runlight({"store": Stores.sqlite(":memory:"), "trustProxy": trust_proxy, "now": lambda: now, "geo": lambda ip: {"country": "DE", "region": "BE", "city": "Berlin"}})
        routes = rl.routes({"token": "t"})
        platform = {
            "cf-ipcountry": "US",
            "cf-region-code": "CA",
            "cf-ipcity": "San Francisco",
            "x-vercel-ip-country": "FR",
            "x-nf-geo": base64.b64encode(_js.dumps({"country": {"code": "JP"}}).encode()).decode(),
        }
        for i, (name, value) in enumerate(platform.items()):
            # A visitor each, so each request opens a visit of its own.
            ip = f"203.0.113.{i + 1}"
            headers = {"user-agent": "Mozilla/5.0 (Macintosh) Chrome/129.0.0.0 Safari/537.36", "x-forwarded-for": ip, name: value}
            routes.handle(Request("https://x.com/runlight/e", "POST", headers, _js.dumps({"k": "pageview", "u": f"https://x.com/{name}"})), {"ip": ip})
        rl.idle()
        rows = _js.loads(routes.handle(Request("https://x.com/runlight/api/breakdown?period=today&dimension=country", "GET", {"authorization": "Bearer t"})).text())
        return sorted(r["value"] for r in rows["rows"])

    assert countries(False) == ["DE"], "without a proxy in front, a client writes them itself, so the lookup answers"
    assert countries(True) == ["DE", "FR", "JP", "US"], "behind one, they come first, and the lookup answers where they name no country"

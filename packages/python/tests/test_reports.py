"""Email reports against packages/php/tests/fixtures/reports.json: the period each covers, Intl's numbers, dates,
money, and region names as the reports write them, and its cases, hits sent through the core and the reports built
from them in every language. Then whole reports built over the TypeScript SDK's own database, against
tests/fixtures/reports-store.json (scripts/python-fixtures-reports.mts)."""

from __future__ import annotations

import shutil
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from support.fixtures import PHP_FIXTURES, label, load, own

from runlight import Runlight, _intl, _js
from runlight.http import Request
from runlight.reports import build_report, last_period
from runlight.store import Stores

AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"


def test_periods_match_the_typescript_sdk() -> None:
    periods = load("reports")["periods"]
    assert len(periods) > 1000
    for case in periods:
        assert last_period(case["frequency"], case["now"], case["zone"]) == case["period"], f"{case['frequency']} {case['now']} {case['zone']}"


def test_reports_built_over_the_same_database_match_the_typescript_sdk(tmp_path: Path) -> None:
    file = tmp_path / "store.db"
    shutil.copy(PHP_FIXTURES / "store.db", file)
    store = Stores.sqlite(str(file))
    store.migrate()
    runlight = SimpleNamespace(store=store)
    cases = own("reports-store")["cases"]
    assert len(cases) >= 30
    for case in cases:
        got = build_report(runlight, case["site"], case["frequency"], case["period"], case["lang"], case["links"])
        label = f"{case['site']['id']} {case['frequency']} {case['period']['key']} {case['lang']}"
        assert got["subject"] == case["report"]["subject"], label
        assert got["text"] == case["report"]["text"], label
        assert got["html"] == case["report"]["html"], label
    store.close()


@pytest.mark.parametrize("lang", [s["lang"] for s in load("reports")["intl"]])
def test_numbers_percents_dates_currencies_and_regions_are_written_as_intl_writes_them(lang: str) -> None:
    set_ = next(s for s in load("reports")["intl"] if s["lang"] == lang)
    failures: list[str] = []

    def check(want: str, got: str, what: Any) -> None:
        if got != want:
            failures.append(f"{lang} {label(what)} gave {got!r} not {want!r}")

    for n, text in set_["number"]:
        check(text, _intl.number(lang, n), ["number", n])
    for n, text in set_["decimal"]:
        check(text, _intl.number(lang, n, 1, 1), ["decimal", n])
    for n, text in set_["percent"]:
        check(text, _intl.percent(lang, n), ["percent", n])
    for day, text in set_["monthYear"]:
        check(text, _intl.month_year(lang, day), ["monthYear", day])
    for day, short, long in set_["shortDay"]:
        check(short, _intl.short_day(lang, day, False), ["shortDay", day])
        check(long, _intl.short_day(lang, day, True), ["shortDayYear", day])
    for n, code, text in set_["currency"]:
        check(text, _intl.currency(lang, n, code, 0 if _js.is_integer(n) else 2), ["currency", n, code])
    for code, name in set_["region"]:
        check(name, _intl.region(lang, code), ["region", code])
    assert failures[:20] == []


@pytest.mark.parametrize("name", [c["name"] for c in load("reports")["cases"]])
def test_reports_render_as_the_typescript_sdk_renders_them_in_every_language(name: str) -> None:
    case = next(c for c in load("reports")["cases"] if c["name"] == name)
    clock = SimpleNamespace(now=0)
    rl = Runlight(
        {
            "store": Stores.sqlite(":memory:"),
            "site": {"name": "Example & Co", "hostnames": ["example.com"], "timezone": case["timezone"]},
            "now": lambda: clock.now,
        }
    )
    rl.init()
    for goal in case["goals"]:
        rl.store.save_goal(goal)
    for hit in case["hits"]:
        clock.now = hit["at"]
        headers = {"user-agent": AGENT, "x-forwarded-for": hit["ip"]}
        if hit["country"] != "":
            headers["x-vercel-ip-country"] = hit["country"]
        rl.collect(Request("https://example.com/runlight/e", "POST", headers, _js.dumps(hit["body"])))
    clock.now = case["at"]
    site = rl.site("default")
    assert len(case["reports"]) == 12
    for want in case["reports"]:
        where = f"{name}, {want['lang']} {want['frequency']}"
        assert last_period(want["frequency"], clock.now, case["timezone"]) == want["period"], where
        got = build_report(rl, site, want["frequency"], want["period"], want["lang"], want["links"])
        assert got["subject"] == want["subject"], where
        assert got["text"] == want["text"], where
        assert got["html"] == want["html"], where

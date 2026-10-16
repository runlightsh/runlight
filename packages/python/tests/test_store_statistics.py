"""Planner statistics kept fresh, as hardening.test.ts tests them."""

from __future__ import annotations

from typing import Any

import pytest
from support.databases import store_kinds
from support.store import NOW, WatchedDb, store

from runlight import Runlight
from runlight.store import SqlStore

KINDS = store_kinds()


def _add_events(s: SqlStore, prefix: str, count: int) -> None:
    for i in range(count):
        s.db.run(
            "INSERT INTO rl_events (site, ts, kind, visitor, session, pageview, path, hostname) VALUES ('default', ?, 'pageview', 'v', 's', ?, '/', 'example.com')",
            [NOW, f"{prefix}{i}"],
        )


@pytest.mark.parametrize("kind", KINDS)
def test_planner_statistics_gathered_on_an_empty_database_are_gathered_again_once_the_events_outgrow_them(databases: Any, kind: str) -> None:
    base = store(databases, kind)
    watched = WatchedDb(base.db)
    s = SqlStore(watched)
    clock = [NOW]
    rl = Runlight({"store": s, "site": {"hostnames": ["example.com"], "timezone": "UTC"}, "now": lambda: clock[0]})
    rl.init()
    analyzed = 0

    def count(sql: str, params: list[Any]) -> None:
        nonlocal analyzed
        if sql == "ANALYZE":
            analyzed += 1

    watched.before = count
    s.optimize(True)
    assert analyzed == 0, "fresh enough while still empty"
    _add_events(s, "p", 1500)
    s.optimize(True)
    if s.db.dialect() != "sqlite":
        assert analyzed == 0, "only SQLite needs this"
        return
    assert analyzed == 1, "gathered again once the events grew"
    stat = s.db.all("SELECT stat FROM sqlite_stat1 WHERE idx = 'rl_events_site_ts'")[0]["stat"]
    # A sample, so an estimate of the 1,500 rather than an exact count.
    assert int(stat.split(" ")[0]) > 1000, f"statistics count the events: {stat}"
    s.optimize(True)
    assert analyzed == 1, "not again until they double"
    # An app that never runs the scheduled check gets them from its reports, at most hourly.
    _add_events(s, "q", 1600)
    rl.freshen_statistics()
    rl.freshen_statistics()
    assert analyzed == 2, "once for the doubled events, then not again within the hour"

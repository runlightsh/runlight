"""The assistant's limits against questions sent at once: assistant.test.ts "questions sent at once count once each"."""

from __future__ import annotations

import calendar
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from support.databases import kinds

from runlight import Runlight, _js
from runlight.http import FetchError, Request, Response
from runlight.store import Stores

NOW = calendar.timegm((2026, 10, 12, 12, 0, 0)) * 1000


class _Unreachable:
    """The model is never reached; a question that gets past the limits fails fast instead."""

    def fetch(self, url: str, init: dict[str, Any] | None = None) -> Response:
        raise FetchError("Could not connect")


@pytest.mark.parametrize("kind", kinds())
def test_questions_sent_at_once_count_once_each_against_a_viewers_daily_number(databases: Any, kind: str) -> None:
    store = Stores.from_db(databases.db(kind))

    def make() -> Runlight:
        return Runlight({"store": store, "now": lambda: NOW, "sites": [{"id": "a", "name": "A", "hostnames": ["a.example.com"]}], "fetcher": _Unreachable()})

    first = make()
    first.init()
    first.save_assistant_settings({"provider": "custom", "model": "m", "baseUrl": "http://127.0.0.1:9/v1", "key": "k"})
    first.store.set_setting("assistant-viewer-daily", "1")

    def handler(rl: Runlight) -> Any:
        routes = rl.routes({"authorize": lambda r: "read" if r.headers.get("x-who") else False, "accountOf": lambda r: r.headers.get("x-who")})
        return routes.handle

    def ask(handle: Any, who: str) -> Response:
        given = {"site": "a", "messages": [{"role": "user", "content": "hi"}]}
        return handle(Request("https://x.com/runlight/api/assistant/chat", "POST", {"x-who": who, "content-type": "application/json"}, _js.dumps(given)))

    def passed(answers: list[Response]) -> int:
        return len([a for a in answers if a.status != 429])

    def count(who: str) -> str | None:
        return first.store.setting(f"assistant-asked:2026-10-12:{who}")

    def together(jobs: list[Any]) -> list[Response]:
        with ThreadPoolExecutor(len(jobs)) as pool:
            return [f.result() for f in [pool.submit(job) for job in jobs]]

    # One process: the second and later questions see the first before anything is read from the database.
    one = handler(first)
    assert passed(together([lambda: ask(one, "viewer-1")] * 10)) == 1
    assert count("viewer-1") == "1"

    # Ten processes on one database, each with its own counts in memory: the database lets one through.
    handlers = [handler(make()) for _ in range(10)]
    assert passed(together([(lambda h=h: ask(h, "viewer-2")) for h in handlers])) == 1
    assert count("viewer-2") == "1"

    # Two viewers at once each have their own row, and neither write loses the other's.
    assert passed(together([lambda: ask(handlers[0], "viewer-3"), lambda: ask(handlers[1], "viewer-4")])) == 2
    assert count("viewer-3") == "1"
    assert count("viewer-4") == "1"

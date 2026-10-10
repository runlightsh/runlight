"""Replays tracker bodies through parse_payload, as the TypeScript SDK read them."""

from __future__ import annotations

import sys

from support import fixtures

from runlight import _js
from runlight.payload import MAX_BODY, _shallow, parse_payload


def test_fixture() -> None:
    fixture = fixtures.load("payload")
    assert MAX_BODY == fixture["maxBody"]
    for case in fixture["cases"]:
        payload = parse_payload(case["text"])
        if payload is not None:
            payload["url"] = payload["url"].href
            payload["props"] = None if payload["props"] is None else _js.dumps(payload["props"])
        assert _js.dumps(payload) == _js.dumps(case["payload"]), fixtures.label(case["text"])


def test_props_with_index_keys_stay_an_object() -> None:
    payload = parse_payload('{"k":"event","u":"https://example.com/","n":"x","p":{"1":"b","0":"a"}}')
    assert list(payload["props"]) == ["0", "1"]
    assert _js.dumps(payload["props"]) == '{"0":"a","1":"b"}'


def test_deep_nesting_parses_as_javascript_reads_it() -> None:
    deep = "[" * 3000 + "]" * 3000
    payload = parse_payload('{"k":"pageview","u":"https://example.com/","x":' + deep + "}")
    assert payload is not None
    assert payload["kind"] == "pageview"
    # Without touching the interpreter's recursion limit, which every other thread shares.
    limit = sys.getrecursionlimit()
    nested = '{"a":[{"b":"c\\u00e9","d":[1,-2.5e3,true,false,null,{}]}],"e":[]}'
    for prop in ("[" * 3000 + "]" * 3000, "[" * 2000 + nested + "]" * 2000, '{"x":' * 1200 + "1" + "}" * 1200):
        event = parse_payload('{"k":"event","u":"https://example.com/","n":"x","p":{"a":' + prop + ',"b":"kept"}}')
        assert event is not None, prop[:40]
        assert event["props"] == {"b": "kept"}, "a deep value is skipped, as JavaScript skips it"
    assert sys.getrecursionlimit() == limit
    # A deep part that is not JSON makes the body not JSON, as JSON.parse throws.
    for broken in ("[" * 3000 + "]" * 2999, "[" * 3000 + "1,]" + "]" * 2999, "[" * 3000 + '"\x01"' + "]" * 3000, "[" * 3000 + "01" + "]" * 3000, "[" * 3000 + "NaN" + "]" * 3000):
        assert parse_payload('{"k":"pageview","u":"https://example.com/","x":' + broken + "}") is None, broken[-10:]
        # Some Pythons parse this deep without help, so what they lean on is checked on its own too.
        assert _js.try_loads(_shallow('{"x":' + broken + "}") or "")[0] is False, broken[-10:]
    assert _shallow('{"a":{"b":[[1]],"c":"x"},"d":[{"e":1}]} ') == '{"a":{"b":null,"c":"x"},"d":[null]} '
    assert _shallow('{"p":{"a":' + "[" * 3000 + nested + "]" * 3000 + "}}") == '{"p":{"a":null}}'

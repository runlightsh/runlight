"""The conformance runner's normalizer against cases run through normalize() in http-conformance.ts
(packages/php/tests/fixtures/conformance-normalize.json)."""

from __future__ import annotations

import pytest
from support import conformance, fixtures
from test_conformance import canonical

CASES = fixtures.load("conformance-normalize")


@pytest.mark.parametrize("index", range(len(CASES)))
def test_normalizes_as_typescript_does(index: int) -> None:
    case = CASES[index]
    assert canonical(conformance.normalize(case["input"])) == canonical(case["output"]), fixtures.label(case["input"])


def test_keeps_objects_and_arrays_apart() -> None:
    assert canonical(conformance.normalize({"a": {}, "b": []})) == '{"a":{},"b":[]}'


def test_cookie_shape() -> None:
    assert conformance.cookie_shape("rl_session=abc123; Path=/; HttpOnly") == "rl_session=<value>; Path=/; HttpOnly"
    assert conformance.cookie_shape("rl_session=; Path=/; Max-Age=0") == "rl_session=; Path=/; Max-Age=0"
    assert conformance.cookie_shape("a=b=c") == "a=<value>"
    assert conformance.cookie_shape("no value here") == "no value here"

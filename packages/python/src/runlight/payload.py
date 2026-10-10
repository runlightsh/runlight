"""What the tracker sends, after validation. Anything malformed is dropped.

A Payload is a dict {"kind", "site", "url", "referrer", "title", "screenWidth", "screenHeight", "language",
"name", "props", "pageviewId", "engagedMs", "scroll"}: `url` is a runlight.http.Url, `props` a dict of strings
or None, and None stands for TypeScript's undefined in the three numbers that may be missing.

Text keeps JavaScript's lengths (UTF-16 units). A lone surrogate, sent as an escape or left by a cut through a
pair, reads as U+FFFD, which is how the SDK stores it.
"""

from __future__ import annotations

import re
from json.decoder import scanstring
from typing import Any

from . import _js
from .http import Url

MAX_BODY = 8 * 1024
# One engagement ping covers at most the 30 minutes a session can idle.
MAX_ENGAGED_MS = 30 * 60 * 1000
MAX_PROPS = 30

_PAGEVIEW_ID = re.compile(r"[a-z0-9]+\Z", re.IGNORECASE | re.ASCII)


def _str(value: Any, max: int) -> str:
    return _js.well_formed(_js.slice16(value, 0, max)) if isinstance(value, str) else ""


def _int(value: Any, lo: int, hi: int) -> int | None:
    if not _js.is_finite(value):
        return None
    return int(min(hi, max(lo, _js.js_round(value))))


def _props(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    out: dict[str, str] = {}
    count = 0
    for key in _js.object_keys(value):
        raw = value[key]
        if count >= MAX_PROPS:
            break
        k = _str(_js.trim(key), 60)
        if not k:
            continue
        if isinstance(raw, str):
            text = _str(raw, 500)
        elif _js.is_finite(raw):
            # JSON.parse reads every number as a double, so a long integer is rounded as it is there.
            text = _js.number_text(raw)
        elif isinstance(raw, bool):
            text = "true" if raw else "false"
        else:
            continue
        # Assigning out["__proto__"] in JavaScript sets the prototype, which a string cannot be, so nothing is
        # kept; it still counts.
        if k != "__proto__":
            out[k] = text
        count += 1
    if count == 0:
        return None
    # JavaScript's own key order: keys that are array indexes first, ascending, then the rest as added.
    return {key: out[key] for key in _js.object_keys(out)}


def _loads(text: str) -> tuple[bool, Any]:
    """JSON.parse: a byte order mark is not white space to it, so text that starts with one is not JSON."""
    try:
        return True, _js.loads(text)
    except (ValueError, RecursionError):
        return False, None


# Only the body itself and the props inside it are read; anything opened deeper than this is never looked at.
_KEPT_DEPTH = 2
_JSON_SPACE = " \t\n\r"
_NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?")


def _space(text: str, i: int) -> int:
    while i < len(text) and text[i] in _JSON_SPACE:
        i += 1
    return i


def _key(text: str, i: int) -> int:
    """Past an object's key and its colon, from where the key's quote should be."""
    if text[i : i + 1] != '"':
        raise ValueError("no key")
    i = _space(text, scanstring(text, i + 1, True)[1])
    if text[i : i + 1] != ":":
        raise ValueError("no colon")
    return i + 1


def _value_end(text: str, i: int) -> int:
    """Where the JSON value starting at `i` ends, checked as JSON.parse checks it, however deep it nests, with a
    stack rather than recursion. Raises ValueError for one that is not JSON."""
    closers: list[str] = []
    while True:
        i = _space(text, i)
        c = text[i : i + 1]
        if c == "{" or c == "[":
            i = _space(text, i + 1)
            closer = "}" if c == "{" else "]"
            if text[i : i + 1] == closer:
                i += 1
            else:
                closers.append(closer)
                if closer == "}":
                    i = _key(text, i)
                continue
        elif c == '"':
            i = scanstring(text, i + 1, True)[1]
        else:
            number = _NUMBER.match(text, i)
            if number:
                i = number.end()
            elif text.startswith(("true", "null"), i):
                i += 4
            elif text.startswith("false", i):
                i += 5
            else:
                raise ValueError("not a value")
        # After a value: the next in its container, or the container's end.
        while closers:
            i = _space(text, i)
            c = text[i : i + 1]
            if c == ",":
                i += 1
                if closers[-1] == "}":
                    i = _key(text, _space(text, i))
                break
            if c != closers[-1]:
                raise ValueError("unclosed")
            closers.pop()
            i += 1
        if not closers:
            return i


def _shallow(text: str) -> str | None:
    """The body with every array or object opened deeper than anything read put as null, which reads the same
    (props skip both), once it is checked to be JSON itself, so a body nested past Python's recursion limit reads
    as JavaScript reads it. None for a deep part that is not JSON, where JSON.parse would throw."""
    out: list[str] = []
    depth = 0
    i = start = 0
    try:
        while i < len(text):
            c = text[i]
            if c == '"':
                i = scanstring(text, i + 1, True)[1]
                continue
            if c in "{[":
                if depth >= _KEPT_DEPTH:
                    end = _value_end(text, i)
                    out.append(text[start:i])
                    out.append("null")
                    i = start = end
                    continue
                depth += 1
            elif c in "}]":
                depth -= 1
            i += 1
    except ValueError:
        return None
    out.append(text[start:])
    return "".join(out)


def _parse(text: str) -> tuple[bool, Any]:
    """JSON.parse, with no practical limit on nesting: Python's parser gives up past its recursion limit, where
    JavaScript reads a body of 8 KB however deep it nests. What is that deep is never read, so it is checked
    without recursion and left out, and the rest parsed as it is."""
    try:
        return True, _js.loads(text)
    except RecursionError:
        shallow = _shallow(text)
        return (False, None) if shallow is None else _loads(shallow)
    except ValueError:
        return False, None


def parse_payload(text: str) -> dict[str, Any] | None:
    if _js.length(text) > MAX_BODY:
        return None
    ok, body = _parse(text)
    if not ok or not isinstance(body, dict):
        return None

    kind = body.get("k")
    if kind not in ("pageview", "event", "engagement"):
        return None

    url = Url.parse(_str(body.get("u"), 2048))
    if url is None or url.protocol not in ("http:", "https:"):
        return None

    name = _js.trim(_str(body.get("n"), 120))
    if kind == "event" and not name:
        return None

    pageview_id = _str(body.get("i"), 32)
    if pageview_id and not _PAGEVIEW_ID.match(pageview_id):
        return None
    if kind == "engagement" and not pageview_id:
        return None

    engaged = _int(body.get("e"), 0, MAX_ENGAGED_MS) if kind == "engagement" else 0
    return {
        "kind": kind,
        "site": _str(body.get("s"), 64),
        "url": url,
        "referrer": _str(body.get("r"), 2048),
        "title": _str(body.get("t"), 500),
        "screenWidth": _int(body.get("w"), 0, 20000),
        "screenHeight": _int(body.get("h"), 0, 20000),
        "language": _str(body.get("l"), 35),
        "name": name,
        "props": _props(body.get("p")) if kind == "event" else None,
        "pageviewId": pageview_id,
        "engagedMs": engaged if engaged is not None else 0,
        "scroll": _int(body.get("d"), 0, 100),
    }

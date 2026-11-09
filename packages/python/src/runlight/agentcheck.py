"""Checks a request that names an AI agent against the addresses that agent's company publishes. Every list is in
the same shape, {"prefixes": [{"ipv4Prefix": "a.b.c.d/n"} or {"ipv6Prefix": "x::/n"}]}. A port of the TypeScript
SDK's agentcheck.ts.

The answer is "verified" when the address is in the list, "mismatch" when the company publishes a list and the
address is not in it, and "" when there is nothing to check against: no list for that agent, or no usable address.
The address is only compared, never kept.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from . import _js
from .http import Fetcher

# A list of more prefixes than this, or a reply bigger than MAX_LIST_BYTES, is not a list we read.
MAX_PREFIXES = 20_000
MAX_LIST_BYTES = 4_000_000

_DIGITS = re.compile(r"[0-9]{1,3}\Z")
_HEX_TEXT = re.compile(r"[0-9a-fA-F:.]+\Z")
_GROUP = re.compile(r"[0-9a-fA-F]{1,4}\Z")

# An address or a prefix: (family, number), family 4 or 6.
Address = tuple[int, int]


def _ipv4(text: str) -> int | None:
    parts = text.split(".")
    if len(parts) != 4:
        return None
    n = 0
    for part in parts:
        if not _DIGITS.match(part):
            return None
        byte = int(part)
        if byte > 255:
            return None
        n = n * 256 + byte
    return n


def _ipv6(text: str) -> int | None:
    if not _HEX_TEXT.match(text) or len(text.split("::")) > 2:
        return None
    # A dotted IPv4 tail ("::ffff:1.2.3.4") stands for the last two groups.
    groups = text
    dot = text.rfind(":")
    if "." in text:
        tail = _ipv4(text[dot + 1 :])
        if tail is None:
            return None
        groups = f"{text[: dot + 1]}{tail >> 16:x}:{tail & 0xFFFF:x}"
    pieces = groups.split("::")
    head = pieces[0]
    rest = pieces[1] if len(pieces) > 1 else None
    left = head.split(":") if head else []
    right = [] if rest is None else rest.split(":") if rest else []
    missing = 8 - len(left) - len(right)
    if (missing != 0) if rest is None else (missing < 1):
        return None
    every = [*left, *(["0"] * (0 if rest is None else missing)), *right]
    n = 0
    for group in every:
        if not _GROUP.match(group):
            return None
        n = (n << 16) | int(group, 16)
    return n


def parse_address(text: str) -> Address | None:
    """An address as the check reads it: surrounding space, [brackets], and an IPv6 zone ("%eth0") are ignored, and
    an IPv4 address written as IPv6 (::ffff:1.2.3.4) is read as IPv4. (4, n) or (6, n), or None when it is not one."""
    s = _js.trim(text)
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    zone = s.find("%")
    if zone != -1:
        s = s[:zone]
    if not s:
        return None
    if ":" not in s:
        n = _ipv4(s)
        return None if n is None else (4, n)
    n = _ipv6(s)
    if n is None:
        return None
    if n >> 32 == 0xFFFF:
        return (4, n & 0xFFFFFFFF)
    return (6, n)


def _parse_prefix(text: str) -> tuple[int, int, int] | None:
    """A prefix such as 20.171.206.0/24 or 2600:1f28::/56 as (family, base, bits), or None. Bits past the length are
    ignored."""
    slash = text.find("/")
    if slash == -1:
        return None
    bits_text = text[slash + 1 :]
    if not _DIGITS.match(bits_text):
        return None
    bits = int(bits_text)
    head = text[:slash]
    if ":" in head:
        n = _ipv6(head)
        if n is None or bits > 128:
            return None
        return (6, n, bits)
    n = _ipv4(head)
    if n is None or bits > 32:
        return None
    return (4, n, bits)


def _covers(prefix: tuple[int, int, int], address: Address) -> bool:
    family, base, bits = prefix
    if family != address[0]:
        return False
    shift = (32 if family == 4 else 128) - bits
    return address[1] >> shift == base >> shift


def read_range_list(body: Any) -> list[str] | None:
    """The prefixes in a published list, or None when the reply is not a list in the expected shape (not an object,
    no prefixes, an entry that is not a prefix, or too many). One bad entry rejects the whole list, so a half broken
    download never replaces a good copy."""
    if not isinstance(body, dict):
        return None
    prefixes = body.get("prefixes")
    if not isinstance(prefixes, list) or len(prefixes) == 0 or len(prefixes) > MAX_PREFIXES:
        return None
    out: list[str] = []
    for entry in prefixes:
        if not isinstance(entry, dict):
            return None
        v4 = entry.get("ipv4Prefix")
        v6 = entry.get("ipv6Prefix")
        text = v4 if isinstance(v4, str) else v6 if isinstance(v6, str) else None
        if text is None:
            return None
        prefix = _parse_prefix(_js.trim(text))
        if prefix is None or isinstance(v4, str) != (prefix[0] == 4):
            return None
        out.append(_js.trim(text))
    return out


def download_range_list(fetcher: Fetcher, url: str, timeout_ms: int = 15_000) -> list[str] | None:
    """Downloads one published list. None when it cannot be fetched or read; the caller keeps what it had."""
    try:
        response = fetcher.fetch(
            url,
            {
                "headers": {"accept": "application/json", "user-agent": "Runlight (+https://runlight.sh)"},
                "redirect": "follow",
                "timeoutMs": timeout_ms,
                "maxBytes": MAX_LIST_BYTES,
            },
        )
        if not response.ok:
            return None
        length = _js.number(response.headers.get("content-length") or 0)
        if length > MAX_LIST_BYTES:
            return None
        content = response.content()
        if len(content) > MAX_LIST_BYTES:
            return None
        return read_range_list(_js.loads(content))
    except Exception:
        return None


_compiled: dict[int, tuple[list[str], list[tuple[int, int, int]]]] = {}


def _prefixes_of(ranges: list[str]) -> list[tuple[int, int, int]]:
    # Kept with the list itself, so a list replaced by a download is parsed again and the old one is let go.
    cached = _compiled.get(id(ranges))
    if cached is not None and cached[0] is ranges:
        return cached[1]
    parsed = [p for p in (_parse_prefix(text) for text in ranges) if p is not None]
    if len(_compiled) > 64:
        _compiled.clear()
    _compiled[id(ranges)] = (ranges, parsed)
    return parsed


def in_ranges(ip: str, ranges: list[str]) -> bool:
    """Whether `ip` is inside any of the prefixes. False for an address that cannot be read."""
    address = parse_address(ip)
    return address is not None and any(_covers(p, address) for p in _prefixes_of(ranges))


def check_agent(agent: Mapping[str, Any], ip: str, lists: Mapping[str, list[str]]) -> str:
    """The check for one request that names `agent`, made from `ip` (see the top of this module): "verified",
    "mismatch", or ""."""
    url = agent.get("ranges")
    found = lists.get(url) if url else None
    if not found or parse_address(ip) is None:
        return ""
    return "verified" if in_ranges(ip, found) else "mismatch"


def saved_lists(stored: str | None) -> dict[str, Any] | None:
    """The lists saved in the "agent-ranges" setting, {"at", "lists"}, each list read as a download is. None when
    nothing usable is saved."""
    if not stored:
        return None
    try:
        parsed = _js.loads(stored)
    except Exception:
        return None
    if parsed is None:
        return None
    lists: dict[str, list[str]] = {}
    raw = parsed.get("lists") if isinstance(parsed, dict) else None
    if isinstance(raw, dict):
        for url, ranges in raw.items():
            entries = [{"ipv6Prefix": p} if ":" in _js.string(p) else {"ipv4Prefix": p} for p in ranges] if isinstance(ranges, list) else None
            prefixes = read_range_list({"prefixes": entries})
            if prefixes:
                lists[url] = prefixes
    at = _js.number(parsed.get("at")) if isinstance(parsed, dict) else 0
    return {"at": at if at == at else 0, "lists": lists}

"""The route-level part of hardening.test.ts: a link domain's check, and the warning about trustProxy left at its
default. The rest belongs to the core, safefetch, and the stores."""

from __future__ import annotations

import pytest

from runlight.http import Request, Response
from support.routes import body, owner, runlight


class _Answers404:
    def fetch(self, url, init=None):
        return Response("no", 404)


def test_a_link_domains_check_says_where_the_domain_should_point_for_its_setup_steps() -> None:
    rl = runlight({"site": {"hostnames": ["example.com"]}, "fetcher": _Answers404()})
    rl.init()
    rl.store.add_link_domain("go.example.net", "default", 0)
    check = body(rl.routes({"token": "secret"}).handle(owner("/runlight/api/link-domains/go.example.net/check")))
    assert check["target"]["host"] == "example.com", "this dashboard's own name, for a CNAME"
    assert isinstance(check["target"]["addresses"], list)
    assert check["working"] is False


def test_with_trust_proxy_left_at_its_default_forwarding_headers_count_only_from_a_private_address(
    capsys: pytest.CaptureFixture[str],
) -> None:
    bare = Request("https://example.com/e")
    forwarded = Request("https://example.com/e", headers={"x-forwarded-for": "8.8.4.4"})
    quiet = runlight({"site": {"hostnames": ["example.com"]}, "trustProxy": True})
    assert quiet.client_ip(forwarded, {"ip": "8.8.8.8"}) == "8.8.4.4", "trustProxy set on purpose believes a public address"
    assert capsys.readouterr().err == "", "and is never second-guessed"

    rl = runlight({"site": {"hostnames": ["example.com"]}})
    assert rl.client_ip(forwarded, {"ip": "10.0.0.2"}) == "8.8.4.4", "a proxy on a private network is believed"
    assert rl.client_ip(forwarded, {"ip": "::ffff:127.0.0.1"}) == "8.8.4.4", "and one on this computer"
    assert rl.client_ip(forwarded) == "8.8.4.4", "and a platform that passes no address on"
    assert rl.client_ip(bare, {"ip": "8.8.8.8"}) == "8.8.8.8"
    assert capsys.readouterr().err == "", "a public address without forwarding headers says nothing"
    assert rl.client_ip(forwarded, {"ip": "1.1.1.1"}) == "1.1.1.1", "a client straight from the internet cannot choose its address"
    rl.client_ip(forwarded, {"ip": "1.0.0.1"})
    said = capsys.readouterr().err.splitlines()
    assert len(said) == 1, "said once"
    assert "cf-connecting-ip" in said[0]

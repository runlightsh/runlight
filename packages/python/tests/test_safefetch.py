"""Ports safefetch.test.ts, replays the address checks in the outbound fixture, and covers each hop's checks."""

from __future__ import annotations

import select
import socket
import threading
from collections.abc import Callable, Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from support import fixtures
from support.fake_fetcher import FakeFetcher

from runlight.assistant import AssistantError, chat, list_models
from runlight.http import FetchError, Response, UrllibFetcher
from runlight.mail.transports import MailError, send
from runlight.safefetch import MetadataAddressError, PrivateAddressError, RedirectRefusedError, public_address, public_addresses, public_fetch, service_fetch
from runlight.safefetch import install_address, install_fetch, metadata_address, metadata_host, resolves_privately


def urls(fetcher: FakeFetcher) -> list[str]:
    return [r["url"] for r in fetcher.requests]


def dns(names: dict[str, list[str]]) -> Callable[[str], list[str]]:
    """A DNS stand-in."""
    return lambda name: names.get(name, [])


def test_link_local_and_cloud_metadata_addresses_are_told_apart_from_loopback_and_private_ones():
    for ip in ["169.254.169.254", "169.254.0.1", "100.100.100.200", "fe80::1", "fe80::a9fe:a9fe", "fd00:ec2::254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "::ffff:0:a9fe:a9fe"]:
        assert metadata_address(ip) is True, ip
    for ip in ["127.0.0.1", "::1", "10.0.0.5", "192.168.1.20", "fd00::1", "fd00:ec2::253", "93.184.215.14", "not an address"]:
        assert metadata_address(ip) is False, ip
    assert metadata_host("metadata.google.internal") is True
    assert metadata_host("[fd00:ec2::254]") is True
    assert metadata_host("169.254.169.254") is True
    assert metadata_host("localhost") is False, "a model on this computer is fine"
    assert metadata_host("192.168.1.20") is False
    assert metadata_host("models.example.com", dns({"models.example.com": ["93.184.215.14", "169.254.169.254"]})) is True, "any address it resolves to"
    assert metadata_host("nowhere.example.com", dns({})) is False, "a name that does not resolve is let through"


def hops(answers: list[Response]) -> FakeFetcher:
    queue = list(answers)
    return FakeFetcher(lambda url, init: queue.pop(0) if queue else Response("end"))


def test_only_addresses_on_the_public_internet_count_as_public() -> None:
    for ip in ["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:82a::200e", "::ffff:0:808:808", "64:ff9b::808:808"]:
        assert public_address(ip), ip
    for ip in [
        "127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
        "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1",
        "::ffff:169.254.169.254", "64:ff9b::a00:1", "2002:a00:1::", "2001:db8::1", "2001:0:4136:e378::1", "[::1]",
        "not an address", "1.2.3", "1.2.3.256",
        # IPv4-translated loopback, local-use NAT64, the old site-local, ORCHID, the newer documentation prefix, and discard.
        "::ffff:0:7f00:1", "64:ff9b:1::7f00:1", "fec0::1", "2001:20::1", "3fff::1", "100::1",
    ]:  # fmt: skip
        assert not public_address(ip), ip


def test_address_checks_match_typescript() -> None:
    for case in fixtures.load("outbound")["ips"]:
        assert public_address(case["ip"]) == case["public"], case["ip"]


def test_a_public_fetch_never_reaches_the_installs_own_network_however_the_address_is_written() -> None:
    # Something listening locally, which none of these may reach.
    inside = socket.socket()
    inside.bind(("127.0.0.1", 0))
    inside.listen()
    port = inside.getsockname()[1]
    try:
        for url in [
            f"http://127.0.0.1:{port}/", f"https://127.0.0.1:{port}/", f"https://[::1]:{port}/",
            f"https://[::ffff:127.0.0.1]:{port}/", f"https://localhost:{port}/", f"https://LOCALHOST.:{port}/",
            f"https://app.localhost:{port}/",
        ]:  # fmt: skip
            with pytest.raises(PrivateAddressError):
                public_fetch(url, {"timeoutMs": 2000})
        ready, _, _ = select.select([inside], [], [], 0)
        assert ready == [], "nothing connected"
        assert resolves_privately("localhost")
        assert not resolves_privately("name.that.does.not.resolve.invalid")
        assert public_addresses("name.that.does.not.resolve.invalid") == []
        assert public_addresses("8.8.8.8") == ["8.8.8.8"]
        assert public_addresses("localhost") == []
    finally:
        inside.close()


def test_the_checked_addresses_are_pinned() -> None:
    fetcher = FakeFetcher(lambda url, init: Response("ok"))
    answer = public_fetch(
        "https://Example.com/icon",
        {
            "timeoutMs": 2000,
            "headers": {"user-agent": "Runlight"},
            "maxBytes": 10,
            "lookup": dns({"example.com": ["93.184.215.14", "2606:4700::1111"]}),
        },
        fetcher,
    )
    assert answer.text() == "ok"
    assert fetcher.inits[0]["resolve"] == ["example.com:443:93.184.215.14,[2606:4700::1111]"]
    assert fetcher.inits[0]["redirect"] == "manual"
    assert fetcher.inits[0]["maxBytes"] == 10
    assert fetcher.inits[0]["headers"] == {"user-agent": "Runlight"}
    assert urls(fetcher) == ["https://example.com/icon"]

    literal = FakeFetcher(lambda url, init: Response("ok"))
    public_fetch("https://93.184.215.14:8443/", {"timeoutMs": 2000, "lookup": dns({})}, literal)
    # An address needs no pin.
    assert "resolve" not in literal.inits[0]


def test_a_name_with_any_private_address_is_refused() -> None:
    fetcher = FakeFetcher(lambda url, init: Response("ok"))
    for name, addresses in {
        "inside.example": ["10.0.0.5"],
        "mixed.example": ["93.184.215.14", "169.254.169.254"],
        "mapped.example": ["::ffff:127.0.0.1"],
    }.items():
        with pytest.raises(PrivateAddressError, match=f"^{name} is not a public address$"):
            public_fetch(f"https://{name}/", {"timeoutMs": 2000, "lookup": dns({name: addresses})}, fetcher)
    assert urls(fetcher) == []
    with pytest.raises(FetchError):
        public_fetch("https://nowhere.example/", {"timeoutMs": 2000, "lookup": dns({})}, fetcher)


def test_redirects_are_followed_by_hand_under_the_same_rules() -> None:
    lookup = dns({"a.example": ["93.184.215.14"], "b.example": ["1.1.1.1"], "inside.example": ["192.168.0.2"]})

    fetcher = hops([Response.redirect("/next", 301), Response.redirect("https://b.example/last", 302), Response("done")])
    answer = public_fetch("https://a.example/", {"timeoutMs": 2000, "redirects": 3, "lookup": lookup}, fetcher)
    assert answer.text() == "done"
    assert urls(fetcher) == ["https://a.example/", "https://a.example/next", "https://b.example/last"]
    assert fetcher.inits[2]["resolve"] == ["b.example:443:1.1.1.1"]

    fetcher = hops([Response.redirect("https://b.example/", 302)])
    # A redirect past the last comes back as it is.
    assert public_fetch("https://a.example/", {"timeoutMs": 2000, "lookup": lookup}, fetcher).status == 302

    for location, what in {
        "https://10.0.0.1/": "10.0.0.1",
        "https://inside.example/": "inside.example",
        "http://b.example/": "http://b.example/",
        "https://[fe80::1]/": "fe80::1",
    }.items():
        with pytest.raises(PrivateAddressError) as raised:
            public_fetch(
                "https://a.example/",
                {"timeoutMs": 2000, "redirects": 3, "lookup": lookup},
                hops([Response.redirect(location)]),
            )
        assert str(raised.value) == f"{what} is not a public address"


def test_running_out_of_time_says_so() -> None:
    def times_out(url: str, init: dict) -> Response:
        raise FetchError("Operation timed out", True)

    with pytest.raises(FetchError) as raised:
        public_fetch("https://a.example/", {"timeoutMs": 2000, "lookup": dns({"a.example": ["1.1.1.1"]})}, FakeFetcher(times_out))
    assert raised.value.timed_out
    assert str(raised.value) == "The operation was aborted due to timeout"

    def refuses(url: str, init: dict) -> Response:
        raise FetchError("Connection refused")

    with pytest.raises(FetchError, match="Connection refused"):
        public_fetch("https://a.example/", {"timeoutMs": 2000, "lookup": dns({"a.example": ["1.1.1.1"]})}, FakeFetcher(refuses))


def test_only_a_get_follows_redirects_and_an_install_fetch_follows_none() -> None:
    lookup = dns({"a.example": ["93.184.215.14"]})
    fetcher = hops([Response.redirect("/next", 307)])
    init = {"timeoutMs": 2000, "redirects": 3, "method": "POST", "body": "x", "lookup": lookup}
    assert public_fetch("https://a.example/", init, fetcher).status == 307
    assert urls(fetcher) == ["https://a.example/"]
    assert fetcher.inits[0]["method"] == "POST"
    assert fetcher.inits[0]["body"] == "x"

    fetcher = hops([Response.redirect("/next", 302)])
    assert install_fetch("https://a.example/api/sites", {"timeoutMs": 2000, "local": False, "lookup": lookup}, fetcher).status == 302
    assert urls(fetcher) == ["https://a.example/api/sites"]


def test_an_install_on_this_machine_only_when_code_allows_it() -> None:
    assert install_address("https://example.com/runlight", False)
    assert not install_address("http://localhost:3000", False)
    assert install_address("http://localhost:3000", True)
    assert install_address("http://127.0.0.1:3000/runlight", True)
    assert not install_address("http://localhost.evil.com", True)
    assert not install_address("http://10.0.0.2", True)
    fetcher = hops([Response("ok")])
    assert install_fetch("http://127.0.0.1:3000/api/sites", {"timeoutMs": 2000, "local": True}, fetcher).text() == "ok"
    assert fetcher.inits[0]["redirect"] == "manual"
    for url, local in [("http://127.0.0.1:3000/api/sites", False), ("https://127.0.0.1:3000/api/sites", True)]:
        with pytest.raises(PrivateAddressError):
            install_fetch(url, {"timeoutMs": 2000, "local": local}, hops([]))


class _Services(BaseHTTPRequestHandler):
    """A service on this computer that redirects, recording every request it is asked."""

    seen: list[dict[str, str]] = []

    def _answer(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else ""
        self.seen.append(
            {
                "method": self.command,
                "url": self.path,
                "body": body,
                "authorization": self.headers.get("authorization") or "",
                "type": self.headers.get("content-type") or "",
            }
        )
        port = self.server.server_address[1]
        moves = {
            "/metadata": (302, "http://169.254.169.254/latest/meta-data/"),
            "/metadata-v6": (307, "http://[fd00:ec2::254]/"),
            "/see-other": (303, "/landed"),
            "/keep": (307, "/landed"),
            "/elsewhere": (307, f"http://localhost:{port}/landed"),
            "/loop": (302, "/loop"),
        }
        path = self.path.split("?")[0]
        if path in moves:
            status, location = moves[path]
            self.send_response(status)
            self.send_header("location", location)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("content-length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    do_GET = do_POST = do_HEAD = _answer

    def log_message(self, *args: object) -> None:
        pass


@pytest.fixture
def services() -> Iterator[str]:
    _Services.seen = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Services)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


def test_a_services_redirects_are_followed_only_while_each_one_stays_off_link_local_and_metadata_addresses(services: str) -> None:
    seen = _Services.seen
    ask = {"method": "POST", "headers": {"authorization": "Bearer key", "content-type": "application/json"}, "body": "{}", "timeoutMs": 5000}
    # A service on this computer is fine; a redirect to a metadata address is refused before it is asked.
    with pytest.raises(MetadataAddressError) as refused:
        service_fetch(f"{services}/metadata", ask)
    assert refused.value.host == "169.254.169.254"
    assert str(refused.value) == "169.254.169.254 is a link-local or cloud metadata address, which Runlight never connects to"
    with pytest.raises(MetadataAddressError) as refused:
        service_fetch(f"{services}/metadata-v6", ask)
    assert refused.value.host == "fd00:ec2::254"
    with pytest.raises(MetadataAddressError):
        service_fetch("http://169.254.169.254/v1/models", {})
    # Followed as fetch follows them: a 303 goes on as a GET with no body, a 307 keeps both, and the key goes no
    # further than the origin it was meant for.
    seen.clear()
    assert service_fetch(f"{services}/see-other", ask).text() == "ok"
    assert seen[1] == {"method": "GET", "url": "/landed", "body": "", "authorization": "Bearer key", "type": ""}
    seen.clear()
    service_fetch(f"{services}/keep", ask)
    assert seen[1] == {"method": "POST", "url": "/landed", "body": "{}", "authorization": "Bearer key", "type": "application/json"}
    # Another origin, even the same computer under another name, is never asked.
    seen.clear()
    with pytest.raises(RedirectRefusedError) as elsewhere:
        service_fetch(f"{services}/elsewhere", ask)
    assert elsewhere.value.to == f"http://localhost:{services.rsplit(':', 1)[1]}"
    assert len(seen) == 1
    # Past the last redirect, the redirect comes back as it is.
    seen.clear()
    assert service_fetch(f"{services}/loop", {"redirects": 2}).status == 302
    assert len(seen) == 3
    # The AI assistant and a mail webhook refuse such a redirect with the address it led to.
    with pytest.raises(AssistantError) as assistant:
        list_models({"provider": "custom", "baseUrl": f"{services}/metadata#", "key": ""})
    assert assistant.value.code == "address_refused"
    assert assistant.value.params == {"host": "169.254.169.254"}
    message = {"to": "me@example.com", "from": "reports@example.com", "subject": "Hi", "html": "<p>Hi</p>", "text": "Hi"}
    with pytest.raises(MailError) as mail:
        send({"service": "webhook", "url": f"{services.replace('127.0.0.1', 'localhost')}/metadata"}, message)
    assert mail.value.code == "address_refused"
    assert mail.value.params == {"host": "169.254.169.254"}
    assert str(mail.value) == "169.254.169.254 is a link-local or cloud metadata address, which Runlight never connects to"


def test_a_pinned_request_goes_to_the_pinned_address_and_never_through_a_proxy(services: str, monkeypatch: pytest.MonkeyPatch) -> None:
    port = services.rsplit(":", 1)[1]
    # A proxy that would answer for every request, were it asked.
    proxy = ThreadingHTTPServer(("127.0.0.1", 0), _Services)
    thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    thread.start()
    try:
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
            monkeypatch.setenv(name, f"http://127.0.0.1:{proxy.server_address[1]}")
        monkeypatch.delenv("NO_PROXY", raising=False)
        monkeypatch.delenv("no_proxy", raising=False)
        _Services.seen = []
        answer = UrllibFetcher().fetch(f"http://pinned.invalid:{port}/landed", {"resolve": [f"pinned.invalid:{port}:127.0.0.1"], "redirect": "manual"})
        assert answer.text() == "ok"
        assert [s["url"] for s in _Services.seen] == ["/landed"], "asked directly, at the pinned address, and the proxy never"
        # A pin that does not cover the request refuses it, rather than fetch it unpinned.
        with pytest.raises(FetchError, match="not pinned"):
            UrllibFetcher().fetch(f"http://pinned.invalid:{port}/landed", {"resolve": [f"other.invalid:{port}:127.0.0.1"]})
        assert len(_Services.seen) == 1
    finally:
        proxy.shutdown()
        proxy.server_close()


def test_a_services_redirect_to_another_origin_is_refused_before_anything_its_key_or_its_body_is_sent_there() -> None:
    asked: list[dict] = []

    def moved(location: str, status: int) -> FakeFetcher:
        def answer(url: str, init: dict) -> Response:
            asked.append({"url": url, "headers": dict(init.get("headers") or {}), "body": init.get("body")})
            return Response("", status, {"location": location})

        return FakeFetcher(answer)

    # Every header a service names its key in, and a 307 that would keep the body.
    for key in ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-postmark-server-token"]:
        asked.clear()
        with pytest.raises(RedirectRefusedError):
            service_fetch("https://93.184.215.14/v1/messages", {"method": "POST", "headers": {key: "secret"}, "body": "a conversation"}, moved("http://198.51.100.7/steal", 307))
        assert len(asked) == 1, f"{key}: nothing goes to the other origin"
    # https to http on the same host is another origin too.
    asked.clear()
    with pytest.raises(RedirectRefusedError) as downgraded:
        service_fetch("https://93.184.215.14/v1/messages", {"method": "POST", "body": "{}"}, moved("http://93.184.215.14/v1/messages", 308))
    assert downgraded.value.to == "http://93.184.215.14"
    assert downgraded.value.host == "93.184.215.14"
    assert len(asked) == 1

    fetcher = moved("http://198.51.100.7/steal", 307)
    # The assistant, with Anthropic's x-api-key, both listing models and asking a question.
    asked.clear()
    with pytest.raises(AssistantError) as models:
        list_models({"provider": "anthropic", "baseUrl": "https://93.184.215.14/v1", "key": "sk-ant-secret"}, fetcher)
    assert models.value.code == "redirect_refused"
    assert models.value.params == {"host": "93.184.215.14", "to": "http://198.51.100.7"}
    context = {"site": {"id": "a", "name": "A", "timezone": "UTC"}, "today": "2026-10-12", "view": "today", "language": "en"}
    with pytest.raises(AssistantError) as asking:
        chat({"provider": "anthropic", "model": "m", "baseUrl": "https://93.184.215.14/v1", "key": "sk-ant-secret"}, [{"role": "user", "content": "How many visitors?"}], context, lambda *a: Response("{}"), fetcher=fetcher)
    assert asking.value.code == "redirect_refused"
    assert [(a["url"], a["headers"].get("x-api-key")) for a in asked] == [
        ("https://93.184.215.14/v1/models?limit=100", "sk-ant-secret"),
        ("https://93.184.215.14/v1/messages", "sk-ant-secret"),
    ]

    # Mail services, with Brevo's api-key and Postmark's server token, and a webhook.
    message = {"to": "me@example.com", "from": "reports@example.com", "subject": "Hi", "html": "<p>Hi</p>", "text": "Hi"}
    for config in [{"service": "brevo", "apiKey": "xkeysib-secret"}, {"service": "postmark", "serverToken": "pm-secret"}, {"service": "webhook", "url": "https://93.184.215.14/hook"}]:
        asked.clear()
        with pytest.raises(MailError) as mail:
            send(config, message, fetcher)
        assert mail.value.code == "redirect_refused"
        assert mail.value.params == {"host": mail.value.params["host"], "to": "http://198.51.100.7"}
        assert len(asked) == 1, f"{config['service']}: the email goes nowhere else"


def test_a_service_is_fetched_from_the_addresses_its_name_was_checked_at_and_a_name_that_cannot_be_looked_up_is_refused(services: str) -> None:
    port = services.rsplit(":", 1)[1]
    url = f"http://models.example:{port}/v1/models"
    _Services.seen = []
    # A model on this computer, by a name of its own, is fine, and is connected to at the address checked, never
    # through a proxy and never by looking the name up again (models.example resolves nowhere).
    assert service_fetch(url, {"lookup": dns({"models.example": ["127.0.0.1"]})}).text() == "ok"
    assert len(_Services.seen) == 1
    # The first address that answers is the one used, as a name with several would be.
    assert service_fetch(url, {"lookup": dns({"models.example": ["::1", "127.0.0.1"]})}).text() == "ok"
    assert len(_Services.seen) == 2
    # The same name answering with a metadata address next time is refused before anything is sent.
    for address in ["169.254.169.254", "fd00:ec2::254"]:
        with pytest.raises(MetadataAddressError):
            service_fetch(url, {"method": "POST", "headers": {"x-api-key": "secret"}, "body": "{}", "lookup": dns({"models.example": ["127.0.0.1", address]})})
    # A name that cannot be looked up gets nowhere, rather than being let through to a lookup of the fetcher's own.
    with pytest.raises(FetchError, match="ENOTFOUND"):
        service_fetch(url, {"lookup": dns({})})
    assert len(_Services.seen) == 2

    # The request carries the checked addresses for the fetcher to connect to, on every hop.
    fetcher = hops([Response("", 302, {"location": "/next"}), Response("ok")])
    service_fetch("https://models.example/v1/models", {"lookup": dns({"models.example": ["93.184.215.14", "2606:4700::1111"]})}, fetcher)
    assert [i["resolve"] for i in fetcher.inits] == [["models.example:443:93.184.215.14,[2606:4700::1111]"]] * 2


class _Endless(BaseHTTPRequestHandler):
    """A service whose answer never ends, counting what it managed to send before the reader gave up."""

    sent = 0
    status = 200

    def _answer(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        if length:
            self.rfile.read(length)
        self.send_response(self.status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        chunk = b" " * 65_536
        try:
            while True:
                self.wfile.write(chunk)
                _Endless.sent += len(chunk)
        except OSError:
            pass

    do_GET = do_POST = _answer

    def log_message(self, *args: object) -> None:
        pass


def test_an_answer_from_a_model_or_a_mail_service_is_read_only_so_far() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Endless)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        _Endless.sent, _Endless.status = 0, 200
        with pytest.raises(AssistantError):
            list_models({"provider": "custom", "baseUrl": base, "key": ""})
        assert 0 < _Endless.sent < 16 * 1024 * 1024, "a model list is read no further than the cap"
        _Endless.sent, _Endless.status = 0, 500
        message = {"to": "me@example.com", "from": "reports@example.com", "subject": "Hi", "html": "<p>Hi</p>", "text": "Hi"}
        with pytest.raises(MailError) as mail:
            send({"service": "webhook", "url": f"{base}/hook"}, message)
        assert mail.value.code == "mail_refused"
        assert 0 < _Endless.sent < 8 * 1024 * 1024, "a mail service's error is read no further than the cap"
    finally:
        server.shutdown()
        server.server_close()

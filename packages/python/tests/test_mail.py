"""Ports mail.test.ts, and replays tests/fixtures/outbound.json: every service sends the TypeScript SDK's exact
requests."""

from __future__ import annotations

import base64
import re
import socket
import threading
import time
from datetime import datetime, timezone

import pytest
from support import fixtures
from support.fake_fetcher import FakeFetcher
from support.smtp_server import SmtpServer

from runlight import Runlight, _js
from runlight.http import FetchError, Request, Response, SearchParams
from runlight.mail import SERVICES, MailError, mime, seal, send, service_message, sign_v4, smtp_send, unseal
from runlight.mail.smtp import _Session
from runlight.store import Stores

MESSAGE = {
    "to": "jon@example.com",
    "from": "reports@example.com",
    "fromName": "Runlight",
    "subject": "Hello",
    "html": "<p>Hi</p>",
    "text": "Hi",
    "headers": {"List-Unsubscribe": "<https://x/u>"},
}


def fixture():
    return fixtures.load("outbound")


def capture(status: int = 200) -> FakeFetcher:
    return FakeFetcher(lambda url, init: Response("{}" if status == 200 else "nope", status))


def uuids():
    """A UUID stand-in that counts from 1, as the fixture script's does."""
    n = 0

    def next_uuid() -> str:
        nonlocal n
        n += 1
        return f"00000000-0000-4000-8000-{n:012d}"

    return next_uuid


def failure(error: MailError) -> dict:
    return {"message": error.message, "code": error.code, "params": error.params}


def test_sealed_keys_open_only_with_the_same_secret():
    sealed = seal('{"apiKey":"re_123"}', "server secret")
    assert sealed.startswith("v1:") and "re_123" not in sealed
    assert unseal(sealed, "server secret") == '{"apiKey":"re_123"}'
    assert unseal(sealed, "another secret") is None
    assert unseal(seal("x", None), None) == "x", "with no secret the value is kept as typed"
    assert unseal("v1:AAAA:AAAA", "server secret") is None, "damaged"
    assert unseal("v2:a:b", "server secret") is None
    assert unseal(sealed, None) is None


def test_keys_sealed_by_typescript_open_here():
    for case in fixture()["sealed"]:
        assert unseal(case["sealed"], case["secret"]) == case["value"]
        assert unseal(case["sealed"], f"{case['secret']}!") is None
        # A value of None is a sealed form TypeScript cannot open (an IV under 12 bytes), so there is nothing to seal again.
        if case["value"] is not None:
            assert unseal(seal(case["value"], case["secret"]), case["secret"]) == case["value"]


def test_sig_v4_matches_aws_published_example():
    # https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html (the IAM ListUsers example)
    headers = sign_v4({
        "method": "GET",
        "url": "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
        "body": "",
        "region": "us-east-1",
        "service": "iam",
        "accessKeyId": "AKIDEXAMPLE",
        "secretAccessKey": "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        "now": int(datetime(2015, 8, 30, 12, 36, tzinfo=timezone.utc).timestamp()) * 1000,
        "headers": {"content-type": "application/x-www-form-urlencoded; charset=utf-8"},
    })  # fmt: skip
    assert headers["authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, "
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
    )


def test_sig_v4_matches_typescript():
    for case in fixture()["signatures"]:
        signed = sign_v4(case["input"])
        assert signed == case["headers"], case["input"]["url"]
        assert list(signed) == list(case["headers"]), "in the same order"


def test_each_service_gets_the_request_it_documents():
    calls = capture()
    send({"service": "resend", "apiKey": "re_1"}, MESSAGE, calls)
    assert calls.requests[0]["url"] == "https://api.resend.com/emails"
    assert calls.requests[0]["headers"]["authorization"] == "Bearer re_1"
    assert _js.loads(calls.requests[0]["body"])["to"] == ["jon@example.com"]
    assert _js.loads(calls.requests[0]["body"])["from"] == "Runlight <reports@example.com>"

    calls = capture()
    send({"service": "postmark", "serverToken": "pm"}, MESSAGE, calls)
    assert calls.requests[0]["headers"]["x-postmark-server-token"] == "pm"
    assert _js.loads(calls.requests[0]["body"])["MessageStream"] == "outbound"

    calls = capture()
    send({"service": "mailgun", "apiKey": "key", "domain": "mg.example.com", "region": "eu"}, MESSAGE, calls)
    assert calls.requests[0]["url"] == "https://api.eu.mailgun.net/v3/mg.example.com/messages"
    assert calls.requests[0]["headers"]["authorization"] == "Basic " + base64.b64encode(b"api:key").decode()
    assert SearchParams(calls.requests[0]["body"]).get("h:List-Unsubscribe") == "<https://x/u>"

    calls = capture()
    send({"service": "ses", "region": "eu-west-1", "accessKeyId": "AKID", "secretAccessKey": "secret"}, MESSAGE, calls)
    assert calls.requests[0]["url"] == "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails"
    assert re.match(r"AWS4-HMAC-SHA256 Credential=AKID/\d{8}/eu-west-1/ses/aws4_request", calls.requests[0]["headers"]["authorization"])

    calls = capture()
    send({"service": "webhook", "url": "https://hooks.example.com/mail", "secret": "s"}, MESSAGE, calls)
    assert re.fullmatch(r"sha256=[a-f0-9]{64}", calls.requests[0]["headers"]["x-runlight-signature"])

    refused = capture(401)
    with pytest.raises(MailError, match="api.sendgrid.com answered 401"):
        send({"service": "sendgrid", "apiKey": "bad"}, MESSAGE, refused)
    with pytest.raises(MailError, match="must use https"):
        send({"service": "webhook", "url": "http://example.com/x"}, MESSAGE, refused)
    with pytest.raises(MailError, match="Enter the api key"):
        send({"service": "resend"}, MESSAGE, refused)


def test_every_service_sends_the_typescript_requests_exactly():
    now = fixture()["now"]
    for i, case in enumerate(fixture()["mail"]):
        answer = case["answer"]

        def reply(url, init, answer=answer):
            if answer == "unreachable":
                raise FetchError("fetch failed")
            return Response(answer["body"], answer["status"])

        fetcher = FakeFetcher(reply)
        error = None
        try:
            send(case["config"], case["message"], fetcher, now)
        except MailError as e:
            error = failure(e)
        label = f"case {i}: {_js.dumps(case['config'])}"
        assert fetcher.requests == case["requests"], label
        assert error == case["error"], label


def test_service_messages_match_typescript():
    for case in fixture()["replies"]:
        assert service_message(case["reply"]) == case["message"], case["reply"]


def test_mime_matches_typescript():
    for case in fixture()["mimes"]:
        assert mime(case["message"], case["from"], case["now"], uuids()) == case["mime"]
    raw = mime({**MESSAGE, "subject": "Café report"}, "Runlight <reports@example.com>")
    assert re.search(r"Subject: =\?UTF-8\?B\?", raw)
    assert re.search(r'boundary="rl-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"', raw)


@pytest.fixture
def server():
    started = SmtpServer()
    yield started
    started.stop()


def test_smtp_sends_the_typescript_conversation(server):
    for case in fixture()["smtp"]:
        error = None
        config = {**case["config"], "service": "smtp", "host": "127.0.0.1", "port": str(server.port)}
        try:
            smtp_send(config, case["message"], case["from"], 60_000, fixture()["now"], uuids())
        except MailError as e:
            error = failure(e)
        assert error == case["error"]
        assert (server.conversation() or {}).get("received") == case["received"]


def test_smtp_starttls_refused_is_an_error_and_a_plain_relay_takes_the_message(server):
    config = {"service": "smtp", "host": "127.0.0.1", "port": str(server.port)}
    with pytest.raises(MailError, match="does not offer STARTTLS"):
        smtp_send({**config, "security": "starttls"}, MESSAGE, "reports@example.com")
    server.conversation()
    smtp_send({**config, "security": "none", "username": "jon", "password": "pw"}, {**MESSAGE, "text": ".starts with a dot"}, "Runlight <reports@example.com>")
    received = server.conversation()["received"]
    seen = []
    in_data = False
    data = ""
    for line in received.split("\r\n"):
        if in_data:
            if line == ".":
                in_data = False
            else:
                data += f"{line}\n"
            continue
        if line:
            seen.append(line.split(" ")[0])
        in_data = line == "DATA"
    assert seen == ["EHLO", "AUTH", "MAIL", "RCPT", "DATA", "QUIT"]
    assert re.search("Subject: Hello", data)
    assert re.search("List-Unsubscribe: <https://x/u>", data)
    assert re.search("multipart/alternative", data)


def test_smtp_through_transports_sends_too(server):
    send({"service": "smtp", "host": "127.0.0.1", "port": str(server.port), "security": "none"}, MESSAGE)
    assert "From: Runlight <reports@example.com>\r\n" in server.conversation()["received"]


def test_smtp_reply_just_before_the_server_closes_is_the_error_not_the_close():
    server = SmtpServer("refuse")
    try:
        with pytest.raises(MailError, match=r"\ASMTP greeting: 535 no\Z"):
            smtp_send({"service": "smtp", "host": "127.0.0.1", "port": str(server.port), "security": "none"}, MESSAGE, "reports@example.com")
    finally:
        server.stop()


def test_smtp_character_split_across_two_reads_comes_through_whole():
    ours, theirs = socket.socketpair()
    try:
        session = _Session("127.0.0.1", 25, time.monotonic() + 5, "late")
        session.sock = ours
        data = "250 café ok\r\n".encode()
        split = data.index(0xC3) + 1
        theirs.sendall(data[:split])
        threading.Timer(0.1, lambda: theirs.sendall(data[split:])).start()
        assert session.next(2000) == {"code": 250, "text": "café ok"}
    finally:
        ours.close()
        theirs.close()


def test_smtp_server_that_trickles_is_cut_off_at_the_deadline():
    server = SmtpServer("trickle")
    try:
        started = time.monotonic()
        with pytest.raises(MailError) as caught:
            smtp_send({"service": "smtp", "host": "127.0.0.1", "port": str(server.port), "security": "none"}, MESSAGE, "reports@example.com", 600)
        error = caught.value
        assert error.code == "mail_slow", error.message
        assert error.params == {"host": f"127.0.0.1:{server.port}"}
        assert error.message == f"SMTP: 127.0.0.1:{server.port} took longer than 1 s"
        assert time.monotonic() - started < 2, "the send gives up at its deadline"
        assert (server.conversation(2) or {}).get("closed"), "the connection is closed"
    finally:
        server.stop()


def test_smtp_never_a_link_local_or_metadata_address_and_something_that_is_not_a_mail_server_is_not_quoted(databases):
    from runlight import Runlight
    from runlight.store import Stores

    for host in ["169.254.169.254", "[fd00:ec2::254]"]:
        with pytest.raises(MailError) as caught:
            smtp_send({"service": "smtp", "host": host, "port": "25", "security": "none"}, MESSAGE, "reports@example.com")
        assert caught.value.code == "address_refused", host
    rl = Runlight({"store": Stores.from_db(databases.db("sqlite")), "secret": "s" * 64})
    with pytest.raises(MailError) as caught:
        rl.save_mail_settings({"service": "smtp", "host": "metadata.google.internal", "port": "587", "security": "starttls", "from": "a@example.com"})
    assert caught.value.code == "address_refused"

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)

    def answer() -> None:
        conn, _ = listener.accept()
        conn.sendall(b"HTTP/1.1 400 Bad Request\r\nsecret: internal\r\n\r\n")
        conn.close()

    threading.Thread(target=answer, daemon=True).start()
    try:
        with pytest.raises(MailError) as caught:
            smtp_send({"service": "smtp", "host": "127.0.0.1", "port": str(listener.getsockname()[1]), "security": "none"}, MESSAGE, "reports@example.com")
        assert re.search("did not answer as a mail server does", caught.value.message)
        assert not re.search("internal|HTTP", caught.value.message)
    finally:
        listener.close()


def test_smtp_that_cannot_connect_says_so():
    # A port that was free a moment ago.
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    with pytest.raises(MailError) as caught:
        smtp_send({"service": "smtp", "host": "127.0.0.1", "port": str(port), "security": "none"}, MESSAGE, "reports@example.com")
    error = caught.value
    assert error.code == "mail_unreachable"
    assert error.params["host"] == f"127.0.0.1:{port}"
    assert error.message.startswith(f"SMTP: could not connect to 127.0.0.1:{port}: ")
    assert error.params["detail"] == f"connect ECONNREFUSED 127.0.0.1:{port}", "Node's words"


def test_errors_carry_codes_and_params():
    error = MailError("Something")
    assert error.code == "mail_failed"
    assert error.params == {"detail": "Something"}
    assert SERVICES[0]["id"] == "ses"


def _config_code(config: dict[str, str]) -> str | None:
    from runlight.mail.transports import check_config

    try:
        check_config(config)
    except MailError as error:
        return error.code
    return None


def test_an_smtp_port_out_of_range_is_refused_before_anything_is_saved_or_sent():
    def smtp(port: str) -> dict[str, str]:
        return {"service": "smtp", "host": "smtp.example.com", "port": port, "security": "starttls"}

    for port in ["70000", "65536", "0", "-1", "1.5", "abc", "Infinity", "0x10000"]:
        assert _config_code(smtp(port)) == "mail_port", port
    for port in ["587", " 465 ", "65535", "1", "0o1747", "0b1001001011", "0x24b", "587.0"]:
        assert _config_code(smtp(port)) is None, port


def test_a_webhook_address_that_is_not_a_url_is_refused_before_anything_is_saved_or_sent():
    for url in ["https://", "https://[", "https:// /x"]:
        assert _config_code({"service": "webhook", "url": url}) == "mail_url", url
    assert _config_code({"service": "webhook", "url": "https://hooks.example.com/mail"}) is None
    assert _config_code({"service": "webhook", "url": "http://example.com/x"}) == "mail_https"


def test_the_apps_own_mailer_sends_until_a_service_saved_in_the_dashboard_takes_its_place():
    now = int(datetime(2026, 10, 5, 12, tzinfo=timezone.utc).timestamp() * 1000)
    sent: list[dict] = []
    fail = ""

    def app_send(message: dict) -> None:
        if fail:
            raise RuntimeError(fail)
        sent.append(message)

    calls = capture()
    rl = Runlight({
        "store": Stores.sqlite(":memory:"),
        "site": {"name": "Example", "hostnames": ["example.com"]},
        "now": lambda: now,
        "fetcher": calls,
        "mail": {"from": "site@example.com", "fromName": "Example", "via": "WordPress (WP Mail SMTP)", "send": app_send},
    })  # fmt: skip
    routes = rl.routes(token="t")

    def call(method: str, path: str, body: object = None):
        headers = {"authorization": "Bearer t", "content-type": "application/json"}
        return routes.handle(Request(f"https://stats.example.com/runlight{path}", method, headers, None if body is None else _js.dumps(body)))

    app = _js.loads(call("GET", "/api/mail").text())
    assert {k: app[k] for k in ("source", "service", "from", "fromName", "fields", "saved", "app")} == {
        "source": "app",
        "service": "",
        "from": "site@example.com",
        "fromName": "Example",
        "fields": {},
        "saved": [],
        "app": {"via": "WordPress (WP Mail SMTP)", "from": "site@example.com", "fromName": "Example", "replaced": False},
    }

    assert call("POST", "/api/mail/test", {"to": "jon@example.com"}).status == 200
    assert len(sent) == 1
    assert [sent[0]["to"], sent[0]["from"], sent[0]["fromName"]] == ["jon@example.com", "site@example.com", "Example"]
    assert re.search(r"WordPress \(WP Mail SMTP\)", sent[0]["text"]), "the test names the app's mailer"

    # Reports go through it too, with the unsubscribe headers.
    assert call("POST", "/api/reports", {"email": "jon@example.com", "frequency": "weekly"}).status == 201
    now += 7 * 86_400_000
    assert rl.send_reports() == {"sent": 1, "failed": 0}
    assert re.fullmatch(r"<https://stats\.example\.com/runlight/unsubscribe/[a-f0-9]{32}>", sent[1]["headers"]["List-Unsubscribe"])
    assert sent[1]["headers"]["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"

    # A failure comes back as a mail error naming the mailer.
    fail = "SMTP connect() failed"
    failed = call("POST", "/api/mail/test", {"to": "jon@example.com"})
    assert failed.status == 400
    assert _js.loads(failed.text()) == {
        "error": "WordPress (WP Mail SMTP) could not send it: SMTP connect() failed",
        "code": "mail_app_failed",
        "params": {"via": "WordPress (WP Mail SMTP)", "detail": "SMTP connect() failed"},
    }
    fail = ""

    # A service saved in the dashboard takes its place.
    assert call("PUT", "/api/mail", {"service": "resend", "apiKey": "re_live_key", "from": "reports@example.com"}).status == 200
    replaced = _js.loads(call("GET", "/api/mail").text())
    assert [replaced["source"], replaced["service"], replaced["from"], replaced["app"]] == [
        "dashboard",
        "resend",
        "reports@example.com",
        {"via": "WordPress (WP Mail SMTP)", "from": "site@example.com", "fromName": "Example", "replaced": True},
    ]
    assert call("POST", "/api/mail/test", {"to": "jon@example.com"}).status == 200
    assert len(calls.requests) == 1, "through the saved service"
    assert len(sent) == 2, "and not the app's mailer"

    # Removing it goes back to the app's mailer.
    assert call("DELETE", "/api/mail").status == 200
    assert _js.loads(call("GET", "/api/mail").text())["source"] == "app"
    assert call("POST", "/api/mail/test", {"to": "jon@example.com"}).status == 200
    assert len(sent) == 3


def test_the_apps_mailer_needs_a_from_address_and_without_one_the_answer_has_no_app():
    with pytest.raises(ValueError, match="from address"):
        Runlight({"store": Stores.sqlite(":memory:"), "mail": {"from": "", "via": "Drupal", "send": lambda message: None}})
    rl = Runlight({"store": Stores.sqlite(":memory:")})
    answer = _js.loads(rl.routes(token="t").handle(Request("https://stats.example.com/runlight/api/mail", headers={"authorization": "Bearer t"})).text())
    assert answer["source"] is None
    assert "app" not in answer, "an install without an app mailer answers as before"


def test_mail_services_offers_only_those_named_and_a_saved_one_not_offered_counts_as_none():
    with pytest.raises(ValueError, match='Runlight: mail_services names "carrier-pigeon", which is not a mail service'):
        Runlight({"store": Stores.sqlite(":memory:"), "mailServices": ["resend", "carrier-pigeon"]})
    assert Runlight({"store": Stores.sqlite(":memory:")}).mail_services is SERVICES, "every service by default"
    assert Runlight(store=Stores.sqlite(":memory:"), mail_services=[]).mail_services == [], "an empty list offers none"

    sent: list[dict] = []
    store = Stores.sqlite(":memory:")
    # Kept in the order Settings lists them, whatever the order given.
    rl = Runlight({
        "store": store,
        "secret": "s" * 64,
        "mailServices": ["webhook", "resend"],
        "mail": {"from": "site@example.com", "via": "Craft", "send": sent.append},
        "fetcher": capture(),
    })  # fmt: skip
    assert [s["id"] for s in rl.mail_services] == ["resend", "webhook"]
    routes = rl.routes(token="t")

    def call(method: str, path: str, body: object = None):
        headers = {"authorization": "Bearer t", "content-type": "application/json"}
        return routes.handle(Request(f"https://stats.example.com/runlight{path}", method, headers, None if body is None else _js.dumps(body)))

    assert [s["id"] for s in _js.loads(call("GET", "/api/mail").text())["services"]] == ["resend", "webhook"]
    refused = call("PUT", "/api/mail", {"service": "smtp", "host": "mail.example.com", "port": "587", "from": "reports@example.com"})
    assert refused.status == 400
    assert _js.loads(refused.text()) == {"error": "SMTP is not offered here. Pick another mail service", "code": "mail_service", "params": {"service": "smtp"}}
    unknown = call("PUT", "/api/mail", {"service": "carrier-pigeon", "from": "reports@example.com"})
    assert _js.loads(unknown.text()) == {"error": "Pick a mail service", "code": "mail_service", "params": {}}
    assert call("PUT", "/api/mail", {"service": "resend", "apiKey": "re_live_key", "from": "reports@example.com"}).status == 200
    assert rl.mail_settings()["source"] == "dashboard"

    # The same database with resend no longer offered: the saved service counts as none, and the app's mailer sends.
    later = Runlight({"store": store, "secret": "s" * 64, "mailServices": ["webhook"], "mail": {"from": "site@example.com", "via": "Craft", "send": sent.append}})
    assert later.mail_settings() == {"service": "app", "from": "site@example.com", "via": "Craft", "source": "app"}
    later.send_mail({"to": "jon@example.com", "subject": "Hi", "html": "<p>Hi</p>", "text": "Hi"})
    assert len(sent) == 1

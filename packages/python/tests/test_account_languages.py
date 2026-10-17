"""account-languages.test.ts: the account pages and the OAuth consent page in the browser's language."""

from __future__ import annotations

import re
from typing import Any

from runlight import Runlight, _js
from runlight.accounts import pages
from runlight.http import Request, Response, SearchParams
from runlight.store import Stores

FRENCH = {"accept-language": "fr-FR,fr;q=0.9,en;q=0.8"}


def req(path: str, method: str = "GET", headers: dict[str, str] | None = None, body: str = "") -> Request:
    return Request(f"https://example.com{path}", method, headers or {}, body)


def form(path: str, fields: dict[str, str], headers: dict[str, str] | None = None) -> Request:
    given = {"content-type": "application/x-www-form-urlencoded", **(headers or {})}
    return req(path, "POST", given, SearchParams(fields).to_string())


def cookie_of(response: Response) -> str:
    return (response.headers.get("set-cookie") or "").split(";")[0]


def test_every_account_page_comes_out_in_french_when_asked() -> None:
    cases = [
        ("sign in", pages.login_page("/runlight", {"forgot": "https://runlight.sh/docs"}, "fr"), "Se connecter"),
        ("the code step", pages.code_page("/runlight", {"pending": "p", "next": "/"}, "fr"), "Saisissez votre code"),
        ("an invite", pages.invite_page("/runlight", {"code": "c", "email": "a@example.com", "role": "viewer", "host": "stats.example.com"}, "fr"), "Rejoindre Runlight"),
        ("an invite that is gone", pages.invite_gone_page("/runlight", "fr"), "Cette invitation ne fonctionne plus"),
        ("setup", pages.setup_page("/runlight", {"code": "", "askCode": True}, "fr"), "Créez votre compte"),
        ("setup locked", pages.setup_locked_page("/runlight", False, "fr"), "Terminez la configuration"),
        ("setup needing a token", pages.setup_needs_token_page("/runlight", "fr"), "Terminez la configuration"),
    ]
    for name, html, heading in cases:
        assert '<html lang="fr">' in html, name
        assert f"<h1>{heading}</h1>" in html, name
        assert f"<title>{heading} | Runlight</title>" in html, name
        assert '<script src="/runlight/auth.js?lang=fr"></script>' in html, f"{name} loads the French script"
        assert 'aria-label="Changer de thème"' in html, name
    invite = pages.invite_page("", {"code": "c", "email": "a@example.com", "role": "member", "host": "stats.example.com", "site": "<Blog>"}, "fr")
    assert "Votre rôle : membre, qui peut modifier les réglages de &lt;Blog&gt; uniquement." in invite, "the site name stays escaped"
    login = pages.login_page("", {"forgot": "https://x.example/?a=1&b=2"}, "fr")
    assert '<a href="https://x.example/?a=1&amp;b=2" target="_blank" rel="noopener">la documentation explique' in login
    script = pages.auth_js("fr")
    for words in ['"Afficher le mot de passe"', '"Masquer le mot de passe"', '"Thème : réglage de l’appareil"', '"Thème : sombre"', '["Trop court", "Faible", "Moyen", "Bon", "Fort"]']:
        assert words in script, words
    assert "Show password" not in script


def test_english_pages_and_script_are_unchanged_and_an_unknown_language_is_english() -> None:
    assert pages.auth_js("en") == pages.AUTH_JS
    assert pages.auth_js("xx") == pages.AUTH_JS
    english = pages.login_page("/runlight", {"forgot": "https://runlight.sh/docs"})
    assert english == pages.login_page("/runlight", {"forgot": "https://runlight.sh/docs"}, "en")
    assert pages.login_page("/runlight", {"forgot": "https://runlight.sh/docs"}, "xx") == english
    assert '<html lang="en">' in english
    assert '<script src="/runlight/auth.js"></script>' in english


def test_a_message_with_markup_in_it_stays_escaped_and_only_the_callers_html_goes_in() -> None:
    from runlight.messages import translator

    html = translator("en").html
    assert html("auth.forgot", {"link": "<b>x</b>"}) == "If you have forgotten your password, <b>x</b>."
    page = pages.login_page("", {"forgot": "x", "error": "<script>"}, "en")
    assert "<script>alert" not in page
    assert "&lt;script&gt;" in page
    invite = pages.invite_page("", {"code": "c", "email": "a@example.com", "role": "viewer", "host": "<h&st>", "site": "<S>"}, "en")
    assert "&lt;h&amp;st&gt;" in invite and "&lt;S&gt;" in invite


def test_the_account_routes_answer_in_the_browsers_language_and_in_english_as_before_without_one() -> None:
    rl = Runlight({"store": Stores.sqlite(":memory:"), "secret": "k" * 64})
    handler = rl.routes({"token": "app-token", "accounts": True}).handle

    setup = handler(req("/runlight/setup", headers=FRENCH)).text()
    assert '<html lang="fr">' in setup
    assert "<h1>Créez votre compte</h1>" in setup
    english = handler(req("/runlight/setup", headers={"accept-language": "en-GB,fr;q=0.5"})).text()
    assert english == handler(req("/runlight/setup")).text()
    assert '<html lang="en">' in english
    assert '<script src="/runlight/auth.js"></script>' in english

    wrong_token = handler(form("/runlight/setup", {"code": "guess", "email": "jon@example.com", "password": "a long password", "again": "a long password"}, FRENCH)).text()
    assert "Ce n’est pas le RUNLIGHT_TOKEN de cette application." in wrong_token
    short = handler(form("/runlight/setup", {"code": "app-token", "email": "jon@example.com", "password": "short", "again": "short"}, FRENCH)).text()
    assert "Utilisez un mot de passe d’au moins 10 caractères." in short
    short_english = handler(form("/runlight/setup", {"code": "app-token", "email": "jon@example.com", "password": "short", "again": "short"})).text()
    assert 'role="alert">Use a password of at least 10 characters</p>' in short_english

    owner = cookie_of(handler(form("/runlight/setup", {"code": "app-token", "email": "jon@example.com", "password": "a long password", "again": "a long password"})))
    wrong = handler(form("/runlight/login", {"email": "jon@example.com", "password": "not the password"}, FRENCH))
    assert wrong.status == 401
    assert "Cet e-mail et ce mot de passe ne correspondent à aucun compte." in wrong.text()
    assert "Ce lien de connexion a expiré." in handler(req("/runlight/login/link?ticket=nope", headers=FRENCH)).text()

    made = handler(req("/runlight/api/people", "POST", {"cookie": owner, "content-type": "application/json"}, _js.dumps({"allSites": True, "email": "mo@example.com", "role": "viewer"})))
    link = _js.loads(made.text())["link"]
    path = re.sub(r"^https://example\.com", "", link)
    invite = handler(req(path, headers=FRENCH)).text()
    assert "Votre rôle : lecteur, qui peut lire les statistiques de tous les sites." in invite
    code = re.search(r"code=([^&]+)", link).group(1)  # type: ignore[union-attr]
    mismatch = handler(form("/runlight/invite", {"code": code, "password": "a long password", "again": "another one"}, FRENCH)).text()
    assert "Les deux mots de passe ne sont pas identiques." in mismatch
    assert "<h1>Cette invitation ne fonctionne plus</h1>" in handler(req("/runlight/invite?code=nope", headers=FRENCH)).text()

    # The script comes in the language its page asked for, and in English at its old address.
    assert handler(req("/runlight/auth.js", headers=FRENCH)).text() == pages.AUTH_JS
    assert handler(req("/runlight/auth.js?lang=fr")).text() == pages.auth_js("fr")

    locked = Runlight({"store": Stores.sqlite(":memory:"), "secret": "k" * 64}).routes({"accounts": True}).handle
    page = locked(req("/runlight/setup", headers=FRENCH))
    assert page.status == 403
    assert "<h1>Terminez la configuration</h1>" in page.text()


def test_the_oauth_consent_page_and_its_messages_come_out_in_french_when_asked() -> None:
    rl = Runlight({"store": Stores.sqlite(":memory:"), "sites": [{"id": "a", "name": "Site A", "hostnames": ["a.com"]}, {"id": "b", "name": "Site B", "hostnames": ["b.com"]}]})
    handle: Any = rl.routes({"token": "secret"}).handle
    callback = "https://claude.ai/api/mcp/auth_callback"
    registered = handle(req("/runlight/oauth/register", "POST", {"content-type": "application/json"}, _js.dumps({"client_name": "Claude", "redirect_uris": [callback]})))
    client_id = _js.loads(registered.text())["client_id"]
    params = SearchParams({"response_type": "code", "client_id": client_id, "redirect_uri": callback, "code_challenge": "a" * 43, "code_challenge_method": "S256"}).to_string()
    owner = {"authorization": "Bearer secret"}

    consent = handle(req(f"/runlight/oauth/authorize?{params}", headers={**owner, **FRENCH})).text()
    assert '<html lang="fr">' in consent
    assert "<title>Connecter Claude | Runlight</title>" in consent
    assert "<h1>Connecter Claude</h1>" in consent
    assert "<strong>Claude</strong> veut lire vos statistiques Runlight" in consent
    assert "Autoriser vous renvoie vers <strong>claude.ai</strong>." in consent
    assert '<option value="">Tous les sites</option><option value="a">Site A uniquement</option>' in consent
    assert 'class="ghost">Refuser</button><button type="submit" name="decision" value="allow">Autoriser</button>' in consent
    english = handle(req(f"/runlight/oauth/authorize?{params}", headers=owner)).text()
    assert '<html lang="en">' in english
    assert "<h1>Connect Claude</h1>" in english
    assert "<strong>Claude</strong> wants to read your Runlight stats so it can answer questions about them." in english

    manage = handle(req(f"/runlight/oauth/authorize?{params}&scope=manage", headers={**owner, **FRENCH})).text()
    assert "Son jeton apparaît dans Réglages, MCP &amp; API, où le supprimer déconnecte Claude." in manage
    signed_out = handle(req(f"/runlight/oauth/authorize?{params}", headers=FRENCH))
    assert signed_out.status == 401
    assert "<h1>Connectez-vous d’abord</h1>" in signed_out.text()
    unknown = handle(req(f"/runlight/oauth/authorize?{params}".replace(client_id, "nope"), headers=FRENCH)).text()
    assert "<h1>Cette application n’est pas enregistrée</h1><p>Recommencez la connexion depuis l’application.</p>" in unknown
    forged = handle(req("/runlight/oauth/authorize", "POST", {**owner, **FRENCH, "origin": "https://evil.example", "content-type": "application/x-www-form-urlencoded"}, f"{params}&decision=allow"))
    assert forged.status == 403
    assert "<h1>Cette demande vient d’un autre site</h1>" in forged.text()


def test_the_setup_locked_page_names_the_setup_file_in_every_language() -> None:
    english = pages.setup_locked_page("/runlight", True)
    assert "Open the setup link in the file setup.txt in Runlight&#39;s data folder" not in english
    assert "in the file setup.txt in Runlight's data folder (<code>runlight setup</code> prints it too), which carries a one-time code" in english
    french = pages.setup_locked_page("/runlight", True, "fr")
    assert '<html lang="fr">' in french
    assert "<h1>Terminez la configuration</h1>" in french
    assert "setup.txt" in french and "<code>runlight setup</code>" in french
    assert "Open the setup link" not in french

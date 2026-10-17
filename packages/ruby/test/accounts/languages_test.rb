# frozen_string_literal: true

require "test_helper"
require_relative "../routes/make"

# account-languages.test.ts: the account pages and the OAuth consent page in the visitor's language.
class AccountsLanguagesTest < RoutesTestCase
  Json = Runlight::Json
  Request = Runlight::Http::Request
  Pages = Runlight::Accounts::Pages
  FRENCH = { "accept-language" => "fr-FR,fr;q=0.9,en;q=0.8" }.freeze

  def req(path, method = "GET", headers = {}, body = "")
    Request.new("https://example.com#{path}", method: method, headers: headers, body: body)
  end

  def form(path, fields, headers = {})
    req(path, "POST", { "content-type" => "application/x-www-form-urlencoded" }.merge(headers), Runlight::Http::SearchParams.new(fields).to_s)
  end

  def cookie_of(response)
    (response.headers.get_set_cookie[0] || "").split(";")[0].to_s
  end

  def test_the_language_asked_for_is_the_first_the_dashboard_speaks
    pick = ->(value) { Runlight::Messages.accepted_language(req("/", "GET", value.nil? ? {} : { "accept-language" => value })) }
    assert_equal "fr", pick.call("fr-FR,fr;q=0.9,en;q=0.8")
    assert_equal "de", pick.call("xx,de;q=0.5")
    assert_equal "en", pick.call("en-GB,fr;q=0.5")
    assert_equal "en", pick.call("xx-YY")
    assert_equal "en", pick.call(nil)
  end

  def test_a_message_for_a_page_escapes_its_own_text_and_fills_in_html_the_caller_made_safe
    h = Runlight::Messages.translator("en")["html"]
    assert_equal "Use at least ten characters.", h.call("auth.passwordHint")
    assert_equal "If you have forgotten your password, <a>x</a>.", h.call("auth.forgot", { "link" => "<a>x</a>" })
    assert_equal "You were invited to a&lt;b as &amp;, who. Choose a password to finish.", h.call("auth.joinIntro", { "host" => "a&lt;b", "role" => "&amp;, who" }), "values go in as given"
    assert_equal "{app} sent {error}. Start connecting again from the app.", h.call("oauth.unsupported"), "an unfilled name stays"
  end

  def test_english_account_pages_are_the_same_asked_for_or_not
    assert_equal Pages::AUTH_JS, Pages.auth_js("en")
    assert_equal Pages::AUTH_JS, Pages.auth_js("xx"), "a language Runlight does not speak is English"
    assert_equal Pages.login_page("/runlight", { "forgot" => "https://runlight.sh/docs" }), Pages.login_page("/runlight", { "forgot" => "https://runlight.sh/docs" }, "en")
    assert_equal Pages.login_page("/runlight", { "forgot" => "https://runlight.sh/docs" }), Pages.login_page("/runlight", { "forgot" => "https://runlight.sh/docs" }, "xx")
  end

  def test_every_account_page_comes_out_in_french_when_asked
    [
      ["sign in", Pages.login_page("/runlight", { "forgot" => "https://runlight.sh/docs" }, "fr"), "Se connecter"],
      ["the code step", Pages.code_page("/runlight", { "pending" => "p", "next" => "/" }, "fr"), "Saisissez votre code"],
      ["an invite", Pages.invite_page("/runlight", { "code" => "c", "email" => "a@example.com", "role" => "viewer", "host" => "stats.example.com" }, "fr"), "Rejoindre Runlight"],
      ["an invite that is gone", Pages.invite_gone_page("/runlight", "fr"), "Cette invitation ne fonctionne plus"],
      ["setup", Pages.setup_page("/runlight", { "code" => "", "askCode" => true }, "fr"), "Créez votre compte"],
      ["setup locked", Pages.setup_locked_page("/runlight", nil, "fr"), "Terminez la configuration"],
      ["setup needing a token", Pages.setup_needs_token_page("/runlight", "fr"), "Terminez la configuration"],
    ].each do |name, html, heading|
      assert_match(/<html lang="fr">/, html, name)
      assert_includes html, "<h1>#{heading}</h1>", name
      assert_includes html, "<title>#{heading} | Runlight</title>", name
      assert_includes html, '<script src="/runlight/auth.js?lang=fr"></script>', "#{name} loads the French script"
      assert_includes html, 'aria-label="Changer de thème"', name
    end
    invite = Pages.invite_page("", { "code" => "c", "email" => "a@example.com", "role" => "member", "host" => "stats.example.com", "site" => "<Blog>" }, "fr")
    assert_includes invite, "Votre rôle : membre, qui peut modifier les réglages de &lt;Blog&gt; uniquement.", "the role is French too, and the site name stays escaped"
    assert_includes Pages.login_page("", { "forgot" => "https://x.example/?a=1&b=2" }, "fr"),
                    '<a href="https://x.example/?a=1&amp;b=2" target="_blank" rel="noopener">la documentation explique'
    script = Pages.auth_js("fr")
    ['"Afficher le mot de passe"', '"Masquer le mot de passe"', '"Thème : réglage de l’appareil"', '"Thème : sombre"', '["Trop court", "Faible", "Moyen", "Bon", "Fort"]'].each do |words|
      assert_includes script, words
    end
    refute_includes script, "Show password"
  end

  def test_the_setup_locked_page_names_the_setup_file_in_every_language
    english = Pages.setup_locked_page("/runlight", true)
    assert_includes english, "<p>Runlight has no account yet. Open the setup link in the file setup.txt in Runlight's data folder (<code>runlight setup</code> prints it too), which carries a one-time code, to create the first account.</p>"
    assert_match(/<html lang="en">/, english)
    assert_equal english, Pages.setup_locked_page("/runlight", true, "en")
    french = Pages.setup_locked_page("/runlight", true, "fr")
    assert_match(/<html lang="fr">/, french)
    assert_includes french, "<h1>Terminez la configuration</h1>"
    assert_includes french, "<code>runlight setup</code>"
    refute_includes french, "Open the setup link"
  end

  def test_the_account_routes_answer_in_the_browsers_language_and_in_english_as_before_without_one
    rl = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:"), "secret" => "k" * 64 })
    handler = rl.routes({ "token" => "app-token", "accounts" => true })
    get = ->(path, headers = {}) { handler.handle(req(path, "GET", headers)) }
    post = ->(path, fields, headers = {}) { handler.handle(form(path, fields, headers)) }
    good = { "code" => "app-token", "email" => "jon@example.com", "password" => "a long password", "again" => "a long password" }

    setup = get.call("/runlight/setup", FRENCH).text
    assert_match(/<html lang="fr">/, setup)
    assert_includes setup, "<h1>Créez votre compte</h1>"
    english = get.call("/runlight/setup", { "accept-language" => "en-GB,fr;q=0.5" }).text
    assert_equal get.call("/runlight/setup").text, english, "English asked for is English as it always was"
    assert_match(/<html lang="en">/, english)
    assert_includes english, '<script src="/runlight/auth.js"></script>'

    assert_includes post.call("/runlight/setup", good.merge("code" => "guess"), FRENCH).text, "Ce n’est pas le RUNLIGHT_TOKEN de cette application."
    assert_includes post.call("/runlight/setup", good.merge("password" => "short", "again" => "short"), FRENCH).text, "Utilisez un mot de passe d’au moins 10 caractères."
    assert_includes post.call("/runlight/setup", good.merge("password" => "short", "again" => "short")).text, 'role="alert">Use a password of at least 10 characters</p>'

    owner = cookie_of(post.call("/runlight/setup", good))
    wrong = post.call("/runlight/login", { "email" => "jon@example.com", "password" => "not the password" }, FRENCH)
    assert_equal 401, wrong.status
    assert_includes wrong.text, "Cet e-mail et ce mot de passe ne correspondent à aucun compte."
    assert_includes get.call("/runlight/login/link?ticket=nope", FRENCH).text, "Ce lien de connexion a expiré."

    sent = Json.decode(handler.handle(req("/runlight/api/people", "POST", { "cookie" => owner, "content-type" => "application/json" },
                                          Json.encode({ "allSites" => true, "email" => "mo@example.com", "role" => "viewer" }))).text)
    link = Runlight::Http::Url.new(sent["link"])
    assert_includes get.call("#{link.pathname}#{link.search}", FRENCH).text, "Votre rôle : lecteur, qui peut lire les statistiques de tous les sites."
    mismatch = post.call("/runlight/invite", { "code" => link.search_params.get("code"), "password" => "a long password", "again" => "another one" }, FRENCH)
    assert_includes mismatch.text, "Les deux mots de passe ne sont pas identiques."
    assert_includes get.call("/runlight/invite?code=nope", FRENCH).text, "<h1>Cette invitation ne fonctionne plus</h1>"

    # The script comes in the language its page asked for, and in English at its old address.
    assert_equal Pages::AUTH_JS, get.call("/runlight/auth.js", FRENCH).text
    assert_equal Pages.auth_js("fr"), get.call("/runlight/auth.js?lang=fr").text

    locked = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:"), "secret" => "k" * 64 }).routes({ "accounts" => true })
    page = locked.handle(req("/runlight/setup", "GET", FRENCH))
    assert_equal 403, page.status
    assert_includes page.text, "<h1>Terminez la configuration</h1>"
  end

  def test_the_oauth_consent_page_and_its_messages_come_out_in_french_when_asked
    rl = Runlight::Core.new({ "store" => Runlight::Stores.sqlite(":memory:"),
                              "sites" => [{ "id" => "a", "name" => "Site A", "hostnames" => ["a.com"] }, { "id" => "b", "name" => "Site B", "hostnames" => ["b.com"] }] })
    routes = rl.routes({ "token" => "secret" })
    callback = "https://claude.ai/api/mcp/auth_callback"
    registered = routes.handle(req("/runlight/oauth/register", "POST", { "content-type" => "application/json" }, Json.encode({ "client_name" => "Claude", "redirect_uris" => [callback] })))
    client_id = Json.decode(registered.text)["client_id"]
    params = Runlight::Http::SearchParams.new({ "response_type" => "code", "client_id" => client_id, "redirect_uri" => callback,
                                                "code_challenge" => "a" * 43, "code_challenge_method" => "S256" })
    owner = { "authorization" => "Bearer secret" }
    get = ->(query, headers) { routes.handle(req("/runlight/oauth/authorize?#{query}", "GET", headers)) }

    consent = get.call(params, owner.merge(FRENCH)).text
    assert_match(/<html lang="fr">/, consent)
    assert_includes consent, "<title>Connecter Claude | Runlight</title>"
    assert_includes consent, "<h1>Connecter Claude</h1>"
    assert_includes consent, "<strong>Claude</strong> veut lire vos statistiques Runlight"
    assert_includes consent, "Autoriser vous renvoie vers <strong>claude.ai</strong>."
    assert_includes consent, '<option value="">Tous les sites</option><option value="a">Site A uniquement</option>'
    assert_includes consent, 'class="ghost">Refuser</button><button type="submit" name="decision" value="allow">Autoriser</button>'
    english = get.call(params, owner).text
    assert_match(/<html lang="en">/, english)
    assert_includes english, "<h1>Connect Claude</h1>"
    assert_includes english, "<strong>Claude</strong> wants to read your Runlight stats so it can answer questions about them."

    manage = get.call("#{params}&scope=manage", owner.merge(FRENCH)).text
    assert_includes manage, "Son jeton apparaît dans Réglages, MCP &amp; API, où le supprimer déconnecte Claude."
    signed_out = get.call(params, FRENCH)
    assert_equal 401, signed_out.status
    assert_includes signed_out.text, "<h1>Connectez-vous d’abord</h1>"
    unknown = get.call(params.to_s.sub(client_id, "nope"), FRENCH).text
    assert_includes unknown, "<h1>Cette application n’est pas enregistrée</h1><p>Recommencez la connexion depuis l’application.</p>"
    forged = routes.handle(req("/runlight/oauth/authorize", "POST", owner.merge(FRENCH).merge("origin" => "https://evil.example", "content-type" => "application/x-www-form-urlencoded"),
                               "#{params}&decision=allow"))
    assert_equal 403, forged.status
    assert_includes forged.text, "<h1>Cette demande vient d’un autre site</h1>"
  end
end

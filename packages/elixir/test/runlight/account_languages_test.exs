defmodule Runlight.AccountLanguagesTest do
  @moduledoc "The account and OAuth pages in the browser's language, as packages/sdk/test/account-languages.test.ts checks them."
  use ExUnit.Case, async: true

  alias Runlight.Accounts.Pages
  alias Runlight.Http.Request
  alias Runlight.Messages
  alias Runlight.Test.Stores

  @french [{"accept-language", "fr-FR,fr;q=0.9,en;q=0.8"}]

  defp rl(opts) do
    {store, cleanup} = Stores.store(:sqlite)
    on_exit(cleanup)
    rl = Runlight.new([store: store] ++ opts)
    Runlight.init(rl)
    rl
  end

  defp req(path, opts \\ []), do: Request.new("https://example.com#{path}", opts)

  defp form(fields, headers \\ []),
    do: [
      method: "POST",
      headers: [{"content-type", "application/x-www-form-urlencoded"} | headers],
      body: URI.encode_query(fields)
    ]

  defp cookie_of(response) do
    response.headers
    |> Enum.find_value("", fn {k, v} -> if String.downcase(k) == "set-cookie", do: v end)
    |> String.split(";")
    |> hd()
  end

  test "the first language a browser asks for that the dashboard speaks wins, else English" do
    lang = fn value -> Messages.accepted_language(req("/", headers: [{"accept-language", value}])) end
    assert lang.("fr-FR,fr;q=0.9,en;q=0.8") == "fr"
    assert lang.("xx,de;q=0.5") == "de"
    assert lang.("xx") == "en"
    assert Messages.accepted_language(req("/")) == "en"
  end

  test "a message's own text is escaped and its placeholders take the HTML given" do
    assert Messages.html("en", "oauth.sendsTo", %{"host" => "<strong>a&b</strong>"}) =~ "<strong>a&b</strong>"
    assert Messages.html("en", "auth.forgot", %{"link" => "<a>x</a>"}) =~ "<a>x</a>"
    refute Messages.html("en", "auth.signIn") =~ "<"
  end

  test "English account pages ask for the English script, and an unknown language is English" do
    assert Pages.auth_js("en") == Pages.auth_js()
    assert Pages.auth_js("xx") == Pages.auth_js()
  end

  test "every account page comes out in French when asked" do
    cases = [
      {"sign in", Pages.login_page("/runlight", %{forgot: "https://runlight.sh/docs"}, "fr"), "Se connecter"},
      {"the code step", Pages.code_page("/runlight", %{pending: "p", next: "/"}, "fr"), "Saisissez votre code"},
      {"an invite",
       Pages.invite_page(
         "/runlight",
         %{code: "c", email: "a@example.com", role: "viewer", host: "stats.example.com"},
         "fr"
       ), "Rejoindre Runlight"},
      {"an invite that is gone", Pages.invite_gone_page("/runlight", "fr"), "Cette invitation ne fonctionne plus"},
      {"setup", Pages.setup_page("/runlight", %{code: "", ask_code: true}, "fr"), "Créez votre compte"},
      {"setup locked", Pages.setup_locked_page("/runlight", "fr"), "Terminez la configuration"},
      {"setup needing a token", Pages.setup_needs_token_page("/runlight", "fr"), "Terminez la configuration"}
    ]

    for {name, html, heading} <- cases do
      assert html =~ ~s(<html lang="fr">), name
      assert html =~ "<h1>#{heading}</h1>", name
      assert html =~ "<title>#{heading} | Runlight</title>", name
      assert html =~ ~s(<script src="/runlight/auth.js?lang=fr"></script>), name
      assert html =~ ~s(aria-label="Changer de thème"), name
    end

    invite =
      Pages.invite_page(
        "",
        %{code: "c", email: "a@example.com", role: "member", host: "stats.example.com", site: "<Blog>"},
        "fr"
      )

    assert invite =~ "Votre rôle : membre, qui peut modifier les réglages de &lt;Blog&gt; uniquement."

    assert Pages.login_page("", %{forgot: "https://x.example/?a=1&b=2"}, "fr") =~
             ~s(<a href="https://x.example/?a=1&amp;b=2" target="_blank" rel="noopener">la documentation explique)

    script = Pages.auth_js("fr")

    for words <- [
          ~s("Afficher le mot de passe"),
          ~s("Masquer le mot de passe"),
          ~s("Thème : réglage de l’appareil"),
          ~s("Thème : sombre"),
          ~s(["Trop court", "Faible", "Moyen", "Bon", "Fort"])
        ] do
      assert script =~ words, words
    end

    refute script =~ "Show password"
  end

  defp call(routes, request), do: Runlight.Routes.handle(routes, request)

  test "the account routes answer in the browser's language, and in English as before without one" do
    rl = rl(secret: String.duplicate("k", 64), site: [hostnames: ["example.com"]])
    routes = Runlight.routes(rl, token: "app-token", accounts: true)

    setup = call(routes, req("/runlight/setup", headers: @french)).body
    assert setup =~ ~s(<html lang="fr">)
    assert setup =~ "<h1>Créez votre compte</h1>"

    english = call(routes, req("/runlight/setup", headers: [{"accept-language", "en-GB,fr;q=0.5"}])).body
    assert english == call(routes, req("/runlight/setup")).body
    assert english =~ ~s(<html lang="en">)
    assert english =~ ~s(<script src="/runlight/auth.js"></script>)

    account = %{email: "jon@example.com", password: "a long password", again: "a long password"}

    wrong_token =
      call(routes, req("/runlight/setup", form(Map.put(account, :code, "guess"), @french))).body

    assert wrong_token =~ "Ce n’est pas le RUNLIGHT_TOKEN de cette application."

    short =
      call(
        routes,
        req(
          "/runlight/setup",
          form(%{code: "app-token", email: "jon@example.com", password: "short", again: "short"}, @french)
        )
      ).body

    assert short =~ "Utilisez un mot de passe d’au moins 10 caractères."

    short_english =
      call(
        routes,
        req("/runlight/setup", form(%{code: "app-token", email: "jon@example.com", password: "short", again: "short"}))
      ).body

    assert short_english =~ ~s(role="alert">Use a password of at least 10 characters</p>)

    owner = cookie_of(call(routes, req("/runlight/setup", form(Map.put(account, :code, "app-token")))))

    wrong =
      call(
        routes,
        req("/runlight/login", form(%{email: "jon@example.com", password: "not the password"}, @french))
      )

    assert wrong.status == 401
    assert wrong.body =~ "Cet e-mail et ce mot de passe ne correspondent à aucun compte."

    assert call(routes, req("/runlight/login/link?ticket=nope", headers: @french)).body =~
             "Ce lien de connexion a expiré."

    sent =
      call(
        routes,
        req("/runlight/api/people",
          method: "POST",
          headers: [{"cookie", owner}, {"content-type", "application/json"}],
          body: Jason.encode!(%{allSites: true, email: "mo@example.com", role: "viewer"})
        )
      )

    link = URI.parse(Jason.decode!(sent.body)["link"])
    code = URI.decode_query(link.query)["code"]
    invite = call(routes, req("#{link.path}?#{link.query}", headers: @french)).body
    assert invite =~ "Votre rôle : lecteur, qui peut lire les statistiques de tous les sites."

    mismatch =
      call(
        routes,
        req("/runlight/invite", form(%{code: code, password: "a long password", again: "another one"}, @french))
      ).body

    assert mismatch =~ "Les deux mots de passe ne sont pas identiques."

    assert call(routes, req("/runlight/invite?code=nope", headers: @french)).body =~
             "<h1>Cette invitation ne fonctionne plus</h1>"

    assert call(routes, req("/runlight/auth.js", headers: @french)).body == Pages.auth_js()
    assert call(routes, req("/runlight/auth.js?lang=fr")).body == Pages.auth_js("fr")

    locked = Runlight.routes(rl(secret: String.duplicate("k", 64), site: [hostnames: ["example.com"]]), accounts: true)
    page = call(locked, req("/runlight/setup", headers: @french))
    assert page.status == 403
    assert page.body =~ "<h1>Terminez la configuration</h1>"
  end

  test "the OAuth consent page and its messages come out in French when asked" do
    rl = rl(sites: [[id: "a", name: "Site A", hostnames: ["a.com"]], [id: "b", name: "Site B", hostnames: ["b.com"]]])
    routes = Runlight.routes(rl, token: "secret")
    callback = "https://claude.ai/api/mcp/auth_callback"

    registered =
      call(
        routes,
        req("/runlight/oauth/register",
          method: "POST",
          headers: [{"content-type", "application/json"}],
          body: Jason.encode!(%{client_name: "Claude", redirect_uris: [callback]})
        )
      )

    client_id = Jason.decode!(registered.body)["client_id"]

    params =
      URI.encode_query(%{
        response_type: "code",
        client_id: client_id,
        redirect_uri: callback,
        code_challenge: String.duplicate("a", 43),
        code_challenge_method: "S256"
      })

    owner = [{"authorization", "Bearer secret"}]
    get = fn query, headers -> call(routes, req("/runlight/oauth/authorize?#{query}", headers: headers)) end

    consent = get.(params, owner ++ @french).body
    assert consent =~ ~s(<html lang="fr">)
    assert consent =~ "<title>Connecter Claude | Runlight</title>"
    assert consent =~ "<h1>Connecter Claude</h1>"
    assert consent =~ "<strong>Claude</strong> veut lire vos statistiques Runlight"
    assert consent =~ "Autoriser vous renvoie vers <strong>claude.ai</strong>."
    assert consent =~ ~s(<option value="">Tous les sites</option><option value="a">Site A uniquement</option>)

    assert consent =~
             ~s(class="ghost">Refuser</button><button type="submit" name="decision" value="allow">Autoriser</button>)

    english = get.(params, owner).body
    assert english =~ ~s(<html lang="en">)
    assert english =~ "<h1>Connect Claude</h1>"

    assert english =~
             "<strong>Claude</strong> wants to read your Runlight stats so it can answer questions about them."

    manage = get.(params <> "&scope=manage", owner ++ @french).body
    assert manage =~ "Son jeton apparaît dans Réglages, MCP &amp; API, où le supprimer déconnecte Claude."

    signed_out = get.(params, @french)
    assert signed_out.status == 401
    assert signed_out.body =~ "<h1>Connectez-vous d’abord</h1>"

    unknown = get.(String.replace(params, client_id, "nope"), @french).body

    assert unknown =~
             "<h1>Cette application n’est pas enregistrée</h1><p>Recommencez la connexion depuis l’application.</p>"

    forged =
      call(
        routes,
        req("/runlight/oauth/authorize",
          method: "POST",
          headers:
            owner ++
              @french ++ [{"origin", "https://evil.example"}, {"content-type", "application/x-www-form-urlencoded"}],
          body: "#{params}&decision=allow"
        )
      )

    assert forged.status == 403
    assert forged.body =~ "<h1>Cette demande vient d’un autre site</h1>"
  end
end

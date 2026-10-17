using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Runlight.Accounts;
using Runlight.Http;
using Xunit;
using static Runlight.Tests.Routes.Make;

namespace Runlight.Tests.Routes;

/// <summary>account-languages.test.ts: the account and OAuth pages in the browser's language, and in English as before without one.</summary>
public sealed class AccountLanguagesTests : RoutesTestCase
{
    private static readonly Headers French = H(("accept-language", "fr-FR,fr;q=0.9,en;q=0.8"));

    private static Request Get(string path, Headers? headers = null) => new("https://example.com" + path, "GET", headers, "");

    private static Request Form(string path, IEnumerable<(string Name, string Value)> fields, Headers? headers = null)
    {
        var parameters = new SearchParams();
        foreach (var (name, value) in fields)
        {
            parameters.Append(name, value);
        }
        var all = headers == null ? new Headers() : new Headers(headers);
        all.Set("content-type", "application/x-www-form-urlencoded");
        return new Request("https://example.com" + path, "POST", all, parameters.ToString());
    }

    private static string CookieOf(Response response) => (response.Headers.Get("set-cookie") ?? "").Split(';')[0];

    [Fact]
    public void English_is_what_a_language_Runlight_does_not_speak_gets()
    {
        Assert.Equal(Pages.AuthJs(), Pages.AuthJs("xx"));
        Assert.Equal(Pages.LoginPage("/runlight", "https://runlight.sh/docs"), Pages.LoginPage("/runlight", "https://runlight.sh/docs", lang: "xx"));
        Assert.Contains("<html lang=\"en\">", Pages.LoginPage("/runlight", "https://runlight.sh/docs", lang: "xx"), StringComparison.Ordinal);
    }

    [Fact]
    public void Every_account_page_comes_out_in_French_when_asked()
    {
        var cases = new (string Name, string Html, string Heading)[]
        {
            ("sign in", Pages.LoginPage("/runlight", "https://runlight.sh/docs", lang: "fr"), "Se connecter"),
            ("the code step", Pages.CodePage("/runlight", "p", "/", lang: "fr"), "Saisissez votre code"),
            ("an invite", Pages.InvitePage("/runlight", "c", "a@example.com", "viewer", "stats.example.com", lang: "fr"), "Rejoindre Runlight"),
            ("an invite that is gone", Pages.InviteGonePage("/runlight", "fr"), "Cette invitation ne fonctionne plus"),
            ("setup", Pages.SetupPage("/runlight", "", askCode: true, lang: "fr"), "Créez votre compte"),
            ("setup locked", Pages.SetupLockedPage("/runlight", lang: "fr"), "Terminez la configuration"),
            ("setup needing a token", Pages.SetupNeedsTokenPage("/runlight", "fr"), "Terminez la configuration"),
        };
        foreach (var (name, html, heading) in cases)
        {
            Assert.Contains("<html lang=\"fr\">", html, StringComparison.Ordinal);
            Assert.Contains("<h1>" + heading + "</h1>", html, StringComparison.Ordinal);
            Assert.Contains("<title>" + heading + " | Runlight</title>", html, StringComparison.Ordinal);
            Assert.Contains("<script src=\"/runlight/auth.js?lang=fr\"></script>", html, StringComparison.Ordinal);
            Assert.Contains("aria-label=\"Changer de thème\"", html, StringComparison.Ordinal);
            Assert.True(name.Length > 0);
        }
        string invite = Pages.InvitePage("", "c", "a@example.com", "member", "stats.example.com", site: "<Blog>", lang: "fr");
        // The role is French too, and the site name stays escaped.
        Assert.Contains("Votre rôle : membre, qui peut modifier les réglages de &lt;Blog&gt; uniquement.", invite, StringComparison.Ordinal);
        Assert.Contains("<a href=\"https://x.example/?a=1&amp;b=2\" target=\"_blank\" rel=\"noopener\">la documentation explique", Pages.LoginPage("", "https://x.example/?a=1&b=2", lang: "fr"), StringComparison.Ordinal);
        // The script's words: show and hide, the theme, and the strength meter.
        string script = Pages.AuthJs("fr");
        foreach (string words in new[] { "\"Afficher le mot de passe\"", "\"Masquer le mot de passe\"", "\"Thème : réglage de l’appareil\"", "\"Thème : sombre\"", "[\"Trop court\", \"Faible\", \"Moyen\", \"Bon\", \"Fort\"]" })
        {
            Assert.Contains(words, script, StringComparison.Ordinal);
        }
        Assert.DoesNotContain("Show password", script, StringComparison.Ordinal);
    }

    [Fact]
    public void The_setup_file_sentence_is_in_the_visitors_language_and_English_is_unchanged()
    {
        string english = Pages.SetupLockedPage("/runlight", true);
        Assert.Contains("<p>Runlight has no account yet. Open the setup link in the file setup.txt in Runlight's data folder (<code>runlight setup</code> prints it too), which carries a one-time code, to create the first account.</p>", english, StringComparison.Ordinal);
        string french = Pages.SetupLockedPage("/runlight", true, "fr");
        Assert.Contains("<html lang=\"fr\">", french, StringComparison.Ordinal);
        Assert.Contains("setup.txt", french, StringComparison.Ordinal);
        Assert.Contains("<code>runlight setup</code>", french, StringComparison.Ordinal);
        Assert.DoesNotContain("Runlight has no account yet", french, StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_account_routes_answer_in_the_browsers_language_and_in_English_as_before_without_one()
    {
        var rl = new Runlight(new RunlightOptions { Store = await Databases.FreshAsync("sqlite"), Secret = new string('k', 64) });
        var routes = rl.Routes(new RoutesOptions { Token = "app-token", Accounts = true });
        Task<Response> Handler(Request r) => routes.HandleAsync(r);
        async Task<string> TextAsync(Request r) => (await Handler(r)).Text();

        string setup = await TextAsync(Get("/runlight/setup", French));
        Assert.Contains("<html lang=\"fr\">", setup, StringComparison.Ordinal);
        Assert.Contains("<h1>Créez votre compte</h1>", setup, StringComparison.Ordinal);
        string english = await TextAsync(Get("/runlight/setup", H(("accept-language", "en-GB,fr;q=0.5"))));
        Assert.Equal(await TextAsync(Get("/runlight/setup")), english); // English asked for is English as it always was
        Assert.Contains("<html lang=\"en\">", english, StringComparison.Ordinal);
        Assert.Contains("<script src=\"/runlight/auth.js\"></script>", english, StringComparison.Ordinal);

        (string, string)[] Fields(string code, string password, string again) => [("code", code), ("email", "jon@example.com"), ("password", password), ("again", again)];
        Assert.Contains("Ce n’est pas le RUNLIGHT_TOKEN de cette application.", await TextAsync(Form("/runlight/setup", Fields("guess", "a long password", "a long password"), French)), StringComparison.Ordinal);
        // An account's own problem is worded as the dashboard words it.
        Assert.Contains("Utilisez un mot de passe d’au moins 10 caractères.", await TextAsync(Form("/runlight/setup", Fields("app-token", "short", "short"), French)), StringComparison.Ordinal);
        Assert.Contains("role=\"alert\">Use a password of at least 10 characters</p>", await TextAsync(Form("/runlight/setup", Fields("app-token", "short", "short"))), StringComparison.Ordinal);

        string owner = CookieOf(await Handler(Form("/runlight/setup", Fields("app-token", "a long password", "a long password"))));
        var wrong = await Handler(Form("/runlight/login", [("email", "jon@example.com"), ("password", "not the password")], French));
        Assert.Equal(401, wrong.Status);
        Assert.Contains("Cet e-mail et ce mot de passe ne correspondent à aucun compte.", wrong.Text(), StringComparison.Ordinal);
        Assert.Contains("Ce lien de connexion a expiré.", await TextAsync(Get("/runlight/login/link?ticket=nope", French)), StringComparison.Ordinal);

        var invited = await Handler(new Request("https://example.com/runlight/api/people", "POST", H(("cookie", owner), ("content-type", "application/json")), Json.Stringify(new JsObject { ["allSites"] = true, ["email"] = "mo@example.com", ["role"] = "viewer" })));
        var link = new Url(((JsObject)Json.Parse(invited.Text())!).Str("link")!);
        Assert.Contains("Votre rôle : lecteur, qui peut lire les statistiques de tous les sites.", await TextAsync(Get(link.Pathname + link.Search, French)), StringComparison.Ordinal);
        string code = link.SearchParams.Get("code")!;
        Assert.Contains("Les deux mots de passe ne sont pas identiques.", await TextAsync(Form("/runlight/invite", [("code", code), ("password", "a long password"), ("again", "another one")], French)), StringComparison.Ordinal);
        Assert.Contains("<h1>Cette invitation ne fonctionne plus</h1>", await TextAsync(Get("/runlight/invite?code=nope", French)), StringComparison.Ordinal);

        // The script comes in the language its page asked for, and in English at its old address.
        Assert.Equal(Pages.AuthJs(), await TextAsync(Get("/runlight/auth.js", French)));
        Assert.Equal(Pages.AuthJs("fr"), await TextAsync(Get("/runlight/auth.js?lang=fr")));

        var locked = new Runlight(new RunlightOptions { Store = await Databases.FreshAsync("sqlite"), Secret = new string('k', 64) }).Routes(new RoutesOptions { Accounts = true });
        Environment.SetEnvironmentVariable("NODE_ENV", "production");
        var page = await locked.HandleAsync(Get("/runlight/setup", French));
        Assert.Equal(403, page.Status);
        Assert.Contains("<h1>Terminez la configuration</h1>", page.Text(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task The_OAuth_consent_page_and_its_messages_come_out_in_French_when_asked()
    {
        var rl = await RunlightAsync(sites: [Site("a", "Site A", ["a.com"]), Site("b", "Site B", ["b.com"])]);
        var routes = rl.Routes(new RoutesOptions { Token = "secret" });
        const string callback = "https://claude.ai/api/mcp/auth_callback";
        var registered = await routes.HandleAsync(Req("/runlight/oauth/register", "POST", H(("content-type", "application/json")), Json.Stringify(new JsObject { ["client_name"] = "Claude", ["redirect_uris"] = new List<object?> { callback } })));
        string clientId = ((JsObject)Json.Parse(registered.Text())!).Str("client_id")!;
        var parameters = new SearchParams
        {
            { "response_type", "code" },
            { "client_id", clientId },
            { "redirect_uri", callback },
            { "code_challenge", new string('a', 43) },
            { "code_challenge_method", "S256" },
        };
        Headers Owner(Headers? more = null)
        {
            var h = new Headers(more ?? new Headers());
            h.Set("authorization", "Bearer secret");
            return h;
        }
        async Task<string> PageAsync(string query, Headers? headers) => (await routes.HandleAsync(Req("/runlight/oauth/authorize?" + query, "GET", headers))).Text();
        string q = parameters.ToString();

        string consent = await PageAsync(q, Owner(French));
        Assert.Contains("<html lang=\"fr\">", consent, StringComparison.Ordinal);
        Assert.Contains("<title>Connecter Claude | Runlight</title>", consent, StringComparison.Ordinal);
        Assert.Contains("<h1>Connecter Claude</h1>", consent, StringComparison.Ordinal);
        Assert.Contains("<strong>Claude</strong> veut lire vos statistiques Runlight", consent, StringComparison.Ordinal);
        Assert.Contains("Autoriser vous renvoie vers <strong>claude.ai</strong>.", consent, StringComparison.Ordinal);
        Assert.Contains("<option value=\"\">Tous les sites</option><option value=\"a\">Site A uniquement</option>", consent, StringComparison.Ordinal);
        Assert.Contains("class=\"ghost\">Refuser</button><button type=\"submit\" name=\"decision\" value=\"allow\">Autoriser</button>", consent, StringComparison.Ordinal);
        string english = await PageAsync(q, Owner());
        Assert.Contains("<html lang=\"en\">", english, StringComparison.Ordinal);
        Assert.Contains("<h1>Connect Claude</h1>", english, StringComparison.Ordinal);
        Assert.Contains("<strong>Claude</strong> wants to read your Runlight stats so it can answer questions about them.", english, StringComparison.Ordinal);

        Assert.Contains("Son jeton apparaît dans Réglages, MCP &amp; API, où le supprimer déconnecte Claude.", await PageAsync(q + "&scope=manage", Owner(French)), StringComparison.Ordinal);
        var signedOut = await routes.HandleAsync(Req("/runlight/oauth/authorize?" + q, "GET", French));
        Assert.Equal(401, signedOut.Status);
        Assert.Contains("<h1>Connectez-vous d’abord</h1>", signedOut.Text(), StringComparison.Ordinal);
        Assert.Contains("<h1>Cette application n’est pas enregistrée</h1><p>Recommencez la connexion depuis l’application.</p>", await PageAsync(q.Replace(clientId, "nope", StringComparison.Ordinal), Owner(French)), StringComparison.Ordinal);
        var evil = Owner(French);
        evil.Set("origin", "https://evil.example");
        evil.Set("content-type", "application/x-www-form-urlencoded");
        var forged = await routes.HandleAsync(Req("/runlight/oauth/authorize", "POST", evil, q + "&decision=allow"));
        Assert.Equal(403, forged.Status);
        Assert.Contains("<h1>Cette demande vient d’un autre site</h1>", forged.Text(), StringComparison.Ordinal);
    }
}

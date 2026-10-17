package dbtest

import (
	"context"
	"net/url"
	"regexp"
	"strings"
	"testing"

	runlight "runlight.sh/go"
	"runlight.sh/go/internal/accounts"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/web"
)

const french = "fr-FR,fr;q=0.9,en;q=0.8"

func TestTheAccountRoutesAnswerInTheBrowsersLanguageAndInEnglishAsBeforeWithoutOne(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			rl, err := runlight.New(runlight.Options{Store: Store(t, kind), Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}}, Logf: func(string, ...any) {}, Secret: ptr(strings.Repeat("k", 64))})
			if err != nil {
				t.Fatal(err)
			}
			token := "app-token"
			routes, err := rl.Routes(runlight.RoutesOptions{Token: &token, Accounts: true})
			if err != nil {
				t.Fatal(err)
			}
			call := func(method, path, body string, headers ...string) *runlight.Response {
				t.Helper()
				var b []byte
				if body != "" {
					b = []byte(body)
				}
				return routes.Handle(ctx, web.NewRequest(method, "https://example.com"+path, web.NewHeaders(headers...), b))
			}
			asForm := func(fields ...string) string { return form(fields...) }
			post := func(path, body string, headers ...string) *runlight.Response {
				return call("POST", path, body, append([]string{"content-type", formType}, headers...)...)
			}
			frenchHeader := []string{"accept-language", french}

			setup := call("GET", "/runlight/setup", "", frenchHeader...).Text()
			for _, want := range []string{`<html lang="fr">`, `<h1>Créez votre compte</h1>`} {
				if !strings.Contains(setup, want) {
					t.Errorf("French setup lacks %s", want)
				}
			}
			english := call("GET", "/runlight/setup", "", "accept-language", "en-GB,fr;q=0.5").Text()
			if plain := call("GET", "/runlight/setup", "").Text(); english != plain {
				t.Error("English asked for is English as it always was")
			}
			if !strings.Contains(english, `<html lang="en">`) || !strings.Contains(english, `<script src="/runlight/auth.js"></script>`) {
				t.Errorf("English setup: %s", english)
			}
			if got := call("GET", "/runlight/setup", "", "accept-language", "xx-XX").Text(); got != english {
				t.Error("an unknown language gives English")
			}

			fields := func(code, password, again string) string {
				return asForm("code", code, "email", "jon@example.com", "password", password, "again", again)
			}
			if got := post("/runlight/setup", fields("guess", "a long password", "a long password"), frenchHeader...).Text(); !strings.Contains(got, "Ce n’est pas le RUNLIGHT_TOKEN de cette application.") {
				t.Errorf("a wrong token: %s", got)
			}
			if got := post("/runlight/setup", fields("app-token", "short", "short"), frenchHeader...).Text(); !strings.Contains(got, "Utilisez un mot de passe d’au moins 10 caractères.") {
				t.Errorf("an account's own problem is worded as the dashboard words it: %s", got)
			}
			if got := post("/runlight/setup", fields("app-token", "short", "short")).Text(); !strings.Contains(got, `role="alert">Use a password of at least 10 characters</p>`) {
				t.Errorf("in English: %s", got)
			}

			made := post("/runlight/setup", fields("app-token", "a long password", "a long password"))
			owner := cookieOf(made)
			wrong := post("/runlight/login", asForm("email", "jon@example.com", "password", "not the password"), frenchHeader...)
			if wrong.Status != 401 || !strings.Contains(wrong.Text(), "Cet e-mail et ce mot de passe ne correspondent à aucun compte.") {
				t.Errorf("a wrong password: %d %s", wrong.Status, wrong.Text())
			}
			if got := call("GET", "/runlight/login/link?ticket=nope", "", frenchHeader...).Text(); !strings.Contains(got, "Ce lien de connexion a expiré.") {
				t.Errorf("an old sign-in link: %s", got)
			}

			sent := call("POST", "/runlight/api/people", `{"allSites":true,"email":"mo@example.com","role":"viewer"}`, "cookie", owner, "content-type", "application/json")
			v, _ := js.Parse(sent.Text())
			link, err := url.Parse(js.Str(js.Dig(v, "link")))
			if err != nil {
				t.Fatal(err)
			}
			if got := call("GET", link.Path+"?"+link.RawQuery, "", frenchHeader...).Text(); !strings.Contains(got, "Votre rôle : lecteur, qui peut lire les statistiques de tous les sites.") {
				t.Errorf("an invitation: %s", got)
			}
			mismatch := post("/runlight/invite", asForm("code", link.Query().Get("code"), "password", "a long password", "again", "another one"), frenchHeader...).Text()
			if !strings.Contains(mismatch, "Les deux mots de passe ne sont pas identiques.") {
				t.Errorf("mismatched passwords: %s", mismatch)
			}
			if got := call("GET", "/runlight/invite?code=nope", "", frenchHeader...).Text(); !strings.Contains(got, "<h1>Cette invitation ne fonctionne plus</h1>") {
				t.Errorf("a gone invitation: %s", got)
			}

			// The script comes in the language its page asked for, and in English at its old address.
			if got := call("GET", "/runlight/auth.js", "", frenchHeader...).Text(); got != accounts.AuthJS {
				t.Error("auth.js is English at its old address")
			}
			if got := call("GET", "/runlight/auth.js?lang=fr", "").Text(); got != accounts.AuthJSFor("fr") {
				t.Error("auth.js?lang=fr is French")
			}

			// A server with no account yet, and a locked setup, answers in French too.
			lockedRL, err := runlight.New(runlight.Options{Store: Store(t, Kinds()[0]), Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}}, Logf: func(string, ...any) {}, Secret: ptr(strings.Repeat("k", 64))})
			if err != nil {
				t.Fatal(err)
			}
			locked, err := lockedRL.Routes(runlight.RoutesOptions{Accounts: true})
			if err != nil {
				t.Fatal(err)
			}
			page := locked.Handle(ctx, web.NewRequest("GET", "https://example.com/runlight/setup", web.NewHeaders(frenchHeader...), nil))
			if page.Status != 403 || !strings.Contains(page.Text(), "<h1>Terminez la configuration</h1>") {
				t.Errorf("setup locked: %d %s", page.Status, page.Text())
			}
		})
	}
}

func TestTheOAuthConsentPageAndItsMessagesComeOutInFrenchWhenAsked(t *testing.T) {
	ctx := context.Background()
	rl, err := runlight.New(runlight.Options{Store: Store(t, Kinds()[0]), Logf: func(string, ...any) {}, Sites: []runlight.SiteOptions{
		{ID: "a", Name: "Site A", Hostnames: []string{"a.com"}}, {ID: "b", Name: "Site B", Hostnames: []string{"b.com"}}}})
	if err != nil {
		t.Fatal(err)
	}
	token := "secret"
	routes, err := rl.Routes(runlight.RoutesOptions{Token: &token})
	if err != nil {
		t.Fatal(err)
	}
	callback := "https://claude.ai/api/mcp/auth_callback"
	call := func(method, path, body string, headers ...string) *runlight.Response {
		var b []byte
		if body != "" {
			b = []byte(body)
		}
		return routes.Handle(ctx, web.NewRequest(method, "https://example.com"+path, web.NewHeaders(headers...), b))
	}
	registered := call("POST", "/runlight/oauth/register", `{"client_name":"Claude","redirect_uris":["`+callback+`"]}`, "content-type", "application/json")
	v, _ := js.Parse(registered.Text())
	clientID := js.Str(js.Dig(v, "client_id"))
	params := url.Values{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {callback}, "code_challenge": {strings.Repeat("a", 43)}, "code_challenge_method": {"S256"}}.Encode()
	owner := []string{"authorization", "Bearer secret"}
	fr := append([]string{"accept-language", french}, owner...)

	consent := call("GET", "/runlight/oauth/authorize?"+params, "", fr...).Text()
	for _, want := range []string{
		`<html lang="fr">`,
		`<title>Connecter Claude | Runlight</title>`,
		`<h1>Connecter Claude</h1>`,
		`<strong>Claude</strong> veut lire vos statistiques Runlight`,
		`Autoriser vous renvoie vers <strong>claude.ai</strong>.`,
		`<option value="">Tous les sites</option><option value="a">Site A uniquement</option>`,
		`class="ghost">Refuser</button><button type="submit" name="decision" value="allow">Autoriser</button>`,
	} {
		if !strings.Contains(consent, want) {
			t.Errorf("the French consent page lacks %s", want)
		}
	}
	english := call("GET", "/runlight/oauth/authorize?"+params, "", owner...).Text()
	for _, want := range []string{`<html lang="en">`, `<h1>Connect Claude</h1>`, `<strong>Claude</strong> wants to read your Runlight stats so it can answer questions about them.`} {
		if !strings.Contains(english, want) {
			t.Errorf("the English consent page lacks %s", want)
		}
	}
	if manage := call("GET", "/runlight/oauth/authorize?"+params+"&scope=manage", "", fr...).Text(); !strings.Contains(manage, "Son jeton apparaît dans Réglages, MCP &amp; API, où le supprimer déconnecte Claude.") {
		t.Errorf("the manage page: %s", manage)
	}
	signedOut := call("GET", "/runlight/oauth/authorize?"+params, "", "accept-language", french)
	if signedOut.Status != 401 || !strings.Contains(signedOut.Text(), "<h1>Connectez-vous d’abord</h1>") {
		t.Errorf("signed out: %d %s", signedOut.Status, signedOut.Text())
	}
	unknown := call("GET", "/runlight/oauth/authorize?"+strings.Replace(params, clientID, "nope", 1), "", fr...).Text()
	if !strings.Contains(unknown, "<h1>Cette application n’est pas enregistrée</h1><p>Recommencez la connexion depuis l’application.</p>") {
		t.Errorf("an unknown app: %s", unknown)
	}
	forged := call("POST", "/runlight/oauth/authorize", params+"&decision=allow", append([]string{"origin", "https://evil.example", "content-type", formType}, fr...)...)
	if forged.Status != 403 || !strings.Contains(forged.Text(), "<h1>Cette demande vient d’un autre site</h1>") {
		t.Errorf("forged: %d %s", forged.Status, forged.Text())
	}
}

// A name with markup in it stays escaped, whatever the language.
func TestAnAppNameWithMarkupStaysEscapedOnTheConsentPage(t *testing.T) {
	ctx := context.Background()
	rl, err := runlight.New(runlight.Options{Store: Store(t, Kinds()[0]), Logf: func(string, ...any) {}, Site: &runlight.SiteOptions{Hostnames: []string{"a.com"}}})
	if err != nil {
		t.Fatal(err)
	}
	token := "secret"
	routes, err := rl.Routes(runlight.RoutesOptions{Token: &token})
	if err != nil {
		t.Fatal(err)
	}
	callback := "https://claude.ai/api/mcp/auth_callback"
	registered := routes.Handle(ctx, web.NewRequest("POST", "https://example.com/runlight/oauth/register", web.NewHeaders("content-type", "application/json"), []byte(`{"client_name":"<b>Bold</b> & Co","redirect_uris":["`+callback+`"]}`)))
	v, _ := js.Parse(registered.Text())
	params := url.Values{"response_type": {"code"}, "client_id": {js.Str(js.Dig(v, "client_id"))}, "redirect_uri": {callback}, "code_challenge": {strings.Repeat("a", 43)}, "code_challenge_method": {"S256"}}.Encode()
	for _, lang := range []string{"fr", "en"} {
		page := routes.Handle(ctx, web.NewRequest("GET", "https://example.com/runlight/oauth/authorize?"+params, web.NewHeaders("authorization", "Bearer secret", "accept-language", lang), nil)).Text()
		if strings.Contains(page, "<b>Bold</b>") || !regexp.MustCompile(`&lt;b&gt;Bold&lt;/b&gt; &amp; Co`).MatchString(page) {
			t.Errorf("%s: the name is not escaped: %s", lang, page)
		}
	}
}

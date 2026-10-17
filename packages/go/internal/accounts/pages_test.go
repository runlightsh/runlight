package accounts

import (
	"strings"
	"testing"

	"runlight.sh/go/internal/fixture"
	"runlight.sh/go/internal/js"
)

// The account pages against tests/fixtures/pages.json, the TypeScript's HTML for the same inputs.

func TestStylesAndScriptMatch(t *testing.T) {
	f := fixture.PHP(t, "pages.json")
	if AuthCSS != js.Str(js.Dig(f, "css")) {
		t.Error("AuthCSS differs from the TypeScript's")
	}
	if AuthJS != js.Str(js.Dig(f, "js")) {
		t.Error("AuthJS differs from the TypeScript's")
	}
}

func TestPagesMatch(t *testing.T) {
	f := fixture.PHP(t, "pages.json")
	pages := js.Arr(js.Dig(f, "pages"))
	if len(pages) == 0 {
		t.Fatal("no pages")
	}
	for _, c := range pages {
		base, fn := js.Str(js.Dig(c, "base")), js.Str(js.Dig(c, "fn"))
		opts := js.Obj(js.Dig(c, "opts"))
		get := func(key string) string { return js.Str(opts.Value(key)) }
		var html string
		switch fn {
		case "loginPage":
			o := LoginOptions{Error: get("error"), Email: get("email"), Forgot: get("forgot")}
			if opts.Has("next") {
				next := get("next")
				o.Next = &next
			}
			html = LoginPage(base, o, "en")
		case "codePage":
			html = CodePage(base, CodeOptions{Pending: get("pending"), Next: get("next"), Error: get("error")}, "en")
		case "invitePage":
			html = InvitePage(base, InviteOptions{Code: get("code"), Email: get("email"), Role: get("role"), Host: get("host"), Error: get("error")}, "en")
		case "inviteGonePage":
			html = InviteGonePage(base, "en")
		case "setupPage":
			html = SetupPage(base, SetupOptions{Code: get("code"), Error: get("error"), Email: get("email"), AskCode: js.Truthy(opts.Value("askCode"))}, "en")
		case "setupLockedPage":
			html = SetupLockedPage(base, "en")
		case "setupNeedsTokenPage":
			html = SetupNeedsTokenPage(base, "en")
		default:
			t.Fatalf("unknown page %s", fn)
		}
		if want := js.Str(js.Dig(c, "html")); html != want {
			t.Errorf("%s at %q differs:\n%s\nwant:\n%s", fn, base, html, want)
		}
	}
	for _, c := range js.Arr(js.Dig(f, "roles")) {
		if got := RoleText(js.Str(js.Dig(c, "role")), "", "en"); got != js.Str(js.Dig(c, "text")) {
			t.Errorf("role %q: %s", js.Str(js.Dig(c, "role")), got)
		}
	}
}

func TestSetupAsksForTheTokenWhenTold(t *testing.T) {
	page := SetupPage("/runlight", SetupOptions{AskCode: true}, "en")
	for _, want := range []string{"RUNLIGHT_TOKEN", `action="/runlight/setup"`, `href="/runlight/auth.css"`} {
		if !strings.Contains(page, want) {
			t.Errorf("setup page lacks %s", want)
		}
	}
	if !strings.Contains(InvitePage("", InviteOptions{Code: "c", Email: "a@b.c", Role: "member", Host: "x"}, "en"), "as a member") {
		t.Error("invite page lacks the role")
	}
}

func TestEveryAccountPageComesOutInFrenchWhenAsked(t *testing.T) {
	for _, c := range []struct{ name, html, heading string }{
		{"sign in", LoginPage("/runlight", LoginOptions{Forgot: "https://runlight.sh/docs"}, "fr"), "Se connecter"},
		{"the code step", CodePage("/runlight", CodeOptions{Pending: "p", Next: "/"}, "fr"), "Saisissez votre code"},
		{"an invite", InvitePage("/runlight", InviteOptions{Code: "c", Email: "a@example.com", Role: "viewer", Host: "stats.example.com"}, "fr"), "Rejoindre Runlight"},
		{"an invite that is gone", InviteGonePage("/runlight", "fr"), "Cette invitation ne fonctionne plus"},
		{"setup", SetupPage("/runlight", SetupOptions{AskCode: true}, "fr"), "Créez votre compte"},
		{"setup locked", SetupLockedPage("/runlight", "fr"), "Terminez la configuration"},
		{"setup needing a token", SetupNeedsTokenPage("/runlight", "fr"), "Terminez la configuration"},
	} {
		for _, want := range []string{
			`<html lang="fr">`,
			"<h1>" + c.heading + "</h1>",
			"<title>" + c.heading + " | Runlight</title>",
			`<script src="/runlight/auth.js?lang=fr"></script>`,
			`aria-label="Changer de thème"`,
		} {
			if !strings.Contains(c.html, want) {
				t.Errorf("%s lacks %s", c.name, want)
			}
		}
	}
	invite := InvitePage("", InviteOptions{Code: "c", Email: "a@example.com", Role: "member", Host: "stats.example.com", Site: "<Blog>"}, "fr")
	if !strings.Contains(invite, "Votre rôle : membre, qui peut modifier les réglages de &lt;Blog&gt; uniquement.") {
		t.Errorf("the role is French too, and the site name stays escaped: %s", invite)
	}
	if login := LoginPage("", LoginOptions{Forgot: "https://x.example/?a=1&b=2"}, "fr"); !strings.Contains(login, `<a href="https://x.example/?a=1&amp;b=2" target="_blank" rel="noopener">la documentation explique`) {
		t.Errorf("the docs link: %s", login)
	}
	// The script's words: show and hide, the theme, and the strength meter.
	script := AuthJSFor("fr")
	for _, words := range []string{`"Afficher le mot de passe"`, `"Masquer le mot de passe"`, `"Thème : réglage de l’appareil"`, `"Thème : sombre"`, `["Trop court", "Faible", "Moyen", "Bon", "Fort"]`} {
		if !strings.Contains(script, words) {
			t.Errorf("the script lacks %s", words)
		}
	}
	if strings.Contains(script, "Show password") {
		t.Error("the script still has English")
	}
	if AuthJSFor("xx") != AuthJS || AuthJSFor("en") != AuthJS {
		t.Error("a language Runlight does not speak is English")
	}
}

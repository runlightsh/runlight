package dbtest

import (
	"context"
	"encoding/hex"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	runlight "runlight.sh/go"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/web"
)

func TestBrokenPercentEscapesInAPathAnswerAsANameNobodyHas(t *testing.T) {
	ctx := context.Background()
	rl, err := runlight.New(runlight.Options{Store: Store(t, Kinds()[0]), Logf: func(string, ...any) {}, Sites: []runlight.SiteOptions{
		{ID: "blog", Hostnames: []string{"blog.example.com"}, Timezone: "UTC"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	secret := "secret"
	routes, err := rl.Routes(runlight.RoutesOptions{Token: &secret})
	if err != nil {
		t.Fatal(err)
	}
	get := func(path string) *web.Request {
		return web.NewRequest("GET", "https://stats.example.com"+path, web.NewHeaders(), nil)
	}
	call := func(method, path, body, key string) *runlight.Response {
		t.Helper()
		var b []byte
		if body != "" {
			b = []byte(body)
		}
		return routes.Handle(ctx, web.NewRequest(method, "https://stats.example.com"+path, web.NewHeaders("authorization", "Bearer "+key, "content-type", "application/json"), b))
	}
	codeOf := func(r *runlight.Response) string {
		v, err := js.Parse(string(r.Body))
		if err != nil {
			return ""
		}
		return js.Str(v.(*js.Object).Value("code"))
	}
	for _, c := range []struct{ method, path, code, body string }{
		{"PATCH", "/runlight/api/goals/%E0?site=blog", "unknown_goal", `{"name":"X","kind":"event","match":"X"}`},
		{"DELETE", "/runlight/api/goals/%zz?site=blog", "unknown_goal", ""},
		{"PATCH", "/runlight/api/shares/%E0%A4?site=blog", "unknown_share", `{"name":"X"}`},
		{"DELETE", "/runlight/api/shares/%?site=blog", "unknown_share", ""},
		{"PATCH", "/runlight/api/sites/%E0", "unknown_site", `{"name":"X"}`},
		{"DELETE", "/runlight/api/sites/%zz", "unknown_site", ""},
		{"GET", "/runlight/api/link-domains/%E0/check?site=blog", "unknown_domain", ""},
		{"DELETE", "/runlight/api/link-domains/%zz?site=blog", "unknown_domain", ""},
	} {
		if r := call(c.method, c.path, c.body, secret); r.Status != 404 || codeOf(r) != c.code {
			t.Errorf("%s %s: %d %s", c.method, c.path, r.Status, r.Body)
		}
	}
	// A hub's manage token, checked against its one site before anything else.
	made := call("POST", "/runlight/api/tokens", `{"name":"Hub","scope":"manage","site":"blog"}`, secret)
	v, err := js.Parse(string(made.Body))
	if err != nil {
		t.Fatalf("%d %s", made.Status, made.Body)
	}
	if r := call("PATCH", "/runlight/api/sites/%E0", `{"name":"X"}`, js.Str(v.(*js.Object).Value("secret"))); r.Status != 404 || codeOf(r) != "unknown_site" {
		t.Errorf("a hub: %d %s", r.Status, r.Body)
	}
	// Public pages and short links: the share page, unsubscribing, the app's link path, and a link domain.
	for _, path := range []string{"/runlight/share/%E0", "/runlight/unsubscribe/%E0", "/runlight/assets/app.%E0.js"} {
		if r := routes.Handle(ctx, get(path)); r.Status != 404 {
			t.Errorf("%s: %d", path, r.Status)
		}
	}
	if r := rl.LinkHandler()(ctx, get("/go/%E0")); r.Status != 404 || r.Text() != "Not found" {
		t.Errorf("/go/: %d %s", r.Status, r.Body)
	}
	if err := rl.Store.AddLinkDomain(ctx, "go.example.net", "blog", time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	rl.ForgetLinkDomains()
	linked, err := rl.LinkDomainResponse(ctx, web.NewRequest("GET", "https://go.example.net/%E0", web.NewHeaders("host", "go.example.net"), nil))
	if err != nil || linked == nil || linked.Status != 404 {
		t.Errorf("a link domain: %v %v", linked, err)
	}
}

func TestThePickerSendsItsChoiceToTheRelayPageItsTicketNames(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC).UnixMilli()
	rl, err := runlight.New(runlight.Options{Store: Store(t, Kinds()[0]), Logf: func(string, ...any) {}, Now: func() int64 { return now }, Sites: []runlight.SiteOptions{
		{ID: "blog", Hostnames: []string{"blog.example.com"}, Timezone: "UTC"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	secret := "secret"
	routes, err := rl.Routes(runlight.RoutesOptions{Token: &secret})
	if err != nil {
		t.Fatal(err)
	}
	post := func(path, body, key string) *runlight.Response {
		return routes.Handle(ctx, web.NewRequest("POST", "https://stats.example.com"+path, web.NewHeaders("authorization", "Bearer "+key, "content-type", "application/json"), []byte(body)))
	}
	ask := func(body *js.Object, key string) *runlight.Response {
		return post("/runlight/api/pick?site=blog", js.Stringify(body), key)
	}
	bodyOf := func(r *runlight.Response) *js.Object {
		t.Helper()
		v, err := js.Parse(string(r.Body))
		if err != nil {
			t.Fatalf("%d %s", r.Status, r.Body)
		}
		return v.(*js.Object)
	}
	script := func(ticket string) string {
		return routes.Handle(ctx, web.NewRequest("GET", "https://stats.example.com/runlight/pick.js?runlight=pick&runlight_ticket="+url.QueryEscape(ticket), web.NewHeaders(), nil)).Text()
	}
	nonce := "0123456789abcdef0123456789abcdef"
	back := "https://stats.example.com/runlight/pick-return"
	origin := "https://stats.example.com"

	asked := ask(js.NewObject("origin", origin, "return", back, "nonce", nonce), secret)
	if asked.Status != 200 {
		t.Fatalf("%d %s", asked.Status, asked.Body)
	}
	ticket := js.Str(bodyOf(asked).Value("ticket"))
	parts := strings.Split(ticket, ".")
	if len(parts) != 6 {
		t.Fatalf("the return address and nonce are signed into the ticket: %s", ticket)
	}
	picker := script(ticket)
	if !strings.Contains(picker, js.Stringify(back)) || !strings.Contains(picker, js.Stringify(nonce)) || strings.Contains(picker, "__RUNLIGHT_PICK_RETURN__") || strings.Contains(picker, "__RUNLIGHT_PICK_NONCE__") {
		t.Fatal("the picker names the relay page and nonce")
	}

	// Neither can be changed: a ticket with another return address or nonce is no ticket, and the picker sends nowhere.
	other := hex.EncodeToString([]byte("https://stats.example.com/elsewhere/pick-return"))
	for _, changed := range [][]string{
		{parts[0], parts[1], parts[2], other, parts[4], parts[5]},
		{parts[0], parts[1], parts[2], parts[3], strings.Repeat("f", 32), parts[5]},
	} {
		if sent := script(strings.Join(changed, ".")); strings.Contains(sent, "stats.example.com") || strings.Contains(sent, nonce) {
			t.Error("a changed ticket still names where to send")
		}
	}

	// The return address is the relay page on the dashboard's own origin, and the nonce is 32 hex digits.
	for _, body := range []*js.Object{
		js.NewObject("origin", origin, "return", "https://evil.example/pick-return", "nonce", nonce),
		js.NewObject("origin", origin, "return", "https://stats.example.com.evil.example/pick-return", "nonce", nonce),
		js.NewObject("origin", origin, "return", "https://stats.example.com/runlight/", "nonce", nonce),
		js.NewObject("origin", origin, "return", "https://stats.example.com/pick-return?x=1", "nonce", nonce),
		js.NewObject("origin", origin, "return", "https://stats.example.com/pick-return#x", "nonce", nonce),
		js.NewObject("origin", origin, "return", "https://stats.example.com/"+strings.Repeat("a", 1024)+"/pick-return", "nonce", nonce),
		js.NewObject("origin", origin, "return", back),
		js.NewObject("origin", origin, "return", back, "nonce", "short"),
		js.NewObject("origin", origin, "return", back, "nonce", strings.ToUpper(nonce)),
		js.NewObject("origin", origin, "nonce", nonce),
	} {
		if r := ask(body, secret); r.Status != 400 || js.Str(bodyOf(r).Value("code")) != "pick_return" {
			t.Errorf("%s: %d %s", js.Stringify(body), r.Status, r.Body)
		}
	}
	if r := ask(js.NewObject("origin", origin, "return", "https://stats.example.com/pick-return", "nonce", nonce), secret); r.Status != 200 {
		t.Errorf("a dashboard at the root: %d %s", r.Status, r.Body)
	}

	// An older dashboard sends neither, and its ticket names only the origin.
	older := js.Str(bodyOf(ask(js.NewObject("origin", origin), secret)).Value("ticket"))
	if picker := script(older); len(strings.Split(older, ".")) != 4 || !strings.Contains(picker, js.Stringify(origin)) || strings.Contains(picker, nonce) {
		t.Errorf("an older ticket: %s", older)
	}

	// A hub's ticket names a relay page on the hub it connected from, and no other origin.
	made := bodyOf(post("/runlight/api/tokens", `{"name":"Hub","scope":"manage","site":"blog"}`, secret))
	hubOrigin := "https://hub.example.net"
	if err := rl.Store.SetSetting(ctx, "token-origin:"+js.Str(js.Dig(made, "token", "id")), &hubOrigin); err != nil {
		t.Fatal(err)
	}
	hubKey := js.Str(made.Value("secret"))
	if r := ask(js.NewObject("origin", hubOrigin, "return", hubOrigin+"/pick-return", "nonce", nonce), hubKey); r.Status != 200 {
		t.Errorf("a hub: %d %s", r.Status, r.Body)
	}
	if r := ask(js.NewObject("origin", hubOrigin, "return", "https://evil.example/pick-return", "nonce", nonce), hubKey); r.Status != 400 {
		t.Errorf("a hub naming another origin: %d %s", r.Status, r.Body)
	}

	now += 31 * 60_000
	if strings.Contains(script(ticket), nonce) {
		t.Error("a ticket runs out after half an hour")
	}
}

func TestTheRelayPageIsStaticAndRunsOnlyItsOwnScript(t *testing.T) {
	ctx := context.Background()
	rl, err := runlight.New(runlight.Options{Store: Store(t, Kinds()[0]), Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	secret := "secret"
	routes, err := rl.Routes(runlight.RoutesOptions{Token: &secret})
	if err != nil {
		t.Fatal(err)
	}
	get := func(path string, headers ...string) *runlight.Response {
		return routes.Handle(ctx, web.NewRequest("GET", "https://stats.example.com"+path, web.NewHeaders(headers...), nil))
	}
	page := get("/runlight/pick-return", "accept-language", "de-DE,de;q=0.9")
	if page.Status != 200 || !strings.Contains(page.Header.Get("content-type"), "text/html") || page.Header.Get("cache-control") != "no-store" || page.Header.Get("referrer-policy") != "no-referrer" {
		t.Fatalf("%d %v", page.Status, page.Header)
	}
	csp := page.Header.Get("content-security-policy")
	if !strings.Contains(csp, "script-src 'self'") || !strings.Contains(csp, "frame-ancestors 'none'") || regexp.MustCompile(`script-src[^;]*unsafe`).MatchString(csp) {
		t.Errorf("csp: %s", csp)
	}
	html := page.Text()
	if !strings.Contains(html, `lang="de"`) || !strings.Contains(html, `<script src="/runlight/pick-return.js"></script>`) || strings.Contains(html, "<script>") {
		t.Errorf("page: %s", html)
	}
	if !strings.Contains(html, `<div id="done" hidden>`) || !strings.Contains(html, `<div id="gone" hidden>`) {
		t.Errorf("page: %s", html)
	}
	script := get("/runlight/pick-return.js")
	if !strings.Contains(script.Header.Get("content-type"), "javascript") || !strings.Contains(script.Text(), "BroadcastChannel") {
		t.Errorf("script: %d %v", script.Status, script.Header)
	}
	if r := routes.Handle(ctx, web.NewRequest("POST", "https://stats.example.com/runlight/pick-return", web.NewHeaders(), nil)); r.Status != 404 {
		t.Errorf("POST: %d", r.Status)
	}
	// Signed out, it answers the same: it holds nothing.
	key := strings.Repeat("a", 32)
	open, err := runlight.New(runlight.Options{Store: Store(t, Kinds()[0]), Logf: func(string, ...any) {}, Secret: &key})
	if err != nil {
		t.Fatal(err)
	}
	openRoutes, err := open.Routes(runlight.RoutesOptions{Token: &secret, Accounts: true})
	if err != nil {
		t.Fatal(err)
	}
	if r := openRoutes.Handle(ctx, web.NewRequest("GET", "https://stats.example.com/runlight/pick-return", web.NewHeaders(), nil)); r.Status != 200 {
		t.Errorf("signed out: %d", r.Status)
	}
}

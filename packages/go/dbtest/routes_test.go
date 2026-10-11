package dbtest

import (
	"context"
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

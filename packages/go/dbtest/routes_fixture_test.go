package dbtest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"

	runlight "runlight.sh/go"
	"runlight.sh/go/internal/fixture"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/web"
)

// Replays packages/php/tests/fixtures/routes.json, which scripts/php-fixtures-routes.mts writes from the
// TypeScript SDK: the dashboard's page, the tracker, refusals with their codes, and OAuth's documents, each
// answer byte for byte with every header. Its helper cases are replayed in the runlight package.
func TestRoutesAnswerAsTheTypeScriptDoes(t *testing.T) {
	for _, name := range []string{"RUNLIGHT_TOKEN", "RUNLIGHT_SECRET", "CRON_SECRET", "RUNLIGHT_OBSERVE_KEY", "NODE_ENV"} {
		t.Setenv(name, "")
	}
	f := fixture.PHP(t, "routes.json")
	now := int64(js.Num(js.Dig(f, "now")))
	exchanges := js.Arr(js.Dig(f, "exchanges"))
	if len(exchanges) == 0 {
		t.Fatal("no exchanges")
	}
	for _, exchange := range exchanges {
		t.Run(js.Str(js.Dig(exchange, "name")), func(t *testing.T) {
			replayRoutes(t, exchange, now)
		})
	}
}

func replayRoutes(t *testing.T, exchange any, now int64) {
	ctx := context.Background()
	options := runlight.Options{Store: Store(t, Kinds()[0]), Logf: func(string, ...any) {}, Now: func() int64 { return now }}
	given := js.Obj(js.Dig(exchange, "runlight"))
	for _, key := range given.Keys() {
		switch key {
		case "site":
			site := siteOptions(given.Value("site"))
			options.Site = &site
		case "sites":
			for _, s := range js.Arr(given.Value("sites")) {
				options.Sites = append(options.Sites, siteOptions(s))
			}
		default:
			t.Fatalf("the fixture's runlight has %q, which this replay does not pass on", key)
		}
	}
	rl, err := runlight.New(options)
	if err != nil {
		t.Fatal(err)
	}
	var routesOptions runlight.RoutesOptions
	given = js.Obj(js.Dig(exchange, "routes"))
	for _, key := range given.Keys() {
		value := given.Value(key)
		switch key {
		case "token":
			token := js.Str(value)
			routesOptions.Token = &token
		case "basePath":
			base := js.Str(value)
			routesOptions.BasePath = &base
		case "signOut":
			routesOptions.SignOut = js.Str(value)
		case "signIn":
			routesOptions.SignIn = js.Str(value)
		case "geoCredit":
			routesOptions.GeoCredit = value == true
		default:
			t.Fatalf("the fixture's routes have %q, which this replay does not pass on", key)
		}
	}
	routes, err := rl.Routes(routesOptions)
	if err != nil {
		t.Fatal(err)
	}
	for _, answer := range js.Arr(js.Dig(exchange, "answers")) {
		ask := js.Obj(js.Dig(answer, "ask"))
		method := "GET"
		if m, ok := ask.Get("method"); ok {
			method = js.Str(m)
		}
		path := js.Str(ask.Value("path"))
		label := method + " " + path
		headers := web.NewHeaders()
		if h, ok := ask.Get("headers"); ok {
			js.Obj(h).Each(func(name string, value any) { headers.Set(name, js.Str(value)) })
		}
		var body []byte
		if b, ok := ask.Get("body"); ok && b != nil {
			body = []byte(js.Str(b))
			// JavaScript's Request gives a string body this type when none is named.
			if !headers.Has("content-type") {
				headers.Set("content-type", "text/plain;charset=UTF-8")
			}
		}
		response := routes.Handle(ctx, web.NewRequest(method, "https://example.com"+path, headers, body))
		if want := int(js.Num(js.Dig(answer, "status"))); response.Status != want {
			t.Errorf("%s: status %d, want %d", label, response.Status, want)
		}
		got := js.NewObject()
		response.Header.Each(func(name, value string) {
			if name == "set-cookie" {
				list, _ := got.Get(name)
				got.Set(name, append(js.Arr(list), value))
				return
			}
			got.Set(name, value)
		})
		if g, w := js.Canonical(got), js.Canonical(js.Dig(answer, "headers")); g != w {
			t.Errorf("%s: headers\n got %s\nwant %s", label, g, w)
		}
		if sum, ok := js.Obj(answer).Get("sha256"); ok {
			digest := sha256.Sum256(response.Body)
			if hex.EncodeToString(digest[:]) != js.Str(sum) {
				t.Errorf("%s: body's digest differs", label)
			}
		} else if string(response.Body) != js.Str(js.Dig(answer, "text")) {
			t.Errorf("%s: body\n got %s\nwant %s", label, response.Body, js.Str(js.Dig(answer, "text")))
		}
	}
}

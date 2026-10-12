package runlight

import (
	"testing"

	"runlight.sh/go/internal/fixture"
	"runlight.sh/go/internal/js"
)

// The helpers routes.ts and oauth.ts export, against packages/php/tests/fixtures/routes.json
// (scripts/php-fixtures-routes.mts). Its exchanges, which need a database, are replayed in dbtest.

func TestCodedErrorsAreTheSameBytesAsTheTypeScripts(t *testing.T) {
	cases := js.Arr(js.Dig(fixture.PHP(t, "routes.json"), "coded"))
	if len(cases) == 0 {
		t.Fatal("no coded cases")
	}
	for _, c := range cases {
		args := js.Arr(js.Dig(c, "args"))
		var params *js.Object
		if p, ok := args[3].(*js.Object); ok {
			params = p
		}
		var headers []string
		if h, ok := args[4].(*js.Object); ok {
			h.Each(func(name string, value any) { headers = append(headers, name, js.Str(value)) })
		}
		r := Coded(js.Str(args[0]), js.Str(args[1]), int(js.Num(args[2])), params, headers...)
		label := js.Str(args[1])
		if r.Status != int(js.Num(js.Dig(c, "status"))) {
			t.Errorf("%s: status %d", label, r.Status)
		}
		if string(r.Body) != js.Str(js.Dig(c, "text")) {
			t.Errorf("%s: body %s", label, r.Body)
		}
		got := js.NewObject()
		r.Header.Each(func(name, value string) { got.Set(name, value) })
		same(t, label+": headers", got, js.Dig(c, "headers"))
	}
}

func TestHostNamesAreBareAsTheTypeScriptMakesThem(t *testing.T) {
	for _, c := range js.Arr(js.Dig(fixture.PHP(t, "routes.json"), "hostName")) {
		pair := js.Arr(c)
		if got := HostName(js.Str(pair[0])); got != js.Str(pair[1]) {
			t.Errorf("HostName(%q) = %q, want %q", js.Str(pair[0]), got, js.Str(pair[1]))
		}
	}
}

func TestManagePathsAreTheTypeScripts(t *testing.T) {
	for _, c := range js.Arr(js.Dig(fixture.PHP(t, "routes.json"), "managePath")) {
		row := js.Arr(c)
		if got := ManagePath(js.Str(row[0]), js.Str(row[1])); got != row[2].(bool) {
			t.Errorf("ManagePath(%s %s) = %v", js.Str(row[0]), js.Str(row[1]), got)
		}
	}
}

func TestPKCES256MatchesTheTypeScript(t *testing.T) {
	for _, c := range js.Arr(js.Dig(fixture.PHP(t, "routes.json"), "s256")) {
		pair := js.Arr(c)
		if got := S256(js.Str(pair[0])); got != js.Str(pair[1]) {
			t.Errorf("S256(%q) = %q, want %q", js.Str(pair[0]), got, js.Str(pair[1]))
		}
	}
}

func TestResourceMetadataURLIsTheTypeScripts(t *testing.T) {
	for _, c := range js.Arr(js.Dig(fixture.PHP(t, "routes.json"), "resourceMetadataUrl")) {
		row := js.Arr(c)
		if got := ResourceMetadataURL(js.Str(row[0]), js.Str(row[1])); got != js.Str(row[2]) {
			t.Errorf("ResourceMetadataURL(%q, %q) = %q", js.Str(row[0]), js.Str(row[1]), got)
		}
	}
}

package conformance

import (
	"testing"

	"runlight.sh/go/internal/fixture"
	"runlight.sh/go/internal/js"
)

// The normalizer against cases run through normalize() in http-conformance.ts
// (packages/php/tests/fixtures/conformance-normalize.json).
func TestNormalizesAsTheTypeScriptDoes(t *testing.T) {
	cases := js.Arr(fixture.PHP(t, "conformance-normalize.json"))
	if len(cases) == 0 {
		t.Fatal("no cases")
	}
	for i, c := range cases {
		got, want := Canonical(Normalize(js.Dig(c, "input"), "")), Canonical(js.Dig(c, "output"))
		if got != want {
			t.Errorf("case %d:\n got %s\nwant %s", i+1, got, want)
		}
	}
}

func TestNormalizeKeepsObjectsAndArraysApart(t *testing.T) {
	if got := js.Stringify(Normalize(js.NewObject("a", js.NewObject(), "b", []any{}), "")); got != `{"a":{},"b":[]}` {
		t.Errorf("got %s", got)
	}
}

func TestCookieShape(t *testing.T) {
	for given, want := range map[string]string{
		"rl_session=abc123; Path=/; HttpOnly": "rl_session=<value>; Path=/; HttpOnly",
		"rl_session=; Path=/; Max-Age=0":      "rl_session=; Path=/; Max-Age=0",
		"a=b=c":                               "a=<value>",
		"no value here":                       "no value here",
	} {
		if got := CookieShape(given); got != want {
			t.Errorf("CookieShape(%q) = %q, want %q", given, got, want)
		}
	}
}

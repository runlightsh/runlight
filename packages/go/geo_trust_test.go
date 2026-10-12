package runlight

import (
	"testing"

	"runlight.sh/go/internal/web"
)

// A hosting platform's location headers count only when proxy headers are trusted: without a proxy in
// front, a client writes them itself.
func TestLocationHeadersCountOnlyWhenProxyHeadersAreTrusted(t *testing.T) {
	lookup := func(string) (*Location, error) { return &Location{Country: "DE", Region: "BE", City: "Berlin"}, nil }
	for name, headers := range map[string]*web.Headers{
		"cloudflare": web.NewHeaders("cf-ipcountry", "US", "cf-region-code", "CA", "cf-ipcity", "San Francisco"),
		"vercel":     web.NewHeaders("x-vercel-ip-country", "FR"),
		"netlify":    web.NewHeaders("x-nf-geo", "eyJjb3VudHJ5Ijp7ImNvZGUiOiJKUCJ9fQ=="),
	} {
		if got := LocateTrusting(headers, "203.0.113.1", lookup, false); got.Country != "DE" {
			t.Errorf("%s untrusted: %+v, want the lookup's", name, got)
		}
		if got := LocateTrusting(headers, "203.0.113.1", lookup, true); got.Country == "DE" || got.Country == "" {
			t.Errorf("%s trusted: %+v, want the platform's", name, got)
		}
		if got := Locate(headers, "203.0.113.1", lookup); got.Country == "DE" {
			t.Errorf("%s: Locate trusts the headers", name)
		}
	}
	// Trusted headers that name no country still leave the lookup to answer.
	if got := LocateTrusting(web.NewHeaders("cf-ipcity", "Paris"), "203.0.113.1", lookup, true); got.Country != "DE" {
		t.Errorf("no country: %+v", got)
	}
}

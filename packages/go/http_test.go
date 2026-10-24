package runlight_test

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	runlight "runlight.sh/go"
)

// oneLink is a database with nothing in it that takes every write, except
// for one link domain, go.example.com, with one link on it, /hello.
type oneLink struct{}

func (oneLink) Dialect() string { return "sqlite" }
func (oneLink) All(_ context.Context, sql string, params ...any) ([]runlight.Row, error) {
	if strings.Contains(sql, "FROM rl_link_domains") {
		return []runlight.Row{{"domain": "go.example.com", "site": "default"}}, nil
	}
	if strings.Contains(sql, "FROM rl_links WHERE slug") && len(params) > 0 && params[0] == "hello" {
		return []runlight.Row{{"id": "a1", "site": "default", "domain": "go.example.com", "slug": "hello", "url": "https://example.org/landing", "created_at": 0, "updated_at": 0}}, nil
	}
	return nil, nil
}
func (oneLink) Run(context.Context, string, ...any) error { return nil }

func TestNetHTTPAdaptersAnswerLinkDomains(t *testing.T) {
	rl, err := runlight.New(runlight.Options{Store: runlight.NewStore(oneLink{}), Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}}, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	token := "a-long-random-token-for-tests"
	routes, err := rl.Routes(runlight.RoutesOptions{Token: &token})
	if err != nil {
		t.Fatal(err)
	}
	app := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		_, _ = io.WriteString(w, "the app "+string(body))
	})
	mux := http.NewServeMux()
	mux.Handle("/runlight", routes)
	mux.Handle("/runlight/", routes)
	mux.Handle("/", app)

	for name, handler := range map[string]http.Handler{"routes.Middleware": routes.Middleware(app), "rl.LinkDomains": rl.LinkDomains(mux)} {
		t.Run(name, func(t *testing.T) {
			server := httptest.NewServer(handler)
			defer server.Close()
			do := func(method, host, path, body string) (*http.Response, string) {
				t.Helper()
				req, _ := http.NewRequest(method, server.URL+path, strings.NewReader(body))
				req.Host = host
				res, err := http.DefaultTransport.RoundTrip(req)
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				text, _ := io.ReadAll(res.Body)
				return res, string(text)
			}
			if res, _ := do("GET", "go.example.com", "/hello", ""); res.StatusCode != 302 || res.Header.Get("location") != "https://example.org/landing" {
				t.Errorf("a link on its link domain: %d %s", res.StatusCode, res.Header.Get("location"))
			}
			if res, body := do("GET", "go.example.com", "/about", ""); res.StatusCode != 404 || strings.HasPrefix(body, "the app") {
				t.Errorf("a link domain is not the app: %d %s", res.StatusCode, body)
			}
			if res, body := do("GET", "go.example.com", "/runlight/api/stats", ""); res.StatusCode != 401 {
				t.Errorf("the dashboard stays reachable on a link domain: %d %s", res.StatusCode, body)
			}
			if res, body := do("GET", "example.com", "/hello", ""); res.StatusCode != 200 || body != "the app " {
				t.Errorf("the app's own host reaches the app: %d %s", res.StatusCode, body)
			}
			if res, body := do("POST", "example.com", "/form", "a=1"); res.StatusCode != 200 || body != "the app a=1" {
				t.Errorf("the app gets its body unread: %d %s", res.StatusCode, body)
			}
		})
	}
}

func TestObserveChecksTheKeyBeforeTheBody(t *testing.T) {
	rl, err := runlight.New(runlight.Options{Store: runlight.NewStore(oneLink{}), Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}}, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	routes, err := rl.Routes(runlight.RoutesOptions{})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(routes)
	defer server.Close()
	// Neither key is one this install made, so the body, which would be refused, is never read.
	for _, key := range []string{"not-a-key", "rlo_" + strings.Repeat("ab", 20)} {
		req, _ := http.NewRequest("POST", server.URL+"/runlight/api/observe", strings.NewReader("{not json"))
		req.Header.Set("authorization", "Bearer "+key)
		req.Header.Set("content-type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 401 {
			t.Errorf("%s: %d, want 401", key, res.StatusCode)
		}
	}
}

func TestWithTheDefaultTrustForwardingHeadersCountOnlyFromAPrivateAddress(t *testing.T) {
	var said []string
	logf := func(format string, args ...any) { said = append(said, fmt.Sprintf(format, args...)) }
	request := func(ip string, pairs ...string) *runlight.Request {
		header := &runlight.Headers{}
		for i := 0; i+1 < len(pairs); i += 2 {
			header.Append(pairs[i], pairs[i+1])
		}
		return &runlight.Request{URL: "https://example.com/e", Method: "GET", Header: header, RemoteAddress: ip}
	}
	forwarded := func(ip string) *runlight.Request { return request(ip, "x-forwarded-for", "8.8.4.4") }
	site := &runlight.SiteOptions{Hostnames: []string{"example.com"}}

	quiet, err := runlight.New(runlight.Options{Store: runlight.NewStore(oneLink{}), Site: site, TrustProxy: true, Logf: logf})
	if err != nil {
		t.Fatal(err)
	}
	if got := quiet.ClientIP(forwarded("8.8.8.8")); got != "8.8.4.4" {
		t.Errorf("TrustProxy set on purpose believes a public address: %q", got)
	}
	if len(said) != 0 {
		t.Errorf("and is never second-guessed: %q", said)
	}

	rl, err := runlight.New(runlight.Options{Store: runlight.NewStore(oneLink{}), Site: site, Logf: logf})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ ip, why string }{{"10.0.0.2", "a proxy on a private network"}, {"::ffff:127.0.0.1", "one on this computer"}, {"", "a platform that passes no address on"}} {
		if got := rl.ClientIP(forwarded(c.ip)); got != "8.8.4.4" {
			t.Errorf("%s is believed: %q", c.why, got)
		}
	}
	if got := rl.ClientIP(request("8.8.8.8")); got != "8.8.8.8" {
		t.Errorf("client IP %q", got)
	}
	if len(said) != 0 {
		t.Errorf("a public address without forwarding headers says nothing: %q", said)
	}
	if got := rl.ClientIP(forwarded("1.1.1.1")); got != "1.1.1.1" {
		t.Errorf("a client straight from the internet cannot choose its address: %q", got)
	}
	rl.ClientIP(forwarded("1.0.0.1"))
	if len(said) != 1 || !strings.Contains(said[0], "cf-connecting-ip") {
		t.Errorf("said once, naming the header: %q", said)
	}
}

func TestDashboardNamesTheCMSOnlyWhenSet(t *testing.T) {
	rl, err := runlight.New(runlight.Options{Store: runlight.NewStore(oneLink{}), Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}}, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	for _, cms := range []string{"", `Word"Press`} {
		routes, err := rl.Routes(runlight.RoutesOptions{CMS: cms})
		if err != nil {
			t.Fatal(err)
		}
		res := httptest.NewRecorder()
		routes.ServeHTTP(res, httptest.NewRequest("GET", "/runlight", nil))
		page := res.Body.String()
		if cms == "" && strings.Contains(page, "data-cms") {
			t.Errorf("no CMS, but the page names one: %s", page)
		}
		if cms != "" && !strings.Contains(page, ` data-cms="Word&#34;Press" data-world=`) {
			t.Errorf("the page does not name the CMS: %s", page)
		}
		// Its own admin may frame the whole dashboard; otherwise nothing may.
		ancestors, frame := "frame-ancestors 'none'", "DENY"
		if cms != "" {
			ancestors, frame = "frame-ancestors 'self'", "SAMEORIGIN"
		}
		if csp := res.Header().Get("content-security-policy"); !strings.Contains(csp, ancestors) {
			t.Errorf("cms %q: the policy is %q, want %s", cms, csp, ancestors)
		}
		if got := res.Header().Get("x-frame-options"); got != frame {
			t.Errorf("cms %q: x-frame-options is %q, want %q", cms, got, frame)
		}
	}
}

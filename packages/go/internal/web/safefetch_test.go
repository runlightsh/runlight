package web

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// A Fetcher other than the built-in one may not honour PublicOnly, so a name
// that resolves to a private address never reaches it.
func TestPublicFetchLooksUpNamesForOtherFetchers(t *testing.T) {
	was := Resolver
	defer func() { Resolver = was }()
	Resolver = func(_ context.Context, name string) ([]string, error) {
		switch name {
		case "inside.example":
			return []string{"93.184.216.34", "10.0.0.1"}, nil
		case "outside.example":
			return []string{"93.184.216.34"}, nil
		}
		return nil, errors.New("no such host")
	}
	var asked []string
	fetcher := FetchFunc(func(_ context.Context, url string, _ FetchInit) (*Response, error) {
		asked = append(asked, url)
		return NewResponse(200, []byte("ok")), nil
	})
	_, err := PublicFetch(context.Background(), fetcher, "https://inside.example/", FetchInit{}, 0)
	var private *PrivateAddressError
	if !errors.As(err, &private) {
		t.Fatalf("inside.example: %v, want a PrivateAddressError", err)
	}
	for _, target := range []string{"https://outside.example/", "https://unknown.example/"} {
		if _, err := PublicFetch(context.Background(), fetcher, target, FetchInit{}, 0); err != nil {
			t.Fatalf("%s: %v", target, err)
		}
	}
	if len(asked) != 2 || asked[0] != "https://outside.example/" || asked[1] != "https://unknown.example/" {
		t.Fatalf("fetched %v", asked)
	}
}

// Link-local and cloud metadata addresses are told apart from loopback and private ones.
func TestMetadataAddresses(t *testing.T) {
	for _, ip := range []string{"169.254.169.254", "169.254.0.1", "100.100.100.200", "fe80::1", "fe80::a9fe:a9fe", "fd00:ec2::254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe"} {
		if !MetadataAddress(ip) {
			t.Errorf("%s is a metadata address", ip)
		}
	}
	for _, ip := range []string{"127.0.0.1", "::1", "10.0.0.5", "192.168.1.20", "fd00::1", "fd00:ec2::253", "93.184.215.14", "not an address"} {
		if MetadataAddress(ip) {
			t.Errorf("%s is not a metadata address", ip)
		}
	}
	was := Resolver
	defer func() { Resolver = was }()
	Resolver = func(_ context.Context, name string) ([]string, error) {
		switch name {
		case "localhost":
			return []string{"127.0.0.1", "::1"}, nil
		case "points.example":
			return []string{"93.184.216.34", "169.254.169.254"}, nil
		}
		return nil, errors.New("no such host")
	}
	ctx := context.Background()
	for host, want := range map[string]bool{"metadata.google.internal": true, "[fd00:ec2::254]": true, "169.254.169.254": true, "points.example": true,
		"localhost": false, "192.168.1.20": false, "unknown.example": false} {
		if MetadataHost(ctx, host) != want {
			t.Errorf("MetadataHost(%q) is not %v", host, want)
		}
	}
}

// A service's redirects are followed only while each one stays on its origin and off link-local and metadata addresses.
func TestServiceFetchChecksEveryRedirect(t *testing.T) {
	type seen struct{ method, url, body, authorization, kind string }
	var mu sync.Mutex
	var got []seen
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, _ := io.ReadAll(req.Body)
		mu.Lock()
		got = append(got, seen{req.Method, req.URL.Path, string(body), req.Header.Get("authorization"), req.Header.Get("content-type")})
		mu.Unlock()
		redirect := func(status int, location string) {
			w.Header().Set("location", location)
			w.WriteHeader(status)
		}
		switch req.URL.Path {
		case "/metadata":
			redirect(302, "http://169.254.169.254/latest/meta-data/")
		case "/metadata-v6":
			redirect(307, "http://[fd00:ec2::254]/")
		case "/see-other":
			redirect(303, "/landed")
		case "/keep":
			redirect(307, "/landed")
		case "/elsewhere":
			redirect(307, strings.Replace(server.URL, "127.0.0.1", "localhost", 1)+"/landed")
		case "/downgrade":
			redirect(308, "http://198.51.100.7/landed")
		case "/scheme":
			redirect(307, "ftp://example.com/landed")
		case "/loop":
			redirect(302, "/loop")
		default:
			_, _ = io.WriteString(w, "ok")
		}
	}))
	defer server.Close()
	ctx := context.Background()
	fetcher := HTTPFetcher{}
	ask := func() FetchInit {
		return FetchInit{Method: "POST", Headers: NewHeaders("authorization", "Bearer key", "content-type", "application/json"), Body: []byte("{}")}
	}
	// A service on this computer is fine; a redirect to a metadata address is refused before it is asked.
	for path, host := range map[string]string{"/metadata": "169.254.169.254", "/metadata-v6": "fd00:ec2::254"} {
		_, err := ServiceFetch(ctx, fetcher, server.URL+path, ask(), 5)
		var refused *MetadataAddressError
		if !errors.As(err, &refused) || refused.Host != host || err.Error() != host+" is a link-local or cloud metadata address, which Runlight never connects to" {
			t.Fatalf("%s: %v", path, err)
		}
	}
	asked := false
	never := FetchFunc(func(context.Context, string, FetchInit) (*Response, error) {
		asked = true
		return NewResponse(200, nil), nil
	})
	var refused *MetadataAddressError
	if _, err := ServiceFetch(ctx, never, "http://169.254.169.254/v1/models", FetchInit{}, 5); !errors.As(err, &refused) || asked {
		t.Fatalf("metadata address: %v, asked %v", err, asked)
	}
	// Followed as fetch follows them on the same origin: a 303 goes on as a GET with no body, and a 307 keeps both.
	for path, want := range map[string]seen{
		"/see-other": {"GET", "/landed", "", "Bearer key", ""},
		"/keep":      {"POST", "/landed", "{}", "Bearer key", "application/json"},
	} {
		mu.Lock()
		got = nil
		mu.Unlock()
		answer, err := ServiceFetch(ctx, fetcher, server.URL+path, ask(), 5)
		if err != nil || answer.Text() != "ok" {
			t.Fatalf("%s: %v", path, err)
		}
		mu.Lock()
		if len(got) != 2 || got[1] != want {
			t.Errorf("%s: %+v, want %+v second", path, got, want)
		}
		mu.Unlock()
	}
	// A redirect to another origin is refused before anything is sent there, whatever header the key is in
	// and whether or not the body would go too: exactly one request is made, to the service itself.
	keys := FetchInit{Method: "POST", Body: []byte(`{"secret":"mail"}`), Headers: NewHeaders("authorization", "Bearer key", "proxy-authorization", "x", "cookie", "a=b",
		"x-api-key", "k", "api-key", "k", "x-postmark-server-token", "k", "content-type", "application/json")}
	for path, to := range map[string]string{
		"/elsewhere": strings.Replace(server.URL, "127.0.0.1", "localhost", 1),
		"/downgrade": "http://198.51.100.7",
		"/scheme":    "ftp:",
	} {
		mu.Lock()
		got = nil
		mu.Unlock()
		_, err := ServiceFetch(ctx, fetcher, server.URL+path, keys, 5)
		var redirected *RedirectRefusedError
		if !errors.As(err, &redirected) || redirected.To != to || redirected.Host != strings.TrimPrefix(server.URL, "http://") {
			t.Fatalf("%s: %v", path, err)
		}
		if want := redirected.Host + " redirected to " + to + ". Runlight sends a service's key and request only to the address it was set up with, so set it up with that address instead"; err.Error() != want {
			t.Errorf("%s: %q", path, err.Error())
		}
		mu.Lock()
		if len(got) != 1 {
			t.Errorf("%s: %d requests, want 1", path, len(got))
		}
		mu.Unlock()
	}
	// Past the last redirect, the redirect comes back as it is.
	mu.Lock()
	got = nil
	mu.Unlock()
	answer, err := ServiceFetch(ctx, fetcher, server.URL+"/loop", FetchInit{}, 2)
	if err != nil || answer.Status != 302 {
		t.Fatalf("loop: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 3 {
		t.Errorf("loop asked %d times", len(got))
	}
}

// A fetch pinned to the public internet never goes through a proxy, which would look the name up again
// itself, so the address checked would not be the one used.
func TestPublicFetchesNeverGoThroughAProxy(t *testing.T) {
	if publicTransport.Proxy != nil {
		t.Fatal("the public transport has a proxy")
	}
	var proxied atomic.Bool
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxied.Store(true)
		w.WriteHeader(200)
	}))
	defer proxy.Close()
	t.Setenv("HTTPS_PROXY", proxy.URL)
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")
	_, err := HTTPFetcher{}.Fetch(context.Background(), "https://127.0.0.1:9/", FetchInit{PublicOnly: true, Timeout: 5 * time.Second})
	var private *PrivateAddressError
	if !errors.As(err, &private) || private.What != "127.0.0.1" {
		t.Fatalf("%v, want a PrivateAddressError for 127.0.0.1", err)
	}
	if proxied.Load() {
		t.Error("went through the proxy")
	}
}

// A service is connected to at the address its name was checked at, and never through a proxy, which would look
// the name up again itself.
func TestServiceFetchesRefuseMetadataAtConnect(t *testing.T) {
	if serviceTransport.Proxy != nil {
		t.Fatal("the service transport has a proxy")
	}
	var proxied atomic.Bool
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		proxied.Store(true)
		w.WriteHeader(200)
	}))
	defer proxy.Close()
	t.Setenv("HTTP_PROXY", proxy.URL)
	t.Setenv("NO_PROXY", "")
	for _, target := range []string{"http://169.254.169.254/", "http://[fd00:ec2::254]/", "http://[::ffff:169.254.169.254]/"} {
		_, err := HTTPFetcher{}.Fetch(context.Background(), target, FetchInit{ServiceOnly: true, Timeout: 5 * time.Second})
		var refused *MetadataAddressError
		if !errors.As(err, &refused) {
			t.Fatalf("%s: %v, want a MetadataAddressError", target, err)
		}
	}
	// A server on this computer is still reachable, and a lookup that fails is a connection that fails.
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	defer local.Close()
	answer, err := HTTPFetcher{}.Fetch(context.Background(), local.URL, FetchInit{ServiceOnly: true, Timeout: 5 * time.Second})
	if err != nil || answer.Text() != "ok" {
		t.Fatalf("local service: %v", err)
	}
	if _, err := (HTTPFetcher{}).Fetch(context.Background(), "http://no-such-name.invalid/", FetchInit{ServiceOnly: true, Timeout: 5 * time.Second}); err == nil {
		t.Fatal("a name that does not resolve was connected to")
	}
	if proxied.Load() {
		t.Error("went through the proxy")
	}
}

// A body past the limit is cut off at it, and counts as unreadable.
func TestFetchCutsABodyAtItsLimit(t *testing.T) {
	endless := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		chunk := []byte(strings.Repeat("x", 64<<10))
		for range 1 << 12 {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	}))
	defer endless.Close()
	answer, err := HTTPFetcher{}.Fetch(context.Background(), endless.URL, FetchInit{MaxBytes: 1 << 20, Truncate: true})
	if err != nil || len(answer.Body) != 1<<20 || !answer.Truncated {
		t.Fatalf("%d bytes, truncated %v, %v", len(answer.Body), answer != nil && answer.Truncated, err)
	}
	if _, err := answer.JSONWithin(1 << 20); err == nil {
		t.Error("a cut-off body was read as JSON")
	}
	if answer.TextWithin(1<<20) != "" {
		t.Error("a cut-off body was read as text")
	}
	if got := NewResponse(200, []byte(`{"a":1}`)); got.TextWithin(7) == "" || got.TextWithin(6) != "" {
		t.Error("a body is read up to its limit and no further")
	}
}

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

// A service's redirects are followed only while each one stays off link-local and metadata addresses.
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
	// Followed as fetch follows them: a 303 goes on as a GET with no body, a 307 keeps both, and the key
	// goes no further than the origin it was meant for.
	for path, want := range map[string]seen{
		"/see-other": {"GET", "/landed", "", "Bearer key", ""},
		"/keep":      {"POST", "/landed", "{}", "Bearer key", "application/json"},
		"/elsewhere": {"POST", "/landed", "{}", "", "application/json"},
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

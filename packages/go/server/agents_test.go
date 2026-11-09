package server

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"runlight.sh/go/internal/fixture"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/web"
)

func TestLogLinesReadAsTypeScriptReadsThem(t *testing.T) {
	f := fixture.PHP(t, "agents.json")
	now := int64(js.Num(js.Dig(f, "now")))
	cases := js.Arr(js.Dig(f, "cases"))
	if len(cases) < 100 {
		t.Fatalf("%d cases", len(cases))
	}
	for _, c := range cases {
		line := js.Str(js.Dig(c, "line"))
		site, _ := js.Dig(c, "site").(string)
		var parsed, fetched any
		if hit := ParseLine(line, site); hit != nil {
			parsed = js.NewObject("method", hit.Method, "url", hit.URL, "status", hit.Status, "userAgent", hit.UserAgent, "at", fixtureNumber(hit.At), "ip", hit.IP)
		}
		if found := AgentFetch(line, site, now); found != nil {
			fetched = js.NewObject("url", found.URL, "userAgent", found.UserAgent, "at", fixtureNumber(found.At))
			if found.IP != "" {
				fetched.(*js.Object).Set("ip", found.IP)
			}
		}
		if got, want := js.Stringify(parsed), js.Stringify(js.Dig(c, "parsed")); got != want {
			t.Errorf("parse %q (%q):\n got %s\nwant %s", line, site, got, want)
		}
		if got, want := js.Stringify(fetched), js.Stringify(js.Dig(c, "fetched")); got != want {
			t.Errorf("fetch %q (%q):\n got %s\nwant %s", line, site, got, want)
		}
	}
}

// fixtureNumber is a number as the fixture writes it, which spells out the ones JSON cannot hold.
func fixtureNumber(n float64) any {
	switch {
	case math.IsNaN(n):
		return "NaN"
	case math.IsInf(n, 1):
		return "Infinity"
	case math.IsInf(n, -1):
		return "-Infinity"
	}
	return n
}

const gptbot = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)"

func logLine(path string) string {
	return `203.0.113.9 - - [07/Oct/2026:13:55:36 -0400] "GET ` + path + ` HTTP/1.1" 200 5120 "-" "` + gptbot + `"`
}

// observed is a Runlight that takes every batch and keeps what it was sent.
type observed struct{ urls []string }

func (o *observed) Fetch(_ context.Context, _ string, init web.FetchInit) (*web.Response, error) {
	body, _ := js.Parse(string(init.Body))
	for _, f := range js.Arr(js.Dig(body, "fetches")) {
		o.urls = append(o.urls, js.Str(js.Dig(f, "url")))
	}
	return web.JSONResponse(js.NewObject("recorded", len(js.Arr(js.Dig(body, "fetches")))), 200), nil
}

func TestARunCarriesOnWhereTheLastStopped(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "access.log")
	state := filepath.Join(dir, "agents.json")
	sink := &observed{}
	run := func() float64 {
		t.Helper()
		n, err := RunAgents(context.Background(), AgentsOptions{Log: log, To: "https://stats.example.com", Key: "rlo_x", Site: "https://example.com", State: state, Out: func(string) {}, Fetcher: sink})
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	write := func(lines ...string) {
		if err := os.WriteFile(log, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(logLine("/a"), logLine("/b.png"), logLine("/c"))
	if n := run(); n != 3 {
		t.Fatalf("first run sent %v", n)
	}
	if n := run(); n != 0 {
		t.Fatalf("nothing new, but sent %v", n)
	}
	file, _ := os.OpenFile(log, os.O_APPEND|os.O_WRONLY, 0)
	file.WriteString(logLine("/d") + "\n")
	file.Close()
	if n := run(); n != 1 {
		t.Fatalf("one new line, sent %v", n)
	}
	// Rotated by renaming: the new log is read from its start.
	if err := os.Rename(log, log+".1"); err != nil {
		t.Fatal(err)
	}
	write(logLine("/e"))
	if n := run(); n != 1 {
		t.Fatalf("a rotated log sent %v", n)
	}
	// Copied and truncated: the same file with a new start, already longer than the old place.
	write(logLine("/two"), logLine("/three"))
	if n := run(); n != 2 {
		t.Fatalf("a truncated log sent %v", n)
	}
	if got := strings.Join(sink.urls, " "); got != "https://example.com/a https://example.com/b.png https://example.com/c https://example.com/d https://example.com/e https://example.com/two https://example.com/three" {
		t.Fatal(got)
	}
	if _, err := os.Stat(state + ".lock"); !os.IsNotExist(err) {
		t.Fatal("the lock was left behind")
	}
}

// The address a fetch came from goes with it to /api/observe, for the agent's published list; Caddy's
// client_ip (after its trusted proxies) comes before remote_ip, and a line with neither sends none.
func TestAFetchCarriesTheAddressItCameFrom(t *testing.T) {
	caddy := func(request string) string {
		return `{"ts":1791395736,"status":200,"request":{"method":"GET","host":"example.com","uri":"/","headers":{"User-Agent":["` + gptbot + `"]}` + request + `}}`
	}
	for line, want := range map[string]string{
		logLine("/"): "203.0.113.9",
		`example.com:443 2001:db8::1 - - [07/Oct/2026:13:55:36 -0400] "GET / HTTP/1.1" 200 5120 "-" "` + gptbot + `"`: "2001:db8::1",
		caddy(`,"client_ip":"198.51.100.7","remote_ip":"10.0.0.1"`):                                                   "198.51.100.7",
		caddy(`,"remote_ip":"10.0.0.1"`): "10.0.0.1",
		caddy(``):                        "",
	} {
		found := AgentFetch(line, "https://example.com", 0)
		if found == nil || found.IP != want {
			t.Errorf("%s: %+v, want %q", line, found, want)
			continue
		}
		sent := js.Stringify(found)
		if has := strings.Contains(sent, `"ip"`); has != (want != "") {
			t.Errorf("%s: sent as %s", line, sent)
		}
	}
}

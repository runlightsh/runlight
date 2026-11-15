package runlight

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"runlight.sh/go/internal/assets"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/web"
)

// keepDb takes every write and remembers the events, and answers the settings it was given.
type keepDb struct {
	mu       sync.Mutex
	events   [][]any
	settings map[string]string
}

func (*keepDb) Dialect() string { return "sqlite" }
func (d *keepDb) All(_ context.Context, sql string, params ...any) ([]Row, error) {
	if strings.Contains(sql, "FROM rl_settings") && len(params) > 0 {
		if value, ok := d.settings[str(params[0])]; ok {
			return []Row{{"value": value}}, nil
		}
	}
	return nil, nil
}
func (d *keepDb) Run(_ context.Context, sql string, params ...any) error {
	if strings.Contains(sql, "INSERT INTO rl_events") {
		d.mu.Lock()
		d.events = append(d.events, params)
		d.mu.Unlock()
	}
	return nil
}

const gptBot = "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"

func agentFetch(url, remote string, headers ...string) *Request {
	req := web.NewRequest("GET", url, web.NewHeaders(append([]string{"user-agent", gptBot}, headers...)...), nil)
	req.RemoteAddress = remote
	return req
}

// A fetch seen as it happens is limited per address at ten times the tracker's limit; a reported one is not.
func TestAgentFetchesSeenLiveAreLimitedPerAddress(t *testing.T) {
	db := &keepDb{}
	r, err := New(Options{Store: NewStore(db), Site: &SiteOptions{Hostnames: []string{"example.com"}}, RateLimit: ptr(1), Now: func() int64 { return 1_700_000_000_000 }, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for i := range 10 {
		if !r.Observe(ctx, agentFetch("https://example.com/", "203.0.113.5"), nil) {
			t.Fatalf("fetch %d was not recorded", i+1)
		}
	}
	if r.Observe(ctx, agentFetch("https://example.com/", "203.0.113.5"), nil) {
		t.Error("the eleventh fetch in a minute was recorded")
	}
	if !r.Observe(ctx, agentFetch("https://example.com/", "203.0.113.6"), nil) {
		t.Error("another address was held to the first one's count")
	}
	for range 20 {
		if !r.ObserveReport(ctx, agentFetch("https://example.com/", "203.0.113.5"), nil, "") {
			t.Fatal("a reported fetch was limited")
		}
	}
	// With the tracker's limit off, so is this one.
	open, _ := New(Options{Store: NewStore(&keepDb{}), Site: &SiteOptions{Hostnames: []string{"example.com"}}, RateLimit: ptr(0), Logf: func(string, ...any) {}})
	for range 30 {
		if !open.Observe(ctx, agentFetch("https://example.com/", "203.0.113.5"), nil) {
			t.Fatal("a fetch was limited with the limit off")
		}
	}
}

// The host a proxy names counts only from a proxy that is believed, and is what the fetch is kept under.
func TestAFetchIsKeptUnderTheHostAProxyNamedOnlyWhenTheProxyIsBelieved(t *testing.T) {
	db := &keepDb{}
	r, err := New(Options{Store: NewStore(db), Site: &SiteOptions{Hostnames: []string{"example.com"}}, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if !r.Observe(ctx, agentFetch("http://127.0.0.1:8080/page", "10.0.0.2", "x-forwarded-host", "www.Example.com:8443, inner.local"), nil) {
		t.Fatal("a fetch through a proxy on a private address was not recorded")
	}
	if got := db.events[0][7]; got != "example.com" {
		t.Errorf("kept under %v, want example.com", got)
	}
	if r.Observe(ctx, agentFetch("http://127.0.0.1:8080/page", "8.8.8.8", "x-forwarded-host", "example.com"), nil) {
		t.Error("a forwarded host from a public address was believed")
	}
}

// A logged user agent with a line break or letters no header takes is recorded, given as text.
func TestAReportedFetchTakesItsUserAgentAsText(t *testing.T) {
	db := &keepDb{}
	r, err := New(Options{Store: NewStore(db), Site: &SiteOptions{Hostnames: []string{"example.com"}}, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	req := web.NewRequest("GET", "https://example.com/page", nil, nil)
	if !r.ObserveReportAs(context.Background(), req, nil, "", "Mozilla/5.0 (compatible; GPTBot/1.2)\nX: y 日本") {
		t.Fatal("not recorded")
	}
	// The text stands in for the header.
	other := web.NewRequest("GET", "https://example.com/page", web.NewHeaders("user-agent", gptBot), nil)
	if r.ObserveReportAs(context.Background(), other, nil, "", "curl/8.0") {
		t.Error("the header counted over the text given")
	}
}

// A downloaded list stands in for the one that came with this version only while it is the newer of the two.
func TestADownloadedAddressListIsUsedOnlyWhileNewerThanTheOneShipped(t *testing.T) {
	url := assets.AgentRangeOrder[0]
	shipped, ok := dateParse(assets.AgentRanges.FetchedAt)
	if !ok {
		t.Fatal("the shipped lists have no date")
	}
	use := func(stored string) int {
		db := &keepDb{settings: map[string]string{"agent-ranges": stored}}
		r, err := New(Options{Store: NewStore(db), Logf: func(string, ...any) {}})
		if err != nil {
			t.Fatal(err)
		}
		r.refreshAgentRanges(context.Background())
		return len((*r.agentRanges.Load())[url])
	}
	bundled := len(bundledRanges[url])
	if bundled < 2 {
		t.Fatalf("the shipped list has %d prefixes", bundled)
	}
	one := `"lists":{"` + url + `":["198.51.100.0/24"]}`
	if got := use(`{"at":` + js.FormatNumber(shipped+1) + `,` + one + `,"fetched":{"` + url + `":` + js.FormatNumber(shipped-1) + `}}`); got != bundled {
		t.Errorf("a list downloaded before the shipped one: %d prefixes in use, want the shipped %d", got, bundled)
	}
	if got := use(`{"at":1,` + one + `,"fetched":{"` + url + `":` + js.FormatNumber(shipped) + `}}`); got != 1 {
		t.Errorf("a list downloaded since: %d prefixes in use, want 1", got)
	}
	// A copy saved before each list's time was kept has only the one time, for all of them.
	if got := use(`{"at":` + js.FormatNumber(shipped+1) + `,` + one + `}`); got != 1 {
		t.Errorf("a copy with only at, newer: %d prefixes in use, want 1", got)
	}
	if got := use(`{"at":` + js.FormatNumber(shipped-1) + `,` + one + `}`); got != bundled {
		t.Errorf("a copy with only at, older: %d prefixes in use, want %d", got, bundled)
	}
}

// Collect never fails its caller: a hit the store could not take is logged.
func TestCollectNeverFails(t *testing.T) {
	var logged atomic.Int64
	r, err := New(Options{Store: NewStore(brokenDb{}), Logf: func(format string, _ ...any) {
		if strings.HasPrefix(format, "Runlight: could not record an event") {
			logged.Add(1)
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	req := web.NewRequest("POST", "https://example.com/runlight/e", web.NewHeaders("user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"), []byte(`{"k":"pageview","u":"https://example.com/"}`))
	if err := r.Collect(context.Background(), req); err != nil {
		t.Fatalf("got %v", err)
	}
	if logged.Load() != 1 {
		t.Fatalf("logged %d times, want 1", logged.Load())
	}
}

func TestAForwardedAddressLosesItsPort(t *testing.T) {
	for given, want := range map[string]string{
		"203.0.113.7:51234":      "203.0.113.7",
		"203.0.113.7":            "203.0.113.7",
		"[2001:db8::1]:443":      "2001:db8::1",
		"[2001:db8::1]":          "2001:db8::1",
		"2001:db8::1":            "2001:db8::1",
		"[2001:db8::1]:https":    "[2001:db8::1]:https",
		"[2001:db8::1] and more": "[2001:db8::1] and more",
		"203.0.113.7:":           "203.0.113.7:",
	} {
		if got := bareAddress(given); got != want {
			t.Errorf("%s: got %s, want %s", given, got, want)
		}
	}
}

// The link tags of a page are found as /<link\b[^<>]{0,4000}>/gi finds them.
func TestLinkTagsAreBounded(t *testing.T) {
	long := strings.Repeat("x", 4001)
	html := `<LINK rel="icon" href="/a.png"><link ` + long + `><link a <link rel=icon href=/b.png><linked x><link` + strings.Repeat("y", 3999) + ` ><link>`
	got := linkTags(html)
	want := []string{`<LINK rel="icon" href="/a.png">`, `<link rel=icon href=/b.png>`, `<link>`}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("got %d tags: %.200q", len(got), got)
	}
	if got := linkTags(`<link ` + strings.Repeat("x", 3999) + `>`); len(got) != 1 {
		t.Errorf("a tag of 4,000 characters: %d found", len(got))
	}
	if links := IconLinks(strings.Repeat("<link ", 50_000), "https://example.com/"); len(links) != 0 {
		t.Errorf("a page of unclosed tags gave %d links", len(links))
	}
}

// An unusual method is the app's: no route or link answers it, and it is never an error.
func TestUnusualMethodsGoToTheApp(t *testing.T) {
	r, err := New(Options{Store: NewStore(brokenDb{}), Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	routes, err := r.Routes(RoutesOptions{Token: ptr("a-long-random-token-for-tests")})
	if err != nil {
		t.Fatal(err)
	}
	app := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("the app")) })
	for name, handler := range map[string]http.Handler{"LinkDomains": r.LinkDomains(app), "Middleware": routes.Middleware(app), "LinksHTTPOr": r.LinksHTTPOr(app)} {
		for _, method := range []string{"TRACE", "TRACK", "CONNECT"} {
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(method, "https://example.com/runlight/api/stats", nil))
			if w.Code != 200 || w.Body.String() != "the app" {
				t.Errorf("%s %s: %d %s", name, method, w.Code, w.Body.String())
			}
		}
	}
	w := httptest.NewRecorder()
	routes.ServeHTTP(w, httptest.NewRequest("TRACE", "https://example.com/runlight/api/stats", nil))
	if w.Code != 405 {
		t.Errorf("the routes alone: %d", w.Code)
	}
}

// Five tries, then a lock that starts at the fifth and is longer each time, up to a day.
func TestALockoutLocksForLongerEachTime(t *testing.T) {
	const minute = int64(60_000)
	l := NewLockout(5, 0, 0, 0)
	now := int64(1_700_000_000_000)
	locks := []int64{15, 30, 60, 120, 240, 480, 960, 1440, 1440}
	for round, length := range locks {
		for try := range 5 {
			if !l.Take("account", now) {
				t.Fatalf("round %d: try %d was refused", round+1, try+1)
			}
		}
		if l.Take("account", now) || l.Take("account", now+length*minute-1) {
			t.Fatalf("round %d: a try was taken while locked", round+1)
		}
		if !l.Take("other", now) {
			t.Fatal("another key was locked too")
		}
		l.Clear("other")
		now += length * minute
	}
	// Before the fifth try, the count starts again fifteen minutes after the first.
	fresh := NewLockout(5, 0, 0, 0)
	for range 4 {
		fresh.Take("a", now)
	}
	for range 4 {
		if !fresh.Take("a", now+15*minute) {
			t.Fatal("the count did not start again")
		}
	}
	// A right code clears the key.
	fresh.Take("a", now+15*minute)
	if fresh.Take("a", now+15*minute) {
		t.Fatal("not locked at the fifth try")
	}
	fresh.Clear("a")
	if !fresh.Take("a", now+15*minute) {
		t.Fatal("still locked after a right code")
	}
	// A key with no try for a week after its lock ended is forgotten, lock length and all.
	old := NewLockout(5, 0, 0, 0)
	for range 5 {
		old.Take("a", now)
	}
	later := now + 15*minute + 7*86_400_000
	for range 5 {
		old.Take("a", later)
	}
	if old.Take("a", later+15*minute-1) || !old.Take("a", later+15*minute) {
		t.Fatal("the second lock was not fifteen minutes again")
	}
}

func TestWhatAnImportKeepsOfItsColumns(t *testing.T) {
	for _, c := range []struct {
		name string
		fn   func(string) string
		in   string
		want string
	}{
		{"browser", browserName, "chrome", "Chrome"},
		{"browser", browserName, " my browser ", "My browser"},
		{"browser", browserName, "Mozilla/5.0 (X11; Linux x86_64)", ""},
		{"browser", browserName, "203.0.113.7", ""},
		{"browser", browserName, "9lives", ""},
		{"browser", browserName, "client 203.0.113.7", ""},
		{"browser", browserName, strings.Repeat("a", 41), ""},
		{"system", systemName, "mac os x", "macOS"},
		{"system", systemName, "Haiku", "Haiku"},
		{"system", systemName, "fe80::1", ""},
		{"place", placeName, "Paris", "Paris"},
		{"place", placeName, "203.0.113.7", ""},
		{"place", placeName, "at 203.0.113.7 today", ""},
		{"place", placeName, "1.2.3.4.5", "1.2.3.4.5"},
		{"place", placeName, "x1.2.3.4", ""},
		{"place", placeName, "2001:db8::1", ""},
		{"place", placeName, "Chrome/129.0", ""},
		{"place", placeName, "AppleWebKit", ""},
		{"screen", screenSize, " 1440x900 ", "1440x900"},
		{"screen", screenSize, "1440 x 900", ""},
		{"screen", screenSize, "123456x1", ""},
		{"language", languageTag, " pt-BR ", "pt-BR"},
		{"language", languageTag, "zh_Hant_TW", "zh_Hant_TW"},
		{"language", languageTag, "english", ""},
	} {
		if got := c.fn(c.in); got != c.want {
			t.Errorf("%s %q: got %q, want %q", c.name, c.in, got, c.want)
		}
	}
	for host, want := range map[string]bool{"example.com": true, "example.com:8080": true, "a b": false, "": false, "example.com/x": false, "user@example.com": false, `a\b`: false, "a?b": false, "a#b": false} {
		if got := validHost(host); got != want {
			t.Errorf("host %q: got %v", host, got)
		}
	}
}

// A CSV row from before 2000 has no time: a date written 20240501 is no Unix time.
func TestACsvRowBefore2000HasNoTime(t *testing.T) {
	if ts := rowTime(map[string]string{"time": "20240501"}, "runlight"); !math.IsNaN(ts) {
		t.Errorf("20240501 read as %v", ts)
	}
	if ts := rowTime(map[string]string{"time": "1999-12-31T23:59:59Z"}, "runlight"); !math.IsNaN(ts) {
		t.Errorf("1999 read as %v", ts)
	}
	if ts := rowTime(map[string]string{"created_at": "2000-01-01 00:00:00"}, "umami"); ts != 946_684_800_000 {
		t.Errorf("the start of 2000 read as %v", ts)
	}
}

// Text is kept without U+0000 and cut by character, so an emoji is never cut in half.
func TestStoredTextIsCleaned(t *testing.T) {
	if got := cleanText("a\x00b", 500); got != "ab" {
		t.Errorf("got %q", got)
	}
	value := strings.Repeat("x", 499) + "\U0001F600" + "y"
	if got := cleanText(value, 500); got != strings.Repeat("x", 499)+"\U0001F600" {
		t.Errorf("cut to %d bytes", len(got))
	}
	p := ParsePayload(`{"k":"event","u":"https://example.com/?utm_source=a%00b","n":" sign\u0000up ","t":"a\ud83db","p":{" \u0000 ":"skipped","key\u0000":"v\u0000"}}`)
	if p == nil {
		t.Fatal("no payload")
	}
	if p.Name != "signup" || p.Title != "a�b" || js.Stringify(p.Props) != `{"key":"v"}` {
		t.Errorf("name %q, title %q, props %s", p.Name, p.Title, js.Stringify(p.Props))
	}
	if page := ParsePage(p.URL); page.Utm.Source != "ab" {
		t.Errorf("utm_source %q", page.Utm.Source)
	}
}

// A user agent is read no further than 512 characters, and Safari's version takes no time to find.
func TestAUserAgentIsReadOnlySoFar(t *testing.T) {
	pad := strings.Repeat("a", 520)
	if AiAgentOf(pad+" GPTBot/1.2") != nil {
		t.Error("an agent's name past the cap was seen")
	}
	if !IsBot(strings.Repeat(" ", 520) + "Mozilla/5.0 Chrome/129") {
		t.Error("a browser named past the cap was read")
	}
	for _, ua := range []string{"Mozilla/5.0 Version/18 Safari/605", "Mozilla/5.0 Version/18.1.1 Safari/605", "Mozilla/5.0 Version/18.1 Mobile/15E148 Safari/604"} {
		if c := ParseClient(ua, ClientHints{}, nil); c.Browser != "Safari" || c.BrowserVersion != "18" {
			t.Errorf("%s: %s %s", ua, c.Browser, c.BrowserVersion)
		}
	}
	brands := strings.Repeat(" ", 520) + `"Brave"`
	if c := ParseClient("Mozilla/5.0 Chrome/129.0", ClientHints{Brands: &brands}, nil); c.Browser != "Chrome" {
		t.Errorf("a brand past the cap was read: %s", c.Browser)
	}
}

// An address over 320 characters is refused before the pattern reads it.
func TestAnEmailTooLongIsNoEmail(t *testing.T) {
	if !emailPattern.MatchString(strings.Repeat("a", 308) + "@example.com") {
		t.Error("320 characters refused")
	}
	if emailPattern.MatchString(strings.Repeat("a", 309) + "@example.com") {
		t.Error("321 characters taken")
	}
}

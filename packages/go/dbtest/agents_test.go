package dbtest

import (
	"context"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	runlight "runlight.sh/go"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/web"
)

const (
	gptbotUA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)"
	metaUA   = "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)"
)

// agentRequest is a page request from ua, forwarded for ip when it is not "".
func agentRequest(ua, ip string) *runlight.Request {
	headers := web.NewHeaders("user-agent", ua, "host", "example.com")
	if ip != "" {
		headers.Set("x-forwarded-for", ip)
	}
	return web.NewRequest("GET", "https://example.com/post", headers, nil)
}

func agentRows(t *testing.T, ctx context.Context, routes *runlight.Routes) string {
	t.Helper()
	r := routes.Handle(ctx, web.NewRequest("GET", "https://example.com/runlight/api/breakdown?period=today&dimension=ai_agent", web.NewHeaders("authorization", "Bearer t"), nil))
	v, _ := js.Parse(string(r.Body))
	return js.Stringify(js.Dig(v, "rows"))
}

func fetchTitles(t *testing.T, ctx context.Context, store *runlight.Store) []string {
	t.Helper()
	rows, err := store.DB().All(ctx, "SELECT title FROM rl_events WHERE kind = 'fetch'")
	if err != nil {
		t.Fatal(err)
	}
	titles := []string{}
	for _, row := range rows {
		titles = append(titles, js.String(row["title"]))
	}
	slices.Sort(titles)
	return titles
}

func TestAnAIAgentsAddressIsCheckedAgainstItsCompanysListAndOnlyTheAnswerIsKept(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			ctx := context.Background()
			store := Store(t, kind)
			rl, err := runlight.New(runlight.Options{Store: store, Site: &runlight.SiteOptions{}, Logf: func(string, ...any) {}})
			if err != nil {
				t.Fatal(err)
			}
			token := "t"
			routes, err := rl.Routes(runlight.RoutesOptions{Token: &token})
			if err != nil {
				t.Fatal(err)
			}
			rl.Observe(ctx, agentRequest(gptbotUA, "20.171.206.17"), nil) // in OpenAI's published GPTBot list
			rl.Observe(ctx, agentRequest(gptbotUA, "20.171.206.18"), nil)
			rl.Observe(ctx, agentRequest(gptbotUA, "198.51.100.23"), nil) // says GPTBot, comes from elsewhere
			rl.Observe(ctx, agentRequest(gptbotUA, ""), nil)              // no address to check
			rl.Observe(ctx, agentRequest(metaUA, "157.240.0.1"), nil)     // Meta publishes no list
			// A log reader's or plugin's report names the agent's address itself; it never stands in for the reporter's.
			rl.ObserveReport(ctx, agentRequest(gptbotUA, "198.51.100.40"), nil, "20.171.206.99")
			rl.ObserveReport(ctx, agentRequest(gptbotUA, "20.171.206.40"), nil, "")

			want := `[{"value":"GPTBot","visitors":0,"fetches":3,"claimed":false},{"value":"GPTBot","visitors":0,"fetches":3,"claimed":true},{"value":"meta-externalagent","visitors":0,"fetches":1,"claimed":true}]`
			if got := agentRows(t, ctx, routes); got != want {
				t.Errorf("breakdown:\n got %s\nwant %s", got, want)
			}
			if got := fetchTitles(t, ctx, store); !slices.Equal(got, []string{"", "", "", "mismatch", "verified", "verified", "verified"}) {
				t.Errorf("titles %q", got)
			}
			rows, err := store.DB().All(ctx, "SELECT * FROM rl_events")
			if err != nil {
				t.Fatal(err)
			}
			dump := js.Stringify(rows)
			for _, ip := range []string{"20.171.206.17", "198.51.100.23", "157.240.0.1", "198.51.100.40", "20.171.206.99", "20.171.206.40"} {
				if strings.Contains(dump, ip) {
					t.Errorf("the address %s is kept", ip)
				}
			}
		})
	}
}

// fakeLists answers every download from a function and counts what was asked.
type fakeLists struct {
	mu     sync.Mutex
	asked  []string
	answer func(url string) *web.Response
}

func (f *fakeLists) Fetch(_ context.Context, url string, init web.FetchInit) (*web.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked = append(f.asked, url)
	if init.Headers.Get("user-agent") != "Runlight (+https://runlight.sh)" || init.Redirect != "follow" || init.Timeout != 15*time.Second || init.MaxBytes != 4_000_000 {
		return nil, &web.FetchError{Message: "not asked as the SDK asks"}
	}
	return f.answer(url), nil
}

func (f *fakeLists) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.asked)
}

func TestUpdateAgentRangesDownloadsTheListsOnceADayKeepsAGoodCopyOverABadDownloadAndSharesItThroughTheDatabase(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			ctx := context.Background()
			now := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC).UnixMilli()
			clock := func() int64 { return now }
			lists := &fakeLists{answer: func(string) *web.Response {
				return web.JSONResponse(js.NewObject("prefixes", []any{js.NewObject("ipv4Prefix", "192.0.2.0/24")}), 200)
			}}
			store := Store(t, kind)
			rl, err := runlight.New(runlight.Options{Store: store, Site: &runlight.SiteOptions{}, UpdateAgentRanges: true, Now: clock, Fetcher: lists, Logf: func(string, ...any) {}})
			if err != nil {
				t.Fatal(err)
			}
			from := func(r *runlight.Runlight, ip string) { r.Observe(ctx, agentRequest(gptbotUA, ip), nil) }
			check := func(r *runlight.Runlight) {
				t.Helper()
				if _, err := r.Check(ctx); err != nil {
					t.Fatal(err)
				}
			}
			check(rl)
			if !slices.Contains(lists.asked, "https://openai.com/gptbot.json") {
				t.Fatalf("asked %v", lists.asked)
			}
			firstRound := lists.count()
			from(rl, "192.0.2.7")     // in the downloaded list
			from(rl, "20.171.206.17") // in the bundled list only, which the download replaced
			now += 3_600_000
			check(rl)
			if lists.count() != firstRound {
				t.Errorf("asked again within the day: %d", lists.count())
			}

			now += 86_400_000
			lists.answer = func(string) *web.Response { return web.NewResponse(200, []byte("<html>maintenance</html>")) }
			check(rl)
			if lists.count() != firstRound*2 {
				t.Errorf("a day later: %d asks, want %d", lists.count(), firstRound*2)
			}
			from(rl, "192.0.2.8") // the bad download kept the good copy

			// Another process sharing the database uses the lists without downloading them.
			other, err := runlight.New(runlight.Options{Store: store, Site: &runlight.SiteOptions{}, Now: clock, Fetcher: lists, Logf: func(string, ...any) {}})
			if err != nil {
				t.Fatal(err)
			}
			check(other)
			if lists.count() != firstRound*2 {
				t.Errorf("the other process downloaded: %d", lists.count())
			}
			from(other, "192.0.2.9")

			if got := fetchTitles(t, ctx, store); !slices.Equal(got, []string{"mismatch", "verified", "verified", "verified"}) {
				t.Errorf("titles %q", got)
			}
		})
	}
}

func TestWithoutUpdateAgentRangesRunlightNeverDownloadsTheLists(t *testing.T) {
	ctx := context.Background()
	lists := &fakeLists{answer: func(string) *web.Response { return web.NewResponse(200, []byte("{}")) }}
	rl, err := runlight.New(runlight.Options{Store: Store(t, Kinds()[0]), Site: &runlight.SiteOptions{}, Fetcher: lists, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rl.Check(ctx); err != nil {
		t.Fatal(err)
	}
	if lists.count() != 0 {
		t.Errorf("asked %v", lists.asked)
	}
	// Without a download the bundled lists are what the check uses.
	rl.Observe(ctx, agentRequest(gptbotUA, "20.171.206.17"), nil)
	rl.Observe(ctx, agentRequest(gptbotUA, "192.0.2.7"), nil)
	if got := fetchTitles(t, ctx, rl.Store); !slices.Equal(got, []string{"mismatch", "verified"}) {
		t.Errorf("titles %q", got)
	}
}

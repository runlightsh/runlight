package runlight

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"runlight.sh/go/internal/web"
)

// A panic in work running beside the requests is logged, never left to end the app.
func TestWorkAfterAnAnswerSurvivesAPanic(t *testing.T) {
	var logged atomic.Int64
	r := &Runlight{logf: func(string, ...any) { logged.Add(1) }}
	r.later(func(context.Context) { panic("a mailer that fell over") })
	r.prune(func(context.Context) error { panic("a database that fell over") })
	r.Idle()
	if got := logged.Load(); got != 2 {
		t.Fatalf("%d panics logged, want 2", got)
	}
	// The lock retention takes is free again.
	if !r.pruneMu.TryLock() {
		t.Fatal("retention's lock is still held")
	}
	r.pruneMu.Unlock()
}

// Reads run side by side hand a panic back as an error, as a panic in the request itself becomes one.
func TestReadsSideBySideTurnAPanicIntoAnError(t *testing.T) {
	err := sideBySide(
		func() error { return nil },
		func() error { panic("a database that fell over") },
	)
	if err == nil || !strings.Contains(err.Error(), "panic: a database that fell over") {
		t.Fatalf("got %v", err)
	}
}

// saltPanicDb takes everything, and panics on the salts, which the scheduled check reads after Init.
type saltPanicDb struct{}

func (saltPanicDb) Dialect() string { return "sqlite" }
func (saltPanicDb) All(_ context.Context, sql string, _ ...any) ([]Row, error) {
	if strings.Contains(sql, "rl_salts") {
		panic("a database that fell over")
	}
	return nil, nil
}
func (saltPanicDb) Run(_ context.Context, sql string, _ ...any) error {
	if strings.Contains(sql, "rl_salts") {
		panic("a database that fell over")
	}
	return nil
}

// The scheduled check runs on a goroutine of its own, where a panic would end the app: it is the check's error.
func TestTheScheduledCheckTurnsAPanicIntoAnError(t *testing.T) {
	r, err := New(Options{Store: NewStore(saltPanicDb{}), Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.Check(context.Background()); err == nil || !strings.Contains(err.Error(), "panic: a database that fell over") {
		t.Fatalf("got %v", err)
	}
	// And the next check runs, rather than waiting on the one that fell over.
	if _, err := r.Check(context.Background()); err == nil {
		t.Fatal("the second check did not run")
	}
}

// A site's icon is kept for everyone, so a request that went away while asking for it does not leave "no icon" behind.
func TestAnIconIsLookedUpEvenWhenItsRequestWentAway(t *testing.T) {
	was := web.Resolver
	defer func() { web.Resolver = was }()
	web.Resolver = func(context.Context, string) ([]string, error) { return []string{"93.184.216.34"}, nil }
	fetcher := web.FetchFunc(func(ctx context.Context, url string, _ FetchInit) (*Response, error) {
		if ctx.Err() != nil {
			return nil, &web.FetchError{Message: "fetch failed"}
		}
		if strings.HasSuffix(url, "/favicon.ico") {
			return web.NewResponse(200, []byte("icon"), "content-type", "image/x-icon"), nil
		}
		return web.NewResponse(404, nil), nil
	})
	gone, cancel := context.WithCancel(context.Background())
	cancel()
	icon := FetchIcon(gone, fetcher, "https://icon-for-a-request-that-went-away.example", 1_700_000_000_000)
	if icon == nil || string(icon.Body) != "icon" {
		t.Fatalf("got %v", icon)
	}
}

// downDb fails every query, and counts them.
type downDb struct{ asked *atomic.Int64 }

func (downDb) Dialect() string { return "sqlite" }
func (d downDb) All(context.Context, string, ...any) ([]Row, error) {
	d.asked.Add(1)
	return nil, errors.New("down")
}
func (d downDb) Run(context.Context, string, ...any) error {
	d.asked.Add(1)
	return errors.New("down")
}

// The link domains are looked up on every request of the app, so a database that is down never fails the app:
// its pages are served, and the database is left alone for a few seconds before it is asked again.
func TestTheAppIsServedWhileTheDatabaseIsDown(t *testing.T) {
	var asked atomic.Int64
	now := int64(1_700_000_000_000)
	r, err := New(Options{Store: NewStore(downDb{&asked}), Now: func() int64 { return now }, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	app := r.LinkDomains(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("the app")) }))
	get := func() {
		t.Helper()
		w := httptest.NewRecorder()
		app.ServeHTTP(w, httptest.NewRequest("GET", "https://example.com/about", nil))
		if w.Code != 200 || w.Body.String() != "the app" {
			t.Fatalf("the app's page: %d %s", w.Code, w.Body.String())
		}
	}
	get()
	first := asked.Load()
	if first == 0 {
		t.Fatal("the database was never asked")
	}
	get()
	now += linkDomainsFailedMs - 1
	get()
	if got := asked.Load(); got != first {
		t.Fatalf("the database was asked again within the wait: %d queries, then %d", first, got)
	}
	now++
	get()
	if got := asked.Load(); got == first {
		t.Fatal("the database was not asked again after the wait")
	}
}

// A link domain known before the database went down is still not the app's, so its paths do not reach the app.
func TestALinkDomainKnownBeforeAnOutageStaysOne(t *testing.T) {
	var asked atomic.Int64
	now := int64(1_700_000_000_000)
	r, err := New(Options{Store: NewStore(downDb{&asked}), Now: func() int64 { return now }, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	r.linkDomains = &linkDomainCache{at: now - 60_000, domains: map[string]bool{"go.example.com": true}}
	if got := r.linkDomainSet(context.Background()); !got["go.example.com"] {
		t.Fatalf("got %v", got)
	}
}

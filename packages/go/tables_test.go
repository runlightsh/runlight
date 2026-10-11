package runlight

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"runlight.sh/go/internal/web"
)

// busyTables is a database with nothing in it that takes every write, whose lock for creating tables
// another process holds: each Exclusive waits until the test sends it nil to go ahead or an error to give up.
type busyTables struct {
	release chan error
	mu      sync.Mutex
	written []string
}

func (*busyTables) Dialect() string { return "sqlite" }
func (*busyTables) All(context.Context, string, ...any) ([]Row, error) {
	return nil, nil
}
func (b *busyTables) Run(_ context.Context, sql string, _ ...any) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.written = append(b.written, sql)
	return nil
}
func (b *busyTables) Exclusive(ctx context.Context, fn func(Db) error) error {
	select {
	case err := <-b.release:
		if err != nil {
			return err
		}
		return fn(b)
	case <-ctx.Done():
		return ctx.Err()
	}
}

// counted reports whether a visit was written.
func (b *busyTables) counted() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, sql := range b.written {
		if strings.Contains(sql, "INTO rl_sessions") || strings.Contains(sql, "INTO rl_events") {
			return true
		}
	}
	return false
}

func TestATrackerHitWaitsAMomentAtMostWhileAnotherProcessCreatesTheTables(t *testing.T) {
	was := trackerWait
	trackerWait = 300 * time.Millisecond
	defer func() { trackerWait = was }()
	db := &busyTables{release: make(chan error)}
	rl, err := New(Options{Store: NewStore(db), Site: &SiteOptions{Hostnames: []string{"example.com"}}, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	token := "a-long-random-token-for-tests"
	routes, err := rl.Routes(RoutesOptions{Token: &token})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	hit := func() *Response {
		return routes.Handle(ctx, web.NewRequest("POST", "https://example.com/runlight/e", web.NewHeaders(
			"user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
			"x-forwarded-for", "203.0.113.1", "content-type", "text/plain"), []byte(`{"k":"pageview","u":"https://example.com/","i":"a1"}`)))
	}

	started := time.Now()
	if answer := hit(); answer.Status != 202 {
		t.Fatalf("the hit answered %d", answer.Status)
	}
	if waited := time.Since(started); waited < 300*time.Millisecond || waited > 3*time.Second {
		t.Errorf("the hit waited %v", waited)
	}
	if db.counted() {
		t.Error("the hit that came while the tables were busy was counted")
	}

	// The other process gives up the wait: the request that waited answers 503, saying why.
	asked := make(chan *Response)
	go func() {
		asked <- routes.Handle(ctx, web.NewRequest("GET", "https://example.com/runlight/api/stats?period=today", web.NewHeaders("authorization", "Bearer "+token), nil))
	}()
	// Given up again until the request is waiting on it, as it may not be yet when the first wait ends.
	var answer *Response
	for answer == nil {
		select {
		case db.release <- &TablesBusyError{LockWait}:
		case answer = <-asked:
		}
	}
	if answer.Status != 503 || answer.Header.Get("retry-after") != "30" {
		t.Errorf("answered %d, retry-after %q", answer.Status, answer.Header.Get("retry-after"))
	}
	if got := answer.Text(); got != `{"error":"Runlight is creating or upgrading its tables. Try again in a minute.","code":"tables_busy"}` {
		t.Errorf("answered %s", got)
	}

	// Once the tables are there, hits are counted again.
	trackerWait = 10 * time.Second
	counted := make(chan *Response)
	go func() { counted <- hit() }()
	db.release <- nil
	if answer := <-counted; answer.Status != 202 || !db.counted() {
		t.Errorf("answered %d, counted %v", answer.Status, db.counted())
	}
}

func TestTablesBusyErrorSaysHowLongItWaited(t *testing.T) {
	want := "Runlight: another process is creating or upgrading the tables, and had not finished after 30 seconds. Try again in a minute."
	if got := (&TablesBusyError{LockWait}).Error(); got != want {
		t.Errorf("got %s", got)
	}
	if got := (&TablesBusyError{1500 * time.Millisecond}).Error(); !strings.Contains(got, "after 2 seconds") {
		t.Errorf("got %s", got)
	}
}

package runlight

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
)

// Requests start work after the answer whenever they like, so Idle has to
// cope with new work arriving while it waits, which a WaitGroup cannot.
func TestLaterWhileIdleWaits(t *testing.T) {
	r := &Runlight{}
	var ran atomic.Int64
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 2000 {
				r.later(func(context.Context) { ran.Add(1) })
			}
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	for waiting := true; waiting; {
		select {
		case <-done:
			waiting = false
		default:
			r.Idle()
		}
	}
	r.Idle()
	if got := ran.Load(); got != 8*2000 {
		t.Fatalf("%d pieces of work ran, want %d", got, 8*2000)
	}
	r.busyMu.Lock()
	defer r.busyMu.Unlock()
	if r.busy != 0 {
		t.Fatalf("%d pieces of work still counted after Idle", r.busy)
	}
}

// stuckDb holds every query until open is closed, then has nothing.
type stuckDb struct{ open chan struct{} }

func (stuckDb) Dialect() string { return "sqlite" }
func (d stuckDb) All(context.Context, string, ...any) ([]Row, error) {
	<-d.open
	return nil, nil
}
func (d stuckDb) Run(context.Context, string, ...any) error {
	<-d.open
	return nil
}

// A crawler flooding a slow database gets a bounded number of recordings,
// and the rest are dropped rather than piling up.
func TestObserverDropsFetchesPastItsLimit(t *testing.T) {
	db := stuckDb{open: make(chan struct{})}
	r, err := New(Options{Store: NewStore(db), Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	passed := 0
	handler := r.Observer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { passed++ }))
	for range 3 * observerMax {
		req := httptest.NewRequest("GET", "https://example.com/", nil)
		req.Header.Set("user-agent", "Mozilla/5.0 (compatible; GPTBot/1.2)")
		handler.ServeHTTP(httptest.NewRecorder(), req)
	}
	if passed != 3*observerMax {
		t.Fatalf("%d requests passed on, want %d", passed, 3*observerMax)
	}
	r.busyMu.Lock()
	busy := r.busy
	r.busyMu.Unlock()
	if got := r.observing.Load(); got != observerMax || busy != observerMax {
		t.Fatalf("%d recording and %d running, want %d", got, busy, observerMax)
	}
	close(db.open)
	r.Idle()
	if got := r.observing.Load(); got != 0 {
		t.Fatalf("%d still recording after Idle", got)
	}
}

// brokenDb fails every query.
type brokenDb struct{}

func (brokenDb) Dialect() string { return "sqlite" }
func (brokenDb) All(context.Context, string, ...any) ([]Row, error) {
	return nil, errors.New("down")
}
func (brokenDb) Run(context.Context, string, ...any) error { return errors.New("down") }

func askRoutes() *Routes {
	r := &Runlight{now: func() int64 { return 1_700_000_000_000 }, turns: map[string]*turn{}, Store: NewStore(brokenDb{})}
	return &Routes{r: r, asked: map[string]*askCount{}}
}

// Questions asked at once are checked and counted together, so no more than
// askAtOnce of them get through.
func TestAskTurnCountsQuestionsAskedAtOnce(t *testing.T) {
	rt := askRoutes()
	var through atomic.Int64
	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			refused, _, err := rt.askTurn(context.Background(), "owner", true)
			if err == nil && refused == nil {
				through.Add(1)
			}
		}()
	}
	wg.Wait()
	if got := through.Load(); got != askAtOnce {
		t.Fatalf("%d questions at once got through, want %d", got, askAtOnce)
	}
}

// A viewer's question that the daily check does not let through gives its
// place back.
func TestAskTurnGivesBackARefusedQuestion(t *testing.T) {
	rt := askRoutes()
	for range askPerHour + 1 {
		if _, finish, err := rt.askTurn(context.Background(), "viewer", false); err == nil || finish != nil {
			t.Fatal("the daily check should have failed")
		}
	}
	mine := rt.asked["viewer"]
	if mine.open != 0 || len(mine.at) != 0 {
		t.Fatalf("%d open and %d this hour, want none", mine.open, len(mine.at))
	}
}

// A few password checks run at once and a short line waits; past that a check is refused as busy, never queued.
func TestPasswordChecksTakeTurns(t *testing.T) {
	ctx := context.Background()
	for range checking {
		checkSlots <- struct{}{}
	}
	release := make(chan struct{})
	var started sync.WaitGroup
	results := make(chan error, maxWaiting)
	for range maxWaiting {
		started.Add(1)
		go func() {
			started.Done()
			_, err := slot(ctx, func() bool { <-release; return true })
			results <- err
		}()
	}
	started.Wait()
	for {
		waitingMu.Lock()
		full := waiting == maxWaiting
		waitingMu.Unlock()
		if full {
			break
		}
		runtime.Gosched()
	}
	_, err := slot(ctx, func() bool { return true })
	var ae *AccountError
	if !asAccountError(err, &ae) || ae.Code != "busy" {
		t.Fatalf("a check past the line answered %v", err)
	}
	close(release)
	for range checking {
		<-checkSlots
	}
	for range maxWaiting {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if right, err := slot(ctx, func() bool { return true }); !right || err != nil {
		t.Fatalf("a check after the rush answered %v, %v", right, err)
	}
}

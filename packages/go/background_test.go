package runlight

import (
	"context"
	"errors"
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

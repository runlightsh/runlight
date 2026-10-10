package runlight

import (
	"context"
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

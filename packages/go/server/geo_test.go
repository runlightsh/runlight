package server

import (
	"context"
	"io"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestAFailedDownloadLeavesNothingAndIsTriedAgain(t *testing.T) {
	dir := t.TempDir()
	asked := []string{}
	lines := []string{}
	geo, err := NewGeo(dir, "city", func(line string) { lines = append(lines, line) }, func(_ context.Context, url string) (int, io.ReadCloser, error) {
		asked = append(asked, url)
		return 404, io.NopCloser(strings.NewReader("nope")), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := geo.Refresh(context.Background(), time.Date(2026, 10, 1, 3, 0, 0, 0, time.UTC).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	// Early in a month, last month's release stands in.
	want := []string{"https://download.db-ip.com/free/dbip-city-lite-2026-10.mmdb.gz", "https://download.db-ip.com/free/dbip-city-lite-2026-09.mmdb.gz"}
	if !reflect.DeepEqual(asked, want) {
		t.Fatal(asked)
	}
	if found, _ := geo.Lookup("8.8.8.8"); found != nil {
		t.Fatal(found)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatal(entries)
	}
	if err := geo.Refresh(context.Background(), time.Date(2026, 10, 1, 4, 0, 0, 0, time.UTC).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if len(asked) != 4 {
		t.Fatal("not tried again on the next check")
	}
	// A body that is not gzip is said once and leaves no partial file.
	geo.download = func(context.Context, string) (int, io.ReadCloser, error) {
		return 200, io.NopCloser(strings.NewReader("not gzip")), nil
	}
	if err := geo.Refresh(context.Background(), time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 || len(lines) != 2 {
		t.Fatal(entries, lines)
	}
}

// While the month's file cannot be had, each try waits twice as long as the last, from five minutes to six hours.
func TestDownloadsThatKeepFailingAreTriedLessAndLessOften(t *testing.T) {
	asked := 0
	geo, err := NewGeo(t.TempDir(), "country", nil, func(context.Context, string) (int, io.ReadCloser, error) {
		asked++
		return 404, io.NopCloser(strings.NewReader("nope")), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	const minute = int64(60_000)
	now := time.Date(2026, 10, 1, 3, 0, 0, 0, time.UTC).UnixMilli()
	tries := func(at int64) int {
		t.Helper()
		before := asked
		if err := geo.Refresh(context.Background(), at); err != nil {
			t.Fatal(err)
		}
		// Each try asks for this month's file and then last month's.
		return (asked - before) / 2
	}
	if tries(now) != 1 {
		t.Fatal("the first try was not made")
	}
	wait := 5 * minute
	for round := range 9 {
		if tries(now+wait-1) != 0 {
			t.Fatalf("round %d: tried again before %d minutes were up", round+1, wait/minute)
		}
		now += wait
		if tries(now) != 1 {
			t.Fatalf("round %d: not tried again after %d minutes", round+1, wait/minute)
		}
		wait = min(wait*2, 6*60*minute)
	}
	if wait != 6*60*minute {
		t.Fatalf("the wait ended at %d minutes", wait/minute)
	}
}

package runlight

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestACsvValueWithASemicolonOrATabIsQuotedSoNoLocaleSplitsAFormulaOutOfIt(t *testing.T) {
	got := CsvRow([]any{"x;=1+1", "a\tb", "=1+1", "plain"})
	if want := "\"x;=1+1\",\"a\tb\",'=1+1,plain"; got != want {
		t.Errorf("%q, want %q", got, want)
	}
}

// Amman in 2019, Gaza and Hebron in 2020, an hour each, and three hours at Casey station in 2019.
func TestADayWhereClocksFallBackAcrossMidnightBeginsAtTheFirstMidnight(t *testing.T) {
	for _, c := range [][2]string{{"2019-10-25", "Asia/Amman"}, {"2020-10-24", "Asia/Gaza"}, {"2020-10-24", "Asia/Hebron"}, {"2019-03-17", "Antarctica/Casey"}} {
		date, zone := c[0], c[1]
		if !IsTimezone(zone) {
			t.Skipf("no %s", zone)
		}
		start := StartOf(date, zone, 0)
		if got := LocalDate(start, zone); got != date {
			t.Errorf("%s: begins on %s, want %s", zone, got, date)
		}
		if before := LocalDate(start-1, zone); before >= date {
			t.Errorf("%s: the moment before is %s, not the day before", zone, before)
		}
	}
}

// Sites are kept by name as Node's localeCompare orders them, the order the assistant's models are in too.
func TestSitesAreSortedAsLocaleCompareSortsThem(t *testing.T) {
	names := func(sites []SiteRow) []string {
		out := make([]string, len(sites))
		for i, s := range sites {
			out[i] = s.Name
		}
		return out
	}
	for _, c := range []struct{ in, want []string }{
		{[]string{"äb", "Ab"}, []string{"Ab", "äb"}},
		{[]string{"éa", "Ea"}, []string{"Ea", "éa"}},
		{[]string{"a-b", "a_b"}, []string{"a_b", "a-b"}},
		{[]string{"fa", "éa"}, []string{"éa", "fa"}},
	} {
		sites := make([]SiteRow, len(c.in))
		for i, name := range c.in {
			sites[i] = SiteRow{ID: name, Name: name}
		}
		sortSites(sites)
		got := names(sites)
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%v sorted to %v, want %v", c.in, got, c.want)
				break
			}
		}
	}
}

// The audit of 2026-10-23.

func TestAFloodOfMadeUpNamesCannotResetTheCountOfOneCloseToItsLimit(t *testing.T) {
	throttle := NewThrottle(3, 0)
	now := int64(1_791_288_000_000)
	for range 2 {
		if !throttle.Take("target", now) {
			t.Fatal("the first two tries")
		}
	}
	for i := range 10_050 {
		throttle.Take(fmt.Sprintf("made-up-%d", i), now)
	}
	if !throttle.Take("target", now) {
		t.Error("the third try")
	}
	if throttle.Take("target", now) {
		t.Error("the target's earlier tries still count")
	}
	if n := len(throttle.failures); n > maxThrottled {
		t.Errorf("%d kept", n)
	}
}

// saltsDb keeps salts and nothing else, with no visit open.
type saltsDb struct{ salts map[string]string }

func (d *saltsDb) Dialect() string { return "sqlite" }

func (d *saltsDb) All(_ context.Context, sql string, params ...any) ([]Row, error) {
	if strings.HasPrefix(sql, "SELECT salt FROM rl_salts") {
		if salt, ok := d.salts[params[0].(string)]; ok {
			return []Row{{"salt": salt}}, nil
		}
	}
	return nil, nil
}

func (d *saltsDb) Run(_ context.Context, sql string, params ...any) error {
	switch {
	case strings.HasPrefix(sql, "INSERT INTO rl_salts"):
		if _, ok := d.salts[params[0].(string)]; !ok {
			d.salts[params[0].(string)] = params[1].(string)
		}
	case strings.HasPrefix(sql, "DELETE FROM rl_salts"):
		keep := map[string]bool{}
		for _, p := range params {
			keep[p.(string)] = true
		}
		for day := range d.salts {
			if !keep[day] {
				delete(d.salts, day)
			}
		}
	}
	return nil
}

func TestYesterdaysSaltLeavesMemoryWhenItLeavesTheStoreOnTheFirstHitAfterMidnight(t *testing.T) {
	ctx := context.Background()
	db := &saltsDb{salts: map[string]string{}}
	r, err := New(Options{Store: NewStore(db), Site: &SiteOptions{Hostnames: []string{"example.com"}, Timezone: "UTC"}, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	noon := int64(1_791_288_000_000)
	if _, err := r.currentSalts(ctx, noon, "UTC"); err != nil {
		t.Fatal(err)
	}
	got, err := r.currentSalts(ctx, noon+13*3_600_000, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	cached := r.salts["UTC"]
	if got.day != "2026-10-07" || cached.day != "2026-10-07" {
		t.Errorf("day %s, cached %s", got.day, cached.day)
	}
	if got.hasYest || cached.hasYest || cached.yesterday != "" {
		t.Errorf("no visit was left open, so yesterday's salt is gone from here too: %+v", cached)
	}
	if _, kept := db.salts["2026-10-06"]; kept {
		t.Error("and from the store")
	}
}

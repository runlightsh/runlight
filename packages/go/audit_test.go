package runlight

import "testing"

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

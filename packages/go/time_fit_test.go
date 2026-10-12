package runlight

import "testing"

// An interval too fine for a long range moves up to one that fits, and no bucket takes in the rest.
func TestAnIntervalTooFineForALongRangeMovesUp(t *testing.T) {
	now := int64(1_791_806_400_000) // 2026-10-12 12:00 UTC
	const day = int64(86_400_000)
	str := func(s string) *string { return &s }
	resolve := func(from, to string, interval *string, zone string) *Range {
		return ResolveRange(RangeInput{From: &from, To: &to, Interval: interval}, zone, now, "")
	}

	hourly := resolve("2026-08-01", "2026-09-09", str("hour"), "UTC")
	if hourly == nil || hourly.Interval != "day" {
		t.Fatalf("40 days of hours: %+v", hourly)
	}
	if n := len(Buckets(*hourly, "UTC")); n != 40 {
		t.Errorf("%d buckets, want 40", n)
	}
	if month := resolve("2026-08-01", "2026-08-31", str("hour"), "UTC"); month == nil || month.Interval != "hour" {
		t.Errorf("a month of hours still fits: %+v", month)
	}

	daily := resolve("2018-01-03", "2026-10-12", str("day"), "Europe/London")
	if daily == nil || daily.Interval != "week" {
		t.Fatalf("daily over eight years: %+v", daily)
	}
	weeks := Buckets(*daily, "Europe/London")
	if weeks[0].Start != daily.From || weeks[len(weeks)-1].End != daily.To {
		t.Errorf("the buckets run %d to %d, not %d to %d", weeks[0].Start, weeks[len(weeks)-1].End, daily.From, daily.To)
	}
	for i, week := range weeks {
		if i > 0 && week.Start != weeks[i-1].End {
			t.Fatalf("week %d does not follow the one before", i)
		}
		// A week across a clock change is an hour short or long; none is longer than that.
		if length := week.End - week.Start; length > 7*day+3_600_000 || (i > 0 && i < len(weeks)-1 && length < 7*day-3_600_000) {
			t.Fatalf("week %d is %d ms", i, length)
		}
	}

	decades := resolve("1990-01-01", "2026-10-12", str("day"), "UTC")
	if decades == nil || decades.Interval != "month" {
		t.Fatalf("daily over decades: %+v", decades)
	}
	months := Buckets(*decades, "UTC")
	if len(months) != 442 {
		t.Errorf("%d months, want 442", len(months))
	}
	for _, m := range months {
		if m.End-m.Start > 31*day {
			t.Fatalf("a month of %d ms", m.End-m.Start)
		}
	}
	if past := ResolveRange(RangeInput{From: str("1900-01-01"), To: str("2026-10-12")}, "UTC", now, ""); past != nil {
		t.Errorf("past 1,000 months there is no interval that fits: %+v", past)
	}

	// A comparison longer than its range keeps whole buckets, cut off at a boundary.
	longer := *decades
	longer.From, longer.FromDate, longer.Interval = 946_684_800_000, "2000-01-01", "day"
	cut := Buckets(longer, "UTC")
	if len(cut) != 1000 || cut[999].End-cut[999].Start != day {
		t.Errorf("%d buckets, the last %d ms", len(cut), cut[len(cut)-1].End-cut[len(cut)-1].Start)
	}
}

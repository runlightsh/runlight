package dbtest

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	runlight "runlight.sh/go"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/web"
)

// analyzeCounter counts the ANALYZE statements a store runs.
type analyzeCounter struct {
	runlight.Db
	analyzed atomic.Int64
}

func (c *analyzeCounter) Run(ctx context.Context, sql string, params ...any) error {
	if sql == "ANALYZE" {
		c.analyzed.Add(1)
	}
	return c.Db.Run(ctx, sql, params...)
}

func (c *analyzeCounter) addEvents(t *testing.T, ts int64, prefix string, n int) {
	t.Helper()
	for i := range n {
		if err := c.Run(context.Background(), `INSERT INTO rl_events (site, ts, kind, visitor, session, pageview, path, hostname) VALUES ('default', ?, 'pageview', 'v', 's', ?, '/', 'example.com')`, ts, fmt.Sprintf("%s%d", prefix, i)); err != nil {
			t.Fatal(err)
		}
	}
}

// Planner statistics gathered on an empty database are gathered again once the events outgrow them.
func TestPlannerStatisticsGatheredOnAnEmptyDatabaseAreGatheredAgainOnceTheEventsOutgrowThem(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			db := &analyzeCounter{Db: Open(t, kind)}
			now := int64(1_791_806_400_000)
			store := runlight.NewStore(db)
			if err := store.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			rl, err := runlight.New(runlight.Options{Store: store, Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}, Timezone: "UTC"}, Logf: func(string, ...any) {}, Now: func() int64 { return now }})
			if err != nil {
				t.Fatal(err)
			}
			if err := rl.Init(ctx); err != nil {
				t.Fatal(err)
			}
			db.analyzed.Store(0)
			store.Optimize(ctx, true)
			if got := db.analyzed.Load(); got != 0 {
				t.Fatalf("%d analyses while still empty, want 0", got)
			}
			db.addEvents(t, now, "p", 1500)
			store.Optimize(ctx, true)
			sqlite := db.Dialect() == "sqlite"
			if !sqlite {
				if got := db.analyzed.Load(); got != 0 {
					t.Fatalf("%d analyses, and only SQLite needs them", got)
				}
				return
			}
			if got := db.analyzed.Load(); got != 1 {
				t.Fatalf("%d analyses once the events grew, want 1", got)
			}
			stat, err := db.All(ctx, `SELECT stat FROM sqlite_stat1 WHERE idx = 'rl_events_site_ts'`)
			if err != nil || len(stat) == 0 {
				t.Fatalf("no statistics written: %v", err)
			}
			// A sample, so an estimate of the 1,500 rather than an exact count.
			if first := js.Number(strings.Fields(fmt.Sprint(stat[0]["stat"]))[0]); first <= 1000 {
				t.Fatalf("statistics count %v events", stat[0]["stat"])
			}
			store.Optimize(ctx, true)
			if got := db.analyzed.Load(); got != 1 {
				t.Fatalf("%d analyses, and not again until they double", got)
			}
			// An app that never runs the scheduled check gets them from its reports, at most hourly.
			db.addEvents(t, now, "q", 1600)
			token := "t"
			routes, err := rl.Routes(runlight.RoutesOptions{Token: &token})
			if err != nil {
				t.Fatal(err)
			}
			for range 2 {
				r := routes.Handle(ctx, web.NewRequest("GET", "https://stats.example.com/runlight/api/stats?period=7d", web.NewHeaders("authorization", "Bearer t"), nil))
				if r.Status != 200 {
					t.Fatalf("stats: %d %s", r.Status, r.Body)
				}
			}
			if got := db.analyzed.Load(); got != 2 {
				t.Fatalf("%d analyses, want once for the doubled events and not again within the hour", got)
			}
		})
	}
}

// Goals by a whole path or a name, worth nothing or a fixed amount, read from the daily rollups and answer as they do from the visits.
func TestGoalsByAPathOrANameAreCountedFromDailyRollups(t *testing.T) {
	ctx := context.Background()
	const hour = int64(3_600_000)
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			db := Open(t, kind)
			store := runlight.NewStore(db)
			if err := store.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			start := int64(1_791_806_400_000) // 2026-10-12
			now := start - 6*24*hour
			rl, err := runlight.New(runlight.Options{Store: store, Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}, Timezone: "America/Toronto"}, Logf: func(string, ...any) {}, Now: func() int64 { return now }})
			if err != nil {
				t.Fatal(err)
			}
			token := "t"
			routes, err := rl.Routes(runlight.RoutesOptions{Token: &token})
			if err != nil {
				t.Fatal(err)
			}
			pages := []string{"/", "/blog/one", "/blog/two", "/pricing", "/about"}
			n := 0
			for range 5 {
				for range 6 {
					n++
					headers := web.NewHeaders("user-agent", "Mozilla/5.0 (Macintosh) Chrome/129.0.0.0 Safari/537.36", "x-forwarded-for", fmt.Sprintf("203.0.113.%d", n))
					for p := range 1 + n%3 {
						id := fmt.Sprintf("pv%dx%d", n, p)
						body := fmt.Sprintf(`{"k":"pageview","u":"https://example.com%s","i":"%s"}`, pages[(n+p)%len(pages)], id)
						routes.Handle(ctx, web.NewRequest("POST", "https://stats.example.com/runlight/e", headers, []byte(body)))
						now += 20_000
						if n%2 == 0 {
							routes.Handle(ctx, web.NewRequest("POST", "https://stats.example.com/runlight/e", headers, []byte(fmt.Sprintf(`{"k":"event","u":"https://example.com/","i":"%s","n":"Signup"}`, id))))
						}
					}
					now += 3 * hour
				}
				now += 24*hour - 6*3*hour
			}
			now = start + 2*hour
			rl.Idle()
			for i, goal := range []runlight.GoalRow{
				{Kind: "page", Match: "/pricing", ValueMode: "none"},
				{Kind: "page", Match: "/blog/*", ValueMode: "fixed"},
				{Kind: "event", Match: "Signup", ValueMode: "fixed"},
				{Kind: "event", Match: "Signup", ValueMode: "prop"},
				{Kind: "click", Match: "button", ValueMode: "none"},
			} {
				goal.ID, goal.Site, goal.Name, goal.ClickBy = fmt.Sprintf("%024d", i), "default", "Signup", "selector"
				goal.Value, goal.ValueProp, goal.Currency, goal.CreatedAt = 1.25, "revenue", "USD", now
				if err := store.SaveGoal(ctx, goal, nil); err != nil {
					t.Fatal(err)
				}
			}
			goals := func() []any {
				t.Helper()
				r := routes.Handle(ctx, web.NewRequest("GET", "https://stats.example.com/runlight/api/goals?period=30d&compare=previous", web.NewHeaders("authorization", "Bearer t"), nil))
				if r.Status != 200 {
					t.Fatalf("goals: %d %s", r.Status, r.Body)
				}
				v, _ := js.Parse(string(r.Body))
				return js.Arr(js.Dig(v, "goals"))
			}
			before := goals()
			if len(before) != 5 || js.Num(js.Dig(before[0], "conversions")) == 0 || js.Num(js.Dig(before[2], "conversions")) == 0 {
				t.Fatalf("no conversions to compare: %s", js.Stringify(before))
			}
			built := 0
			for {
				made, err := rl.BuildRollups(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if made == 0 {
					break
				}
				built += made
			}
			if built < 4 {
				t.Fatalf("built %d days", built)
			}
			// Proof the goals read the rollups: with the built days' raw visits gone, they still add up.
			days, err := db.All(ctx, `SELECT MIN(start_at) AS s, MAX(end_at) AS e FROM rl_rollup_days`)
			if err != nil || len(days) == 0 {
				t.Fatalf("no built days: %v", err)
			}
			from, to := int64(js.Num(days[0]["s"])), int64(js.Num(days[0]["e"]))-2*hour
			if err := db.Run(ctx, `DELETE FROM rl_events WHERE ts >= ? AND ts < ?`, from, to); err != nil {
				t.Fatal(err)
			}
			if err := db.Run(ctx, `DELETE FROM rl_sessions WHERE started_at >= ? AND started_at < ?`, from, to); err != nil {
				t.Fatal(err)
			}
			after := goals()
			for _, i := range []int{0, 2, 4} {
				if js.Stringify(after[i]) != js.Stringify(before[i]) {
					t.Errorf("goal %d does not come from rollups:\n%s\n%s", i, js.Stringify(after[i]), js.Stringify(before[i]))
				}
			}
		})
	}
}

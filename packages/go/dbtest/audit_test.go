package dbtest

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	runlight "runlight.sh/go"
	"runlight.sh/go/internal/accounts"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/web"
)

const (
	minute = int64(60_000)
	hour   = 60 * minute
	day    = 24 * hour
	// 2026-10-06 12:00 UTC, as the TypeScript tests begin.
	october6 = int64(1_791_288_000_000)
)

// auditHarness is a Runlight on a kind of database with a clock the test moves.
type auditHarness struct {
	t      *testing.T
	ctx    context.Context
	rl     *runlight.Runlight
	routes *runlight.Routes
	store  *runlight.Store
	db     runlight.Db
	now    int64
}

func newAudit(t *testing.T, kind Kind, sites ...runlight.SiteOptions) *auditHarness {
	t.Helper()
	h := &auditHarness{t: t, ctx: context.Background(), now: october6}
	h.db = Open(t, kind)
	h.store = runlight.NewStore(h.db)
	if err := h.store.Migrate(h.ctx); err != nil {
		t.Fatal(err)
	}
	options := runlight.Options{Store: h.store, Logf: func(string, ...any) {}, Now: func() int64 { return h.now }, Secret: ptr("a server secret that is long enough")}
	if len(sites) == 0 {
		options.Site = &runlight.SiteOptions{Hostnames: []string{"example.com"}, Timezone: "UTC"}
	} else {
		options.Sites = sites
	}
	rl, err := runlight.New(options)
	if err != nil {
		t.Fatal(err)
	}
	h.rl = rl
	token := "secret"
	h.routes, err = rl.Routes(runlight.RoutesOptions{Token: &token})
	if err != nil {
		t.Fatal(err)
	}
	return h
}

const chromeMac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"

// send is a tracker hit from an address, with more headers if wanted.
func (h *auditHarness) send(body, ip string, more ...string) {
	h.t.Helper()
	headers := append([]string{"user-agent", chromeMac, "x-forwarded-for", ip}, more...)
	r := h.routes.Handle(h.ctx, web.NewRequest("POST", "https://example.com/runlight/e", web.NewHeaders(headers...), []byte(body)))
	if r.Status != 202 {
		h.t.Fatalf("collect answered %d %s", r.Status, r.Body)
	}
}

func (h *auditHarness) view(path string) (int, any) {
	h.t.Helper()
	r := h.routes.Handle(h.ctx, web.NewRequest("GET", "https://example.com/runlight"+path, web.NewHeaders("authorization", "Bearer secret"), nil))
	v, _ := js.Parse(string(r.Body))
	return r.Status, v
}

func (h *auditHarness) get(path string) any {
	h.t.Helper()
	status, v := h.view(path)
	if status != 200 {
		h.t.Fatalf("%s answered %d: %s", path, status, js.Stringify(v))
	}
	return v
}

func (h *auditHarness) check() {
	h.t.Helper()
	if _, err := h.rl.Check(h.ctx); err != nil {
		h.t.Fatal(err)
	}
}

func (h *auditHarness) salts() []string {
	h.t.Helper()
	rows, err := h.db.All(h.ctx, "SELECT day FROM rl_salts ORDER BY day")
	if err != nil {
		h.t.Fatal(err)
	}
	out := []string{}
	for _, r := range rows {
		out = append(out, fmt.Sprint(r["day"]))
	}
	return out
}

func pageview(host, path, id string) string {
	return fmt.Sprintf(`{"k":"pageview","u":"https://%s%s","i":"%s"}`, host, path, id)
}

func TestASaltLastsItsDayAndPastMidnightOnlyWhileAVisitThatBeganThatDayGoesOn(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind)
			ip := "203.0.113.1"
			h.send(pageview("example.com", "/", "s1"), ip)
			for i := range 3 {
				h.now += day
				h.send(pageview("example.com", "/", fmt.Sprintf("s%d", i+2)), ip)
			}
			h.check()
			// October 9th at noon UTC: no visit from the 8th is still going, so only today's salt is left.
			if got := strings.Join(h.salts(), " "); got != "2026-10-09" {
				t.Fatalf("salts %s", got)
			}

			// A visit that runs past midnight keeps its day's salt until it ends, and stays one visit.
			h.now += 11*hour + 50*minute // 23:50 on the 9th
			h.send(pageview("example.com", "/late", "m1"), ip)
			h.now += 20 * minute // 00:10 on the 10th
			h.send(pageview("example.com", "/later", "m2"), ip)
			h.check()
			if got := strings.Join(h.salts(), " "); got != "2026-10-09 2026-10-10" {
				t.Fatalf("the visit is still going: salts %s", got)
			}
			h.now += 31 * minute // idle for half an hour: the visit has ended
			h.check()
			if got := strings.Join(h.salts(), " "); got != "2026-10-10" {
				t.Fatalf("the visit has ended: salts %s", got)
			}
			// Noon on the 9th, and the one across midnight, which belongs to the 9th where it began.
			stats := js.Dig(h.get("/api/stats?from=2026-10-09&to=2026-10-10&compare=off"), "stats")
			if visits, views := js.Num(js.Dig(stats, "visits")), js.Num(js.Dig(stats, "pageviews")); visits != 2 || views != 3 {
				t.Errorf("visits %v, pageviews %v, want 2 and 3: the visit across midnight is one visit", visits, views)
			}
		})
	}
}

func TestEachSitesTimezoneKeepsTheSaltsItsOwnVisitsNeed(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			// Toronto is still on the 9th when UTC reaches the 10th.
			h := newAudit(t, kind,
				runlight.SiteOptions{ID: "utc", Name: "UTC", Hostnames: []string{"example.com"}, Timezone: "UTC"},
				runlight.SiteOptions{ID: "to", Name: "Toronto", Hostnames: []string{"example.org"}, Timezone: "America/Toronto"})
			h.now += -12*hour + 2*hour // 02:00 UTC on the 6th, 22:00 on the 5th in Toronto
			h.check()
			for _, d := range h.salts() {
				if d != "2026-10-05" && d != "2026-10-06" {
					t.Errorf("a salt for %s", d)
				}
			}
			h.send(pageview("example.org", "/", "to1"), "203.0.113.1")
			h.send(pageview("example.com", "/", "utc1"), "203.0.113.1")
			h.check()
			if got := strings.Join(h.salts(), " "); got != "2026-10-05 2026-10-06" {
				t.Errorf("today in each timezone: %s", got)
			}
		})
	}
}

func TestRenamingAClickGoalKeepsItsConversionsOnBuiltDaysEvenOntoANameWithEventsOfItsOwn(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind)
			h.now -= 3 * day
			for i := range 3 {
				ip := fmt.Sprintf("203.0.113.%d", 60+i)
				h.send(pageview("example.com", "/", fmt.Sprintf("c%d", i)), ip)
				h.send(fmt.Sprintf(`{"k":"event","u":"https://example.com/","i":"c%d","n":"Buy click"}`, i), ip)
				// One visit also sends a plain event under the name the goal is renamed to.
				if i == 0 {
					h.send(fmt.Sprintf(`{"k":"event","u":"https://example.com/","i":"c%d","n":"Purchase"}`, i), ip)
				}
				h.now += hour
			}
			h.now += 3*day - 3*hour
			goal := runlight.GoalRow{ID: strings.Repeat("0", 23) + "c", Site: "default", Name: "Buy click", Kind: "click", Match: "button.buy", ClickBy: "selector", ValueMode: "none", Currency: "USD", CreatedAt: h.now}
			if err := h.store.SaveGoal(h.ctx, goal, nil); err != nil {
				t.Fatal(err)
			}
			buildAll := func() {
				for {
					made, err := h.rl.BuildRollups(h.ctx)
					if err != nil {
						t.Fatal(err)
					}
					if made == 0 {
						return
					}
				}
			}
			buildAll()
			read := func() (string, string) {
				goals := []any{}
				for _, g := range js.Arr(js.Dig(h.get("/api/goals?period=7d&compare=off"), "goals")) {
					goals = append(goals, []any{js.Dig(g, "name"), js.Dig(g, "conversions"), js.Dig(g, "visitors")})
				}
				events := []any{}
				for _, r := range js.Arr(js.Dig(h.get("/api/breakdown?period=7d&dimension=event"), "rows")) {
					events = append(events, []any{js.Dig(r, "value"), js.Dig(r, "events")})
				}
				return js.Stringify(goals), js.Stringify(events)
			}
			if goals, _ := read(); goals != `[["Buy click",3,3]]` {
				t.Fatalf("before: %s", goals)
			}
			for _, name := range []string{"Checkout click", "Purchase"} {
				all, err := h.store.Goals(h.ctx, "default")
				if err != nil || len(all) != 1 {
					t.Fatalf("goals: %v %v", all, err)
				}
				before := all[0]
				renamed := before
				renamed.Name = name
				if err := h.store.SaveGoal(h.ctx, renamed, &before); err != nil {
					t.Fatal(err)
				}
				conversions := 3
				if name == "Purchase" {
					conversions = 4
				}
				if goals, _ := read(); goals != fmt.Sprintf(`[["%s",%d,3]]`, name, conversions) {
					t.Fatalf("renamed to %s: %s", name, goals)
				}
				// Days built again where both names met, then every built day read the same as the raw events.
				buildAll()
				goals, events := read()
				if err := h.store.ClearRollups(h.ctx, "default", runlight.RollupRange{}); err != nil {
					t.Fatal(err)
				}
				rawGoals, rawEvents := read()
				if goals != rawGoals || events != rawEvents {
					t.Errorf("rollups disagree with the raw events after renaming to %s:\n%s %s\n%s %s", name, goals, events, rawGoals, rawEvents)
				}
				buildAll()
			}
		})
	}
}

func TestAHeaderLongerThanItsColumnIsCutToFitSoTheDaysRollupStillBuilds(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind)
			h.now -= 2 * day
			long := `"` + strings.Repeat("Windows ", 400) + `"`
			// A browser whose user agent names no system, so the platform hint is what is stored.
			headers := []string{"user-agent", "Mozilla/5.0 (Unknown) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
				"sec-ch-ua-platform", long, "sec-ch-ua", `"` + strings.Repeat("B", 3000) + `";v="1"`, "x-forwarded-for", "203.0.113.70"}
			r := h.routes.Handle(h.ctx, web.NewRequest("POST", "https://example.com/runlight/e", web.NewHeaders(headers...),
				[]byte(pageview("example.com", "/"+strings.Repeat("a", 1500), "long1"))))
			if r.Status != 202 {
				t.Fatalf("collect: %d %s", r.Status, r.Body)
			}
			h.now += 2 * day
			rows, err := h.db.All(h.ctx, "SELECT os, entry_path FROM rl_sessions")
			if err != nil || len(rows) != 1 {
				t.Fatalf("%v %v", rows, err)
			}
			if n := len([]rune(fmt.Sprint(rows[0]["os"]))); n <= 50 || n > 100 {
				t.Errorf("os is %d characters", n)
			}
			if n := len([]rune(fmt.Sprint(rows[0]["entry_path"]))); n > 1000 {
				t.Errorf("entry_path is %d characters", n)
			}
			built := 0
			for {
				made, err := h.rl.BuildRollups(h.ctx)
				if err != nil {
					t.Fatal(err)
				}
				if made == 0 {
					break
				}
				built += made
			}
			if built < 1 {
				t.Error("the day does not build")
			}
			if visits := js.Num(js.Dig(h.get("/api/stats?period=7d&compare=off"), "stats", "visits")); visits != 1 {
				t.Errorf("visits %v", visits)
			}
		})
	}
}

// On MySQL, two processes building one day at once add its rows once.
func TestTwoProcessesBuildingOneDayAtOnceAddItsRowsOnceOnMySQL(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		if kind.Name != "mysql" && kind.Name != "mariadb" {
			continue
		}
		t.Run(kind.Name, func(t *testing.T) {
			raw, open := sharedPair(t, kind)
			one, other := runlight.NewStore(raw), runlight.NewStore(open())
			for _, s := range []*runlight.Store{one, other} {
				if err := s.Migrate(ctx); err != nil {
					t.Fatal(err)
				}
			}
			now := int64(1_791_028_800_000) // 2026-10-03 12:00 UTC
			rl, err := runlight.New(runlight.Options{Store: one, Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}, Timezone: "UTC"}, Logf: func(string, ...any) {}, Now: func() int64 { return now }})
			if err != nil {
				t.Fatal(err)
			}
			token := "secret"
			routes, err := rl.Routes(runlight.RoutesOptions{Token: &token})
			if err != nil {
				t.Fatal(err)
			}
			for i := range 5 {
				headers := web.NewHeaders("user-agent", chromeMac, "x-forwarded-for", fmt.Sprintf("203.0.113.%d", 80+i))
				if r := routes.Handle(ctx, web.NewRequest("POST", "https://example.com/runlight/e", headers, []byte(fmt.Sprintf(`{"k":"pageview","u":"https://example.com/p%d"}`, i)))); r.Status != 202 {
					t.Fatalf("collect: %d %s", r.Status, r.Body)
				}
			}
			rl.Idle()
			start := int64(1_790_985_600_000) // 2026-10-03 00:00 UTC
			for round := range 5 {
				var wg sync.WaitGroup
				errs := make([]error, 2)
				for i, s := range []*runlight.Store{one, other} {
					wg.Add(1)
					go func() {
						defer wg.Done()
						errs[i] = s.BuildRollupDay(ctx, "default", "2026-10-03", start, start+day)
					}()
				}
				wg.Wait()
				if errs[0] != nil && errs[1] != nil {
					t.Fatalf("round %d: neither built it: %v %v", round, errs[0], errs[1])
				}
				rows, err := raw.All(ctx, "SELECT COUNT(*) AS n, SUM(visits) AS visits FROM rl_rollups WHERE site = 'default' AND day = '2026-10-03' AND dim = ''")
				if err != nil || len(rows) != 1 {
					t.Fatalf("%v %v", rows, err)
				}
				if n, visits := js.Number(fmt.Sprint(rows[0]["n"])), js.Number(fmt.Sprint(rows[0]["visits"])); n != 1 || visits != 5 {
					t.Fatalf("round %d: %v rows, %v visits, want 1 and 5", round, n, visits)
				}
			}
		})
	}
}

// Two visits opened for one visitor at once, by two processes, settle on one.
func TestTwoVisitsOpenedForOneVisitorAtOnceSettleOnOne(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind)
			if err := h.rl.Init(h.ctx); err != nil {
				t.Fatal(err)
			}
			row := func(id string) runlight.SessionRow {
				return runlight.SessionRow{ID: id, Site: "default", Visitor: "v1", StartedAt: h.now, Hostname: "example.com", Channel: "Direct"}
			}
			for _, id := range []string{"bbbb", "aaaa"} {
				if err := h.store.InsertSession(h.ctx, row(id)); err != nil {
					t.Fatal(err)
				}
			}
			// Each process asks after opening its own; both settle on the same one, and the other is gone.
			one, err := h.store.SettleOpenSession(h.ctx, "default", []string{"v1"}, h.now-minute, runlight.OpenSession{ID: "bbbb", Visitor: "v1"})
			if err != nil {
				t.Fatal(err)
			}
			other, err := h.store.SettleOpenSession(h.ctx, "default", []string{"v1"}, h.now-minute, runlight.OpenSession{ID: "aaaa", Visitor: "v1"})
			if err != nil {
				t.Fatal(err)
			}
			if one.ID != "aaaa" || other.ID != "aaaa" {
				t.Errorf("settled on %s and %s, want aaaa twice", one.ID, other.ID)
			}
			rows, err := h.db.All(h.ctx, "SELECT id FROM rl_sessions")
			if err != nil || len(rows) != 1 || rows[0]["id"] != "aaaa" {
				t.Errorf("sessions left: %v %v", rows, err)
			}
		})
	}
}

func TestSigningInHashesAPasswordMadeAtTheOldCostAgainAndAWrongPasswordChangesNothing(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			// The real cost, for this one.
			defer accounts.SetCostForTests(32768, 8, 3)()
			db := Open(t, kind)
			store := runlight.NewStore(db)
			if err := store.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			users := runlight.NewAccountStore(store, "a server secret long enough")
			user, err := users.SetPassword(ctx, "owner@example.com", "a long password", 1_791_806_400_000, "")
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(user.Hash, "scrypt$32768$8$3$") {
				t.Fatalf("a new hash: %s", user.Hash)
			}
			salt := accounts.RandomBytes(16)
			key, err := accounts.Scrypt("a long password", salt, 16384, 8, 1, 32)
			if err != nil {
				t.Fatal(err)
			}
			old := "scrypt$" + accounts.Base64url(salt) + "$" + accounts.Base64url(key)
			if err := db.Run(ctx, "UPDATE rl_users SET hash = ? WHERE id = ?", old, user.ID); err != nil {
				t.Fatal(err)
			}
			if got, err := users.SignIn(ctx, "owner@example.com", "a wrong password"); got != nil || err != nil {
				t.Fatalf("a wrong password: %v %v", got, err)
			}
			if again, _ := users.ByID(ctx, user.ID); again.Hash != old {
				t.Error("a wrong password changed the hash")
			}
			signedIn, err := users.SignIn(ctx, "owner@example.com", "a long password")
			if err != nil || signedIn == nil {
				t.Fatalf("signing in: %v %v", signedIn, err)
			}
			if !strings.HasPrefix(signedIn.Hash, "scrypt$32768$8$3$") {
				t.Errorf("made again at the new cost: %s", signedIn.Hash)
			}
			if again, _ := users.ByID(ctx, user.ID); again.Hash != signedIn.Hash {
				t.Error("and kept")
			}
			if again, err := users.SignIn(ctx, "owner@example.com", "a long password"); again == nil || err != nil {
				t.Errorf("and it still signs in: %v %v", again, err)
			}
		})
	}
}

func TestDeletingASiteRemovesTheAccountsAndInvitationsKeptToItAndNoOneElse(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			store := Store(t, kind)
			users := runlight.NewAccountStore(store, "a server secret long enough")
			now := int64(1_791_806_400_000)
			for _, who := range []struct{ email, role, site string }{{"owner@example.com", "", ""}, {"alpha@example.com", "viewer", "alpha"}, {"beta@example.com", "member", "beta"}} {
				if _, err := users.SetPassword(ctx, who.email, "a long password", now, who.role, who.site); err != nil {
					t.Fatal(err)
				}
			}
			if _, _, err := users.InviteSomeone(ctx, "invited@example.com", "member", "owner@example.com", now, "alpha"); err != nil {
				t.Fatal(err)
			}
			if _, _, err := users.InviteSomeone(ctx, "other@example.com", "member", "owner@example.com", now, "beta"); err != nil {
				t.Fatal(err)
			}
			if err := users.ForgetSite(ctx, "alpha"); err != nil {
				t.Fatal(err)
			}
			list, err := users.List(ctx)
			if err != nil {
				t.Fatal(err)
			}
			emails := []string{}
			for _, u := range list {
				emails = append(emails, u.Email)
			}
			sortStrings(emails)
			if got := strings.Join(emails, " "); got != "beta@example.com owner@example.com" {
				t.Errorf("accounts left: %s", got)
			}
			invites, err := users.Invites(ctx, now)
			if err != nil || len(invites) != 1 || invites[0].Email != "other@example.com" {
				t.Errorf("invitations left: %+v %v", invites, err)
			}
		})
	}
}

func TestDeletingASiteThroughTheAPIRemovesItsOwnAccounts(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			store := Store(t, kind)
			now := int64(1_791_806_400_000)
			rl, err := runlight.New(runlight.Options{Store: store, ManagedSites: true, Logf: func(string, ...any) {}, Now: func() int64 { return now }, Secret: ptr("a server secret long enough")})
			if err != nil {
				t.Fatal(err)
			}
			token := "t"
			routes, err := rl.Routes(runlight.RoutesOptions{Token: &token, Accounts: true})
			if err != nil {
				t.Fatal(err)
			}
			auth := web.NewHeaders("authorization", "Bearer t", "content-type", "application/json")
			do := func(method, path, body string) *runlight.Response {
				var b []byte
				if body != "" {
					b = []byte(body)
				}
				return routes.Handle(ctx, web.NewRequest(method, "https://stats.example.com/runlight"+path, auth, b))
			}
			for _, host := range []string{"alpha.example.com", "beta.example.com"} {
				if r := do("POST", "/api/sites", `{"hostnames":"`+host+`"}`); r.Status != 201 {
					t.Fatalf("adding %s: %d %s", host, r.Status, r.Body)
				}
			}
			users := runlight.NewAccountStore(store, "a server secret long enough")
			if _, err := users.SetPassword(ctx, "owner@example.com", "a long password", now, ""); err != nil {
				t.Fatal(err)
			}
			for _, who := range []struct{ email, site string }{{"alpha@example.com", "alpha.example.com"}, {"beta@example.com", "beta.example.com"}} {
				if _, err := users.SetPassword(ctx, who.email, "a long password", now, "viewer", who.site); err != nil {
					t.Fatal(err)
				}
			}
			if r := do("DELETE", "/api/sites/alpha.example.com", ""); r.Status != 200 {
				t.Fatalf("deleting: %d %s", r.Status, r.Body)
			}
			list, err := users.List(ctx)
			if err != nil {
				t.Fatal(err)
			}
			emails := []string{}
			for _, u := range list {
				emails = append(emails, u.Email)
			}
			sortStrings(emails)
			if got := strings.Join(emails, " "); got != "beta@example.com owner@example.com" {
				t.Errorf("accounts left: %s", got)
			}
		})
	}
}

func TestASitesAgentsKeyIsKeptSealedAndOneKeptAsPlainTextBeforeStillWorksAndIsSealedWhenRead(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind)
			if err := h.rl.Init(h.ctx); err != nil {
				t.Fatal(err)
			}
			token := func() string {
				r := h.routes.Handle(h.ctx, web.NewRequest("GET", "https://example.com/runlight/api/observe-key", web.NewHeaders("authorization", "Bearer secret"), nil))
				if r.Status != 200 {
					t.Fatalf("observe-key: %d %s", r.Status, r.Body)
				}
				v, _ := js.Parse(string(r.Body))
				return js.Str(js.Dig(v, "key"))
			}
			key := token()
			stored, _, _ := h.store.Setting(h.ctx, "observe-key:default")
			if strings.Contains(stored, key) {
				t.Fatalf("the key is in the database as it is: %s", stored)
			}
			observe := func(bearer string) int {
				body := `{"url":"https://example.com/","userAgent":"Mozilla/5.0 (compatible; GPTBot/1.2)"}`
				r := h.routes.Handle(h.ctx, web.NewRequest("POST", "https://example.com/runlight/api/observe", web.NewHeaders("authorization", "Bearer "+bearer, "content-type", "application/json"), []byte(body)))
				return r.Status
			}
			if got := observe(key); got != 204 {
				t.Errorf("the key: %d", got)
			}
			// A key from before, kept as it was.
			legacy := "rlo_legacykeylegacykey00"
			if err := h.store.SetSetting(h.ctx, "observe-key:default", &legacy); err != nil {
				t.Fatal(err)
			}
			if got := observe(legacy); got != 204 {
				t.Errorf("a key kept as plain text: %d", got)
			}
			if got := token(); got != legacy {
				t.Errorf("shown as it was: %s", got)
			}
			if sealed, _, _ := h.store.Setting(h.ctx, "observe-key:default"); strings.Contains(sealed, "rlo_legacy") {
				t.Errorf("and sealed now: %s", sealed)
			}
			if got := observe(legacy); got != 204 {
				t.Errorf("still working: %d", got)
			}
			if got := observe("rlo_wrongkeywrongkeywron"); got != 401 {
				t.Errorf("a wrong key: %d", got)
			}
		})
	}
}

func TestAJourneysStartEndAndThroughTakeAPageAsWrittenAsFiltersDo(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind)
			h.send(pageview("example.com", "/café", "a"), "203.0.113.1")
			h.now += 30_000
			h.send(pageview("example.com", "/pricing", "b"), "203.0.113.1")
			for _, query := range []string{
				"start=" + url.QueryEscape("/café"),
				"start=" + url.QueryEscape("/caf%C3%A9"),
				"end=" + url.QueryEscape("/pricing") + "&start=" + url.QueryEscape("/café"),
				"through=" + url.QueryEscape("0:/café"),
			} {
				if visits := js.Num(js.Dig(h.get("/api/journeys?period=today&"+query), "visits")); visits != 1 {
					t.Errorf("%s: %v visits", query, visits)
				}
			}
		})
	}
}

func TestNMonthsBackFromAMonthsLastDaysStaysInThatMonthAndPagingTakesWholeNumbers(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind)
			if err := h.rl.Init(h.ctx); err != nil {
				t.Fatal(err)
			}
			six := 6.0
			if err := h.rl.SetRetention(h.ctx, "default", &six); err != nil {
				t.Fatal(err)
			}
			h.rl.Idle()
			utc := func(y, m, d, hh int) int64 { return js.DateUTC(int64(y), int64(m), int64(d), int64(hh), 0, 0, 0) }
			for _, c := range [][2]int64{
				{utc(2026, 7, 31, 12), utc(2026, 1, 28, 12)},
				{utc(2026, 7, 30, 12), utc(2026, 1, 28, 12)},
				{utc(2028, 7, 31, 12), utc(2028, 1, 29, 12)},
				{utc(2026, 9, 6, 12), utc(2026, 3, 6, 12)},
			} {
				h.now = c[0]
				cutoff, err := h.rl.RetentionCutoff(h.ctx, "default")
				if err != nil || cutoff == nil || *cutoff != c[1] {
					t.Errorf("%s: cutoff %v %v, want %s", js.ISOString(c[0]), cutoff, err, js.ISOString(c[1]))
				}
			}
			h.now = october6
			for i := range 12 {
				h.send(pageview("example.com", fmt.Sprintf("/p%d", i), ""), fmt.Sprintf("203.0.113.%d", i+1))
			}
			rows := func(query string) int {
				return len(js.Arr(js.Dig(h.get("/api/breakdown?period=7d&dimension=page&"+query), "rows")))
			}
			// A fraction, a huge number, or text is no number of rows: the default ten stands.
			for query, want := range map[string]int{"limit=3": 3, "limit=2.5": 10, "page=1e20": 10, "limit=-3&page=0": 10, "limit=abc&page=2.5": 10, "limit=5&page=3": 2} {
				if got := rows(query); got != want {
					t.Errorf("%s: %d rows, want %d", query, got, want)
				}
			}
		})
	}
}

func TestHostnameSuggestionsRespectVisitsFiltersDatesAndSitesWithoutCountingTotals(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind,
				runlight.SiteOptions{ID: "a", Hostnames: []string{"a.example.com", "b.example.com", "old.example.com", "event.example.com"}, Timezone: "UTC"},
				runlight.SiteOptions{ID: "other", Hostnames: []string{"private.example.com"}, Timezone: "UTC"})
			h.send(pageview("old.example.com", "/", "old"), "203.0.113.1")
			h.now += day
			h.send(pageview("b.example.com", "/pricing", "b"), "203.0.113.1")
			h.send(pageview("a.example.com", "/", "a"), "203.0.113.2")
			h.send(pageview("a.example.com", "/", "a2"), "203.0.113.3")
			h.send(`{"k":"event","u":"https://event.example.com/","n":"Signup"}`, "203.0.113.4")
			h.send(pageview("private.example.com", "/", "private"), "203.0.113.1")
			path := "/api/breakdown?site=a&period=today&dimension=hostname&suggestions=1"
			values := func(query string) string {
				out := []string{}
				for _, r := range js.Arr(js.Dig(h.get(path+query), "rows")) {
					out = append(out, js.Str(js.Dig(r, "value")))
				}
				return strings.Join(out, " ")
			}
			if got := values(""); got != "a.example.com b.example.com" {
				t.Errorf("suggestions: %s", got)
			}
			if got := values("&limit=1"); got != "a.example.com" {
				t.Errorf("limit 1: %s", got)
			}
			if got := values("&filter=" + url.QueryEscape("page:is:/pricing")); got != "b.example.com" {
				t.Errorf("filtered: %s", got)
			}
			if got := values("&filter=" + url.QueryEscape("page:is:/missing")); got != "" {
				t.Errorf("filtered to nothing: %s", got)
			}
			if first := js.Dig(h.get(path), "rows", 0); js.Dig(first, "visitors") != nil {
				t.Errorf("a suggestion carries no totals: %s", js.Stringify(first))
			}
			denied := h.routes.Handle(h.ctx, web.NewRequest("GET", "https://example.com/runlight"+path, web.NewHeaders(), nil))
			if denied.Status != 401 {
				t.Errorf("without the token: %d", denied.Status)
			}
		})
	}
}

// A locale's own order puts blog-staging after blog, where byte order puts it before, so suggestions taken one
// after another in byte order must compare in byte order too, or one is skipped (Postgres on Linux).
func TestHostnameSuggestionsStepThroughHostnamesInTheOrderTheyAreSortedIn(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind, runlight.SiteOptions{ID: "a", Hostnames: []string{"blog.example.com", "blog-staging.example.com", "shop.example.com"}, Timezone: "UTC"})
			h.send(pageview("blog.example.com", "/", "a"), "203.0.113.2")
			h.send(pageview("blog-staging.example.com", "/", "b"), "203.0.113.3")
			h.send(pageview("shop.example.com", "/", "c"), "203.0.113.4")
			out := []string{}
			for _, r := range js.Arr(js.Dig(h.get("/api/breakdown?site=a&period=today&dimension=hostname&suggestions=1"), "rows")) {
				out = append(out, js.Str(js.Dig(r, "value")))
			}
			if got := strings.Join(out, " "); got != "blog-staging.example.com blog.example.com shop.example.com" {
				t.Errorf("suggestions: %s", got)
			}
		})
	}
}

// The audit of 2026-10-23.

// withMember is an install with accounts: its owner, and a member who joined by invite.
type withMember struct {
	t      *testing.T
	ctx    context.Context
	rl     *runlight.Runlight
	routes *runlight.Routes
	owner  string
	member string
}

func newWithMember(t *testing.T, kind Kind) *withMember {
	t.Helper()
	m := &withMember{t: t, ctx: context.Background()}
	rl, err := runlight.New(runlight.Options{Store: Store(t, kind), Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}}, Logf: func(string, ...any) {}, Secret: ptr(strings.Repeat("k", 64))})
	if err != nil {
		t.Fatal(err)
	}
	m.rl = rl
	token := "app-token"
	if m.routes, err = rl.Routes(runlight.RoutesOptions{Token: &token, Accounts: true}); err != nil {
		t.Fatal(err)
	}
	m.owner = cookieOf(m.form("/setup", "", "code", "app-token", "email", "jon@example.com", "password", "a long password", "again", "a long password"))
	v, _ := m.json(m.owner, "POST", "/api/people", `{"allSites":true,"email":"mo@example.com","role":"member"}`).JSON()
	link, err := url.Parse(js.Str(js.Dig(v, "link")))
	if err != nil {
		t.Fatal(err)
	}
	m.member = cookieOf(m.form("/invite", "", "code", link.Query().Get("code"), "password", "a long password", "again", "a long password"))
	if m.owner == "" || m.member == "" {
		t.Fatal("no sessions")
	}
	return m
}

func (m *withMember) do(method, path, body string, headers ...string) *runlight.Response {
	m.t.Helper()
	var b []byte
	if body != "" {
		b = []byte(body)
	}
	return m.routes.Handle(m.ctx, web.NewRequest(method, "https://example.com/runlight"+path, web.NewHeaders(headers...), b))
}

// form posts a form, from another site when site names one.
func (m *withMember) form(path, site string, fields ...string) *runlight.Response {
	m.t.Helper()
	headers := []string{"content-type", formType}
	if site != "" {
		headers = append(headers, "sec-fetch-site", site)
	}
	return m.do("POST", path, form(fields...), headers...)
}

func (m *withMember) json(cookie, method, path, body string) *runlight.Response {
	m.t.Helper()
	return m.do(method, path, body, "cookie", cookie, "content-type", "application/json")
}

func (m *withMember) signIn(site string) *runlight.Response {
	m.t.Helper()
	return m.form("/login", site, "email", "mo@example.com", "password", "a long password", "next", "/runlight/")
}

func (m *withMember) tokens(cookie string) []string {
	m.t.Helper()
	r := m.json(cookie, "GET", "/api/tokens", "")
	if r.Status != 200 {
		m.t.Fatalf("tokens: %d %s", r.Status, r.Body)
	}
	v, _ := r.JSON()
	out := []string{}
	for _, token := range js.Arr(js.Dig(v, "tokens")) {
		out = append(out, js.Str(js.Dig(token, "id")))
	}
	sortStrings(out)
	return out
}

func (m *withMember) makeToken(cookie, name string) string {
	m.t.Helper()
	r := m.json(cookie, "POST", "/api/tokens", `{"name":"`+name+`"}`)
	if r.Status != 201 {
		m.t.Fatalf("making a token: %d %s", r.Status, r.Body)
	}
	v, _ := r.JSON()
	return js.Str(js.Dig(v, "token", "id"))
}

func TestAMemberSeesAndRevokesOnlyTheTokensTheyMadeAndCannotReplaceASitesAgentsKey(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			m := newWithMember(t, kind)
			owners := m.makeToken(m.owner, "Owner's")
			mine := m.makeToken(m.member, "Member's")
			both := []string{owners, mine}
			sortStrings(both)
			if got := m.tokens(m.member); strings.Join(got, " ") != mine {
				t.Errorf("the member sees %v", got)
			}
			if got := m.tokens(m.owner); strings.Join(got, " ") != strings.Join(both, " ") {
				t.Errorf("the owner sees every token, not %v", got)
			}
			if r := m.json(m.member, "DELETE", "/api/tokens/"+owners, ""); r.Status != 404 || !strings.Contains(r.Text(), "unknown_token") {
				t.Errorf("the owner's token is not the member's to revoke: %d %s", r.Status, r.Body)
			}
			if got := m.tokens(m.owner); strings.Join(got, " ") != strings.Join(both, " ") {
				t.Errorf("still both: %v", got)
			}
			if r := m.json(m.member, "DELETE", "/api/tokens/"+mine, ""); r.Status != 200 {
				t.Errorf("the member's own: %d %s", r.Status, r.Body)
			}
			if r := m.json(m.member, "POST", "/api/observe-key/new?site=default", "{}"); r.Status != 403 {
				t.Errorf("a member replacing the agents key: %d %s", r.Status, r.Body)
			}
			if r := m.json(m.owner, "POST", "/api/observe-key/new?site=default", "{}"); r.Status != 200 {
				t.Errorf("the owner replacing it: %d %s", r.Status, r.Body)
			}
		})
	}
}

func TestSigningOutEndsTheAccountsSessionsEverywhereAndOnlyFromTheDashboardsOwnPages(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			m := newWithMember(t, kind)
			account := func(cookie string) int { return m.json(cookie, "GET", "/api/account", "").Status }
			other := cookieOf(m.signIn(""))
			if got := account(other); got != 200 {
				t.Fatalf("another browser: %d", got)
			}
			if r := m.do("GET", "/logout", "", "cookie", m.member, "sec-fetch-site", "cross-site"); r.Status != 403 {
				t.Errorf("another site cannot sign anyone out: %d", r.Status)
			}
			if got := account(other); got != 200 {
				t.Errorf("still signed in: %d", got)
			}
			if r := m.do("GET", "/logout", "", "cookie", m.member, "sec-fetch-site", "same-origin"); r.Status != 303 {
				t.Errorf("signing out: %d", r.Status)
			}
			if got := account(m.member); got != 401 {
				t.Errorf("the cookie copied before stops working: %d", got)
			}
			if got := account(other); got != 401 {
				t.Errorf("and so does the one in the other browser: %d", got)
			}
			if got := account(cookieOf(m.signIn(""))); got != 200 {
				t.Errorf("signing in again works: %d", got)
			}
		})
	}
}

func TestTheSignInFormsTakeAPostOnlyFromTheirOwnPages(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			m := newWithMember(t, kind)
			for _, site := range []string{"cross-site", "same-site"} {
				refused := m.signIn(site)
				if refused.Status != 403 {
					t.Errorf("%s: %d", site, refused.Status)
				}
				if refused.Header.Has("set-cookie") {
					t.Errorf("%s: a session is planted", site)
				}
			}
			if own := m.signIn("same-origin"); own.Status != 303 {
				t.Errorf("its own page: %d", own.Status)
			}
		})
	}
}

func TestANewPasswordCanTakeBackTheTokensTheAccountMade(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			m := newWithMember(t, kind)
			m.makeToken(m.member, "Kept")
			changed := m.json(m.member, "POST", "/api/account/password", `{"current":"a long password","next":"another long password"}`)
			fresh := cookieOf(changed)
			if got := m.tokens(fresh); len(got) != 1 {
				t.Errorf("kept unless asked: %v", got)
			}
			latest := cookieOf(m.json(fresh, "POST", "/api/account/password", `{"current":"another long password","next":"a third long password","revokeTokens":true}`))
			if got := m.tokens(latest); len(got) != 0 {
				t.Errorf("taken back: %v", got)
			}
		})
	}
}

// busyEvents is a database that says it is busy for the next few event inserts.
type busyEvents struct {
	runlight.Db
	fail atomic.Int32
}

func (b *busyEvents) Run(ctx context.Context, sql string, params ...any) error {
	if strings.Contains(sql, "INSERT INTO rl_events") && b.fail.Add(-1) >= 0 {
		return errors.New("SQLITE_BUSY: database is locked")
	}
	return b.Db.Run(ctx, sql, params...)
}

func TestAHitTriedAgainAfterTheStoreWasBusyCountsOnce(t *testing.T) {
	ctx := context.Background()
	db := &busyEvents{Db: Open(t, Kind{Name: "sqlite"})}
	store := runlight.NewStore(db)
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	now := october6
	rl, err := runlight.New(runlight.Options{Store: store, Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}, Timezone: "UTC"}, Logf: func(string, ...any) {}, Now: func() int64 { return now }})
	if err != nil {
		t.Fatal(err)
	}
	token := "secret"
	routes, err := rl.Routes(runlight.RoutesOptions{Token: &token})
	if err != nil {
		t.Fatal(err)
	}
	send := func(body string) {
		t.Helper()
		r := routes.Handle(ctx, web.NewRequest("POST", "https://example.com/runlight/e", web.NewHeaders("user-agent", chromeMac, "x-forwarded-for", "203.0.113.9"), []byte(body)))
		if r.Status != 202 {
			t.Fatalf("collect answered %d %s", r.Status, r.Body)
		}
		rl.Idle()
	}
	db.fail.Store(2)
	send(pageview("example.com", "/", "p1"))
	db.fail.Store(1)
	send(`{"k":"engagement","u":"https://example.com/","i":"p1","e":5000}`)
	rows, err := db.All(ctx, `SELECT pageviews, engaged_ms FROM rl_sessions`)
	if err != nil || len(rows) != 1 {
		t.Fatalf("%v %v", rows, err)
	}
	if fmt.Sprint(rows[0]["pageviews"]) != "1" || fmt.Sprint(rows[0]["engaged_ms"]) != "5000" {
		t.Errorf("the visit counted %v pageviews and %v ms", rows[0]["pageviews"], rows[0]["engaged_ms"])
	}
	if events, _ := db.All(ctx, `SELECT id FROM rl_events WHERE kind = 'pageview'`); len(events) != 1 {
		t.Errorf("%d pageview rows", len(events))
	}
}

func TestAFunnelOverMoreVisitsThanTheCapCountsTheNewestAndSaysSo(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind)
			h.store.FunnelVisits = 2
			for _, ip := range []string{"203.0.113.1", "203.0.113.2", "203.0.113.3"} {
				h.send(`{"k":"pageview","u":"https://example.com/pricing"}`, ip)
				h.now += minute
			}
			made := h.routes.Handle(h.ctx, web.NewRequest("POST", "https://example.com/runlight/api/funnels?site=default", web.NewHeaders("authorization", "Bearer secret", "content-type", "application/json"),
				[]byte(`{"name":"F","steps":[{"kind":"page","match":"/pricing"},{"kind":"page","match":"/thanks"}]}`)))
			if made.Status != 201 && made.Status != 200 {
				t.Fatalf("making the funnel: %d %s", made.Status, made.Body)
			}
			funnel := js.Dig(h.get("/api/funnels?period=today"), "funnels", 0)
			if got := js.Dig(funnel, "sampled"); fmt.Sprint(got) != "2" {
				t.Errorf("sampled %v", got)
			}
			if got := js.Dig(funnel, "steps", 0, "visits"); fmt.Sprint(got) != "2" {
				t.Errorf("the first step counted %v visits", got)
			}
			h.store.FunnelVisits = 10
			if funnel := js.Dig(h.get("/api/funnels?period=today"), "funnels", 0); funnel.(*js.Object).Has("sampled") {
				t.Errorf("sampled under the cap: %s", js.Stringify(funnel))
			}
		})
	}
}

func TestAnAutomaticLinkEventKeepsItsLinkWithoutTheQueryStringOrFragment(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind)
			h.send(`{"k":"event","u":"https://example.com/","n":"Outbound link","p":{"url":"https://other.example/reset?token=abc&email=a@b.example#top"}}`, "203.0.113.9")
			h.send(`{"k":"event","u":"https://example.com/","n":"File download","p":{"url":"https://example.com/a.pdf?sig=x"}}`, "203.0.113.9")
			h.send(`{"k":"event","u":"https://example.com/","n":"Signup","p":{"url":"https://example.com/?plan=pro"}}`, "203.0.113.9")
			h.rl.Idle()
			rows, err := h.db.All(h.ctx, `SELECT name, props FROM rl_events ORDER BY name`)
			if err != nil {
				t.Fatal(err)
			}
			got := []string{}
			for _, row := range rows {
				props, _ := js.Parse(fmt.Sprint(row["props"]))
				got = append(got, fmt.Sprint(row["name"])+" "+js.Str(js.Dig(props, "url")))
			}
			if want := "File download https://example.com/a.pdf|Outbound link https://other.example/reset|Signup https://example.com/?plan=pro"; strings.Join(got, "|") != want {
				t.Errorf("%v", got)
			}
		})
	}
}

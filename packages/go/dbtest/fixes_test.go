package dbtest

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	runlight "runlight.sh/go"
	"runlight.sh/go/internal/accounts"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/web"
)

// Of settings written at once, each one is won by exactly one writer, on every database.
func TestSettingsWrittenAtOnceAreWonOnce(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			store := Store(t, kind)
			var added, swapped atomic.Int64
			var wg sync.WaitGroup
			for i := range 12 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					won, err := store.AddSetting(ctx, "once", js.FormatNumber(float64(i)))
					if err != nil {
						t.Error(err)
					} else if won {
						added.Add(1)
					}
				}()
			}
			wg.Wait()
			if added.Load() != 1 {
				t.Fatalf("%d adds won, want 1", added.Load())
			}
			first, _, _ := store.Setting(ctx, "once")
			if won, _ := store.AddSetting(ctx, "once", "later"); won {
				t.Error("a setting there was written again")
			}
			if now, _, _ := store.Setting(ctx, "once"); now != first {
				t.Errorf("the setting moved from %q to %q", first, now)
			}
			for range 12 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					if won, err := store.SwapSetting(ctx, "once", first, "next"); err != nil {
						t.Error(err)
					} else if won {
						swapped.Add(1)
					}
				}()
			}
			wg.Wait()
			if swapped.Load() != 1 {
				t.Fatalf("%d swaps won, want 1", swapped.Load())
			}
			if won, _ := store.SwapSetting(ctx, "absent", "a", "b"); won {
				t.Error("a setting that is not there was swapped")
			}

			keys := make(chan string, 20)
			for range 20 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					key, err := store.SettingOrAdd(ctx, "oauth-key", func() string { return strings.Repeat("k", 8) + js.FormatNumber(float64(len(keys))) })
					if err != nil {
						t.Error(err)
					}
					keys <- key
				}()
			}
			wg.Wait()
			close(keys)
			saved, _, _ := store.Setting(ctx, "oauth-key")
			for key := range keys {
				if key != saved {
					t.Errorf("%q is not the key kept, %q", key, saved)
				}
			}
		})
	}
}

// A one-time code is accepted once, even by two stores on one database that do not wait on each other.
func TestACodeIsAcceptedOnceEvenByTwoStores(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			store := Store(t, kind)
			one := runlight.NewAccountStore(store, "a secret for the tests")
			two := runlight.NewAccountStore(store, "a secret for the tests")
			now := int64(1_791_806_400_000)
			user, err := one.SetPassword(ctx, "jon@example.com", "a long password", now, "")
			if err != nil {
				t.Fatal(err)
			}
			secret, err := one.StartTwoFactor(ctx, user.ID)
			if err != nil {
				t.Fatal(err)
			}
			code, _ := accounts.TOTP(secret, now/30_000)
			recovery, err := one.ConfirmTwoFactor(ctx, user.ID, code, now)
			if err != nil || len(recovery) == 0 {
				t.Fatalf("turning it on: %v %v", recovery, err)
			}
			// Both ask at once, five times over, each time with a step later than the last.
			for round := int64(1); round <= 5; round++ {
				at := now + round*60_000
				code, _ := accounts.TOTP(secret, at/30_000)
				if accepted := bothCheck(t, ctx, one, two, user.ID, code, code, at); accepted != 1 {
					t.Fatalf("round %d: %d of two accepted the same code, want 1", round, accepted)
				}
				if again, _ := one.CheckSecondFactor(ctx, user.ID, code, at); again {
					t.Fatalf("round %d: a code used was accepted again", round)
				}
			}
			// A recovery code works once, and one crossed off at the same moment elsewhere is not used twice.
			at := now + 10*60_000
			if accepted := bothCheck(t, ctx, one, two, user.ID, recovery[0], recovery[0], at); accepted != 1 {
				t.Fatalf("%d of two accepted the same recovery code, want 1", accepted)
			}
			after, _ := one.ByID(ctx, user.ID)
			if after.RecoveryLeft != len(recovery)-1 {
				t.Errorf("%d recovery codes left, want %d", after.RecoveryLeft, len(recovery)-1)
			}
			// Two different codes at once: no code is accepted twice or lost. One may need to try again.
			accepted := bothCheck(t, ctx, one, two, user.ID, recovery[1], recovery[2], at)
			left, _ := one.ByID(ctx, user.ID)
			if accepted < 1 || left.RecoveryLeft != len(recovery)-1-accepted {
				t.Errorf("%d accepted, %d left", accepted, left.RecoveryLeft)
			}
		})
	}
}

// bothCheck has two stores check a code each at once, and says how many were accepted.
func bothCheck(t *testing.T, ctx context.Context, one, two *runlight.AccountStore, id, codeOne, codeTwo string, now int64) int {
	t.Helper()
	var accepted atomic.Int64
	var wg sync.WaitGroup
	for store, code := range map[*runlight.AccountStore]string{one: codeOne, two: codeTwo} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := store.CheckSecondFactor(ctx, id, code, now)
			if err != nil {
				t.Error(err)
			}
			if ok {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	return int(accepted.Load())
}

// A site change refused for a bad domain changes nothing, retention and timezone included.
func TestASiteChangeRefusedForABadDomainChangesNothing(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			now := int64(1_759_276_800_000) // 2025-10-01
			rl, err := runlight.New(runlight.Options{Store: Store(t, kind), ManagedSites: true, Logf: func(string, ...any) {}, Now: func() int64 { return now }})
			if err != nil {
				t.Fatal(err)
			}
			token := "t"
			routes, err := rl.Routes(runlight.RoutesOptions{Token: &token})
			if err != nil {
				t.Fatal(err)
			}
			do := func(method, path string, headers []string, body string) *runlight.Response {
				t.Helper()
				var b []byte
				if body != "" {
					b = []byte(body)
				}
				return routes.Handle(ctx, web.NewRequest(method, "https://stats.example.com/runlight"+path, web.NewHeaders(headers...), b))
			}
			auth := []string{"authorization", "Bearer t", "content-type", "application/json"}
			for _, host := range []string{"blog.example.com", "shop.example.com"} {
				if r := do("POST", "/api/sites", auth, `{"hostnames":"`+host+`"}`); r.Status != 201 {
					t.Fatalf("adding %s: %d %s", host, r.Status, r.Body)
				}
			}
			agent := []string{"user-agent", "Mozilla/5.0 (Macintosh) Chrome/129.0.0.0 Safari/537.36", "x-forwarded-for", "203.0.113.1"}
			do("POST", "/e", agent, `{"k":"pageview","u":"https://blog.example.com/"}`)
			now = 1_791_806_400_000 // 2026-10-12
			zone, _, _ := rl.Store.Setting(ctx, "rollup-zone:blog.example.com")
			visits := func() float64 {
				r := do("GET", "/api/stats?site=blog.example.com&period=all", auth, "")
				v, _ := js.Parse(string(r.Body))
				return js.Num(js.Dig(v, "stats", "visits"))
			}
			if visits() != 1 {
				t.Fatalf("no visit to lose: %v", visits())
			}
			for _, hostnames := range []string{"not a domain", "shop.example.com"} {
				r := do("PATCH", "/api/sites/blog.example.com", auth, `{"retentionMonths":6,"timezone":"Europe/Paris","name":"Renamed","hostnames":`+js.Stringify(hostnames)+`}`)
				if r.Status != 400 {
					t.Fatalf("%s: %d %s", hostnames, r.Status, r.Body)
				}
				rl.Idle()
				if months, _ := rl.Retention(ctx, "blog.example.com"); months != nil {
					t.Errorf("%s: retention is %d", hostnames, *months)
				}
				if now, _, _ := rl.Store.Setting(ctx, "rollup-zone:blog.example.com"); now != zone {
					t.Errorf("%s: the built days were cleared", hostnames)
				}
				if site, _ := rl.Site("blog.example.com"); site.Name != "blog.example.com" || site.Timezone != "UTC" || len(site.Hostnames) != 1 || site.Hostnames[0] != "blog.example.com" {
					t.Errorf("%s: the site is now %+v", hostnames, site)
				}
				if visits() != 1 {
					t.Errorf("%s: the old visit is gone", hostnames)
				}
			}
			if r := do("PATCH", "/api/sites/blog.example.com", auth, `{"retentionMonths":6,"hostnames":"blog.example.com"}`); r.Status != 200 {
				t.Fatalf("a change that passes: %d %s", r.Status, r.Body)
			}
			rl.Idle()
			if visits() != 0 {
				t.Error("a change that passes prunes once saved")
			}
		})
	}
}

// Location headers from a hosting platform are believed only when proxy headers are trusted.
func TestAVisitsPlatformLocationCountsOnlyBehindATrustedProxy(t *testing.T) {
	ctx := context.Background()
	countries := func(ignoreProxy bool) string {
		rl, err := runlight.New(runlight.Options{Store: Store(t, Kinds()[0]), Site: &runlight.SiteOptions{Hostnames: []string{"x.com"}}, IgnoreProxy: ignoreProxy, Logf: func(string, ...any) {},
			Geo: func(string) (*runlight.Location, error) { return &runlight.Location{Country: "DE"}, nil }})
		if err != nil {
			t.Fatal(err)
		}
		token := "t"
		routes, err := rl.Routes(runlight.RoutesOptions{Token: &token})
		if err != nil {
			t.Fatal(err)
		}
		headers := web.NewHeaders("user-agent", "Mozilla/5.0 (Macintosh) Chrome/129.0.0.0 Safari/537.36", "x-forwarded-for", "203.0.113.5", "cf-ipcountry", "US")
		hit := web.NewRequest("POST", "https://x.com/runlight/e", headers, []byte(`{"k":"pageview","u":"https://x.com/"}`))
		hit.RemoteAddress = "203.0.113.5"
		routes.Handle(ctx, hit)
		rl.Idle()
		r := routes.Handle(ctx, web.NewRequest("GET", "https://x.com/runlight/api/breakdown?period=today&dimension=country", web.NewHeaders("authorization", "Bearer t"), nil))
		v, _ := js.Parse(string(r.Body))
		return js.Stringify(js.Dig(v, "rows"))
	}
	if got := countries(true); !strings.Contains(got, `"DE"`) || strings.Contains(got, `"US"`) {
		t.Errorf("without a proxy in front the lookup answers: %s", got)
	}
	if got := countries(false); !strings.Contains(got, `"US"`) {
		t.Errorf("behind one the platform's header comes first: %s", got)
	}
}

// On a server set to NO_BACKSLASH_ESCAPES, a value with a quote and a backslash in it reads back as itself:
// every session drops that mode, an app's own pool's too, so a quote never ends a value early.
func TestAValueReadsBackAsItselfOnAServerSetToNoBackslashEscapes(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		if kind.Name != "mysql" && kind.Name != "mariadb" {
			continue
		}
		t.Run(kind.Name, func(t *testing.T) {
			lock, _ := mysqlLocks.LoadOrStore(kind.URL, &sync.Mutex{})
			lock.(*sync.Mutex).Lock()
			defer lock.(*sync.Mutex).Unlock()
			dsn, err := MySQLDSN(kind.URL)
			if err != nil {
				t.Fatal(err)
			}
			admin, err := sql.Open("mysql", dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer admin.Close()
			var before string
			if err := admin.QueryRowContext(ctx, "SELECT @@GLOBAL.sql_mode").Scan(&before); err != nil {
				t.Fatal(err)
			}
			mode := "NO_BACKSLASH_ESCAPES"
			if before != "" {
				mode = before + ",NO_BACKSLASH_ESCAPES"
			}
			if _, err := admin.ExecContext(ctx, "SET GLOBAL sql_mode = ?", mode); err != nil {
				t.Skipf("cannot set the server's sql_mode: %v", err)
			}
			defer admin.ExecContext(context.WithoutCancel(ctx), "SET GLOBAL sql_mode = ?", before)
			// A pool opened after the change, as an app's own would be.
			pool, err := sql.Open("mysql", dsn)
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			d := runlight.MySQL(pool)
			rows, err := d.All(ctx, "SELECT @@SESSION.sql_mode AS mode")
			if err != nil {
				t.Fatal(err)
			}
			if got, _ := rows[0]["mode"].(string); strings.Contains(got, "NO_BACKSLASH_ESCAPES") {
				t.Fatalf("session still has NO_BACKSLASH_ESCAPES: %s", got)
			}
			for _, value := range []string{`x\' OR '1'='1`, `it's`, `back\slash`, `\`, `'`, `\\'`} {
				rows, err := d.All(ctx, "SELECT ? AS v", value)
				if err != nil {
					t.Fatalf("%q: %v", value, err)
				}
				if got := fmt.Sprint(rows[0]["v"]); got != value {
					t.Fatalf("%q read back as %q", value, got)
				}
			}
		})
	}
}

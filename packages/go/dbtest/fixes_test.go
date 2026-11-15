package dbtest

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

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

// plainDb is a Db with no transactions of its own, so the store, or a prefixed Db, runs BEGIN and COMMIT itself.
type plainDb struct{ runlight.Db }

// A transaction that ends in an error, a request that went away, or a panic is rolled back, and leaves
// the database as it was for whatever comes next, on every database and each way a transaction is run.
func TestATransactionIsRolledBackHoweverItEnds(t *testing.T) {
	bg := context.Background()
	stores := func(t *testing.T, kind Kind) map[string]*runlight.Store {
		out := map[string]*runlight.Store{"the database's own": Store(t, kind)}
		if kind.Name == "sqlite" {
			// One connection, so BEGIN and COMMIT sent as statements hold a transaction, as on a database without them.
			out["the store's"] = runlight.NewStore(plainDb{Store(t, kind).DB()})
			prefixed, err := runlight.Prefixed(plainDb{open(t, kind)}, TestPrefix)
			if err != nil {
				t.Fatal(err)
			}
			store := runlight.NewStore(prefixed)
			if err := store.Migrate(bg); err != nil {
				t.Fatal(err)
			}
			out["a prefixed Db's"] = store
		}
		return out
	}
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			for name, store := range stores(t, kind) {
				t.Run(name, func(t *testing.T) {
					within := func(what string, fn func()) {
						t.Helper()
						done := make(chan struct{})
						go func() { defer close(done); fn() }()
						select {
						case <-done:
						case <-time.After(20 * time.Second):
							t.Fatalf("%s: the transaction never ended", what)
						}
					}
					after := func(what string) {
						t.Helper()
						if _, has, err := store.Setting(bg, "inside"); err != nil || has {
							t.Fatalf("%s: what the transaction wrote is still there: %v %v", what, has, err)
						}
						// The next transaction starts, and what it writes is kept.
						if err := store.Transaction(bg, func(tx *runlight.Store) error { return tx.SetSetting(bg, "next", ptr(what)) }); err != nil {
							t.Fatalf("%s: the next transaction: %v", what, err)
						}
						if got, _, err := store.Setting(bg, "next"); err != nil || got != what {
							t.Fatalf("%s: the next transaction's write: %q %v", what, got, err)
						}
						// And a write outside one is not left inside an open transaction: rolling back undoes nothing.
						if err := store.SetSetting(bg, "outside", ptr(what)); err != nil {
							t.Fatal(err)
						}
						_ = store.DB().Run(bg, "ROLLBACK")
						if got, _, err := store.Setting(bg, "outside"); err != nil || got != what {
							t.Fatalf("%s: a later write was not kept: %q %v", what, got, err)
						}
					}

					within("an error", func() {
						err := store.Transaction(bg, func(tx *runlight.Store) error {
							if err := tx.SetSetting(bg, "inside", ptr("1")); err != nil {
								return err
							}
							return errors.New("stop")
						})
						if err == nil || err.Error() != "stop" {
							t.Errorf("an error: %v", err)
						}
					})
					after("an error")

					within("a request that went away", func() {
						ctx, cancel := context.WithCancel(bg)
						defer cancel()
						err := store.Transaction(ctx, func(tx *runlight.Store) error {
							if err := tx.SetSetting(ctx, "inside", ptr("1")); err != nil {
								return err
							}
							cancel()
							return tx.SetSetting(ctx, "inside", ptr("2"))
						})
						if err == nil {
							t.Error("a request that went away: no error")
						}
					})
					after("a request that went away")

					within("a panic", func() {
						defer func() {
							if recover() == nil {
								t.Error("a panic: it did not reach the caller")
							}
						}()
						_ = store.Transaction(bg, func(tx *runlight.Store) error {
							if err := tx.SetSetting(bg, "inside", ptr("1")); err != nil {
								return err
							}
							panic("fell over")
						})
					})
					after("a panic")
				})
			}
		})
	}
}

// A row whose hostname is none, as another tool's export may hold, is imported under the site's own
// name, and never stops the import or the store.
func TestAVisitWithAHostnameThatIsNoneIsImported(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind)
			rows, _ := js.Parse(`[{"time":"2026-10-01T10:00:00Z","path":"/pricing","hostname":"a b"},{"time":"2026-10-01T10:00:05Z","path":"/","hostname":"example.com"}]`)
			result, err := runlight.ImportCsvVisits(h.ctx, h.rl, "default", rows, nil)
			if err != nil {
				t.Fatal(err)
			}
			if result.Pageviews != 2 || result.Visits != 2 {
				t.Errorf("imported %d pageviews in %d visits, want 2 in 2", result.Pageviews, result.Visits)
			}
			found, err := h.db.All(h.ctx, `SELECT hostname FROM rl_events WHERE path = ?`, "/pricing")
			if err != nil || len(found) != 1 || found[0]["hostname"] != "example.com" {
				t.Errorf("the row with no real hostname: %v %v", found, err)
			}
		})
	}
}

// The consent form's answer counts only from the page that showed it. A target starting // or /\ is a
// path here, never another host, so it cannot make another site's form look like this one's.
func TestAConsentFormPostedFromAnotherSiteIsRefusedWhateverItsTarget(t *testing.T) {
	ctx := context.Background()
	store := Store(t, Kinds()[0])
	rl, err := runlight.New(runlight.Options{Store: store, Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}}, Logf: func(string, ...any) {}, Secret: ptr("a server secret long enough")})
	if err != nil {
		t.Fatal(err)
	}
	routes, err := rl.Routes(runlight.RoutesOptions{BasePath: ptr(""), Open: true})
	if err != nil {
		t.Fatal(err)
	}
	registered := routes.Handle(ctx, web.NewRequest("POST", "https://stats.example.com/oauth/register", web.NewHeaders("content-type", "application/json"),
		[]byte(`{"client_name":"x","redirect_uris":["https://attacker.example/cb"]}`)))
	client, _ := js.Parse(string(registered.Body))
	id := js.Str(js.Dig(client, "client_id"))
	if id == "" {
		t.Fatalf("registering: %d %s", registered.Status, registered.Body)
	}
	form := url.Values{"response_type": {"code"}, "client_id": {id}, "redirect_uri": {"https://attacker.example/cb"},
		"code_challenge": {strings.Repeat("a", 43)}, "code_challenge_method": {"S256"}, "decision": {"allow"}, "site": {""}}.Encode()
	post := func(target, origin string) *httptest.ResponseRecorder {
		req := &http.Request{Method: "POST", Host: "stats.example.com", RequestURI: target, URL: &url.URL{Path: "/"}, Body: io.NopCloser(strings.NewReader(form)),
			Header: http.Header{"X-Forwarded-Proto": {"https"}, "Content-Type": {"application/x-www-form-urlencoded"}, "Origin": {origin}}}
		w := httptest.NewRecorder()
		routes.ServeHTTP(w, req)
		return w
	}
	if w := post("/oauth/authorize", "https://stats.example.com"); w.Code != 303 || !strings.HasPrefix(w.Header().Get("location"), "https://attacker.example/cb?code=") {
		t.Fatalf("the form from its own page: %d %s", w.Code, w.Header().Get("location"))
	}
	if w := post("/oauth/authorize", "https://attacker.example"); w.Code != 403 {
		t.Errorf("the form from another site: %d", w.Code)
	}
	for _, target := range []string{"//attacker.example/oauth/authorize", `/\attacker.example/oauth/authorize`} {
		if w := post(target, "https://attacker.example"); w.Code == 303 || strings.Contains(w.Header().Get("location"), "code=") {
			t.Errorf("%s: another site's form was allowed: %d %s", target, w.Code, w.Header().Get("location"))
		}
	}
}

// An account kept to one site is refused the OAuth pages, by their path: a report whose address
// merely holds /oauth/, as a filter on such a page does, is read as any other.
func TestAnAccountKeptToASiteReadsAReportWhoseFilterNamesAnOAuthPath(t *testing.T) {
	defer accounts.SetCostForTests(16, 8, 1)()
	ctx := context.Background()
	store := Store(t, Kinds()[0])
	secret := "a server secret long enough"
	now := int64(1_791_806_400_000)
	rl, err := runlight.New(runlight.Options{Store: store, Site: &runlight.SiteOptions{Hostnames: []string{"example.com"}}, Logf: func(string, ...any) {}, Now: func() int64 { return now }, Secret: &secret})
	if err != nil {
		t.Fatal(err)
	}
	routes, err := rl.Routes(runlight.RoutesOptions{Token: ptr("t"), Accounts: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := rl.Init(ctx); err != nil {
		t.Fatal(err)
	}
	users := runlight.NewAccountStore(store, secret)
	if _, err := users.SetPassword(ctx, "owner@example.com", "a long password", now, ""); err != nil {
		t.Fatal(err)
	}
	viewer, err := users.SetPassword(ctx, "viewer@example.com", "a long password", now, "viewer", "default")
	if err != nil {
		t.Fatal(err)
	}
	session, err := users.SessionFor(viewer, now)
	if err != nil {
		t.Fatal(err)
	}
	get := func(path string) int {
		return routes.Handle(ctx, web.NewRequest("GET", "https://stats.example.com/runlight"+path, web.NewHeaders("cookie", runlight.SessionCookie+"="+url.QueryEscape(session)), nil)).Status
	}
	if got := get("/api/stats?filter=page:contains:/oauth/"); got != 200 {
		t.Errorf("a report filtered to /oauth/ pages: %d", got)
	}
	if got := get("/oauth/authorize?client_id=x"); got == 200 {
		t.Errorf("the OAuth pages: %d", got)
	}
}

// Connections of a pool Runlight owns are set up at once, each asking which server it is.
func TestMySQLConnectionsSetUpAtOnceAgreeOnTheServer(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		if !strings.HasPrefix(kind.Name, "mysql") && !strings.HasPrefix(kind.Name, "mariadb") || kind.Prefix != "" {
			continue
		}
		t.Run(kind.Name, func(t *testing.T) {
			dsn, err := MySQLDSN(kind.URL)
			if err != nil {
				t.Fatal(err)
			}
			pool, err := sql.Open("mysql", dsn)
			if err != nil {
				t.Fatal(err)
			}
			d := runlight.MySQL(pool).Owned(120_000)
			defer d.Close()
			var wg sync.WaitGroup
			for range 12 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					if rows, err := d.All(ctx, "SELECT 1 AS n"); err != nil || len(rows) != 1 {
						t.Errorf("%v %v", rows, err)
					}
				}()
			}
			wg.Wait()
		})
	}
}

// A newer day's salt is never deleted: a process whose clock is a moment behind must not delete the salt
// another has just made for the day that began.
func TestDroppingSaltsLeavesANewerDaysAlone(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			store := Store(t, kind)
			for _, day := range []string{"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"} {
				if _, err := store.Salt(ctx, day, "salt-"+day); err != nil {
					t.Fatal(err)
				}
			}
			if err := store.DropSaltsExcept(ctx, []string{"2026-10-03", "2026-10-02"}); err != nil {
				t.Fatal(err)
			}
			rows, err := store.DB().All(ctx, "SELECT day FROM rl_salts ORDER BY day")
			if err != nil {
				t.Fatal(err)
			}
			days := []string{}
			for _, r := range rows {
				days = append(days, fmt.Sprint(r["day"]))
			}
			if got := strings.Join(days, " "); got != "2026-10-02 2026-10-03 2026-10-04" {
				t.Errorf("salts left: %s", got)
			}
		})
	}
}

// An event whose props the database cannot read as JSON (an escaped NUL, half a surrogate pair) counts as one
// with no props, and never fails the reports that read its event.
func TestPropsTheDatabaseCannotReadCountAsNone(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind)
			for i, plan := range []string{"free", "pro", "team"} {
				ip := fmt.Sprintf("198.51.100.%d", i+1)
				h.send(`{"k":"pageview","u":"https://example.com/","i":"pv`+fmt.Sprint(i)+`"}`, ip)
				h.send(`{"k":"event","u":"https://example.com/","n":"signup","i":"pv`+fmt.Sprint(i)+`","p":{"plan":"`+plan+`","amount":"`+fmt.Sprint(10*(i+1))+`"}}`, ip)
			}
			// As a tracker's props were kept before they were cleaned: valid JSON that Postgres and MySQL will not read.
			for plan, text := range map[string]string{"pro": `{"plan":"a\u0000","amount":"20"}`, "team": `{"plan":"a\ud83d","amount":"30"}`} {
				if err := h.db.Run(h.ctx, `UPDATE rl_events SET props = ? WHERE kind = 'event' AND props LIKE ?`, text, `%`+plan+`%`); err != nil {
					t.Fatal(err)
				}
			}
			query := runlight.Query{Site: "default", From: h.now - 86_400_000, To: h.now + 86_400_000}
			keys, err := h.store.EventPropKeys(h.ctx, query, "signup")
			if err != nil {
				t.Fatalf("the property names: %v", err)
			}
			values, err := h.store.EventPropValues(h.ctx, query, "signup", "plan", 10)
			if err != nil {
				t.Fatalf("the property's values: %v", err)
			}
			goal := runlight.GoalRow{ID: "g", Site: "default", Name: "Signup", Kind: "event", Match: "signup", ValueMode: "prop", ValueProp: "amount"}
			totals, err := h.store.GoalTotals(h.ctx, query, goal)
			if err != nil {
				t.Fatalf("a goal worth a property: %v", err)
			}
			if totals.Conversions != 3 || len(keys) != 2 || len(values) == 0 {
				t.Errorf("3 signups read as %d, with %d property names and %d values", totals.Conversions, len(keys), len(values))
			}
			free := false
			for _, v := range values {
				free = free || v.Value == "free"
			}
			if !free || totals.Revenue < 10 {
				t.Errorf("the readable event's props were lost: %+v, revenue %v", values, totals.Revenue)
			}
		})
	}
}

// A breakdown read from built days and the visits left over is the one read from the visits alone, page by page.
func TestABreakdownFromBuiltDaysIsTheOneFromTheVisits(t *testing.T) {
	for _, kind := range Kinds() {
		t.Run(kind.Name, func(t *testing.T) {
			h := newAudit(t, kind)
			start := h.now
			pages := []string{"/", "/pricing", "/docs", "/blog", "/about"}
			for day := range 3 {
				h.now = start + int64(day)*86_400_000
				for visitor := range 6 {
					ip := fmt.Sprintf("198.51.%d.%d", 100+day, visitor+1)
					for view := 0; view <= visitor%len(pages); view++ {
						id := fmt.Sprintf("pv%d%d%d", day, visitor, view)
						h.send(`{"k":"pageview","u":"https://example.com`+pages[(view+day)%len(pages)]+`?utm_source=s`+fmt.Sprint(visitor%3)+`","i":"`+id+`"}`, ip)
						h.send(`{"k":"engagement","u":"https://example.com`+pages[(view+day)%len(pages)]+`","i":"`+id+`","e":`+fmt.Sprint(1000*(view+1))+`,"d":`+fmt.Sprint(10*(view+1))+`}`, ip)
						if view == 1 {
							h.send(`{"k":"event","u":"https://example.com/","n":"signup`+fmt.Sprint(visitor%2)+`","i":"`+id+`"}`, ip)
						}
					}
				}
			}
			h.now = start + 3*86_400_000 + 3*3_600_000
			query := runlight.Query{Site: "default", From: start - 86_400_000, To: h.now}
			read := func() string {
				out := []string{}
				for _, dimension := range []string{"page", "event", "source", "entry", "exit", "browser"} {
					for _, at := range [][2]int{{100, 0}, {2, 0}, {2, 2}, {2, 4}} {
						rows, err := h.store.Breakdown(h.ctx, query, dimension, at[0], at[1])
						if err != nil {
							t.Fatalf("%s: %v", dimension, err)
						}
						out = append(out, dimension+" "+fmt.Sprint(at)+" "+js.Stringify(rows))
					}
				}
				return strings.Join(out, "\n")
			}
			raw := read()
			made, err := h.rl.BuildRollups(h.ctx)
			if err != nil || made == 0 {
				t.Fatalf("built %d days: %v", made, err)
			}
			if rolled := read(); rolled != raw {
				t.Errorf("with %d days built:\n%s\nfrom the visits:\n%s", made, rolled, raw)
			}
			if !strings.Contains(raw, `"/pricing"`) || !strings.Contains(raw, `"signup1"`) {
				t.Errorf("nothing to compare: %s", raw)
			}
		})
	}
}

// The standalone server keeps its own one-segment paths back from new links, believes a forwarded host only
// from a proxy it believes, and counts wrong guesses at a token short enough to guess.
func TestTheServerKeepsItsOwnPathsAndCountsGuessesAtAShortToken(t *testing.T) {
	s := makeServer(t, "short-token", "")
	bearer := []string{"authorization", "Bearer short-token", "content-type", "application/json"}
	if r := s.do("POST", "/api/sites", "", `{"hostnames":"example.com"}`, bearer...); r.Status != 201 {
		t.Fatalf("adding a site: %d %s", r.Status, r.Body)
	}
	for _, slug := range []string{"login", "api", "mcp", "e", "embed", "healthz", "pick-return"} {
		r := s.do("POST", "/api/links?site=example.com", "", `{"url":"https://example.org/","slug":"`+slug+`"}`, bearer...)
		if r.Status != 400 || !strings.Contains(r.Text(), `"link_reserved"`) {
			t.Errorf("a link at /%s: %d %s", slug, r.Status, r.Body)
		}
	}
	if r := s.do("POST", "/api/links?site=example.com", "", `{"url":"https://example.org/","slug":"sale"}`, bearer...); r.Status != 201 {
		t.Errorf("a link at /sale: %d %s", r.Status, r.Body)
	}

	// Ten wrong guesses from one address, and that address's tries are all refused, the right one too.
	guess := func(token, remote string) int {
		req := web.NewRequest("GET", "https://stats.example.com/api/sites", web.NewHeaders("host", "stats.example.com", "authorization", "Bearer "+token), nil)
		req.RemoteAddress = remote
		return s.server.Handle(context.Background(), req).Status
	}
	for i := range 10 {
		if got := guess(fmt.Sprintf("guess-%d", i), "8.8.8.8"); got != 401 {
			t.Fatalf("guess %d: %d", i+1, got)
		}
	}
	// A token made in Settings is never a guess at this one.
	for range 20 {
		guess("rl_0000000000000000000000000000000000000000", "8.8.4.4")
	}
	if got := guess("short-token", "8.8.8.8"); got != 401 {
		t.Errorf("the right token after ten wrong guesses from the same address: %d", got)
	}
	if got := guess("short-token", "8.8.4.4"); got != 200 {
		t.Errorf("the right token from another address: %d", got)
	}

	// A long token cannot be guessed, so nothing is counted for it.
	long := makeServer(t, strings.Repeat("t", 40), "")
	for i := range 12 {
		req := web.NewRequest("GET", "https://stats.example.com/api/sites", web.NewHeaders("host", "stats.example.com", "authorization", fmt.Sprintf("Bearer guess-%d", i)), nil)
		req.RemoteAddress = "8.8.8.8"
		long.server.Handle(context.Background(), req)
	}
	req := web.NewRequest("GET", "https://stats.example.com/api/sites", web.NewHeaders("host", "stats.example.com", "authorization", "Bearer "+strings.Repeat("t", 40)), nil)
	req.RemoteAddress = "8.8.8.8"
	if got := long.server.Handle(context.Background(), req).Status; got != 200 {
		t.Errorf("a long token after wrong guesses: %d", got)
	}
}

// A forwarded host names the server only from a proxy that is believed: the public address, where short links
// never answer, cannot be claimed by a client that connects straight from the internet.
func TestTheServersNameIsReadFromAProxyOnlyWhenItIsBelieved(t *testing.T) {
	s := makeServer(t, strings.Repeat("t", 40), "https://stats.example.com")
	bearer := []string{"authorization", "Bearer " + strings.Repeat("t", 40), "content-type", "application/json"}
	if r := s.do("POST", "/api/sites", "", `{"hostnames":"example.com"}`, bearer...); r.Status != 201 {
		t.Fatalf("adding a site: %d %s", r.Status, r.Body)
	}
	if err := s.server.Runlight.Store.AddLinkDomain(context.Background(), "go.example.net", "example.com", 1); err != nil {
		t.Fatal(err)
	}
	s.server.Runlight.ForgetLinkDomains()
	from := func(remote string) int {
		req := web.NewRequest("GET", "https://go.example.net/nothing-here", web.NewHeaders("host", "go.example.net", "x-forwarded-host", "stats.example.com"), nil)
		req.RemoteAddress = remote
		r := s.server.Handle(context.Background(), req)
		if strings.HasPrefix(r.Header.Get("content-type"), "text/plain") {
			return 1
		}
		return 0
	}
	// From a public address the forwarded name is not believed, so the request is the link domain's: its own plain 404.
	if from("8.8.8.8") != 1 {
		t.Error("a client on a public address named the server's host itself")
	}
	// From a proxy on a private address it is, and the request is the server's own.
	if from("10.0.0.2") != 0 {
		t.Error("a proxy's forwarded host was not believed")
	}
}

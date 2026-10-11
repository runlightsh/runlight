package dbtest

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	runlight "runlight.sh/go"
)

// names are every table and index name in the database, as each dialect lists them.
func names(t *testing.T, db runlight.Db) []string {
	t.Helper()
	var query string
	switch db.Dialect() {
	case "sqlite":
		query = `SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\'`
	case "postgres":
		query = `SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'i', 'S')`
	default:
		query = `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()
           UNION SELECT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name <> 'PRIMARY'`
	}
	rows, err := db.All(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, row := range rows {
		out = append(out, strings.TrimSpace(toString(row["name"])))
	}
	sort.Strings(out)
	return out
}

func toString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// sharedPair opens one database twice, as two processes would: raw is a Db with its tables under rl_, and
// open a new Db on the same database each time it is called.
func sharedPair(t *testing.T, kind Kind) (raw *runlight.SQLDB, open func() *runlight.SQLDB) {
	t.Helper()
	ctx := context.Background()
	var dbs []*runlight.SQLDB
	t.Cleanup(func() {
		for _, d := range dbs {
			d.Close()
		}
	})
	made := func(driver, dsn string, of func(*sql.DB) *runlight.SQLDB) func() *runlight.SQLDB {
		return func() *runlight.SQLDB {
			db, err := sql.Open(driver, dsn)
			if err != nil {
				t.Fatal(err)
			}
			d := of(db).Owned(0)
			dbs = append(dbs, d)
			return d
		}
	}
	switch kind.Name {
	case "sqlite":
		open = made("sqlite", filepath.Join(t.TempDir(), "shared.db"), runlight.SQLite)
	case "postgres":
		b := make([]byte, 5)
		_, _ = rand.Read(b)
		schema := "rl_go_" + hex.EncodeToString(b)
		admin, err := sql.Open("pgx", kind.URL)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := admin.ExecContext(ctx, `CREATE SCHEMA "`+schema+`"`); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = admin.ExecContext(ctx, `DROP SCHEMA IF EXISTS "`+schema+`" CASCADE`)
			admin.Close()
		})
		sep := "?"
		if strings.Contains(kind.URL, "?") {
			sep = "&"
		}
		open = made("pgx", kind.URL+sep+"search_path="+schema, runlight.Postgres)
	default:
		dsn, err := MySQLDSN(kind.URL)
		if err != nil {
			t.Fatal(err)
		}
		lock, _ := mysqlLocks.LoadOrStore(kind.URL, &sync.Mutex{})
		lock.(*sync.Mutex).Lock()
		open = made("mysql", dsn, runlight.MySQL)
		raw := open()
		if err := DropTables(ctx, raw.DB()); err != nil {
			lock.(*sync.Mutex).Unlock()
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_ = DropTables(ctx, raw.DB())
			lock.(*sync.Mutex).Unlock()
		})
		return raw, open
	}
	return open(), open
}

// A prefix keeps a second set of tables beside the first in one database.
func TestAPrefixKeepsASecondSetOfTablesInOneDatabase(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		if kind.Prefix != "" {
			continue
		}
		t.Run(kind.Name, func(t *testing.T) {
			raw, open := sharedPair(t, kind)
			prefixed := func() *runlight.Store {
				store, err := runlight.NewStoreWithPrefix(open(), "wp_rl_")
				if err != nil {
					t.Fatal(err)
				}
				return store
			}
			other := prefixed()
			if err := other.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			// A second process with the same prefix finds every table and index already there.
			if err := prefixed().Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			made := names(t, raw)
			if len(made) == 0 {
				t.Fatal("no tables")
			}
			for _, name := range made {
				if !strings.HasPrefix(name, "wp_rl_") {
					t.Errorf("%s is not under the prefix", name)
				}
			}
			want := []string{}
			for _, table := range runlight.Tables {
				want = append(want, "wp_rl_"+table)
			}
			if got := other.Tables(); !slices.Equal(got, want) || other.Prefix() != "wp_rl_" {
				t.Errorf("tables %v, prefix %s", got, other.Prefix())
			}
			// The store's 15 tables, listed for removing them.
			for _, table := range other.Tables()[:15] {
				if !slices.Contains(made, table) {
					t.Errorf("%s was not made", table)
				}
			}

			plain := runlight.NewStore(raw)
			if err := plain.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			count := 0
			for _, name := range names(t, raw) {
				if rest, ok := strings.CutPrefix(name, runlight.Prefix); ok && slices.Contains(runlight.Tables, rest) {
					count++
				}
			}
			if count != 15 {
				t.Errorf("%d rl_ tables", count)
			}
			site := func(id string) runlight.SiteRow {
				return runlight.SiteRow{ID: id, Name: id, Hostnames: []string{id + ".example"}, Timezone: "UTC"}
			}
			if err := plain.UpsertSite(ctx, site("first"), 1); err != nil {
				t.Fatal(err)
			}
			if err := other.UpsertSite(ctx, site("second"), 1); err != nil {
				t.Fatal(err)
			}
			ids := func(store *runlight.Store) []string {
				sites, err := store.Sites(ctx)
				if err != nil {
					t.Fatal(err)
				}
				out := []string{}
				for _, s := range sites {
					out = append(out, s.ID)
				}
				return out
			}
			if got := ids(plain); !slices.Equal(got, []string{"first"}) {
				t.Errorf("rl_ sites %v", got)
			}
			if got := ids(other); !slices.Equal(got, []string{"second"}) {
				t.Errorf("wp_rl_ sites %v", got)
			}
			var inside []string
			if err := other.Transaction(ctx, func(tx *runlight.Store) error {
				inside = ids(tx)
				return nil
			}); err != nil || !slices.Equal(inside, []string{"second"}) {
				t.Errorf("a transaction keeps the prefix: %v %v", inside, err)
			}
			wp := "wp"
			if err := other.SetSetting(ctx, "k", &wp); err != nil {
				t.Fatal(err)
			}
			if _, has, _ := plain.Setting(ctx, "k"); has {
				t.Error("the rl_ store sees the wp_rl_ setting")
			}
			if v, _, _ := other.Setting(ctx, "k"); v != "wp" {
				t.Errorf("the wp_rl_ setting is %q", v)
			}
		})
	}
}

func TestATablePrefixIsLettersDigitsAndUnderscores(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	d := runlight.SQLite(db).Owned(0)
	defer d.Close()
	for _, prefix := range []string{"1rl_", "rl-", "rl_; DROP TABLE x", "", strings.Repeat("a", 33)} {
		if _, err := runlight.NewStoreWithPrefix(d, prefix); err == nil || err.Error() != "Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit" {
			t.Errorf("%q: %v", prefix, err)
		}
	}
	for _, prefix := range []string{"rl_", "wp_rl_", "_x", strings.Repeat("A", 32)} {
		if store, err := runlight.NewStoreWithPrefix(d, prefix); err != nil || store.Prefix() != prefix {
			t.Errorf("%q: %v", prefix, err)
		}
	}
	prefixed, err := runlight.Prefixed(d, "wp_rl_")
	if err != nil {
		t.Fatal(err)
	}
	if runlight.NewStore(prefixed).Prefix() != "wp_rl_" {
		t.Error("a store over a prefixed Db keeps its prefix")
	}
	if store, _ := runlight.NewStoreWithPrefix(prefixed, "other_"); store.Prefix() != "wp_rl_" {
		t.Error("a store over a prefixed Db keeps its own prefix")
	}
	if got := runlight.NewStore(d).Tables()[:2]; !slices.Equal(got, []string{"rl_meta", "rl_sites"}) {
		t.Errorf("tables %v", got)
	}
}

// A new SQLite file is for its owner and group alone, and so are the files SQLite makes beside it.
func TestANewSQLiteFileIsForItsOwnerAndGroup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows has no such modes")
	}
	file := filepath.Join(t.TempDir(), "mode.db")
	db, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	d := runlight.SQLite(db).Owned(0)
	defer d.Close()
	store := runlight.NewStore(d)
	ctx := context.Background()
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	v := "v"
	if err := store.SetSetting(ctx, "k", &v); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{file, file + "-wal"} {
		info, err := os.Stat(name)
		if err != nil {
			t.Fatal(err)
		}
		if mode := info.Mode().Perm(); mode != 0o660 {
			t.Errorf("%s is %o", filepath.Base(name), mode)
		}
	}
}

// An index left unusable is built again under a prefix that itself starts rl_, dropped under its own name
// rather than with the prefix put on twice.
func TestAnUnusableIndexIsBuiltAgainUnderAPrefixStartingRl(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		if kind.Name != "postgres" {
			continue
		}
		raw, open := sharedPair(t, kind)
		migrate := func() {
			t.Helper()
			store, err := runlight.NewStoreWithPrefix(open(), "rl_wp_")
			if err != nil {
				t.Fatal(err)
			}
			if err := store.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
		}
		migrate()
		// As a concurrent build stopped part way leaves it.
		if err := raw.Run(ctx, `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'rl_wp_events_site_ts'::regclass`); err != nil {
			t.Fatal(err)
		}
		migrate()
		rows, err := raw.All(ctx, `SELECT i.indisvalid AS valid FROM pg_index i WHERE i.indexrelid = 'rl_wp_events_site_ts'::regclass`)
		if err != nil || len(rows) != 1 || rows[0]["valid"] != true {
			t.Fatalf("%v %v", rows, err)
		}
	}
}

// Waiting for another process creating the tables gives up after the lock wait.
func TestWaitingForTheTablesGivesUp(t *testing.T) {
	ctx := context.Background()
	for _, kind := range Kinds() {
		if kind.Name == "sqlite" || kind.Prefix != "" {
			continue
		}
		t.Run(kind.Name, func(t *testing.T) {
			raw, open := sharedPair(t, kind)
			// The lock every Runlight takes to create tables, held by another session.
			held, err := raw.DB().Conn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer held.Close()
			if kind.Name == "postgres" {
				// Asked for again and again, as the stores do, since waiting on it could deadlock with an
				// index another test is building concurrently.
				for {
					var ok bool
					if err := held.QueryRowContext(ctx, "SELECT pg_try_advisory_lock(7331906)").Scan(&ok); err != nil {
						t.Fatal(err)
					}
					if ok {
						break
					}
					time.Sleep(50 * time.Millisecond)
				}
			} else {
				var ok int64
				if err := held.QueryRowContext(ctx, "SELECT GET_LOCK(CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48)), 0)").Scan(&ok); err != nil || ok != 1 {
					t.Fatalf("the lock: %d %v", ok, err)
				}
			}
			started := time.Now()
			err = runlight.NewStore(open().WaitForTables(time.Second)).Migrate(ctx)
			var busy *runlight.TablesBusyError
			if !errors.As(err, &busy) || !strings.Contains(err.Error(), "had not finished after 1 seconds") {
				t.Fatalf("%v, want a TablesBusyError", err)
			}
			if waited := time.Since(started); waited > 5*time.Second {
				t.Errorf("waited %v", waited)
			}
			release := "SELECT pg_advisory_unlock(7331906)"
			if kind.Name != "postgres" {
				release = "DO RELEASE_LOCK(CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48)))"
			}
			if _, err := held.ExecContext(ctx, release); err != nil {
				t.Fatal(err)
			}
			if err := runlight.NewStore(open().WaitForTables(time.Second)).Migrate(ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}

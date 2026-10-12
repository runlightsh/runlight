package runlight

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// settingsDb is a database of settings alone, with the compare-and-set a real one gives
// and no lock, so what holds under it holds on SQLite and the databases without one.
type settingsDb struct {
	mu   sync.Mutex
	rows map[string]string
}

func newSettingsDb() *settingsDb { return &settingsDb{rows: map[string]string{}} }

func (*settingsDb) Dialect() string { return "sqlite" }

func (d *settingsDb) All(_ context.Context, sql string, params ...any) ([]Row, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch {
	case strings.HasPrefix(sql, `SELECT value FROM rl_settings WHERE "key" = ?`):
		if v, ok := d.rows[params[0].(string)]; ok {
			return []Row{{"value": v}}, nil
		}
	case strings.HasPrefix(sql, `SELECT "key", value FROM rl_settings WHERE "key" LIKE ?`):
		out := []Row{}
		for k, v := range d.rows {
			if strings.HasPrefix(k, strings.TrimSuffix(params[0].(string), "%")) {
				out = append(out, Row{"key": k, "value": v})
			}
		}
		return out, nil
	}
	return nil, nil
}

func (d *settingsDb) Run(ctx context.Context, sql string, params ...any) error {
	_, err := d.Affected(ctx, sql, params...)
	return err
}

func (d *settingsDb) Affected(_ context.Context, sql string, params ...any) (int64, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch {
	case strings.HasPrefix(sql, `DELETE FROM rl_settings WHERE "key" = ?`):
		key := params[0].(string)
		if _, ok := d.rows[key]; ok {
			delete(d.rows, key)
			return 1, nil
		}
	case strings.HasPrefix(sql, `INSERT INTO rl_settings`) && strings.HasSuffix(sql, "DO NOTHING"):
		if _, ok := d.rows[params[0].(string)]; !ok {
			d.rows[params[0].(string)] = params[1].(string)
			return 1, nil
		}
	case strings.HasPrefix(sql, `INSERT INTO rl_settings`):
		d.rows[params[0].(string)] = params[1].(string)
		return 1, nil
	case strings.HasPrefix(sql, `UPDATE rl_settings SET value = ? WHERE "key" = ? AND value = ?`):
		if v, ok := d.rows[params[1].(string)]; ok && v == params[2].(string) {
			d.rows[params[1].(string)] = params[0].(string)
			return 1, nil
		}
	}
	return 0, nil
}

func askRoutesOn(db Db) *Routes {
	r := &Runlight{now: func() int64 { return 1_700_000_000_000 }, turns: map[string]*turn{}, Store: NewStore(db)}
	return &Routes{r: r, asked: map[string]*askCount{}}
}

// A viewer's daily number is counted once for each question, however many are asked at once, and
// however many servers share the database.
func TestViewerQuestionsAskedAtOnceCountOnceEach(t *testing.T) {
	ctx := context.Background()
	db := newSettingsDb()
	db.rows["assistant-viewer-daily"] = "5"
	// Three servers on one database, so the lock in each does not help.
	servers := []*Routes{askRoutesOn(db), askRoutesOn(db), askRoutesOn(db)}
	var allowed, refused atomic.Int64
	var wg sync.WaitGroup
	for i := range 40 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answer, err := servers[i%3].viewerAsked(ctx, "viewer", 1_700_000_000_000)
			switch {
			case err != nil:
				t.Error(err)
			case answer == nil:
				allowed.Add(1)
			case answer.Status == 429 && strings.Contains(string(answer.Body), "assistant_daily"):
				refused.Add(1)
			default:
				t.Errorf("answered %d %s", answer.Status, answer.Body)
			}
		}()
	}
	wg.Wait()
	if allowed.Load() != 5 || refused.Load() != 35 {
		t.Fatalf("%d allowed and %d refused, want 5 and 35", allowed.Load(), refused.Load())
	}
	if got := db.rows["assistant-asked:2023-11-14:viewer"]; got != "5" {
		t.Errorf("the count is %q, want 5", got)
	}
}

// With one question a day, ten asked at once get one answer, and two viewers each get theirs.
func TestAskTurnAllowsOneQuestionADayOnceForEachViewer(t *testing.T) {
	ctx := context.Background()
	db := newSettingsDb()
	db.rows["assistant-viewer-daily"] = "1"
	// The old single row for a day is cleared with the other days'.
	db.rows["assistant-asked:2023-11-13"] = `{"viewer":1}`
	db.rows["assistant-asked:2023-11-13:viewer"] = "1"
	rt := askRoutesOn(db)
	var allowed atomic.Int64
	var wg sync.WaitGroup
	for _, who := range []string{"a", "b"} {
		for range 10 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				refused, finish, err := rt.askTurn(ctx, who, false)
				if err != nil {
					t.Error(err)
					return
				}
				if refused == nil {
					allowed.Add(1)
					finish()
				}
			}()
		}
	}
	wg.Wait()
	if allowed.Load() != 2 {
		t.Fatalf("%d questions got through, want 2", allowed.Load())
	}
	if db.rows["assistant-asked:2023-11-14:a"] != "1" || db.rows["assistant-asked:2023-11-14:b"] != "1" {
		t.Errorf("counts are %v", db.rows)
	}
	for key := range db.rows {
		if strings.HasPrefix(key, "assistant-asked:2023-11-13") {
			t.Errorf("%s was kept", key)
		}
	}
	// A limit of none refuses at once, without writing.
	db.rows["assistant-viewer-daily"] = "0"
	if refused, _, err := rt.askTurn(ctx, "c", false); err != nil || refused == nil || refused.Status != 429 {
		t.Fatalf("a limit of 0: %v %v", refused, err)
	}
	if _, has := db.rows["assistant-asked:2023-11-14:c"]; has {
		t.Error("a refused question was counted")
	}
}

// A signing key made on first use is the same for everyone who asks at once.
func TestSettingOrAddGivesEveryCallerTheFirstValue(t *testing.T) {
	ctx := context.Background()
	store := NewStore(newSettingsDb())
	var mu sync.Mutex
	seen := map[string]bool{}
	var wg sync.WaitGroup
	for range 30 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			key, err := store.SettingOrAdd(ctx, "pick-key", func() string { return randomID(32) })
			if err != nil {
				t.Error(err)
			}
			mu.Lock()
			seen[key] = true
			mu.Unlock()
		}()
	}
	wg.Wait()
	saved, _, _ := store.Setting(ctx, "pick-key")
	if len(seen) != 1 || !seen[saved] || saved == "" {
		t.Fatalf("%d different keys, saved %q", len(seen), saved)
	}
}

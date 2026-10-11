package runlight

import (
	"context"
	"errors"
	"regexp"
)

// Prefix is what every table and index name starts with, unless a store is
// given another prefix in its place.
const Prefix = "rl_"

// Tables are Runlight's tables, after the prefix: the store's, and the
// sign-in accounts' two. An app dropping Runlight's tables drops these by
// name, never every table that starts with the prefix.
var Tables = []string{
	"meta", "sites", "salts", "sessions", "events", "links", "link_domains", "shares", "goals", "settings",
	"reports", "tokens", "funnels", "rollup_days", "rollups", "users", "invites",
}

var (
	// A name in a statement, and short enough that the longest index name stays inside MySQL's 64.
	prefixPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,31}$`)
	// A table or index name: rl_ at the start of a word, and a letter after it.
	prefixedName = regexp.MustCompile(`\brl_([a-z])`)
)

// prefixedDb is a Db whose tables and indexes start with prefix in place of rl_.
type prefixedDb struct {
	inner  Db
	prefix string
}

// Prefixed is a Db whose tables and indexes start with prefix in place of
// rl_, such as wp_rl_ inside WordPress, so two apps sharing one database
// each keep a set of their own. Runlight's SQL names every table and index
// rl_ and something, and those names alone are rewritten on the way
// through, in each statement and in the names a schema check compares as
// text. A store over a prefixed Db keeps its prefix, and the accounts and
// importers that reach the Db through the store follow it too. The prefix
// is up to 32 letters, digits, and underscores, not starting with a digit.
//
// The prefixed Db is an Affecter, Exclusiver, Transactor, and Metered
// whatever db is, and asked for what db cannot do, does what the store
// would do without it: Exclusive runs fn on it, Transaction runs fn between
// BEGIN and COMMIT, and Affected fails.
func Prefixed(db Db, prefix string) (Db, error) {
	if !prefixPattern.MatchString(prefix) {
		return nil, errors.New("Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit")
	}
	return &prefixedDb{inner: db, prefix: prefix}, nil
}

// prefixOf is the prefix a Db was made with: Prefix unless it is a prefixed one.
func prefixOf(db Db) string {
	if p, ok := db.(*prefixedDb); ok {
		return p.prefix
	}
	return Prefix
}

// as is db as the optional interface T, when it has it. A prefixed Db has it only when the Db under it does.
func as[T any](db Db) (T, bool) {
	if p, ok := db.(*prefixedDb); ok {
		if _, has := as[T](p.inner); !has {
			var none T
			return none, false
		}
	}
	t, ok := db.(T)
	return t, ok
}

func (p *prefixedDb) sql(text string) string {
	return prefixedName.ReplaceAllString(text, p.prefix+"${1}")
}

func (p *prefixedDb) wrap(db Db) Db { return &prefixedDb{inner: db, prefix: p.prefix} }

// Dialect is that of the Db under it.
func (p *prefixedDb) Dialect() string { return p.inner.Dialect() }

// All runs a query and reads every row.
func (p *prefixedDb) All(ctx context.Context, sql string, params ...any) ([]Row, error) {
	return p.inner.All(ctx, p.sql(sql), params...)
}

// Run runs a statement.
func (p *prefixedDb) Run(ctx context.Context, sql string, params ...any) error {
	return p.inner.Run(ctx, p.sql(sql), params...)
}

// Affected runs an UPDATE or DELETE and says how many rows it matched.
func (p *prefixedDb) Affected(ctx context.Context, sql string, params ...any) (int64, error) {
	a, ok := p.inner.(Affecter)
	if !ok {
		return 0, errors.New("Runlight: this database does not say how many rows a statement matched")
	}
	return a.Affected(ctx, p.sql(sql), params...)
}

// Exclusive runs fn holding the lock of the Db under it, when it has one.
func (p *prefixedDb) Exclusive(ctx context.Context, fn func(Db) error) error {
	ex, ok := p.inner.(Exclusiver)
	if !ok {
		return fn(p)
	}
	return ex.Exclusive(ctx, func(db Db) error { return fn(p.wrap(db)) })
}

// Transaction runs fn in one transaction, when the Db under it has them.
func (p *prefixedDb) Transaction(ctx context.Context, fn func(Db) error) error {
	t, ok := p.inner.(Transactor)
	if !ok {
		if err := p.Run(ctx, "BEGIN"); err != nil {
			return err
		}
		if err := fn(p); err != nil {
			_ = p.Run(ctx, "ROLLBACK")
			return err
		}
		return p.Run(ctx, "COMMIT")
	}
	return t.Transaction(ctx, func(db Db) error { return fn(p.wrap(db)) })
}

// Metered is whether the Db under it is.
func (p *prefixedDb) Metered() bool {
	m, ok := p.inner.(Metered)
	return ok && m.Metered()
}

// Close closes the Db under it, when it has a Close.
func (p *prefixedDb) Close() error {
	if c, ok := p.inner.(interface{ Close() error }); ok {
		return c.Close()
	}
	return nil
}

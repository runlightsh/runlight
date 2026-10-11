//! Another prefix for Runlight's tables, so two apps sharing one database each keep a set of their own
//! (store.ts's `prefixed`), and the wait for the lock for creating them.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use super::db::{Db, DbError, Dialect, Hold, Param, Row};
use crate::BoxFuture;

/// What every table and index name starts with, unless a store is given another prefix in its place.
pub const PREFIX: &str = "rl_";

/// Runlight's tables, after the prefix: the store's, and the sign-in accounts' two. An app dropping
/// Runlight's tables drops these by name, never every table that starts with the prefix.
pub const TABLES: [&str; 17] = [
    "meta",
    "sites",
    "salts",
    "sessions",
    "events",
    "links",
    "link_domains",
    "shares",
    "goals",
    "settings",
    "reports",
    "tokens",
    "funnels",
    "rollup_days",
    "rollups",
    "users",
    "invites",
];

/// Whether a prefix may name tables: up to 32 letters, digits, and underscores, not starting with a digit,
/// so it is a name in a statement and the longest index name stays inside MySQL's 64.
fn valid(prefix: &str) -> bool {
    let bytes = prefix.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && !bytes[0].is_ascii_digit()
        && bytes.iter().all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

/// Checks a table prefix, with the error the SDK throws for one that cannot be.
pub fn check_prefix(prefix: &str) -> Result<(), DbError> {
    if valid(prefix) {
        Ok(())
    } else {
        Err(DbError(
            "Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit"
                .into(),
        ))
    }
}

/// `sql` with every `rl_` that starts a name and goes on with a lowercase letter (`\brl_(?=[a-z])`) put
/// under `prefix` instead.
fn rewrite(sql: &str, prefix: &str) -> String {
    let bytes = sql.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut out = String::with_capacity(sql.len() + 16);
    let mut from = 0;
    let mut at = 0;
    while let Some(found) = sql[at..].find("rl_") {
        let i = at + found;
        let starts = i == 0 || !word(bytes[i - 1]);
        if starts && bytes.get(i + 3).is_some_and(u8::is_ascii_lowercase) {
            out.push_str(&sql[from..i]);
            out.push_str(prefix);
            from = i + 3;
        }
        at = i + 3;
    }
    out.push_str(&sql[from..]);
    out
}

/// A Db whose tables and indexes start with a prefix in place of `rl_`, such as `wp_rl_` inside WordPress,
/// so two apps sharing one database each keep a set of their own. Runlight's SQL names every table and
/// index `rl_` and something, and those names alone are rewritten on the way through, in each statement
/// and in the names a schema check compares as text. Values bound as parameters are left as they are. A
/// store given a prefix puts one in front of its Db, so the accounts and importers that reach the Db
/// through the store follow it too.
pub struct Prefixed {
    inner: Arc<dyn Db>,
    prefix: String,
}

impl Prefixed {
    /// `inner` with its tables under `prefix`, or the error for a prefix that cannot be one.
    pub fn new(inner: Arc<dyn Db>, prefix: &str) -> Result<Prefixed, DbError> {
        check_prefix(prefix)?;
        Ok(Prefixed { inner, prefix: prefix.to_string() })
    }
}

impl Db for Prefixed {
    fn dialect(&self) -> Dialect {
        self.inner.dialect()
    }

    fn all<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<Vec<Row>, DbError>> {
        Box::pin(async move { self.inner.all(&rewrite(sql, &self.prefix), params).await })
    }

    fn run<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<u64, DbError>> {
        Box::pin(async move { self.inner.run(&rewrite(sql, &self.prefix), params).await })
    }

    fn hold(&self, kind: Hold) -> BoxFuture<'_, Result<Arc<dyn Db>, DbError>> {
        // The held connection keeps the prefix, so a transaction's statements follow it too.
        Box::pin(async move {
            let held = self.inner.hold(kind).await?;
            Ok(Arc::new(Prefixed { inner: held, prefix: self.prefix.clone() }) as Arc<dyn Db>)
        })
    }

    fn finish(&self, ok: bool) -> BoxFuture<'_, Result<(), DbError>> {
        self.inner.finish(ok)
    }

    fn metered(&self) -> bool {
        self.inner.metered()
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        self.inner.close()
    }

    fn prefix(&self) -> Option<&str> {
        Some(&self.prefix)
    }
}

/// The longest a process waits for another one creating or upgrading the tables before it gives up.
pub const LOCK_WAIT: Duration = Duration::from_secs(30);

/// The wait a test has set in place of LOCK_WAIT, in milliseconds; 0 for none.
static LOCK_WAIT_IN_TESTS: AtomicU64 = AtomicU64::new(0);

/// How long a Db waits for the lock for creating tables: [`LOCK_WAIT`], unless a test has set another.
pub fn lock_wait() -> Duration {
    match LOCK_WAIT_IN_TESTS.load(Ordering::Relaxed) {
        0 => LOCK_WAIT,
        ms => Duration::from_millis(ms),
    }
}

/// For tests: Dbs wait this long for the lock instead, or [`LOCK_WAIT`] again with `None`.
#[doc(hidden)]
pub fn lock_wait_in_tests(wait: Option<Duration>) {
    LOCK_WAIT_IN_TESTS.store(wait.map_or(0, |w| (w.as_millis() as u64).max(1)), Ordering::Relaxed);
}

/// The start of what [`TablesBusyError`] says, by which its [`DbError`] is told apart from others.
const TABLES_BUSY: &str = "Runlight: another process is creating or upgrading the tables, and had not finished after ";

/// Another process held the lock for creating tables past the wait, such as one building an index on a
/// big table after an upgrade. The request that waited fails with this, rather than waiting for good. It
/// reaches the store as a [`DbError`] with its words, which [`TablesBusyError::of`] knows again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TablesBusyError {
    /// How long it waited.
    pub waited: Duration,
}

impl TablesBusyError {
    /// The error a [`DbError`] is, when it is this one.
    pub fn of(error: &DbError) -> Option<TablesBusyError> {
        let seconds = error.0.strip_prefix(TABLES_BUSY)?.strip_suffix(" seconds. Try again in a minute.")?;
        seconds.parse::<u64>().ok().map(|s| TablesBusyError { waited: Duration::from_secs(s) })
    }
}

impl std::fmt::Display for TablesBusyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let seconds = (self.waited.as_millis() as f64 / 1000.0).round() as u64;
        write!(f, "{TABLES_BUSY}{seconds} seconds. Try again in a minute.")
    }
}

impl std::error::Error for TablesBusyError {}

impl From<TablesBusyError> for DbError {
    fn from(e: TablesBusyError) -> DbError {
        DbError(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_names_that_start_with_rl_are_rewritten() {
        assert_eq!(
            rewrite("SELECT * FROM rl_sites s JOIN rl_events e WHERE x = 'rl_users' AND y LIKE 'rl\\_%'", "wp_rl_"),
            "SELECT * FROM wp_rl_sites s JOIN wp_rl_events e WHERE x = 'wp_rl_users' AND y LIKE 'rl\\_%'"
        );
        assert_eq!(rewrite("rl_meta, url_x, xrl_sites, rl_1, rl_", "p_"), "p_meta, url_x, xrl_sites, rl_1, rl_");
        assert_eq!(rewrite("\"rl_links\".slug", "a_"), "\"a_links\".slug");
    }

    #[test]
    fn the_busy_error_is_known_again_by_its_words() {
        let error = DbError::from(TablesBusyError { waited: Duration::from_millis(1_000) });
        assert_eq!(
            error.0,
            "Runlight: another process is creating or upgrading the tables, and had not finished after 1 seconds. Try again in a minute."
        );
        assert_eq!(TablesBusyError::of(&error), Some(TablesBusyError { waited: Duration::from_secs(1) }));
        assert_eq!(TablesBusyError::of(&DbError("Runlight: something else".into())), None);
    }
}

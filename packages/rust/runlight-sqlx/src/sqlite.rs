//! SQLite's one connection, held for the store's statements in turn.

use std::sync::Arc;
use std::time::Duration;

use runlight::BoxFuture;
use runlight::store::{Db, DbError, Dialect, Hold, Param, Row};
use sqlx::pool::PoolConnection;
use sqlx::sqlite::{Sqlite, SqliteArguments};
use sqlx::{AssertSqlSafe, SqlitePool};
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::rows::{db_error, sqlite_row};

/// How long opening SQLite keeps retrying a busy database before it gives up.
const BUSY_RETRY: Duration = Duration::from_secs(2);

/// The store's one connection, opened on first use.
#[derive(Default)]
struct Slot {
    conn: Option<PoolConnection<Sqlite>>,
    /// A transaction was let go of before it ended (a request cancelled before `finish`), so it is
    /// rolled back before the connection is used again. Closing the connection instead would lose an
    /// in-memory database.
    abandoned: bool,
}

/// The pool, and the one connection of it the store holds. Statements and transactions take turns, so
/// a request's insert can never land inside an import's open transaction, and a rollback can only undo
/// the transaction's own writes.
#[derive(Clone)]
pub struct SqliteDb {
    pool: SqlitePool,
    conn: Arc<Mutex<Slot>>,
}

impl SqliteDb {
    /// The store's driver over a pool.
    pub fn new(pool: SqlitePool) -> SqliteDb {
        SqliteDb { pool, conn: Arc::new(Mutex::new(Slot::default())) }
    }
}

/// The connection, opened (and its pragmas set) on first use and held for the caller.
async fn open(pool: &SqlitePool, guard: &mut Slot) -> Result<(), DbError> {
    if guard.abandoned {
        if let Some(conn) = guard.conn.as_mut()
            && let Err(e) = exec(conn, "ROLLBACK").await
            && !e.to_string().contains("no transaction is active")
        {
            // Still in the transaction, perhaps: never used again.
            if let Some(conn) = guard.conn.take() {
                drop(conn.detach());
            }
        }
        // Only once the rollback is done, so one cancelled in turn is tried again.
        guard.abandoned = false;
    }
    if guard.conn.is_none() {
        let mut conn = pool.acquire().await.map_err(db_error)?;
        // No busy handler until WAL is on: switching journal mode can answer busy at once while
        // another process is doing the same on a new file, so that is retried.
        wal(&mut conn).await.map_err(db_error)?;
        exec(&mut conn, "PRAGMA synchronous = NORMAL").await.map_err(db_error)?;
        // Deleted rows, such as a day's salt once it is gone, are overwritten where that costs no extra writes,
        // so they do not linger in the file's free space.
        exec(&mut conn, "PRAGMA secure_delete = FAST").await.map_err(db_error)?;
        exec(&mut conn, "PRAGMA busy_timeout = 5000").await.map_err(db_error)?;
        guard.conn = Some(conn);
    }
    Ok(())
}

fn arguments(params: Vec<Param>) -> Result<SqliteArguments, DbError> {
    use sqlx::Arguments;
    let mut args = SqliteArguments::default();
    for p in params {
        match p {
            Param::Null => args.add(Option::<i64>::None),
            Param::Int(n) => args.add(n),
            Param::Float(f) => args.add(f),
            Param::Text(s) => args.add(s),
        }
        .map_err(db_error)?;
    }
    Ok(args)
}

fn broken(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Io(_) | sqlx::Error::PoolClosed | sqlx::Error::WorkerCrashed)
}

async fn all_on(pool: &SqlitePool, slot: &mut Slot, sql: &str, params: Vec<Param>) -> Result<Vec<Row>, DbError> {
    open(pool, slot).await?;
    let conn = slot.conn.as_mut().expect("an open connection");
    let result = sqlx::query_with(AssertSqlSafe(sql.to_string()), arguments(params)?).fetch_all(&mut **conn).await;
    if let Err(e) = &result
        && broken(e)
    {
        slot.conn = None;
    }
    result.map_err(db_error)?.iter().map(sqlite_row).collect()
}

async fn run_on(pool: &SqlitePool, slot: &mut Slot, sql: &str, params: Vec<Param>) -> Result<u64, DbError> {
    open(pool, slot).await?;
    let conn = slot.conn.as_mut().expect("an open connection");
    let result = sqlx::query_with(AssertSqlSafe(sql.to_string()), arguments(params)?).execute(&mut **conn).await;
    if let Err(e) = &result
        && broken(e)
    {
        slot.conn = None;
    }
    Ok(result.map_err(db_error)?.rows_affected())
}

impl Db for SqliteDb {
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }

    fn all<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<Vec<Row>, DbError>> {
        Box::pin(async move {
            let mut slot = self.conn.lock().await;
            all_on(&self.pool, &mut slot, sql, params).await
        })
    }

    fn run<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<u64, DbError>> {
        Box::pin(async move {
            let mut slot = self.conn.lock().await;
            run_on(&self.pool, &mut slot, sql, params).await
        })
    }

    fn hold(&self, kind: Hold) -> BoxFuture<'_, Result<Arc<dyn Db>, DbError>> {
        Box::pin(async move {
            // SQLite's file lock already serialises its writers, so a lock to create tables needs nothing.
            if kind == Hold::Exclusive {
                return Ok(Arc::new(self.clone()) as Arc<dyn Db>);
            }
            // Open from before BEGIN is sent, since a BEGIN cancelled part way may still have run.
            let mut tx = Tx { slot: self.conn.clone().lock_owned().await, open: true };
            run_on(&self.pool, &mut tx.slot, "BEGIN", vec![]).await?;
            Ok(Arc::new(Held { pool: self.pool.clone(), guard: Arc::new(Mutex::new(Some(tx))), owner: true })
                as Arc<dyn Db>)
        })
    }
}

/// The connection, held for one transaction until it ends. Let go of while still open, it has the
/// transaction rolled back before anything else uses the connection.
struct Tx {
    slot: OwnedMutexGuard<Slot>,
    open: bool,
}

impl Drop for Tx {
    fn drop(&mut self) {
        if self.open {
            self.slot.abandoned = true;
        }
    }
}

/// The connection held for one transaction. A transaction asked for inside it joins it: the same
/// connection, with nothing to finish.
struct Held {
    pool: SqlitePool,
    guard: Arc<Mutex<Option<Tx>>>,
    owner: bool,
}

impl Drop for Held {
    fn drop(&mut self) {
        // Its owner gone without `finish`: the connection is let go now rather than when the last joined
        // handle goes, so other statements are not held up behind it.
        if self.owner
            && let Ok(mut held) = self.guard.try_lock()
        {
            held.take();
        }
    }
}

fn ended() -> DbError {
    DbError("Runlight: the transaction has ended".into())
}

impl Db for Held {
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }

    fn all<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<Vec<Row>, DbError>> {
        Box::pin(async move {
            let mut held = self.guard.lock().await;
            let slot = &mut held.as_mut().ok_or_else(ended)?.slot;
            all_on(&self.pool, slot, sql, params).await
        })
    }

    fn run<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<u64, DbError>> {
        Box::pin(async move {
            let mut held = self.guard.lock().await;
            let slot = &mut held.as_mut().ok_or_else(ended)?.slot;
            run_on(&self.pool, slot, sql, params).await
        })
    }

    fn hold(&self, _kind: Hold) -> BoxFuture<'_, Result<Arc<dyn Db>, DbError>> {
        // A transaction already open is joined.
        Box::pin(async move {
            Ok(Arc::new(Held { pool: self.pool.clone(), guard: self.guard.clone(), owner: false }) as Arc<dyn Db>)
        })
    }

    fn finish(&self, ok: bool) -> BoxFuture<'_, Result<(), DbError>> {
        Box::pin(async move {
            if !self.owner {
                return Ok(());
            }
            let mut held = self.guard.lock().await;
            let Some(mut tx) = held.take() else { return Ok(()) };
            let result = run_on(&self.pool, &mut tx.slot, if ok { "COMMIT" } else { "ROLLBACK" }, vec![]).await;
            // One that failed may still be in its transaction, which is rolled back before the connection
            // is used again.
            tx.open = result.is_err();
            result.map(|_| ())
        })
    }
}

/// Runs a statement whose rows, if any, are not wanted (`PRAGMA journal_mode` answers one).
async fn exec(conn: &mut PoolConnection<Sqlite>, text: &'static str) -> Result<(), sqlx::Error> {
    sqlx::query(text).fetch_all(&mut **conn).await.map(|_| ())
}

fn is_busy(err: &sqlx::Error) -> bool {
    let text = err.to_string();
    let code = match err {
        sqlx::Error::Database(db) => db.code().map(|c| c.to_string()).unwrap_or_default(),
        _ => String::new(),
    };
    // SQLITE_BUSY is 5 and SQLITE_LOCKED 6, and their extended codes are those plus a multiple of 256.
    let busy_code = code.parse::<i64>().is_ok_and(|c| c & 0xff == 5 || c & 0xff == 6);
    busy_code || text.contains("SQLITE_BUSY") || text.contains("database is locked")
}

/// Makes the database file, when there is none yet, for its owner and group alone (0660), whatever the
/// umask: the visits in it are nobody else's to read, and a scheduled job running as another user of the
/// same group can still write to it. It is made before SQLite opens it and turns on WAL, so the -wal and
/// -shm files SQLite makes beside it take the same mode. Systems without such modes make it as it is.
pub(crate) fn own_file(path: &std::path::Path) {
    if path.exists() {
        return;
    }
    // A file another process made a moment ago is left as it is.
    let Ok(file) = std::fs::OpenOptions::new().write(true).create_new(true).open(path) else { return };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Not a file this process may change, or a file system with no such modes: it stays as made.
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o660));
    }
    drop(file);
}

/// Puts the connection in WAL mode, retrying while SQLite answers busy, with a short growing pause.
async fn wal(conn: &mut PoolConnection<Sqlite>) -> Result<(), sqlx::Error> {
    let mut waited = Duration::ZERO;
    let mut attempt = 0u32;
    loop {
        match exec(conn, "PRAGMA journal_mode = WAL").await {
            Err(err) if is_busy(&err) && waited < BUSY_RETRY => {
                let pause = Duration::from_millis(10u64 << attempt.min(10))
                    .min(Duration::from_millis(200))
                    .min(BUSY_RETRY - waited);
                tokio::time::sleep(pause).await;
                waited += pause;
                attempt += 1;
            }
            other => return other,
        }
    }
}

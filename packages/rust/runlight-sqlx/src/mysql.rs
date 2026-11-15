//! MySQL 8.0.20 and MariaDB 11.4, on the app's pool. Each statement runs on the pool on its own; a
//! transaction or a lock holds one connection until it ends.

use std::sync::Arc;
use std::time::Instant;

use runlight::BoxFuture;
use runlight::store::{Db, DbError, Dialect, Hold, Param, Row, TablesBusyError, fill_placeholders, lock_wait};
use sqlx::mysql::{MySqlArguments, MySqlConnection};
use sqlx::pool::PoolConnection;
use sqlx::{AssertSqlSafe, MySql, MySqlPool};
use tokio::sync::Mutex;

use crate::rows::{db_error, mysql_row};

/// One lock per database, so installs sharing a server do not wait on each other. Lock names are 64
/// characters at most.
const LOCK: &str = "CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48))";

/// The store's driver over a MySQL pool. SQL written for SQLite and Postgres is sent as MySQL reads it:
/// a "quoted" name in backticks, a backslash inside 'text' doubled, and every value bound to its
/// placeholder, never written into the statement.
#[derive(Clone)]
pub struct MysqlDb {
    pool: MySqlPool,
}

impl MysqlDb {
    /// The store's driver over a pool.
    pub fn new(pool: MySqlPool) -> MysqlDb {
        MysqlDb { pool }
    }
}

/// The session's sql_mode as it was, less NO_BACKSLASH_ESCAPES, wherever it sits in the list.
const NO_BACKSLASH_ESCAPES_OFF: &str = "SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',NO_BACKSLASH_ESCAPES,', ','))";

/// A statement that takes no values, as it is sent. Its own 'text' has each backslash doubled, which a server
/// set to NO_BACKSLASH_ESCAPES would read as two, so it goes after a statement that drops that mode from the
/// connection, an app's own pool's too, in the same round trip.
fn plain(sql: &str) -> Result<AssertSqlSafe<String>, DbError> {
    Ok(AssertSqlSafe(format!("{NO_BACKSLASH_ESCAPES_OFF}; {}", fill_placeholders(sql, &[], true, |_| String::new())?)))
}

/// The values of a statement as the arguments bound to it. No value is ever written into a statement's text.
fn arguments(params: &[Param]) -> Result<MySqlArguments, DbError> {
    use sqlx::Arguments;
    let mut args = MySqlArguments::default();
    for p in params {
        match p {
            Param::Null => args.add(Option::<String>::None),
            Param::Int(n) => args.add(*n),
            Param::Float(f) => args.add(*f),
            Param::Text(s) => args.add(s.as_str()),
        }
        .map_err(db_error)?;
    }
    Ok(args)
}

/// A statement with values, ready to run on one connection: its names in backticks, its placeholders left for
/// the values to be bound to. A backslash in the statement's own 'text' (the escape of a LIKE) is read
/// as written only without NO_BACKSLASH_ESCAPES, so that mode is dropped from the connection first.
async fn prepared(conn: &mut MySqlConnection, sql: &str, params: &[Param]) -> Result<AssertSqlSafe<String>, DbError> {
    if sql.contains('\\') {
        sqlx::raw_sql(AssertSqlSafe(NO_BACKSLASH_ESCAPES_OFF.to_string()))
            .execute(&mut *conn)
            .await
            .map_err(db_error)?;
    }
    Ok(AssertSqlSafe(fill_placeholders(sql, params, true, |_| "?".to_string())?))
}

async fn rows_on(conn: &mut MySqlConnection, sql: &str, params: &[Param]) -> Result<Vec<Row>, DbError> {
    let rows = if params.is_empty() {
        sqlx::raw_sql(plain(sql)?).fetch_all(conn).await.map_err(db_error)?
    } else {
        let statement = prepared(conn, sql, params).await?;
        sqlx::query_with(statement, arguments(params)?).fetch_all(conn).await.map_err(db_error)?
    };
    rows.iter().map(mysql_row).collect()
}

async fn changed_on(conn: &mut MySqlConnection, sql: &str, params: &[Param]) -> Result<u64, DbError> {
    if params.is_empty() {
        return Ok(sqlx::raw_sql(plain(sql)?).execute(conn).await.map_err(db_error)?.rows_affected());
    }
    let statement = prepared(conn, sql, params).await?;
    Ok(sqlx::query_with(statement, arguments(params)?).execute(conn).await.map_err(db_error)?.rows_affected())
}

async fn exec(conn: &mut PoolConnection<MySql>, sql: &str) -> Result<Vec<Row>, DbError> {
    let rows = sqlx::raw_sql(AssertSqlSafe(sql.to_string())).fetch_all(&mut **conn).await.map_err(db_error)?;
    rows.iter().map(mysql_row).collect()
}

impl Db for MysqlDb {
    fn dialect(&self) -> Dialect {
        Dialect::Mysql
    }

    fn all<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<Vec<Row>, DbError>> {
        Box::pin(async move {
            let mut conn = self.pool.acquire().await.map_err(db_error)?;
            rows_on(&mut conn, sql, &params).await
        })
    }

    fn run<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<u64, DbError>> {
        Box::pin(async move {
            let mut conn = self.pool.acquire().await.map_err(db_error)?;
            changed_on(&mut conn, sql, &params).await
        })
    }

    fn hold(&self, kind: Hold) -> BoxFuture<'_, Result<Arc<dyn Db>, DbError>> {
        Box::pin(async move {
            // In its slot from the start, so a request cancelled part way closes the connection rather than
            // give it back to the pool in a transaction or with the lock taken.
            let mut slot = Slot { conn: Some(self.pool.acquire().await.map_err(db_error)?), nested: false };
            let conn = slot.conn.as_mut().ok_or_else(ended)?;
            match kind {
                Hold::Transaction => begin(conn).await?,
                Hold::Exclusive => {
                    // Up to the lock wait, so a request does not wait on a long index build for good.
                    let wait = lock_wait();
                    let until = Instant::now() + wait;
                    loop {
                        let left = until.saturating_duration_since(Instant::now()).as_millis().div_ceil(1000);
                        let seconds = left.clamp(1, 5);
                        let rows = exec(conn, &format!("SELECT GET_LOCK({LOCK}, {seconds}) AS ok")).await?;
                        let row = rows.into_iter().next().unwrap_or_default();
                        if row.is_null("ok") {
                            return Err(DbError("Runlight: MySQL refused the lock for creating tables".into()));
                        }
                        if row.num("ok") == 1.0 {
                            break;
                        }
                        // Not got in time: another process is creating the tables. Ask again, until the wait is up.
                        if Instant::now() >= until {
                            return Err(TablesBusyError { waited: wait }.into());
                        }
                    }
                }
            }
            Ok(Arc::new(Held { conn: Arc::new(Mutex::new(slot)), kind, role: Role::Owner }) as Arc<dyn Db>)
        })
    }
}

/// As Postgres does by default: each statement sees what was committed before it began, and InnoDB
/// takes no gap locks, so two writers to neighbouring rows do not deadlock.
async fn begin(conn: &mut PoolConnection<MySql>) -> Result<(), DbError> {
    exec(conn, "SET TRANSACTION ISOLATION LEVEL READ COMMITTED").await?;
    exec(conn, "START TRANSACTION").await?;
    Ok(())
}

/// The held connection. Let go of with it still in (a request cancelled before `finish`), it closes the
/// connection, so no transaction or lock goes back to the pool.
struct Slot {
    conn: Option<PoolConnection<MySql>>,
    /// A transaction begun inside the lock that has not ended.
    nested: bool,
}

impl Slot {
    fn close(&mut self) {
        if let Some(conn) = self.conn.take() {
            drop(conn.detach());
        }
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.close();
    }
}

/// One connection held for a transaction or a lock.
struct Held {
    conn: Arc<Mutex<Slot>>,
    kind: Hold,
    role: Role,
}

impl Drop for Held {
    fn drop(&mut self) {
        // Its owner gone without `finish`: closed now rather than when the last joined handle goes.
        if self.role == Role::Owner
            && let Ok(mut slot) = self.conn.try_lock()
        {
            slot.close();
        }
    }
}

/// What finishing a held connection does.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    /// Ends the transaction or lets the lock go, and gives the connection back.
    Owner,
    /// A transaction begun inside a lock: ends the transaction, and keeps the connection.
    Nested,
    /// Joined what was already held: ends nothing.
    Joined,
}

fn ended() -> DbError {
    DbError("Runlight: the held connection has been let go".into())
}

impl Db for Held {
    fn dialect(&self) -> Dialect {
        Dialect::Mysql
    }

    fn all<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<Vec<Row>, DbError>> {
        Box::pin(async move {
            let mut slot = self.conn.lock().await;
            let conn = slot.conn.as_mut().ok_or_else(ended)?;
            rows_on(conn, sql, &params).await
        })
    }

    fn run<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<u64, DbError>> {
        Box::pin(async move {
            let mut slot = self.conn.lock().await;
            let conn = slot.conn.as_mut().ok_or_else(ended)?;
            changed_on(conn, sql, &params).await
        })
    }

    fn hold(&self, kind: Hold) -> BoxFuture<'_, Result<Arc<dyn Db>, DbError>> {
        Box::pin(async move {
            if kind == Hold::Transaction && self.kind == Hold::Exclusive {
                let mut slot = self.conn.lock().await;
                let slot = &mut *slot;
                let conn = slot.conn.as_mut().ok_or_else(ended)?;
                // Marked before it is sent: a transaction cancelled part way may still have begun.
                slot.nested = true;
                begin(conn).await?;
                return Ok(Arc::new(Held { conn: self.conn.clone(), kind, role: Role::Nested }) as Arc<dyn Db>);
            }
            Ok(Arc::new(Held { conn: self.conn.clone(), kind: self.kind, role: Role::Joined }) as Arc<dyn Db>)
        })
    }

    fn finish(&self, ok: bool) -> BoxFuture<'_, Result<(), DbError>> {
        Box::pin(async move {
            let mut slot = self.conn.lock().await;
            match self.role {
                Role::Joined => Ok(()),
                Role::Nested => {
                    let slot = &mut *slot;
                    let Some(conn) = slot.conn.as_mut() else { return Ok(()) };
                    exec(conn, if ok { "COMMIT" } else { "ROLLBACK" }).await?;
                    slot.nested = false;
                    Ok(())
                }
                // A transaction inside the lock that never ended: closing the connection rolls it back and
                // lets the lock go.
                Role::Owner if slot.nested => {
                    slot.close();
                    Ok(())
                }
                Role::Owner => {
                    let Some(mut conn) = slot.conn.take() else { return Ok(()) };
                    let result = match self.kind {
                        Hold::Transaction => exec(&mut conn, if ok { "COMMIT" } else { "ROLLBACK" }).await.map(|_| ()),
                        // A connection whose release failed may still have the lock, so it is closed below,
                        // and a lost connection ends its session, and the lock with it.
                        Hold::Exclusive => exec(&mut conn, &format!("DO RELEASE_LOCK({LOCK})")).await.map(|_| ()),
                    };
                    if result.is_err() {
                        // A connection still in its transaction or holding the lock must never go back to
                        // the pool.
                        drop(conn.detach());
                    }
                    if self.kind == Hold::Exclusive { Ok(()) } else { result }
                }
            }
        })
    }
}

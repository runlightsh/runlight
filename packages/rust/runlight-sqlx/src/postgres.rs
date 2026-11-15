//! Postgres, on the app's pool. Each statement runs on the pool on its own, so the store's writes never
//! join a transaction the app has open; a transaction or a lock holds one connection until it ends.

use std::sync::Arc;
use std::time::Instant;

use runlight::BoxFuture;
use runlight::store::{Db, DbError, Dialect, Hold, Param, Row, TablesBusyError, fill_placeholders, lock_wait};
use sqlx::pool::PoolConnection;
use sqlx::postgres::{PgConnection, PgRow, PgStatement, PgTypeInfo};
use sqlx::{AssertSqlSafe, Connection, Executor, PgPool, Postgres, SqlSafeStr, Statement};

use crate::pg_bind::arguments;
use tokio::sync::Mutex;

use crate::rows::{db_error, pg_row};

/// Arbitrary but fixed, so every Runlight process takes the same lock to create tables.
const MIGRATION_LOCK: i64 = 7_331_906;

/// The store's driver over a Postgres pool. Every value is a bound parameter, never part of a statement's
/// text, and Postgres infers each one's type as it does for node-postgres's untyped parameters.
#[derive(Clone)]
pub struct PostgresDb {
    pool: PgPool,
}

impl PostgresDb {
    /// The store's driver over a pool.
    pub fn new(pool: PgPool) -> PostgresDb {
        PostgresDb { pool }
    }
}

/// A statement that takes no values, as it is sent: any 'text' in it that holds a backslash written so that it
/// reads the same whatever standard_conforming_strings says.
fn plain(sql: &str) -> Result<AssertSqlSafe<String>, DbError> {
    Ok(AssertSqlSafe(fill_placeholders(sql, &[], false, |_| String::new())?))
}

/// A statement with each `?` outside quotes numbered ($1, $2, ...), for its values to be bound to. No value is
/// ever written into the statement's text.
fn numbered(sql: &str, params: &[Param]) -> Result<String, DbError> {
    let n = std::cell::Cell::new(0);
    fill_placeholders(sql, params, false, |_| {
        n.set(n.get() + 1);
        format!("${}", n.get())
    })
}

/// A statement's rows, on one connection. With values, the statement is prepared with no types named, so the
/// server chooses each value's type from its place in the statement, as it does for node-postgres, and each
/// value is bound in the form of the type it was given. sqlx keeps the prepared statement with its connection,
/// so the types are asked for once. `again` is for a statement outside any transaction: see `stale`.
async fn rows_on(conn: &mut PgConnection, sql: &str, params: &[Param], again: bool) -> Result<Vec<PgRow>, DbError> {
    if params.is_empty() {
        return sqlx::raw_sql(plain(sql)?).fetch_all(conn).await.map_err(db_error);
    }
    let sql = numbered(sql, params)?;
    match bound(conn, &sql, params).await?.fetch_all(&mut *conn).await {
        Err(e) if stale(&e) => {
            conn.clear_cached_statements().await.map_err(db_error)?;
            if !again {
                return Err(db_error(e));
            }
            bound(conn, &sql, params).await?.fetch_all(conn).await.map_err(db_error)
        }
        done => done.map_err(db_error),
    }
}

/// As `rows_on`, for a statement that changes rows: how many it changed.
async fn changed_on(conn: &mut PgConnection, sql: &str, params: &[Param], again: bool) -> Result<u64, DbError> {
    if params.is_empty() {
        return Ok(sqlx::raw_sql(plain(sql)?).execute(conn).await.map_err(db_error)?.rows_affected());
    }
    let sql = numbered(sql, params)?;
    let done = match bound(conn, &sql, params).await?.execute(&mut *conn).await {
        Err(e) if stale(&e) => {
            conn.clear_cached_statements().await.map_err(db_error)?;
            if !again {
                return Err(db_error(e));
            }
            bound(conn, &sql, params).await?.execute(conn).await
        }
        done => done,
    };
    Ok(done.map_err(db_error)?.rows_affected())
}

/// A numbered statement, prepared, with its values bound under the types the server chose.
/// The connection needs what sqlx's own queries need: one server connection from the statement being
/// prepared to its values being bound.
async fn bound(
    conn: &mut PgConnection,
    sql: &str,
    params: &[Param],
) -> Result<sqlx::query::Query<'static, Postgres, sqlx::postgres::PgArguments>, DbError> {
    let statement = conn.prepare(AssertSqlSafe(sql.to_string()).into_sql_str()).await.map_err(db_error)?;
    let args = arguments(&kinds(&statement), params)?;
    let query = sqlx::query_with(AssertSqlSafe(sql.to_string()), args);
    if conn.cached_statements_size() > 0 {
        return Ok(query);
    }
    // A connection that keeps no statements (statement_cache_capacity(0)) has not kept this one either, yet
    // the server holds it under a name sqlx will never use again. With nothing kept, every named statement on
    // the connection is such a leftover, so they are all dropped, and the statement runs with no name.
    sqlx::raw_sql(AssertSqlSafe("DEALLOCATE ALL".to_string())).execute(&mut *conn).await.map_err(db_error)?;
    Ok(query.persistent(false))
}

/// Whether Postgres refused a kept statement because a table it reads has changed since it was prepared (a
/// column added by a newer version's migration, under a SELECT of every column). The connection's kept
/// statements are dropped, and a statement outside a transaction is run again; inside one the refusal has
/// already ended the transaction, so it is given back as the error it is.
fn stale(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Database(d) if d.code().as_deref() == Some("0A000") && d.message().contains("cached plan"))
}

/// The types the server chose for a prepared statement's values.
fn kinds(statement: &PgStatement) -> Vec<PgTypeInfo> {
    match statement.parameters() {
        Some(sqlx::Either::Left(kinds)) => kinds.to_vec(),
        _ => Vec::new(),
    }
}

impl Db for PostgresDb {
    fn dialect(&self) -> Dialect {
        Dialect::Postgres
    }

    fn all<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<Vec<Row>, DbError>> {
        Box::pin(async move {
            let mut conn = self.pool.acquire().await.map_err(db_error)?;
            rows_on(&mut conn, sql, &params, true).await?.iter().map(pg_row).collect()
        })
    }

    fn run<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<u64, DbError>> {
        Box::pin(async move {
            let mut conn = self.pool.acquire().await.map_err(db_error)?;
            changed_on(&mut conn, sql, &params, true).await
        })
    }

    fn hold(&self, kind: Hold) -> BoxFuture<'_, Result<Arc<dyn Db>, DbError>> {
        Box::pin(async move {
            // In its slot from the start, so a request cancelled part way closes the connection rather than
            // give it back to the pool in a transaction or with the lock taken.
            let mut slot = Slot { conn: Some(self.pool.acquire().await.map_err(db_error)?), nested: false };
            let conn = slot.conn.as_mut().ok_or_else(ended)?;
            match kind {
                Hold::Transaction => {
                    sqlx::raw_sql(AssertSqlSafe("BEGIN".to_string())).execute(&mut **conn).await.map_err(db_error)?;
                }
                Hold::Exclusive => {
                    // Up to the lock wait, so a request does not wait on a long index build for good.
                    let wait = lock_wait();
                    let until = Instant::now() + wait;
                    loop {
                        // Asked for again and again rather than waited on: a waiting statement would hold up an
                        // index being built CONCURRENTLY by whoever has the lock, and the two would wait on each
                        // other for good.
                        let rows = sqlx::raw_sql(AssertSqlSafe(format!(
                            "SELECT pg_try_advisory_lock({MIGRATION_LOCK}) AS ok"
                        )))
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(db_error)?;
                        let ok = rows.first().map(pg_row).transpose()?.is_some_and(|r| r.num("ok") == 1.0);
                        if ok {
                            break;
                        }
                        if Instant::now() >= until {
                            return Err(TablesBusyError { waited: wait }.into());
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                }
            }
            Ok(Arc::new(Held { conn: Arc::new(Mutex::new(slot)), kind, role: Role::Owner }) as Arc<dyn Db>)
        })
    }
}

/// The held connection. Let go of with it still in (a request cancelled before `finish`), it closes the
/// connection, so no transaction or lock goes back to the pool.
struct Slot {
    conn: Option<PoolConnection<Postgres>>,
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
        Dialect::Postgres
    }

    fn all<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<Vec<Row>, DbError>> {
        Box::pin(async move {
            let mut slot = self.conn.lock().await;
            let conn = slot.conn.as_mut().ok_or_else(ended)?;
            rows_on(conn, sql, &params, false).await?.iter().map(pg_row).collect()
        })
    }

    fn run<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<u64, DbError>> {
        Box::pin(async move {
            let mut slot = self.conn.lock().await;
            let conn = slot.conn.as_mut().ok_or_else(ended)?;
            changed_on(conn, sql, &params, false).await
        })
    }

    fn hold(&self, kind: Hold) -> BoxFuture<'_, Result<Arc<dyn Db>, DbError>> {
        Box::pin(async move {
            // A transaction inside the lock runs on the locked connection; anything else joins what is held.
            if kind == Hold::Transaction && self.kind == Hold::Exclusive {
                let mut slot = self.conn.lock().await;
                let slot = &mut *slot;
                let conn = slot.conn.as_mut().ok_or_else(ended)?;
                // Marked before it is sent: a BEGIN cancelled part way may still have run.
                slot.nested = true;
                sqlx::raw_sql(AssertSqlSafe("BEGIN".to_string())).execute(&mut **conn).await.map_err(db_error)?;
                return Ok(Arc::new(Held { conn: self.conn.clone(), kind, role: Role::Nested }) as Arc<dyn Db>);
            }
            Ok(Arc::new(Held { conn: self.conn.clone(), kind: self.kind, role: Role::Joined }) as Arc<dyn Db>)
        })
    }

    fn finish(&self, ok: bool) -> BoxFuture<'_, Result<(), DbError>> {
        Box::pin(async move {
            let mut slot = self.conn.lock().await;
            if self.role == Role::Joined {
                return Ok(());
            }
            if self.role == Role::Nested {
                let slot = &mut *slot;
                let Some(conn) = slot.conn.as_mut() else { return Ok(()) };
                let end = if ok { "COMMIT" } else { "ROLLBACK" };
                sqlx::raw_sql(AssertSqlSafe(end.to_string())).execute(&mut **conn).await.map_err(db_error)?;
                slot.nested = false;
                return Ok(());
            }
            // A transaction inside the lock that never ended: closing the connection rolls it back and lets
            // the lock go.
            if slot.nested {
                slot.close();
                return Ok(());
            }
            let Some(mut conn) = slot.conn.take() else { return Ok(()) };
            let result = match self.kind {
                Hold::Transaction => {
                    let end = if ok { "COMMIT" } else { "ROLLBACK" };
                    sqlx::raw_sql(AssertSqlSafe(end.to_string()))
                        .execute(&mut *conn)
                        .await
                        .map(|_| ())
                        .map_err(db_error)
                }
                // A connection whose unlock failed may still have the lock, so it is closed below, and a
                // lost connection ends its session, and the lock with it.
                Hold::Exclusive => sqlx::raw_sql(AssertSqlSafe(format!("SELECT pg_advisory_unlock({MIGRATION_LOCK})")))
                    .execute(&mut *conn)
                    .await
                    .map(|_| ())
                    .map_err(db_error),
            };
            if result.is_err() {
                // A connection still in its transaction or holding the lock must never go back to the pool.
                drop(conn.detach());
            }
            if self.kind == Hold::Exclusive { Ok(()) } else { result }
        })
    }
}

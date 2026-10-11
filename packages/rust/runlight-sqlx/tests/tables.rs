//! Runlight's tables under another prefix beside the first in one database, a new SQLite file's mode, and
//! the limit on waiting for another process creating the tables, as tables.test.ts tests them.

#![cfg(all(feature = "sqlite", feature = "postgres", feature = "mysql"))]

mod common;

use std::str::FromStr;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use runlight::BoxFuture;
use runlight::http::Request;
use runlight::store::{
    Db, DbError, Dialect, Hold, LOCK_WAIT, PREFIX, Param, Row, SiteRow, SqlStore, TABLES, TablesBusyError,
    lock_wait_in_tests,
};
use runlight::{Runlight, RunlightOptions, SiteOptions};
use tokio::sync::{Mutex, watch};

/// The tests here take turns: the lock they hold or wait for is one per database server, and the wait a
/// test shortens is the whole process's.
static TURN: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn url(kind: &str) -> Option<String> {
    common::kinds().into_iter().find(|(k, _)| *k == kind).map(|(_, url)| url)
}

/// Every table and index name in the database, as each dialect lists them.
async fn names(db: &dyn Db) -> Vec<String> {
    let sql = match db.dialect() {
        Dialect::Sqlite => "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        Dialect::Postgres => {
            "SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'i', 'S')"
        }
        Dialect::Mysql => {
            "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()
           UNION SELECT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name <> 'PRIMARY'"
        }
    };
    let mut out: Vec<String> = db.all(sql, vec![]).await.unwrap().iter().map(|r| r.text("name")).collect();
    out.sort();
    out
}

fn site(id: &str) -> SiteRow {
    SiteRow { id: id.into(), name: id.into(), hostnames: vec![format!("{id}.example")], timezone: "UTC".into() }
}

/// Two stores over one database, one with its tables under rl_ and the other under wp_rl_, a way to open
/// another store under wp_rl_, and what to do when the test is done.
struct Pair {
    plain: SqlStore,
    open: Box<dyn Fn() -> BoxFuture<'static, SqlStore> + Send + Sync>,
    done: BoxFuture<'static, ()>,
}

async fn shared_pair(kind: &str, url: &str) -> Pair {
    match kind {
        "sqlite" => {
            let file = std::env::temp_dir().join(format!("runlight-shared-{}.db", runlight::hash::random_id(6)));
            let path = file.to_str().unwrap().to_string();
            let plain = runlight_sqlx::connect(&path).await.unwrap();
            let opened = path.clone();
            let open = Box::new(move || {
                let path = opened.clone();
                Box::pin(async move { runlight_sqlx::connect_with_prefix(&path, "wp_rl_").await.unwrap() })
                    as BoxFuture<'static, SqlStore>
            });
            let closing = plain.clone();
            let done = Box::pin(async move {
                closing.close().await;
                for end in ["", "-wal", "-shm"] {
                    let _ = std::fs::remove_file(format!("{path}{end}"));
                }
            });
            Pair { plain, open, done }
        }
        "postgres" => {
            let schema = format!("rl_test_{}", runlight::hash::random_id(4));
            let admin = sqlx::PgPool::connect(url).await.unwrap();
            sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE SCHEMA \"{schema}\""))).execute(&admin).await.unwrap();
            let options = sqlx::postgres::PgConnectOptions::from_str(url).unwrap().options([("search_path", &schema)]);
            let pool = sqlx::postgres::PgPoolOptions::new().max_connections(3).connect_with(options).await.unwrap();
            let plain = runlight_sqlx::postgres(pool.clone());
            let prefixed = pool.clone();
            let open = Box::new(move || {
                let pool = prefixed.clone();
                Box::pin(async move { runlight_sqlx::postgres_with_prefix(pool, "wp_rl_").unwrap() })
                    as BoxFuture<'static, SqlStore>
            });
            let done = Box::pin(async move {
                pool.close().await;
                let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP SCHEMA \"{schema}\" CASCADE")))
                    .execute(&admin)
                    .await;
                admin.close().await;
            });
            Pair { plain, open, done }
        }
        _ => {
            // A fresh MySQL store holds the server's turn and starts from no tables; the second store shares its database.
            let fresh = common::fresh("mysql", url).await;
            let plain = fresh.store.clone();
            let pool = sqlx::mysql::MySqlPoolOptions::new().max_connections(3).connect(url).await.unwrap();
            let prefixed = pool.clone();
            let open = Box::new(move || {
                let pool = prefixed.clone();
                Box::pin(async move { runlight_sqlx::mysql_with_prefix(pool, "wp_rl_").unwrap() })
                    as BoxFuture<'static, SqlStore>
            });
            let done = Box::pin(async move {
                pool.close().await;
                fresh.done().await;
            });
            Pair { plain, open, done }
        }
    }
}

#[tokio::test]
async fn a_prefix_keeps_a_second_set_of_tables_beside_the_first_in_one_database() {
    let _turn = TURN.lock().await;
    for kind in ["sqlite", "postgres", "mysql"] {
        let Some(url) = url(kind) else { continue };
        let Pair { plain, open, done } = shared_pair(kind, &url).await;
        let raw = plain.db().clone();
        let other = open().await;
        other.migrate().await.unwrap();
        // A second process with the same prefix finds every table and index already there.
        open().await.migrate().await.unwrap();
        let made = names(&*raw).await;
        assert!(!made.is_empty(), "{kind}");
        assert_eq!(
            made.iter().filter(|n| !n.starts_with("wp_rl_")).collect::<Vec<_>>(),
            Vec::<&String>::new(),
            "{kind}: every name is under the prefix"
        );
        assert_eq!(other.prefix(), "wp_rl_");
        assert_eq!(other.tables(), TABLES.map(|t| format!("wp_rl_{t}")));
        assert!(
            other.tables()[..15].iter().all(|t| made.contains(t)),
            "{kind}: the store's 15 tables, listed for removing them"
        );

        plain.migrate().await.unwrap();
        let plain_tables = names(&*raw)
            .await
            .into_iter()
            .filter(|n| n.strip_prefix(PREFIX).is_some_and(|t| TABLES.contains(&t)))
            .count();
        assert_eq!(plain_tables, 15, "{kind}");
        plain.upsert_site(&site("first"), 1).await.unwrap();
        other.upsert_site(&site("second"), 1).await.unwrap();
        assert_eq!(plain.sites().await.unwrap().iter().map(|s| s.id.clone()).collect::<Vec<_>>(), ["first"]);
        assert_eq!(other.sites().await.unwrap().iter().map(|s| s.id.clone()).collect::<Vec<_>>(), ["second"]);
        let in_transaction = other.transaction(|tx| async move { Ok(tx.sites().await?[0].id.clone()) }).await.unwrap();
        assert_eq!(in_transaction, "second", "{kind}: a transaction keeps the prefix");
        other.set_setting("k", Some("wp")).await.unwrap();
        assert_eq!(plain.setting("k").await.unwrap(), None, "{kind}");
        assert_eq!(other.setting("k").await.unwrap().as_deref(), Some("wp"), "{kind}");
        other.close().await;
        done.await;
    }
}

#[tokio::test]
async fn a_table_prefix_is_letters_digits_and_underscores_and_does_not_start_with_a_digit() {
    for prefix in ["1rl_", "rl-", "rl_; DROP TABLE x", "", &"a".repeat(33)] {
        let error = runlight_sqlx::connect_with_prefix(":memory:", prefix).await.err().expect(prefix);
        assert_eq!(
            error.0,
            "Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit",
            "{prefix}"
        );
    }
    for prefix in ["rl_", "wp_rl_", "_x", &"A".repeat(32)] {
        assert_eq!(runlight_sqlx::connect_with_prefix(":memory:", prefix).await.unwrap().prefix(), prefix);
    }
    let prefixed = runlight_sqlx::connect_with_prefix(":memory:", "wp_rl_").await.unwrap();
    assert_eq!(SqlStore::new(prefixed.db().clone()).prefix(), "wp_rl_", "a store over a prefixed Db keeps its prefix");
    assert_eq!(runlight_sqlx::connect(":memory:").await.unwrap().tables()[..2], ["rl_meta", "rl_sites"]);
}

#[cfg(unix)]
#[tokio::test]
async fn a_new_sqlite_file_is_for_its_owner_and_group_alone_and_so_are_the_files_sqlite_makes_beside_it() {
    use std::os::unix::fs::PermissionsExt;
    let file = std::env::temp_dir().join(format!("runlight-mode-{}.db", runlight::hash::random_id(6)));
    let path = file.to_str().unwrap().to_string();
    let store = runlight_sqlx::connect(&path).await.unwrap();
    store.migrate().await.unwrap();
    store.set_setting("k", Some("v")).await.unwrap();
    let mode = |p: &str| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&path), 0o660);
    assert_eq!(mode(&format!("{path}-wal")), 0o660);
    store.close().await;
    for end in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{path}{end}"));
    }
}

/// Another process creating the tables: the lock is not got until the test says, and then either given
/// up on (busy) or taken.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Lock {
    Waiting,
    Busy,
    Free,
}

struct Gate {
    inner: Arc<dyn Db>,
    lock: watch::Receiver<Lock>,
}

impl Db for Gate {
    fn dialect(&self) -> Dialect {
        self.inner.dialect()
    }

    fn all<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<Vec<Row>, DbError>> {
        self.inner.all(sql, params)
    }

    fn run<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<u64, DbError>> {
        self.inner.run(sql, params)
    }

    fn hold(&self, kind: Hold) -> BoxFuture<'_, Result<Arc<dyn Db>, DbError>> {
        Box::pin(async move {
            if kind == Hold::Exclusive {
                let mut lock = self.lock.clone();
                let state = *lock.wait_for(|l| *l != Lock::Waiting).await.unwrap();
                if state == Lock::Busy {
                    return Err(TablesBusyError { waited: LOCK_WAIT }.into());
                }
            }
            self.inner.hold(kind).await
        })
    }
}

#[tokio::test]
async fn a_tracker_hit_waits_a_moment_at_most_while_another_process_creates_the_tables() {
    let inner = runlight_sqlx::connect(":memory:").await.unwrap().db().clone();
    let (set, lock) = watch::channel(Lock::Waiting);
    let mut options = RunlightOptions::new(SqlStore::new(Arc::new(Gate { inner, lock })));
    options.site = Some(SiteOptions { hostnames: Some(vec!["example.com".into()]), ..SiteOptions::default() });
    options.now = Some(Arc::new(|| 1_791_288_000_000));
    let rl = Runlight::new(options).unwrap();
    let routes = rl
        .routes(runlight::RoutesOptions {
            token: runlight::TokenOption::Given("secret".into()),
            ..runlight::RoutesOptions::default()
        })
        .unwrap();
    let started = Instant::now();
    let hit = routes
        .handle(
            Request::new("POST", "https://example.com/runlight/e")
                .header("user-agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")
                .header("x-forwarded-for", "203.0.113.1")
                .body(r#"{"k":"pageview","u":"https://example.com/","i":"a1"}"#),
        )
        .await;
    assert_eq!(hit.status, 202);
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(9_900) && waited < Duration::from_secs(12), "the hit waited {waited:?}");

    // The other process gives up the wait: the request that waited answers 503, saying why.
    let stats = |query: &str| {
        Request::new("GET", format!("https://example.com/runlight/api/stats?{query}"))
            .header("authorization", "Bearer secret")
    };
    let asked = tokio::spawn({
        let routes = routes.clone();
        let request = stats("period=today");
        async move { routes.handle(request).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    set.send(Lock::Busy).unwrap();
    let answer = asked.await.unwrap();
    assert_eq!(answer.status, 503);
    assert_eq!(answer.headers.get("retry-after").as_deref(), Some("30"));
    assert_eq!(
        answer.json_body().unwrap(),
        runlight::obj! { "error" => "Runlight is creating or upgrading its tables. Try again in a minute.", "code" => "tables_busy" }
    );

    // Once the tables are there, hits are counted again.
    set.send(Lock::Free).unwrap();
    rl.init().await.unwrap();
    let answer = routes.handle(stats("period=today&compare=off")).await;
    assert_eq!(
        answer.json_body().unwrap().at("stats").at("visitors").as_f64(),
        Some(0.0),
        "the hit that came while the tables were busy was dropped"
    );
}

#[tokio::test]
async fn postgres_waiting_for_another_process_creating_the_tables_gives_up_after_the_lock_wait() {
    let Some(url) = url("postgres") else { return };
    let _turn = TURN.lock().await;
    let fresh = common::fresh("postgres", &url).await;
    let other = sqlx::PgPool::connect(&url).await.unwrap();
    let mut held = other.acquire().await.unwrap();
    lock_wait_in_tests(Some(Duration::from_secs(1)));
    // The lock every Runlight takes to create tables, held by another session. Asked for again and again, as
    // the stores do, since waiting on it could deadlock with an index another process is building concurrently.
    loop {
        let got: (bool,) = sqlx::query_as("SELECT pg_try_advisory_lock(7331906)").fetch_one(&mut *held).await.unwrap();
        if got.0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let started = Instant::now();
    let error = fresh.store.migrate().await.unwrap_err();
    assert!(TablesBusyError::of(&error).is_some(), "{error}");
    assert!(error.0.contains("had not finished after 1 seconds"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(5));
    sqlx::query("SELECT pg_advisory_unlock(7331906)").execute(&mut *held).await.unwrap();
    lock_wait_in_tests(None);
    fresh.store.migrate().await.unwrap();
    drop(held);
    other.close().await;
    fresh.done().await;
}

#[tokio::test]
async fn mysql_waiting_for_another_process_creating_the_tables_gives_up_after_the_lock_wait() {
    let Some(url) = url("mysql") else { return };
    let _turn = TURN.lock().await;
    let fresh = common::fresh("mysql", &url).await;
    let other = sqlx::MySqlPool::connect(&url).await.unwrap();
    let mut held = other.acquire().await.unwrap();
    let name = "CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48))";
    lock_wait_in_tests(Some(Duration::from_secs(1)));
    // The lock every Runlight takes to create tables in this database, held by another session.
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("SELECT GET_LOCK({name}, 0)"))).execute(&mut *held).await.unwrap();
    let started = Instant::now();
    let error = fresh.store.migrate().await.unwrap_err();
    assert!(TablesBusyError::of(&error).is_some(), "{error}");
    assert!(started.elapsed() < Duration::from_secs(5));
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DO RELEASE_LOCK({name})"))).execute(&mut *held).await.unwrap();
    lock_wait_in_tests(None);
    fresh.store.migrate().await.unwrap();
    drop(held);
    other.close().await;
    fresh.done().await;
}

#[tokio::test]
async fn postgres_an_index_left_unusable_is_built_again_under_a_prefix_that_itself_starts_rl() {
    let Some(url) = url("postgres") else { return };
    let _turn = TURN.lock().await;
    let schema = format!("rl_test_{}", runlight::hash::random_id(4));
    let admin = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE SCHEMA \"{schema}\""))).execute(&admin).await.unwrap();
    let options = sqlx::postgres::PgConnectOptions::from_str(&url).unwrap().options([("search_path", &schema)]);
    let pool = sqlx::postgres::PgPoolOptions::new().max_connections(2).connect_with(options).await.unwrap();
    runlight_sqlx::postgres_with_prefix(pool.clone(), "rl_wp_").unwrap().migrate().await.unwrap();
    // As a concurrent build stopped part way leaves it.
    let index = format!("'\"{schema}\".rl_wp_events_site_ts'::regclass");
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("UPDATE pg_index SET indisvalid = false WHERE indexrelid = {index}")))
        .execute(&admin)
        .await
        .unwrap();
    runlight_sqlx::postgres_with_prefix(pool.clone(), "rl_wp_").unwrap().migrate().await.unwrap();
    let valid: (bool,) =
        sqlx::query_as(sqlx::AssertSqlSafe(format!("SELECT indisvalid FROM pg_index WHERE indexrelid = {index}")))
            .fetch_one(&admin)
            .await
            .unwrap();
    assert!(valid.0);
    pool.close().await;
    let _ = sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP SCHEMA \"{schema}\" CASCADE"))).execute(&admin).await;
    admin.close().await;
}

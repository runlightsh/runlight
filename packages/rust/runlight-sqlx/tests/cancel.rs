//! A request cancelled while it holds a connection (its client went away, or a timeout fired) must not
//! leave a transaction open or the lock taken for whoever uses the connection next.

#![cfg(all(feature = "sqlite", feature = "postgres", feature = "mysql"))]

mod common;

use std::sync::Arc;
use std::time::Duration;

use runlight::store::{Db, Hold};

/// Runs `f` until it parks, then drops it, as a cancelled request's future is dropped.
async fn cancelled<F: Future<Output = ()>>(f: F) {
    let parked = async {
        f.await;
        std::future::pending::<()>().await;
    };
    assert!(tokio::time::timeout(Duration::from_millis(300), parked).await.is_err());
}

/// What every connection of the pool sees in the table, asked at once so the pool must hand out each
/// of them: a connection left in the cancelled transaction would see its own row.
async fn seen(db: &Arc<dyn Db>) -> Vec<f64> {
    let count = || async { db.all("SELECT COUNT(*) AS n FROM rl_cancel", vec![]).await.unwrap()[0].num("n") };
    let (a, b, c, d, e) = tokio::join!(count(), count(), count(), count(), count());
    vec![a, b, c, d, e]
}

/// A transaction that works and commits, after the cancelled one.
async fn commits(db: &Arc<dyn Db>, label: &str) {
    let held = tokio::time::timeout(Duration::from_secs(20), db.hold(Hold::Transaction))
        .await
        .unwrap_or_else(|_| panic!("{label}: a transaction is held up"))
        .unwrap_or_else(|e| panic!("{label}: {e}"));
    held.run("INSERT INTO rl_cancel (n) VALUES (2)", vec![]).await.unwrap();
    held.finish(true).await.unwrap();
    let rows = db.all("SELECT n FROM rl_cancel", vec![]).await.unwrap();
    assert_eq!(rows.iter().map(|r| r.num("n")).collect::<Vec<_>>(), [2.0], "{label}");
    db.run("DELETE FROM rl_cancel", vec![]).await.unwrap();
}

/// The lock can be taken from another pool, so the cancelled holder's connection let it go.
async fn lock_free(kind: &str, url: &str, label: &str) {
    if common::base(kind) == "sqlite" {
        return;
    }
    let other = runlight_sqlx::connect(url).await.unwrap();
    let held = tokio::time::timeout(Duration::from_secs(20), other.db().hold(Hold::Exclusive))
        .await
        .unwrap_or_else(|_| panic!("{label}: the lock was never let go"))
        .unwrap();
    held.finish(true).await.unwrap();
    other.close().await;
}

#[tokio::test]
async fn a_cancelled_transaction_or_lock_leaves_the_next_one_working() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let db = fresh.store.db().clone();
        db.run("CREATE TABLE rl_cancel (n INTEGER)", vec![]).await.unwrap();

        // Cancelled inside a transaction, after a write.
        cancelled(async {
            let held = db.hold(Hold::Transaction).await.unwrap();
            held.run("INSERT INTO rl_cancel (n) VALUES (1)", vec![]).await.unwrap();
            std::future::pending::<()>().await;
            drop(held);
        })
        .await;
        commits(&db, &format!("{kind}: after a transaction")).await;

        // The same through the store's own transaction, its joined handles and all.
        let store = fresh.store.clone();
        cancelled(async {
            let _ = store
                .transaction(|tx| async move {
                    tx.db().run("INSERT INTO rl_cancel (n) VALUES (1)", vec![]).await?;
                    std::future::pending::<()>().await;
                    Ok(())
                })
                .await;
        })
        .await;
        if common::base(kind) != "sqlite" {
            assert_eq!(seen(&db).await, [0.0; 5], "{kind}: no connection is left in the transaction");
        }
        commits(&db, &format!("{kind}: after the store's transaction")).await;

        // Cancelled holding the lock.
        let holding = db.clone();
        cancelled(async move {
            let held = holding.hold(Hold::Exclusive).await.unwrap();
            std::future::pending::<()>().await;
            drop(held);
        })
        .await;
        lock_free(kind, &url, &format!("{kind}: after the lock")).await;
        commits(&db, &format!("{kind}: after the lock")).await;

        // Cancelled in a transaction inside the lock.
        let holding = db.clone();
        cancelled(async move {
            let lock = holding.hold(Hold::Exclusive).await.unwrap();
            let tx = lock.hold(Hold::Transaction).await.unwrap();
            tx.run("INSERT INTO rl_cancel (n) VALUES (1)", vec![]).await.unwrap();
            std::future::pending::<()>().await;
            drop((lock, tx));
        })
        .await;
        if common::base(kind) != "sqlite" {
            assert_eq!(seen(&db).await, [0.0; 5], "{kind}: no connection is left in the nested transaction");
        }
        lock_free(kind, &url, &format!("{kind}: after a transaction in the lock")).await;
        commits(&db, &format!("{kind}: after a transaction in the lock")).await;

        // A transaction in the lock that its owner finishes without ending: the connection is not given
        // back still in it.
        let lock = db.hold(Hold::Exclusive).await.unwrap();
        let tx = lock.hold(Hold::Transaction).await.unwrap();
        tx.run("INSERT INTO rl_cancel (n) VALUES (1)", vec![]).await.unwrap();
        lock.finish(true).await.unwrap();
        drop((lock, tx));
        if common::base(kind) != "sqlite" {
            assert_eq!(seen(&db).await, [0.0; 5], "{kind}: an unended nested transaction is not given back");
        }
        lock_free(kind, &url, &format!("{kind}: after an unended transaction in the lock")).await;
        commits(&db, &format!("{kind}: after an unended transaction in the lock")).await;

        fresh.done().await;
    }
}

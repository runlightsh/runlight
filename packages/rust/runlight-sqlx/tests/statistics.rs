//! Planner statistics and goals from rollups, as hardening.test.ts and rollups.test.ts test them, on every
//! database at hand.

#![cfg(all(feature = "sqlite", feature = "postgres", feature = "mysql"))]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use runlight::params;
use runlight::query::Query;
use runlight::store::{EventRow, GoalRow, SessionRow, SqlStore};
use runlight::{Runlight, RunlightOptions, SiteOptions};

const NOON: i64 = 1_791_374_400_000;
const DAY: i64 = 86_400_000;

async fn runlight(store: SqlStore, clock: &Arc<AtomicI64>) -> Runlight {
    let mut options = RunlightOptions::new(store);
    let clock = clock.clone();
    options.now = Some(Arc::new(move || clock.load(Ordering::SeqCst)));
    options.site = Some(SiteOptions {
        hostnames: Some(vec!["example.com".into()]),
        timezone: Some("UTC".into()),
        ..SiteOptions::default()
    });
    Runlight::new(options).unwrap()
}

/// What the store last noted about the events its statistics were gathered over.
async fn gathered_over(store: &SqlStore) -> Option<String> {
    let rows = store.db().all("SELECT value FROM rl_meta WHERE \"key\" = 'statistics_events'", vec![]).await.unwrap();
    rows.first().map(|r| r.text("value"))
}

async fn add_events(store: &SqlStore, count: usize, label: &str) {
    for start in (0..count).step_by(100) {
        let ids: Vec<usize> = (start..count.min(start + 100)).collect();
        let rows =
            ids.iter().map(|_| "('default', ?, 'pageview', 'v', 's', ?, '/', 'example.com')").collect::<Vec<_>>();
        let mut values = Vec::new();
        for i in &ids {
            values.extend(params![NOON, format!("{label}{i}")]);
        }
        store
            .db()
            .run(
                &format!(
                    "INSERT INTO rl_events (site, ts, kind, visitor, session, pageview, path, hostname) VALUES {}",
                    rows.join(", ")
                ),
                values,
            )
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn planner_statistics_gathered_on_an_empty_database_are_gathered_again_once_the_events_outgrow_them() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let clock = Arc::new(AtomicI64::new(NOON));
        let rl = runlight(fresh.store.clone(), &clock).await;
        rl.init().await.unwrap();
        let store = rl.store();
        let sqlite = common::base(kind) == "sqlite";
        let want = |events: &str| sqlite.then(|| events.to_string());
        // Gathered while still empty, by init.
        assert_eq!(gathered_over(store).await, want("0"), "{kind}: init gathered them on the empty database");
        store.optimize(true).await;
        assert_eq!(gathered_over(store).await, want("0"), "{kind}: fresh enough while still empty");
        add_events(store, 1500, "p").await;
        store.optimize(true).await;
        assert_eq!(gathered_over(store).await, want("1500"), "{kind}: gathered again once the events grew");
        if sqlite {
            let stat =
                store.db().all("SELECT stat FROM sqlite_stat1 WHERE idx = 'rl_events_site_ts'", vec![]).await.unwrap();
            // A sample, so an estimate of the 1,500 rather than an exact count.
            let counted: f64 = stat[0].text("stat").split(' ').next().unwrap().parse().unwrap();
            assert!(counted > 1000.0, "{kind}: statistics count the events: {counted}");
        }
        add_events(store, 100, "q").await;
        store.optimize(true).await;
        assert_eq!(gathered_over(store).await, want("1500"), "{kind}: not again until they double");
        // An app that never runs the scheduled check gets them from its reports, at most hourly.
        add_events(store, 1500, "r").await;
        rl.freshen_statistics().await;
        assert_eq!(gathered_over(store).await, want("3100"), "{kind}: once for the doubled events");
        add_events(store, 3200, "s").await;
        rl.freshen_statistics().await;
        assert_eq!(gathered_over(store).await, want("3100"), "{kind}: not again within the hour");
        clock.fetch_add(3_600_000, Ordering::SeqCst);
        rl.freshen_statistics().await;
        assert_eq!(gathered_over(store).await, want("6300"), "{kind}: again an hour later");
        fresh.done().await;
    }
}

fn goal(n: usize, kind: &str, match_: &str, value_mode: &str) -> GoalRow {
    GoalRow {
        id: format!("{n:024}"),
        site: "default".into(),
        name: "Signup".into(),
        kind: kind.into(),
        match_: match_.into(),
        click_by: "selector".into(),
        value_mode: value_mode.into(),
        value: 1.25,
        value_prop: "revenue".into(),
        currency: "USD".into(),
        created_at: NOON,
    }
}

/// A visit of `views` pageviews on `path`, and a "Signup" event when `signup`.
async fn visit(store: &SqlStore, id: &str, started_at: i64, path: &str, views: usize, signup: bool) {
    let session = SessionRow {
        id: id.into(),
        site: "default".into(),
        visitor: format!("v{id}"),
        started_at,
        hostname: "example.com".into(),
        ..SessionRow::default()
    };
    store.insert_session(&session).await.unwrap();
    let mut rows = Vec::new();
    for i in 0..views {
        rows.push(EventRow {
            kind: "pageview".into(),
            path: path.into(),
            pageview: format!("{id}p{i}"),
            ..EventRow::default()
        });
    }
    if signup {
        rows.push(EventRow { kind: "event".into(), path: "/".into(), name: "Signup".into(), ..EventRow::default() });
    }
    for (i, mut row) in rows.into_iter().enumerate() {
        row.site = "default".into();
        row.ts = started_at + 1000 * (i as i64 + 1);
        row.visitor = session.visitor.clone();
        row.session = id.into();
        row.hostname = "example.com".into();
        store.insert_event(&row).await.unwrap();
    }
    store
        .db()
        .run(
            "UPDATE rl_sessions SET last_at = ?, pageviews = ?, events = ?, entry_path = ?, exit_path = ? WHERE id = ?",
            params![started_at + 5000, views as i64, signup as i64, path, path, id],
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn goals_by_a_whole_path_or_a_name_come_from_rollups_and_a_pattern_or_a_sent_value_reads_events() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let clock = Arc::new(AtomicI64::new(NOON));
        let rl = runlight(fresh.store.clone(), &clock).await;
        rl.init().await.unwrap();
        let store = rl.store();
        let start = NOON - NOON.rem_euclid(DAY) - 10 * DAY;
        for day in 0..10 {
            for v in 0..4 {
                let path = if v < 2 { "/pricing" } else { "/blog/one" };
                visit(
                    store,
                    &format!("d{day}v{v}"),
                    start + day * DAY + v * 3_600_000,
                    path,
                    1 + (v as usize % 2),
                    v % 2 == 0,
                )
                .await;
            }
        }
        // Today's visit is not in a built day, so it is read from the events.
        visit(store, "today", NOON - 3_600_000, "/pricing", 1, true).await;
        let goals = [
            goal(0, "page", "/pricing", "none"),
            goal(1, "page", "/blog/*", "fixed"),
            goal(2, "event", "Signup", "fixed"),
            goal(3, "event", "Signup", "prop"),
            goal(4, "click", "button", "none"),
        ];
        for g in &goals {
            store.save_goal(g, None).await.unwrap();
        }
        let query = Query { site: "default".into(), from: start, to: NOON, filters: vec![] };
        let before = store.goal_totals_all(&query, &goals).await.unwrap();
        assert_eq!(before[&goals[0].id].conversions, 31.0, "{kind}: the pricing views are counted");
        let mut built = 0;
        loop {
            let made = rl.build_rollups().await.unwrap();
            if made == 0 {
                break;
            }
            built += made;
        }
        assert!(built >= 8, "{kind}: built {built} days");
        let rolled = store.goal_totals_all(&query, &goals).await.unwrap();
        for g in &goals {
            assert_eq!(rolled[&g.id], before[&g.id], "{kind}: {} comes out the same from the rollups", g.id);
        }
        assert_eq!(
            store.visitors(&query).await.unwrap(),
            store.stats(&query).await.unwrap().visitors,
            "{kind}: visitors"
        );
        // Proof the rollups are read: with the built days' events gone, the goals they count still add up.
        let days =
            store.db().all("SELECT MIN(start_at) AS s, MAX(end_at) AS e FROM rl_rollup_days", vec![]).await.unwrap();
        let (from, to) = (days[0].int("s"), days[0].int("e"));
        store.db().run("DELETE FROM rl_events WHERE ts >= ? AND ts < ?", params![from, to]).await.unwrap();
        store
            .db()
            .run("DELETE FROM rl_sessions WHERE started_at >= ? AND started_at < ?", params![from, to])
            .await
            .unwrap();
        let after = store.goal_totals_all(&query, &goals).await.unwrap();
        for i in [0, 2, 4] {
            assert_eq!(after[&goals[i].id], before[&goals[i].id], "{kind}: goal {i} comes from rollups");
        }
        assert!(
            after[&goals[1].id].conversions < before[&goals[1].id].conversions,
            "{kind}: a pattern reads the events"
        );
        fresh.done().await;
    }
}

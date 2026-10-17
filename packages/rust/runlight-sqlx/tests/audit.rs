//! The audit of 2026-10-16, as audit.test.ts, ingest.test.ts, rollups.test.ts, counting.test.ts,
//! hostname-suggestions.test.ts, journeys.test.ts, mail.test.ts, and oauth.test.ts test it, on every database at
//! hand: salts kept while a visit needs them, a click goal's rename in the rollups, stored text cut to its
//! column, one visit settled between processes, hostname suggestions in byte order, and the smaller report edges.

#![cfg(all(feature = "sqlite", feature = "postgres", feature = "mysql"))]

mod common;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use runlight::http::{FetchError, FetchInit, Fetcher, Request, Response};
use runlight::js::Value;
use runlight::mail::Message;
use runlight::store::{GoalRow, SessionRow, SqlStore};
use runlight::{
    AppMailer, BoxFuture, Routes, RoutesOptions, Runlight, RunlightOptions, SiteOptions, TokenOption, obj, params,
};

/// 2026-10-06 at noon UTC.
const START: i64 = 1_791_288_000_000;
const MIN: i64 = 60_000;
const HOUR: i64 = 60 * MIN;
const DAY: i64 = 24 * HOUR;
const SAFARI: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

fn site(id: &str, hostnames: &[&str], timezone: &str) -> SiteOptions {
    SiteOptions {
        id: Some(id.into()),
        hostnames: Some(hostnames.iter().map(|h| h.to_string()).collect()),
        timezone: Some(timezone.into()),
        ..SiteOptions::default()
    }
}

struct T {
    rl: Runlight,
    routes: Routes,
    clock: Arc<AtomicI64>,
}

impl T {
    async fn new(store: SqlStore, sites: Vec<SiteOptions>) -> T {
        let clock = Arc::new(AtomicI64::new(START));
        let mut options = RunlightOptions::new(store);
        let now = clock.clone();
        options.now = Some(Arc::new(move || now.load(Ordering::SeqCst)));
        options.sites = Some(sites);
        let rl = Runlight::new(options).unwrap();
        let routes = rl
            .routes(RoutesOptions { token: TokenOption::Given("secret".into()), ..RoutesOptions::default() })
            .unwrap();
        T { rl, routes, clock }
    }

    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    /// One tracker hit from an address, with a user agent and any more headers.
    async fn send_as(&self, body: &str, ip: &str, agent: &str, headers: &[(&str, &str)]) {
        let mut request = Request::new("POST", "https://example.com/runlight/e")
            .header("user-agent", agent)
            .header("x-forwarded-for", ip)
            .body(body.to_string());
        for (name, value) in headers {
            request = request.header(name, value);
        }
        self.routes.handle(request).await;
    }

    async fn send(&self, body: &str, ip: &str) {
        self.send_as(body, ip, SAFARI, &[]).await;
    }

    async fn get(&self, path: &str) -> Value {
        let request =
            Request::get(format!("https://example.com/runlight{path}")).header("authorization", "Bearer secret");
        let response = self.routes.handle(request).await;
        assert_eq!(response.status, 200, "{path}");
        response.json_body().unwrap()
    }

    async fn build_all(&self) -> usize {
        let mut built = 0;
        loop {
            let made = self.rl.build_rollups().await.unwrap();
            if made == 0 {
                return built;
            }
            built += made;
        }
    }

    async fn salt_days(&self) -> Vec<String> {
        let rows = self.rl.store().db().all("SELECT day FROM rl_salts ORDER BY day", vec![]).await.unwrap();
        rows.iter().map(|r| r.text("day")).collect()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_salt_lasts_its_day_and_past_midnight_only_while_a_visit_that_began_that_day_goes_on() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let t = T::new(fresh.store.clone(), vec![site("default", &["example.com"], "UTC")]).await;
        t.send(r#"{"k":"pageview","u":"https://example.com/","i":"s1"}"#, "203.0.113.1").await;
        for i in 0..3 {
            t.advance(DAY);
            t.send(&format!(r#"{{"k":"pageview","u":"https://example.com/","i":"s{}"}}"#, i + 2), "203.0.113.1").await;
        }
        t.rl.check().await.unwrap();
        // October 9th at noon UTC: no visit from the 8th is still going, so only today's salt is left.
        assert_eq!(t.salt_days().await, ["2026-10-09"], "{kind}");

        // A visit that runs past midnight keeps its day's salt until it ends, and stays one visit.
        t.advance(11 * HOUR + 50 * MIN);
        t.send(r#"{"k":"pageview","u":"https://example.com/late","i":"m1"}"#, "203.0.113.1").await;
        t.advance(20 * MIN);
        t.send(r#"{"k":"pageview","u":"https://example.com/later","i":"m2"}"#, "203.0.113.1").await;
        t.rl.check().await.unwrap();
        assert_eq!(t.salt_days().await, ["2026-10-09", "2026-10-10"], "{kind}: the visit is still going");
        t.advance(31 * MIN);
        t.rl.check().await.unwrap();
        assert_eq!(t.salt_days().await, ["2026-10-10"], "{kind}");
        // Noon on the 9th, and the one across midnight, which belongs to the 9th where it began.
        let stats = t.get("/api/stats?from=2026-10-09&to=2026-10-10&compare=off").await;
        let stats = stats.at("stats");
        assert_eq!(
            [stats.at("visits").as_f64().unwrap(), stats.at("pageviews").as_f64().unwrap()],
            [2.0, 3.0],
            "{kind}: the visit across midnight is one visit"
        );
        fresh.done().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn each_sites_timezone_keeps_the_salts_its_own_visits_need() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        // Toronto is still on the 9th when UTC reaches the 10th.
        let t = T::new(
            fresh.store.clone(),
            vec![site("utc", &["example.com"], "UTC"), site("to", &["example.org"], "America/Toronto")],
        )
        .await;
        t.advance(-12 * HOUR + 2 * HOUR); // 02:00 UTC on the 6th, 22:00 on the 5th in Toronto
        t.rl.check().await.unwrap();
        for day in t.salt_days().await {
            assert!(day == "2026-10-05" || day == "2026-10-06", "{kind}: {day}");
        }
        t.send(r#"{"k":"pageview","u":"https://example.org/","i":"to1"}"#, "203.0.113.1").await;
        t.send(r#"{"k":"pageview","u":"https://example.com/","i":"utc1"}"#, "203.0.113.2").await;
        t.rl.check().await.unwrap();
        assert_eq!(t.salt_days().await, ["2026-10-05", "2026-10-06"], "{kind}: today in each timezone");
        fresh.done().await;
    }
}

fn click_goal(created_at: i64) -> GoalRow {
    GoalRow {
        id: format!("{:024}", 12),
        site: "default".into(),
        name: "Buy click".into(),
        kind: "click".into(),
        match_: "button.buy".into(),
        click_by: "selector".into(),
        value_mode: "none".into(),
        value: 0.0,
        value_prop: String::new(),
        currency: "USD".into(),
        created_at,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn renaming_a_click_goal_keeps_its_conversions_on_built_days_even_onto_a_name_with_events_of_its_own() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let t = T::new(fresh.store.clone(), vec![site("default", &["example.com"], "UTC")]).await;
        t.advance(-3 * DAY);
        for i in 0..3 {
            let ip = format!("203.0.113.{}", 60 + i);
            t.send(&format!(r#"{{"k":"pageview","u":"https://example.com/","i":"c{i}"}}"#), &ip).await;
            t.send(&format!(r#"{{"k":"event","u":"https://example.com/","i":"c{i}","n":"Buy click"}}"#), &ip).await;
            // One visit also sends a plain event under the name the goal is renamed to.
            if i == 0 {
                t.send(&format!(r#"{{"k":"event","u":"https://example.com/","i":"c{i}","n":"Purchase"}}"#), &ip).await;
            }
            t.advance(HOUR);
        }
        t.advance(3 * DAY - 3 * HOUR);
        let store = t.rl.store();
        store.save_goal(&click_goal(START), None).await.unwrap();
        t.build_all().await;
        let read = async || {
            let goals = t.get("/api/goals?period=7d&compare=off").await;
            let goals: Vec<(String, f64, f64)> = goals
                .at("goals")
                .as_array()
                .unwrap()
                .iter()
                .map(|g| {
                    (
                        g.at("name").as_str().unwrap().to_string(),
                        g.at("conversions").as_f64().unwrap(),
                        g.at("visitors").as_f64().unwrap(),
                    )
                })
                .collect();
            let events = t.get("/api/breakdown?period=7d&dimension=event").await;
            let events: Vec<(String, f64)> = events
                .at("rows")
                .as_array()
                .unwrap()
                .iter()
                .map(|r| (r.at("value").as_str().unwrap().to_string(), r.at("events").as_f64().unwrap()))
                .collect();
            (goals, events)
        };
        assert_eq!(read().await.0, [("Buy click".to_string(), 3.0, 3.0)], "{kind}");
        for name in ["Checkout click", "Purchase"] {
            let before = store.goals(Some("default")).await.unwrap().remove(0);
            store.save_goal(&GoalRow { name: name.into(), ..before.clone() }, Some(&before)).await.unwrap();
            let rolled = read().await;
            let conversions = if name == "Purchase" { 4.0 } else { 3.0 };
            assert_eq!(rolled.0, [(name.to_string(), conversions, 3.0)], "{kind}: renamed to {name}");
            // Days built again where both names met, then every built day read the same as the raw events.
            t.build_all().await;
            let built = read().await;
            store.clear_rollups("default", None, None).await.unwrap();
            assert_eq!(built, read().await, "{kind}: rollups agree with the raw events after renaming to {name}");
            t.build_all().await;
        }
        fresh.done().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_header_longer_than_its_column_is_cut_to_fit_so_the_days_rollup_still_builds() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let t = T::new(fresh.store.clone(), vec![site("default", &["example.com"], "UTC")]).await;
        t.advance(-2 * DAY);
        let long = format!("\"{}\"", "Windows ".repeat(400));
        let brands = format!("\"{}\";v=\"1\"", "B".repeat(3000));
        // A browser whose user agent names no system, so the platform hint is what is stored.
        t.send_as(
            &format!(r#"{{"k":"pageview","u":"https://example.com/{}","i":"long1"}}"#, "a".repeat(1500)),
            "203.0.113.70",
            "Mozilla/5.0 (Unknown) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
            &[("sec-ch-ua-platform", &long), ("sec-ch-ua", &brands)],
        )
        .await;
        t.advance(2 * DAY);
        let rows = t.rl.store().db().all("SELECT os, entry_path FROM rl_sessions", vec![]).await.unwrap();
        let os = rows[0].text("os").chars().count();
        assert!(os > 50 && os <= 100, "{kind}: os is {os} characters");
        assert!(rows[0].text("entry_path").chars().count() <= 1000, "{kind}");
        assert!(t.build_all().await >= 1, "{kind}: the day builds");
        let stats = t.get("/api/stats?period=7d&compare=off").await;
        assert_eq!(stats.at("stats").at("visits").as_f64(), Some(1.0), "{kind}");
        fresh.done().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn on_mysql_two_processes_building_one_day_at_once_add_its_rows_once() {
    for (kind, url) in common::kinds() {
        if kind != "mysql" {
            continue;
        }
        let fresh = common::fresh(kind, &url).await;
        let t = T::new(fresh.store.clone(), vec![site("default", &["example.com"], "UTC")]).await;
        t.advance(-3 * DAY);
        for i in 0..5 {
            t.send(&format!(r#"{{"k":"pageview","u":"https://example.com/p{i}"}}"#), &format!("203.0.113.{}", 80 + i))
                .await;
        }
        let other = runlight_sqlx::mysql(
            sqlx::mysql::MySqlPoolOptions::new().max_connections(3).connect(&url).await.expect("MySQL"),
        );
        let one = t.rl.store();
        let start = START - START.rem_euclid(DAY) - 3 * DAY;
        for round in 0..5 {
            let (a, b) = tokio::join!(
                one.build_rollup_day("default", "2026-10-03", start, start + DAY),
                other.build_rollup_day("default", "2026-10-03", start, start + DAY)
            );
            assert!(a.is_ok() || b.is_ok(), "one of them builds it");
            let totals = one
                .db()
                .all(
                    "SELECT COUNT(*) AS n, SUM(visits) AS visits FROM rl_rollups WHERE site = 'default' AND day = '2026-10-03' AND dim = ''",
                    vec![],
                )
                .await
                .unwrap();
            assert_eq!([totals[0].num("n"), totals[0].num("visits")], [1.0, 5.0], "round {round}");
        }
        other.close().await;
        fresh.done().await;
    }
}

fn session(id: &str, started_at: i64) -> SessionRow {
    SessionRow {
        id: id.into(),
        site: "default".into(),
        visitor: "v1".into(),
        started_at,
        hostname: "example.com".into(),
        channel: "Direct".into(),
        ..SessionRow::default()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn two_visits_opened_for_one_visitor_at_once_by_two_processes_settle_on_one() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let store = fresh.store.clone();
        store.migrate().await.unwrap();
        store.insert_session(&session("bbbb", START)).await.unwrap();
        store.insert_session(&session("aaaa", START)).await.unwrap();
        // Each process asks after opening its own; both settle on the same one, and the other is gone.
        let visitors = ["v1".to_string()];
        let one =
            store.settle_open_session("default", &visitors, START - MIN, ("bbbb".into(), "v1".into())).await.unwrap();
        let other =
            store.settle_open_session("default", &visitors, START - MIN, ("aaaa".into(), "v1".into())).await.unwrap();
        assert_eq!([one.0.as_str(), other.0.as_str()], ["aaaa", "aaaa"], "{kind}");
        let left = store.db().all("SELECT id FROM rl_sessions", vec![]).await.unwrap();
        assert_eq!(left.iter().map(|r| r.text("id")).collect::<Vec<_>>(), ["aaaa"], "{kind}");
        fresh.done().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn hostname_suggestions_step_through_hostnames_in_the_order_they_are_sorted_in() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        // A locale's own order puts blog-staging after blog. where byte order puts it before, so suggestions
        // taken one after another in byte order must compare in byte order too, or one is skipped.
        let t = T::new(
            fresh.store.clone(),
            vec![site("a", &["blog.example.com", "blog-staging.example.com", "shop.example.com"], "UTC")],
        )
        .await;
        for (i, host) in ["blog.example.com", "blog-staging.example.com", "shop.example.com"].iter().enumerate() {
            let body = format!(r#"{{"s":"a","k":"pageview","u":"https://{host}/","i":"{i}"}}"#);
            t.send(&body, &format!("203.0.113.{}", i + 2)).await;
        }
        let answer = t.get("/api/breakdown?site=a&period=today&dimension=hostname&suggestions=1").await;
        let rows: Vec<&str> =
            answer.at("rows").as_array().unwrap().iter().map(|r| r.at("value").as_str().unwrap()).collect();
        assert_eq!(rows, ["blog-staging.example.com", "blog.example.com", "shop.example.com"], "{kind}");
        fresh.done().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn n_months_back_from_a_months_last_days_stays_in_that_month_and_paging_takes_whole_numbers() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let t = T::new(fresh.store.clone(), vec![site("default", &["example.com"], "UTC")]).await;
        t.rl.init().await.unwrap();
        t.rl.set_retention("default", Some(6)).await.unwrap();
        let utc = |y, m, d, h| runlight::js::date_utc(y, m, d, h, 0, 0, 0);
        for (now, cutoff) in [
            (utc(2026, 7, 31, 12), utc(2026, 1, 28, 12)),
            (utc(2026, 7, 30, 12), utc(2026, 1, 28, 12)),
            (utc(2028, 7, 31, 12), utc(2028, 1, 29, 12)),
            (utc(2026, 9, 6, 12), utc(2026, 3, 6, 12)),
        ] {
            t.advance(now - t.clock.load(Ordering::SeqCst));
            assert_eq!(t.rl.retention_cutoff("default").await.unwrap(), Some(cutoff), "{kind}: {now}");
        }
        for query in ["limit=2.5", "page=1e20", "limit=-3&page=0", "limit=abc&page=2.5"] {
            t.get(&format!("/api/breakdown?period=7d&dimension=page&{query}")).await;
        }
        fresh.done().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_journeys_start_end_and_through_take_a_page_as_written_as_filters_do() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let t = T::new(fresh.store.clone(), vec![site("default", &["example.com"], "UTC")]).await;
        t.send(r#"{"k":"pageview","u":"https://example.com/café","i":"a"}"#, "203.0.113.1").await;
        t.advance(30_000);
        t.send(r#"{"k":"pageview","u":"https://example.com/pricing","i":"b"}"#, "203.0.113.1").await;
        let encode = |text: &str| runlight::sources::encode_uri_component(text);
        for query in [
            format!("start={}", encode("/café")),
            format!("start={}", encode("/caf%C3%A9")),
            format!("end={}&start={}", encode("/pricing"), encode("/café")),
            format!("through={}", encode("0:/café")),
        ] {
            let answer = t.get(&format!("/api/journeys?period=today&{query}")).await;
            assert_eq!(answer.at("visits").as_f64(), Some(1.0), "{kind}: {query}");
        }
        fresh.done().await;
    }
}

/// A mail service's API that counts what it is asked to send.
struct Quiet;

impl Fetcher for Quiet {
    fn fetch<'a>(&'a self, _url: &'a str, _init: FetchInit) -> BoxFuture<'a, Result<Response, FetchError>> {
        Box::pin(async { Ok(Response::new(r#"{"id":"x"}"#, 200, Default::default())) })
    }
}

#[tokio::test]
async fn a_test_email_goes_at_most_once_a_minute_through_each_mail_service_and_counts_once_it_went_out() {
    let clock = Arc::new(AtomicI64::new(START));
    let sent: Arc<Mutex<Vec<Message>>> = Arc::default();
    let failing: Arc<Mutex<String>> = Arc::default();
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    let now = clock.clone();
    options.now = Some(Arc::new(move || now.load(Ordering::SeqCst)));
    options.fetcher = Some(Arc::new(Quiet));
    let (into, fails) = (sent.clone(), failing.clone());
    options.app_mailer = Some(AppMailer {
        from: "site@example.com".into(),
        from_name: None,
        via: "Drupal".into(),
        send: Arc::new(move |m| {
            let (into, fails) = (into.clone(), fails.clone());
            Box::pin(async move {
                let fail = fails.lock().unwrap().clone();
                if !fail.is_empty() {
                    return Err(fail.into());
                }
                into.lock().unwrap().push(m);
                Ok(())
            })
        }),
    });
    let rl = Runlight::new(options).unwrap();
    let routes =
        rl.routes(RoutesOptions { token: TokenOption::Given("t".into()), ..RoutesOptions::default() }).unwrap();
    let test = async || {
        let request = Request::new("POST", "https://stats.example.com/runlight/api/mail/test")
            .header("authorization", "Bearer t")
            .header("content-type", "application/json")
            .body(obj! { "to" => "jon@example.com" }.to_json());
        let response = routes.handle(request).await;
        (response.status, response.json_body().unwrap().at("code").as_str().map(str::to_string))
    };
    // A test that failed does not count, so it can be tried again straight away.
    *failing.lock().unwrap() = "SMTP connect() failed".into();
    assert_eq!(test().await.0, 400);
    failing.lock().unwrap().clear();
    assert_eq!(test().await.0, 200);
    // Another through it straight away waits a minute, so the button cannot flood an inbox.
    assert_eq!(test().await, (429, Some("test_soon".to_string())));
    assert_eq!(sent.lock().unwrap().len(), 1);
    clock.fetch_add(MIN, Ordering::SeqCst);
    assert_eq!(test().await.0, 200);
    assert_eq!(sent.lock().unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sites_agents_key_is_kept_sealed_and_one_kept_as_plain_text_before_still_works_and_is_sealed_when_read() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let mut options = RunlightOptions::new(fresh.store.clone());
        options.secret = Some("s".repeat(32));
        options.sites = Some(vec![site("default", &["example.com"], "UTC")]);
        let rl = Runlight::new(options).unwrap();
        rl.init().await.unwrap();
        let routes =
            rl.routes(RoutesOptions { token: TokenOption::Given("owner".into()), ..RoutesOptions::default() }).unwrap();
        let ask = async |method: &str, path: &str, bearer: &str, body: &str| {
            let request = Request::new(method, format!("https://example.com/runlight{path}"))
                .header("authorization", format!("Bearer {bearer}"))
                .header("content-type", "application/json")
                .body(body.to_string());
            routes.handle(request).await
        };
        let made = ask("GET", "/api/observe-key", "owner", "").await;
        let key = made.json_body().unwrap().at("key").as_str().unwrap().to_string();
        let stored = rl.store().setting("observe-key:default").await.unwrap().unwrap();
        assert!(!stored.contains(&key), "{kind}: not in the database as it is");
        let observe = async |bearer: &str| {
            let body = r#"{"url":"https://example.com/","userAgent":"Mozilla/5.0 (compatible; GPTBot/1.2)"}"#;
            ask("POST", "/api/observe", bearer, body).await.status
        };
        assert_eq!(observe(&key).await, 204, "{kind}");
        // A key from before, kept as it was.
        rl.store().set_setting("observe-key:default", Some("rlo_legacykeylegacykey00")).await.unwrap();
        assert_eq!(observe("rlo_legacykeylegacykey00").await, 204, "{kind}");
        let shown = ask("GET", "/api/observe-key", "owner", "").await;
        assert_eq!(
            shown.json_body().unwrap().at("key").as_str(),
            Some("rlo_legacykeylegacykey00"),
            "{kind}: shown as it was"
        );
        let now = rl.store().setting("observe-key:default").await.unwrap().unwrap();
        assert!(!now.contains("rlo_legacy"), "{kind}: and sealed now");
        assert_eq!(observe("rlo_legacykeylegacykey00").await, 204, "{kind}: still working");
        assert_eq!(observe("rlo_wrongkeywrongkeywron").await, 401, "{kind}");
        fresh.done().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rows_are_cut_in_characters_not_bytes() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let store = fresh.store.clone();
        store.migrate().await.unwrap();
        // 300 two-byte characters in a column 255 wide.
        let row = SessionRow { hostname: "é".repeat(300), ..session("long", START) };
        store.insert_session(&row).await.unwrap();
        let stored = store.db().all("SELECT hostname FROM rl_sessions WHERE id = ?", params!["long"]).await.unwrap();
        assert_eq!(stored[0].text("hostname").chars().count(), 255, "{kind}");
        fresh.done().await;
    }
}

#[tokio::test]
async fn sites_sort_as_node_sorts_their_names() {
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    options.managed_sites = true;
    let rl = Runlight::new(options).unwrap();
    rl.init().await.unwrap();
    for (i, name) in ["fa", "éa", "Ea", "a-b", "a_b", "äb", "Ab", "ab"].iter().enumerate() {
        let input = obj! { "hostnames" => format!("site{i}.example.com"), "name" => *name };
        rl.add_site(&input).await.unwrap();
    }
    let names: Vec<String> = rl.sites().into_iter().map(|s| s.name).collect();
    // What `a.name.localeCompare(b.name)` gives in Node, the order the dashboard's site list takes.
    assert_eq!(names, ["a_b", "a-b", "ab", "Ab", "äb", "Ea", "éa", "fa"]);
}

#[tokio::test]
async fn oauth_json_answers_say_not_to_sniff_them() {
    let rl = Runlight::new(RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap())).unwrap();
    let routes =
        rl.routes(RoutesOptions { token: TokenOption::Given("t".into()), ..RoutesOptions::default() }).unwrap();
    let meta = routes.handle(Request::get("https://example.com/runlight/.well-known/oauth-authorization-server")).await;
    assert_eq!(meta.status, 200);
    assert_eq!(meta.headers.get("x-content-type-options").as_deref(), Some("nosniff"));
    let token = routes
        .handle(
            Request::new("POST", "https://example.com/runlight/oauth/token")
                .header("content-type", "application/x-www-form-urlencoded")
                .body("grant_type=authorization_code&code=x"),
        )
        .await;
    assert_eq!(token.status, 400);
    assert_eq!(token.headers.get("x-content-type-options").as_deref(), Some("nosniff"));
}

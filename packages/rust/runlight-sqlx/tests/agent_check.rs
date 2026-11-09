//! AI agent fetches checked against the addresses their companies publish, as ingest.test.ts tests it:
//! verified, mismatch, no list, no address, a reported address in place of the request's, no address
//! kept, and the lists downloaded once a day with update_agent_ranges.

#![cfg(all(feature = "sqlite", feature = "postgres", feature = "mysql"))]

mod common;

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use runlight::http::{FetchError, FetchInit, Fetcher, Headers, Request, Response};
use runlight::js::Value;
use runlight::store::SqlStore;
use runlight::{BoxFuture, Routes, RoutesOptions, Runlight, RunlightOptions, SiteOptions, TokenOption};

/// 2026-11-08 at noon UTC.
const START: i64 = 1_794_139_200_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
const GPTBOT: &str =
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const META: &str = "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)";

/// Stands in for every company's server: counts what it is asked for and answers as told.
#[derive(Default)]
struct Lists {
    asked: Mutex<Vec<String>>,
    /// The body every list is answered with.
    answer: Mutex<String>,
}

impl Fetcher for Lists {
    fn fetch<'a>(&'a self, url: &'a str, init: FetchInit) -> BoxFuture<'a, Result<Response, FetchError>> {
        Box::pin(async move {
            assert_eq!(init.headers.get("user-agent").as_deref(), Some("Runlight (+https://runlight.sh)"));
            self.asked.lock().unwrap().push(url.to_string());
            let body = self.answer.lock().unwrap().clone();
            Ok(Response { status: 200, headers: Headers::new(), body: body.into_bytes() })
        })
    }
}

impl Lists {
    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }

    fn answer(&self, body: &str) {
        *self.answer.lock().unwrap() = body.to_string();
    }
}

fn runlight(store: SqlStore, clock: &Arc<AtomicI64>, lists: &Arc<Lists>, update: bool) -> Runlight {
    let mut options = RunlightOptions::new(store);
    let now = clock.clone();
    options.now = Some(Arc::new(move || now.load(Ordering::SeqCst)));
    options.site = Some(SiteOptions::default());
    options.fetcher = Some(lists.clone());
    options.update_agent_ranges = update;
    Runlight::new(options).unwrap()
}

fn routes(rl: &Runlight) -> Routes {
    rl.routes(RoutesOptions { token: TokenOption::Given("secret".into()), ..RoutesOptions::default() }).unwrap()
}

async fn get(routes: &Routes, path: &str) -> Value {
    let request = Request::get(format!("https://example.com/runlight{path}")).header("authorization", "Bearer secret");
    let response = routes.handle(request).await;
    assert_eq!(response.status, 200, "{path}");
    response.json_body().unwrap()
}

/// A page fetched by `ua`, from `ip` when given (through a proxy's header).
async fn fetch(rl: &Runlight, ua: &str, ip: Option<&str>) -> bool {
    let mut request = Request::get("https://example.com/post").header("user-agent", ua).header("host", "example.com");
    if let Some(ip) = ip {
        request = request.header("x-forwarded-for", ip);
    }
    rl.observe(&request, None).await
}

/// The breakdown's rows as (value, fetches, claimed).
async fn agents(routes: &Routes) -> Vec<(String, f64, Option<bool>)> {
    let body = get(routes, "/api/breakdown?period=today&dimension=ai_agent").await;
    body.at("rows")
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let keys: Vec<&str> = r.as_object().unwrap().keys().collect();
            assert_eq!(keys, ["value", "visitors", "fetches", "claimed"]);
            (r.at("value").as_str().unwrap().to_string(), r.at("fetches").as_f64().unwrap(), r.at("claimed").as_bool())
        })
        .collect()
}

async fn titles(rl: &Runlight) -> Vec<String> {
    let rows = rl.store().db().all("SELECT title FROM rl_events WHERE kind = 'fetch'", vec![]).await.unwrap();
    let mut titles: Vec<String> = rows.iter().map(|r| r.text("title")).collect();
    titles.sort();
    titles
}

fn row(value: &str, fetches: f64, claimed: bool) -> (String, f64, Option<bool>) {
    (value.to_string(), fetches, Some(claimed))
}

#[tokio::test(flavor = "multi_thread")]
async fn an_ai_agents_address_is_checked_against_its_companys_list_and_only_the_answer_is_kept() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let clock = Arc::new(AtomicI64::new(START));
        let lists = Arc::new(Lists::default());
        let rl = runlight(fresh.store.clone(), &clock, &lists, false);
        let routes = routes(&rl);
        assert!(fetch(&rl, GPTBOT, Some("20.171.206.17")).await, "{kind}"); // in OpenAI's published GPTBot list
        assert!(fetch(&rl, GPTBOT, Some("20.171.206.18")).await, "{kind}");
        assert!(fetch(&rl, GPTBOT, Some("198.51.100.23")).await, "{kind}"); // says GPTBot, comes from elsewhere
        assert!(fetch(&rl, GPTBOT, None).await, "{kind}"); // no address to check
        assert!(fetch(&rl, META, Some("157.240.0.1")).await, "{kind}"); // Meta publishes no list
        // A log reader's or plugin's report names the agent's address itself; it never stands in for the reporter's.
        let reported = Request::get("https://example.com/post")
            .header("user-agent", GPTBOT)
            .header("x-forwarded-for", "198.51.100.40");
        assert!(rl.observe_with(&reported, None, Some("20.171.206.99")).await, "{kind}");

        assert_eq!(
            agents(&routes).await,
            [row("GPTBot", 3.0, false), row("GPTBot", 2.0, true), row("meta-externalagent", 1.0, true)],
            "{kind}"
        );
        assert_eq!(titles(&rl).await, ["", "", "mismatch", "verified", "verified", "verified"], "{kind}");
        let dump = rl.store().db().all("SELECT * FROM rl_events", vec![]).await.unwrap();
        let dump = Value::Array(dump.iter().map(|r| r.to_value()).collect()).to_json();
        for ip in ["20.171.206.17", "198.51.100.23", "157.240.0.1", "198.51.100.40", "20.171.206.99"] {
            assert!(!dump.contains(ip), "{kind}: no address: {ip}");
        }
        assert!(lists.asked().is_empty(), "{kind}: nothing downloaded");
        fresh.done().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_report_through_the_api_is_checked_against_its_own_address_never_the_reporters() {
    let clock = Arc::new(AtomicI64::new(START));
    let lists = Arc::new(Lists::default());
    let rl = runlight(runlight_sqlx::connect(":memory:").await.unwrap(), &clock, &lists, false);
    let routes = routes(&rl);
    let body = format!(
        r#"{{"fetches":[{{"url":"https://example.com/a","userAgent":"{GPTBOT}","ip":"20.171.206.17"}},{{"url":"https://example.com/b","userAgent":"{GPTBOT}"}},{{"url":"https://example.com/c","userAgent":"{GPTBOT}","ip":351391249}}]}}"#
    );
    let request = Request::new("POST", "https://example.com/runlight/api/observe")
        .header("authorization", "Bearer secret")
        .header("content-type", "application/json")
        .header("x-forwarded-for", "20.171.206.18")
        .body(body);
    let response = routes.handle(request).await;
    assert_eq!(response.status, 200);
    assert_eq!(agents(&routes).await, [row("GPTBot", 2.0, true), row("GPTBot", 1.0, false)]);
    assert_eq!(titles(&rl).await, ["", "", "verified"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn update_agent_ranges_downloads_the_lists_once_a_day_keeps_a_good_copy_over_a_bad_download_and_shares_it() {
    let clock = Arc::new(AtomicI64::new(START));
    let lists = Arc::new(Lists::default());
    lists.answer(r#"{"prefixes":[{"ipv4Prefix":"192.0.2.0/24"}]}"#);
    let store = runlight_sqlx::connect(":memory:").await.unwrap();
    let rl = runlight(store.clone(), &clock, &lists, true);
    rl.check().await.unwrap();
    assert!(lists.asked().contains(&"https://openai.com/gptbot.json".to_string()));
    let first_round = lists.asked().len();
    assert_eq!(first_round, runlight::agentcheck::AGENT_RANGES.urls.len(), "each list once");
    fetch(&rl, GPTBOT, Some("192.0.2.7")).await; // in the downloaded list
    fetch(&rl, GPTBOT, Some("20.171.206.17")).await; // in the bundled list only, which the download replaced
    clock.fetch_add(HOUR, Ordering::SeqCst);
    rl.check().await.unwrap();
    assert_eq!(lists.asked().len(), first_round, "not again within the day");

    clock.fetch_add(DAY, Ordering::SeqCst);
    lists.answer("<html>maintenance</html>");
    rl.check().await.unwrap();
    assert_eq!(lists.asked().len(), first_round * 2, "a day later it tries again");
    fetch(&rl, GPTBOT, Some("192.0.2.8")).await; // the bad download kept the good copy
    let saved = store.setting("agent-ranges").await.unwrap().unwrap();
    let saved = runlight::js::parse(&saved).unwrap();
    assert_eq!(saved.at("at").as_f64(), Some((START + HOUR + DAY) as f64), "the failed day is saved as tried");
    assert_eq!(saved.at("lists").at("https://openai.com/gptbot.json").to_json(), r#"["192.0.2.0/24"]"#);

    // Another process sharing the database uses the lists without downloading them.
    let other = runlight(store.clone(), &clock, &lists, false);
    other.check().await.unwrap();
    assert_eq!(lists.asked().len(), first_round * 2);
    fetch(&other, GPTBOT, Some("192.0.2.9")).await;

    assert_eq!(titles(&rl).await, ["mismatch", "verified", "verified", "verified"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_saved_list_that_does_not_read_as_one_is_left_out_and_the_bundled_one_used() {
    let clock = Arc::new(AtomicI64::new(START));
    let lists = Arc::new(Lists::default());
    let store = runlight_sqlx::connect(":memory:").await.unwrap();
    let rl = runlight(store.clone(), &clock, &lists, false);
    rl.init().await.unwrap();
    let saved = format!(
        r#"{{"at":{START},"lists":{{"https://openai.com/gptbot.json":["192.0.2.0/24","junk"],"https://claude.com/crawling/bots.json":["198.51.100.0/24"]}}}}"#
    );
    store.set_setting("agent-ranges", Some(&saved)).await.unwrap();
    rl.check().await.unwrap();
    fetch(&rl, GPTBOT, Some("20.171.206.17")).await; // the bundled list, as the saved one was refused
    fetch(&rl, "Mozilla/5.0 (compatible; ClaudeBot/1.0)", Some("198.51.100.7")).await; // the saved one
    assert_eq!(titles(&rl).await, ["verified", "verified"]);
    assert!(lists.asked().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn without_update_agent_ranges_runlight_never_downloads_the_lists() {
    let clock = Arc::new(AtomicI64::new(START));
    let lists = Arc::new(Lists::default());
    let rl = runlight(runlight_sqlx::connect(":memory:").await.unwrap(), &clock, &lists, false);
    rl.check().await.unwrap();
    clock.fetch_add(2 * DAY, Ordering::SeqCst);
    rl.check().await.unwrap();
    assert!(lists.asked().is_empty());
    assert_eq!(rl.store().setting("agent-ranges").await.unwrap(), None);
}

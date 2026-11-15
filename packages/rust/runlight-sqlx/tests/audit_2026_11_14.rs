//! The audit of 2026-11-14: statements that read the same whatever Postgres's standard_conforming_strings says,
//! a site-scoped account's reads that name /oauth/ in a query, one init() for every tracker hit waiting on it,
//! and an app whose every request asks about link domains carrying on while the database is down.

#![cfg(all(feature = "sqlite", feature = "postgres", feature = "mysql"))]

mod common;

use std::str::FromStr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use axum::body::Body;
use http_body_util::BodyExt;
use runlight::http::{Request, Response, SearchParams, Url};
use runlight::js;
use runlight::store::{Db, DbError, Dialect, Hold, Param, Row, SqlStore};
use runlight::{BoxFuture, RoutesOptions, Runlight, RunlightOptions, SiteOptions, TokenOption, obj};
use tower::ServiceExt;

const SAFARI: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

fn site() -> Option<SiteOptions> {
    Some(SiteOptions { hostnames: Some(vec!["example.com".into()]), ..SiteOptions::default() })
}

fn hit(path: &str) -> Request {
    Request::new("POST", "https://example.com/runlight/e")
        .header("user-agent", SAFARI)
        .body(obj! { "k" => "pageview", "u" => format!("https://example.com{path}"), "s" => "" }.to_json())
}

fn visitors(answer: &Response) -> f64 {
    assert_eq!(answer.status, 200, "{}", answer.text());
    answer.json_body().unwrap().at("stats").at("visitors").as_f64().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_11_14_filters_read_the_same_on_postgres_with_standard_conforming_strings_off() {
    let Some((_, url)) = common::kinds().into_iter().find(|(kind, _)| *kind == "postgres") else { return };
    let name = format!("rl_rust_{}", runlight::hash::random_id(5));
    let admin = sqlx::PgPool::connect(&url).await.expect("Postgres");
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE SCHEMA \"{name}\""))).execute(&admin).await.expect("a schema");
    // With it off, a backslash in 'text' is an escape, so a plain ESCAPE '\' would never close.
    let options = sqlx::postgres::PgConnectOptions::from_str(&url)
        .expect("a URL")
        .options([("search_path", name.as_str()), ("standard_conforming_strings", "off")]);
    let pool = sqlx::postgres::PgPoolOptions::new().max_connections(5).connect_with(options).await.expect("Postgres");
    let off: String = sqlx::query_scalar("SHOW standard_conforming_strings").fetch_one(&pool).await.unwrap();
    assert_eq!(off, "off");

    let mut options = RunlightOptions::new(runlight_sqlx::postgres(pool));
    options.site = site();
    let rl = Runlight::new(options).unwrap();
    let routes = rl.routes(RoutesOptions { token: TokenOption::Open, ..RoutesOptions::default() }).unwrap();
    assert_eq!(routes.handle(hit("/pricing/plans")).await.status, 202);
    let read = |filters: &[&str]| {
        let mut query = SearchParams::from_pairs([("period", "today")]);
        for filter in filters {
            query.append("filter", filter);
        }
        routes.handle(Request::get(format!("https://example.com/runlight/api/stats?{query}")))
    };
    assert_eq!(visitors(&read(&[]).await), 1.0);
    // A path filter is tried in several cases, each its own LIKE with its own ESCAPE.
    assert_eq!(visitors(&read(&["page:contains:Pricing"]).await), 1.0);
    assert_eq!(visitors(&read(&["page:contains:nowhere"]).await), 0.0);
    assert_eq!(visitors(&read(&["browser:contains:saf", "os:contains:mac"]).await), 1.0);
    // Text that would be SQL if a value before it ran on past its closing quote is only ever text.
    for value in ["x' OR $$a$$=$$a$$ --", "\\", "a\\' OR 1=1 --", "$$) OR TRUE --", "%_\\%"] {
        let filters = [format!("browser:contains:{value}"), format!("os:contains:{value}")];
        let answer = read(&[filters[0].as_str(), filters[1].as_str()]).await;
        assert_eq!(visitors(&answer), 0.0, "{value}");
        assert_eq!(visitors(&read(&[format!("page:contains:{value}").as_str()]).await), 0.0, "{value}");
    }
    // Settings are found by their prefix, with the same clause.
    rl.store().set_setting("remote:a_b", Some("x")).await.unwrap();
    rl.store().set_setting("remote:a%b", Some("y")).await.unwrap();
    assert_eq!(rl.store().settings_starting_with("remote:a_").await.unwrap(), [("remote:a_b".into(), "x".into())]);

    rl.store().close().await;
    let _ =
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP SCHEMA IF EXISTS \"{name}\" CASCADE"))).execute(&admin).await;
    admin.close().await;
}

fn cookie_of(response: &Response) -> String {
    response.headers.get_set_cookie().first().map(|c| c.split(';').next().unwrap().to_string()).unwrap_or_default()
}

fn form(path: &str, fields: &[(&str, &str)]) -> Request {
    Request::new("POST", format!("https://example.com/runlight{path}"))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(SearchParams::from_pairs(fields.iter().copied()).to_string())
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_11_14_an_account_kept_to_one_site_reads_a_query_that_names_oauth_in_a_path() {
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    options.site = site();
    options.secret = Some("k".repeat(64));
    let rl = Runlight::new(options).unwrap();
    let routes = rl
        .routes(RoutesOptions {
            token: TokenOption::Given("app-token".into()),
            accounts: true,
            ..RoutesOptions::default()
        })
        .unwrap();
    let setup = [
        ("code", "app-token"),
        ("email", "jon@example.com"),
        ("password", "a long password"),
        ("again", "a long password"),
    ];
    let owner = cookie_of(&routes.handle(form("/setup", &setup)).await);
    let invited = routes
        .handle(
            Request::new("POST", "https://example.com/runlight/api/people")
                .header("cookie", &owner)
                .header("content-type", "application/json")
                .body(obj! { "site" => "default", "email" => "vi@example.com", "role" => "viewer" }.to_json()),
        )
        .await;
    assert_eq!(invited.status, 201, "{}", invited.text());
    let link = js::str_or_empty(invited.json_body().unwrap().get("link"));
    let code = Url::parse(&link).unwrap().search_params().get("code").unwrap().to_string();
    let joined = [("code", code.as_str()), ("password", "a long password"), ("again", "a long password")];
    let viewer = cookie_of(&routes.handle(form("/invite", &joined)).await);
    assert!(!viewer.is_empty());

    let get = |path: &str| {
        routes.handle(Request::get(format!("https://example.com/runlight{path}")).header("cookie", &viewer))
    };
    assert_eq!(get("/api/stats?period=today").await.status, 200);
    // Written as a script writes it, the slashes as they are.
    assert_eq!(get("/api/stats?period=today&filter=page:is:/oauth/callback").await.status, 200);
    assert_eq!(get("/api/breakdown?period=today&dimension=page&filter=page:contains:/oauth/").await.status, 200);
    // The consent page itself is still not theirs to allow an app from.
    let consent = get("/oauth/authorize?response_type=code&client_id=x&redirect_uri=https://app.example/cb").await;
    assert_ne!(consent.status, 200);
}

/// A database that can be made to fail, counting what it is asked.
struct Flaky {
    inner: Arc<dyn Db>,
    down: AtomicBool,
    /// How long a failure takes, as a database that cannot be reached takes a while to say so.
    slow: std::time::Duration,
    asked: AtomicUsize,
    locks: AtomicUsize,
}

impl Flaky {
    fn over(store: &SqlStore, slow: u64) -> Arc<Flaky> {
        Arc::new(Flaky {
            inner: store.db().clone(),
            down: AtomicBool::new(false),
            slow: std::time::Duration::from_millis(slow),
            asked: AtomicUsize::new(0),
            locks: AtomicUsize::new(0),
        })
    }

    async fn check(&self) -> Result<(), DbError> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        if self.down.load(Ordering::SeqCst) {
            tokio::time::sleep(self.slow).await;
            return Err(DbError("the database is down".into()));
        }
        Ok(())
    }
}

impl Db for Flaky {
    fn dialect(&self) -> Dialect {
        self.inner.dialect()
    }

    fn all<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<Vec<Row>, DbError>> {
        Box::pin(async move {
            self.check().await?;
            self.inner.all(sql, params).await
        })
    }

    fn run<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<u64, DbError>> {
        Box::pin(async move {
            self.check().await?;
            self.inner.run(sql, params).await
        })
    }

    fn hold(&self, kind: Hold) -> BoxFuture<'_, Result<Arc<dyn Db>, DbError>> {
        Box::pin(async move {
            if kind == Hold::Exclusive {
                self.locks.fetch_add(1, Ordering::SeqCst);
            }
            self.check().await?;
            self.inner.hold(kind).await
        })
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_11_14_tracker_hits_that_arrive_while_the_tables_are_made_share_one_init() {
    let flaky = Flaky::over(&runlight_sqlx::connect(":memory:").await.unwrap(), 300);
    let mut options = RunlightOptions::new(SqlStore::new(flaky.clone()));
    options.site = site();
    let rl = Runlight::new(options).unwrap();
    flaky.down.store(true, Ordering::SeqCst);
    // Twenty hits at once, while making the tables takes a while and then fails: one try for all of them, where
    // each starting its own would try twenty times, one after the other.
    let hits: Vec<_> = (0..20)
        .map(|_| {
            let rl = rl.clone();
            tokio::spawn(async move { rl.collect(&hit("/")).await })
        })
        .collect();
    for sent in hits {
        assert!(sent.await.unwrap().is_ok(), "a hit that could not be recorded is logged, never an error");
    }
    assert_eq!(flaky.locks.load(Ordering::SeqCst), 1);
    // One that failed is tried again by the next hit.
    flaky.down.store(false, Ordering::SeqCst);
    rl.collect(&hit("/")).await.unwrap();
    assert_eq!(flaky.locks.load(Ordering::SeqCst), 2);
    assert!(rl.store().last_seen("default").await.unwrap().is_some());
}

async fn body(response: axum::response::Response) -> (u16, String) {
    let status = response.status().as_u16();
    (status, String::from_utf8_lossy(&response.into_body().collect().await.unwrap().to_bytes()).into_owned())
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_11_14_an_app_carries_on_while_the_database_is_down() {
    let flaky = Flaky::over(&runlight_sqlx::connect(":memory:").await.unwrap(), 0);
    let mut options = RunlightOptions::new(SqlStore::new(flaky.clone()));
    options.site = site();
    let rl = Runlight::new(options).unwrap();
    rl.init().await.unwrap();
    rl.store().add_link_domain("go.example.com", "default", rl.now()).await.unwrap();
    let app: axum::Router = axum::Router::new()
        .fallback(|| async { "the app" })
        .layer(axum::middleware::from_fn_with_state(rl.clone(), runlight::adapters::axum_support::middleware));
    let get = |url: &str| app.clone().oneshot(http::Request::get(url).body(Body::empty()).unwrap());
    assert_eq!(body(get("http://example.com/").await.unwrap()).await, (200, "the app".into()));
    assert_eq!(body(get("http://go.example.com/").await.unwrap()).await, (404, "Not found".into()), "a link domain");

    // The database goes, and what was read of the link domains is forgotten: the app's pages are still served,
    // the first asking once and the rest not at all, until a few seconds have passed.
    flaky.down.store(true, Ordering::SeqCst);
    rl.forget_link_domains();
    let before = flaky.asked.load(Ordering::SeqCst);
    assert_eq!(body(get("http://example.com/").await.unwrap()).await, (200, "the app".into()));
    assert_eq!(flaky.asked.load(Ordering::SeqCst), before + 1);
    for _ in 0..5 {
        assert_eq!(body(get("http://example.com/").await.unwrap()).await, (200, "the app".into()));
        // Nothing is a link domain meanwhile, so its requests reach the app too.
        assert_eq!(body(get("http://go.example.com/").await.unwrap()).await, (200, "the app".into()));
    }
    assert_eq!(flaky.asked.load(Ordering::SeqCst), before + 1, "the database is left alone");
    // The services the app routes to Runlight answer the same way, with no error of their own.
    let answer = rl.link_service().oneshot(http::Request::get("http://example.com/go/x").body(Body::empty()).unwrap());
    assert_eq!(answer.await.unwrap().status().as_u16(), 404);

    // Back again, and asked again: the link domain answers for itself once more.
    flaky.down.store(false, Ordering::SeqCst);
    rl.forget_link_domains();
    assert_eq!(body(get("http://go.example.com/").await.unwrap()).await, (404, "Not found".into()));
    assert_eq!(body(get("http://example.com/").await.unwrap()).await, (200, "the app".into()));
}

// The behaviour brought over from the TypeScript after the audit.

const GPTBOT: &str =
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";

/// 2026-11-10 at noon UTC, after the day the bundled address lists were fetched.
const NOW: i64 = 1_794_312_000_000;

async fn install(rate_limit: Option<f64>) -> Runlight {
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    options.site = site();
    options.rate_limit = rate_limit;
    options.now = Some(Arc::new(|| NOW));
    let rl = Runlight::new(options).unwrap();
    rl.init().await.unwrap();
    rl
}

async fn count(rl: &Runlight, kind: &str) -> usize {
    rl.store().db().all("SELECT id FROM rl_events WHERE kind = ?", vec![Param::Text(kind.into())]).await.unwrap().len()
}

#[tokio::test(flavor = "multi_thread")]
async fn round_two_a_click_past_the_trackers_limit_still_redirects_and_is_not_counted() {
    let rl = install(Some(2.0)).await;
    let link = runlight::store::LinkRow {
        id: "a".repeat(24),
        site: "default".into(),
        domain: String::new(),
        slug: "docs".into(),
        name: "Docs".into(),
        url: "https://docs.example.com/start".into(),
        created_at: 0,
        updated_at: 0,
    };
    rl.store().insert_link(&link).await.unwrap();
    let click = |ip: &str| {
        let mut request = Request::get("https://example.com/go/docs").header("user-agent", SAFARI);
        request.remote_address = ip.into();
        request
    };
    for _ in 0..5 {
        assert_eq!(rl.link_response(&click("203.0.113.9")).await.unwrap().status, 302);
    }
    assert_eq!(count(&rl, "click").await, 2, "two a minute are counted, and the rest only redirect");
    // An address of its own has a count of its own, and no address at all is not limited.
    assert_eq!(rl.link_response(&click("203.0.113.10")).await.unwrap().status, 302);
    for _ in 0..3 {
        rl.link_response(&click("")).await.unwrap();
    }
    assert_eq!(count(&rl, "click").await, 6);
}

#[tokio::test(flavor = "multi_thread")]
async fn round_two_an_agents_fetches_seen_live_are_limited_and_reported_ones_are_not() {
    let rl = install(Some(1.0)).await;
    let live = || {
        let mut request =
            Request::get("https://example.com/post").header("user-agent", GPTBOT).header("host", "example.com");
        request.remote_address = "203.0.113.9".into();
        request
    };
    let mut seen = 0;
    for _ in 0..15 {
        seen += usize::from(rl.observe(&live(), None).await);
    }
    assert_eq!(seen, 10, "ten times the tracker's limit, a minute");
    // A log reader's report gives the agent's address, or none ("") when it has none: never limited.
    for _ in 0..12 {
        assert!(rl.observe_with(&live(), None, Some("")).await);
    }
    assert_eq!(count(&rl, "fetch").await, 22);
    // With no limit on hits there is none on fetches.
    let open = install(Some(0.0)).await;
    for _ in 0..30 {
        assert!(open.observe(&live(), None).await);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn round_two_a_fetch_is_recorded_under_the_host_it_was_for_and_with_any_logged_user_agent() {
    let rl = install(None).await;
    // The first name a trusted proxy gives, without its port, is the page's host; the URL's own is not.
    let request = Request::get("https://internal.invalid/post")
        .header("user-agent", GPTBOT)
        .header("host", "internal.invalid")
        .header("x-forwarded-host", "www.Example.com:8443, proxy.invalid");
    assert!(rl.observe(&request, None).await);
    // From a public address the header is the client's own to write, so it is not read.
    let mut direct = request.clone();
    direct.remote_address = "8.8.8.8".into();
    assert!(!rl.observe(&direct, None).await, "internal.invalid is no site here");
    // A user agent as a log holds it, given as text: a line break and letters no header takes.
    let page = Request::get("https://example.com/caf%C3%A9");
    assert!(rl.observe_as(&page, None, Some(""), Some("GPTBot/1.2\n (caf\u{e9} \u{4e16}\u{754c})")).await);
    assert!(!rl.observe_as(&page, None, Some(""), Some("curl/8.0")).await);
    let rows = rl
        .store()
        .db()
        .all("SELECT hostname, path FROM rl_events WHERE kind = 'fetch' ORDER BY id", vec![])
        .await
        .unwrap();
    let got: Vec<(String, String)> = rows.iter().map(|r| (r.text("hostname"), r.text("path"))).collect();
    assert_eq!(got, [("example.com".into(), "/post".into()), ("example.com".into(), "/caf%C3%A9".into())]);
}

#[tokio::test(flavor = "multi_thread")]
async fn round_two_a_salt_newer_than_the_days_kept_is_never_deleted() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let store = &fresh.store;
        store.migrate().await.unwrap();
        for day in ["2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"] {
            store.salt(day, day).await.unwrap();
        }
        // A process whose clock is a moment behind keeps yesterday and today, as it sees them.
        store.drop_salts_except(&["2026-11-10".into(), "2026-11-09".into()]).await.unwrap();
        assert_eq!(store.salt_if_exists("2026-11-08").await.unwrap(), None, "{kind}");
        for day in ["2026-11-09", "2026-11-10", "2026-11-11"] {
            assert_eq!(store.salt_if_exists(day).await.unwrap().as_deref(), Some(day), "{kind}: {day}");
        }
        fresh.done().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn round_two_a_downloaded_address_list_older_than_the_bundled_one_is_not_used() {
    let list = "https://openai.com/gptbot.json";
    let title = |stored: runlight::js::Value| async move {
        let rl = install(None).await;
        rl.store().set_setting("agent-ranges", Some(&stored.to_json())).await.unwrap();
        rl.check().await.unwrap();
        // In OpenAI's published list, as it came with this version; the stored one has another address only.
        assert!(
            rl.observe_with(
                &Request::get("https://example.com/post").header("user-agent", GPTBOT),
                None,
                Some("20.171.206.17")
            )
            .await
        );
        let rows = rl.store().db().all("SELECT title FROM rl_events WHERE kind = 'fetch'", vec![]).await.unwrap();
        rows[0].text("title")
    };
    let lists = obj! { list => runlight::js::Value::Array(vec!["203.0.113.0/24".into()]) };
    // Saved before each list's own time was kept, long ago: the bundled list is the newer.
    assert_eq!(title(obj! { "at" => 1_700_000_000_000i64, "lists" => lists.clone() }).await, "verified");
    // Saved since, but this list was last fetched long ago.
    let old = obj! { "at" => NOW, "lists" => lists.clone(), "fetched" => obj! { list => 1_700_000_000_000i64 } };
    assert_eq!(title(old).await, "verified");
    // Fetched after the bundled lists were: the download stands in.
    let new = obj! { "at" => NOW, "lists" => lists.clone(), "fetched" => obj! { list => NOW } };
    assert_eq!(title(new).await, "mismatch");
    assert_eq!(
        title(obj! { "at" => NOW, "lists" => lists }).await,
        "mismatch",
        "at stands for every list without fetched"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn round_two_an_unusual_method_through_the_middleware_is_the_apps() {
    let rl = install(None).await;
    rl.store().add_link_domain("go.example.com", "default", NOW).await.unwrap();
    let app: axum::Router = axum::Router::new()
        .fallback(|| async { "the app" })
        .layer(axum::middleware::from_fn_with_state(rl.clone(), runlight::adapters::axum_support::middleware));
    for method in ["TRACE", "CONNECT", "TRACK"] {
        let request =
            http::Request::builder().method(method).uri("http://go.example.com/docs").body(Body::empty()).unwrap();
        // (A CONNECT's answer carries no body.)
        let answer = body(app.clone().oneshot(request).await.unwrap()).await;
        assert_eq!(answer, (200, if method == "CONNECT" { String::new() } else { "the app".into() }), "{method}");
    }
    // Where there is no app to hand it to, it is refused without a word.
    let routes = rl.routes(RoutesOptions { token: TokenOption::Open, ..RoutesOptions::default() }).unwrap();
    let request = http::Request::builder().method("TRACE").uri("http://example.com/runlight/api").body(Body::empty());
    let answer = routes.oneshot(request.unwrap()).await.unwrap();
    assert_eq!(answer.status().as_u16(), 405);
}

#[tokio::test(flavor = "multi_thread")]
async fn round_two_events_whose_props_the_database_cannot_read_count_as_having_none() {
    for (kind, url) in common::kinds() {
        let fresh = common::fresh(kind, &url).await;
        let mut options = RunlightOptions::new(fresh.store.clone());
        options.site = site();
        let rl = Runlight::new(options).unwrap();
        let routes = rl.routes(RoutesOptions { token: TokenOption::Open, ..RoutesOptions::default() }).unwrap();
        let send = |plan: &str| {
            let hit = obj! { "k" => "event", "u" => "https://example.com/", "s" => "", "n" => "Signup", "p" => obj! { "plan" => plan, "price" => 12.5 } };
            routes.handle(
                Request::new("POST", "https://example.com/runlight/e").header("user-agent", SAFARI).body(hit.to_json()),
            )
        };
        assert_eq!(send("pro").await.status, 202);
        assert_eq!(send("free").await.status, 202);
        // As another version, or another tool, may have written a row: an escaped NUL, and half a surrogate pair.
        for props in [r#"{"plan":"a\u0000b"}"#, r#"{"plan":"\ud83d"}"#, r#"{"plan":"x\\\\\udc00"}"#] {
            rl.store()
                .db()
                .run(
                    "UPDATE rl_events SET props = ? WHERE id = (SELECT id FROM (SELECT MAX(id) AS id FROM rl_events) t)",
                    vec![Param::Text(props.into())],
                )
                .await
                .unwrap();
            let keys = routes
                .handle(Request::get("https://example.com/runlight/api/event-props?period=today&event=Signup"))
                .await;
            assert_eq!(keys.status, 200, "{kind}: {props}: {}", keys.text());
            let values = routes
                .handle(Request::get("https://example.com/runlight/api/event-props?period=today&event=Signup&key=plan"))
                .await;
            assert_eq!(values.status, 200, "{kind}: {props}: {}", values.text());
            // The event with props that read is there; the other is one with no props, where it cannot be read.
            let rows = values.json_body().unwrap();
            let read: Vec<&str> =
                rows.at("rows").as_array().unwrap().iter().filter_map(|r| r.at("value").as_str()).collect();
            assert!(read.contains(&"pro"), "{kind}: {props}: {read:?}");
            if common::base(kind) == "postgres" {
                assert_eq!(read, ["pro"], "{kind}: {props}");
            }
        }
        fresh.done().await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn round_two_a_deleted_link_still_exists_for_an_import() {
    let rl = install(None).await;
    let store = rl.store();
    let id = "b".repeat(24);
    assert!(!store.link_exists(&id).await.unwrap());
    let link = runlight::store::LinkRow {
        id: id.clone(),
        site: "default".into(),
        domain: String::new(),
        slug: "gone".into(),
        name: "Gone".into(),
        url: "https://example.com/".into(),
        created_at: 0,
        updated_at: 0,
    };
    store.insert_link(&link).await.unwrap();
    store.delete_link(&id, NOW).await.unwrap();
    assert!(store.link_by_id(&id).await.unwrap().is_none());
    assert!(store.link_exists(&id).await.unwrap(), "its row stays, hidden");
}

#[tokio::test(flavor = "multi_thread")]
async fn round_two_a_forwarded_address_is_read_without_its_port() {
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    options.trust_proxy = Some(runlight::TrustProxy::On);
    let rl = Runlight::new(options).unwrap();
    for (sent, read) in [
        ("203.0.113.7:51234", "203.0.113.7"),
        ("203.0.113.7", "203.0.113.7"),
        ("[2001:db8::1]:443", "2001:db8::1"),
        ("[2001:db8::1]", "2001:db8::1"),
        ("2001:db8::1", "2001:db8::1"),
        ("[2001:db8::1]:https", "[2001:db8::1]:https"),
        ("[2001:db8::1", "[2001:db8::1"),
        ("203.0.113.7:51234:9", "203.0.113.7:51234:9"),
    ] {
        let request = Request::get("https://example.com/").header("x-forwarded-for", format!("198.51.100.1, {sent}"));
        assert_eq!(rl.client_ip(&request), read, "{sent}");
    }
}

#[test]
fn round_two_a_wrong_code_locks_for_longer_each_time_the_tries_run_out() {
    use runlight::accounts::Lockout;
    const MIN: i64 = 60_000;
    let lock = Lockout::default();
    let mut now = 0;
    // Fifteen minutes, then thirty, an hour, two, four, eight, sixteen, and a day every time after.
    for minutes in [15, 30, 60, 120, 240, 480, 960, 1440, 1440, 1440] {
        for n in 0..5 {
            assert!(lock.take("u1", now), "try {n} of the lock of {minutes} minutes");
        }
        assert!(!lock.take("u1", now), "the fifth try starts the lock");
        assert!(!lock.take("u1", now + minutes * MIN - 1));
        now += minutes * MIN;
    }
    // Another key, such as the account's own browser, counts on its own.
    assert!(lock.take("u1\ndevice", now - 1));
    // Before the fifth try, the count starts again fifteen minutes after the first.
    let fresh = Lockout::default();
    for _ in 0..4 {
        assert!(fresh.take("u2", 0));
    }
    for _ in 0..4 {
        assert!(fresh.take("u2", 15 * MIN));
    }
    assert!(fresh.take("u2", 15 * MIN), "the fifth of this window");
    assert!(!fresh.take("u2", 15 * MIN));
    // A right code clears the key, and a week with no try forgets how long its locks had grown.
    fresh.clear("u2");
    for _ in 0..5 {
        assert!(fresh.take("u2", 16 * MIN));
    }
    assert!(!fresh.take("u2", 16 * MIN + 15 * MIN - 1), "the first lock again, of fifteen minutes");
    let week = 7 * 1440 * MIN;
    for _ in 0..5 {
        assert!(lock.take("u1", now + 1440 * MIN + week));
    }
    assert!(lock.take("u1", now + 1440 * MIN + week + 15 * MIN), "forgotten, so its first lock is fifteen minutes");
}

//! The audit of 2026-10-23, as audit.test.ts tests it, on SQLite in memory: a member's own tokens, signing out
//! everywhere, sign-in forms only from their own pages, a new password taking back tokens, the throttle's
//! eviction, the salt cache after midnight, a retried hit counted once, the funnel cap, and link events' URLs.

#![cfg(feature = "sqlite")]

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use runlight::accounts::Throttle;
use runlight::http::{Request, Response, SearchParams, Url};
use runlight::js::{self, Value};
use runlight::store::{Db, DbError, Dialect, Hold, Param, Row, SqlStore};
use runlight::{BoxFuture, Routes, RoutesOptions, Runlight, RunlightOptions, SiteOptions, TokenOption, obj};

/// 2026-10-06 at noon UTC.
const START: i64 = 1_791_288_000_000;
const SAFARI: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

fn req(method: &str, path: &str) -> Request {
    Request::new(method, format!("https://example.com/runlight{path}"))
}

fn form(path: &str, fields: &[(&str, &str)], headers: &[(&str, &str)]) -> Request {
    let mut request = req("POST", path)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(SearchParams::from_pairs(fields.iter().copied()).to_string());
    for (name, value) in headers {
        request = request.header(name, value);
    }
    request
}

fn cookie_of(response: &Response) -> String {
    response.headers.get_set_cookie().first().map(|c| c.split(';').next().unwrap().to_string()).unwrap_or_default()
}

/// An install with accounts: its owner, and a member who joined by invite.
struct WithMember {
    routes: Routes,
    owner: String,
    member: String,
}

impl WithMember {
    async fn new() -> WithMember {
        let store = runlight_sqlx::connect(":memory:").await.unwrap();
        let mut options = RunlightOptions::new(store);
        options.site = Some(SiteOptions { hostnames: Some(vec!["example.com".into()]), ..SiteOptions::default() });
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
        let owner = cookie_of(&routes.handle(form("/setup", &setup, &[])).await);
        let mut t = WithMember { routes, owner, member: String::new() };
        let invited = t
            .json(
                &t.owner,
                "POST",
                "/api/people",
                Some(obj! { "allSites" => true, "email" => "mo@example.com", "role" => "member" }),
            )
            .await;
        let link = js::str_or_empty(invited.json_body().unwrap().get("link"));
        let code = Url::parse(&link).unwrap().search_params().get("code").unwrap().to_string();
        let joined = [("code", code.as_str()), ("password", "a long password"), ("again", "a long password")];
        t.member = cookie_of(&t.routes.handle(form("/invite", &joined, &[])).await);
        t
    }

    async fn json(&self, cookie: &str, method: &str, path: &str, body: Option<Value>) -> Response {
        let mut request = req(method, path).header("cookie", cookie).header("content-type", "application/json");
        if let Some(body) = body {
            request = request.body(body.to_json());
        }
        self.routes.handle(request).await
    }

    async fn make(&self, cookie: &str, name: &str) -> String {
        let made = self.json(cookie, "POST", "/api/tokens", Some(obj! { "name" => name })).await;
        assert_eq!(made.status, 201);
        js::str_or_empty(made.json_body().unwrap().at("token").get("id"))
    }

    async fn listed(&self, cookie: &str) -> Vec<String> {
        let answer = self.json(cookie, "GET", "/api/tokens", None).await.json_body().unwrap();
        let mut ids: Vec<String> =
            answer.at("tokens").as_array().unwrap().iter().map(|t| js::str_or_empty(t.get("id"))).collect();
        ids.sort();
        ids
    }

    async fn login(&self, headers: &[(&str, &str)]) -> Response {
        let fields = [("email", "mo@example.com"), ("password", "a long password"), ("next", "/runlight/")];
        self.routes.handle(form("/login", &fields, headers)).await
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_10_23_a_member_sees_and_revokes_only_the_tokens_they_made_and_cannot_replace_a_sites_agents_key() {
    let t = WithMember::new().await;
    let owners = t.make(&t.owner, "Owner's").await;
    let mine = t.make(&t.member, "Member's").await;
    let mut both = vec![owners.clone(), mine.clone()];
    both.sort();
    assert_eq!(t.listed(&t.member).await, std::slice::from_ref(&mine));
    assert_eq!(t.listed(&t.owner).await, both, "the owner sees every token");
    let refused = t.json(&t.member, "DELETE", &format!("/api/tokens/{owners}"), None).await;
    assert_eq!(refused.status, 404, "the owner's token is not the member's to revoke");
    assert_eq!(js::str_or_empty(refused.json_body().unwrap().get("code")), "unknown_token");
    assert_eq!(t.listed(&t.owner).await, both);
    assert_eq!(t.json(&t.member, "DELETE", &format!("/api/tokens/{mine}"), None).await.status, 200);
    assert_eq!(t.json(&t.member, "POST", "/api/observe-key/new?site=default", Some(obj! {})).await.status, 403);
    assert_eq!(t.json(&t.owner, "POST", "/api/observe-key/new?site=default", Some(obj! {})).await.status, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_10_23_signing_out_ends_the_accounts_sessions_everywhere_and_only_from_the_dashboards_own_pages() {
    let t = WithMember::new().await;
    let other = cookie_of(&t.login(&[]).await);
    assert_eq!(t.json(&other, "GET", "/api/account", None).await.status, 200);
    let cross_site =
        t.routes.handle(req("GET", "/logout").header("cookie", &t.member).header("sec-fetch-site", "cross-site")).await;
    assert_eq!(cross_site.status, 403, "another site cannot sign anyone out");
    assert_eq!(t.json(&other, "GET", "/api/account", None).await.status, 200);
    let out = t
        .routes
        .handle(req("GET", "/logout").header("cookie", &t.member).header("sec-fetch-site", "same-origin"))
        .await;
    assert_eq!(out.status, 303);
    assert_eq!(
        t.json(&t.member, "GET", "/api/account", None).await.status,
        401,
        "the cookie copied before stops working"
    );
    assert_eq!(
        t.json(&other, "GET", "/api/account", None).await.status,
        401,
        "and so does the one in the other browser"
    );
    let back = cookie_of(&t.login(&[]).await);
    assert_eq!(t.json(&back, "GET", "/api/account", None).await.status, 200, "signing in again works");
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_10_23_the_sign_in_forms_take_a_post_only_from_their_own_pages() {
    let t = WithMember::new().await;
    for site in ["cross-site", "same-site"] {
        let refused = t.login(&[("sec-fetch-site", site)]).await;
        assert_eq!(refused.status, 403, "{site}");
        assert!(refused.headers.get_set_cookie().is_empty(), "{site}: no session is planted");
    }
    assert_eq!(t.login(&[("sec-fetch-site", "same-origin")]).await.status, 303);
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_10_23_a_new_password_can_take_back_the_tokens_the_account_made() {
    let t = WithMember::new().await;
    t.make(&t.member, "Kept").await;
    let changed = t
        .json(
            &t.member,
            "POST",
            "/api/account/password",
            Some(obj! { "current" => "a long password", "next" => "another long password" }),
        )
        .await;
    let fresh = cookie_of(&changed);
    assert_eq!(t.listed(&fresh).await.len(), 1, "kept unless asked");
    let latest = cookie_of(
        &t.json(
            &fresh,
            "POST",
            "/api/account/password",
            Some(obj! { "current" => "another long password", "next" => "a third long password", "revokeTokens" => true }),
        )
        .await,
    );
    assert_eq!(t.listed(&latest).await.len(), 0);
}

#[test]
fn audit_2026_10_23_a_flood_of_made_up_names_cannot_reset_the_count_of_one_close_to_its_limit() {
    let throttle = Throttle::new(3, 15 * 60_000);
    let now = START;
    assert!(throttle.take("target", now));
    assert!(throttle.take("target", now));
    for i in 0..10_050 {
        throttle.take(&format!("made-up-{i}"), now);
    }
    assert!(throttle.take("target", now));
    assert!(!throttle.take("target", now), "the target's earlier tries still count");
}

/// A database that answers busy to the next few event inserts, as a SQLite file another process is writing does.
struct Busy {
    inner: Arc<dyn Db>,
    fail: Arc<AtomicUsize>,
}

impl Db for Busy {
    fn dialect(&self) -> Dialect {
        self.inner.dialect()
    }

    fn all<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<Vec<Row>, DbError>> {
        self.inner.all(sql, params)
    }

    fn run<'a>(&'a self, sql: &'a str, params: Vec<Param>) -> BoxFuture<'a, Result<u64, DbError>> {
        if sql.starts_with("INSERT INTO rl_events")
            && self.fail.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok()
        {
            return Box::pin(async { Err(DbError("SQLITE_BUSY: database is locked".into())) });
        }
        self.inner.run(sql, params)
    }

    fn hold(&self, kind: Hold) -> BoxFuture<'_, Result<Arc<dyn Db>, DbError>> {
        self.inner.hold(kind)
    }
}

struct T {
    rl: Runlight,
    routes: Routes,
    clock: Arc<AtomicI64>,
}

impl T {
    async fn new(store: SqlStore) -> T {
        let clock = Arc::new(AtomicI64::new(START));
        let mut options = RunlightOptions::new(store);
        let now = clock.clone();
        options.now = Some(Arc::new(move || now.load(Ordering::SeqCst)));
        options.site = Some(SiteOptions { hostnames: Some(vec!["example.com".into()]), ..SiteOptions::default() });
        let rl = Runlight::new(options).unwrap();
        let routes = rl
            .routes(RoutesOptions { token: TokenOption::Given("secret".into()), ..RoutesOptions::default() })
            .unwrap();
        T { rl, routes, clock }
    }

    async fn sqlite() -> T {
        T::new(runlight_sqlx::connect(":memory:").await.unwrap()).await
    }

    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    async fn send(&self, body: Value, ip: &str) {
        let request = Request::new("POST", "https://example.com/runlight/e")
            .header("user-agent", SAFARI)
            .header("x-forwarded-for", ip)
            .body(body.to_json());
        self.routes.handle(request).await;
    }

    async fn api(&self, method: &str, path: &str, body: Option<Value>) -> Value {
        let mut request = req(method, path).header("authorization", "Bearer secret");
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(body.to_json());
        }
        let response = self.routes.handle(request).await;
        assert!(response.status < 300, "{path}: {}", response.status);
        response.json_body().unwrap()
    }

    async fn rows(&self, sql: &str) -> Vec<Row> {
        self.rl.store().db().all(sql, vec![]).await.unwrap()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_10_23_yesterdays_salt_leaves_memory_when_it_leaves_the_store_on_the_first_hit_after_midnight() {
    let t = T::sqlite().await;
    t.send(obj! { "k" => "pageview", "u" => "https://example.com/" }, "203.0.113.1").await;
    t.advance(13 * 3_600_000);
    t.send(obj! { "k" => "pageview", "u" => "https://example.com/" }, "203.0.113.9").await;
    let (day, yesterday) = t.rl.cached_salts("UTC").unwrap();
    assert_eq!(day, "2026-10-07");
    assert_eq!(yesterday, None, "no visit was left open, so yesterday's salt is gone from here too");
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_10_23_a_hit_tried_again_after_the_store_was_busy_counts_once() {
    let inner = runlight_sqlx::connect(":memory:").await.unwrap().db().clone();
    let fail = Arc::new(AtomicUsize::new(2));
    let t = T::new(SqlStore::new(Arc::new(Busy { inner, fail: fail.clone() }))).await;
    t.send(obj! { "k" => "pageview", "u" => "https://example.com/", "i" => "p1" }, "203.0.113.1").await;
    fail.store(1, Ordering::SeqCst);
    t.send(obj! { "k" => "engagement", "u" => "https://example.com/", "i" => "p1", "e" => 5000 }, "203.0.113.1").await;
    let visits = t.rows("SELECT pageviews, engaged_ms FROM rl_sessions").await;
    assert_eq!(visits.len(), 1);
    assert_eq!(visits[0].num("pageviews"), 1.0);
    assert_eq!(visits[0].num("engaged_ms"), 5000.0);
    assert_eq!(t.rows("SELECT id FROM rl_events WHERE kind = 'pageview'").await.len(), 1);
    assert_eq!(t.rows("SELECT id FROM rl_events WHERE kind = 'engagement'").await.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_10_23_a_funnel_over_more_visits_than_the_cap_counts_the_newest_and_says_so() {
    let t = T::sqlite().await;
    t.rl.store().set_funnel_visits(2);
    for ip in ["203.0.113.1", "203.0.113.2", "203.0.113.3"] {
        t.send(obj! { "k" => "pageview", "u" => "https://example.com/pricing" }, ip).await;
        t.advance(60_000);
    }
    let steps = Value::Array(vec![
        obj! { "kind" => "page", "match" => "/pricing" },
        obj! { "kind" => "page", "match" => "/thanks" },
    ]);
    t.api("POST", "/api/funnels?site=default", Some(obj! { "name" => "F", "steps" => steps })).await;
    let answer = t.api("GET", "/api/funnels?period=today", None).await;
    let funnel = &answer.at("funnels").as_array().unwrap()[0];
    assert_eq!(funnel.get("sampled"), Some(&Value::from(2)));
    assert_eq!(funnel.at("steps").as_array().unwrap()[0].get("visits"), Some(&Value::from(2)));
    t.rl.store().set_funnel_visits(10);
    let answer = t.api("GET", "/api/funnels?period=today", None).await;
    assert_eq!(answer.at("funnels").as_array().unwrap()[0].get("sampled"), None);
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_10_23_an_automatic_link_event_keeps_its_link_without_the_query_string_or_fragment() {
    let t = T::sqlite().await;
    let event = |name: &str, url: &str| obj! { "k" => "event", "u" => "https://example.com/", "n" => name, "p" => obj! { "url" => url } };
    t.send(event("Outbound link", "https://other.example/reset?token=abc&email=a@b.example#top"), "203.0.113.1").await;
    t.send(event("File download", "https://example.com/a.pdf?sig=x"), "203.0.113.1").await;
    t.send(event("Signup", "https://example.com/?plan=pro"), "203.0.113.1").await;
    let rows = t.rows("SELECT name, props FROM rl_events ORDER BY name").await;
    let got: Vec<(String, String)> = rows
        .iter()
        .map(|r| (r.text("name"), js::str_or_empty(js::parse(&r.text("props")).unwrap().get("url"))))
        .collect();
    assert_eq!(
        got,
        [
            ("File download".to_string(), "https://example.com/a.pdf".to_string()),
            ("Outbound link".to_string(), "https://other.example/reset".to_string()),
            ("Signup".to_string(), "https://example.com/?plan=pro".to_string()),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn audit_2026_10_23_a_prop_named_proto_is_kept() {
    let t = T::sqlite().await;
    let props = js::parse(r#"{"__proto__":"x","plain":"y"}"#).unwrap();
    t.send(obj! { "k" => "event", "u" => "https://example.com/", "n" => "Odd", "p" => props.clone() }, "203.0.113.1")
        .await;
    let rows = t.rows("SELECT props FROM rl_events WHERE name = 'Odd'").await;
    assert_eq!(js::parse(&rows[0].text("props")).unwrap(), props);
}

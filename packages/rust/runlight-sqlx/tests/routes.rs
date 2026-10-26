//! Routes as routes.test.ts tests them: the element picker's relay page, and paths whose escapes do not decode.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use runlight::http::{Request, Response};
use runlight::js::Value;
use runlight::{Routes, RoutesOptions, Runlight, RunlightOptions, SiteOptions, TokenOption};

const APP: &str = "http://localhost:4000";

async fn runlight() -> Runlight {
    runlight_at(None).await
}

async fn runlight_at(now: Option<Arc<AtomicI64>>) -> Runlight {
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    if let Some(clock) = now {
        options.now = Some(Arc::new(move || clock.load(Ordering::SeqCst)));
    }
    options.sites = Some(vec![SiteOptions {
        id: Some("blog".into()),
        hostnames: Some(vec!["blog.example.com".into()]),
        ..SiteOptions::default()
    }]);
    Runlight::new(options).unwrap()
}

fn routes(rl: &Runlight) -> Routes {
    rl.routes(RoutesOptions { token: TokenOption::Given("secret".into()), ..RoutesOptions::default() }).unwrap()
}

fn call(method: &str, path: &str, body: &str, bearer: &str) -> Request {
    let request = Request::new(method, format!("{APP}{path}"))
        .header("authorization", format!("Bearer {bearer}"))
        .header("content-type", "application/json");
    if body.is_empty() { request } else { request.body(body.to_string()) }
}

fn code(response: &Response) -> String {
    response.json_body().unwrap().get("code").and_then(Value::as_str).unwrap_or_default().to_string()
}

fn hex(text: &str) -> String {
    text.bytes().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn the_picker_sends_its_choice_to_the_relay_page_its_ticket_names_never_through_the_tab_that_opened_it() {
    let now = Arc::new(AtomicI64::new(1_791_374_400_000));
    let rl = runlight_at(Some(now.clone())).await;
    let routes = routes(&rl);
    let ask = |body: String, bearer: &str| call("POST", "/runlight/api/pick?site=blog", &body, bearer);
    let script = async |ticket: &str| {
        let path = format!("/runlight/pick.js?runlight=pick&runlight_ticket={ticket}");
        String::from_utf8(routes.handle(Request::get(format!("{APP}{path}"))).await.body).unwrap()
    };
    let nonce = "0123456789abcdef0123456789abcdef";
    let back = "https://stats.example.com/runlight/pick-return";
    let origin = "https://stats.example.com";

    let asked =
        routes.handle(ask(format!(r#"{{"origin":"{origin}","return":"{back}","nonce":"{nonce}"}}"#), "secret")).await;
    assert_eq!(asked.status, 200);
    let ticket = asked.json_body().unwrap().get("ticket").and_then(Value::as_str).unwrap().to_string();
    assert_eq!(ticket.split('.').count(), 6, "the return address and nonce are signed into the ticket");
    let picker = script(&ticket).await;
    assert!(picker.contains(&format!("\"{back}\"")) && picker.contains(&format!("\"{nonce}\"")));
    assert!(!picker.contains("__RUNLIGHT_PICK_RETURN__") && !picker.contains("__RUNLIGHT_PICK_NONCE__"));

    // Neither can be changed: a ticket with another return address or nonce is no ticket, and the picker sends nowhere.
    let parts: Vec<&str> = ticket.split('.').collect();
    let other = hex("https://stats.example.com/elsewhere/pick-return");
    let fs = "f".repeat(32);
    for changed in [
        [parts[0], parts[1], parts[2], &other, parts[4], parts[5]],
        [parts[0], parts[1], parts[2], parts[3], &fs, parts[5]],
    ] {
        let sent = script(&changed.join(".")).await;
        assert!(!sent.contains("stats.example.com") && !sent.contains(nonce));
    }

    // The return address is the relay page on the dashboard's own origin, and the nonce is 32 hex digits.
    for (address, given) in [
        (Some("https://evil.example/pick-return"), Some(nonce)),
        (Some("https://stats.example.com.evil.example/pick-return"), Some(nonce)),
        (Some("https://stats.example.com/runlight/"), Some(nonce)),
        (Some("https://stats.example.com/pick-return?x=1"), Some(nonce)),
        (Some("https://stats.example.com/pick-return#x"), Some(nonce)),
        (Some(back), None),
        (Some(back), Some("short")),
        (None, Some(nonce)),
    ] {
        let mut body = format!(r#"{{"origin":"{origin}""#);
        if let Some(a) = address {
            body.push_str(&format!(r#","return":"{a}""#));
        }
        if let Some(n) = given {
            body.push_str(&format!(r#","nonce":"{n}""#));
        }
        body.push('}');
        let refused = routes.handle(ask(body.clone(), "secret")).await;
        assert_eq!(refused.status, 400, "{body}");
        assert_eq!(code(&refused), "pick_return", "{body}");
    }
    let root = format!(r#"{{"origin":"{origin}","return":"https://stats.example.com/pick-return","nonce":"{nonce}"}}"#);
    assert_eq!(routes.handle(ask(root, "secret")).await.status, 200, "a dashboard at the root");

    // A hub's ticket names a relay page on the hub it connected from, and no other origin.
    let made = routes
        .handle(call("POST", "/runlight/api/tokens", r#"{"name":"Hub","scope":"manage","site":"blog"}"#, "secret"))
        .await
        .json_body()
        .unwrap();
    let secret = made.get("secret").and_then(Value::as_str).unwrap().to_string();
    let id = made.get("token").and_then(|t| t.get("id")).and_then(Value::as_str).unwrap().to_string();
    rl.store().set_setting(&format!("token-origin:{id}"), Some("https://hub.example.net")).await.unwrap();
    let hub = format!(
        r#"{{"origin":"https://hub.example.net","return":"https://hub.example.net/pick-return","nonce":"{nonce}"}}"#
    );
    assert_eq!(routes.handle(ask(hub, &secret)).await.status, 200);
    let evil = format!(
        r#"{{"origin":"https://hub.example.net","return":"https://evil.example/pick-return","nonce":"{nonce}"}}"#
    );
    assert_eq!(routes.handle(ask(evil, &secret)).await.status, 400);

    now.fetch_add(31 * 60_000, Ordering::SeqCst);
    assert!(!script(&ticket).await.contains(nonce), "a ticket runs out after half an hour");
}

#[tokio::test]
async fn the_relay_page_is_static_runs_only_its_own_script_and_keeps_its_address_to_itself() {
    let rl = runlight().await;
    let routes = routes(&rl);
    let asked = Request::get(format!("{APP}/runlight/pick-return")).header("accept-language", "de-DE,de;q=0.9");
    let page = routes.handle(asked).await;
    assert_eq!(page.status, 200);
    assert!(page.headers.get("content-type").unwrap_or_default().contains("text/html"));
    assert_eq!(page.headers.get("cache-control").as_deref(), Some("no-store"));
    assert_eq!(page.headers.get("referrer-policy").as_deref(), Some("no-referrer"));
    let csp = page.headers.get("content-security-policy").unwrap_or_default();
    assert!(csp.contains("script-src 'self'") && csp.contains("frame-ancestors 'none'"));
    assert!(!csp.split(';').any(|d| d.contains("script-src") && d.contains("unsafe")), "no inline script");
    let html = String::from_utf8(page.body).unwrap();
    assert!(html.contains(r#"lang="de""#));
    assert!(html.contains(r#"<script src="/runlight/pick-return.js"></script>"#));
    assert!(!html.contains("<script>"), "no inline script");
    let script = routes.handle(Request::get(format!("{APP}/runlight/pick-return.js"))).await;
    assert!(script.headers.get("content-type").unwrap_or_default().contains("javascript"));
    assert!(String::from_utf8(script.body).unwrap().contains("BroadcastChannel"));
    assert_eq!(routes.handle(Request::new("POST", format!("{APP}/runlight/pick-return"))).await.status, 404);
    // Signed out, it answers the same: it holds nothing.
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    options.secret = Some("a".repeat(32));
    let open = Runlight::new(options)
        .unwrap()
        .routes(RoutesOptions {
            token: TokenOption::Given("secret".into()),
            accounts: true,
            ..RoutesOptions::default()
        })
        .unwrap();
    assert_eq!(open.handle(Request::get(format!("{APP}/runlight/pick-return"))).await.status, 200);
}

#[tokio::test]
async fn broken_percent_escapes_in_a_path_answer_as_a_name_nobody_has_never_an_error() {
    let rl = runlight().await;
    let routes = routes(&rl);
    let cases = [
        ("PATCH", "/runlight/api/goals/%E0?site=blog", "unknown_goal", r#"{"name":"X","kind":"event","match":"X"}"#),
        ("DELETE", "/runlight/api/goals/%zz?site=blog", "unknown_goal", ""),
        ("PATCH", "/runlight/api/shares/%E0%A4?site=blog", "unknown_share", r#"{"name":"X"}"#),
        ("DELETE", "/runlight/api/shares/%?site=blog", "unknown_share", ""),
        ("PATCH", "/runlight/api/sites/%E0", "unknown_site", r#"{"name":"X"}"#),
        ("DELETE", "/runlight/api/sites/%zz", "unknown_site", ""),
        ("GET", "/runlight/api/link-domains/%E0/check?site=blog", "unknown_domain", ""),
        ("DELETE", "/runlight/api/link-domains/%zz?site=blog", "unknown_domain", ""),
    ];
    for (method, path, expected, body) in cases {
        let answer = routes.handle(call(method, path, body, "secret")).await;
        assert_eq!(answer.status, 404, "{method} {path}");
        assert_eq!(code(&answer), expected, "{method} {path}");
    }
    // A hub's manage token, checked against its one site before anything else.
    let made = routes
        .handle(call("POST", "/runlight/api/tokens", r#"{"name":"Hub","scope":"manage","site":"blog"}"#, "secret"))
        .await;
    let secret = made.json_body().unwrap().get("secret").and_then(Value::as_str).unwrap().to_string();
    let hub = routes.handle(call("PATCH", "/runlight/api/sites/%E0", r#"{"name":"X"}"#, &secret)).await;
    assert_eq!(hub.status, 404);
    // Public pages and short links: the share page, unsubscribing, the app's link path, and a link domain.
    for path in ["/runlight/share/%E0", "/runlight/unsubscribe/%E0", "/runlight/assets/app.%E0.js"] {
        assert_eq!(routes.handle(Request::get(format!("{APP}{path}"))).await.status, 404, "{path}");
    }
    for path in ["/go/%E0", "/go/%zz"] {
        assert_eq!(rl.link_response(&Request::get(format!("{APP}{path}"))).await.unwrap().status, 404, "{path}");
    }
    rl.store().add_link_domain("go.example.net", "blog", rl.now()).await.unwrap();
    rl.forget_link_domains();
    let linked = rl.link_domain_response(&Request::get("https://go.example.net/%E0")).await.unwrap();
    assert_eq!(linked.map(|r| r.status), Some(404));
}

#[tokio::test]
async fn inside_a_cms_the_dashboard_names_it_and_its_own_admin_may_frame_the_whole_dashboard_otherwise_nothing_may() {
    let rl = runlight().await;
    let page = async |cms: Option<&str>| {
        let routes = rl
            .routes(RoutesOptions { token: TokenOption::Open, cms: cms.map(String::from), ..RoutesOptions::default() })
            .unwrap();
        routes.handle(Request::get(format!("{APP}/runlight/"))).await
    };
    let inside = page(Some("WordPress")).await;
    assert!(String::from_utf8(inside.body.clone()).unwrap().contains("data-cms=\"WordPress\""));
    assert!(inside.headers.get("content-security-policy").unwrap_or_default().contains("frame-ancestors 'self'"));
    assert_eq!(inside.headers.get("x-frame-options").as_deref(), Some("SAMEORIGIN"));
    let alone = page(None).await;
    assert!(!String::from_utf8(alone.body.clone()).unwrap().contains("data-cms"));
    assert!(alone.headers.get("content-security-policy").unwrap_or_default().contains("frame-ancestors 'none'"));
    assert_eq!(alone.headers.get("x-frame-options").as_deref(), Some("DENY"));
}

#[tokio::test]
async fn an_apps_csrf_token_is_printed_in_the_dashboard_and_the_consent_form_asked_for_each_time_and_only_when_given() {
    let made = Arc::new(AtomicI64::new(0));
    let pages = async |csrf: Option<runlight::routes::Csrf>| {
        let rl = runlight().await;
        let routes = rl.routes(RoutesOptions { token: TokenOption::Open, csrf, ..RoutesOptions::default() }).unwrap();
        let text = |response: Response| String::from_utf8(response.body).unwrap();
        let dashboard = text(routes.handle(Request::get(format!("{APP}/runlight/"))).await);
        let registered = routes
            .handle(call(
                "POST",
                "/runlight/oauth/register",
                r#"{"client_name":"App","redirect_uris":["https://app.example/cb"]}"#,
                "",
            ))
            .await;
        let client_id = registered.json_body().unwrap().get("client_id").and_then(Value::as_str).unwrap().to_string();
        let params = runlight::http::SearchParams::from_pairs([
            ("response_type", "code"),
            ("client_id", client_id.as_str()),
            ("redirect_uri", "https://app.example/cb"),
            ("code_challenge", "a".repeat(43).as_str()),
            ("code_challenge_method", "S256"),
        ])
        .to_string();
        let consent = text(routes.handle(Request::get(format!("{APP}/runlight/oauth/authorize?{params}"))).await);
        (dashboard, consent)
    };
    let (dashboard, consent) =
        pages(Some(Arc::new(move || format!("tok-{}", made.fetch_add(1, Ordering::SeqCst) + 1)))).await;
    assert!(dashboard.contains("data-csrf=\"tok-1\""), "{dashboard}");
    assert!(consent.contains("<input type=\"hidden\" name=\"csrf\" value=\"tok-2\">"), "{consent}");
    let (dashboard, consent) = pages(None).await;
    assert!(!dashboard.contains("data-csrf"));
    assert!(!consent.contains("name=\"csrf\""));
}

#[tokio::test]
async fn a_site_change_refused_for_a_bad_domain_changes_nothing_retention_and_timezone_included() {
    let now = Arc::new(AtomicI64::new(1_759_276_800_000));
    let clock = now.clone();
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    options.managed_sites = true;
    options.now = Some(Arc::new(move || clock.load(Ordering::SeqCst)));
    let rl = Runlight::new(options).unwrap();
    let routes = routes(&rl);
    let sent = async |method: &str, path: &str, body: &str| routes.handle(call(method, path, body, "secret")).await;
    for host in ["blog.example.com", "shop.example.com"] {
        assert_eq!(sent("POST", "/runlight/api/sites", &format!(r#"{{"hostnames":"{host}"}}"#)).await.status, 201);
    }
    let pageview = Request::new("POST", format!("{APP}/runlight/e"))
        .header("user-agent", "Mozilla/5.0 (Macintosh) Chrome/129.0.0.0 Safari/537.36")
        .header("x-forwarded-for", "203.0.113.1")
        .body(r#"{"k":"pageview","u":"https://blog.example.com/"}"#);
    routes.handle(pageview).await;
    now.store(1_791_288_000_000, Ordering::SeqCst);
    let zone = rl.store().setting("rollup-zone:blog.example.com").await.unwrap();
    let visits = async || {
        let stats = sent("GET", "/runlight/api/stats?site=blog.example.com&period=all", "").await;
        stats.json_body().unwrap().get("stats").and_then(|s| s.get("visits")).and_then(Value::as_f64).unwrap()
    };
    assert_eq!(visits().await, 1.0);
    for hostnames in ["not a domain", "shop.example.com"] {
        let body =
            format!(r#"{{"retentionMonths":6,"timezone":"Europe/Paris","name":"Renamed","hostnames":"{hostnames}"}}"#);
        assert_eq!(sent("PATCH", "/runlight/api/sites/blog.example.com", &body).await.status, 400, "{hostnames}");
        rl.idle().await;
        assert_eq!(rl.retention("blog.example.com").await.unwrap(), None, "retention is unchanged");
        assert_eq!(rl.store().setting("rollup-zone:blog.example.com").await.unwrap(), zone, "the built days are kept");
        let site = rl.site(Some("blog.example.com")).unwrap();
        assert_eq!((site.name.as_str(), site.timezone.as_str()), ("blog.example.com", "UTC"));
        assert_eq!(visits().await, 1.0, "the old visit is still there");
    }
    let passes = sent(
        "PATCH",
        "/runlight/api/sites/blog.example.com",
        r#"{"retentionMonths":6,"hostnames":"blog.example.com"}"#,
    );
    assert_eq!(passes.await.status, 200);
    rl.idle().await;
    assert_eq!(visits().await, 0.0, "a change that passes prunes once saved");
}

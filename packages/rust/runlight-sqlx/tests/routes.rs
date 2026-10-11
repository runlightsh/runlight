//! Routes as routes.test.ts tests them: paths whose escapes do not decode.

use runlight::http::{Request, Response};
use runlight::js::Value;
use runlight::{Routes, RoutesOptions, Runlight, RunlightOptions, SiteOptions, TokenOption};

const APP: &str = "http://localhost:4000";

async fn runlight() -> Runlight {
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
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

//! Replays packages/php/tests/fixtures/routes.json, which scripts/php-fixtures-routes.mts writes from the
//! TypeScript SDK: the dashboard's page, the tracker, refusals with their codes, and OAuth's documents,
//! each answer byte for byte with every header, and the helpers routes.ts and oauth.ts export.

mod common;

use std::sync::Arc;

use runlight::http::{Headers, Request, Response};
use runlight::js::{self, Object, Value};
use runlight::routes::{coded_with, host_name, manage_path};
use runlight::{RoutesOptions, Runlight, RunlightOptions, SiteOptions, TokenOption};

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

fn site(v: &Value) -> SiteOptions {
    SiteOptions {
        id: v.get("id").and_then(Value::as_str).map(str::to_string),
        name: v.get("name").and_then(Value::as_str).map(str::to_string),
        hostnames: v.get("hostnames").and_then(Value::as_array).map(|h| h.iter().map(js::js_string).collect()),
        timezone: v.get("timezone").and_then(Value::as_str).map(str::to_string),
    }
}

/// A value with object keys sorted, so two compare whatever order their keys came in.
fn sorted(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            let mut keys: Vec<&str> = o.keys().collect();
            keys.sort_unstable();
            let mut out = Object::new();
            for k in keys {
                out.set(k, sorted(o.get(k).unwrap()));
            }
            Value::Object(out)
        }
        Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

/// A response's headers as the fixture holds them: set-cookie a list when `cookie_list`, the rest joined.
fn headers(response: &Response, cookie_list: bool) -> Value {
    let mut out = Object::new();
    for (name, values) in response.headers.all() {
        if cookie_list && name == "set-cookie" {
            out.set(name, Value::Array(values.iter().map(|v| Value::from(v.as_str())).collect()));
        } else {
            out.set(name, values.join(", "));
        }
    }
    sorted(&Value::Object(out))
}

#[tokio::test]
async fn every_exchange_answers_as_the_typescript_does() {
    let fixture = common::fixture("routes");
    let now = fixture.at("now").as_f64().unwrap() as i64;
    let mut failures = Vec::new();
    for exchange in list(&fixture, "exchanges") {
        let given = exchange.at("runlight");
        let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
        options.now = Some(Arc::new(move || now));
        if let Some(Value::Array(sites)) = given.get("sites") {
            options.sites = Some(sites.iter().map(site).collect());
        }
        if let Some(one) = given.get("site").filter(|v| v.is_object()) {
            options.site = Some(site(one));
        }
        let rl = Runlight::new(options).unwrap();
        let r = exchange.at("routes");
        let routes = rl
            .routes(RoutesOptions {
                token: match r.get("token") {
                    Some(Value::String(t)) => TokenOption::Given(t.clone()),
                    Some(Value::Null) => TokenOption::Open,
                    _ => TokenOption::FromEnv,
                },
                base_path: r.get("basePath").and_then(Value::as_str).map(str::to_string),
                sign_out: r.get("signOut").and_then(Value::as_str).map(str::to_string),
                sign_in: r.get("signIn").and_then(Value::as_str).map(str::to_string),
                geo_credit: js::opt_truthy(r.get("geoCredit")),
                ..RoutesOptions::default()
            })
            .unwrap();
        for answer in list(exchange, "answers") {
            let ask = answer.at("ask");
            let method = ask.get("method").and_then(Value::as_str).unwrap_or("GET").to_string();
            let label = format!("{}: {method} {}", s(exchange, "name"), s(ask, "path"));
            let mut sent = Headers::new();
            if let Some(Value::Object(h)) = ask.get("headers") {
                for (k, v) in h.iter() {
                    sent.set(&k.to_lowercase(), &js::js_string(v));
                }
            }
            let body = ask.get("body").and_then(Value::as_str);
            if body.is_some() && !sent.has("content-type") {
                sent.set("content-type", "text/plain;charset=UTF-8");
            }
            let mut request = Request::new(&method, format!("https://example.com{}", s(ask, "path")));
            request.headers = sent;
            if let Some(b) = body {
                request.body = b.as_bytes().to_vec();
            }
            let response = routes.handle(request).await;
            let status = answer.at("status").as_f64().unwrap() as u16;
            if response.status != status {
                failures.push(format!("{label}: status {} not {status}", response.status));
                continue;
            }
            let want = sorted(answer.at("headers"));
            let got = headers(&response, true);
            if got != want {
                failures.push(format!("{label}: headers\n  expected {}\n  actual   {}", want.to_json(), got.to_json()));
            }
            let text = runlight::http::utf8(&response.body);
            if let Some(Value::String(sum)) = answer.get("sha256") {
                if runlight::hash::sha256(&text) != *sum {
                    failures.push(format!("{label}: body"));
                }
            } else if text != s(answer, "text") {
                failures.push(format!("{label}: body\n  expected {}\n  actual   {text}", s(answer, "text")));
            }
        }
    }
    assert!(failures.is_empty(), "{} failures:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn coded_errors_are_the_same_bytes() {
    for case in list(&common::fixture("routes"), "coded") {
        let args = list(case, "args");
        let code = js::js_string(&args[1]);
        let params: Option<Vec<(String, String)>> =
            args[3].as_object().map(|o| o.iter().map(|(k, v)| (k.to_string(), js::js_string(v))).collect());
        let extra: Vec<(String, String)> =
            args[4].as_object().map(|o| o.iter().map(|(k, v)| (k.to_string(), js::js_string(v))).collect()).unwrap();
        let params_ref: Option<Vec<(&str, &str)>> =
            params.as_ref().map(|p| p.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect());
        let extra_ref: Vec<(&str, &str)> = extra.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let response = coded_with(
            &js::js_string(&args[0]),
            &code,
            args[2].as_f64().unwrap() as u16,
            params_ref.as_deref(),
            &extra_ref,
        );
        assert_eq!(f64::from(response.status), case.at("status").as_f64().unwrap(), "{code}");
        assert_eq!(runlight::http::utf8(&response.body), s(case, "text"), "{code}");
        assert_eq!(headers(&response, false), sorted(case.at("headers")), "{code}");
    }
}

#[test]
fn host_names_are_bare_as_the_typescript_makes_them() {
    for case in list(&common::fixture("routes"), "hostName") {
        let pair = case.as_array().unwrap();
        assert_eq!(host_name(&js::js_string(&pair[0])), js::js_string(&pair[1]), "{}", js::js_string(&pair[0]));
    }
}

#[test]
fn manage_paths_are_the_same() {
    for case in list(&common::fixture("routes"), "managePath") {
        let c = case.as_array().unwrap();
        let (method, path) = (js::js_string(&c[0]), js::js_string(&c[1]));
        assert_eq!(Value::from(manage_path(&method, &path)), c[2], "{method} {path}");
    }
}

#[test]
fn pkce_s256_matches_the_typescript() {
    for case in list(&common::fixture("routes"), "s256") {
        let c = case.as_array().unwrap();
        assert_eq!(runlight::oauth::s256(&js::js_string(&c[0])), js::js_string(&c[1]));
    }
}

#[test]
fn resource_metadata_urls_are_the_same() {
    for case in list(&common::fixture("routes"), "resourceMetadataUrl") {
        let c = case.as_array().unwrap();
        assert_eq!(
            runlight::oauth::resource_metadata_url(&js::js_string(&c[0]), &js::js_string(&c[1])),
            js::js_string(&c[2])
        );
    }
}

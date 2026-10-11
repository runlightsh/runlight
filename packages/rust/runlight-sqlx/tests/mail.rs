//! The app's own mailer, as mail.test.ts tests it: it sends the test email and the reports until a service
//! saved in the dashboard takes its place, and removing that service goes back to it.

#![cfg(feature = "sqlite")]

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use runlight::http::{FetchError, FetchInit, Fetcher, Request, Response};
use runlight::js::Value;
use runlight::mail::Message;
use runlight::{AppMailer, BoxFuture, Routes, RoutesOptions, Runlight, RunlightOptions, SiteOptions, TokenOption, obj};

const NOW: i64 = 1_791_201_600_000;

/// A mail service's API that counts what it is asked to send.
#[derive(Default)]
struct Capture {
    calls: Mutex<Vec<String>>,
}

impl Fetcher for Capture {
    fn fetch<'a>(&'a self, url: &'a str, _init: FetchInit) -> BoxFuture<'a, Result<Response, FetchError>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(url.to_string());
            Ok(Response::new(r#"{"id":"x"}"#, 200, Default::default()))
        })
    }
}

fn call(method: &str, path: &str, body: Option<Value>) -> Request {
    let request = Request::new(method, format!("https://stats.example.com/runlight{path}"))
        .header("authorization", "Bearer t")
        .header("content-type", "application/json");
    match body {
        Some(b) => request.body(b.to_json()),
        None => request,
    }
}

async fn answer(routes: &Routes, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
    let response = routes.handle(call(method, path, body)).await;
    (response.status, response.json_body().unwrap_or(Value::Null))
}

fn routes(rl: &Runlight) -> Routes {
    rl.routes(RoutesOptions { token: TokenOption::Given("t".into()), ..RoutesOptions::default() }).unwrap()
}

#[tokio::test]
async fn the_apps_own_mailer_sends_until_a_service_saved_in_the_dashboard_takes_its_place() {
    let now = Arc::new(AtomicI64::new(NOW));
    let sent: Arc<Mutex<Vec<Message>>> = Arc::default();
    let fail: Arc<Mutex<String>> = Arc::default();
    let capture = Arc::new(Capture::default());
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    options.site = Some(SiteOptions {
        name: Some("Example".into()),
        hostnames: Some(vec!["example.com".into()]),
        ..SiteOptions::default()
    });
    let clock = now.clone();
    options.now = Some(Arc::new(move || clock.load(Ordering::SeqCst)));
    options.fetcher = Some(capture.clone());
    let (into, failing) = (sent.clone(), fail.clone());
    options.app_mailer = Some(AppMailer {
        from: "site@example.com".into(),
        from_name: Some("Example".into()),
        via: "WordPress (WP Mail SMTP)".into(),
        send: Arc::new(move |m| {
            let (into, failing) = (into.clone(), failing.clone());
            Box::pin(async move {
                let fail = failing.lock().unwrap().clone();
                if !fail.is_empty() {
                    return Err(fail.into());
                }
                into.lock().unwrap().push(m);
                Ok(())
            })
        }),
    });
    let rl = Runlight::new(options).unwrap();
    let routes = routes(&rl);
    let app = obj! {
        "via" => "WordPress (WP Mail SMTP)", "from" => "site@example.com", "fromName" => "Example", "replaced" => false,
    };

    let (_, view) = answer(&routes, "GET", "/api/mail", None).await;
    let keys: Vec<&str> = view.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["source", "service", "from", "fromName", "fields", "saved", "encrypted", "services", "app"]);
    assert_eq!(
        ["source", "service", "from", "fromName", "fields", "saved", "app"].map(|k| view.at(k).clone()),
        [
            Value::from("app"),
            Value::from(""),
            Value::from("site@example.com"),
            Value::from("Example"),
            obj! {},
            Value::Array(vec![]),
            app.clone(),
        ]
    );

    let test = || Some(obj! { "to" => "jon@example.com" });
    assert_eq!(answer(&routes, "POST", "/api/mail/test", test()).await.0, 200);
    {
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            (sent[0].to.as_str(), sent[0].from.as_str(), sent[0].from_name.as_deref()),
            ("jon@example.com", "site@example.com", Some("Example"))
        );
        assert!(sent[0].text.contains("WordPress (WP Mail SMTP)"), "the test names the app's mailer");
    }

    // Reports go through it too, with the unsubscribe headers.
    let report = Some(obj! { "email" => "jon@example.com", "frequency" => "weekly" });
    assert_eq!(answer(&routes, "POST", "/api/reports", report).await.0, 201);
    now.fetch_add(7 * 86_400_000, Ordering::SeqCst);
    assert_eq!(rl.send_reports().await.unwrap(), (1, 0));
    {
        let sent = sent.lock().unwrap();
        let header = |name: &str| sent[1].headers.iter().find(|h| h.0 == name).map(|h| h.1.clone()).unwrap();
        let unsubscribe = header("List-Unsubscribe");
        let token = unsubscribe
            .strip_prefix("<https://stats.example.com/runlight/unsubscribe/")
            .and_then(|t| t.strip_suffix('>'))
            .unwrap();
        assert!(token.len() == 32 && token.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(header("List-Unsubscribe-Post"), "List-Unsubscribe=One-Click");
    }

    // A failure comes back as a mail error naming the mailer.
    *fail.lock().unwrap() = "SMTP connect() failed".into();
    assert_eq!(
        answer(&routes, "POST", "/api/mail/test", test()).await,
        (
            400,
            obj! {
                "error" => "WordPress (WP Mail SMTP) could not send it: SMTP connect() failed",
                "code" => "mail_app_failed",
                "params" => obj! { "via" => "WordPress (WP Mail SMTP)", "detail" => "SMTP connect() failed" },
            }
        )
    );
    fail.lock().unwrap().clear();

    // A service saved in the dashboard takes its place.
    let resend = Some(obj! { "service" => "resend", "apiKey" => "re_live_key", "from" => "reports@example.com" });
    assert_eq!(answer(&routes, "PUT", "/api/mail", resend).await.0, 200);
    let (_, replaced) = answer(&routes, "GET", "/api/mail", None).await;
    let mut app_replaced = app.clone();
    app_replaced.as_object_mut().unwrap().set("replaced", true);
    assert_eq!(
        ["source", "service", "from", "app"].map(|k| replaced.at(k).clone()),
        [Value::from("dashboard"), Value::from("resend"), Value::from("reports@example.com"), app_replaced]
    );
    assert_eq!(answer(&routes, "POST", "/api/mail/test", test()).await.0, 200);
    assert_eq!(capture.calls.lock().unwrap().len(), 1, "through the saved service");
    assert_eq!(sent.lock().unwrap().len(), 2, "and not the app's mailer");

    // Removing it goes back to the app's mailer.
    assert_eq!(answer(&routes, "DELETE", "/api/mail", None).await.0, 200);
    assert_eq!(answer(&routes, "GET", "/api/mail", None).await.1.at("source"), &Value::from("app"));
    assert_eq!(answer(&routes, "POST", "/api/mail/test", test()).await.0, 200);
    assert_eq!(sent.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn the_apps_mailer_needs_a_from_address_and_without_one_the_answer_has_no_app() {
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    options.app_mailer = Some(AppMailer {
        from: String::new(),
        from_name: None,
        via: "Drupal".into(),
        send: Arc::new(|_| Box::pin(async { Ok(()) })),
    });
    assert!(Runlight::new(options).err().unwrap().contains("from address"));

    let rl = Runlight::new(RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap())).unwrap();
    let (_, view) = answer(&routes(&rl), "GET", "/api/mail", None).await;
    assert_eq!(view.at("source"), &Value::Null);
    assert!(view.get("app").is_none(), "an install without an app mailer answers as before");
    assert!(rl.app_mailer().is_none());
}

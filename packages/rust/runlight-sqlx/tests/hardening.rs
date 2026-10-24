//! Hardening as hardening.test.ts tests it: trust_proxy left at its default believes forwarding headers only
//! from a private address.

use runlight::http::Request;
use runlight::{Runlight, RunlightOptions, SiteOptions, TrustProxy};

async fn runlight(trust_proxy: Option<TrustProxy>) -> Runlight {
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    options.site = Some(SiteOptions { hostnames: Some(vec!["example.com".into()]), ..SiteOptions::default() });
    options.trust_proxy = trust_proxy;
    Runlight::new(options).unwrap()
}

fn from(ip: &str) -> Request {
    let mut request = Request::get("https://example.com/e");
    request.remote_address = ip.into();
    request
}

fn forwarded(ip: &str) -> Request {
    from(ip).header("x-forwarded-for", "8.8.4.4")
}

#[tokio::test]
async fn with_trust_proxy_left_at_its_default_forwarding_headers_count_only_from_a_private_address() {
    let quiet = runlight(Some(TrustProxy::On)).await;
    assert_eq!(
        quiet.client_ip(&forwarded("8.8.8.8")),
        "8.8.4.4",
        "trust_proxy set on purpose believes a public address"
    );
    assert_eq!(quiet.direct_warnings(), 0, "and is never second-guessed");

    let rl = runlight(None).await;
    assert_eq!(rl.client_ip(&forwarded("10.0.0.2")), "8.8.4.4", "a proxy on a private network is believed");
    assert_eq!(rl.client_ip(&forwarded("::ffff:127.0.0.1")), "8.8.4.4", "and one on this computer");
    assert_eq!(rl.client_ip(&forwarded("")), "8.8.4.4", "and a platform that passes no address on");
    assert_eq!(rl.client_ip(&from("8.8.8.8")), "8.8.8.8");
    assert_eq!(rl.direct_warnings(), 0, "a public address without forwarding headers says nothing");
    assert_eq!(
        rl.client_ip(&forwarded("1.1.1.1")),
        "1.1.1.1",
        "a client straight from the internet cannot choose its address"
    );
    rl.client_ip(&forwarded("1.0.0.1"));
    assert_eq!(rl.direct_warnings(), 1, "said once");
}

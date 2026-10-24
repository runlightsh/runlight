//! Fetches that stay on the public internet, and site icons over them: the
//! cases of the PHP port's SafefetchTest and IconTest, and the address checks
//! and icon links in outbound.json.

mod common;

use std::net::IpAddr;
use std::sync::{Arc, Mutex};

use common::{fixture, list, s};
use runlight::BoxFuture;
use runlight::http::{FetchError, FetchInit, Fetcher, Headers, Response};
use runlight::icon::{Icon, fetch_icon, icon_links};
use runlight::safefetch::{
    Lookup, MetadataAddressError, PrivateAddressError, PublicFetchError, PublicFetchInit, ServiceFetchError,
    metadata_address, metadata_host, public_address, public_addresses, public_fetch, resolves_privately, service_fetch,
};

#[tokio::test]
async fn link_local_and_cloud_metadata_addresses_are_told_apart_from_loopback_and_private_ones() {
    for ip in [
        "169.254.169.254",
        "169.254.0.1",
        "100.100.100.200",
        "fe80::1",
        "fe80::a9fe:a9fe",
        "fd00:ec2::254",
        "::ffff:169.254.169.254",
        "::ffff:a9fe:a9fe",
        "64:ff9b::a9fe:a9fe",
        "::ffff:0:a9fe:a9fe",
    ] {
        assert!(metadata_address(ip), "{ip}");
    }
    for ip in
        ["127.0.0.1", "::1", "10.0.0.5", "192.168.1.20", "fd00::1", "fd00:ec2::253", "93.184.215.14", "not an address"]
    {
        assert!(!metadata_address(ip), "{ip}");
    }
    assert!(metadata_host("metadata.google.internal", None).await);
    assert!(metadata_host("[fd00:ec2::254]", None).await);
    assert!(metadata_host("169.254.169.254", None).await);
    assert!(!metadata_host("localhost", None).await, "a model on this computer is fine");
    assert!(!metadata_host("192.168.1.20", None).await);
    let points_at_metadata: Lookup = Arc::new(|_| Box::pin(async { vec!["169.254.169.254".to_string()] }));
    assert!(metadata_host("llm.example.com", Some(&points_at_metadata)).await, "a name is judged by its addresses");
}

type Answer = Box<dyn Fn(&str) -> Result<Response, FetchError> + Send + Sync>;

/// A Fetcher that answers from a function and remembers what it was asked.
struct Fake {
    answer: Answer,
    seen: Mutex<Vec<(String, FetchInit)>>,
}

impl Fake {
    fn new(answer: impl Fn(&str) -> Result<Response, FetchError> + Send + Sync + 'static) -> Arc<Fake> {
        Arc::new(Fake { answer: Box::new(answer), seen: Mutex::new(Vec::new()) })
    }

    fn urls(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|(u, _)| u.clone()).collect()
    }

    fn init(&self, i: usize) -> FetchInit {
        self.seen.lock().unwrap()[i].1.clone()
    }
}

impl Fetcher for Fake {
    fn fetch<'a>(&'a self, url: &'a str, init: FetchInit) -> BoxFuture<'a, Result<Response, FetchError>> {
        self.seen.lock().unwrap().push((url.to_string(), init));
        let out = (self.answer)(url);
        Box::pin(async move { out })
    }
}

/// Answers in turn, then "end".
fn hops(answers: Vec<Response>) -> Arc<Fake> {
    let queue = Mutex::new(answers);
    Fake::new(move |_| {
        let mut q = queue.lock().unwrap();
        Ok(if q.is_empty() { Response::new("end", 200, Headers::new()) } else { q.remove(0) })
    })
}

fn redirect(location: &str, status: u16) -> Response {
    Response::status(status).header("location", location)
}

/// A DNS stand-in.
fn dns(names: &[(&str, &[&str])]) -> Lookup {
    let names: Vec<(String, Vec<String>)> =
        names.iter().map(|(n, a)| (n.to_string(), a.iter().map(|s| s.to_string()).collect())).collect();
    Arc::new(move |name: &str| {
        let found = names.iter().find(|(n, _)| n == name).map(|(_, a)| a.clone()).unwrap_or_default();
        Box::pin(async move { found }) as BoxFuture<'static, Vec<String>>
    })
}

fn init(timeout_ms: u64, lookup: &Lookup) -> PublicFetchInit {
    PublicFetchInit { lookup: Some(lookup.clone()), ..PublicFetchInit::new(timeout_ms) }
}

fn private(what: &str) -> PublicFetchError {
    PublicFetchError::Private(PrivateAddressError(what.to_string()))
}

#[test]
fn only_addresses_on_the_public_internet_count_as_public() {
    for ip in [
        "93.184.215.14",
        "1.1.1.1",
        "2606:4700:4700::1111",
        "2a00:1450:4001:82a::200e",
        "::ffff:0:808:808",
        "64:ff9b::808:808",
    ] {
        assert!(public_address(ip), "{ip}");
    }
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "172.16.5.4",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::",
        "fe80::1",
        "fd00::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
        "::ffff:169.254.169.254",
        "64:ff9b::a00:1",
        "2002:a00:1::",
        "2001:db8::1",
        "2001:0:4136:e378::1",
        // IPv4-translated loopback, local-use NAT64, the old site-local, ORCHID, the newer documentation prefix, and discard.
        "::ffff:0:7f00:1",
        "64:ff9b:1::7f00:1",
        "fec0::1",
        "2001:20::1",
        "3fff::1",
        "100::1",
        "[::1]",
        "not an address",
        "1.2.3",
        "1.2.3.256",
    ] {
        assert!(!public_address(ip), "{ip}");
    }
}

#[test]
fn address_checks_match_typescript() {
    let f = fixture("outbound");
    let cases = list(&f, "ips");
    assert!(cases.len() > 50);
    for case in cases {
        assert_eq!(public_address(s(case, "ip")), case.at("public").as_bool().unwrap(), "{}", s(case, "ip"));
    }
}

#[tokio::test]
async fn a_public_fetch_never_reaches_the_installs_own_network_however_the_address_is_written() {
    // Something listening locally, which none of these may reach.
    let inside = (5440..5450).find_map(|p| std::net::TcpListener::bind(("127.0.0.1", p)).ok()).expect("a free port");
    inside.set_nonblocking(true).unwrap();
    let port = inside.local_addr().unwrap().port();
    let fetcher = runlight::http::default_fetcher();
    for url in [
        format!("http://127.0.0.1:{port}/"),
        format!("https://127.0.0.1:{port}/"),
        format!("https://[::1]:{port}/"),
        format!("https://[::ffff:127.0.0.1]:{port}/"),
        format!("https://localhost:{port}/"),
        format!("https://LOCALHOST.:{port}/"),
        format!("https://app.localhost:{port}/"),
    ] {
        match public_fetch(fetcher.as_ref(), &url, &PublicFetchInit::new(2000)).await {
            Err(PublicFetchError::Private(_)) => {}
            other => panic!("{url} should be refused: {other:?}"),
        }
    }
    assert!(inside.accept().is_err(), "nothing connected");
    assert!(resolves_privately("localhost", None).await);
    assert!(!resolves_privately("name.that.does.not.resolve.invalid", None).await);
    assert!(public_addresses("name.that.does.not.resolve.invalid", None).await.is_empty());
    assert_eq!(public_addresses("8.8.8.8", None).await, vec!["8.8.8.8"]);
    assert!(public_addresses("localhost", None).await.is_empty());
}

#[tokio::test]
async fn the_checked_addresses_are_pinned() {
    let fetcher = Fake::new(|_| Ok(Response::new("ok", 200, Headers::new())));
    let lookup = dns(&[("example.com", &["93.184.215.14", "2606:4700::1111"])]);
    let options = PublicFetchInit {
        headers: Headers::new().with("user-agent", "Runlight"),
        max_bytes: Some(10),
        ..init(2000, &lookup)
    };
    let answer = public_fetch(fetcher.as_ref(), "https://Example.com/icon", &options).await.unwrap();
    assert_eq!(answer.text(), "ok");
    let first = fetcher.init(0);
    let ips: Vec<IpAddr> = vec!["93.184.215.14".parse().unwrap(), "2606:4700::1111".parse().unwrap()];
    assert_eq!(first.resolve, vec![("example.com".to_string(), 443, ips)]);
    assert!(first.manual_redirect);
    assert_eq!(first.max_bytes, Some(10));
    assert_eq!(first.method, "GET");
    assert_eq!(first.headers.get("user-agent").as_deref(), Some("Runlight"));
    assert!(first.timeout_ms <= 2000);
    assert_eq!(fetcher.urls(), vec!["https://example.com/icon"]);

    let literal = Fake::new(|_| Ok(Response::new("ok", 200, Headers::new())));
    public_fetch(literal.as_ref(), "https://93.184.215.14:8443/", &init(2000, &dns(&[]))).await.unwrap();
    let ip: IpAddr = "93.184.215.14".parse().unwrap();
    assert_eq!(literal.init(0).resolve, vec![("93.184.215.14".to_string(), 8443, vec![ip])], "pinned to itself");
}

#[tokio::test]
async fn a_name_with_any_private_address_is_refused() {
    let fetcher = Fake::new(|_| Ok(Response::new("ok", 200, Headers::new())));
    for (name, addresses) in [
        ("inside.example", &["10.0.0.5"][..]),
        ("mixed.example", &["93.184.215.14", "169.254.169.254"][..]),
        ("mapped.example", &["::ffff:127.0.0.1"][..]),
    ] {
        let lookup = dns(&[(name, addresses)]);
        let err = public_fetch(fetcher.as_ref(), &format!("https://{name}/"), &init(2000, &lookup)).await.unwrap_err();
        assert_eq!(err.to_string(), format!("{name} is not a public address"));
    }
    assert!(fetcher.urls().is_empty());
    let err = public_fetch(fetcher.as_ref(), "https://nowhere.example/", &init(2000, &dns(&[]))).await.unwrap_err();
    assert_eq!(err, PublicFetchError::Fetch(FetchError::Failed("getaddrinfo ENOTFOUND nowhere.example".into())));
}

#[tokio::test]
async fn redirects_are_followed_by_hand_under_the_same_rules() {
    let lookup =
        dns(&[("a.example", &["93.184.215.14"]), ("b.example", &["1.1.1.1"]), ("inside.example", &["192.168.0.2"])]);
    let three = PublicFetchInit { redirects: 3, ..init(2000, &lookup) };

    let fetcher = hops(vec![
        redirect("/next", 301),
        redirect("https://b.example/last", 302),
        Response::new("done", 200, Headers::new()),
    ]);
    let answer = public_fetch(fetcher.as_ref(), "https://a.example/", &three).await.unwrap();
    assert_eq!(answer.text(), "done");
    assert_eq!(fetcher.urls(), vec!["https://a.example/", "https://a.example/next", "https://b.example/last"]);
    assert_eq!(
        fetcher.init(2).resolve,
        vec![("b.example".to_string(), 443, vec!["1.1.1.1".parse::<IpAddr>().unwrap()])]
    );

    let fetcher = hops(vec![redirect("https://b.example/", 302)]);
    let answer = public_fetch(fetcher.as_ref(), "https://a.example/", &init(2000, &lookup)).await.unwrap();
    assert_eq!(answer.status, 302, "a redirect past the last comes back as it is");

    let fetcher = hops(vec![redirect("https://b.example/", 307)]);
    let post = PublicFetchInit { method: "POST".into(), body: Some(b"{}".to_vec()), ..three.clone() };
    let answer = public_fetch(fetcher.as_ref(), "https://a.example/", &post).await.unwrap();
    assert_eq!((answer.status, fetcher.urls().len()), (307, 1), "only a GET follows a redirect");
    assert_eq!((fetcher.init(0).method.as_str(), fetcher.init(0).body.as_deref()), ("POST", Some(&b"{}"[..])));

    for (location, what) in [
        ("https://10.0.0.1/", "10.0.0.1"),
        ("https://inside.example/", "inside.example"),
        ("http://b.example/", "http://b.example/"),
        ("https://[fe80::1]/", "fe80::1"),
    ] {
        let fetcher = hops(vec![redirect(location, 302)]);
        let err = public_fetch(fetcher.as_ref(), "https://a.example/", &three).await.unwrap_err();
        assert_eq!(err, private(what), "{location}");
        assert_eq!(err.to_string(), format!("{what} is not a public address"));
    }
}

#[tokio::test]
async fn running_out_of_time_says_so() {
    let lookup = dns(&[("a.example", &["1.1.1.1"])]);
    let fetcher = Fake::new(|_| Err(FetchError::TimedOut));
    let err = public_fetch(fetcher.as_ref(), "https://a.example/", &init(2000, &lookup)).await.unwrap_err();
    assert_eq!(err, PublicFetchError::Fetch(FetchError::TimedOut));
    assert_eq!(err.to_string(), "The operation was aborted due to timeout");

    let refused = Fake::new(|_| Err(FetchError::Failed("Connection refused".into())));
    let err = public_fetch(refused.as_ref(), "https://a.example/", &init(2000, &lookup)).await.unwrap_err();
    assert_eq!(err.to_string(), "Connection refused");

    // A Fetcher that never answers is cut off at the time limit.
    struct Hangs;
    impl Fetcher for Hangs {
        fn fetch<'a>(&'a self, _: &'a str, _: FetchInit) -> BoxFuture<'a, Result<Response, FetchError>> {
            Box::pin(std::future::pending())
        }
    }
    let started = std::time::Instant::now();
    let err = public_fetch(&Hangs, "https://a.example/", &init(50, &lookup)).await.unwrap_err();
    assert_eq!(err, PublicFetchError::Fetch(FetchError::TimedOut));
    assert!(started.elapsed().as_millis() < 1000);
}

#[test]
fn icon_links_match_typescript() {
    let f = fixture("outbound");
    let cases = list(&f, "icons");
    assert!(!cases.is_empty());
    for case in cases {
        let want: Vec<String> = list(case, "links").iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(icon_links(s(case, "html"), s(case, "base")), want, "{}", s(case, "html"));
    }
}

#[test]
fn icon_links_read_attributes_as_javascript_does() {
    // As the TypeScript reads it (checked against Node): data-rel is a name of its own, so the first
    // link is an icon; a quote that never closes starts an unquoted value; names, spaces around the
    // equals sign, and the tag itself are matched in any case.
    let html = "<link data-rel=\"stylesheet\" rel=\"icon\" href=/a.png\u{a0}x><link rel='apple-touch-icon' href=\"/t.png><LINK\nREL = ICON HREF = '/b.svg' >";
    assert_eq!(
        icon_links(html, "https://example.com"),
        vec!["https://example.com/%22/t.png", "https://example.com/b.svg", "https://example.com/a.png"]
    );
    // A name with an equals sign and no value reads as empty.
    assert!(icon_links("<link rel = \"icon\" href= >", "https://example.com").is_empty());
    // Unquoted values stop at JavaScript's whitespace, which includes a no-break space.
    assert_eq!(
        icon_links("<link rel=icon href=/a.png\u{a0}x>", "https://example.com"),
        vec!["https://example.com/a.png"]
    );
}

fn html(body: &str) -> Response {
    Response::new(body, 200, Headers::new().with("content-type", "text/html; charset=utf-8"))
}

#[tokio::test]
async fn the_best_linked_icon_is_fetched_with_its_caps() {
    // An address as the origin, so no name is looked up.
    let origin = "https://93.184.215.14";
    let fetcher = Fake::new(|url| {
        Ok(match url {
            "https://93.184.215.14/" => {
                html("<link rel=\"apple-touch-icon\" href=\"/touch.png\"><link rel=\"icon\" href=\"/i.svg\">")
            }
            "https://93.184.215.14/touch.png" => {
                Response::new("<html>", 200, Headers::new().with("content-type", "text/html"))
            }
            "https://93.184.215.14/i.svg" => {
                Response::new("<svg/>", 200, Headers::new().with("content-type", "Image/SVG+xml; charset=utf-8"))
            }
            _ => Response::new("", 404, Headers::new()),
        })
    });
    let now = 1_791_471_600_000;
    let icon = fetch_icon(fetcher.as_ref(), origin, now).await;
    assert_eq!(icon, Some(Icon { body: b"<svg/>".to_vec(), content_type: "image/svg+xml".into() }));
    assert_eq!(
        fetcher.urls(),
        vec!["https://93.184.215.14/", "https://93.184.215.14/touch.png", "https://93.184.215.14/i.svg"]
    );
    let page = fetcher.init(0);
    assert_eq!((page.max_bytes, page.truncate), (Some(200_000), true));
    let image = fetcher.init(1);
    assert_eq!((image.max_bytes, image.truncate), (Some(262_144), false), "an image must arrive whole");
    assert_eq!(page.headers.get("user-agent").as_deref(), Some("Runlight (+https://runlight.sh)"));
    assert!(page.timeout_ms <= 4000);

    // Cached for a day.
    assert_eq!(fetch_icon(fetcher.as_ref(), origin, now + 86_399_000).await, icon);
    assert_eq!(fetcher.urls().len(), 3);
    fetch_icon(fetcher.as_ref(), origin, now + 86_400_000).await;
    assert_eq!(fetcher.urls().len(), 6, "and looked up again after it");
}

#[tokio::test]
async fn favicon_is_the_fallback_and_no_icon_is_remembered_for_an_hour() {
    let origin = "https://1.1.1.1";
    let fetcher = Fake::new(|url| {
        Ok(if url == "https://1.1.1.1/favicon.ico" {
            Response::new("", 200, Headers::new().with("content-type", "image/x-icon"))
        } else {
            Response::new("nope", 500, Headers::new())
        })
    });
    let now = 1_791_471_600_000;
    assert_eq!(fetch_icon(fetcher.as_ref(), origin, now).await, None, "an empty image is no icon");
    assert_eq!(fetcher.urls(), vec!["https://1.1.1.1/", "https://1.1.1.1/favicon.ico"]);
    assert_eq!(fetch_icon(fetcher.as_ref(), origin, now + 3_599_000).await, None);
    assert_eq!(fetcher.urls().len(), 2);
    fetch_icon(fetcher.as_ref(), origin, now + 3_600_000).await;
    assert_eq!(fetcher.urls().len(), 4);
}

#[tokio::test]
async fn an_image_too_long_or_declared_too_long_is_no_icon() {
    let origin = "https://8.8.4.4";
    let fetcher = Fake::new(|url| {
        Ok(match url {
            "https://8.8.4.4/" => html("<link rel=icon href=/big.png><link rel=icon href=/said.png>"),
            "https://8.8.4.4/said.png" => Response::new(
                "x",
                200,
                Headers::new().with("content-type", "image/png").with("content-length", " 300000 "),
            ),
            "https://8.8.4.4/favicon.ico" => {
                Response::new("ico", 200, Headers::new().with("content-type", "image/x-icon"))
            }
            _ => return Err(FetchError::TooLong(262_144)),
        })
    });
    let icon = fetch_icon(fetcher.as_ref(), origin, 0).await;
    assert_eq!(icon, Some(Icon { body: b"ico".to_vec(), content_type: "image/x-icon".into() }));
    assert_eq!(
        fetcher.urls(),
        vec!["https://8.8.4.4/", "https://8.8.4.4/big.png", "https://8.8.4.4/said.png", "https://8.8.4.4/favicon.ico"]
    );
}

#[tokio::test]
async fn a_private_origin_is_never_fetched() {
    let fetcher = Fake::new(|_| Ok(Response::new("x", 200, Headers::new().with("content-type", "image/png"))));
    assert_eq!(fetch_icon(fetcher.as_ref(), "https://192.168.1.1", 0).await, None);
    assert!(fetcher.urls().is_empty());
}

#[tokio::test]
async fn dashboards_opening_at_once_share_one_lookup() {
    struct Slow(Mutex<usize>);
    impl Fetcher for Slow {
        fn fetch<'a>(&'a self, url: &'a str, _: FetchInit) -> BoxFuture<'a, Result<Response, FetchError>> {
            *self.0.lock().unwrap() += 1;
            let ico = url.ends_with("/favicon.ico");
            Box::pin(async move {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                Ok(if ico {
                    Response::new("i", 200, Headers::new().with("content-type", "image/x-icon"))
                } else {
                    Response::new("", 404, Headers::new())
                })
            })
        }
    }
    let fetcher = Slow(Mutex::new(0));
    let (a, b) = tokio::join!(fetch_icon(&fetcher, "https://9.9.9.9", 0), fetch_icon(&fetcher, "https://9.9.9.9", 0));
    assert_eq!(a, b);
    assert!(a.is_some());
    assert_eq!(*fetcher.0.lock().unwrap(), 2, "the page and the favicon, once");
}

/// What the little server below was asked: method, path, body, authorization, and content type.
type Seen = Arc<Mutex<Vec<[String; 5]>>>;

/// An HTTP server on this computer that redirects as each path says, and records every request.
async fn redirecting_server() -> (u16, Seen) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen: Seen = Arc::default();
    let record = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { return };
            let record = record.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head, body) = loop {
                    let Ok(n) = socket.read(&mut chunk).await else { return };
                    if n == 0 {
                        return;
                    }
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(at) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&bytes[..at]).into_owned();
                        let length = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().to_string())
                            })
                            .and_then(|v| v.parse::<usize>().ok())
                            .unwrap_or(0);
                        while bytes.len() < at + 4 + length {
                            let Ok(n) = socket.read(&mut chunk).await else { return };
                            if n == 0 {
                                break;
                            }
                            bytes.extend_from_slice(&chunk[..n]);
                        }
                        break (head, String::from_utf8_lossy(&bytes[at + 4..]).into_owned());
                    }
                };
                let mut lines = head.lines();
                let mut first = lines.next().unwrap_or("").split(' ');
                let (method, path) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("").to_string());
                let header = |name: &str| {
                    head.lines()
                        .skip(1)
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.eq_ignore_ascii_case(name).then(|| v.trim().to_string())
                        })
                        .unwrap_or_default()
                };
                record.lock().unwrap().push([
                    method,
                    path.clone(),
                    body,
                    header("authorization"),
                    header("content-type"),
                ]);
                let location = match path.as_str() {
                    "/metadata" => Some((302, "http://169.254.169.254/latest/meta-data/".to_string())),
                    "/metadata-v6" => Some((307, "http://[fd00:ec2::254]/".to_string())),
                    "/see-other" => Some((303, "/landed".to_string())),
                    "/keep" => Some((307, "/landed".to_string())),
                    "/elsewhere" => Some((307, format!("http://localhost:{port}/landed"))),
                    "/loop" => Some((302, "/loop".to_string())),
                    _ => None,
                };
                let answer = match location {
                    Some((status, to)) => {
                        format!(
                            "HTTP/1.1 {status} Moved\r\nlocation: {to}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        )
                    }
                    None => "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok".to_string(),
                };
                let _ = socket.write_all(answer.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    (port, seen)
}

#[cfg(feature = "transport")]
#[tokio::test]
async fn a_services_redirects_are_followed_only_while_each_one_stays_off_link_local_and_metadata_addresses() {
    use runlight::safefetch::{MetadataAddressError, SERVICE_REDIRECTS, ServiceFetchError, service_fetch};
    let (port, seen) = redirecting_server().await;
    let base = format!("http://127.0.0.1:{port}");
    let fetcher = runlight::http::default_fetcher();
    let ask = || {
        FetchInit::method("POST")
            .header("authorization", "Bearer key")
            .header("content-type", "application/json")
            .body("{}")
            .timeout(10_000)
    };
    let refused = |host: &str| Err(ServiceFetchError::Metadata(MetadataAddressError { host: host.into() }));
    // A service on this computer is fine; a redirect to a metadata address is refused before it is asked.
    let fetch = |path: &str, init: FetchInit, redirects: u32| {
        let (fetcher, url) = (fetcher.clone(), format!("{base}{path}"));
        async move { service_fetch(&*fetcher, &url, init, redirects, None).await }
    };
    assert_eq!(fetch("/metadata", ask(), SERVICE_REDIRECTS).await.map(|r| r.status), refused("169.254.169.254"));
    assert_eq!(fetch("/metadata-v6", ask(), SERVICE_REDIRECTS).await.map(|r| r.status), refused("fd00:ec2::254"));
    assert_eq!(
        service_fetch(&*fetcher, "http://169.254.169.254/v1/models", FetchInit::default(), 5, None)
            .await
            .map(|r| r.status),
        refused("169.254.169.254")
    );
    let row = |m: &str, p: &str, b: &str, a: &str, t: &str| [m, p, b, a, t].map(str::to_string);
    // Followed as fetch follows them: a 303 goes on as a GET with no body, a 307 keeps both, and the key goes
    // no further than the origin it was meant for.
    seen.lock().unwrap().clear();
    assert_eq!(fetch("/see-other", ask(), SERVICE_REDIRECTS).await.unwrap().text(), "ok");
    assert_eq!(seen.lock().unwrap()[1], row("GET", "/landed", "", "Bearer key", ""));
    seen.lock().unwrap().clear();
    fetch("/keep", ask(), SERVICE_REDIRECTS).await.unwrap();
    assert_eq!(seen.lock().unwrap()[1], row("POST", "/landed", "{}", "Bearer key", "application/json"));
    // A redirect to another origin (here, another name for the same computer) is refused before it is asked.
    seen.lock().unwrap().clear();
    match fetch("/elsewhere", ask(), SERVICE_REDIRECTS).await {
        Err(ServiceFetchError::Redirect(error)) => {
            assert_eq!(error.host, format!("127.0.0.1:{port}"));
            assert_eq!(error.to, format!("http://localhost:{port}"));
        }
        other => panic!("{:?}", other.map(|r| r.status)),
    }
    assert_eq!(seen.lock().unwrap().len(), 1, "nothing was sent to the other origin");
    // Past the last redirect, the redirect comes back as it is.
    seen.lock().unwrap().clear();
    assert_eq!(fetch("/loop", FetchInit::default(), 2).await.unwrap().status, 302);
    assert_eq!(seen.lock().unwrap().len(), 3);

    // The AI assistant and a mail webhook refuse such a redirect with the address it led to.
    let settings = runlight::assistant::AssistantSettings {
        provider: "custom".into(),
        base_url: format!("{base}/metadata#"),
        ..Default::default()
    };
    match runlight::assistant::list_models(&settings, &fetcher).await {
        Err(runlight::assistant::AssistantFailure::Coded(e)) => {
            assert_eq!(
                (e.code.as_str(), e.params),
                ("address_refused", vec![("host".into(), "169.254.169.254".into())])
            )
        }
        other => panic!("{other:?}"),
    }
    let mut config = runlight::js::Object::new();
    config.set("service", "webhook");
    config.set("url", format!("http://localhost:{port}/metadata"));
    let message = runlight::mail::Message {
        to: "me@example.com".into(),
        from: "reports@example.com".into(),
        subject: "Hi".into(),
        html: "<p>Hi</p>".into(),
        text: "Hi".into(),
        ..Default::default()
    };
    let error = runlight::mail::transports::send(&config, &message, &fetcher, 0).await.unwrap_err();
    assert_eq!(
        (error.code.as_str(), error.message.as_str()),
        (
            "address_refused",
            "169.254.169.254 is a link-local or cloud metadata address, which Runlight never connects to"
        )
    );
}

/// A Fake that connects only to the addresses it is given, as the default Fetcher does.
struct Pinning(Arc<Fake>);

impl Fetcher for Pinning {
    fn fetch<'a>(&'a self, url: &'a str, init: FetchInit) -> BoxFuture<'a, Result<Response, FetchError>> {
        self.0.fetch(url, init)
    }

    fn pins(&self) -> bool {
        true
    }
}

#[tokio::test]
async fn a_services_redirect_to_another_origin_is_refused_with_nothing_sent_there() {
    let lookup = dns(&[("api.example.com", &["93.184.215.14"]), ("elsewhere.example.com", &["93.184.215.15"])]);
    let key_headers =
        ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-postmark-server-token"];
    for (status, to) in [
        (307, "https://elsewhere.example.com/v1"),
        (308, "https://elsewhere.example.com/v1"),
        (302, "https://api.example.com:8443/v1"),
        (301, "http://api.example.com/v1"),
        (308, "http://198.51.100.7/v1"),
        (307, "ftp://api.example.com/v1"),
    ] {
        for name in key_headers {
            let fake = hops(vec![redirect(to, status)]);
            let init = FetchInit::method("POST").header(name, "secret").body("the whole email").timeout(5_000);
            let error = service_fetch(&*fake, "https://api.example.com/v1/send", init, 5, Some(&lookup)).await;
            let Err(ServiceFetchError::Redirect(refused)) = error else { panic!("{status} {to} {name}: {error:?}") };
            assert_eq!(refused.host, "api.example.com");
            assert_eq!(fake.urls(), ["https://api.example.com/v1/send"], "{status} {to} {name}: one request only");
        }
    }
    // The message names where it pointed, or the protocol for one that is not http.
    let fake = hops(vec![redirect("http://198.51.100.7/v1", 307)]);
    let error = service_fetch(&*fake, "https://api.example.com/v1", FetchInit::default(), 5, Some(&lookup)).await;
    assert_eq!(
        error.unwrap_err().to_string(),
        "api.example.com redirected to http://198.51.100.7. Runlight sends a service's key and request only to the address it was set up with, so set it up with that address instead"
    );
    let fake = hops(vec![redirect("ftp://api.example.com/v1", 307)]);
    let error = service_fetch(&*fake, "https://api.example.com/v1", FetchInit::default(), 5, Some(&lookup)).await;
    let Err(ServiceFetchError::Redirect(refused)) = error else { panic!("{error:?}") };
    assert_eq!(refused.to, "ftp:");
    // A metadata address wins over the redirect refusal, and a redirect on the same origin is followed.
    let fake = hops(vec![redirect("http://169.254.169.254/latest", 307)]);
    let error = service_fetch(&*fake, "https://api.example.com/v1", FetchInit::default(), 5, Some(&lookup)).await;
    assert_eq!(
        error.unwrap_err(),
        ServiceFetchError::Metadata(MetadataAddressError { host: "169.254.169.254".into() })
    );
    let fake = hops(vec![redirect("/v2/send", 307)]);
    let init = FetchInit::method("POST").header("x-api-key", "secret").body("{}").timeout(5_000);
    assert_eq!(
        service_fetch(&*fake, "https://api.example.com/v1", init, 5, Some(&lookup)).await.unwrap().text(),
        "end"
    );
    assert_eq!(fake.urls(), ["https://api.example.com/v1", "https://api.example.com/v2/send"]);
    assert_eq!(fake.init(1).headers.get("x-api-key").as_deref(), Some("secret"));
}

#[tokio::test]
async fn a_service_is_fetched_from_the_address_its_name_was_checked_at() {
    let lookup = dns(&[
        ("local.example.com", &["127.0.0.1"]),
        ("lan.example.com", &["192.168.1.20", "10.0.0.5"]),
        ("meta.example.com", &["169.254.169.254"]),
        ("mixed.example.com", &["93.184.215.14", "fd00:ec2::254"]),
    ]);
    let ok = || Fake::new(|_| Ok(Response::new("ok", 200, Headers::new())));
    // Private and local addresses stay allowed, and the connection is pinned to what was checked.
    for (url, port, found) in [
        ("http://local.example.com:11434/v1", 11434, vec!["127.0.0.1"]),
        ("https://lan.example.com/v1", 443, vec!["192.168.1.20", "10.0.0.5"]),
        ("http://127.0.0.1/v1", 80, vec!["127.0.0.1"]),
    ] {
        let fake = ok();
        let answer = service_fetch(&Pinning(fake.clone()), url, FetchInit::default(), 5, Some(&lookup)).await;
        assert_eq!(answer.unwrap().text(), "ok", "{url}");
        let host = runlight::http::Url::parse(url).unwrap().hostname();
        let ips: Vec<IpAddr> = found.iter().map(|a| a.parse().unwrap()).collect();
        assert_eq!(fake.init(0).resolve, vec![(host, port, ips)], "{url}");
    }
    // A name with a metadata address among its answers, or none at all, is refused; nothing is sent.
    for (url, host) in
        [("https://meta.example.com/v1", "meta.example.com"), ("https://mixed.example.com/v1", "mixed.example.com")]
    {
        let fake = ok();
        let answer = service_fetch(&Pinning(fake.clone()), url, FetchInit::default(), 5, Some(&lookup)).await;
        assert_eq!(answer.unwrap_err(), ServiceFetchError::Metadata(MetadataAddressError { host: host.into() }));
        assert!(fake.urls().is_empty(), "{url}");
    }
    let fake = ok();
    let answer =
        service_fetch(&Pinning(fake.clone()), "https://gone.example.com/v1", FetchInit::default(), 5, Some(&lookup))
            .await;
    assert_eq!(
        answer.unwrap_err(),
        ServiceFetchError::Fetch(FetchError::Failed("getaddrinfo ENOTFOUND gone.example.com".into())),
        "a lookup that fails fails closed"
    );
    assert!(fake.urls().is_empty());
    // A Fetcher that cannot pin gets the name as before, checked but not looked up for it.
    let fake = ok();
    let answer = service_fetch(&*fake, "https://gone.example.com/v1", FetchInit::default(), 5, Some(&lookup)).await;
    assert_eq!(answer.unwrap().text(), "ok");
    assert!(fake.init(0).resolve.is_empty());
}

//! The AI agents' address check, as agentcheck.test.ts tests it: addresses, prefixes, published lists,
//! and the answer for one request.

use runlight::BoxFuture;
use runlight::agentcheck::{
    AGENT_RANGES, Address, RangeList, RangeLists, check_agent, download_range_list, in_ranges, parse_address,
    read_range_list, read_stored_list,
};
use runlight::data::agents::AI_AGENTS;
use runlight::http::{FetchError, FetchInit, Fetcher, Headers, Response};
use runlight::js::{self, Value};

fn json(text: &str) -> Value {
    js::parse(text).unwrap()
}

fn list(prefixes: &[&str]) -> RangeList {
    RangeList::new(prefixes.iter().map(|p| p.to_string()).collect())
}

#[test]
fn addresses_ipv4_ipv6_ipv4_written_as_ipv6_brackets_and_zones_and_junk() {
    assert_eq!(parse_address("20.171.206.17"), Some(Address::V4(0x14ab_ce11)));
    assert_eq!(parse_address(" ::ffff:20.171.206.17 "), Some(Address::V4(0x14ab_ce11)));
    assert_eq!(parse_address("::ffff:14ab:ce11"), Some(Address::V4(0x14ab_ce11)));
    assert_eq!(parse_address("[2600:1f28:365:8000::1]"), Some(Address::V6((0x2600_1f28_0365_8000u128 << 64) | 1)));
    assert_eq!(parse_address("fe80::1%eth0"), Some(Address::V6((0xfe80u128 << 112) | 1)));
    assert_eq!(parse_address("::"), Some(Address::V6(0)));
    for junk in [
        "",
        "unknown",
        "256.1.1.1",
        "1.2.3",
        "1.2.3.4.5",
        "01.2.3.4x",
        "1::2::3",
        "12345::",
        ":1::",
        "1:2:3:4:5:6:7:8:9",
        "::ffff:1.2.3.256",
        "-",
    ] {
        assert_eq!(parse_address(junk), None, "{junk}");
    }
}

#[test]
fn ranges_prefixes_of_any_length_both_families_and_host_bits_past_the_length_ignored() {
    assert!(in_ranges("20.171.206.255", &list(&["20.171.206.0/24"])));
    assert!(!in_ranges("20.171.207.0", &list(&["20.171.206.0/24"])));
    assert!(in_ranges("34.162.230.222", &list(&["34.162.230.222/32"])));
    assert!(!in_ranges("34.162.230.223", &list(&["34.162.230.222/32"])));
    assert!(in_ranges("10.200.0.1", &list(&["10.1.2.3/8"])), "10.1.2.3/8 covers all of 10/8");
    assert!(in_ranges("2600:1f28:365:80ff:ffff::1", &list(&["2600:1f28:365:8000::/56"])));
    assert!(!in_ranges("2600:1f28:365:8100::1", &list(&["2600:1f28:365:8000::/56"])));
    assert!(
        !in_ranges("20.171.206.1", &list(&["2600:1f28:365:8000::/56"])),
        "an IPv4 address is never in an IPv6 prefix"
    );
    assert!(in_ranges("203.0.113.9", &list(&["0.0.0.0/0"])), "/0 covers every IPv4 address");
    assert!(in_ranges("2001:db8::1", &list(&["::/0"])), "/0 covers every IPv6 address");
    let all = list(&["20.171.206.0/24", "34.162.230.222/32", "10.1.2.3/8", "2600:1f28:365:8000::/56", "0.0.0.0/0"]);
    assert!(!in_ranges("not an address", &all));
}

#[test]
fn published_lists_the_shape_every_company_uses_and_anything_else_refused_whole() {
    assert_eq!(
        read_range_list(&json(
            r#"{"creationTime":"x","prefixes":[{"ipv4Prefix":"20.171.206.0/24"},{"ipv6Prefix":" 2600:1f28::/56 "}]}"#
        )),
        Some(vec!["20.171.206.0/24".to_string(), "2600:1f28::/56".to_string()])
    );
    for bad in [
        "null",
        "[]",
        "\"x\"",
        "{}",
        r#"{"prefixes":[]}"#,
        r#"{"prefixes":"1.2.3.0/24"}"#,
        r#"{"prefixes":[{"ipv4Prefix":"1.2.3.0"}]}"#,
        r#"{"prefixes":[{"ipv4Prefix":"1.2.3.0/33"}]}"#,
        r#"{"prefixes":[{"ipv4Prefix":"2600::/56"}]}"#,
        r#"{"prefixes":[{"ipv6Prefix":"1.2.3.0/24"}]}"#,
        r#"{"prefixes":[{"ipv4Prefix":"1.2.3.0/24"},{"other":"x"}]}"#,
    ] {
        assert_eq!(read_range_list(&json(bad)), None, "{bad}");
    }
    let many = format!(r#"{{"prefixes":[{}]}}"#, vec![r#"{"ipv4Prefix":"1.2.3.0/24"}"#; 20_001].join(","));
    assert_eq!(read_range_list(&json(&many)), None);
}

#[test]
fn an_agent_checks_out_does_not_or_has_nothing_to_check_against() {
    let gptbot = AI_AGENTS.iter().find(|a| a.name == "GPTBot").unwrap();
    let meta = AI_AGENTS.iter().find(|a| a.name == "meta-externalagent").unwrap();
    let lists = &*AGENT_RANGES.lists;
    assert_eq!(check_agent(gptbot, "20.171.206.17", lists), "verified");
    assert_eq!(check_agent(gptbot, "198.51.100.23", lists), "mismatch");
    assert_eq!(check_agent(gptbot, "", lists), "", "no address");
    assert_eq!(check_agent(gptbot, "garbage", lists), "");
    assert_eq!(check_agent(meta, "157.240.0.1", lists), "", "Meta publishes no list");
    assert_eq!(
        check_agent(gptbot, "20.171.206.17", &RangeLists::new()),
        "",
        "a list that is missing is nothing to check against"
    );
}

#[test]
fn every_agent_with_a_list_has_it_bundled_and_every_bundled_list_is_read_whole() {
    for agent in AI_AGENTS {
        if let Some(url) = agent.ranges {
            assert!(AGENT_RANGES.lists.get(url).is_some_and(|l| !l.prefixes().is_empty()), "{}: {url}", agent.name);
        }
    }
    // The agents without a list, as the SDK has them.
    let unlisted: Vec<&str> = AI_AGENTS.iter().filter(|a| a.ranges.is_none()).map(|a| a.name).collect();
    assert_eq!(
        unlisted,
        [
            "meta-externalfetcher",
            "meta-externalagent",
            "Amazonbot",
            "Bytespider",
            "cohere-ai",
            "YouBot",
            "Diffbot",
            "Timpibot"
        ]
    );
    assert_eq!(AGENT_RANGES.urls.len(), AGENT_RANGES.lists.len());
    assert!(!AGENT_RANGES.fetched_at.is_empty());
    for (url, list) in AGENT_RANGES.lists.iter() {
        let stored = Value::Array(list.prefixes().iter().map(|p| Value::from(p.as_str())).collect());
        assert_eq!(read_stored_list(&stored).as_deref(), Some(list.prefixes()), "{url}");
    }
}

/// Answers every request with one status, header, and body, and keeps what it was asked with.
struct One(u16, Option<&'static str>, &'static str, std::sync::Mutex<Vec<FetchInit>>);

impl Fetcher for One {
    fn fetch<'a>(&'a self, _url: &'a str, init: FetchInit) -> BoxFuture<'a, Result<Response, FetchError>> {
        self.3.lock().unwrap().push(init);
        let mut headers = Headers::new();
        if let Some(length) = self.1 {
            headers.set("content-length", length);
        }
        let answer = Response { status: self.0, headers, body: self.2.as_bytes().to_vec() };
        Box::pin(async move { Ok(answer) })
    }
}

#[tokio::test]
async fn a_download_is_read_only_when_it_came_back_whole_and_in_the_shape_of_a_list() {
    let good = r#"{"prefixes":[{"ipv4Prefix":"192.0.2.0/24"}]}"#;
    let ok = One(200, None, good, Default::default());
    assert_eq!(
        download_range_list(&ok, "https://openai.com/gptbot.json", 15_000).await,
        Some(vec!["192.0.2.0/24".into()])
    );
    let init = ok.3.lock().unwrap().pop().unwrap();
    assert_eq!(init.headers.get("user-agent").as_deref(), Some("Runlight (+https://runlight.sh)"));
    assert_eq!(init.headers.get("accept").as_deref(), Some("application/json"));
    assert_eq!((init.timeout_ms, init.max_bytes, init.manual_redirect), (15_000, Some(4_000_000), false));
    for (status, length, body) in
        [(404, None, good), (200, Some("4000001"), good), (200, None, "<html>maintenance</html>")]
    {
        let answer = One(status, length, body, Default::default());
        assert_eq!(
            download_range_list(&answer, "https://openai.com/gptbot.json", 15_000).await,
            None,
            "{status} {body}"
        );
    }
}

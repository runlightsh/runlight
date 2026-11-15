//! The pure modules against the fixtures written from the TypeScript SDK:
//! user agents, sources, queries, payloads, time, place, URLs, CSV, and ZIP.

mod common;

use base64::Engine;
use common::{conformance, fixture, list, s};
use runlight::geo::{self, Found};
use runlight::http::{Headers, SearchParams, Url};
use runlight::js::{self, Value};
use runlight::{obj, payload, query, sources, time, ua, zip};

fn opt(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn hints(v: Option<&Value>) -> ua::ClientHints {
    let v = v.cloned().unwrap_or(Value::Null);
    ua::ClientHints { brands: opt(v.get("brands")), mobile: opt(v.get("mobile")), platform: opt(v.get("platform")) }
}

#[test]
fn user_agents_read_as_the_sdk_reads_them() {
    let mut failures = Vec::new();
    for case in list(&conformance("ua"), "cases") {
        let text = s(case, "ua");
        let agent = ua::ai_agent(text);
        if let Some(want) = case.get("agent") {
            if agent.map(|a| (a.name, a.kind)) != Some((s(want, "name"), s(want, "kind"))) {
                failures.push(format!("agent {text}"));
            }
            continue;
        }
        if agent.is_some() {
            failures.push(format!("not an agent: {text}"));
        }
        if ua::is_bot(text) != js::opt_truthy(case.get("bot")) {
            failures.push(format!("bot {text}"));
        }
        if let Some(client) = case.get("client") {
            let got =
                ua::parse_client(text, &hints(case.get("hints")), case.get("screenWidth").and_then(Value::as_f64));
            if got.to_value() != *client {
                failures.push(format!("{text}: {}", got.to_value().to_json()));
            }
        }
    }
    for case in list(&fixture("ua"), "cases") {
        let text = s(case, "ua");
        // As the SDK writes an agent: its list's address only when its company publishes one.
        let agent = ua::ai_agent(text).map(|a| {
            let mut o = obj! { "name" => a.name, "company" => a.company, "kind" => a.kind, "token" => a.token };
            if let (Some(url), Some(o)) = (a.ranges, o.as_object_mut()) {
                o.set("ranges", url);
            }
            o
        });
        let got = obj! {
            "agent" => agent,
            "bot" => ua::is_bot(text),
            "client" => ua::parse_client(text, &hints(case.get("hints")), case.get("screenWidth").and_then(Value::as_f64)).to_value(),
        };
        let want = obj! { "agent" => case.at("agent").clone(), "bot" => case.at("bot").clone(), "client" => case.at("client").clone() };
        if got != want {
            failures.push(format!("{text}: {} not {}", got.to_json(), want.to_json()));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

fn found(f: Option<sources::Found>) -> Value {
    f.map_or(Value::Null, |f| {
        let kind = match f.kind {
            runlight::data::sources::SourceKind::Search => "search",
            runlight::data::sources::SourceKind::Social => "social",
            runlight::data::sources::SourceKind::Ai => "ai",
            runlight::data::sources::SourceKind::Email => "email",
            runlight::data::sources::SourceKind::Other => "other",
        };
        obj! { "name" => f.name, "kind" => kind }
    })
}

fn name_and_kind(v: &Value) -> Value {
    if v.is_null() {
        Value::Null
    } else {
        obj! { "name" => v.at("name").clone(), "kind" => v.at("kind").clone() }
    }
}

fn page_value(p: &sources::Page) -> Value {
    obj! {
        "hostname" => p.hostname.clone(),
        "path" => p.path.clone(),
        "utm" => obj! {
            "source" => p.utm.source.clone(), "medium" => p.utm.medium.clone(), "campaign" => p.utm.campaign.clone(),
            "term" => p.utm.term.clone(), "content" => p.utm.content.clone(),
        },
        "ref" => p.ref_.clone(),
        "paid" => p.paid,
    }
}

#[test]
fn sources_and_channels_match_the_sdk() {
    let f = fixture("sources");
    let mut failures = Vec::new();
    for case in list(&f, "hosts") {
        if found(sources::source_for_host(s(case, "host"))) != name_and_kind(case.at("source")) {
            failures.push(format!("host {}", s(case, "host")));
        }
    }
    for case in list(&f, "aliases") {
        if found(sources::source_for_alias(s(case, "alias"))) != name_and_kind(case.at("source")) {
            failures.push(format!("alias {}", s(case, "alias")));
        }
    }
    for case in list(&f, "pages") {
        let page = sources::parse_page(&Url::parse(s(case, "url")).unwrap());
        if page_value(&page) != *case.at("page") {
            failures.push(format!("page {}: {}", s(case, "url"), page_value(&page).to_json()));
        }
    }
    for case in list(&f, "visits") {
        let page = sources::parse_page(&Url::parse(s(case, "url")).unwrap());
        let internal: Vec<String> = list(case, "internal").iter().map(js::js_string).collect();
        let a = sources::attribute(&page, s(case, "referrer"), &internal);
        let got = obj! { "referrerHost" => a.referrer_host, "referrerPath" => a.referrer_path, "source" => a.source, "channel" => a.channel };
        if got != *case.at("attribution") {
            failures.push(format!("visit {} from {}: {}", s(case, "url"), s(case, "referrer"), got.to_json()));
        }
    }
    for case in list(&f, "recordedPaths") {
        let got: Value = sources::recorded_path(s(case, "input")).into();
        if got != *case.at("path") {
            failures.push(format!("recorded {:?}: {}", s(case, "input"), got.to_json()));
        }
    }
    for case in list(&f, "readablePaths") {
        if sources::readable_path(s(case, "input")) != s(case, "path") {
            failures.push(format!("readable {:?}: {}", s(case, "input"), sources::readable_path(s(case, "input"))));
        }
    }
    for case in list(&f, "stripWww") {
        if sources::strip_www(s(case, "input")) != s(case, "host") {
            failures.push(format!("stripWww {}", s(case, "input")));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn queries_and_filters_match_the_sdk() {
    let f = fixture("query");
    let dims: Vec<Value> = query::dimensions().into_iter().map(Value::from).collect();
    assert_eq!(Value::Array(dims), *f.at("dimensions"));
    let map = |pairs: &[(&str, &str)]| {
        let mut o = js::Object::new();
        for (k, v) in pairs {
            o.set(*k, *v);
        }
        Value::Object(o)
    };
    assert_eq!(map(&query::EVENT_DIMENSIONS), *f.at("eventDimensions"));
    assert_eq!(map(&query::SESSION_DIMENSIONS), *f.at("sessionDimensions"));
    assert_eq!(f.at("maxFilters").as_f64(), Some(query::MAX_FILTERS as f64));
    for case in list(&f, "dimensionTests") {
        let v = s(case, "value");
        assert_eq!(Value::from(query::is_dimension(v)), *case.at("isDimension"), "{v}");
        assert_eq!(Value::from(query::is_session_dimension(v)), *case.at("isSessionDimension"), "{v}");
        assert_eq!(Value::from(query::is_event_dimension(v)), *case.at("isEventDimension"), "{v}");
    }
    for case in list(&f, "filters") {
        let got = query::parse_filter(s(case, "text")).map_or(Value::Null, |f| f.to_value());
        assert_eq!(got, *case.at("filter"), "{}", s(case, "text"));
    }
}

#[test]
fn payloads_match_the_sdk() {
    let f = fixture("payload");
    assert_eq!(f.at("maxBody").as_f64(), Some(payload::MAX_BODY as f64));
    let mut failures = Vec::new();
    for case in list(&f, "cases") {
        let got = payload::parse_payload(s(case, "text")).map_or(Value::Null, |p| {
            obj! {
                "kind" => p.kind, "site" => p.site, "url" => p.url.href(), "referrer" => p.referrer, "title" => p.title,
                "screenWidth" => p.screen_width, "screenHeight" => p.screen_height, "language" => p.language, "name" => p.name,
                "props" => p.props.map(|o| o.to_json()), "pageviewId" => p.pageview_id, "engagedMs" => p.engaged_ms, "scroll" => p.scroll,
            }
        });
        if got != *case.at("payload") {
            failures.push(format!("{}: {} not {}", s(case, "text"), got.to_json(), case.at("payload").to_json()));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

const SYSTEM_V_SUMMER: [&str; 6] =
    ["systemv/ast4adt", "systemv/est5edt", "systemv/cst6cdt", "systemv/mst7mdt", "systemv/pst8pdt", "systemv/yst9ydt"];

#[test]
fn zones_and_local_times_match_the_sdk() {
    let f = fixture("time");
    let mut failures = Vec::new();
    let samples: Vec<i64> = list(&f, "sampleTimes").iter().map(|v| v.as_f64().unwrap() as i64).collect();
    for zone in list(&f, "zones") {
        let name = s(zone, "name");
        let valid = time::is_timezone(name);
        if Value::from(valid) != *zone.at("valid") {
            failures.push(format!("{name} {}", if valid { "taken" } else { "refused" }));
            continue;
        }
        if !valid || SYSTEM_V_SUMMER.contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        for (i, ts) in samples.iter().enumerate() {
            if *ts < 0 {
                continue;
            }
            let (w, h) = time::local_weekday_hour(*ts, name);
            let local = format!("{} {w} {h}", time::local_date(*ts, name));
            if Some(local.as_str()) != zone.at("local").as_array().and_then(|a| a[i].as_str()) {
                failures.push(format!("{name} at {ts}: {local}"));
            }
        }
    }
    for case in list(&f, "instants") {
        let a = case.as_array().unwrap();
        let (zone, ts) = (a[0].as_str().unwrap(), a[1].as_f64().unwrap() as i64);
        let (w, h) = time::local_weekday_hour(ts, zone);
        let got = format!("{} {w} {h}", time::local_date(ts, zone));
        let want = format!("{} {} {}", a[2].as_str().unwrap(), a[3].as_f64().unwrap(), a[4].as_f64().unwrap());
        if got != want {
            failures.push(format!("{zone} {ts}: {got} not {want}"));
        }
    }
    for case in list(&f, "starts") {
        let a = case.as_array().unwrap();
        let got = time::start_of(a[1].as_str().unwrap(), a[0].as_str().unwrap(), a[2].as_f64().unwrap() as i64);
        if got as f64 != a[3].as_f64().unwrap() {
            failures.push(format!("{} start {}: {got}", a[0].as_str().unwrap(), a[1].to_json()));
        }
    }
    for case in list(&f, "dayStarts") {
        let a = case.as_array().unwrap();
        let (zone, year) = (a[0].as_str().unwrap(), a[1].as_f64().unwrap() as i64);
        let mut days = Vec::new();
        let mut d = format!("{year}-01-01");
        while d < format!("{}-01-01", year + 1) {
            days.push(Value::from(time::start_of(&d, zone, 0)));
            d = time::add_days(&d, 1);
        }
        if runlight::hash::sha256(&js::stringify(&Value::Array(days))) != a[2].as_str().unwrap() {
            failures.push(format!("{zone} {year}: every day's start"));
        }
    }
    // The fixture came from Node's ICU with time zone data 2025c. The system's database disagrees
    // wherever a zone's rules changed since (Morocco, British Columbia, Alberta, Manitoba, and Cuba), so those zones are
    // compared only on 2025c.
    if tzdata_version().as_deref() != Some("2025c") {
        failures.retain(|f| !CHANGED_SINCE_2025C.iter().any(|z| f.starts_with(z)));
    }
    let mut zones: Vec<&str> = failures.iter().map(|f| f.split(' ').next().unwrap()).collect();
    zones.dedup();
    eprintln!("zones that differ: {zones:?}");
    failures.truncate(40);
    assert!(failures.is_empty(), "{failures:#?}");
}

const CHANGED_SINCE_2025C: [&str; 15] = [
    "Africa/Casablanca",
    "Africa/El_Aaiun",
    "America/Vancouver",
    "America/Edmonton",
    "America/Inuvik",
    "America/Yellowknife",
    "America/Dawson_Creek",
    "America/Fort_Nelson",
    "Canada/Mountain",
    "Canada/Pacific",
    "America/Winnipeg",
    "America/Rainy_River",
    "Canada/Central",
    "America/Havana",
    "Cuba",
];

/// The system's time zone data version, where it says.
fn tzdata_version() -> Option<String> {
    for path in ["/usr/share/zoneinfo/+VERSION", "/usr/share/zoneinfo/tzdata.zi"] {
        if let Ok(text) = std::fs::read_to_string(path) {
            let line = text.lines().next().unwrap_or("");
            return Some(line.trim_start_matches("# version ").trim().to_string());
        }
    }
    None
}

#[test]
fn a_url_with_three_slashes_is_a_host() {
    let url = Url::parse_with_base("///triple", "https://x.invalid");
    assert_eq!(url.map(|u| u.href()), Some("https://triple/".to_string()));
}

fn range_value(r: &time::Range) -> Value {
    obj! { "from" => r.from, "to" => r.to, "fromDate" => r.from_date.clone(), "toDate" => r.to_date.clone(), "interval" => r.interval }
}

fn range_of(v: &Value) -> time::Range {
    let interval = time::INTERVALS.iter().find(|i| v.at("interval").as_str() == Some(**i)).copied().unwrap();
    time::Range {
        from: v.at("from").as_f64().unwrap() as i64,
        to: v.at("to").as_f64().unwrap() as i64,
        from_date: s(v, "fromDate").into(),
        to_date: s(v, "toDate").into(),
        interval,
    }
}

#[test]
fn dates_ranges_and_buckets_match_the_sdk() {
    let f = fixture("time");
    let mut failures = Vec::new();
    for case in list(&f, "dates") {
        let date = s(case, "date");
        if Value::from(time::is_date(date)) != *case.at("isDate") {
            failures.push(format!("isDate {date}"));
        }
        if !case.at("plus").is_null() {
            let plus: Vec<Value> = [-400, -366, -365, -31, -1, 0, 1, 28, 29, 31, 365, 366, 1000]
                .iter()
                .map(|n| time::add_days(date, *n).into())
                .collect();
            let months: Vec<Value> =
                [-25, -12, -11, -1, 0, 1, 11, 12, 13].iter().map(|n| time::add_months(date, *n).into()).collect();
            if Value::Array(plus) != *case.at("plus") || Value::Array(months) != *case.at("months") {
                failures.push(format!("date math {date}"));
            }
        }
    }
    for case in list(&f, "ranges") {
        let input = case.at("input");
        let get = |k: &str| match input.get(k) {
            Some(Value::String(s)) => Some(s.clone()),
            _ => None,
        };
        let ri =
            time::RangeInput { period: get("period"), from: get("from"), to: get("to"), interval: get("interval") };
        let zone = s(case, "zone");
        let now = case.at("now").as_f64().unwrap() as i64;
        let first = case.at("firstDate").as_str();
        let range = time::resolve_range(&ri, zone, now, first);
        let mut got = obj! { "range" => range.as_ref().map(range_value) };
        let mut want = obj! { "range" => case.at("range").clone() };
        if let Some(range) = &range {
            let buckets = time::buckets(range, zone);
            let bucket_values: Vec<Value> =
                buckets.iter().map(|b| obj! { "start" => b.start, "end" => b.end }).collect();
            got.as_object_mut().unwrap().set(
                "buckets",
                obj! {
                    "count" => buckets.len(),
                    "first" => bucket_values.first().cloned(),
                    "sha256" => runlight::hash::sha256(&js::stringify(&Value::Array(bucket_values.clone()))),
                },
            );
            want.as_object_mut().unwrap().set("buckets", case.at("buckets").clone());
            if case.get("compare").is_some() {
                let mut compare = js::Object::new();
                for mode in ["previous", "year", "off", "custom", "nope"] {
                    let c = time::compare_range(range, mode, zone, Some("2025-02-28"), Some("2025-03-31"));
                    compare.set(mode, c.as_ref().map(range_value));
                }
                got.as_object_mut().unwrap().set("compare", compare);
                want.as_object_mut().unwrap().set("compare", case.at("compare").clone());
            }
        }
        if got != want {
            failures.push(format!("{} {now} {}: {} not {}", zone, input.to_json(), got.to_json(), want.to_json()));
        }
    }
    for case in list(&f, "compares") {
        let range = range_of(case.at("range"));
        let custom = case.at("custom");
        let c = time::compare_range(
            &range,
            s(case, "mode"),
            s(case, "zone"),
            custom.get("from").and_then(Value::as_str),
            custom.get("to").and_then(Value::as_str),
        );
        let got = c.as_ref().map_or(Value::Null, range_value);
        if got != *case.at("compare") {
            failures.push(format!("compare {}: {}", case.to_json(), got.to_json()));
        }
    }
    failures.truncate(20);
    assert!(failures.is_empty(), "{failures:#?}");
}

fn location_value(l: &geo::Location) -> Value {
    obj! { "country" => l.country.clone(), "region" => l.region.clone(), "city" => l.city.clone() }
}

fn headers_of(v: &Value) -> Headers {
    Headers::from_pairs(v.as_object().unwrap().iter().map(|(k, v)| (k.to_string(), js::js_string(v))))
}

#[tokio::test]
async fn places_match_the_sdk() {
    let f = fixture("geo");
    for case in list(&f, "headers") {
        let got =
            geo::location_from_headers(&headers_of(case.at("headers"))).map_or(Value::Null, |l| location_value(&l));
        assert_eq!(got, *case.at("location"), "{}", case.at("headers").to_json());
    }
    for case in list(&f, "located") {
        let found = case.at("found").clone();
        let throws = js::opt_truthy(case.get("throws"));
        let lookup = geo::geo_fn(move |_| {
            if throws {
                return None;
            }
            found.as_object().map(|o| Found {
                country: o.get("country").map(js::js_string),
                region: o.get("region").map(js::js_string),
                city: o.get("city").map(js::js_string),
            })
        });
        let use_lookup = !js::opt_truthy(case.get("noLookup"));
        let got =
            geo::locate(&headers_of(case.at("headers")), s(case, "ip"), use_lookup.then_some(&lookup), true).await;
        assert_eq!(location_value(&got), *case.at("location"), "{}", case.to_json());
    }
    for db in list(&f, "databases") {
        let bytes = base64::engine::general_purpose::STANDARD.decode(s(db, "base64")).unwrap();
        let reader = runlight::mmdb::Mmdb::from_bytes(bytes.clone()).unwrap();
        assert_eq!(reader.metadata.at("ip_version"), db.at("ipVersion"));
        assert_eq!(reader.metadata.at("record_size"), db.at("recordSize"));
        for case in list(db, "records") {
            let record = reader.get(s(case, "ip")).unwrap().unwrap_or(Value::Null);
            assert_eq!(record.to_json(), case.at("record").to_json(), "{}", s(case, "ip"));
            let location = runlight::mmdb::found_in(&record).map_or(Value::Null, |f| {
                obj! { "country" => f.country, "region" => f.region, "city" => f.city }
            });
            assert_eq!(location, *case.at("location"), "{}", s(case, "ip"));
        }
        // The same database from a file, looked up as a visit is: read off the runtime's threads, to the same answer.
        let path = std::env::temp_dir().join(format!("runlight-test-{}.mmdb", runlight::hash::random_id(6)));
        std::fs::write(&path, &bytes).unwrap();
        let (in_file, in_memory) =
            (runlight::mmdb::Mmdb::open(&path).unwrap(), runlight::mmdb::Mmdb::from_bytes(bytes).unwrap());
        for case in list(db, "records") {
            use runlight::geo::GeoLookup;
            let found = in_file.lookup(s(case, "ip")).await.unwrap();
            assert_eq!(found, in_memory.lookup(s(case, "ip")).await.unwrap(), "{}", s(case, "ip"));
            let location =
                found.map_or(Value::Null, |f| obj! { "country" => f.country, "region" => f.region, "city" => f.city });
            assert_eq!(location, *case.at("location"), "{}", s(case, "ip"));
        }
        std::fs::remove_file(&path).unwrap();
    }
}

#[tokio::test]
async fn a_hosting_platforms_location_headers_count_only_when_proxy_headers_are_trusted() {
    let headers = Headers::from_pairs([("cf-ipcountry".to_string(), "FR".to_string())]);
    let lookup = geo::geo_fn(|_| {
        Some(Found { country: Some("CA".into()), region: Some("ON".into()), city: Some("Toronto".into()) })
    });
    let trusted = geo::locate(&headers, "203.0.113.5", Some(&lookup), true).await;
    assert_eq!(trusted.country, "FR");
    let ignored = geo::locate(&headers, "203.0.113.5", Some(&lookup), false).await;
    assert_eq!((ignored.country.as_str(), ignored.city.as_str()), ("CA", "Toronto"), "the lookup answers alone");
    let none = geo::locate(&headers, "203.0.113.5", None, false).await;
    assert_eq!(none.country, "");
}

#[test]
fn an_interval_too_fine_for_its_range_moves_up_instead_of_merging_the_tail() {
    let now = 1_791_288_000_000;
    let range = |from: &str, to: &str, interval: &str| {
        let input = time::RangeInput {
            from: Some(from.into()),
            to: Some(to.into()),
            interval: Some(interval.into()),
            ..time::RangeInput::default()
        };
        time::resolve_range(&input, "UTC", now, None)
    };
    // A month of hours fits, 40 days of them become days, and so on up.
    assert_eq!(range("2026-01-01", "2026-01-31", "hour").unwrap().interval, "hour");
    let days = range("2026-01-01", "2026-02-09", "hour").unwrap();
    assert_eq!(days.interval, "day");
    assert_eq!(time::buckets(&days, "UTC").len(), 40);
    assert_eq!(range("2026-01-01", "2026-03-01", "day").unwrap().interval, "day");
    assert_eq!(range("2020-01-01", "2026-01-01", "day").unwrap().interval, "week");
    assert_eq!(range("2005-01-01", "2026-12-31", "day").unwrap().interval, "month");
    assert!(
        range("1900-01-01", "2026-01-01", "month").is_none(),
        "1,513 months is past the limit, and no interval is coarser"
    );
    assert!(range("1950-01-01", "2026-01-01", "month").is_some(), "913 months fit");
    // Every bucket follows the interval's boundaries: only the first and last can be partial, none is swallowed.
    for (from, to, interval) in [
        ("2026-01-01", "2026-12-31", "hour"),
        ("2020-03-05", "2026-10-12", "hour"),
        ("2005-01-01", "2026-10-12", "day"),
    ] {
        let r = range(from, to, interval).unwrap();
        let list = time::buckets(&r, "UTC");
        assert_eq!(list.first().unwrap().start, r.from);
        assert_eq!(list.last().unwrap().end, r.to, "{from} {to}");
        for pair in list.windows(2) {
            assert_eq!(pair[0].end, pair[1].start);
        }
        let longest = match r.interval {
            "hour" => 3_600_000,
            "day" => 86_400_000,
            "week" => 7 * 86_400_000,
            _ => 31 * 86_400_000,
        };
        assert!(list.iter().all(|b| b.end - b.start <= longest), "{from} {to}: no bucket swallows the rest");
    }
    // A comparison range longer than the main one is cut off at a boundary, not merged into its last bucket.
    let long = time::Range {
        from: 1_577_836_800_000,
        to: 1_767_225_600_000,
        from_date: "2020-01-01".into(),
        to_date: "2025-12-31".into(),
        interval: "day",
    };
    let list = time::buckets(&long, "UTC");
    assert_eq!(list.len(), 1000);
    assert!(list.iter().all(|b| b.end - b.start == 86_400_000));
}

#[test]
fn urls_queries_and_numbers_read_as_javascript_reads_them() {
    let f = conformance("url");
    let mut failures = Vec::new();
    let mut check = |input: &str, base: Option<&str>, expect: &Value| {
        let url = match base {
            Some(b) => Url::parse_with_base(input, b),
            None => Url::parse(input),
        };
        let got = url.map_or(Value::Null, |u| {
            obj! {
                "href" => u.href(), "protocol" => u.protocol(), "username" => u.username(), "password" => u.password(),
                "hostname" => u.hostname(), "port" => u.port(), "host" => u.host(), "origin" => u.origin(),
                "pathname" => u.pathname(), "search" => u.search(), "hash" => u.hash(),
            }
        });
        if got != *expect {
            failures.push(format!("{input:?} {base:?}: {} not {}", got.to_json(), expect.to_json()));
        }
    };
    for case in list(&f, "urls") {
        check(s(case, "input"), None, case.at("expect"));
    }
    for case in list(&f, "relative") {
        check(s(case, "input"), Some(s(case, "base")), case.at("expect"));
    }
    for case in list(&f, "queries") {
        let p = SearchParams::parse(s(case, "input"));
        let pairs: Vec<Value> =
            p.pairs().iter().map(|(k, v)| Value::Array(vec![k.clone().into(), v.clone().into()])).collect();
        if Value::Array(pairs) != *case.at("pairs") || p.to_string() != s(case, "string") {
            failures.push(format!("query {}", s(case, "input")));
        }
    }
    for case in list(&f, "written") {
        let p = SearchParams::from_pairs(list(case, "pairs").iter().map(|pair| {
            let a = pair.as_array().unwrap();
            (js::js_string(&a[0]), js::js_string(&a[1]))
        }));
        if p.to_string() != s(case, "string") {
            failures.push(format!("written {}: {p}", s(case, "string")));
        }
    }
    for case in list(&f, "numbers") {
        let n = match case.at("n") {
            Value::String(t) => js::text_number(t),
            v => v.as_f64().unwrap(),
        };
        if js::format_number(n) != s(case, "text") {
            failures.push(format!("number {}", s(case, "text")));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

fn cell(v: &Value) -> String {
    if let Some(o) = v.as_object()
        && o.len() == 1
        && let Some(Value::String(j)) = o.get("js")
    {
        return match j.as_str() {
            "undefined" => String::new(),
            "-0" => "0".into(),
            other => other.into(),
        };
    }
    zip::cell(v)
}

#[test]
fn csv_and_zip_match_the_sdk() {
    let f = fixture("zip");
    for case in list(&f, "rows") {
        assert_eq!(zip::csv_row(&[cell(case.at("cell"))]), s(case, "row"), "{}", case.at("cell").to_json());
    }
    for case in list(&f, "csvs") {
        let header: Vec<String> = list(case, "header").iter().map(js::js_string).collect();
        let header: Vec<&str> = header.iter().map(String::as_str).collect();
        let rows: Vec<Vec<String>> =
            list(case, "rows").iter().map(|r| r.as_array().unwrap().iter().map(cell).collect()).collect();
        assert_eq!(zip::csv(&header, &rows), s(case, "csv"));
    }
    for case in list(&f, "zips") {
        let files: Vec<(String, String)> =
            list(case, "files").iter().map(|f| (s(f, "name").to_string(), s(f, "text").to_string())).collect();
        let got = zip::zip(&files, case.at("now").as_f64().unwrap() as i64);
        assert_eq!(base64::engine::general_purpose::STANDARD.encode(got), s(case, "base64"));
    }
}

#[test]
fn a_day_where_clocks_fall_back_across_midnight_begins_at_the_first_midnight() {
    // Amman in 2019, Gaza and Hebron in 2020, an hour each, and three hours at Casey station in 2019.
    for (date, zone) in [
        ("2019-10-25", "Asia/Amman"),
        ("2020-10-24", "Asia/Gaza"),
        ("2020-10-24", "Asia/Hebron"),
        ("2019-03-17", "Antarctica/Casey"),
    ] {
        let start = time::start_of(date, zone, 0);
        assert_eq!(time::local_date(start, zone), date, "{zone}");
        assert!(time::local_date(start - 1, zone).as_str() < date, "{zone}: the moment before is the day before");
    }
}

#[test]
fn a_csv_value_with_a_semicolon_or_a_tab_is_quoted_so_no_locale_splits_a_formula_out_of_it() {
    let row = ["x;=1+1", "a\tb", "=1+1", "plain"].map(String::from);
    assert_eq!(zip::csv_row(&row), "\"x;=1+1\",\"a\tb\",'=1+1,plain");
}

#[test]
fn only_the_start_of_a_user_agent_is_read() {
    let safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    // A bot's token, or an agent's, past character 512 is no longer seen.
    let padded = format!("{safari} {}", "x".repeat(512));
    assert!(!ua::is_bot(&format!("{padded} Googlebot/2.1")));
    assert!(ua::is_bot(&format!("{safari} Googlebot/2.1")));
    assert!(ua::ai_agent(&format!("{padded} GPTBot/1.2")).is_none());
    assert!(ua::ai_agent(&format!("{safari} GPTBot/1.2")).is_some());
    // A client hint is cut the same way.
    let hints = ua::ClientHints { brands: Some(format!("{}\"Brave\"", " ".repeat(512))), ..ua::ClientHints::default() };
    let chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
    assert_eq!(ua::parse_client(chrome, &hints, None).browser, "Chrome");
    // Safari's version, with any number of parts after it or none.
    for version in ["18", "18.1", "18.1.1", "18."] {
        let agent = format!(
            "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{version} Safari/605.1.15"
        );
        let client = ua::parse_client(&agent, &ua::ClientHints::default(), None);
        assert_eq!((client.browser.as_str(), client.browser_version.as_str()), ("Safari", "18"), "{version}");
    }
    let odd = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18x Safari/605.1.15";
    assert_eq!(ua::parse_client(odd, &ua::ClientHints::default(), None).browser, "Other");
}

#[test]
fn an_address_longer_than_any_real_one_is_no_email_address() {
    let long = format!("{}@example.com", "a".repeat(320 - "@example.com".len()));
    assert_eq!(long.len(), 320);
    assert!(runlight::runlight::is_email(&long));
    assert!(!runlight::runlight::is_email(&format!("a{long}")));
    assert!(!runlight::runlight::is_email(&format!("{}@example.com", "a".repeat(1_000_000))));
}

#[test]
fn an_imported_column_keeps_no_address_and_no_user_agent() {
    use runlight::importers::write::{browser, language_tag, named, place_name, screen_size, system};
    // A browser is a known name, else a name with a capital first letter, else nothing.
    assert_eq!(browser("chrome"), "Chrome");
    assert_eq!(browser(" arc "), "Arc");
    assert_eq!(browser("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"), "");
    assert_eq!(browser("203.0.113.7"), "");
    assert_eq!(browser("9front"), "", "a name does not start with a digit");
    assert_eq!(browser(&"a".repeat(41)), "");
    assert_eq!(browser(&"a".repeat(40)), format!("A{}", "a".repeat(39)));
    // A system the same, as it is written.
    assert_eq!(system("mac os"), "macOS");
    assert_eq!(system("haiku"), "haiku");
    assert_eq!(system("Windows NT 10.0; Win64; x64"), "");
    assert_eq!(named("Net 10.0.0.1"), "");
    assert_eq!(named("v1.2.3"), "v1.2.3", "three numbers are no address");
    assert_eq!(named("build 1.2.3.4.5"), "build 1.2.3.4.5", "nor are five");
    // A place is free text, unless it holds an address or reads as a user agent.
    assert_eq!(place_name("São Paulo"), "São Paulo");
    assert_eq!(place_name("10.0.0.1"), "");
    assert_eq!(place_name("near 10.0.0.1, probably"), "");
    assert_eq!(place_name("1.2.3.4.5"), "1.2.3.4.5");
    assert_eq!(place_name("2001:db8::1"), "");
    assert_eq!(place_name("FE80::1"), "");
    assert_eq!(place_name("Chrome/129"), "");
    assert_eq!(place_name("applewebkit"), "");
    assert_eq!(place_name("12:30"), "12:30", "one colon is no address");
    assert_eq!(screen_size(" 1440x900 "), "1440x900");
    assert_eq!(screen_size("1440 x 900"), "");
    assert_eq!(screen_size("123456x1"), "");
    assert_eq!(language_tag(" pt-BR "), "pt-BR");
    assert_eq!(language_tag("zh_Hant_TW"), "zh_Hant_TW");
    assert_eq!(language_tag("en-US,en;q=0.9"), "");
    assert_eq!(language_tag("e"), "");
}

#[test]
fn a_csv_rows_time_before_2000_is_no_time() {
    use runlight::importers::csvvisits::{CsvFormat, row_time};
    let at = |text: &str| row_time(&js::Object::new().with("time", text), CsvFormat::Runlight);
    assert_eq!(at("2000-01-01T00:00:00Z"), 946_684_800_000.0);
    assert!(at("1999-12-31T23:59:59Z").is_nan());
    // A date written as a bare number is a Unix time, in 1970.
    assert!(at("20240501").is_nan());
    assert_eq!(at("1714564800"), 1_714_564_800_000.0);
    assert!(at("").is_nan());
}

#[test]
fn an_icon_link_is_read_only_from_a_tag_of_a_few_thousand_characters() {
    use runlight::icon::icon_links;
    let base = "https://example.com";
    assert_eq!(icon_links(r#"<LINK rel="icon" href="/a.png">"#, base), ["https://example.com/a.png"]);
    let padded = |n: usize| format!(r#"<link rel="icon" {}href="/a.png">"#, " ".repeat(n));
    // 4,000 characters between the tag's name and its end, and no more.
    assert_eq!(icon_links(&padded(4000 - r#" rel="icon" href="/a.png""#.len()), base).len(), 1);
    assert!(icon_links(&padded(4000), base).is_empty());
    // A tag never holds another's start, so one left open reads up to the next and no further.
    assert_eq!(icon_links(r#"<link rel="icon" <link rel="icon" href="/b.png">"#, base), ["https://example.com/b.png"]);
    assert!(icon_links(&"<link ".repeat(50_000), base).is_empty());
}

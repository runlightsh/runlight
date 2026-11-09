//! Checks a request that names an AI agent against the addresses that agent's company publishes. Every
//! list is in the same shape, `{"prefixes": [{"ipv4Prefix": "a.b.c.d/n"} or {"ipv6Prefix": "x::/n"}]}`.
//!
//! The answer is "verified" when the address is in the list, "mismatch" when the company publishes a list
//! and the address is not in it, and "" when there is nothing to check against: no list for that agent,
//! or no usable address. The address is only compared, never kept.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use crate::data::agents::AiAgent;
use crate::http::{FetchInit, Fetcher};
use crate::js::{self, Value};

/// A list of more prefixes than this, or a reply bigger than [`MAX_LIST_BYTES`], is not a list we read.
pub const MAX_PREFIXES: usize = 20_000;
/// The most a downloaded list may weigh.
pub const MAX_LIST_BYTES: usize = 4_000_000;

/// An address as the check reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Address {
    /// An IPv4 address, as a number.
    V4(u32),
    /// An IPv6 address, as a number.
    V6(u128),
}

fn digits(text: &str, max: usize) -> bool {
    (1..=max).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
}

fn ipv4(text: &str) -> Option<u32> {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut n: u32 = 0;
    for part in parts {
        if !digits(part, 3) {
            return None;
        }
        let byte: u32 = part.parse().ok()?;
        if byte > 255 {
            return None;
        }
        n = (n << 8) | byte;
    }
    Some(n)
}

fn ipv6(text: &str) -> Option<u128> {
    if text.is_empty()
        || !text.bytes().all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
        || text.split("::").count() > 2
    {
        return None;
    }
    // A dotted IPv4 tail ("::ffff:1.2.3.4") stands for the last two groups.
    let mut groups = text.to_string();
    if text.contains('.') {
        let dot = text.rfind(':').map_or(0, |i| i + 1);
        let tail = ipv4(&text[dot..])?;
        groups = format!("{}{:x}:{:x}", &text[..dot], tail >> 16, tail & 0xffff);
    }
    let mut halves = groups.split("::");
    let head = halves.next().unwrap_or("");
    let rest = halves.next();
    let left: Vec<&str> = if head.is_empty() { Vec::new() } else { head.split(':').collect() };
    let right: Vec<&str> = match rest {
        None | Some("") => Vec::new(),
        Some(r) => r.split(':').collect(),
    };
    let missing = 8 - left.len() as i64 - right.len() as i64;
    if if rest.is_none() { missing != 0 } else { missing < 1 } {
        return None;
    }
    let fill = if rest.is_none() { 0 } else { missing as usize };
    let mut n: u128 = 0;
    for group in left.iter().copied().chain(std::iter::repeat_n("0", fill)).chain(right.iter().copied()) {
        if !(1..=4).contains(&group.len()) || !group.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        n = (n << 16) | u128::from(u16::from_str_radix(group, 16).ok()?);
    }
    Some(n)
}

/// An address as the check reads it: surrounding space, [brackets], and an IPv6 zone ("%eth0") are
/// ignored, and an IPv4 address written as IPv6 (::ffff:1.2.3.4) is read as IPv4. None when it is not one.
pub fn parse_address(text: &str) -> Option<Address> {
    let mut s = js::trim(text);
    if s.starts_with('[') && s.ends_with(']') && s.len() >= 2 {
        s = &s[1..s.len() - 1];
    }
    if let Some(zone) = s.find('%') {
        s = &s[..zone];
    }
    if s.is_empty() {
        return None;
    }
    if !s.contains(':') {
        return ipv4(s).map(Address::V4);
    }
    let n = ipv6(s)?;
    if n >> 32 == 0xffff {
        return Some(Address::V4((n & 0xffff_ffff) as u32));
    }
    Some(Address::V6(n))
}

/// A prefix such as 20.171.206.0/24 or 2600:1f28::/56.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Prefix {
    v6: bool,
    base: u128,
    bits: u32,
}

/// A prefix, or None. Bits past the length are ignored.
fn parse_prefix(text: &str) -> Option<Prefix> {
    let slash = text.find('/')?;
    let bits_text = &text[slash + 1..];
    if !digits(bits_text, 3) {
        return None;
    }
    let bits: u32 = bits_text.parse().ok()?;
    let head = &text[..slash];
    if head.contains(':') {
        let n = ipv6(head)?;
        return (bits <= 128).then_some(Prefix { v6: true, base: n, bits });
    }
    let n = ipv4(head)?;
    (bits <= 32).then_some(Prefix { v6: false, base: u128::from(n), bits })
}

fn covers(prefix: &Prefix, address: Address) -> bool {
    let (v6, n) = match address {
        Address::V4(n) => (false, u128::from(n)),
        Address::V6(n) => (true, n),
    };
    if prefix.v6 != v6 {
        return false;
    }
    let width = if v6 { 128 } else { 32 };
    let shift = width - prefix.bits;
    n.checked_shr(shift).unwrap_or(0) == prefix.base.checked_shr(shift).unwrap_or(0)
}

/// The prefixes in a published list, or None when the reply is not a list in the expected shape (not an
/// object, no prefixes, an entry that is not a prefix, or too many). One bad entry rejects the whole list,
/// so a half broken download never replaces a good copy.
pub fn read_range_list(body: &Value) -> Option<Vec<String>> {
    let Value::Object(o) = body else { return None };
    let Some(Value::Array(prefixes)) = o.get("prefixes") else { return None };
    if prefixes.is_empty() || prefixes.len() > MAX_PREFIXES {
        return None;
    }
    let mut out = Vec::with_capacity(prefixes.len());
    for entry in prefixes {
        let Value::Object(entry) = entry else { return None };
        let v4 = entry.get("ipv4Prefix").and_then(Value::as_str);
        let text = v4.or_else(|| entry.get("ipv6Prefix").and_then(Value::as_str))?;
        let text = js::trim(text);
        let prefix = parse_prefix(text)?;
        if v4.is_some() == prefix.v6 {
            return None;
        }
        out.push(text.to_string());
    }
    Some(out)
}

/// A list of prefixes as stored, `["a.b.c.d/n", "x::/n"]`, read as a published list is: None when any
/// entry is not a prefix of the family it looks like.
pub fn read_stored_list(list: &Value) -> Option<Vec<String>> {
    let Value::Array(items) = list else { return None };
    let mut prefixes = Vec::with_capacity(items.len());
    for p in items {
        let key = if js::js_string(p).contains(':') { "ipv6Prefix" } else { "ipv4Prefix" };
        prefixes.push(Value::Object(js::Object::new().with(key, p.clone())));
    }
    read_range_list(&Value::Object(js::Object::new().with("prefixes", Value::Array(prefixes))))
}

/// Downloads one published list. None when it cannot be fetched or read; the caller keeps what it had.
pub async fn download_range_list(fetcher: &dyn Fetcher, url: &str, timeout_ms: u64) -> Option<Vec<String>> {
    let init = FetchInit::default()
        .header("accept", "application/json")
        .header("user-agent", "Runlight (+https://runlight.sh)")
        .timeout(timeout_ms)
        .max_bytes(MAX_LIST_BYTES);
    let response = fetcher.fetch(url, init).await.ok()?;
    if !(200..300).contains(&response.status) {
        return None;
    }
    let length = response.headers.get("content-length").map_or(0.0, |l| js::text_number(&l));
    if length > MAX_LIST_BYTES as f64 || response.body.len() > MAX_LIST_BYTES {
        return None;
    }
    let text = String::from_utf8_lossy(&response.body);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    read_range_list(&js::parse(text).ok()?)
}

/// One company's list: its prefixes as published, and read once for checking.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RangeList {
    prefixes: Vec<String>,
    parsed: Vec<Prefix>,
}

impl RangeList {
    /// A list of prefixes such as "20.171.206.0/24"; any that is not one is left out of the check.
    pub fn new(prefixes: Vec<String>) -> RangeList {
        let parsed = prefixes.iter().filter_map(|p| parse_prefix(p)).collect();
        RangeList { prefixes, parsed }
    }

    /// The prefixes, as given.
    pub fn prefixes(&self) -> &[String] {
        &self.prefixes
    }
}

/// The lists in use, by the address each is published at.
pub type RangeLists = HashMap<String, Arc<RangeList>>;

/// Whether `ip` is inside any of the prefixes. False for an address that cannot be read.
pub fn in_ranges(ip: &str, list: &RangeList) -> bool {
    parse_address(ip).is_some_and(|address| list.parsed.iter().any(|p| covers(p, address)))
}

/// The check for one request that names `agent`, made from `ip`: "verified", "mismatch", or "".
pub fn check_agent(agent: &AiAgent, ip: &str, lists: &RangeLists) -> &'static str {
    let Some(list) = agent.ranges.and_then(|url| lists.get(url)) else { return "" };
    if parse_address(ip).is_none() {
        return "";
    }
    if in_ranges(ip, list) { "verified" } else { "mismatch" }
}

/// The lists that came with this version (assets/agent-ranges.json).
pub struct BundledRanges {
    /// The day they were downloaded, YYYY-MM-DD.
    pub fetched_at: String,
    /// Their addresses, in the file's order, as the scheduled check downloads them.
    pub urls: Vec<String>,
    /// The lists.
    pub lists: Arc<RangeLists>,
}

/// The lists that came with this version.
pub static AGENT_RANGES: LazyLock<BundledRanges> = LazyLock::new(|| {
    let v = js::parse(crate::assets::AGENT_RANGES_JSON).expect("assets/agent-ranges.json is JSON");
    let mut urls = Vec::new();
    let mut lists = RangeLists::new();
    if let Some(o) = v.get("lists").and_then(Value::as_object) {
        for (url, list) in o.iter() {
            let prefixes = list.as_array().map(|a| a.iter().map(js::js_string).collect()).unwrap_or_default();
            urls.push(url.to_string());
            lists.insert(url.to_string(), Arc::new(RangeList::new(prefixes)));
        }
    }
    BundledRanges { fetched_at: js::str_or_empty(v.get("fetchedAt")), urls, lists: Arc::new(lists) }
});

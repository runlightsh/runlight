//! The routes' ties to mail, reports, the assistant, MCP, icons, translations, and fetching from the
//! public internet.

use super::parts::R;
use super::*;
use crate::assistant::{AssistantFailure, ChatContext, ChatMessage, ChatSite, PROVIDERS, chat, list_models};
use crate::error::Error;
use crate::mail::transports::{Message, SERVICES};
use crate::mcp::ApiRead;
use crate::store::{ReportRow, SiteRow};
use crate::time::local_date;

/// The languages the dashboard speaks, English first.
pub(crate) fn languages() -> Vec<String> {
    crate::messages::languages()
}

/// A translator for a language: `t(key, vars)`, and the language used.
#[allow(clippy::type_complexity)]
pub(crate) fn translator(lang: &str) -> (impl Fn(&str, &[(&str, &str)]) -> String + use<>, String) {
    let words = crate::messages::translator(lang);
    let code = words.lang.clone();
    let t = move |key: &str, vars: &[(&str, &str)]| {
        let vars: Vec<(&str, Value)> = vars.iter().map(|(k, v)| (*k, Value::from(*v))).collect();
        words.t(key, &vars)
    };
    (t, code)
}

/// Reads the HTTP API with a caller's own headers, so a tool sees what they may.
pub(crate) struct ApiReader {
    pub(crate) routes: Routes,
    pub(crate) origin: String,
    pub(crate) headers: Headers,
    /// The site a read that names none reads, for the assistant; `None` for MCP.
    pub(crate) site: Option<String>,
}

impl ApiReader {
    pub(crate) fn new(routes: &Routes, request: &Request, url: &Url, site: Option<String>) -> ApiReader {
        let mut headers = request.headers.clone();
        for name in ["content-type", "content-length", SHARE_HEADER, EMBED_HEADER] {
            headers.delete(name);
        }
        ApiReader { routes: routes.clone(), origin: url.origin(), headers, site }
    }
}

impl ApiRead for ApiReader {
    fn read<'a>(
        &'a self,
        path: &'a str,
        params: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<Response, crate::BoxError>> {
        Box::pin(async move {
            let base = &self.routes.0.base;
            let mut target =
                Url::parse_with_base(&format!("{base}{path}"), &self.origin).ok_or("TypeError: Invalid URL")?;
            let mut query = target.search_params();
            for (k, v) in params {
                query.append(k, v);
            }
            // A tool that names no site reads the one on screen, not the install's first.
            if let Some(site) = &self.site
                && path != "/api/sites"
                && !query.has("site")
            {
                query.set("site", site);
            }
            target.set_search_params(&query);
            let request = Request {
                url: target.href(),
                method: "GET".into(),
                headers: self.headers.clone(),
                body: Vec::new(),
                remote_address: String::new(),
            };
            let call = Call::default();
            self.routes.api(&request, path, &mut target, &call).await.map_err(|e| Box::new(e) as crate::BoxError)
        })
    }
}

pub(crate) async fn mcp_response(routes: &Routes, request: &Request, url: &Url) -> R {
    let reader = ApiReader::new(routes, request, url, None);
    crate::mcp::mcp_response(request, &reader).await.map_err(|e| Error::Other(e.to_string()))
}

pub(crate) async fn resolves_privately(_rl: &Runlight, domain: &str) -> bool {
    crate::safefetch::resolves_privately(domain, None).await
}

pub(crate) async fn public_addresses(_rl: &Runlight, name: &str) -> Vec<String> {
    crate::safefetch::public_addresses(name, None).await
}

/// A public fetch of no more than `max_bytes` of the answer (the start of a longer one), or whether it timed out.
pub(crate) async fn public_fetch(rl: &Runlight, url: &str, ms: u64, max_bytes: usize) -> Result<Response, bool> {
    let mut init = crate::safefetch::PublicFetchInit::new(ms);
    init.max_bytes = Some(max_bytes);
    init.truncate = true;
    match crate::safefetch::public_fetch(&**rl.fetcher(), url, &init).await {
        Ok(r) => Ok(r),
        Err(crate::safefetch::PublicFetchError::Fetch(crate::http::FetchError::TimedOut)) => Err(true),
        Err(_) => Err(false),
    }
}

pub(crate) async fn fetch_icon(rl: &Runlight, url: &str) -> Option<(Vec<u8>, String)> {
    crate::icon::fetch_icon(&**rl.fetcher(), url, rl.now()).await.map(|i| (i.body, i.content_type))
}

/// GET /api/mail: which service sends the reports, never its keys.
pub(crate) async fn mail_view(rl: &Runlight, managed: bool) -> Result<Value, Error> {
    let settings = rl.mail_settings().await?;
    let config = settings.as_ref().map(|s| &s.0);
    let app_in_use = settings.as_ref().is_some_and(|s| s.1 == "app");
    let service = SERVICES
        .iter()
        .find(|s| !app_in_use && config.and_then(|c| c.get("service")).and_then(Value::as_str) == Some(s.id));
    // Secret fields come back only as "saved", never as their value.
    let mut fields = js::Object::new();
    let mut saved = Vec::new();
    for f in service.map_or(&[][..], |s| s.fields) {
        let value = config.and_then(|c| c.get(f.name));
        if f.secret {
            if value.is_some_and(js::truthy) {
                saved.push(Value::from(f.name));
            }
        } else {
            fields.set(f.name, js::str_or_empty(value));
        }
    }
    let get = |k: &str| config.and_then(|c| c.get(k)).cloned();
    let mut view = obj! {
        "source" => settings.as_ref().map(|s| s.1),
        "service" => if app_in_use { Value::from("") } else { get("service").unwrap_or_else(|| Value::from("")) },
        "from" => get("from").unwrap_or_else(|| Value::from("")),
        "fromName" => get("fromName").unwrap_or_else(|| Value::from("")),
        "fields" => if managed { Value::Object(js::Object::new()) } else { Value::Object(fields) },
        "saved" => if managed { Value::Array(vec![]) } else { Value::Array(saved) },
        "encrypted" => rl.secret().is_some(),
        "services" => Value::Array(rl.mail_services().iter().map(|s| s.to_value()).collect()),
    };
    // The app's own mailer, named only when there is one, so the answer without it stays as it was.
    if let (Some(app), Value::Object(o)) = (rl.app_mailer(), &mut view) {
        o.set(
            "app",
            obj! {
                "via" => app.via.as_str(),
                "from" => app.from.as_str(),
                "fromName" => app.from_name.as_deref().unwrap_or(""),
                "replaced" => !app_in_use,
            },
        );
    }
    Ok(view)
}

pub(crate) async fn save_mail_settings(rl: &Runlight, input: Option<&Value>) -> Result<(), Error> {
    rl.save_mail_settings(input).await
}

/// Sends one email through the mail service.
#[allow(dead_code)]
pub(crate) async fn send_mail(rl: &Runlight, message: Message) -> Result<(), Error> {
    rl.send_mail(message).await
}

pub(crate) async fn send_test_mail(rl: &Runlight, to: &str, lang: &str) -> R {
    let Some((settings, source)) = rl.mail_settings().await? else {
        return Ok(coded("Set up a mail service first", "mail_unset", 400, None));
    };
    let (t, _) = translator(lang);
    let id = settings.get("service").and_then(Value::as_str).unwrap_or("");
    let name = if source == "app" {
        js::str_or_empty(settings.get("via"))
    } else {
        SERVICES.iter().find(|s| s.id == id).map_or("", |s| s.name).to_string()
    };
    let body = t("email.test.body", &[("service", &name)]);
    rl.send_mail(Message {
        to: to.to_string(),
        subject: t("email.test.subject", &[]),
        text: body.clone(),
        html: format!("<p style=\"font-family:sans-serif;font-size:15px\">{}</p>", escape_html(&body)),
        ..Message::default()
    })
    .await?;
    Ok(json(&obj! { "ok" => true }, 200, &[]))
}

/// The last period's key and when it is due.
pub(crate) fn last_period(frequency: &str, now: i64, timezone: &str) -> (String, i64) {
    let p = crate::reports::last_period(frequency, now, timezone);
    (p.key, p.due_at)
}

pub(crate) async fn deliver_report(rl: &Runlight, report: &ReportRow, site: &SiteRow) -> Result<(), Error> {
    rl.deliver_report(report, site, None).await
}

/// How many questions each viewer may ask the assistant a day, as an owner set it.
async fn viewer_daily(rl: &Runlight) -> Result<f64, Error> {
    Ok(match rl.store().setting("assistant-viewer-daily").await? {
        None => 50.0,
        Some(s) => js::text_number(&s),
    })
}

/// Counts a question to the assistant, or refuses it: past thirty an hour or two at once for anyone,
/// and past the owner's daily number for a viewer. Gives the refusal, or the turn to go ahead with.
async fn ask_turn<'a>(routes: &'a Routes, who: &str, owner: bool) -> Result<Result<Asking<'a>, Response>, Error> {
    let rl = routes.rl();
    let now = rl.now();
    let soon =
        || coded("You have asked a lot in a short time. Wait a little and ask again.", "assistant_soon", 429, None);
    // The slot is taken in the same step as the check, before anything is awaited, so questions sent at once each see the others.
    {
        let mut asked = routes.0.asked.lock().unwrap_or_else(|e| e.into_inner());
        let mine = asked.entry(who.to_string()).or_default();
        mine.0.retain(|at| now - at < 3_600_000);
        if mine.0.len() >= 30 || mine.1 >= 2 {
            return Ok(Err(soon()));
        }
        mine.0.push(now);
        mine.1 += 1;
        // People who stopped asking are dropped, so the map holds only the last hour's.
        if asked.len() > 1000 {
            asked.retain(|_, v| v.1 > 0 || v.0.iter().any(|at| now - at < 3_600_000));
        }
    }
    let asking = Asking { routes, who: who.to_string() };
    if !owner {
        match count_ask(rl, who, now).await? {
            Counted::Yes => {}
            refused => {
                // A refused question does not count toward the hour's thirty.
                if let Some(mine) = routes.0.asked.lock().unwrap_or_else(|e| e.into_inner()).get_mut(who)
                    && let Some(at) = mine.0.iter().position(|at| *at == now)
                {
                    mine.0.remove(at);
                }
                return Ok(Err(match refused {
                    Counted::Soon => soon(),
                    Counted::Limit(limit) => {
                        let l = js::format_number(limit);
                        coded(
                            &format!("Viewers can ask {l} questions a day. Ask again tomorrow."),
                            "assistant_daily",
                            429,
                            Some(&[("limit", &l)]),
                        )
                    }
                    Counted::Yes => unreachable!(),
                }));
            }
        }
    }
    Ok(Ok(asking))
}

enum Counted {
    Yes,
    Limit(f64),
    Soon,
}

/// Counts a viewer's question in their own row for the day, or answers the daily limit when it is reached.
/// The row only ever moves from the count read to the next one, so of questions sent at once, by one viewer
/// or by every process on the database, each count is taken once.
async fn count_ask(rl: &Runlight, who: &str, now: i64) -> Result<Counted, Error> {
    let limit = viewer_daily(rl).await?;
    if limit < 1.0 {
        return Ok(Counted::Limit(limit));
    }
    let day = format!("assistant-asked:{}:", js::head16(&js::iso_string(now), 10));
    let key = format!("{day}{who}");
    for _ in 0..20 {
        let Some(seen) = rl.store().setting(&key).await? else {
            if !rl.store().add_setting(&key, "1").await? {
                continue;
            }
            // A viewer's first question of the day clears the days before.
            for (old, _) in rl.store().settings_starting_with("assistant-asked:").await? {
                if !old.starts_with(&day) {
                    rl.store().set_setting(&old, None).await?;
                }
            }
            return Ok(Counted::Yes);
        };
        let n = js::text_number(&seen);
        if n >= limit {
            return Ok(Counted::Limit(limit));
        }
        if rl.store().swap_setting(&key, &seen, &js::format_number(n + 1.0)).await? {
            return Ok(Counted::Yes);
        }
    }
    Ok(Counted::Soon)
}

/// A question being answered. Let go of, however the answer ends (a request cancelled part way too), it
/// stops counting against the asker's two at once.
struct Asking<'a> {
    routes: &'a Routes,
    who: String,
}

impl Drop for Asking<'_> {
    fn drop(&mut self) {
        if let Some(mine) = self.routes.0.asked.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&self.who) {
            mine.1 -= 1;
        }
    }
}

fn assistant_refused(failure: AssistantFailure, status: u16) -> R {
    match failure {
        AssistantFailure::Coded(e) => Ok(refused(&e, status)),
        AssistantFailure::Thrown(m) => Err(Error::Other(m)),
    }
}

/// The assistant: an owner sets it up; anyone signed in to the dashboard can ask it. `None` for a path
/// it does not answer.
pub(crate) async fn assistant_api(
    routes: &Routes,
    request: &Request,
    path: &str,
    url: &Url,
    call: &Call,
) -> Result<Option<Response>, Error> {
    let rl = routes.rl();
    let method = request.method.as_str();
    if path == "/api/assistant" {
        let me = routes.can_read(request, call).await;
        // A member uses the assistant like anyone else, but its settings are for owners and admins.
        let owner = me == CanRead::Yes && !call.is_member();
        if method == "GET" {
            let reader = routes.reader(request, call).await?;
            match &reader {
                Reader::No | Reader::Unconfigured => return Ok(Some(routes.denied_reader(&reader))),
                // Only people at the dashboard, never an API token or a share.
                Reader::Token(t) if !t.id.is_empty() => {
                    return Ok(Some(coded(
                        "Only the dashboard can use the assistant",
                        "assistant_dashboard",
                        403,
                        None,
                    )));
                }
                _ => {}
            }
            rl.init().await?;
            let settings = rl.assistant_settings().await?;
            if !owner {
                return Ok(Some(json(&obj! { "configured" => settings.is_some() }, 200, &[])));
            }
            let s = settings.clone().unwrap_or_default();
            return Ok(Some(json(
                &obj! {
                    "configured" => settings.is_some(),
                    "viewerDaily" => viewer_daily(rl).await?,
                    "provider" => s.provider,
                    "model" => s.model,
                    "baseUrl" => s.base_url,
                    "keySaved" => !s.key.is_empty(),
                    "encrypted" => rl.secret().is_some(),
                    "providers" => Value::Array(PROVIDERS.iter().map(|p| p.to_value()).collect()),
                },
                200,
                &[],
            )));
        }
        if !owner {
            return Ok(Some(if me == CanRead::Yes {
                coded("Only an owner or admin can change this", "admin_only", 403, None)
            } else {
                routes.denied(me)
            }));
        }
        rl.init().await?;
        if method == "DELETE" {
            rl.save_assistant_settings(None).await?;
            return Ok(Some(json(&obj! { "ok" => true }, 200, &[])));
        }
        if method == "PUT" {
            let body = match read_json(request) {
                Ok(b) => Value::Object(b),
                Err(r) => return Ok(Some(r)),
            };
            return Ok(Some(match rl.save_assistant_settings(Some(&body)).await {
                Ok(()) => json(&obj! { "ok" => true }, 200, &[]),
                Err(Error::Settings(e)) => refused(&e, 400),
                Err(e) => return Err(e),
            }));
        }
        return Ok(Some(coded("Method not allowed", "method_not_allowed", 405, None)));
    }
    // How many questions each viewer may ask a day; 0 keeps the assistant for owners.
    if path == "/api/assistant/limits" && method == "PUT" {
        let access = routes.can_read(request, call).await;
        if access != CanRead::Yes {
            return Ok(Some(routes.denied(access)));
        }
        rl.init().await?;
        let body = match read_json(request) {
            Ok(b) => Value::Object(b),
            Err(r) => return Ok(Some(r)),
        };
        let daily = js::opt_number(body.get("viewerDaily"));
        if !js::is_integer(daily) || !(0.0..=1000.0).contains(&daily) {
            return Ok(Some(coded("Use a whole number from 0 to 1,000", "assistant_limit", 400, None)));
        }
        rl.store().set_setting("assistant-viewer-daily", Some(&js::format_number(daily))).await?;
        return Ok(Some(json(&obj! { "viewerDaily" => daily }, 200, &[])));
    }
    // The models a service offers, for the setup form's dropdown. The key can be the one already saved.
    if path == "/api/assistant/models" && method == "POST" {
        let access = routes.can_read(request, call).await;
        if access != CanRead::Yes {
            return Ok(Some(routes.denied(access)));
        }
        rl.init().await?;
        let body = match read_json(request) {
            Ok(b) => Value::Object(b),
            Err(r) => return Ok(Some(r)),
        };
        let provider = js::str_or_empty(body.get("provider"));
        let saved = rl.assistant_settings().await?;
        let base_url = js::trim(&js::str_or_empty(body.get("baseUrl"))).trim_end_matches('/').to_string();
        // The saved key only for the address it was saved with.
        let same = saved.as_ref().is_some_and(|s| s.provider == provider && s.base_url == base_url);
        let given = js::trim(&js::str_or_empty(body.get("key"))).to_string();
        let key = if !given.is_empty() {
            given
        } else if same {
            saved.map(|s| s.key).unwrap_or_default()
        } else {
            String::new()
        };
        let settings = crate::assistant::AssistantSettings {
            provider,
            model: String::new(),
            base_url: js::trim(&js::str_or_empty(body.get("baseUrl"))).to_string(),
            key,
        };
        return Ok(Some(match list_models(&settings, rl.fetcher()).await {
            Ok(models) => {
                json(&obj! { "models" => Value::Array(models.iter().map(|m| m.to_value()).collect()) }, 200, &[])
            }
            Err(f) => assistant_refused(f, 400)?,
        }));
    }
    if path == "/api/assistant/chat" && method == "POST" {
        let reader = routes.reader(request, call).await?;
        match &reader {
            Reader::No | Reader::Unconfigured => return Ok(Some(routes.denied_reader(&reader))),
            Reader::Token(t) if !t.id.is_empty() => {
                return Ok(Some(coded("Only the dashboard can use the assistant", "assistant_dashboard", 403, None)));
            }
            _ => {}
        }
        if request.headers.get(SHARE_HEADER).is_some() {
            return Ok(Some(coded("Not available on a shared dashboard", "share_not_available", 403, None)));
        }
        rl.init().await?;
        let Some(settings) = rl.assistant_settings().await? else {
            return Ok(Some(coded(
                "The assistant is not set up yet. An owner can set it up in Settings, AI Assistant.",
                "assistant_unset",
                400,
                None,
            )));
        };
        let body = match read_json(request) {
            Ok(b) => Value::Object(b),
            Err(r) => return Ok(Some(r)),
        };
        let wanted = js::str_or_empty(body.get("site"));
        let Some(site) = rl.site(if wanted.is_empty() { None } else { Some(&wanted) }) else {
            return Ok(Some(coded("Unknown site", "unknown_site", 404, None)));
        };
        let messages: Vec<ChatMessage> = body
            .get("messages")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter(|m| {
                        let role = m.get("role").and_then(Value::as_str);
                        (role == Some("user") || role == Some("assistant"))
                            && m.get("content").is_some_and(Value::is_string)
                    })
                    .map(|m| ChatMessage {
                        role: js::str_or_empty(m.get("role")),
                        content: js::str_or_empty(m.get("content")),
                    })
                    .collect()
            })
            .unwrap_or_default();
        if messages.last().is_none_or(|m| m.role != "user") {
            return Ok(Some(coded("Ask a question", "question_needed", 400, None)));
        }
        let owner = reader == Reader::Owner;
        // Each signed-in account counts on its own; without accounts, the owner and the viewers.
        let who = match glue::account_of(routes, request).await? {
            Some(account) => account,
            None => (if owner { "owner" } else { "viewer" }).to_string(),
        };
        let who = who.as_str();
        let asking = match ask_turn(routes, who, owner).await? {
            Ok(asking) => asking,
            Err(refusal) => return Ok(Some(refusal)),
        };
        let reader = ApiReader::new(routes, request, url, Some(site.id.clone()));
        let language = body.get("language").map_or_else(|| "undefined".to_string(), js::js_string);
        let context = ChatContext {
            site: ChatSite { id: site.id.clone(), name: site.name.clone(), timezone: site.timezone.clone() },
            today: local_date(rl.now(), &site.timezone),
            view: js::head16(
                &body
                    .get("view")
                    .filter(|v| !v.is_null())
                    .map_or_else(|| "the last 30 days".to_string(), js::js_string),
                200,
            ),
            language: if language.len() == 2 && language.bytes().all(|b| b.is_ascii_lowercase()) {
                language
            } else {
                "en".into()
            },
        };
        let clock = || rl.now();
        let answer = chat(&settings, &messages, &context, &reader, rl.fetcher(), &clock, None).await;
        drop(asking);
        return Ok(Some(match answer {
            Ok(a) => json(&a.to_value(), 200, &[]),
            Err(f) => assistant_refused(f, 502)?,
        }));
    }
    Ok(None)
}

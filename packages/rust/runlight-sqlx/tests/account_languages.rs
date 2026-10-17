//! The account and OAuth pages in the visitor's language, as account-languages.test.ts tests them.

#![cfg(feature = "sqlite")]

use runlight::http::{Request, Response, SearchParams};
use runlight::{Routes, RoutesOptions, Runlight, RunlightOptions, SiteOptions, TokenOption, obj};

const FRENCH: (&str, &str) = ("accept-language", "fr-FR,fr;q=0.9,en;q=0.8");

fn req(path: &str) -> Request {
    Request::get(format!("https://example.com{path}"))
}

fn form(path: &str, fields: &[(&str, &str)], headers: &[(&str, &str)]) -> Request {
    let mut request = Request::new("POST", format!("https://example.com{path}"))
        .header("content-type", "application/x-www-form-urlencoded")
        .body(SearchParams::from_pairs(fields.iter().copied()).to_string());
    for (name, value) in headers {
        request = request.header(name, value);
    }
    request
}

async fn text(routes: &Routes, request: Request) -> String {
    String::from_utf8(routes.handle(request).await.body).unwrap()
}

fn cookie_of(response: &Response) -> String {
    response.headers.get_set_cookie().first().map(|c| c.split(';').next().unwrap().to_string()).unwrap_or_default()
}

async fn accounts_routes() -> Routes {
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    options.secret = Some("k".repeat(64));
    Runlight::new(options)
        .unwrap()
        .routes(RoutesOptions {
            token: TokenOption::Given("app-token".into()),
            accounts: true,
            ..RoutesOptions::default()
        })
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_account_routes_answer_in_the_browsers_language_and_in_english_as_before_without_one() {
    let routes = accounts_routes().await;
    let setup = text(&routes, req("/runlight/setup").header(FRENCH.0, FRENCH.1)).await;
    assert!(setup.contains(r#"<html lang="fr">"#));
    assert!(setup.contains("<h1>Créez votre compte</h1>"));
    let english = text(&routes, req("/runlight/setup").header("accept-language", "en-GB,fr;q=0.5")).await;
    assert_eq!(english, text(&routes, req("/runlight/setup")).await, "English asked for is English as it always was");
    assert!(english.contains(r#"<html lang="en">"#));
    assert!(english.contains(r#"<script src="/runlight/auth.js"></script>"#));

    let setup_form = |code: &str, password: &str, headers: &[(&str, &str)]| {
        form(
            "/runlight/setup",
            &[("code", code), ("email", "jon@example.com"), ("password", password), ("again", password)],
            headers,
        )
    };
    let wrong_token = text(&routes, setup_form("guess", "a long password", &[FRENCH])).await;
    assert!(wrong_token.contains("Ce n’est pas le RUNLIGHT_TOKEN de cette application."));
    let short = text(&routes, setup_form("app-token", "short", &[FRENCH])).await;
    assert!(
        short.contains("Utilisez un mot de passe d’au moins 10 caractères."),
        "an account's own problem is worded as the dashboard words it"
    );
    let short_english = text(&routes, setup_form("app-token", "short", &[])).await;
    assert!(short_english.contains(r#"role="alert">Use a password of at least 10 characters</p>"#));

    let owner = cookie_of(&routes.handle(setup_form("app-token", "a long password", &[])).await);
    let wrong = routes
        .handle(form("/runlight/login", &[("email", "jon@example.com"), ("password", "not the password")], &[FRENCH]))
        .await;
    assert_eq!(wrong.status, 401);
    assert!(
        String::from_utf8(wrong.body)
            .unwrap()
            .contains("Cet e-mail et ce mot de passe ne correspondent à aucun compte.")
    );
    assert!(
        text(&routes, req("/runlight/login/link?ticket=nope").header(FRENCH.0, FRENCH.1))
            .await
            .contains("Ce lien de connexion a expiré.")
    );

    let invited = routes
        .handle(
            Request::new("POST", "https://example.com/runlight/api/people")
                .header("cookie", &owner)
                .header("content-type", "application/json")
                .body(obj! { "allSites" => true, "email" => "mo@example.com", "role" => "viewer" }.to_json()),
        )
        .await;
    let link = runlight::http::Url::parse(invited.json_body().unwrap().at("link").as_str().unwrap()).unwrap();
    let code = link.search_params().get("code").unwrap().to_string();
    let invite = text(&routes, req(&format!("{}{}", link.pathname(), link.search())).header(FRENCH.0, FRENCH.1)).await;
    assert!(invite.contains("Votre rôle : lecteur, qui peut lire les statistiques de tous les sites."));
    let mismatch = text(
        &routes,
        form(
            "/runlight/invite",
            &[("code", &code), ("password", "a long password"), ("again", "another one")],
            &[FRENCH],
        ),
    )
    .await;
    assert!(mismatch.contains("Les deux mots de passe ne sont pas identiques."));
    assert!(
        text(&routes, req("/runlight/invite?code=nope").header(FRENCH.0, FRENCH.1))
            .await
            .contains("<h1>Cette invitation ne fonctionne plus</h1>")
    );

    // The script comes in the language its page asked for, and in English at its old address.
    let english_script = runlight::accounts::pages::auth_js("en");
    assert_eq!(text(&routes, req("/runlight/auth.js").header(FRENCH.0, FRENCH.1)).await, english_script);
    assert_eq!(text(&routes, req("/runlight/auth.js?lang=fr")).await, runlight::accounts::pages::auth_js("fr"));

    let mut bare = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    bare.secret = Some("k".repeat(64));
    let locked =
        Runlight::new(bare).unwrap().routes(RoutesOptions { accounts: true, ..RoutesOptions::default() }).unwrap();
    let page = locked.handle(req("/runlight/setup").header(FRENCH.0, FRENCH.1)).await;
    assert_eq!(page.status, 403);
    assert!(String::from_utf8(page.body).unwrap().contains("<h1>Terminez la configuration</h1>"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_oauth_consent_page_and_its_messages_come_out_in_french_when_asked() {
    let mut options = RunlightOptions::new(runlight_sqlx::connect(":memory:").await.unwrap());
    options.sites = Some(vec![
        SiteOptions {
            id: Some("a".into()),
            name: Some("Site A".into()),
            hostnames: Some(vec!["a.com".into()]),
            ..SiteOptions::default()
        },
        SiteOptions {
            id: Some("b".into()),
            name: Some("Site B".into()),
            hostnames: Some(vec!["b.com".into()]),
            ..SiteOptions::default()
        },
    ]);
    let routes = Runlight::new(options)
        .unwrap()
        .routes(RoutesOptions { token: TokenOption::Given("secret".into()), ..RoutesOptions::default() })
        .unwrap();
    let callback = "https://claude.ai/api/mcp/auth_callback";
    let registered = routes
        .handle(
            Request::new("POST", "https://example.com/runlight/oauth/register")
                .header("content-type", "application/json")
                .body(obj! { "client_name" => "Claude", "redirect_uris" => runlight::arr![callback] }.to_json()),
        )
        .await;
    let client_id = registered.json_body().unwrap().at("client_id").as_str().unwrap().to_string();
    let challenge = "a".repeat(43);
    let params = |client: &str| {
        SearchParams::from_pairs([
            ("response_type", "code"),
            ("client_id", client),
            ("redirect_uri", callback),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
        ])
        .to_string()
    };
    let owner = ("authorization", "Bearer secret");
    let authorize = |query: &str| req(&format!("/runlight/oauth/authorize?{query}"));

    let consent =
        text(&routes, authorize(&params(&client_id)).header(owner.0, owner.1).header(FRENCH.0, FRENCH.1)).await;
    for want in [
        r#"<html lang="fr">"#,
        "<title>Connecter Claude | Runlight</title>",
        "<h1>Connecter Claude</h1>",
        "<strong>Claude</strong> veut lire vos statistiques Runlight",
        "Autoriser vous renvoie vers <strong>claude.ai</strong>.",
        r#"<option value="">Tous les sites</option><option value="a">Site A uniquement</option>"#,
        r#"class="ghost">Refuser</button><button type="submit" name="decision" value="allow">Autoriser</button>"#,
    ] {
        assert!(consent.contains(want), "{want}");
    }
    let english = text(&routes, authorize(&params(&client_id)).header(owner.0, owner.1)).await;
    assert!(english.contains(r#"<html lang="en">"#));
    assert!(english.contains("<h1>Connect Claude</h1>"));
    assert!(
        english.contains(
            "<strong>Claude</strong> wants to read your Runlight stats so it can answer questions about them."
        )
    );

    let manage = text(
        &routes,
        authorize(&format!("{}&scope=manage", params(&client_id))).header(owner.0, owner.1).header(FRENCH.0, FRENCH.1),
    )
    .await;
    assert!(manage.contains("Son jeton apparaît dans Réglages, MCP &amp; API, où le supprimer déconnecte Claude."));
    let signed_out = routes.handle(authorize(&params(&client_id)).header(FRENCH.0, FRENCH.1)).await;
    assert_eq!(signed_out.status, 401);
    assert!(String::from_utf8(signed_out.body).unwrap().contains("<h1>Connectez-vous d’abord</h1>"));
    let unknown = text(&routes, authorize(&params("nope")).header(FRENCH.0, FRENCH.1)).await;
    assert!(unknown.contains(
        "<h1>Cette application n’est pas enregistrée</h1><p>Recommencez la connexion depuis l’application.</p>"
    ));
    let forged = routes
        .handle(
            Request::new("POST", "https://example.com/runlight/oauth/authorize")
                .header(owner.0, owner.1)
                .header(FRENCH.0, FRENCH.1)
                .header("origin", "https://evil.example")
                .header("content-type", "application/x-www-form-urlencoded")
                .body(format!("{}&decision=allow", params(&client_id))),
        )
        .await;
    assert_eq!(forged.status, 403);
    assert!(String::from_utf8(forged.body).unwrap().contains("<h1>Cette demande vient d’un autre site</h1>"));
}

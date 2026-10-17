import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { runlight } from "../src/index.js";
import * as pages from "../src/accounts/pages.js";
import { cleanup, freshStore } from "./helpers.js";

after(cleanup);

const FRENCH = { "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" };
const req = (path: string, init: RequestInit = {}) => new Request(`https://example.com${path}`, init);
const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(fields).toString(),
});
const cookieOf = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0]!;

test("English account pages are the ones the other implementations are checked against, byte for byte", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../php/tests/fixtures/pages.json", import.meta.url), "utf8")) as {
    css: string;
    js: string;
    pages: Array<{ fn: keyof typeof pages; base: string; opts: unknown; html: string }>;
    roles: Array<{ role: string; text: string }>;
  };
  assert.equal(pages.AUTH_JS, fixture.js);
  assert.equal(pages.authJs("en"), fixture.js);
  assert.equal(pages.authJs("xx"), fixture.js, "a language Runlight does not speak is English");
  for (const c of fixture.pages) {
    const render = pages[c.fn] as (base: string, ...rest: unknown[]) => string;
    assert.equal(c.opts === null ? render(c.base) : render(c.base, c.opts), c.html, `${c.fn} at "${c.base}"`);
    assert.equal(c.opts === null ? render(c.base, "en") : render(c.base, c.opts, "en"), c.html, `${c.fn} at "${c.base}", asked for in English`);
  }
  for (const { role, text } of fixture.roles) assert.equal(pages.roleText(role), text);
});

test("every account page comes out in French when asked", () => {
  const cases: Array<[string, string, string]> = [
    ["sign in", pages.loginPage("/runlight", { forgot: "https://runlight.sh/docs" }, "fr"), "Se connecter"],
    ["the code step", pages.codePage("/runlight", { pending: "p", next: "/" }, "fr"), "Saisissez votre code"],
    ["an invite", pages.invitePage("/runlight", { code: "c", email: "a@example.com", role: "viewer", host: "stats.example.com" }, "fr"), "Rejoindre Runlight"],
    ["an invite that is gone", pages.inviteGonePage("/runlight", "fr"), "Cette invitation ne fonctionne plus"],
    ["setup", pages.setupPage("/runlight", { code: "", askCode: true }, "fr"), "Créez votre compte"],
    ["setup locked", pages.setupLockedPage("/runlight", "fr"), "Terminez la configuration"],
    ["setup needing a token", pages.setupNeedsTokenPage("/runlight", "fr"), "Terminez la configuration"],
  ];
  for (const [name, html, heading] of cases) {
    assert.match(html, /<html lang="fr">/, name);
    assert.ok(html.includes(`<h1>${heading}</h1>`), name);
    assert.ok(html.includes(`<title>${heading} | Runlight</title>`), name);
    assert.ok(html.includes(`<script src="/runlight/auth.js?lang=fr"></script>`), `${name} loads the French script`);
    assert.ok(html.includes(`aria-label="Changer de thème"`), name);
  }
  const invite = pages.invitePage("", { code: "c", email: "a@example.com", role: "member", host: "stats.example.com", site: "<Blog>" }, "fr");
  assert.ok(invite.includes("Votre rôle : membre, qui peut modifier les réglages de &lt;Blog&gt; uniquement."), "the role is French too, and the site name stays escaped");
  assert.ok(pages.loginPage("", { forgot: "https://x.example/?a=1&b=2" }, "fr").includes(`<a href="https://x.example/?a=1&amp;b=2" target="_blank" rel="noopener">la documentation explique`));
  // The script's words: show and hide, the theme, and the strength meter.
  const script = pages.authJs("fr");
  for (const words of ['"Afficher le mot de passe"', '"Masquer le mot de passe"', '"Thème : réglage de l’appareil"', '"Thème : sombre"', '["Trop court", "Faible", "Moyen", "Bon", "Fort"]']) {
    assert.ok(script.includes(words), words);
  }
  assert.ok(!script.includes("Show password"));
});

test("the account routes answer in the browser's language, and in English as before without one", async () => {
  const rl = runlight({ store: freshStore("sqlite"), secret: "k".repeat(64) });
  const { handler } = rl.routes({ token: "app-token", accounts: true });

  const setup = await (await handler(req("/runlight/setup", { headers: FRENCH }))).text();
  assert.match(setup, /<html lang="fr">/);
  assert.match(setup, /<h1>Créez votre compte<\/h1>/);
  const english = await (await handler(req("/runlight/setup", { headers: { "accept-language": "en-GB,fr;q=0.5" } }))).text();
  assert.equal(english, await (await handler(req("/runlight/setup"))).text(), "English asked for is English as it always was");
  assert.match(english, /<html lang="en">/);
  assert.match(english, /<script src="\/runlight\/auth\.js"><\/script>/);

  const wrongToken = await (await handler(req("/runlight/setup", form({ code: "guess", email: "jon@example.com", password: "a long password", again: "a long password" }, FRENCH)))).text();
  assert.match(wrongToken, /Ce n’est pas le RUNLIGHT_TOKEN de cette application\./);
  const short = await (await handler(req("/runlight/setup", form({ code: "app-token", email: "jon@example.com", password: "short", again: "short" }, FRENCH)))).text();
  assert.match(short, /Utilisez un mot de passe d’au moins 10 caractères\./, "an account's own problem is worded as the dashboard words it");
  const shortEnglish = await (await handler(req("/runlight/setup", form({ code: "app-token", email: "jon@example.com", password: "short", again: "short" })))).text();
  assert.match(shortEnglish, /role="alert">Use a password of at least 10 characters<\/p>/);

  const owner = cookieOf(await handler(req("/runlight/setup", form({ code: "app-token", email: "jon@example.com", password: "a long password", again: "a long password" }))));
  const wrong = await handler(req("/runlight/login", form({ email: "jon@example.com", password: "not the password" }, FRENCH)));
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Cet e-mail et ce mot de passe ne correspondent à aucun compte\./);
  assert.match(await (await handler(req("/runlight/login/link?ticket=nope", { headers: FRENCH }))).text(), /Ce lien de connexion a expiré\./);

  const sent = (await (await handler(req("/runlight/api/people", { method: "POST", headers: { cookie: owner, "content-type": "application/json" }, body: JSON.stringify({ allSites: true, email: "mo@example.com", role: "viewer" }) }))).json()) as { link: string };
  const link = new URL(sent.link);
  const invite = await (await handler(req(`${link.pathname}${link.search}`, { headers: FRENCH }))).text();
  assert.match(invite, /Votre rôle : lecteur, qui peut lire les statistiques de tous les sites\./);
  const mismatch = await (await handler(req("/runlight/invite", form({ code: link.searchParams.get("code")!, password: "a long password", again: "another one" }, FRENCH)))).text();
  assert.match(mismatch, /Les deux mots de passe ne sont pas identiques\./);
  assert.match(await (await handler(req("/runlight/invite?code=nope", { headers: FRENCH }))).text(), /<h1>Cette invitation ne fonctionne plus<\/h1>/);

  // The script comes in the language its page asked for, and in English at its old address.
  assert.equal(await (await handler(req("/runlight/auth.js", { headers: FRENCH }))).text(), pages.AUTH_JS);
  assert.equal(await (await handler(req("/runlight/auth.js?lang=fr"))).text(), pages.authJs("fr"));

  const locked = runlight({ store: freshStore("sqlite"), secret: "k".repeat(64) }).routes({ accounts: true });
  const page = await locked.handler(req("/runlight/setup", { headers: FRENCH }));
  assert.equal(page.status, 403);
  assert.match(await page.text(), /<h1>Terminez la configuration<\/h1>/);
});

test("the OAuth consent page and its messages come out in French when asked", async () => {
  const rl = runlight({ store: freshStore("sqlite"), sites: [{ id: "a", name: "Site A", hostnames: ["a.com"] }, { id: "b", name: "Site B", hostnames: ["b.com"] }] });
  const { GET, POST } = rl.routes({ token: "secret" });
  const callback = "https://claude.ai/api/mcp/auth_callback";
  const registered = await POST(req("/runlight/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [callback] }) }));
  const { client_id } = (await registered.json()) as { client_id: string };
  const params = new URLSearchParams({ response_type: "code", client_id, redirect_uri: callback, code_challenge: "a".repeat(43), code_challenge_method: "S256" });
  const owner = { authorization: "Bearer secret" };

  const consent = await (await GET(req(`/runlight/oauth/authorize?${params}`, { headers: { ...owner, ...FRENCH } }))).text();
  assert.match(consent, /<html lang="fr">/);
  assert.match(consent, /<title>Connecter Claude \| Runlight<\/title>/);
  assert.match(consent, /<h1>Connecter Claude<\/h1>/);
  assert.match(consent, /<strong>Claude<\/strong> veut lire vos statistiques Runlight/);
  assert.match(consent, /Autoriser vous renvoie vers <strong>claude\.ai<\/strong>\./);
  assert.match(consent, /<option value="">Tous les sites<\/option><option value="a">Site A uniquement<\/option>/);
  assert.match(consent, /class="ghost">Refuser<\/button><button type="submit" name="decision" value="allow">Autoriser<\/button>/);
  const english = await (await GET(req(`/runlight/oauth/authorize?${params}`, { headers: owner }))).text();
  assert.match(english, /<html lang="en">/);
  assert.match(english, /<h1>Connect Claude<\/h1>/);
  assert.match(english, /<strong>Claude<\/strong> wants to read your Runlight stats so it can answer questions about them\./);

  const manage = await (await GET(req(`/runlight/oauth/authorize?${params}&scope=manage`, { headers: { ...owner, ...FRENCH } }))).text();
  assert.match(manage, /Son jeton apparaît dans Réglages, MCP &amp; API, où le supprimer déconnecte Claude\./);
  const signedOut = await GET(req(`/runlight/oauth/authorize?${params}`, { headers: FRENCH }));
  assert.equal(signedOut.status, 401);
  assert.match(await signedOut.text(), /<h1>Connectez-vous d’abord<\/h1>/);
  const unknown = await (await GET(req(`/runlight/oauth/authorize?${params}`.replace(client_id, "nope"), { headers: FRENCH }))).text();
  assert.match(unknown, /<h1>Cette application n’est pas enregistrée<\/h1><p>Recommencez la connexion depuis l’application\.<\/p>/);
  const forged = await POST(req("/runlight/oauth/authorize", { method: "POST", headers: { ...owner, ...FRENCH, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: `${params}&decision=allow` }));
  assert.equal(forged.status, 403);
  assert.match(await forged.text(), /<h1>Cette demande vient d’un autre site<\/h1>/);
});

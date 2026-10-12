import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { runlight } from "../src/index.js";
import { agentsKey } from "../src/oauth.js";
import { sqlite } from "../src/stores/sqlite.js";
import { STORES, cleanup, freshStore } from "./helpers.js";

after(cleanup);

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("an app connects to the MCP server over OAuth: discovery, registration, consent, PKCE, and a read-only token", async () => {
  const rl = runlight({
    store: sqlite({ path: ":memory:" }),
    sites: [
      { id: "a", name: "Site A", hostnames: ["a.com"] },
      { id: "b", name: "Site B", hostnames: ["b.com"] },
    ],
  });
  const { GET, POST } = rl.routes({ token: "secret" });
  const origin = "https://x.com";
  const owner = { authorization: "Bearer secret" };

  // The MCP endpoint points at the metadata.
  const refused = await POST(new Request(`${origin}/runlight/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  assert.equal(refused.status, 401);
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(refused.headers.get("www-authenticate") ?? "")?.[1];
  assert.equal(metadataUrl, `${origin}/runlight/.well-known/oauth-protected-resource`);
  const resource = (await (await GET(new Request(metadataUrl!))).json()) as any;
  assert.deepEqual(resource.authorization_servers, [`${origin}/runlight`]);
  assert.equal(resource.resource, `${origin}/runlight/mcp`);
  const server = (await (await GET(new Request(`${origin}/.well-known/oauth-authorization-server/runlight`))).json()) as any;
  assert.equal(server.token_endpoint, `${origin}/runlight/oauth/token`);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);

  // Registration.
  assert.equal((await POST(new Request(`${origin}/runlight/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) }))).status, 400);
  const registered = await POST(new Request(`${origin}/runlight/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }) }));
  assert.equal(registered.status, 201);
  const { client_id } = (await registered.json()) as any;

  // Consent: signed out it says so; signed in it asks; allowing sends a code back.
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: challenge, code_challenge_method: "S256", state: "xyz" });
  assert.equal((await GET(new Request(`${origin}/runlight/oauth/authorize?${params}`))).status, 401);
  const wrongRedirect = new URLSearchParams(params);
  wrongRedirect.set("redirect_uri", "https://evil.example/cb");
  assert.equal((await GET(new Request(`${origin}/runlight/oauth/authorize?${wrongRedirect}`, { headers: owner }))).status, 400, "never sends a code to an address the app did not register");
  const consent = await GET(new Request(`${origin}/runlight/oauth/authorize?${params}`, { headers: owner }));
  assert.equal(consent.status, 200);
  const consentPage = await consent.text();
  assert.match(consentPage, /Claude<\/strong> wants to read your Runlight stats/);
  assert.match(consentPage, /sends you back to <strong>claude\.ai<\/strong>/, "the page shows where the answer goes");
  const deny = await POST(new Request(`${origin}/runlight/oauth/authorize`, { method: "POST", headers: { ...owner, "content-type": "application/x-www-form-urlencoded" }, body: `${params}&decision=deny` }));
  assert.match(deny.headers.get("location") ?? "", /error=access_denied&state=xyz/);
  const forged = await POST(new Request(`${origin}/runlight/oauth/authorize`, { method: "POST", headers: { ...owner, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: `${params}&decision=allow` }));
  assert.equal(forged.status, 403);
  const allow = await POST(new Request(`${origin}/runlight/oauth/authorize`, { method: "POST", headers: { ...owner, origin, "content-type": "application/x-www-form-urlencoded" }, body: `${params}&decision=allow&site=b` }));
  const back = new URL(allow.headers.get("location") ?? "");
  assert.equal(back.origin + back.pathname, "https://claude.ai/api/mcp/auth_callback");
  assert.equal(back.searchParams.get("state"), "xyz");
  const code = back.searchParams.get("code")!;

  // The token: PKCE checked, the code good once.
  const exchange = (verifierUsed: string) =>
    POST(new Request(`${origin}/runlight/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifierUsed }).toString() }));
  assert.equal(((await (await exchange("wrong-verifier")).json()) as any).error, "invalid_grant");
  assert.equal(((await (await exchange(verifier)).json()) as any).error, "invalid_grant", "a code that failed once is spent");

  // Again, properly this time.
  const second = await POST(new Request(`${origin}/runlight/oauth/authorize`, { method: "POST", headers: { ...owner, origin, "content-type": "application/x-www-form-urlencoded" }, body: `${params}&decision=allow&site=b` }));
  const code2 = new URL(second.headers.get("location")!).searchParams.get("code")!;
  // The same code swapped twice at once makes one token, not two.
  const swap = () => POST(new Request(`${origin}/runlight/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: code2, client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_verifier: verifier }).toString() }));
  const both = await Promise.all([swap(), swap()]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 400]);
  const issued = both.find((r) => r.status === 200)!;
  const { access_token, token_type } = (await issued.json()) as any;
  assert.equal(token_type, "Bearer");

  const call = await POST(new Request(`${origin}/runlight/mcp`, { method: "POST", headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sites", arguments: {} } }) }));
  const sites = JSON.parse(((await call.json()) as any).result.content[0].text).sites;
  assert.deepEqual(sites.map((s: any) => s.id), ["b"], "the token reads only the site chosen at consent");
  const tokens = (await (await GET(new Request(`${origin}/runlight/api/tokens`, { headers: owner }))).json()) as any;
  assert.deepEqual(tokens.tokens.map((t: any) => [t.name, t.site]), [["Claude (OAuth)", "b"]]);
});

test("registering stores nothing, so a flood of registrations never keeps a real app out", async () => {
  let now = Date.UTC(2026, 9, 7, 12);
  const rl = runlight({ store: sqlite({ path: ":memory:" }), sites: [{ id: "a", name: "Site A", hostnames: ["a.com"] }], now: () => now });
  const { GET, POST } = rl.routes({ token: "secret" });
  const register = (name: string, ip = "", redirect = "https://app.example/cb") =>
    POST(new Request("https://x.com/runlight/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect] }) }), { ip });
  const flood = await Promise.all(Array.from({ length: 500 }, (_, i) => register(`flood ${i}`).then((r) => r.status)));
  assert.ok(flood.every((s) => s === 201));
  assert.equal((await rl.store.settingsStartingWith("oauth-client:")).length, 0);
  assert.equal((await rl.store.settingsStartingWith("oauth-used:")).length, 0);

  // A real app still registers, and its id names it and its address, signed, so nobody can change them.
  const claude = await register("Claude", "", "https://claude.ai/cb");
  assert.equal(claude.status, 201);
  const { client_id } = (await claude.json()) as any;
  const verifier = b64url(randomBytes(32));
  const params = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://claude.ai/cb", code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256" });
  assert.match(await (await GET(new Request(`https://x.com/runlight/oauth/authorize?${params}`, { headers: { authorization: "Bearer secret" } }))).text(), /Claude<\/strong> wants to read/);
  const [payload] = client_id.split(".");
  const forged = `${Buffer.from(JSON.stringify({ n: "Claude", r: ["https://evil.example/cb"], t: now })).toString("base64url")}.${client_id.split(".")[1]}`;
  assert.notEqual(forged.split(".")[0], payload);
  assert.equal((await GET(new Request(`https://x.com/runlight/oauth/authorize?${new URLSearchParams({ ...Object.fromEntries(params), client_id: forged, redirect_uri: "https://evil.example/cb" })}`, { headers: { authorization: "Bearer secret" } }))).status, 400);

  // Allowed and swapped for a token, the app gets its first row.
  const allow = await POST(new Request("https://x.com/runlight/oauth/authorize", { method: "POST", headers: { authorization: "Bearer secret", origin: "https://x.com", "content-type": "application/x-www-form-urlencoded" }, body: `${params}&decision=allow` }));
  const code = new URL(allow.headers.get("location")!).searchParams.get("code")!;
  const issued = await POST(new Request("https://x.com/runlight/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: "https://claude.ai/cb", code_verifier: verifier }).toString() }));
  assert.equal(issued.status, 200);
  assert.equal((await rl.store.settingsStartingWith("oauth-used:")).length, 1);

  // An app stored before ids were signed still works, and one that never connected goes after a day.
  await rl.store.setSetting(`oauth-client:${"a".repeat(32)}`, JSON.stringify({ name: "Old", redirects: ["https://old.example/cb"], createdAt: now }));
  const old = new URLSearchParams({ ...Object.fromEntries(params), client_id: "a".repeat(32), redirect_uri: "https://old.example/cb" });
  assert.equal((await GET(new Request(`https://x.com/runlight/oauth/authorize?${old}`, { headers: { authorization: "Bearer secret" } }))).status, 200);
  now += 86_400_000;
  await register("Another");
  assert.equal((await rl.store.settingsStartingWith("oauth-client:")).length, 0);

  // One address registers at most ten a minute.
  for (let i = 0; i < 10; i++) assert.equal((await register(`app ${i}`, "203.0.113.9")).status, 201);
  assert.equal((await register("one more", "203.0.113.9")).status, 429);
  assert.equal((await register("one more", "203.0.113.10")).status, 201);
});

test("before an owner has allowed an app once, a request it got wrong ends on a page, never on its address", async () => {
  const rl = runlight({ store: sqlite({ path: ":memory:" }), sites: [{ id: "a", name: "Site A", hostnames: ["a.com"] }] });
  const { GET, POST } = rl.routes({ signIn: "/login", authorize: () => false });
  const registered = await POST(new Request("https://x.com/runlight/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "x", redirect_uris: ["https://evil.example/landing"] }) }));
  const { client_id } = (await registered.json()) as any;
  const wrong: Array<Record<string, string>> = [{ response_type: "token" }, { response_type: "code", code_challenge_method: "plain", code_challenge: "a".repeat(43) }];
  for (const asked of wrong) {
    const answer = await GET(new Request(`https://x.com/runlight/oauth/authorize?${new URLSearchParams({ client_id, redirect_uri: "https://evil.example/landing", state: "x", ...asked })}`));
    assert.equal(answer.status, 400);
    assert.equal(answer.headers.get("location"), null);
  }
});

test("a signed-in viewer is told only an owner can connect, never sent to sign in again", async () => {
  const rl = runlight({ store: sqlite({ path: ":memory:" }), sites: [{ id: "a", name: "Site A", hostnames: ["a.com"] }] });
  const { GET, POST } = rl.routes({ signIn: "/login", authorize: (request) => (request.headers.get("cookie") === "viewer" ? "read" : false) });
  const registered = await POST(new Request("https://x.com/runlight/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] }) }));
  const { client_id } = (await registered.json()) as any;
  const params = new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://claude.ai/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256" });
  const signedOut = await GET(new Request(`https://x.com/runlight/oauth/authorize?${params}`));
  assert.equal(signedOut.status, 303);
  const viewer = await GET(new Request(`https://x.com/runlight/oauth/authorize?${params}`, { headers: { cookie: "viewer" } }));
  assert.equal(viewer.status, 403);
  assert.match(await viewer.text(), /only an owner of this Runlight can connect Claude/);
});

test("a CMS plugin connects for the site that counts its domain and gets that site's agents key and a dashboard key", async () => {
  const rl = runlight({ store: sqlite({ path: ":memory:" }), managedSites: true });
  const { GET, POST } = rl.routes({ token: "secret" });
  const origin = "https://x.com";
  const owner = { authorization: "Bearer secret" };
  const form = { ...owner, "content-type": "application/x-www-form-urlencoded" };
  await rl.addSite({ name: "Blog", hostnames: ["blog.com"] });
  const agentsKey = ((await (await GET(new Request(`${origin}/runlight/api/observe-key?site=blog.com`, { headers: owner }))).json()) as any).key;

  const back = "https://www.blog.com/wp-admin/options-general.php?page=runlight";
  const registered = await POST(new Request(`${origin}/runlight/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "WordPress at www.blog.com", redirect_uris: [back] }) }));
  const { client_id } = (await registered.json()) as any;
  const verifier = b64url(randomBytes(32));
  const params = new URLSearchParams({ response_type: "code", client_id, redirect_uri: back, code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", scope: "cms", state: "s" });
  const consent = await (await GET(new Request(`${origin}/runlight/oauth/authorize?${params}`, { headers: owner }))).text();
  assert.match(consent, /wants to count <strong>blog\.com<\/strong>/);
  assert.doesNotMatch(consent, /A new site/, "a site already counts the domain, so there is no second one to make");

  const allow = await POST(new Request(`${origin}/runlight/oauth/authorize`, { method: "POST", headers: form, body: `${params}&decision=allow&site=blog.com` }));
  const code = new URL(allow.headers.get("location")!).searchParams.get("code")!;
  const swap = await POST(new Request(`${origin}/runlight/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id, redirect_uri: back, code_verifier: verifier }).toString() }));
  const granted = (await swap.json()) as any;
  assert.equal(granted.scope, "cms");
  assert.equal(granted.site, "blog.com");
  assert.equal(granted.agents_key, agentsKey, "the site keeps the agents key it had");
  const embed = await POST(new Request(`${origin}/runlight/api/embed`, { method: "POST", headers: { authorization: `Bearer ${granted.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ origin: "https://www.blog.com" }) }));
  assert.equal(embed.status, 201, "the token is the site's dashboard key");
  assert.equal((await GET(new Request(`${origin}/runlight/api/stats?site=blog.com&period=today`, { headers: { authorization: `Bearer ${granted.access_token}` } }))).status, 403, "and reads nothing itself");
});

for (const kind of STORES) {
  test(`${kind}: a key made on first use is the same for every request that asks at once`, async () => {
    const store = freshStore(kind);
    await store.migrate();
    // Two processes on one database, each making its own key when it finds none.
    let made = 0;
    const keys = await Promise.all(Array.from({ length: 10 }, () => store.settingOrAdd("embed-key", () => `key-${++made}`)));
    assert.equal(new Set(keys).size, 1, "every caller signs with the one written first");
    assert.equal(await store.setting("embed-key"), keys[0]);
    const rl = runlight({ store, site: { hostnames: ["example.com"] } });
    await rl.init();
    const agents = await Promise.all(Array.from({ length: 5 }, () => agentsKey(rl, "default")));
    assert.equal(new Set(agents).size, 1);
    assert.equal(await store.setting("observe-key:default"), agents[0]);
    assert.notEqual(await agentsKey(rl, "default", true), agents[0], "replacing it still makes a new one");
  });
}

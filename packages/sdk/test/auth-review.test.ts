import assert from "node:assert/strict";
import { test } from "node:test";
import { runlight } from "../src/index.js";
import { Lockout } from "../src/accounts/auth.js";
import { sqlite } from "../src/stores/sqlite.js";

const req = (path: string, init: RequestInit = {}, host = "dash.runlight-test.com") => new Request(`https://${host}${path}`, init);
const form = (fields: Record<string, string>, cookie = "") => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(fields).toString() });
const cookieOf = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0]!;
const SITES = [
  { id: "alpha", name: "Alpha", hostnames: ["alpha.example"] },
  { id: "beta", name: "Beta", hostnames: ["beta.example"] },
];

/** An install with an owner and a member kept to alpha, and a way to send JSON as either. */
async function install(routes: Record<string, unknown> = {}) {
  const store = sqlite({ path: ":memory:" });
  const rl = runlight({ store, secret: "k".repeat(64), sites: SITES });
  const { handler } = rl.routes({ token: "app-token", accounts: true, ...routes });
  const json = (cookie: string, method: string, path: string, body?: unknown, host?: string) =>
    handler(req(`/runlight${path}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, host));
  const owner = cookieOf(await handler(req("/runlight/setup", form({ code: "app-token", email: "owner@example.com", password: "a long password", again: "a long password" }))));
  const invite = (await (await json(owner, "POST", "/api/people", { email: "member@example.com", role: "member", site: "alpha" })).json()) as { link: string };
  const member = cookieOf(await handler(req("/runlight/invite", form({ code: new URL(invite.link).searchParams.get("code")!, password: "another long password", again: "another long password" }))));
  return { store, handler, json, owner, member };
}

/** A body sent in pieces with no content-length, as a client that streams sends it. */
const streamed = (megabytes: number) => {
  const chunk = new Uint8Array(1024 * 1024).fill(97);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent++ < megabytes) controller.enqueue(chunk);
      else controller.close();
    },
  });
};

test("an account kept to one site adds no link domain or report until the app knows its own address, like a hub", async () => {
  const open = await install();
  const refusedDomain = await open.json(open.member, "POST", "/api/link-domains", { domain: "dash.runlight-test.com" }, "other.runlight-test.com");
  assert.equal(refusedDomain.status, 400);
  assert.equal(((await refusedDomain.json()) as { code: string }).code, "origin_needed");
  const refusedReport = await open.json(open.member, "POST", "/api/reports", { email: "reader@example.com", frequency: "weekly" }, "evil.runlight-test.com");
  assert.equal(refusedReport.status, 400);
  assert.equal(((await refusedReport.json()) as { code: string }).code, "origin_needed");
  assert.equal((await open.store.reports()).length, 0);
  // The owner is still taken at their word.
  assert.equal((await open.json(open.owner, "POST", "/api/reports?site=alpha", { email: "reader@example.com", frequency: "weekly" })).status, 201);

  const known = await install({ origin: "https://dash.runlight-test.com" });
  const taken = await known.json(known.member, "POST", "/api/link-domains", { domain: "dash.runlight-test.com" }, "other.runlight-test.com");
  assert.equal(taken.status, 400);
  assert.equal(((await taken.json()) as { code: string }).code, "domain_in_use");
  assert.equal((await known.json(known.member, "POST", "/api/reports", { email: "reader@example.com", frequency: "weekly" }, "evil.runlight-test.com")).status, 201);
  assert.deepEqual((await known.store.reports()).map((r) => r.origin), ["https://dash.runlight-test.com/runlight"]);
});

test("an account kept to one site gets a picker ticket only for this dashboard", async () => {
  const { json, member, owner } = await install();
  const elsewhere = await json(member, "POST", "/api/pick", { origin: "https://evil.runlight-test.com" });
  assert.equal(elsewhere.status, 403);
  assert.equal(((await elsewhere.json()) as { code: string }).code, "pick_own");
  assert.equal((await json(member, "POST", "/api/pick", { origin: "https://dash.runlight-test.com" })).status, 200);
  assert.equal((await json(owner, "POST", "/api/pick?site=alpha", { origin: "https://hub.runlight-test.com" })).status, 200);
  const known = await install({ origin: "https://dash.runlight-test.com" });
  assert.equal((await known.json(known.member, "POST", "/api/pick", { origin: "https://evil.runlight-test.com" }, "evil.runlight-test.com")).status, 403);
});

test("an email or a domain too long to be one is refused before any pattern reads it", async () => {
  const { json, owner } = await install();
  const started = Date.now();
  const email = `a@${".".repeat(300_000)}@`;
  assert.equal((await json(owner, "POST", "/api/reports?site=alpha", { email, frequency: "weekly" })).status, 400);
  assert.equal((await json(owner, "POST", "/api/mail/test", { to: email })).status, 400);
  // The account routes take far smaller bodies, so this one is shorter, and still far too long to be an address.
  assert.equal((await json(owner, "POST", "/api/people", { email: `a@${".".repeat(60_000)}@`, role: "viewer", allSites: true })).status, 400);
  assert.equal((await json(owner, "POST", "/api/people", { email, role: "viewer", allSites: true })).status, 413);
  const domain = await json(owner, "POST", "/api/link-domains?site=alpha", { domain: `${".".repeat(300_000)}x` });
  assert.equal(domain.status, 400);
  assert.equal(((await domain.json()) as { code: string }).code, "domain_invalid");
  assert.equal((await json(owner, "POST", "/api/link-domains?site=alpha", { domain: `a${".".repeat(250)}` })).status, 400);
  assert.ok(Date.now() - started < 2000, "none of them took long");
  // An address of ordinary length is still taken.
  assert.equal((await json(owner, "POST", "/api/reports?site=alpha", { email: "reader@example.com", frequency: "weekly" })).status, 201);
});

test("a body sent without a length is capped on the sign-in, OAuth, and MCP paths too", async () => {
  const { handler, owner } = await install();
  const post = (path: string, type: string, headers: Record<string, string> = {}) =>
    handler(new Request(`https://dash.runlight-test.com/runlight${path}`, { method: "POST", headers: { "content-type": type, ...headers }, body: streamed(3), duplex: "half" } as RequestInit));
  for (const path of ["/oauth/token", "/oauth/authorize", "/login", "/login/code", "/invite"]) {
    assert.equal((await post(path, "application/x-www-form-urlencoded")).status, 413, path);
  }
  assert.equal((await post("/oauth/token", "application/json")).status, 413);
  assert.equal((await post("/oauth/register", "application/json")).status, 413);
  assert.equal((await post("/api/account/password", "application/json", { cookie: owner })).status, 413);
  assert.equal((await post("/mcp", "application/json", { cookie: owner })).status, 413);
  // What is not JSON still reads as before.
  assert.equal((await handler(req("/runlight/mcp", { method: "POST", headers: { cookie: owner }, body: "not json" }))).status, 400);
  assert.equal((await handler(req("/runlight/oauth/token", form({ grant_type: "password" })))).status, 400);
});

test("the consent form reaches an app's own check unread, so it can find the csrf field", async () => {
  const rl = runlight({ store: sqlite({ path: ":memory:" }), site: { hostnames: ["example.com"] } });
  const { handler } = rl.routes({
    csrf: () => "nonce-1",
    authorize: async (request) => request.method === "GET" || (await request.formData()).get("csrf") === "nonce-1",
  });
  const registered = (await (await handler(req("/runlight/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "App", redirect_uris: ["https://app.example/cb"] }) }))).json()) as { client_id: string };
  const fields = { response_type: "code", client_id: registered.client_id, redirect_uri: "https://app.example/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256", decision: "allow", site: "" };
  const allowed = await handler(req("/runlight/oauth/authorize", form({ ...fields, csrf: "nonce-1" })));
  assert.equal(allowed.status, 303);
  assert.match(allowed.headers.get("location") ?? "", /^https:\/\/app\.example\/cb\?code=/);
  assert.equal((await handler(req("/runlight/oauth/authorize", form({ ...fields, csrf: "guess" })))).status, 401);
});

test("an app cannot register a redirect address that is not an address", async () => {
  const { handler } = await install();
  const register = (redirect_uris: string[]) => handler(req("/runlight/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "App", redirect_uris }) }));
  const refused = await register(["https://["]);
  assert.equal(refused.status, 400);
  assert.equal(((await refused.json()) as { error: string }).error, "invalid_redirect_uri");
  const kept = (await (await register(["https://[", "https://app.example/cb"])).json()) as { redirect_uris: string[] };
  assert.deepEqual(kept.redirect_uris, ["https://app.example/cb"]);
});

test("an account kept to one site is told it cannot connect an app, not sent to sign in again", async () => {
  const { handler, member } = await install();
  const registered = (await (await handler(req("/runlight/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "App", redirect_uris: ["https://app.example/cb"] }) }))).json()) as { client_id: string };
  const query = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: "https://app.example/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256" });
  const page = await handler(req(`/runlight/oauth/authorize?${query}`, { headers: { cookie: member } }));
  assert.equal(page.status, 403);
  assert.equal(page.headers.get("location"), null);
  const words = await page.text();
  assert.match(words, /Ask an owner to connect this/);
  assert.match(words, /Your account only has access to one site, and only an owner of this Runlight can connect App\./);
  assert.doesNotMatch(words, /signed in as a viewer/);
  const french = await (await handler(req(`/runlight/oauth/authorize?${query}`, { headers: { cookie: member, "accept-language": "fr" } }))).text();
  assert.match(french, /Votre compte n’a accès qu’à un seul site/);
  const posted = await handler(req("/runlight/oauth/authorize", form({ ...Object.fromEntries(query), decision: "allow", site: "" }, member)));
  assert.equal(posted.status, 403);
});

test("all time for short links reaches back to clicks that came as daily counts, which belong to no visit", async () => {
  const rl = runlight({ store: sqlite({ path: ":memory:" }), site: { hostnames: ["example.com"] } });
  const { handler } = rl.routes({ token: "t" });
  const get = async (path: string) => (await handler(req(`/runlight${path}`, { headers: { authorization: "Bearer t" } }))).json() as Promise<any>;
  const link = await rl.links.create("default", { url: "https://example.org/", slug: "old" });
  // As an import writes a day's count: a click with no visitor and no visit, long before any visit.
  const ts = Date.UTC(2025, 0, 5, 12);
  await rl.store.insertEvent({ site: "default", ts, kind: "click", visitor: "", session: "", pageview: "", path: "/old", hostname: "", title: "", name: "old", props: { imported: "daily" }, engagedMs: 0, scroll: null, link: link.id });
  assert.equal(await rl.store.firstSeen("default"), null);
  assert.equal(await rl.store.firstClick("default"), ts);
  const all = await get("/api/links?period=all");
  assert.deepEqual(all.links.map((l: any) => [l.slug, l.clicks]), [["old", 1]]);
  const one = await get(`/api/links/${link.id}?period=all`);
  assert.equal(one.clicks, 1);
  assert.equal(one.range.from, "2025-01-05");
  // The site's other reports still start at its first visit.
  assert.notEqual((await get("/api/stats?period=all&compare=off")).range.from, "2025-01-05");
  await rl.store.close();
});

test("wrong second-factor codes lock for longer each time, up to a day, and a lock always ends", async () => {
  const lock = new Lockout();
  const minute = 60_000;
  let now = 1_000_000;
  const tries = async () => {
    let taken = 0;
    while (await lock.take("account", now)) taken++;
    return taken;
  };
  assert.equal(await tries(), 5);
  // Fifteen minutes, then thirty, then an hour, doubling to a day and no further.
  for (const wait of [15, 30, 60, 120, 240, 480, 960, 1440, 1440]) {
    now += wait * minute - 1;
    assert.equal(await lock.take("account", now), false, `still locked just short of ${wait} minutes`);
    now += 1;
    assert.equal(await tries(), 5, `five more after ${wait} minutes`);
  }
  // Another key is not held up, a right code clears one, and a quiet week forgets it.
  assert.equal(await lock.take("account\ndevice", now), true);
  await lock.clear("account");
  assert.equal(await tries(), 5);
  now += 15 * minute;
  assert.equal(await tries(), 5);
  now += 30 * minute + 7 * 1440 * minute;
  assert.equal(await tries(), 5);
  now += 15 * minute;
  assert.equal(await lock.take("account", now), true, "the count started again");
});

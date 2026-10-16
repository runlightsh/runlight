import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { after, test } from "node:test";
import { checkPassword, hashPassword, runlight } from "../src/index.js";
import { sealText, unsealText } from "../src/accounts/crypto.js";
import { STORES, cleanup, freshStore } from "./helpers.js";

after(cleanup);

const req = (path: string, init: RequestInit = {}) => new Request(`https://example.com${path}`, init);
const form = (fields: Record<string, string>, cookie = "") => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});
const cookieOf = (response: Response) => (response.headers.get("set-cookie") ?? "").split(";")[0]!;

test("passwords hashed before, with scrypt, still check, and a PBKDF2 hash made elsewhere checks too", async () => {
  // The standalone server's own format, as it has always written it.
  const salt = randomBytes(16);
  const key = scryptSync("a long password", salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const old = `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
  assert.equal(await checkPassword("a long password", old), true);
  assert.equal(await checkPassword("a wrong password", old), false);
  // What an edge runtime without scrypt writes.
  const pbkdf2 = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations: 100_000 },
    await crypto.subtle.importKey("raw", new TextEncoder().encode("a long password"), "PBKDF2", false, ["deriveBits"]),
    256,
  );
  const edge = `pbkdf2$100000$${salt.toString("base64url")}$${Buffer.from(pbkdf2).toString("base64url")}`;
  assert.equal(await checkPassword("a long password", edge), true);
  assert.equal(await checkPassword("a long passwore", edge), false);
  assert.equal(await checkPassword("x", "pbkdf2$99999999999$a$b"), false, "an absurd round count is refused, not run");
  assert.equal(await checkPassword("anything", `scrypt$${salt.toString("base64url")}$`), false, "an empty key matches nothing");
  assert.equal(await checkPassword("anything", `pbkdf2$1000$${salt.toString("base64url")}$`), false, "an empty key matches nothing");
  assert.equal(await checkPassword("a long password", `scrypt$${salt.toString("base64url")}$${key.subarray(0, 8).toString("base64url")}`), false, "a cut key is refused");
  assert.equal(await checkPassword("a long password", "scrypt$Xn_mYpTI3PoQhj0lEUmHtw$a"), false, "a key that is not base64url matches nothing rather than throwing");
  assert.equal(await checkPassword("a long password", `scrypt$@@$${key.toString("base64url")}`), false, "nor does a salt that is not base64url");
  assert.equal(await checkPassword("a long password", `pbkdf2$1000$@@$${key.toString("base64url")}`), false);
  assert.match(await hashPassword("a long password"), /^scrypt\$/, "Node has scrypt, so new hashes use it");
});

test("new password hashes record their scrypt cost, and a cost out of bounds is refused, not run", async () => {
  const made = await hashPassword("a long password");
  assert.match(made, /^scrypt\$32768\$8\$3\$[\w-]+\$[\w-]+$/);
  assert.equal(await checkPassword("a long password", made), true);
  assert.equal(await checkPassword("a long passwore", made), false);
  // The same bytes any language's scrypt gives for that cost, so every port can check them.
  const [, , , , salt, key] = made.split("$");
  const again = scryptSync("a long password", Buffer.from(salt!, "base64url"), 32, { N: 32768, r: 8, p: 3, maxmem: 256 * 32768 * 8 });
  assert.equal(again.toString("base64url"), key);
  for (const cost of ["2097152$8$1", "30000$8$1", "1$8$1", "16384$33$1", "16384$8$17", "16384$0$1", "x$8$1"]) {
    assert.equal(await checkPassword("a long password", `scrypt$${cost}$${salt}$${key}`), false, cost);
  }
});

for (const kind of STORES) {
  test(`${kind}: signing in hashes a password made at the old cost again, and a wrong password changes nothing`, async () => {
    const store = freshStore(kind);
    const { Accounts } = await import("../src/accounts/auth.js");
    const accounts = new Accounts(store, "a server secret long enough");
    const user = await accounts.setPassword("owner@example.com", "a long password", Date.UTC(2026, 9, 14, 12));
    const salt = randomBytes(16);
    const old = `scrypt$${salt.toString("base64url")}$${scryptSync("a long password", salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64url")}`;
    await store.db.run(`UPDATE rl_users SET hash = ? WHERE id = ?`, [old, user.id]);
    assert.equal(await accounts.signIn("owner@example.com", "a wrong password"), null);
    assert.equal((await accounts.byId(user.id))!.hash, old);
    const signedIn = await accounts.signIn("owner@example.com", "a long password");
    assert.match(signedIn!.hash, /^scrypt\$32768\$8\$3\$/, "made again at the new cost");
    assert.equal((await accounts.byId(user.id))!.hash, signedIn!.hash);
    assert.notEqual((await accounts.signIn("owner@example.com", "a long password")), null, "and it still signs in");
  });
}

test("two-factor secrets sealed by the server open here, and the other way round", async () => {
  const secret = "s".repeat(64);
  const key = createHash("sha256").update(`totp:${secret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update("JBSWY3DPEHPK3PXP", "utf8"), cipher.final()]);
  const sealedByNode = `${iv.toString("base64url")}.${body.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  assert.equal(await unsealText(sealedByNode, secret), "JBSWY3DPEHPK3PXP");
  assert.equal(await unsealText(sealedByNode, "another secret"), null);

  const [i, b, t] = (await sealText("JBSWY3DPEHPK3PXP", secret)).split(".");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(i!, "base64url"));
  decipher.setAuthTag(Buffer.from(t!, "base64url"));
  assert.equal(Buffer.concat([decipher.update(Buffer.from(b!, "base64url")), decipher.final()]).toString("utf8"), "JBSWY3DPEHPK3PXP");
});

for (const kind of STORES) {
  test(`${kind}: reopening accounts preserves scoped invitations and existing columns`, async () => {
    const store = freshStore(kind);
    const { Accounts } = await import("../src/accounts/auth.js");
    const now = Date.UTC(2026, 9, 14, 12);
    const first = new Accounts(store, "a server secret long enough");
    await first.setPassword("owner@example.com", "a long password", now);
    await first.invite("member@example.com", "member", "owner@example.com", now, "alpha");
    const reopened = new Accounts(store, "a server secret long enough");
    assert.equal(await reopened.count(), 1);
    assert.equal((await reopened.invites(now))[0]!.site, "alpha");
    assert.equal((await reopened.byEmail("owner@example.com"))!.site, undefined);
  });

  test(`${kind}: an app with accounts on makes its first account with its token, then invites people by role`, async () => {
    const rl = runlight({ store: freshStore(kind), secret: "k".repeat(64) });
    const { handler } = rl.routes({ token: "app-token", accounts: true });
    const json = (cookie: string, method: string, path: string, body?: unknown) =>
      handler(req(`/runlight${path}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));

    // Nobody yet: the dashboard sends you to set up, which asks for the app's token.
    const start = await handler(req("/runlight/"));
    assert.equal(start.status, 303);
    assert.equal(start.headers.get("location"), "/runlight/setup");
    const page = await (await handler(req("/runlight/setup"))).text();
    assert.match(page, /RUNLIGHT_TOKEN/);
    assert.match(page, /action="\/runlight\/setup"/);
    assert.match(page, /href="\/runlight\/auth\.css"/);
    const wrong = await handler(req("/runlight/setup", form({ code: "guess", email: "jon@example.com", password: "a long password", again: "a long password" })));
    assert.equal(wrong.status, 403);
    const made = await handler(req("/runlight/setup", form({ code: "app-token", email: "jon@example.com", password: "a long password", again: "a long password" })));
    assert.equal(made.status, 303);
    assert.equal(made.headers.get("location"), "/runlight/");
    assert.match(made.headers.get("set-cookie") ?? "", /Path=\/runlight;/, "the session is for Runlight's paths only");
    const owner = cookieOf(made);
    assert.equal((await handler(req("/runlight/setup"))).headers.get("location"), "/runlight/login", "setup closes once there is an account");

    // Signed in, the dashboard and its API answer; signed out, they do not.
    assert.equal((await handler(req("/runlight/", { headers: { cookie: owner } }))).status, 200);
    assert.match(await (await handler(req("/runlight/", { headers: { cookie: owner } }))).text(), /data-accounts=""/);
    assert.equal((await handler(req("/runlight/api/sites"))).status, 401);
    assert.equal((await handler(req("/runlight/api/sites", { headers: { cookie: owner } }))).status, 200);
    assert.equal((await handler(req("/runlight/api/sites", { headers: { authorization: "Bearer app-token" } }))).status, 200, "a script's token still works");
    assert.equal(((await (await json(owner, "GET", "/api/account")).json()) as any).account.role, "owner");

    // The owner invites a member, who joins with their own password.
    const sent = (await (await json(owner, "POST", "/api/people", { allSites: true, email: "mo@example.com", role: "member" })).json()) as any;
    assert.equal(sent.emailed, false, "no mail service here, so the link is for passing on");
    const link = new URL(sent.link);
    assert.equal(link.pathname, "/runlight/invite");
    assert.match(await (await handler(req(`${link.pathname}${link.search}`))).text(), /as a member/);
    const joined = await handler(req("/runlight/invite", form({ code: link.searchParams.get("code")!, password: "another long one", again: "another long one" })));
    assert.equal(joined.status, 303);
    const member = cookieOf(joined);

    // A member changes a site's settings, but not people, the mail service, or the assistant's settings.
    assert.equal((await json(member, "POST", "/api/goals", { name: "Signup", kind: "page", match: "/thanks" })).status, 201);
    assert.equal((await json(member, "GET", "/api/people")).status, 403);
    assert.equal(((await (await json(member, "PUT", "/api/mail", {})).json()) as any).code, "admin_only");
    assert.equal((await json(member, "PUT", "/api/assistant", {})).status, 403);

    // Signing out ends the session; signing in again with the password starts one.
    const out = await handler(req("/runlight/logout"));
    assert.equal(out.headers.get("location"), "/runlight/login");
    assert.equal((await handler(req("/runlight/"))).headers.get("location"), "/runlight/login");
    const back = await handler(req("/runlight/login", form({ email: "mo@example.com", password: "another long one", next: "/runlight/?period=7d" })));
    assert.equal(back.status, 303);
    assert.equal(back.headers.get("location"), "/runlight/?period=7d");
    const elsewhere = await handler(req("/runlight/login", form({ email: "mo@example.com", password: "another long one", next: "//evil.example/" })));
    assert.equal(elsewhere.headers.get("location"), "/runlight/", "never sent off the app");
    // A session cookie that is not valid percent-encoding reads as signed out.
    assert.equal((await handler(req("/runlight/api/sites", { headers: { cookie: "runlight_session=%E0%A4%A" } }))).status, 401);
    assert.equal((await handler(req("/runlight/", { headers: { cookie: "runlight_session=%" } }))).headers.get("location"), "/runlight/login");
    // Dot segments that resolve to a path starting "//" would leave from the Location header too.
    for (const next of ["/..//evil.example/", "/runlight/..//evil.example", "/./../..//evil.example/x"]) {
      const dotted = await handler(req("/runlight/login", form({ email: "mo@example.com", password: "another long one", next })));
      assert.equal(dotted.headers.get("location"), "/runlight/", next);
    }
  });
}

test("invites go with whoever sent them: removed, made a member, or no longer allowed when the link is used", async () => {
  const rl = runlight({ store: freshStore("sqlite"), secret: "k".repeat(64) });
  const { handler } = rl.routes({ token: "app-token", accounts: true });
  const json = (cookie: string, method: string, path: string, body?: unknown) =>
    handler(req(`/runlight${path}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const owner = cookieOf(await handler(req("/runlight/setup", form({ code: "app-token", email: "jon@example.com", password: "a long password", again: "a long password" }))));
  const join = async (email: string, role: string, by = owner) => {
    const link = new URL(((await (await json(by, "POST", "/api/people", { allSites: true, email, role })).json()) as any).link);
    return link.searchParams.get("code")!;
  };
  const accept = (code: string) => handler(req("/runlight/invite", form({ code, password: "a long password", again: "a long password" })));
  const admin = cookieOf(await accept(await join("ada@example.com", "admin")));
  const adminId = ((await (await json(admin, "GET", "/api/account")).json()) as any).account.id;

  // Made a member: what they sent stops working.
  const fromAda = await join("eve@example.com", "admin", admin);
  assert.equal((await json(owner, "PATCH", `/api/people/${adminId}`, { role: "member" })).status, 200);
  assert.equal((await handler(req(`/runlight/invite?code=${fromAda}`))).status, 410);
  assert.equal((await accept(fromAda)).status, 410);

  // Removed: the same.
  await json(owner, "PATCH", `/api/people/${adminId}`, { role: "admin" });
  const again = await join("eve@example.com", "admin", admin);
  assert.equal((await json(owner, "DELETE", `/api/people/${adminId}`)).status, 200);
  assert.equal((await accept(again)).status, 410);
  assert.deepEqual(((await (await json(owner, "GET", "/api/people")).json()) as any).invites, []);

  // An invite left from before, whose sender is no longer an admin, is refused when used.
  const second = cookieOf(await accept(await join("bo@example.com", "admin")));
  const fromBo = await join("zed@example.com", "admin", second);
  await rl.store.db.run(`UPDATE rl_users SET role = 'viewer' WHERE email = ?`, ["bo@example.com"]);
  assert.equal((await accept(fromBo)).status, 410);
  assert.equal((await handler(req(`/runlight/invite?code=${fromBo}`))).status, 410, "and it is gone afterwards");
});

test("in development, or left open on purpose, the first account needs no proof; in production without a token, setup stays shut", async () => {
  const before = process.env.NODE_ENV;
  const token = process.env.RUNLIGHT_TOKEN;
  delete process.env.RUNLIGHT_TOKEN;
  try {
    process.env.NODE_ENV = "development";
    const dev = runlight({ store: freshStore("sqlite") }).routes({ accounts: true });
    const page = await (await dev.handler(req("/runlight/setup"))).text();
    assert.doesNotMatch(page, /RUNLIGHT_TOKEN/);
    const made = await dev.handler(req("/runlight/setup", form({ code: "", email: "jon@example.com", password: "a long password", again: "a long password" })));
    assert.equal(made.status, 303);

    process.env.NODE_ENV = "production";
    const open = runlight({ store: freshStore("sqlite") }).routes({ token: null, accounts: true });
    assert.equal((await open.handler(req("/runlight/setup"))).status, 200, "token: null leaves setup open, as it leaves everything");
    const prod = runlight({ store: freshStore("sqlite"), secret: "k".repeat(64) }).routes({ accounts: true });
    const shut = await prod.handler(req("/runlight/setup"));
    assert.equal(shut.status, 403);
    assert.match(await shut.text(), /Set RUNLIGHT_TOKEN/);
    const tried = await prod.handler(req("/runlight/setup", form({ code: "", email: "jon@example.com", password: "a long password", again: "a long password" })));
    assert.equal(tried.status, 403);
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
    if (token !== undefined) process.env.RUNLIGHT_TOKEN = token;
  }
});

for (const kind of STORES) {
  test(`${kind}: a code is accepted once, even by two processes checking it at the same moment`, async () => {
    const store = freshStore(kind);
    const { Accounts, totp } = await import("../src/accounts/auth.js");
    const one = new Accounts(store, "a server secret long enough");
    // Another process on the same database: its own Accounts, with nothing in memory shared.
    const other = new Accounts(store, "a server secret long enough");
    const now = Date.UTC(2026, 9, 12, 12);
    const user = await one.setPassword("owner@example.com", "a long password", now);
    const secret = await one.startTwoFactor(user.id);
    const recovery = (await one.confirmTwoFactor(user.id, await totp(secret, Math.floor(now / 30_000)), now))!;

    const later = now + 60_000;
    const code = await totp(secret, Math.floor(later / 30_000));
    for (let round = 0; round < 5; round++) {
      const at = later + round * 30_000;
      const fresh = await totp(secret, Math.floor(at / 30_000));
      const both = await Promise.all([one.checkSecondFactor(user.id, fresh, at), other.checkSecondFactor(user.id, fresh, at)]);
      assert.equal(both.filter(Boolean).length, 1, `round ${round}: one of the two is accepted`);
    }
    assert.equal(await one.checkSecondFactor(user.id, code, later), false, "an older code stays refused");

    for (const used of recovery.slice(0, 3)) {
      const both = await Promise.all([one.checkSecondFactor(user.id, used, later), other.checkSecondFactor(user.id, used, later)]);
      assert.equal(both.filter(Boolean).length, 1, "a recovery code is crossed off once");
    }
    // Two different recovery codes at once: neither write loses the other's, though one may be asked again.
    const pair = await Promise.all([one.checkSecondFactor(user.id, recovery[3]!, later), other.checkSecondFactor(user.id, recovery[4]!, later)]);
    assert.equal((await one.byId(user.id))!.recoveryLeft, 7 - pair.filter(Boolean).length, "every code accepted is crossed off");
    for (const [i, accepted] of pair.entries()) if (accepted) assert.equal(await one.checkSecondFactor(user.id, recovery[3 + i]!, later), false);
    assert.equal((one as unknown as { checking: Map<string, unknown> }).checking.size, 0, "a finished check leaves nothing queued behind");
  });
}

for (const role of ["member", "viewer"] as const) {
  test(`site-only ${role}: invitations preserve scope and reject cross-site and install-wide access`, async () => {
    const rl = runlight({ store: freshStore("sqlite"), secret: "k".repeat(64), sites: [
      { id: "alpha", name: "Alpha", hostnames: ["alpha.example"] },
      { id: "beta", name: "Beta", hostnames: ["beta.example"] },
    ] });
    const { handler } = rl.routes({ token: "app-token", accounts: true });
    const json = (cookie: string, method: string, path: string, body?: unknown) => handler(req(`/runlight${path}`, {
      method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const owner = cookieOf(await handler(req("/runlight/setup", form({ code: "app-token", email: "owner@example.com", password: "a long password", again: "a long password" }))));
    assert.equal((await json(owner, "POST", "/api/people", { email: "missing@example.com", role })).status, 400);
    assert.equal((await json(owner, "POST", "/api/people", { email: "bad@example.com", role: "admin", site: "alpha" })).status, 400);
    assert.equal((await json(owner, "POST", "/api/people", { email: "bad@example.com", role, site: "missing" })).status, 404);
    const invite = await (await json(owner, "POST", "/api/people", { email: `${role}@example.com`, role, site: "alpha" })).json() as any;
    assert.equal(invite.invite.site, "alpha");
    const resent = await (await json(owner, "POST", `/api/invites/${invite.invite.id}/resend`, {})).json() as any;
    assert.equal(resent.invite.site, "alpha");
    const code = new URL(resent.link).searchParams.get("code")!;
    assert.match(await (await handler(req(`/runlight/invite?code=${code}`))).text(), /alpha only/);
    const session = cookieOf(await handler(req("/runlight/invite", form({ code, password: "another long password", again: "another long password" }))));
    const me = (await (await json(session, "GET", "/api/account")).json() as any).account;
    assert.equal(me.site, "alpha");
    assert.equal((await json(owner, "PATCH", `/api/people/${me.id}`, { role: "admin" })).status, 400);
    const listed = await (await json(session, "GET", "/api/sites")).json() as any;
    assert.deepEqual(listed.sites.map((site: any) => site.id), ["alpha"]);
    assert.equal(listed.managed, false);
    assert.equal((await json(session, "GET", "/api/stats?site=alpha&period=today")).status, 200);
    assert.equal((await json(session, "GET", "/api/stats?site=beta&period=today")).status, 404);
    assert.equal((await json(session, "GET", "/api/sites?site=beta")).status, 404);
    for (const path of ["/api/tokens", "/api/people", "/api/check", "/api/observe-key"]) {
      assert.equal((await json(session, "GET", path)).status, 403, path);
    }
    for (const path of ["/api/sites", "/api/people", "/api/tokens", "/api/mail/test", "/api/observe", "/api/sites/connect"]) {
      assert.equal((await json(session, "POST", path, {})).status, path === "/api/sites/connect" ? 404 : 403, path);
    }
    assert.equal((await json(session, "POST", "/api/assistant/chat", { site: "beta", messages: [{ role: "user", content: "stats" }] })).status, 404);
    assert.equal((await json(session, "POST", "/api/goals?site=beta", { name: "Cross site", kind: "event", match: "bad" })).status, 404);
    assert.equal((await json(session, "POST", "/api/goals?site=alpha", { name: "Signup", kind: "event", match: "Signup" })).status, role === "member" ? 201 : 403);
    const mcp = await (await json(session, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sites", arguments: {} } })).json() as any;
    assert.ok(JSON.stringify(mcp).includes('alpha.example'));
    assert.ok(!JSON.stringify(mcp).includes('beta.example'));
    assert.ok(!JSON.stringify(mcp).includes('"Beta"'));
  });
}


test("deleting a site from a signed-in browser requires the current password and throttles guessing", async () => {
  const rl = runlight({ store: freshStore("sqlite"), managedSites: true, secret: "k".repeat(64) });
  const { handler } = rl.routes({ token: "app-token", accounts: true });
  const password = "a long password";
  const owner = cookieOf(await handler(req("/runlight/setup", form({ code: "app-token", email: "owner@example.com", password, again: password }))));
  const site = await rl.addSite({ name: "Delete test", hostnames: ["delete.example"] });
  const remove = (value: unknown, headers: Record<string, string> = { cookie: owner, "content-type": "application/json" }) => handler(req(`/runlight/api/sites/${site.id}`, { method: "DELETE", headers, body: JSON.stringify(value) }));
  assert.equal((await remove({})).status, 400);
  assert.equal((await remove({ password: "incorrect" })).status, 400);
  assert.equal((await remove({ password }, { cookie: owner, "content-type": "text/plain" })).status, 415);
  assert.ok(rl.site(site.id));
  assert.equal((await remove({ password })).status, 200);
  assert.equal(rl.site(site.id), null);
  const again = await rl.addSite({ name: "Delete test", hostnames: ["delete.example"] });
  assert.equal(again.id, site.id);
  for (let i = 0; i < 8; i++) assert.equal((await remove({ password: "incorrect" })).status, 400);
  assert.equal((await remove({ password })).status, 429);
  assert.ok(rl.site(site.id));
  assert.equal((await remove({}, { authorization: "Bearer app-token", "content-type": "application/json" })).status, 200);
});

for (const kind of STORES) {
  test(`${kind}: deleting a site removes the accounts and invitations kept to it, and no one else`, async () => {
    const store = freshStore(kind);
    const { Accounts } = await import("../src/accounts/auth.js");
    const now = Date.UTC(2026, 9, 14, 12);
    await store.migrate();
    const accounts = new Accounts(store, "a server secret long enough");
    await accounts.setPassword("owner@example.com", "a long password", now);
    await accounts.setPassword("alpha@example.com", "a long password", now, "viewer", "alpha");
    await accounts.setPassword("beta@example.com", "a long password", now, "member", "beta");
    await accounts.invite("invited@example.com", "member", "owner@example.com", now, "alpha");
    await accounts.invite("other@example.com", "member", "owner@example.com", now, "beta");
    await accounts.forgetSite("alpha");
    assert.deepEqual((await accounts.list()).map((u) => u.email).sort(), ["beta@example.com", "owner@example.com"]);
    assert.deepEqual((await accounts.invites(now)).map((i) => i.email), ["other@example.com"]);
  });
}

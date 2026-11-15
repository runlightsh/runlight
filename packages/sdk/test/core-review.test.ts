import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { downloadRangeList } from "../src/agentcheck.js";
import { AGENT_RANGES } from "../src/data/agent-ranges.js";
import { iconLinks } from "../src/icon.js";
import { runlight } from "../src/index.js";
import { shortLinks, toNodeHandler } from "../src/node.js";
import { parsePayload } from "../src/payload.js";
import { EMAIL } from "../src/runlight.js";
import { attribute, parsePage } from "../src/sources.js";
import { sqlite } from "../src/stores/sqlite.js";
import { aiAgent, isBot, parseClient } from "../src/ua.js";
import { CHROME_MAC, setup } from "./helpers.js";

const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";

/** Runs `fn` with console.error and console.warn kept quiet, and gives back what was said. */
async function quietly(fn: () => Promise<void> | void): Promise<string[]> {
  const { error, warn } = console;
  const said: string[] = [];
  console.error = console.warn = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = error;
    console.warn = warn;
  }
  return said;
}

/** Runs `fn` with environment variables set (or, for undefined, unset), then puts them back. */
function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const before = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  const put = (all: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  put(values);
  try {
    return fn();
  } finally {
    put(before);
  }
}

const PLATFORMS = { VERCEL: undefined, NETLIFY: undefined, CF_PAGES: undefined, AWS_LAMBDA_FUNCTION_NAME: undefined, K_SERVICE: undefined, WEBSITE_SITE_NAME: undefined, FLY_APP_NAME: undefined, RENDER: undefined, RAILWAY_ENVIRONMENT: undefined, DENO_DEPLOYMENT_ID: undefined, DYNO: undefined };

test("a database that is down never fails the app's own requests through the link middleware", async () => {
  const t = setup("sqlite", { site: { hostnames: ["example.com"] } });
  await t.rl.init();
  const linkDomains = t.rl.store.linkDomains.bind(t.rl.store);
  let asked = 0;
  t.rl.store.linkDomains = async () => {
    asked++;
    throw new Error("db down");
  };
  const middleware = shortLinks(t.rl);
  const through = (method: string, url: string) =>
    new Promise<string>((resolve) => void middleware({ method, url, headers: { host: "example.com" }, socket: { remoteAddress: "203.0.113.9" } } as unknown as IncomingMessage, {} as ServerResponse, (e) => resolve(e ? `error: ${(e as Error).message}` : "next")));
  const said = await quietly(async () => {
    assert.equal(await t.rl.linkDomainResponse(new Request("https://example.com/about")), null, "the request is the app's");
    assert.equal(await through("GET", "/about"), "next");
    assert.equal(await through("POST", "/form"), "next");
  });
  assert.equal(asked, 1, "and the database is not asked again on every request");
  assert.ok(said.some((line) => line.includes("could not read the link domains")));
  t.advance(6_000);
  t.rl.store.linkDomains = linkDomains;
  assert.equal(await through("GET", "/about"), "next", "it is asked again a few seconds later");
  assert.equal(await through("TRACE", "/about"), "next", "a method a fetch Request cannot carry is the app's, not an error");
});

test("link clicks and AI agent fetches are limited per address, as tracker hits are", async () => {
  const t = setup("sqlite", { site: { hostnames: ["example.com"] }, rateLimit: 2 });
  await t.rl.links.create("default", { url: "https://dest.example/", slug: "promo" });
  const follow = t.rl.linkHandler();
  for (let i = 0; i < 4; i++) {
    const answer = await follow(new Request("https://example.com/go/promo", { headers: { "user-agent": `${CHROME_MAC} v${i}` } }), { ip: "203.0.113.9" });
    assert.equal(answer.status, 302, "a click past the limit still redirects");
  }
  const clicks = await t.rl.store.db.all(`SELECT COUNT(*) AS n FROM rl_events WHERE kind = 'click'`);
  assert.equal(Number(clicks[0]!.n), 2, "and is not counted");

  // Fetches get ten times the limit, each address on its own; a log reader's report is not limited.
  const seen = (ip: string, extra: { agentIp?: string } = {}) => t.rl.observe(new Request("https://example.com/post", { headers: { "user-agent": GPTBOT } }), undefined, { ip, ...extra });
  let recorded = 0;
  for (let i = 0; i < 25; i++) if (await seen("203.0.113.9")) recorded++;
  assert.equal(recorded, 20);
  assert.equal(await seen("203.0.113.10"), true);
  assert.equal(await seen("203.0.113.9", { agentIp: "" }), true);
});

test("without a connection address, forwarding headers count on a hosting platform or outside production only", async () => {
  const forwarded = new Request("https://example.com/e", { headers: { "x-forwarded-for": "8.8.4.4", "x-vercel-ip-country": "DE" } });
  const make = (env: Record<string, string | undefined>, options = {}) => withEnv({ ...PLATFORMS, ...env }, () => runlight({ store: sqlite({ path: ":memory:" }), ...options }));
  const said = await quietly(() => {
    const own = make({ NODE_ENV: "production" });
    assert.equal(own.clientIp(forwarded), "", "a production server of its own does not believe a header anyone could write");
    assert.equal(own.clientIp(forwarded), "");
    assert.equal(own.clientIp(forwarded, { ip: "10.0.0.2" }), "8.8.4.4", "a proxy on a private network is believed as before");
    assert.equal(make({ NODE_ENV: "production", VERCEL: "1" }).clientIp(forwarded), "8.8.4.4", "a hosting platform's proxy is the only way in");
    assert.equal(make({ NODE_ENV: "production" }, { trustProxy: true }).clientIp(forwarded), "8.8.4.4", "trustProxy set on purpose is believed");
    assert.equal(make({ NODE_ENV: "production" }, { trustProxy: "x-forwarded-for" }).clientIp(forwarded), "8.8.4.4");
    assert.equal(make({ NODE_ENV: undefined }).clientIp(forwarded), "8.8.4.4", "outside production nothing changes");
  });
  assert.equal(said.filter((line) => line.includes("no connection address")).length, 1, "said once, with what to set");
});

test("a forwarded address is read without its port", () => {
  const rl = runlight({ store: sqlite({ path: ":memory:" }), trustProxy: true });
  const ip = (value: string) => rl.clientIp(new Request("https://example.com/e", { headers: { "x-forwarded-for": value } }));
  assert.equal(ip("203.0.113.7:51234"), "203.0.113.7");
  assert.equal(ip("198.51.100.1, 203.0.113.7:51234"), "203.0.113.7");
  assert.equal(ip("[2001:db8::1]:443"), "2001:db8::1");
  assert.equal(ip("[2001:db8::1]"), "2001:db8::1");
  assert.equal(ip("2001:db8::1"), "2001:db8::1", "a bare IPv6 address ends in a group, not a port");
  assert.equal(ip("203.0.113.7"), "203.0.113.7");
});

test("a process whose clock is behind at midnight does not delete the new day's salt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-salt-"));
  try {
    const midnight = Date.UTC(2026, 10, 15);
    let a = midnight - 500;
    let b = midnight + 500;
    const A = runlight({ store: sqlite({ path: join(dir, "a.db") }), now: () => a });
    const B = runlight({ store: sqlite({ path: join(dir, "a.db") }), now: () => b });
    const hit = (id: string) => B.collect(new Request("https://example.com/runlight/e", { method: "POST", headers: { "user-agent": CHROME_MAC }, body: JSON.stringify({ k: "pageview", u: `https://example.com/${id}`, i: id }) }), { ip: "203.0.113.9" });
    await hit("p1");
    await A.check();
    const days = (await B.store.db.all<{ day: string }>(`SELECT day FROM rl_salts ORDER BY day`)).map((r) => r.day);
    assert.ok(days.includes("2026-11-15"), "the day that began elsewhere keeps its salt");
    a += 60_000;
    b += 60_000;
    await B.check();
    await hit("p2");
    const visits = await B.store.db.all(`SELECT visitor, pageviews FROM rl_sessions`);
    assert.equal(visits.length, 1, "so one visitor stays one visitor");
    assert.equal(Number(visits[0]!.pageviews), 2);
    // The day before still goes, once no process needs it.
    a = b = midnight + 2 * 86_400_000;
    await A.check();
    assert.deepEqual((await B.store.db.all<{ day: string }>(`SELECT day FROM rl_salts`)).map((r) => r.day), ["2026-11-17"]);
    await A.store.close();
    await B.store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an AI agent fetch believes a forwarded host only as a tracker hit does, and keeps the host it was counted for", async () => {
  const t = setup("sqlite", { sites: [{ id: "a", hostnames: ["a.com"] }, { id: "b", hostnames: ["b.com"] }] });
  const fetch = (ip: string) => t.rl.observe(new Request("http://a.com/page", { headers: { "user-agent": GPTBOT, host: "a.com", "x-forwarded-host": "b.com" } }), undefined, { ip });
  await quietly(async () => {
    assert.equal(await fetch("8.8.8.8"), true);
    assert.equal(await fetch("10.0.0.2"), true);
  });
  const rows = await t.rl.store.db.all(`SELECT site, hostname FROM rl_events WHERE kind = 'fetch' ORDER BY site`);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ site: "a", hostname: "a.com" }, { site: "b", hostname: "b.com" }], "a public address cannot name another site; a proxy can");
});

test("an AI agent fetch takes its user agent as text, so a logged one that no header can hold is still read", async () => {
  const t = setup("sqlite", { site: { hostnames: ["example.com"] } });
  assert.equal(await t.rl.observe(new Request("https://example.com/post"), undefined, { agentIp: "", userAgent: "GPTBot/1.0 日本\nx" }), true);
  const sent = await t.routes.POST(
    new Request("https://example.com/runlight/api/observe", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ fetches: [{ url: "https://example.com/a", userAgent: "GPTBot/1.0 日本" }, { url: "https://example.com/b", userAgent: "ClaudeBot/1.0" }] }),
    }),
  );
  assert.equal(sent.status, 200);
  assert.equal(((await sent.json()) as { recorded: number }).recorded, 2);
});

test("stored text has no NUL and no half character, and is cut by character", () => {
  const payload = (body: Record<string, unknown>) => parsePayload(JSON.stringify({ k: "event", u: "https://example.com/", n: "Signup", ...body }))!;
  assert.equal(payload({ t: "a\u0000b" }).title, "ab");
  assert.equal(payload({ l: "en\u0000" }).language, "en");
  assert.equal(payload({ n: " Sign\u0000up " }).name, "Signup");
  assert.equal(payload({ t: "a\ud83db" }).title, "a�b", "half a surrogate pair is no character");
  assert.equal(payload({ t: "a\ude00b" }).title, "a�b");
  assert.equal(payload({ t: "ok 😀" }).title, "ok 😀", "a whole one is kept");

  const props = payload({ p: { [`k\u0000${"😀".repeat(70)}`]: `${"x".repeat(499)}😀y`, "\u0000": "gone", half: "\ud83d" } }).props!;
  const [key] = Object.keys(props);
  assert.equal(Array.from(key!).length, 60, "a key is 60 characters");
  assert.ok(key!.startsWith("k😀") && key!.endsWith("😀"));
  assert.equal(props[key!], `${"x".repeat(499)}😀`, "an emoji at the 500th character is kept whole");
  assert.equal(props.half, "�");
  assert.equal(Object.keys(props).length, 2, "a key that is only NUL is no key");

  const page = parsePage(new URL("https://example.com/?utm_source=a%00b&utm_campaign=%ED%A0%BD&ref=x"));
  assert.equal(page.utm.source, "ab");
  assert.ok(!/[\ud800-\udfff]/.test(page.utm.campaign));
});

test("utm_source=kit is Kit, as its click tracker is", () => {
  const visit = (url: string) => attribute(parsePage(new URL(url)), "", []);
  assert.deepEqual([visit("https://example.com/?utm_source=kit").source, visit("https://example.com/?utm_source=ConvertKit").source], ["Kit", "Kit"]);
  assert.equal(visit("https://example.com/?utm_source=kit").channel, "Email");
  assert.equal(visit("https://example.com/?utm_source=newsletter").source, "Newsletter");
});

test("a downloaded address list stands in for the shipped one only while it is newer", async () => {
  const url = "https://openai.com/gptbot.json";
  const inList = AGENT_RANGES.lists[url]![0]!.split("/")[0]!;
  const shipped = Date.parse(AGENT_RANGES.fetchedAt);
  const check = async (saved: unknown, at: number) => {
    const t = setup("sqlite", { site: { hostnames: ["example.com"] }, now: () => at });
    await t.rl.init();
    await t.rl.store.setSetting("agent-ranges", JSON.stringify(saved));
    await t.rl.check();
    await t.rl.observe(new Request("https://example.com/post", { headers: { "user-agent": GPTBOT } }), undefined, { agentIp: inList });
    return String((await t.rl.store.db.all(`SELECT title FROM rl_events WHERE kind = 'fetch'`))[0]!.title);
  };
  const elsewhere = { [url]: ["192.0.2.0/24"] };
  const now = shipped + 30 * 86_400_000;
  assert.equal(await check({ at: shipped - 86_400_000, lists: elsewhere }, now), "verified", "a copy saved before this version's lists were made is left aside");
  assert.equal(await check({ at: now, lists: elsewhere, fetched: { [url]: shipped - 86_400_000 } }, now), "verified", "and so is one list that has not downloaded since");
  assert.equal(await check({ at: now, lists: elsewhere }, now), "mismatch", "a newer copy is used");
  assert.equal(await check({ at: now, lists: elsewhere, fetched: { [url]: now } }, now), "mismatch");
});

test("a published list that never ends is not read to the end", async () => {
  const real = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          sent++;
          controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
        },
      }),
    )) as typeof fetch;
  try {
    assert.equal(await downloadRangeList("https://lists.example/bots.json"), null);
    assert.ok(sent < 16, `read ${sent} MB of a list that can be 4 MB at most`);
  } finally {
    globalThis.fetch = real;
  }
});

test("the Node adapter never lets the request target name the host", async () => {
  const seen: string[] = [];
  const handler = toNodeHandler(async (request) => {
    seen.push(request.url);
    return new Response("{}", { headers: { "content-type": "application/json" } });
  });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const ask = (method: string, path: string) =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { host: "stats.example.com" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });
  try {
    await ask("GET", "//evil.example/oauth/authorize?x=1");
    await ask("GET", "/\\evil.example/oauth/authorize");
    await ask("GET", "/runlight/api/sites?a=1");
    assert.deepEqual(
      seen.map((url) => new URL(url).host),
      ["stats.example.com", "stats.example.com", "stats.example.com"],
    );
    assert.equal(new URL(seen[0]!).pathname, "//evil.example/oauth/authorize");
    assert.equal(seen[2], "http://stats.example.com/runlight/api/sites?a=1");
    assert.equal(await ask("TRACE", "/runlight/api/sites"), 405, "a method a fetch Request cannot carry is refused, not an error");
    assert.equal(seen.length, 3);
  } finally {
    server.close();
  }
});

test("a long user agent, a page of unclosed tags, and a long address are read in no time", () => {
  const started = Date.now();
  const long = `Mozilla/5.0 Version/${"1".repeat(60_000)}`;
  assert.equal(parseClient(long).browser, "Other");
  assert.equal(parseClient(`${"Version/1 ".repeat(6_000)}`, { brands: "x".repeat(60_000), platform: `"${"y".repeat(60_000)}"` }).os.length <= 512, true);
  assert.equal(isBot(`${CHROME_MAC} ${"a".repeat(60_000)} bot/1`), false, "nothing past the first 512 characters is read");
  assert.equal(aiAgent(`${"a".repeat(600)} GPTBot`), null);
  assert.equal(aiAgent(GPTBOT)?.name, "GPTBot");
  assert.equal(parseClient("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1.1 Safari/605.1.15").browserVersion, "18");
  assert.equal(parseClient("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18 Safari/605.1.15").browser, "Safari");
  assert.deepEqual(iconLinks("<link ".repeat(33_000), "https://example.com/"), []);
  assert.deepEqual(iconLinks(`<link rel="icon" href="/a.png"><link rel=apple-touch-icon href=/b.png>`, "https://example.com/"), ["https://example.com/b.png", "https://example.com/a.png"]);
  assert.equal(EMAIL.test(`${"a@".repeat(40_000)}b.co`), false);
  assert.equal(EMAIL.test(`${"a".repeat(310)}@example.com`), false, "an address is 320 characters at most");
  assert.equal(EMAIL.test("reports@example.com"), true);
  assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
});

test("a connected install's answer is checked before anything is saved", async () => {
  let answer: unknown = { sites: [{ id: "shop", name: 5, hostnames: ["shop.example.com"], timezone: "UTC" }] };
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url?.endsWith("/api/sites") ? answer : {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/runlight`;
  try {
    const hub = runlight({ store: sqlite({ path: ":memory:" }), managedSites: true, localInstalls: true });
    await assert.rejects(hub.addSite({ remote: { url, token: "t" } }), /did not answer like a Runlight install/);
    assert.equal((await hub.store.sites()).length, 0, "nothing was saved");
    assert.equal((await hub.store.settingsStartingWith("remote:")).length, 0);
    answer = { sites: [{ id: "shop", name: "", hostnames: [""], timezone: "UTC" }] };
    const site = await hub.addSite({ remote: { url, token: "t" } });
    assert.match(site.id, /^127\.0\.0\.1/, "an empty hostname is none, so the id comes from the address");
    assert.ok(site.name);
    assert.equal(hub.site(site.id)?.id, site.id);
  } finally {
    server.close();
  }
});

test("collect resolves when the store cannot take the hit", async () => {
  const t = setup("sqlite", { site: { hostnames: ["example.com"] } });
  await t.rl.init();
  t.rl.store.insertEvent = async () => {
    throw new Error("disk full");
  };
  const said = await quietly(() => t.rl.collect(new Request("https://example.com/runlight/e", { method: "POST", headers: { "user-agent": CHROME_MAC }, body: JSON.stringify({ k: "pageview", u: "https://example.com/" }) })));
  assert.ok(said.some((line) => line.includes("could not record an event") && line.includes("disk full")));
});

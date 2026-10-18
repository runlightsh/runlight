import assert from "node:assert/strict";
import { test } from "node:test";
import { runlight } from "../src/index.js";
import { SqlStore } from "../src/store.js";
import { ClickHouseStore, bindPlaceholders, clickhouse, clickhouseDb, limiter, plainAcross } from "../src/stores/clickhouse.js";
import { sqlite } from "../src/stores/sqlite.js";
import { CHROME_MAC, SAFARI_IPHONE } from "./helpers.js";

test("ClickHouse placeholders are typed by their values, outside quotes only", () => {
  const bound = bindPlaceholders("SELECT ? WHERE a = '?' AND b = ? AND c = 'it\\'s ?' AND d IN (?, ?) AND e = ?", [1, "x\ty", 2.5, null, true]);
  assert.equal(bound.sql, "SELECT {p0:Int64} WHERE a = '?' AND b = {p1:String} AND c = 'it\\'s ?' AND d IN ({p2:Float64}, {p3:Nullable(String)}) AND e = {p4:Bool}");
  assert.deepEqual(bound.values, { p0: "1", p1: "x\\ty", p2: "2.5", p3: "\\N", p4: "true" });
  assert.throws(() => bindPlaceholders("SELECT ?, ?", [1]), /more placeholders than values/);
});

test("plain http:// to ClickHouse is warned about only when it may cross the internet", () => {
  const across = (url: string) => plainAcross(new URL(url));
  for (const url of ["http://u:p@clickhouse.example.com:8123/runlight", "http://93.184.215.14:8123/", "http://[2001:4860::1]:8123/"]) assert.equal(across(url), true, url);
  for (const url of ["https://clickhouse.example.com:8443/", "http://clickhouse:8123/runlight", "http://localhost:8123/", "http://127.0.0.1:8123/", "http://10.0.0.5:8123/", "http://192.168.1.2:8123/", "http://[::1]:8123/", "http://db.internal:8123/", "http://box.local:8123/"]) {
    assert.equal(across(url), false, url);
  }
});

test("a lane of queries turns work away past its queue or its wait, as busy, so a hit waits rather than piling up", async () => {
  const lane = limiter(1, 1, 50);
  let open!: () => void;
  const first = lane(() => new Promise<string>((resolve) => (open = () => resolve("first"))));
  const second = lane(async () => "second");
  // The one running and the one waiting fill the lane: a third is turned away at once.
  await assert.rejects(lane(async () => "third"), /ClickHouse is busy: 1 queries are waiting/);
  // The one waiting gives up when its turn has not come in time.
  await assert.rejects(second, /ClickHouse is busy: a query waited 0 s for its turn/);
  open();
  assert.equal(await first, "first");
  assert.equal(await lane(async () => "after"), "after");
  // Both read as ClickHouse being busy, so a hit turned away waits for it rather than being lost.
  const store = clickhouse({ url: "http://localhost:1/runlight", store: sqlite({ path: ":memory:" }) });
  assert.equal(store.waitable(new Error("Runlight: ClickHouse is busy: 20000 queries are waiting")), true);
  assert.equal(store.waitable(new Error("Runlight: no such column")), false);
});

test("every store method that reads or writes visits or events has its ClickHouse version", () => {
  // A method whose SQL names the visit tables, or that builds on the helpers that do, would otherwise read
  // the other store's tables, which ClickHouse leaves empty. Methods that only clear rollups, and private
  // helpers called only from methods ClickHouseStore has its own of, are left be.
  const visitSql = /rl_sessions|rl_events|rl_rollups|rl_rollup_days|visitRows\(|visitScope\(|rolledStats\(|rolledBreakdown\(|rollupPlan\(/;
  const leftBe = new Set(["constructor", "clearRollups", "touchedOldVisit", "rollupPlan", "rolledStats", "rolledBreakdown", "oldest", "optimize", "deleteGoal", "migrate", "rawGoalTotalsAll"]);
  const missing: string[] = [];
  for (const name of Object.getOwnPropertyNames(SqlStore.prototype)) {
    if (leftBe.has(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(SqlStore.prototype, name)!;
    if (typeof descriptor.value !== "function") continue;
    if (!visitSql.test(String(descriptor.value))) continue;
    if (!Object.hasOwn(ClickHouseStore.prototype, name)) missing.push(name);
  }
  assert.deepEqual(missing, [], "Add these to ClickHouseStore, or to the list above if they never touch visits");
});

const CLICKHOUSE = process.env.RUNLIGHT_TEST_CLICKHOUSE;

/** A ClickHouse database of its own, made and dropped by the test. */
async function own(t: { after(fn: () => Promise<void>): void }, url = CLICKHOUSE!) {
  const at = new URL(url);
  at.pathname = `/rl_test_${Math.random().toString(36).slice(2, 10)}`;
  const store = clickhouse({ url: at.href, store: sqlite({ path: ":memory:" }) });
  t.after(async () => {
    await store.close().catch(() => {});
    await clickhouseDb({ url: at.href.replace(/\/\/[^@]*@/, `//${new URL(CLICKHOUSE!).username}:${new URL(CLICKHOUSE!).password}@`) }).dropDatabase();
  });
  return { store, url: at };
}

test("ClickHouse counts distinct values exactly below about 4,000, as the docs say", { skip: !CLICKHOUSE }, async (t) => {
  const { store } = await own(t);
  await store.migrate();
  const [row] = await store.clickhouse.all<{ a: unknown; b: unknown }>(`SELECT COUNT(DISTINCT number) AS a, (SELECT COUNT(DISTINCT number) FROM numbers(4000)) AS b FROM numbers(1000)`);
  assert.deepEqual([Number(row?.a), Number(row?.b)], [1000, 4000]);
});

test("an error ClickHouse sends after the first rows fails the query rather than reading as a row", { skip: !CLICKHOUSE }, async (t) => {
  const { store } = await own(t);
  await store.migrate();
  await assert.rejects(
    store.clickhouse.all(`SELECT throwIf(number = 200000, 'stopped part way') AS x FROM numbers(300000) SETTINGS max_block_size = 1000, http_response_buffer_size = 1`),
    /stopped part way/,
  );
});

test("the pages report adds up engaged time the same in slices as in one query", { skip: !CLICKHOUSE }, async (t) => {
  const { store } = await own(t);
  const now = Date.now();
  const rl = runlight({ store, site: { hostnames: ["example.com"], timezone: "UTC" }, now: () => now });
  const routes = rl.routes({ token: null });
  for (let i = 0; i < 12; i++) {
    const headers = { "user-agent": CHROME_MAC, "x-forwarded-for": `203.0.113.${i + 1}` };
    const send = (body: Record<string, unknown>) => routes.POST(new Request("https://example.com/runlight/e", { method: "POST", body: JSON.stringify(body), headers }));
    await send({ k: "pageview", u: `https://example.com/p${i % 3}`, i: `v${i}` });
    await send({ k: "engagement", u: `https://example.com/p${i % 3}`, i: `v${i}`, e: 5_000 * (i + 1) });
  }
  const pages = async () => (await (await routes.GET(new Request("https://example.com/runlight/api/breakdown?period=7d&compare=off&dimension=page"))).json()).rows;
  const whole = await pages();
  assert.ok(whole.every((r: { timeOnPage: number }) => r.timeOnPage > 0));
  store.visits.engagedPerSlice = 2;
  assert.deepEqual(await pages(), whole);
});

/** Two dozen visits over two hosts, four pages, four sources, two devices, and two events, through the tracker. */
async function traffic(store: SqlStore) {
  // A second between hits, so a visit's first page is the one that came first in every store.
  let now = Date.now() - 3_600_000;
  const rl = runlight({ store, site: { hostnames: ["example.com", "docs.example.com"], timezone: "UTC" }, now: () => now });
  const routes = rl.routes({ token: null });
  const referrers = ["https://www.google.com/", "https://news.ycombinator.com/", "", "https://www.bing.com/"];
  for (let i = 0; i < 24; i++) {
    const headers = { "user-agent": i % 3 ? CHROME_MAC : SAFARI_IPHONE, "x-forwarded-for": `203.0.113.${i + 1}` };
    const send = (body: Record<string, unknown>) => ((now += 1_000), routes.POST(new Request("https://example.com/runlight/e", { method: "POST", body: JSON.stringify(body), headers })));
    const host = i % 5 ? "example.com" : "docs.example.com";
    await send({ k: "pageview", u: `https://${host}/p${i % 4}${i % 7 ? "" : "?utm_campaign=launch"}`, r: referrers[i % 4], i: `a${i}` });
    await send({ k: "engagement", u: `https://${host}/p${i % 4}`, i: `a${i}`, e: 1_000 * (i + 1) });
    if (i % 2) await send({ k: "pageview", u: `https://example.com/p${(i + 1) % 4}`, i: `b${i}` });
    if (i % 3) await send({ k: "event", u: `https://example.com/p${i % 4}`, i: `a${i}`, n: i % 2 ? "Signup" : "Download" });
  }
  return { rl, routes };
}

test("a lone page or hostname filter, read once on ClickHouse, counts the visits and their pageviews as SQLite does", { skip: !CLICKHOUSE }, async (t) => {
  const { store } = await own(t);
  const clickhouseRoutes = (await traffic(store)).routes;
  const sqliteRoutes = (await traffic(sqlite({ path: ":memory:" }))).routes;
  const filters = [["page:is:/p1"], ["page:contains:P2"], ["hostname:is:docs.example.com"], ["page:is:/p1", "channel:is:Organic Search"], ["page:contains:p", "device:not:mobile"], ["page:not:/p0"], ["page:is:/p1", "event:is:Signup"]];
  for (const f of filters) {
    for (const path of ["stats", "series", "rhythm", "breakdown&dimension=source", "breakdown&dimension=entry", "breakdown&dimension=device"]) {
      const q = new URLSearchParams({ period: "7d", compare: "off" });
      for (const one of f) q.append("filter", one);
      const url = `https://example.com/runlight/api/${path.replace("&", `?${q}&`)}${path.includes("&") ? "" : `?${q}`}`;
      const read = async (routes: typeof sqliteRoutes) => (await routes.GET(new Request(url))).json();
      assert.deepEqual(await read(clickhouseRoutes), await read(sqliteRoutes), `${path} ${f.join(" ")}`);
    }
  }
});

test("filtered pages, hosts, and events read from the visits' columns on the events give the same answers as through the visits", { skip: !CLICKHOUSE }, async (t) => {
  const { store } = await own(t);
  const { rl, routes } = await traffic(store);
  const filters = [
    ["channel:is:Organic Search"], ["channel:not:Direct"], ["source:contains:goo"], ["device:is:mobile"], ["utm_campaign:is:launch"],
    ["page:is:/p1"], ["page:is:/p1", "channel:is:Organic Search"], ["page:contains:p2", "browser:not:Safari"], ["hostname:is:docs.example.com"],
    ["event:is:Signup"], ["event:is:Signup", "device:is:desktop"],
    // These still go through the visits: a "not" on the rows read, two filters on one, and the entry page.
    ["page:not:/p0"], ["page:is:/p1", "page:is:/p2"], ["entry:is:/p3"], ["event:is:Signup", "page:is:/p1"],
  ];
  const report = async (dimension: string, f: string[]) => {
    const q = new URLSearchParams({ period: "7d", compare: "off", dimension });
    for (const one of f) q.append("filter", one);
    return (await (await routes.GET(new Request(`https://example.com/runlight/api/breakdown?${q}`))).json()).rows;
  };
  const answers = async () => {
    const out: Array<[string[], string, unknown[]]> = [];
    for (const f of filters) for (const dimension of ["page", "hostname", "event"]) out.push([f, dimension, await report(dimension, f)]);
    return out;
  };
  await rl.init();
  assert.equal(store.visits.carriedFrom, 0);
  const carried = await answers();
  store.visits.carriedFrom = null;
  assert.deepEqual(carried, await answers());
  assert.ok(carried.some(([, , rows]) => rows.length > 0));
});

test("a ClickHouse made before events carried their visits' columns gets them, and reads older visits as before", { skip: !CLICKHOUSE }, async (t) => {
  const { store, url } = await own(t);
  await store.migrate();
  for (const col of ["channel", "country"]) await store.clickhouse.run(`ALTER TABLE rl_events DROP COLUMN visit_${col}`);
  const meta = (key: string, value: string) => store.clickhouse.insert("rl_meta", [{ key, value, at: Date.now() + 1_000 }], { batched: true });
  await meta("schema", "1");
  const before = Date.now();
  const again = clickhouse({ url: url.href, store: sqlite({ path: ":memory:" }) });
  t.after(() => again.close());
  await again.migrate();
  const columns = await again.clickhouse.all<{ name: string }>(`SELECT name FROM system.columns WHERE database = currentDatabase() AND table = 'rl_events' AND name IN ('visit_channel', 'visit_country')`);
  assert.equal(columns.length, 2);
  assert.ok(again.visits.carriedFrom! >= before);
});

test("a ClickHouse user granted only its own database, as the docs list, can start and copy back", { skip: !CLICKHOUSE }, async (t) => {
  const admin = clickhouseDb({ url: CLICKHOUSE! });
  const name = `rl_test_${Math.random().toString(36).slice(2, 10)}`;
  const user = `${name}_user`;
  await admin.run(`CREATE DATABASE ${name}`);
  await admin.run(`CREATE USER ${user} IDENTIFIED WITH plaintext_password BY 'pw'`);
  t.after(async () => {
    await admin.run(`DROP USER IF EXISTS ${user}`);
    await admin.run(`DROP DATABASE IF EXISTS ${name}`);
  });
  await admin.run(`GRANT CREATE TABLE, CREATE VIEW, INSERT, SELECT, ALTER DELETE, ALTER UPDATE, OPTIMIZE, TRUNCATE ON ${name}.* TO ${user}`);
  const url = new URL(CLICKHOUSE!);
  url.username = user;
  url.password = "pw";
  url.pathname = `/${name}`;
  const rows = sqlite({ path: ":memory:" });
  const store = clickhouse({ url: url.href, store: rows });
  const rl = runlight({ store, site: { hostnames: ["example.com"], timezone: "UTC" } });
  await rl.init();
  const routes = rl.routes({ token: null });
  await routes.POST(new Request("https://example.com/runlight/e", { method: "POST", body: JSON.stringify({ k: "pageview", u: "https://example.com/", i: "a" }), headers: { "user-agent": CHROME_MAC } }));
  const errors: unknown[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    await store.optimize();
    await store.dropBefore("default", Date.now() - 86_400_000);
    await store.copyBack();
  } finally {
    console.error = log;
  }
  assert.deepEqual(errors, []);
  const [row] = await rows.db.all<{ n: unknown }>(`SELECT COUNT(*) AS n FROM rl_sessions`);
  assert.equal(Number(row?.n), 1);
});

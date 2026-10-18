import assert from "node:assert/strict";
import { test } from "node:test";
import { runlight } from "../src/index.js";
import { SqlStore } from "../src/store.js";
import { ClickHouseStore, bindPlaceholders, clickhouse, clickhouseDb } from "../src/stores/clickhouse.js";
import { sqlite } from "../src/stores/sqlite.js";
import { CHROME_MAC } from "./helpers.js";

test("ClickHouse placeholders are typed by their values, outside quotes only", () => {
  const bound = bindPlaceholders("SELECT ? WHERE a = '?' AND b = ? AND c = 'it\\'s ?' AND d IN (?, ?) AND e = ?", [1, "x\ty", 2.5, null, true]);
  assert.equal(bound.sql, "SELECT {p0:Int64} WHERE a = '?' AND b = {p1:String} AND c = 'it\\'s ?' AND d IN ({p2:Float64}, {p3:Nullable(String)}) AND e = {p4:Bool}");
  assert.deepEqual(bound.values, { p0: "1", p1: "x\\ty", p2: "2.5", p3: "\\N", p4: "true" });
  assert.throws(() => bindPlaceholders("SELECT ?, ?", [1]), /more placeholders than values/);
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

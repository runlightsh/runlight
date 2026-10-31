import assert from "node:assert/strict";
import { after, test } from "node:test";
import { runlight } from "../src/index.js";
import type { SqlStore } from "../src/store.js";
import { ClickHouseStore, clickhouse } from "../src/stores/clickhouse.js";
import { sqlite } from "../src/stores/sqlite.js";
import { CHROME_MAC } from "./helpers.js";

const CLICKHOUSE = process.env.RUNLIGHT_TEST_CLICKHOUSE;
const SITE = { site: { hostnames: ["example.com"], timezone: "UTC" } };

/** A ClickHouse database of its own over `rows`, dropped after the test. */
function switched(rows: SqlStore): ClickHouseStore {
  const url = new URL(CLICKHOUSE!);
  url.pathname = `/rl_test_${Math.random().toString(36).slice(2, 10)}`;
  const store = clickhouse({ url: url.href, store: rows });
  after(() => store.clickhouse.dropDatabase());
  return store;
}

/** Makes every request to ClickHouse fail as an unreachable one does, until the returned function is called. */
function down(store: ClickHouseStore): () => void {
  const db = store.clickhouse;
  const kept = { all: db.all, run: db.run, lookup: db.lookup, insert: db.insert, mutate: db.mutate };
  const refuse = async () => {
    throw new Error("Runlight: could not reach ClickHouse at localhost:8123 (ECONNREFUSED)");
  };
  Object.assign(db, { all: refuse, run: refuse, lookup: refuse, insert: refuse, mutate: refuse });
  return () => Object.assign(db, kept);
}

function server(store: SqlStore, clock: { now: number }) {
  const rl = runlight({ store, now: () => clock.now, ...SITE });
  const routes = rl.routes({ token: null });
  return {
    rl,
    async send(body: Record<string, unknown>, ip: string) {
      const response = await routes.POST(new Request("https://example.com/runlight/e", { method: "POST", body: JSON.stringify(body), headers: { "user-agent": CHROME_MAC, "x-forwarded-for": ip } }));
      assert.equal(response.status, 202);
    },
    async get(path: string): Promise<any> {
      return (await routes.GET(new Request(`https://example.com/runlight/api/${path}`))).json();
    },
  };
}

/** Three visitors, each with two pageviews, an event, and engaged time, a minute apart. */
async function visits(s: ReturnType<typeof server>, clock: { now: number }) {
  for (let person = 1; person <= 3; person++) {
    const ip = `203.0.113.${person}`;
    await s.send({ k: "pageview", u: `https://example.com/?utm_source=news${person}`, i: `p${person}a`, r: "https://news.example.org/" }, ip);
    clock.now += 60_000;
    await s.send({ k: "pageview", u: "https://example.com/pricing", i: `p${person}b` }, ip);
    await s.send({ k: "event", u: "https://example.com/pricing", n: "Signup", i: `p${person}b` }, ip);
    await s.send({ k: "engagement", u: "https://example.com/pricing", i: `p${person}b`, e: 20_000 * person }, ip);
    clock.now += 60_000;
  }
}

const REPORTS = ["stats?period=7d&compare=off", "breakdown?period=7d&compare=off&dimension=page", "breakdown?period=7d&compare=off&dimension=source", "breakdown?period=7d&compare=off&dimension=event"];

test("hits that come while ClickHouse is down wait in the other store and count the same once it is back", { skip: !CLICKHOUSE }, async () => {
  const start = Date.now() - 3_600_000;
  // One clock for both, so that a run just after midnight asks both for the same days.
  const clock = { now: start };
  const plain = server(sqlite({ path: ":memory:" }), clock);
  await visits(plain, clock);

  const rows = sqlite({ path: ":memory:" });
  const store = switched(rows);
  clock.now = start;
  const s = server(store, clock);
  await s.rl.init();
  const up = down(store);
  await visits(s, clock);
  const [waiting] = await rows.db.all<{ n: unknown }>(`SELECT COUNT(*) AS n FROM rl_waiting_hits`);
  assert.equal(Number(waiting?.n), 12);
  // Nothing waits as anything but the hit itself: no address and no user agent.
  const kept = (await rows.db.all<{ hit: string }>(`SELECT hit FROM rl_waiting_hits`)).map((r) => r.hit).join("\n");
  assert.doesNotMatch(kept, /203\.0\.113|Mozilla/);

  up();
  // Once ClickHouse is back, a new hit still queues behind the ones waiting, so a visitor's hits stay in order.
  clock.now += 60_000;
  await s.send({ k: "pageview", u: "https://example.com/docs", i: "late" }, "203.0.113.9");
  await plain.send({ k: "pageview", u: "https://example.com/docs", i: "late" }, "203.0.113.9");
  const [behind] = await rows.db.all<{ n: unknown }>(`SELECT COUNT(*) AS n FROM rl_waiting_hits`);
  assert.equal(Number(behind?.n), 13);

  await s.rl.flushWaiting();
  assert.equal((await rows.db.all(`SELECT 1 FROM rl_waiting_hits`)).length, 0);
  for (const report of REPORTS) assert.deepEqual(await s.get(report), await plain.get(report), report);
  // With none left waiting, hits go straight in again.
  await s.send({ k: "pageview", u: "https://example.com/about", i: "after" }, "203.0.113.10");
  assert.equal((await rows.db.all(`SELECT 1 FROM rl_waiting_hits`)).length, 0);
  await store.close();
});

test("a hit that waited more than a day is let go", { skip: !CLICKHOUSE }, async () => {
  const rows = sqlite({ path: ":memory:" });
  const store = switched(rows);
  const clock = { now: Date.now() - 2 * 86_400_000 };
  const s = server(store, clock);
  await s.rl.init();
  const up = down(store);
  await s.send({ k: "pageview", u: "https://example.com/", i: "old" }, "203.0.113.1");
  up();
  clock.now += 86_400_000 + 60_000;
  await s.rl.flushWaiting();
  assert.equal((await rows.db.all(`SELECT 1 FROM rl_waiting_hits`)).length, 0);
  assert.equal((await s.get("stats?period=all&compare=off")).stats.visits, 0);
  await store.close();
});

test("one process at a time sends the waiting hits", { skip: !CLICKHOUSE }, async () => {
  const rows = sqlite({ path: ":memory:" });
  const one = switched(rows);
  await one.migrate();
  const url = new URL(CLICKHOUSE!);
  url.pathname = `/${one.clickhouse.database}`;
  const two = clickhouse({ url: url.href, store: rows, copyInBackground: false });
  await one.wait(Date.now(), "{}");
  assert.equal((await one.waiting(10, 0))?.hits.length, 1);
  assert.equal(await two.waiting(10, 0), null);
  // Once the first has sent them all, it lets go, and the second sends the next ones at once.
  await one.doneWaiting((await one.waiting(10, 0))!.hits.map((h) => h.id));
  assert.deepEqual(await one.waiting(10, 0), { hits: [], left: 0 });
  await two.wait(Date.now(), "{}");
  assert.equal((await two.waiting(10, 0))?.hits.length, 1);
  await one.close();
});

test("a closed store's waiting hits are left alone, so a look on a timer after it closes reads nothing", { skip: !CLICKHOUSE }, async () => {
  const rows = sqlite({ path: ":memory:" });
  const store = switched(rows);
  await store.migrate();
  await store.wait(Date.now(), "{}");
  await store.close();
  // SQLite would open an empty database again here, and say there is no such table.
  assert.equal(await store.waiting(10, 0), null);
});

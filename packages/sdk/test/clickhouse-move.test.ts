import assert from "node:assert/strict";
import { after, test } from "node:test";
import { runlight } from "../src/index.js";
import type { SqlStore } from "../src/store.js";
import { ClickHouseStore, clickhouse } from "../src/stores/clickhouse.js";
import { CHROME_MAC, cleanup, freshStore, type StoreKind } from "./helpers.js";

after(cleanup);

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The databases a server can move from. */
const FROM: StoreKind[] = ["sqlite", ...(process.env.RUNLIGHT_TEST_PG ? (["postgres"] as const) : []), ...(process.env.RUNLIGHT_TEST_MYSQL ? (["mysql"] as const) : [])];

const SITE = { site: { hostnames: ["example.com"], timezone: "UTC" } };

/** A ClickHouse database of its own over `rows`, dropped after the test. */
function switched(rows: SqlStore, copyInBackground = true): ClickHouseStore {
  const url = new URL(process.env.RUNLIGHT_TEST_CLICKHOUSE!);
  url.pathname = `/rl_test_${Math.random().toString(36).slice(2, 10)}`;
  const store = clickhouse({ url: url.href, store: rows, copyInBackground });
  after(() => store.clickhouse.dropDatabase());
  return store;
}

/** A Runlight over `store` on a clock the test moves, which starts at the real time, as the copy reads it. */
function server(store: SqlStore, clock: { now: number }) {
  const rl = runlight({ store, now: () => clock.now, ...SITE });
  const routes = rl.routes({ token: "secret" });
  return {
    rl,
    async send(body: Record<string, unknown>, ip = "203.0.113.1") {
      const response = await routes.POST(new Request("https://example.com/runlight/e", { method: "POST", body: JSON.stringify(body), headers: { "user-agent": CHROME_MAC, "x-forwarded-for": ip } }));
      assert.equal(response.status, 202);
    },
    async get(path: string): Promise<any> {
      const response = await routes.GET(new Request(`https://example.com/runlight${path}`, { headers: { authorization: "Bearer secret" } }));
      assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
      return response.json();
    },
  };
}

/** Ten days of visits, the newest an hour ago, with events, engagement, and a visit that runs past midnight. */
async function history(s: ReturnType<typeof server>, clock: { now: number }): Promise<void> {
  const start = clock.now;
  for (let day = 10; day >= 0; day--) {
    clock.now = start - day * DAY - HOUR;
    for (let person = 1; person <= 3; person++) {
      const ip = `203.0.113.${person}`;
      const id = `d${day}p${person}`;
      await s.send({ k: "pageview", u: `https://example.com/?utm_source=news${person}`, i: `${id}a`, r: "https://news.example.org/" }, ip);
      clock.now += MIN;
      await s.send({ k: "pageview", u: `https://example.com/pricing`, i: `${id}b` }, ip);
      await s.send({ k: "event", u: "https://example.com/pricing", n: "Signup", i: `${id}b`, p: { plan: person === 1 ? "pro" : "free" } }, ip);
      await s.send({ k: "engagement", u: "https://example.com/pricing", i: `${id}b`, e: 20_000 * person }, ip);
    }
  }
  clock.now = start;
}

/** What the dashboard shows for all time, enough to tell a visit counted twice or left out. */
async function reports(s: ReturnType<typeof server>) {
  const range = "period=all&compare=off";
  return {
    stats: (await s.get(`/api/stats?${range}`)).stats,
    pages: (await s.get(`/api/breakdown?${range}&dimension=page`)).rows,
    entry: (await s.get(`/api/breakdown?${range}&dimension=entry`)).rows,
    sources: (await s.get(`/api/breakdown?${range}&dimension=source`)).rows,
    plans: (await s.get(`/api/event-props?${range}&event=Signup&key=plan`)).rows,
    series: (await s.get("/api/series?period=30d&compare=off")).points,
  };
}

async function settled(store: ClickHouseStore): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if ((await store.moveState())?.done) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the copy did not finish");
}

for (const kind of process.env.RUNLIGHT_TEST_CLICKHOUSE ? FROM : []) {
  test(`${kind}: switching to ClickHouse copies the history across, and the reports read the same`, async () => {
    const clock = { now: Date.now() };
    const rows = freshStore(kind);
    const before = server(rows, clock);
    await history(before, clock);
    const expected = await reports(before);

    const store = switched(rows);
    const after = server(store, clock);
    await after.rl.init();
    // The last two days are in before the store is ready; the dashboard says the rest are on their way.
    assert.ok((await store.counts()).clickhouse.visits >= 6);
    await settled(store);
    assert.deepEqual(await reports(after), expected);
    const counts = await store.counts();
    assert.deepEqual([counts.clickhouse.visits, counts.clickhouse.events], [counts.other.visits, counts.other.events]);
    assert.equal(await store.moving(), null);
  });

  test(`${kind}: a visit going on at the switch carries on in ClickHouse`, async () => {
    const clock = { now: Date.now() };
    const rows = freshStore(kind);
    const before = server(rows, clock);
    await before.send({ k: "pageview", u: "https://example.com/", i: "a" });
    clock.now += 5 * MIN;

    const store = switched(rows, false);
    const after = server(store, clock);
    await after.send({ k: "pageview", u: "https://example.com/pricing", i: "b" });
    await after.send({ k: "engagement", u: "https://example.com/", i: "a", e: 30_000 });
    const stats = (await after.get("/api/stats?period=today&compare=off")).stats;
    assert.deepEqual([stats.visitors, stats.visits, stats.pageviews], [1, 1, 2]);
    const exits = (await after.get("/api/breakdown?period=today&compare=off&dimension=exit")).rows.map((r: { value: string }) => r.value);
    assert.deepEqual(exits, ["/pricing"]);
  });

  test(`${kind}: a copy stopped part way carries on without counting anything twice`, async () => {
    const clock = { now: Date.now() };
    const rows = freshStore(kind);
    const before = server(rows, clock);
    await history(before, clock);
    const expected = await reports(before);

    const first = switched(rows, false);
    await first.migrate();
    let steps = 0;
    await assert.rejects(
      first.copy(() => {
        if (++steps === 3) throw new Error("stopped");
      }),
      /stopped/,
    );
    // A process stopped in the middle of the next day left some of it in ClickHouse already.
    const state = (await first.moveState())!;
    const [partial] = await rows.db.all(`SELECT * FROM rl_sessions WHERE started_at < ? ORDER BY started_at DESC LIMIT 1`, [state.through]);
    await first.clickhouse.insert("rl_visits", [{ site: partial!.site, started_at: Number(partial!.started_at), id: partial!.id, visitor: partial!.visitor, last_at: Number(partial!.last_at), pageviews: 2, entry: [Number(partial!.started_at), "/"], exit: [Number(partial!.last_at), "/pricing"] }], { batched: true });

    // Started again, once the stopped process's claim has run out.
    const again = new ClickHouseStore(rows, first.clickhouse);
    await rows.swapSetting("clickhouse-copy", (await rows.setting("clickhouse-copy"))!, JSON.stringify({ by: "", until: 0 }));
    await again.migrate();
    assert.equal((await again.copy())?.done, true);
    const after = server(again, clock);
    assert.deepEqual(await reports(after), expected);
  });

  test(`${kind}: two processes copying at once copy each visit once`, async () => {
    const clock = { now: Date.now() };
    const rows = freshStore(kind);
    const before = server(rows, clock);
    await history(before, clock);
    const expected = await reports(before);

    const one = switched(rows, false);
    const two = new ClickHouseStore(rows, one.clickhouse);
    await Promise.all([one.migrate(), two.migrate()]);
    await Promise.all([one.copy(), two.copy()]);
    assert.deepEqual(await reports(server(one, clock)), expected);
  });

  test(`${kind}: drop-old waits for the copy, then empties the old tables, and copy back brings everything home`, async () => {
    const clock = { now: Date.now() };
    const rows = freshStore(kind);
    const before = server(rows, clock);
    await history(before, clock);
    const expected = await reports(before);

    const store = switched(rows, false);
    const after = server(store, clock);
    await after.rl.init();
    assert.ok((await after.get("/api/sites")).moving.through < clock.now);
    await assert.rejects(store.dropOld(), /still being copied/);
    await assert.rejects(store.copyBack(), /still being copied/);
    await store.copy();
    assert.equal((await after.get("/api/sites")).moving, undefined);

    await store.dropOld();
    assert.deepEqual((await store.counts()).other, { visits: 0, events: 0, copied: null });
    assert.deepEqual(await reports(after), expected);

    // A visit after the switch goes back too.
    await after.send({ k: "pageview", u: "https://example.com/new", i: "n" }, "203.0.113.9");
    const withNew = await reports(after);
    await store.copyBack();
    assert.deepEqual((await store.counts()).clickhouse, { visits: 0, events: 0 });
    assert.equal(await store.moveState(), null);
    assert.deepEqual(await reports(server(rows, clock)), withNew);
  });
}

test("the old database's text columns map onto ClickHouse's", async () => {
  // The visit columns copied one way and back must be the visit columns both stores have.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  const table = source.slice(source.indexOf("CREATE TABLE IF NOT EXISTS rl_sessions ("), source.indexOf("CREATE INDEX IF NOT EXISTS rl_sessions_site_started"));
  const columns = [...table.matchAll(/(\w+) \$\{text\(/g)].map((m) => m[1]).filter((c) => c !== "entry_path" && c !== "exit_path");
  const mine = readFileSync(new URL("../src/stores/clickhouse.ts", import.meta.url), "utf8");
  const listed = mine.slice(mine.indexOf("const VISIT_TEXT = ["), mine.indexOf("] as const;", mine.indexOf("const VISIT_TEXT = [")));
  assert.deepEqual([...listed.matchAll(/"(\w+)"/g)].map((m) => m[1]), columns);
});

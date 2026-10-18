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

  test(`${kind}: a copy that loses its connection part way tries again without counting anything twice`, async () => {
    const clock = { now: Date.now() };
    const rows = freshStore(kind);
    const before = server(rows, clock);
    await history(before, clock);
    const expected = await reports(before);

    const store = switched(rows, false);
    await store.migrate();
    // The visits of an older day go in, then the connection drops before its events do.
    const insert = store.clickhouse.insert.bind(store.clickhouse);
    let inserts = 0;
    store.clickhouse.insert = async (table, batch, options) => {
      if (++inserts === 4) throw new TypeError("fetch failed", { cause: new Error("other side closed") });
      return insert(table, batch, options);
    };
    assert.equal((await store.copy())?.done, true);
    assert.ok(inserts > 4);
    assert.deepEqual(await reports(server(store, clock)), expected);
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
    assert.deepEqual((await store.counts()).other, { visits: 0, events: 0, copied: null, late: 0 });
    assert.deepEqual(await reports(after), expected);

    // A visit after the switch goes back too.
    await after.send({ k: "pageview", u: "https://example.com/new", i: "n" }, "203.0.113.9");
    const withNew = await reports(after);
    await store.copyBack();
    assert.deepEqual((await store.counts()).clickhouse, { visits: 0, events: 0 });
    assert.equal(await store.moveState(), null);
    assert.deepEqual(await reports(server(rows, clock)), withNew);
    // Run again, there is nothing to copy back, and nothing is emptied.
    await assert.rejects(store.copyBack(), /nothing to copy back/);
    assert.deepEqual(await reports(server(rows, clock)), withNew);
  });

  test(`${kind}: a copy back stopped after the other store holds everything finishes when run again`, async () => {
    const clock = { now: Date.now() };
    const rows = freshStore(kind);
    await history(server(rows, clock), clock);
    const store = switched(rows, false);
    const after = server(store, clock);
    await after.rl.init();
    await store.copy();
    await after.send({ k: "pageview", u: "https://example.com/new", i: "n" }, "203.0.113.9");
    const expected = await reports(after);

    // ClickHouse goes away just as it is being emptied.
    const run = store.clickhouse.run.bind(store.clickhouse);
    store.clickhouse.run = async (sql, params) => {
      if (sql.includes("TRUNCATE TABLE rl_events")) throw new Error("connection lost");
      return run(sql, params);
    };
    await assert.rejects(store.copyBack(), /connection lost/);
    store.clickhouse.run = run;
    // A server will not start on it half done, and running it again finishes it without emptying the other store.
    await assert.rejects(new ClickHouseStore(rows, store.clickhouse).migrate(), /being copied back/);
    await store.copyBack();
    assert.equal(await store.moveState(), null);
    assert.deepEqual(await reports(server(rows, clock)), expected);
  });

  test(`${kind}: copy back waits until no server is taking hits and no hit is waiting, and refuses an empty ClickHouse`, async () => {
    const clock = { now: Date.now() };
    const rows = freshStore(kind);
    await history(server(rows, clock), clock);
    const store = switched(rows, false);
    await store.migrate();
    await store.copy();
    // Another process, a server, is still running on it, then shuts down.
    const say = (value: string) => (store as unknown as { setMeta(key: string, value: string): Promise<void> }).setMeta("live:another", value);
    await say(String(Date.now() + 90_000));
    await assert.rejects(store.copyBack(), /still taking hits/);
    await say("0");
    // Hits still waiting for ClickHouse would never be sent once it is gone.
    await store.wait(Date.now(), "{}");
    await assert.rejects(store.copyBack(), /a hit is still waiting/);
    await store.doneWaiting((await store.waiting(10, 0))!.hits.map((h) => h.id));
    // ClickHouse emptied by hand would leave nothing to copy back but the other store to lose.
    await store.clickhouse.run("TRUNCATE TABLE rl_visits");
    await store.clickhouse.run("TRUNCATE TABLE rl_events");
    await assert.rejects(store.copyBack(), /holds no visits/);
    assert.ok((await store.counts()).other.visits > 0);
  });

  test(`${kind}: drop-old leaves the visits a server without ClickHouse wrote after the switch`, async () => {
    const clock = { now: Date.now() };
    const rows = freshStore(kind);
    await history(server(rows, clock), clock);
    const store = switched(rows, false);
    await store.migrate();
    await store.copy();
    // A second server, not yet switched over, counts a visit in the old database.
    clock.now += MIN;
    await server(rows, clock).send({ k: "pageview", u: "https://example.com/late", i: "late" }, "203.0.113.8");
    assert.equal((await store.counts()).other.late, 1);
    await store.dropOld();
    const left = await rows.db.all<{ entry_path: string }>(`SELECT entry_path FROM rl_sessions`);
    assert.deepEqual(left.map((r) => r.entry_path), ["/late"]);
  });

  test(`${kind}: on ClickHouse that drops repeated inserts, as Cloud does, a piece tried again still copies its visits`, async () => {
    const clock = { now: Date.now() };
    const rows = freshStore(kind);
    const before = server(rows, clock);
    await history(before, clock);
    const expected = await reports(before);

    const store = switched(rows, false);
    await store.migrate();
    for (const table of ["rl_visits", "rl_events"]) await store.clickhouse.run(`ALTER TABLE ${table} MODIFY SETTING non_replicated_deduplication_window = 100`);
    const insert = store.clickhouse.insert.bind(store.clickhouse);
    let inserts = 0;
    store.clickhouse.insert = async (table, batch, options) => {
      if (++inserts === 4) throw new TypeError("fetch failed", { cause: new Error("other side closed") });
      return insert(table, batch, options);
    };
    assert.equal((await store.copy())?.done, true);
    assert.deepEqual(await reports(server(store, clock)), expected);
  });

  test(`${kind}: an AI fetch read from a log into days still being copied stays when a piece is tried again`, async () => {
    const clock = { now: Date.now() };
    const rows = freshStore(kind);
    await history(server(rows, clock), clock);
    const store = switched(rows, false);
    const after = server(store, clock);
    await after.rl.init();
    // A log reader sends a fetch from three days ago, into days the copy has not reached yet.
    const fetched = clock.now - 3 * DAY;
    assert.ok(await after.rl.observe(new Request("https://example.com/pricing", { headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" } }), fetched));
    // The connection drops as the events of the piece around it go in, so that piece is cleared and copied again.
    const insert = store.clickhouse.insert.bind(store.clickhouse);
    let dropped = false;
    store.clickhouse.insert = async (table, batch, options) => {
      if (table === "rl_events" && options?.batched && !dropped && batch.some((r) => Math.abs(Number(r.ts) - fetched) < DAY)) {
        dropped = true;
        throw new TypeError("fetch failed", { cause: new Error("other side closed") });
      }
      return insert(table, batch, options);
    };
    assert.equal((await store.copy())?.done, true);
    assert.ok(dropped);
    const [row] = await store.clickhouse.all<{ n: unknown }>(`SELECT count() AS n FROM rl_events WHERE kind = 'fetch'`);
    assert.equal(Number(row?.n), 1);
  });

  test(`${kind}: a process that loses its claim part way stops, and the one that takes over copies each visit once`, async () => {
    const clock = { now: Date.now() };
    const rows = freshStore(kind);
    const before = server(rows, clock);
    await history(before, clock);
    const expected = await reports(before);

    const store = switched(rows, false);
    await store.migrate();
    // Part way through, another process holds the claim for a moment, as if this one had stalled past it.
    const insert = store.clickhouse.insert.bind(store.clickhouse);
    let inserts = 0;
    store.clickhouse.insert = async (table, batch, options) => {
      if (table !== "rl_meta" && ++inserts === 3) await rows.setSetting("clickhouse-copy", JSON.stringify({ by: "someone", until: Date.now() + 1_000 }));
      return insert(table, batch, options);
    };
    const errors: unknown[] = [];
    const log = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      assert.equal((await store.copy())?.done, true);
    } finally {
      console.error = log;
    }
    assert.match(String(errors[0]), /another process took over/);
    assert.deepEqual(await reports(server(store, clock)), expected);
  });
}

test("a copy gives up after ten failures in a row, and a piece that goes in starts the count again", { skip: !process.env.RUNLIGHT_TEST_CLICKHOUSE }, async () => {
  const clock = { now: Date.now() };
  const rows = freshStore("sqlite");
  const before = server(rows, clock);
  await history(before, clock);
  const expected = await reports(before);

  const store = switched(rows, false);
  await store.migrate();
  // No pauses between tries, which would otherwise double from a second up to five minutes.
  const inner = store as unknown as { pause(ms: number): Promise<void>; copyStep(...a: unknown[]): Promise<unknown> };
  const waits: number[] = [];
  inner.pause = async (ms) => void waits.push(ms);
  const step = inner.copyStep.bind(store);
  const plan = [...Array(9).fill("fail"), "copy", ...Array(9).fill("fail")];
  let tries = 0;
  inner.copyStep = async (...a) => {
    tries++;
    const next = plan.shift() ?? "copy";
    if (next === "fail") throw new TypeError("fetch failed", { cause: new Error("other side closed") });
    return step(...a);
  };
  // Nine failures, a piece, nine more: never ten in a row, so the copy finishes.
  assert.equal((await store.copy())?.done, true);
  assert.deepEqual(waits.slice(0, 10), [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 1_000]);
  assert.deepEqual(await reports(server(store, clock)), expected);

  // Ten in a row stops it with the last reason.
  const otherRows = freshStore("sqlite");
  await history(server(otherRows, clock), clock);
  const other = switched(otherRows, false);
  await other.migrate();
  const otherInner = other as unknown as typeof inner;
  otherInner.pause = async () => {};
  tries = 0;
  otherInner.copyStep = async () => {
    tries++;
    throw new TypeError("fetch failed", { cause: new Error("other side closed") });
  };
  await assert.rejects(other.copy(), /fetch failed/);
  assert.equal(tries, 10);
  await other.close();
  await store.close();
});

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

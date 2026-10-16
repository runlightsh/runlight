import assert from "node:assert/strict";
import { after, test } from "node:test";
import { SAFARI_IPHONE, STORES, cleanup, setup } from "./helpers.js";

const DAY = 86_400_000;

after(cleanup);

const HOUR = 3_600_000;
const PAGES = ["/", "/blog/one", "/blog/two", "/pricing", "/about"];
const REFERRERS = ["https://www.google.com/", "https://news.ycombinator.com/", "", "https://chatgpt.com/", "https://t.co/x"];
const COUNTRIES = ["GB", "US", "DE", "CA"];

/** Every report the dashboard asks for, as JSON, for comparing before and after. */
async function everything(get: (path: string) => Promise<any>) {
  const out: Record<string, unknown> = {};
  for (const range of ["period=7d", "period=30d", "from=2026-09-29&to=2026-10-03", "period=today", "period=all"]) {
    out[`stats ${range}`] = (await get(`/api/stats?${range}&compare=previous`)).stats;
    out[`goals ${range}`] = (await get(`/api/goals?${range}&compare=previous`)).goals;
    out[`series ${range}`] = (await get(`/api/series?${range}&compare=off`)).points;
    out[`rhythm ${range}`] = await get(`/api/rhythm?${range}`);
    for (const dimension of ["page", "event", "entry", "exit", "source", "channel", "referrer", "country", "browser", "device", "os"]) {
      out[`${dimension} ${range}`] = (await get(`/api/breakdown?${range}&dimension=${dimension}&limit=3`)).rows;
      out[`${dimension} ${range} page 2`] = (await get(`/api/breakdown?${range}&dimension=${dimension}&limit=3&page=2`)).rows;
    }
  }
  out["filtered"] = (await get(`/api/stats?period=30d&filter=country:is:GB`)).stats;
  out["hourly"] = (await get(`/api/series?period=yesterday`)).points;
  return out;
}

for (const kind of STORES) {
  test(`${kind}: reports read from daily rollups match reports read from every visit`, async () => {
    // Toronto, so local days and UTC days differ, starting ten days back.
    const t = setup(kind, { site: { hostnames: ["example.com"], timezone: "America/Toronto" } });
    const start = t.now;
    t.advance(-10 * 24 * HOUR);
    let n = 0;
    for (let day = 0; day < 10; day++) {
      for (let v = 0; v < 6; v++) {
        n++;
        const ip = `203.0.113.${n % 40}`;
        const ua = n % 3 === 0 ? SAFARI_IPHONE : undefined;
        const headers = { "x-vercel-ip-country": COUNTRIES[n % COUNTRIES.length]! };
        const views = 1 + (n % 3);
        for (let p = 0; p < views; p++) {
          const id = `pv${n}x${p}`;
          await t.send({ k: "pageview", u: `https://example.com${PAGES[(n + p) % PAGES.length]}`, r: p === 0 ? REFERRERS[n % REFERRERS.length] : "", i: id }, { ip, ua, headers });
          t.advance(20_000 + (n % 5) * 7_000);
          if (n % 2 === 0) await t.send({ k: "engagement", u: "https://example.com/", i: id, e: 9_000 + n * 100, d: 40 + (n % 60) }, { ip, ua, headers });
          if (n % 4 === 0) await t.send({ k: "event", u: "https://example.com/", i: id, n: "Signup" }, { ip, ua, headers });
        }
        t.advance(3 * HOUR + (n % 7) * 60_000);
      }
      // A visit that runs past midnight: it belongs to the day it started.
      t.advance(24 * HOUR - 6 * (3 * HOUR) - 30 * 60_000);
    }
    t.advance(start - t.now + 2 * HOUR);

    for (const [i, goal] of [
      { kind: "page", match: "/pricing", valueMode: "none" },
      { kind: "page", match: "/blog/*", valueMode: "fixed" },
      { kind: "event", match: "Signup", valueMode: "fixed" },
      { kind: "event", match: "Signup", valueMode: "prop" },
      { kind: "click", match: "button", valueMode: "none" },
    ].entries()) {
      await t.rl.store.saveGoal({ id: String(i).padStart(24, "0"), site: "default", name: "Signup", kind: goal.kind as "page" | "event" | "click", match: goal.match, clickBy: "selector", valueMode: goal.valueMode as "none" | "fixed" | "prop", value: 1.25, valueProp: "revenue", currency: "USD", createdAt: t.now });
    }
    const before = await everything(t.get);
    // D1 builds a few days a check, the others ten.
    let built = 0;
    for (let made = await t.rl.buildRollups(); made > 0; made = await t.rl.buildRollups()) built += made;
    assert.ok(built >= 8, `built ${built} days`);
    assert.equal(await t.rl.buildRollups(), 0, "a built day is not built again");
    const afterwards = await everything(t.get);
    for (const key of Object.keys(before)) assert.deepEqual(afterwards[key], before[key], key);

    // Proof the reports read the rollups: with the built days' raw visits gone, a long range still adds up.
    const [first] = await t.rl.store.db.all<{ s: unknown; e: unknown }>(`SELECT MIN(start_at) AS s, MAX(end_at) AS e FROM rl_rollup_days`);
    await t.rl.store.db.run(`DELETE FROM rl_events WHERE ts >= ? AND ts < ?`, [Number(first!.s), Number(first!.e) - 2 * HOUR]);
    await t.rl.store.db.run(`DELETE FROM rl_sessions WHERE started_at >= ? AND started_at < ?`, [Number(first!.s), Number(first!.e) - 2 * HOUR]);
    assert.deepEqual((await t.get(`/api/stats?period=30d&compare=off`)).stats, before["stats period=30d"], "the 30 days come from rollups");
    assert.deepEqual((await t.get(`/api/breakdown?period=30d&dimension=source&limit=3`)).rows, before["source period=30d"]);
    assert.deepEqual((await t.get(`/api/breakdown?period=30d&dimension=page&limit=3`)).rows, before["page period=30d"]);
    assert.deepEqual((await t.get(`/api/breakdown?period=30d&dimension=event&limit=3`)).rows, before["event period=30d"]);
    assert.deepEqual(await t.get(`/api/rhythm?period=30d`), before["rhythm period=30d"]);
    // Goals by a whole path or a name, worth nothing or a fixed amount; a pattern or a sent value reads events.
    const goals = (await t.get(`/api/goals?period=30d&compare=previous`)).goals;
    for (const i of [0, 2, 4]) assert.deepEqual(goals[i], (before["goals period=30d"] as unknown[])[i], `goal ${i} comes from rollups`);

  });
}

for (const kind of STORES) {
  test(`${kind}: a late event and engagement on an old pageview are counted once the day is built again`, async () => {
    const t = setup(kind, { site: { hostnames: ["example.com"], timezone: "UTC" } });
    // Evening of October 5th, then rollups built the next morning.
    t.advance(-(Date.UTC(2026, 9, 6, 12) - Date.UTC(2026, 9, 5, 20)));
    await t.send({ k: "pageview", u: "https://example.com/", i: "late1" }, { ip: "203.0.113.50" });
    t.advance(7 * HOUR);
    assert.ok((await t.rl.buildRollups()) >= 1);
    // The tab was left open overnight: its event and engagement arrive now.
    await t.send({ k: "event", u: "https://example.com/", i: "late1", n: "Signup" }, { ip: "203.0.113.50" });
    await t.send({ k: "engagement", u: "https://example.com/", i: "late1", e: 60_000, d: 80 }, { ip: "203.0.113.50" });
    const range = "from=2026-10-05&to=2026-10-05";
    const read = async () => ({
      stats: (await t.get(`/api/stats?${range}&compare=off`)).stats,
      events: (await t.get(`/api/breakdown?${range}&dimension=event`)).rows,
      pages: (await t.get(`/api/breakdown?${range}&dimension=page`)).rows,
    });
    await t.rl.buildRollups();
    const rolled = await read();
    await t.rl.store.clearRollups("default");
    const raw = await read();
    assert.deepEqual(rolled, raw);
    assert.equal(raw.stats.bounceRate, 0, "the event means the visit did not bounce");
    assert.deepEqual(raw.events.map((r: any) => r.value), ["Signup"]);
  });
}

for (const kind of STORES) {
  test(`${kind}: ties come in code point order, the same before and after the days are built`, async () => {
    const t = setup(kind, { site: { hostnames: ["example.com"], timezone: "UTC" } });
    const values = ["alpha", "Zeta", "beta", "Gamma", "émile", "Émile", "_x", "a-b", "ab"];
    t.advance(-24 * HOUR);
    let n = 0;
    for (const value of values) {
      n++;
      await t.send({ k: "pageview", u: `https://example.com/?utm_campaign=${encodeURIComponent(value)}`, r: "", i: `pv${n}` }, { ip: `203.0.113.${n}` });
      t.advance(60_000);
    }
    t.advance(26 * HOUR);
    const expected = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const order = async () => ((await t.get(`/api/breakdown?period=7d&dimension=utm_campaign&limit=20`)).rows as Array<{ value: string }>).map((r) => r.value);
    assert.deepEqual(await order(), expected, "read from every visit");
    assert.ok((await t.rl.buildRollups()) >= 1);
    assert.deepEqual(await order(), expected, "read from rollups");
  });
}

for (const kind of STORES) {
  test(`${kind}: after a timezone change, only days after it are built, so nothing counts twice`, async () => {
    const t = setup(kind, { site: { hostnames: ["example.com"], timezone: "UTC" } });
    await t.rl.init();
    const site = t.rl.sites[0]!;
    // The same person in the morning and evening of October 3rd UTC, and a visit on the 4th.
    t.advance(Date.UTC(2026, 9, 3, 10) - t.now);
    await t.send({ k: "pageview", u: "https://example.com/", r: "", i: "a1" }, { ip: "203.0.113.1" });
    t.advance(10 * HOUR);
    await t.send({ k: "pageview", u: "https://example.com/", r: "", i: "a2" }, { ip: "203.0.113.1" });
    t.advance(Date.UTC(2026, 9, 4, 12) - t.now);
    await t.send({ k: "pageview", u: "https://example.com/", r: "", i: "b1" }, { ip: "203.0.113.2" });
    t.advance(Date.UTC(2026, 9, 6, 12) - t.now);
    assert.ok((await t.rl.buildRollups()) >= 2);
    const range = "from=2026-10-03&to=2026-10-05";
    const raw = async () => (await t.get(`/api/stats?${range}&compare=off`)).stats;

    await t.rl.updateSite(site.id, { timezone: "Asia/Tokyo" });
    const before = await raw();
    assert.equal(await t.rl.buildRollups(), 0, "days before the change stay counted visit by visit");
    assert.deepEqual(await raw(), before);
    assert.equal(before.visitors, 2);

    // A day that starts after the change is built as usual.
    t.advance(3 * 24 * HOUR);
    assert.ok((await t.rl.buildRollups()) >= 1);
  });
}

test("two processes on one database: a stale timezone builds nothing and clears nothing", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { runlight } = await import("../src/index.js");
  const { sqlite } = await import("../src/stores/sqlite.js");
  const file = path.join(mkdtempSync(path.join(tmpdir(), "runlight-zones-")), "shared.db");
  let now = Date.UTC(2026, 9, 3, 12);
  const old = runlight({ store: sqlite({ path: file }), site: { hostnames: ["example.com"], timezone: "UTC" }, now: () => now });
  const routes = old.routes({ token: "secret" });
  const send = (u: string, ip: string) =>
    routes.POST(new Request("https://example.com/runlight/e", { method: "POST", body: JSON.stringify({ k: "pageview", u }), headers: { "x-forwarded-for": ip, "user-agent": SAFARI_IPHONE } }));
  await old.init();
  await send("https://example.com/", "203.0.113.1");
  now = Date.UTC(2026, 9, 6, 12);
  assert.ok((await old.buildRollups()) >= 2, "the old process builds in UTC");
  const built = async () => (await old.store.db.all(`SELECT COUNT(*) AS n FROM rl_rollup_days`))[0]!.n;

  // A new copy starts with the timezone changed in code: it clears the old days once, at startup.
  const fresh = runlight({ store: sqlite({ path: file }), site: { hostnames: ["example.com"], timezone: "Asia/Tokyo" }, now: () => now });
  await fresh.init();
  assert.equal(Number(await built()), 0);
  // The old copy, still running, neither builds in UTC nor clears what the new one does.
  now += 3 * 86_400_000;
  assert.equal(await old.buildRollups(), 0);
  assert.ok((await fresh.buildRollups()) >= 1);
  const afterFresh = Number(await built());
  assert.equal(await old.buildRollups(), 0);
  assert.equal(Number(await built()), afterFresh, "nothing cleared by the stale copy");
});

test("a timezone changed in the dashboard reaches another process at its next check", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { runlight } = await import("../src/index.js");
  const { sqlite } = await import("../src/stores/sqlite.js");
  const file = path.join(mkdtempSync(path.join(tmpdir(), "runlight-zones-")), "shared.db");
  let now = Date.UTC(2026, 9, 6, 12);
  const a = runlight({ store: sqlite({ path: file }), site: { hostnames: ["example.com"], timezone: "UTC" }, now: () => now });
  const b = runlight({ store: sqlite({ path: file }), site: { hostnames: ["example.com"], timezone: "UTC" }, now: () => now });
  await a.init();
  await b.init();
  await a.updateSite("default", { timezone: "Europe/Paris" });
  assert.equal(b.site("default")!.timezone, "UTC");
  // A visit after the change, and days enough for its day to be built.
  await b.store.db.run(`INSERT INTO rl_sessions (id, site, visitor, started_at, last_at, pageviews) VALUES ('s1', 'default', 'v1', ?, ?, 1)`, [now + DAY, now + DAY]);
  now += 3 * DAY;
  assert.equal(await b.buildRollups(), 0, "holding the old timezone, it builds nothing");
  await b.check();
  assert.equal(b.site("default")!.timezone, "Europe/Paris");
  assert.deepEqual([...(await b.store.rollupDays("default"))].sort(), ["2026-10-07", "2026-10-08"], "then it builds the days after the change");
});

for (const kind of STORES) {
  test(`${kind}: clearing days that stops part way leaves none marked built without its numbers`, async () => {
    const t = setup(kind, { site: { hostnames: ["example.com"], timezone: "UTC" } });
    t.advance(-10 * DAY);
    for (let d = 0; d < 8; d++) {
      await t.send({ k: "pageview", u: "https://example.com/", i: `d${d}` }, { ip: `203.0.113.${d + 1}` });
      t.advance(DAY);
    }
    t.advance(2 * DAY);
    while ((await t.rl.buildRollups()) > 0);
    const before = (await t.get("/api/stats?period=30d&compare=off")).stats;
    // The connection drops after a few of the per-day deletes.
    const db = t.rl.store.db;
    const run = db.run.bind(db);
    let deletes = 0;
    db.run = (async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("DELETE FROM rl_rollups WHERE") && ++deletes > 3) throw new Error("connection lost");
      return run(sql, params);
    }) as typeof db.run;
    await assert.rejects(t.rl.store.clearRollups("default"));
    db.run = run;
    assert.deepEqual((await t.get("/api/stats?period=30d&compare=off")).stats, before);
    while ((await t.rl.buildRollups()) > 0);
    assert.deepEqual((await t.get("/api/stats?period=30d&compare=off")).stats, before);
  });
}

for (const kind of STORES) {
  test(`${kind}: renaming a click goal keeps its conversions on built days, even onto a name with events of its own`, async () => {
    const t = setup(kind, { site: { hostnames: ["example.com"], timezone: "UTC" } });
    t.advance(-3 * 24 * HOUR);
    for (let i = 0; i < 3; i++) {
      await t.send({ k: "pageview", u: "https://example.com/", i: `c${i}` }, { ip: `203.0.113.${60 + i}` });
      await t.send({ k: "event", u: "https://example.com/", i: `c${i}`, n: "Buy click" }, { ip: `203.0.113.${60 + i}` });
      // One visit also sends a plain event under the name the goal is renamed to.
      if (i === 0) await t.send({ k: "event", u: "https://example.com/", i: `c${i}`, n: "Purchase" }, { ip: `203.0.113.${60 + i}` });
      t.advance(HOUR);
    }
    t.advance(3 * 24 * HOUR - 3 * HOUR);
    const goal = { id: "c".padStart(24, "0"), site: "default", name: "Buy click", kind: "click" as const, match: "button.buy", clickBy: "selector" as const, valueMode: "none" as const, value: 0, valueProp: "", currency: "USD", createdAt: t.now };
    await t.rl.store.saveGoal(goal);
    for (let made = await t.rl.buildRollups(); made > 0; made = await t.rl.buildRollups());
    const read = async () => ({
      goals: (await t.get(`/api/goals?period=7d&compare=off`)).goals.map((g: any) => [g.name, g.conversions, g.visitors]),
      events: (await t.get(`/api/breakdown?period=7d&dimension=event`)).rows.map((r: any) => [r.value, r.events]),
    });
    assert.deepEqual((await read()).goals, [["Buy click", 3, 3]]);
    for (const name of ["Checkout click", "Purchase"]) {
      const before = (await t.rl.store.goals("default"))[0]!;
      await t.rl.store.saveGoal({ ...before, name }, before);
      const rolled = await read();
      assert.deepEqual(rolled.goals, [[name, name === "Purchase" ? 4 : 3, 3]], `renamed to ${name}`);
      // Days built again where both names met, then every built day read the same as the raw events.
      for (let made = await t.rl.buildRollups(); made > 0; made = await t.rl.buildRollups());
      const built = await read();
      await t.rl.store.clearRollups("default");
      assert.deepEqual(built, await read(), `rollups agree with the raw events after renaming to ${name}`);
      for (let made = await t.rl.buildRollups(); made > 0; made = await t.rl.buildRollups());
    }
  });
}

for (const kind of STORES) {
  test(`${kind}: a header longer than its column is cut to fit, so the day's rollup still builds`, async () => {
    const t = setup(kind, { site: { hostnames: ["example.com"], timezone: "UTC" } });
    t.advance(-2 * 24 * HOUR);
    const long = `"${"Windows ".repeat(400)}"`;
    await t.send({ k: "pageview", u: `https://example.com/${"a".repeat(1500)}`, i: "long1" }, {
      ip: "203.0.113.70",
      // A browser whose user agent names no system, so the platform hint is what is stored.
      ua: "Mozilla/5.0 (Unknown) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      headers: { "sec-ch-ua-platform": long, "sec-ch-ua": `"${"B".repeat(3000)}";v="1"` },
    });
    t.advance(2 * 24 * HOUR);
    const [row] = await t.rl.store.db.all<{ os: string; entry_path: string }>(`SELECT os, entry_path FROM rl_sessions`);
    assert.ok(row!.os.length > 50 && row!.os.length <= 100, `os is ${row!.os.length} characters`);
    assert.ok(row!.entry_path.length <= 1000);
    let built = 0;
    for (let made = await t.rl.buildRollups(); made > 0; made = await t.rl.buildRollups()) built += made;
    assert.ok(built >= 1, "the day builds");
    assert.equal((await t.get(`/api/stats?period=7d&compare=off`)).stats.visits, 1);
  });
}

test("on MySQL, two processes building one day at once add its rows once", { skip: !process.env.RUNLIGHT_TEST_MYSQL && "RUNLIGHT_TEST_MYSQL is not set" }, async () => {
  const { runlight } = await import("../src/index.js");
  const { mysql } = await import("../src/stores/mysql.js");
  const { freshMysqlDatabase } = await import("./helpers.js");
  const { url, ready } = freshMysqlDatabase();
  await ready;
  let now = Date.UTC(2026, 9, 3, 12);
  const site = { hostnames: ["example.com"], timezone: "UTC" };
  const one = runlight({ store: mysql({ url, max: 3 }), site, now: () => now });
  const other = runlight({ store: mysql({ url, max: 3 }), site, now: () => now });
  const routes = one.routes({ token: "secret" });
  for (let i = 0; i < 5; i++) {
    await routes.POST(new Request("https://example.com/runlight/e", { method: "POST", body: JSON.stringify({ k: "pageview", u: `https://example.com/p${i}` }), headers: { "x-forwarded-for": `203.0.113.${80 + i}`, "user-agent": SAFARI_IPHONE } }));
  }
  await other.init();
  const start = Date.UTC(2026, 9, 3);
  for (let round = 0; round < 5; round++) {
    const both = await Promise.allSettled([one.store.buildRollupDay("default", "2026-10-03", start, start + 86_400_000), other.store.buildRollupDay("default", "2026-10-03", start, start + 86_400_000)]);
    assert.ok(both.some((b) => b.status === "fulfilled"), "one of them builds it");
    const [totals] = await one.store.db.all<{ n: unknown; visits: unknown }>(`SELECT COUNT(*) AS n, SUM(visits) AS visits FROM rl_rollups WHERE site = 'default' AND day = '2026-10-03' AND dim = ''`);
    assert.deepEqual([Number(totals!.n), Number(totals!.visits)], [1, 5], `round ${round}`);
  }
  now += 1;
  await one.store.close();
  await other.store.close();
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { importCsvVisits } from "../src/importers/visits.js";
import { writeLink } from "../src/importers/write.js";
import { runlight } from "../src/index.js";
import { BATCH_STATEMENTS, type SqlStore } from "../src/store.js";
import { d1 } from "../src/stores/d1.js";
import { sqlite } from "../src/stores/sqlite.js";
import { fakeD1 } from "./helpers.js";

// What Cloudflare allows a Worker on the free plan to send D1 in one request, a batch counting as one query,
// and the most values one statement binds: https://developers.cloudflare.com/d1/platform/limits/
const FREE_QUERIES = 50;
const MOST_PARAMS = 100;

const site = { hostnames: ["blog.example.com"], timezone: "UTC" };
const NOW = Date.parse("2026-03-10T00:00:00Z");

function onD1(prefix?: string) {
  const database = fakeD1();
  const rl = runlight({ store: d1({ database, ...(prefix ? { prefix } : {}) }), site, now: () => NOW });
  return { rl, sent: database.sent, failing: database.failing };
}
const onSqlite = () => runlight({ store: sqlite({ path: ":memory:" }), site, now: () => NOW });

/** Everything an import wrote, in order, without the ids of the events, which only count rows. */
async function written(store: SqlStore) {
  return {
    visits: await store.db.all(`SELECT * FROM rl_sessions ORDER BY started_at, id`),
    events: await store.db.all(`SELECT site, ts, kind, visitor, session, path, hostname, title, name, props, link FROM rl_events ORDER BY ts, id`),
    links: await store.db.all(`SELECT * FROM rl_links ORDER BY id`),
  };
}

/** Rows a second apart from `start`: every fourth a new visitor, the rest that visitor's next pages and a signup. */
function rows(start: number, count: number, offset = 0) {
  return Array.from({ length: count }, (_, n) => {
    const i = n + offset;
    return { time: new Date(start + n * 1_000).toISOString(), path: `/p${i % 7}`, visitor: `v${Math.floor(i / 4)}`, country: "CA", browser: "Safari", ...(i % 4 === 3 ? { event: "Signup" } : {}) };
  });
}

for (const prefix of [undefined, "wp_rl_"]) {
  test(`D1${prefix ? " with a prefix" : ""}: a full CSV batch of visits fits a free Worker's queries, and writes what SQLite writes`, async () => {
    const { rl, sent } = onD1(prefix);
    const other = onSqlite();
    const start = Date.parse("2026-03-01T22:00:00Z");
    // Two batches, with a visit that runs from the first into the second, and across midnight.
    const first = rows(start, 2000);
    const second = rows(start + 2000 * 1_000, 2000, 2000);
    await rl.init();
    for (const batch of [first, second]) {
      sent.queries = 0;
      const step = await importCsvVisits(rl, "default", batch, "s".repeat(32));
      assert.deepEqual(step, await importCsvVisits(other, "default", batch, "s".repeat(32)));
      assert.ok(sent.queries <= FREE_QUERIES, `a batch took ${sent.queries} queries`);
    }
    // The second batch again, as after a failure: nothing doubles.
    sent.queries = 0;
    await importCsvVisits(rl, "default", second, "s".repeat(32));
    await importCsvVisits(other, "default", second, "s".repeat(32));
    assert.ok(sent.queries <= FREE_QUERIES, `a batch sent again took ${sent.queries} queries`);
    assert.ok(sent.mostStatements <= BATCH_STATEMENTS && sent.mostParams <= MOST_PARAMS, JSON.stringify(sent));
    assert.deepEqual(await written(rl.store), await written(other.store));
  });
}

test("D1: a link's clicks and the link go in one batch, all or nothing", async () => {
  const { rl, sent, failing } = onD1();
  const other = onSqlite();
  await rl.init();
  await other.init();
  const link = { sourceId: "l1", slug: "sale", domain: "", name: "Sale", url: "https://a.com/sale", createdAt: NOW - 86_400_000 };
  // 300 clicks in 100 visits: five statements for a visit's first click, two for each after it.
  const clicks = Array.from({ length: 300 }, (_, i) => ({ ts: NOW - 3_600_000 + i * 1_000, visit: `v${i % 100}`, country: "CA" }));
  failing.push(/INSERT INTO rl_links/);
  await assert.rejects(writeLink(rl, "default", "dub", link, { clicks }), /D1_ERROR/);
  assert.deepEqual(await written(rl.store), { visits: [], events: [], links: [] }, "the batch that failed left nothing behind");
  sent.queries = 0;
  assert.deepEqual(await writeLink(rl, "default", "dub", link, { clicks }), { status: "created", clicks: 300 });
  // The checks before it, then the one batch.
  assert.ok(sent.queries <= 6 && sent.batches === 2, JSON.stringify(sent));
  await writeLink(other, "default", "dub", link, { clicks });
  assert.deepEqual(await written(rl.store), await written(other.store));
});

test("D1: a link's daily counts go several rows to a statement, and a long history in several batches", async () => {
  const { rl, sent } = onD1();
  const other = onSqlite();
  await rl.init();
  await other.init();
  const link = { sourceId: "l2", slug: "daily", domain: "", name: "", url: "https://a.com/daily", createdAt: NOW - 86_400_000 };
  const daily = Array.from({ length: 3 }, (_, n) => ({ day: `2026-03-0${n + 1}`, clicks: 9_000 }));
  sent.queries = 0;
  assert.deepEqual(await writeLink(rl, "default", "dub", link, { daily }), { status: "created", clicks: 27_000 });
  // 27,000 rows, six to a statement, are 4,500 statements: three batches, where a row at a time is 27,000 queries.
  assert.ok(sent.queries <= 8, JSON.stringify(sent));
  assert.ok(sent.mostStatements <= BATCH_STATEMENTS && sent.mostParams <= MOST_PARAMS, JSON.stringify(sent));
  await writeLink(other, "default", "dub", link, { daily });
  assert.deepEqual(await written(rl.store), await written(other.store));
});

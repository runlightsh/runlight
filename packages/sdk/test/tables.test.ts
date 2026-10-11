import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import pg from "pg";
import mysql2 from "mysql2/promise";
import { runlight } from "../src/index.js";
import { PREFIX, SqlStore, TABLES, TablesBusyError, lockWaitInTests, type Db } from "../src/store.js";
import { sqlite } from "../src/stores/sqlite.js";
import { postgres } from "../src/stores/postgres.js";
import { mysql } from "../src/stores/mysql.js";
import { cleanup, freshMysqlDatabase } from "./helpers.js";

const dir = mkdtempSync(path.join(tmpdir(), "runlight-tables-"));
after(async () => {
  rmSync(dir, { recursive: true, force: true });
  await cleanup();
});

const pgUrl = process.env.RUNLIGHT_TEST_PG;
const mysqlUrl = process.env.RUNLIGHT_TEST_MYSQL;

/** Every table and index name in the database, as each dialect lists them. */
async function names(db: Db): Promise<string[]> {
  const sql =
    db.dialect === "sqlite"
      ? "SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
      : db.dialect === "postgres"
        ? "SELECT c.relname AS name FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'i', 'S')"
        : `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()
           UNION SELECT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name <> 'PRIMARY'`;
  return (await db.all<{ name: string }>(sql)).map((row) => String(row.name)).sort();
}

/** Two stores over one database, one with its tables under rl_ and one under wp_rl_, and a raw look at it. */
async function sharedPair(kind: "sqlite" | "postgres" | "mysql"): Promise<{ plain: SqlStore; open: () => SqlStore; raw: Db; done: () => Promise<void> }> {
  if (kind === "sqlite") {
    const file = path.join(dir, `shared-${Math.random().toString(36).slice(2)}.db`);
    const plain = sqlite({ path: file });
    return { plain, open: () => sqlite({ path: file, prefix: "wp_rl_" }), raw: plain.db, done: () => plain.close() };
  }
  if (kind === "postgres") {
    const schema = `rl_test_${Math.random().toString(36).slice(2, 10)}`;
    const admin = new pg.Pool({ connectionString: pgUrl, max: 2 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pools: pg.Pool[] = [];
    const pool = () => {
      const made = new pg.Pool({ connectionString: pgUrl, max: 3, options: `-c search_path=${schema}` });
      pools.push(made);
      return made;
    };
    const plain = postgres({ pool: pool() });
    return {
      plain,
      open: () => postgres({ pool: pool(), prefix: "wp_rl_" }),
      raw: plain.db,
      done: async () => {
        for (const made of pools) await made.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      },
    };
  }
  const { url, ready } = freshMysqlDatabase();
  await ready;
  const stores: SqlStore[] = [];
  const open = (prefix?: string) => {
    const made = mysql({ url, max: 3, ...(prefix ? { prefix } : {}) });
    stores.push(made);
    return made;
  };
  const plain = open();
  return {
    plain,
    open: () => open("wp_rl_"),
    raw: plain.db,
    done: async () => {
      for (const store of stores) await store.close();
    },
  };
}

const kinds = [
  { kind: "sqlite" as const, skip: false as const },
  { kind: "postgres" as const, skip: !pgUrl && "RUNLIGHT_TEST_PG is not set" },
  { kind: "mysql" as const, skip: !mysqlUrl && "RUNLIGHT_TEST_MYSQL is not set" },
];

for (const { kind, skip } of kinds) {
  test(`${kind}: a prefix keeps a second set of tables beside the first in one database`, { skip }, async () => {
    const { plain, open, raw, done } = await sharedPair(kind);
    try {
      const other = open();
      await other.migrate();
      // A second process with the same prefix finds every table and index already there.
      await open().migrate();
      const made = await names(raw);
      assert.notDeepEqual(made, []);
      assert.deepEqual(made.filter((name) => !name.startsWith("wp_rl_")), [], "every name is under the prefix");
      assert.deepEqual(other.tables(), TABLES.map((table) => `wp_rl_${table}`));
      assert.deepEqual(other.tables().slice(0, 15).filter((table) => !made.includes(table)), [], "the store's 15 tables, listed for removing them");

      await plain.migrate();
      const plainNames = (await names(raw)).filter((name) => name.startsWith(PREFIX));
      assert.equal(plainNames.filter((name) => (TABLES as readonly string[]).includes(name.slice(PREFIX.length))).length, 15);
      const site = (id: string) => ({ id, name: id, hostnames: [`${id}.example`], timezone: "UTC" });
      await plain.upsertSite(site("first"), 1);
      await other.upsertSite(site("second"), 1);
      assert.deepEqual((await plain.sites()).map((s) => s.id), ["first"]);
      assert.deepEqual((await other.sites()).map((s) => s.id), ["second"]);
      assert.equal(await other.transaction(async (tx) => (await tx.sites())[0]!.id), "second", "a transaction keeps the prefix");
      await other.setSetting("k", "wp");
      assert.equal(await plain.setting("k"), null);
      assert.equal(await other.setting("k"), "wp");
    } finally {
      await done();
    }
  });
}

test("a table prefix is letters, digits, and underscores, and does not start with a digit", () => {
  for (const prefix of ["1rl_", "rl-", "rl_; DROP TABLE x", "", "a".repeat(33)]) {
    assert.throws(() => sqlite({ path: ":memory:", prefix }), /a table prefix is up to 32 letters, digits, and underscores/, prefix);
  }
  for (const prefix of ["rl_", "wp_rl_", "_x", "A".repeat(32)]) assert.equal(sqlite({ path: ":memory:", prefix }).prefix, prefix);
  assert.equal(new SqlStore(sqlite({ path: ":memory:", prefix: "wp_rl_" }).db).prefix, "wp_rl_", "a store over a prefixed Db keeps its prefix");
  assert.deepEqual(sqlite({ path: ":memory:" }).tables().slice(0, 2), ["rl_meta", "rl_sites"]);
});

test("a new SQLite file is for its owner and group alone, and so are the files SQLite makes beside it", { skip: process.platform === "win32" && "Windows has no such modes" }, async () => {
  const file = path.join(dir, "mode.db");
  const store = sqlite({ path: file });
  await store.migrate();
  await store.setSetting("k", "v");
  assert.equal(statSync(file).mode & 0o777, 0o660);
  assert.ok(existsSync(`${file}-wal`));
  assert.equal(statSync(`${file}-wal`).mode & 0o777, 0o660);
  await store.close();
});

test("a tracker hit waits a moment at most while another process creates the tables, and other requests hear why they failed", async () => {
  const inner = sqlite({ path: ":memory:" }).db;
  let release: () => void = () => {};
  let busy = false;
  const db: Db = {
    ...inner,
    // Another process holds the lock: this one waits, until it is told to give up or go ahead.
    exclusive: (fn) =>
      new Promise((resolve, reject) => {
        release = () => (busy ? reject(new TablesBusyError()) : resolve(fn(inner)));
      }),
  };
  const rl = runlight({ store: new SqlStore(db), site: { hostnames: ["example.com"] }, now: () => Date.UTC(2026, 9, 6, 12) });
  const { handler } = rl.routes({ token: "secret" });
  const started = Date.now();
  const hit = await handler(
    new Request("https://example.com/runlight/e", {
      method: "POST",
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", "x-forwarded-for": "203.0.113.1" },
      body: JSON.stringify({ k: "pageview", u: "https://example.com/", i: "a1" }),
    }),
  );
  assert.equal(hit.status, 202);
  const waited = Date.now() - started;
  assert.ok(waited >= 9900 && waited < 12000, `the hit waited ${waited}ms`);
  // The other process gives up the wait: the request that waited answers 503, saying why.
  const asked = handler(new Request("https://example.com/runlight/api/stats?period=today", { headers: { authorization: "Bearer secret" } }));
  busy = true;
  release();
  const answer = await asked;
  assert.equal(answer.status, 503);
  assert.equal(answer.headers.get("retry-after"), "30");
  assert.deepEqual(await answer.json(), { error: "Runlight is creating or upgrading its tables. Try again in a minute.", code: "tables_busy" });
  // Once the tables are there, hits are counted again.
  busy = false;
  const later = rl.init();
  release();
  await later;
  const stats = await (await handler(new Request("https://example.com/runlight/api/stats?period=today&compare=off", { headers: { authorization: "Bearer secret" } }))).json();
  assert.equal(stats.stats.visitors, 0, "the hit that came while the tables were busy was dropped");
});

test("postgres: waiting for another process creating the tables gives up after the lock wait", { skip: !pgUrl && "RUNLIGHT_TEST_PG is not set" }, async () => {
  const schema = `rl_test_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: pgUrl, max: 2, options: `-c search_path=${schema}` });
  lockWaitInTests(1_000);
  try {
    // The lock every Runlight takes to create tables, held by another session. Asked for again and again, as
    // the stores do, since waiting on it could deadlock with an index another test is building concurrently.
    while (!(await admin.query("SELECT pg_try_advisory_lock(7331906) AS ok")).rows[0]?.ok) await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    await assert.rejects(postgres({ pool }).migrate(), (error: Error) => error instanceof TablesBusyError && /had not finished after 1 seconds/.test(error.message));
    assert.ok(Date.now() - started < 5_000);
    await admin.query("SELECT pg_advisory_unlock(7331906)");
    await postgres({ pool }).migrate();
  } finally {
    lockWaitInTests(null);
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("mysql: waiting for another process creating the tables gives up after the lock wait", { skip: !mysqlUrl && "RUNLIGHT_TEST_MYSQL is not set" }, async () => {
  const { url, ready } = freshMysqlDatabase();
  await ready;
  const other = await mysql2.createConnection(url);
  const store = mysql({ url, max: 2 });
  lockWaitInTests(1_000);
  try {
    // The lock every Runlight takes to create tables in this database, held by another session.
    await other.query("SELECT GET_LOCK(CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48)), 0)");
    const started = Date.now();
    await assert.rejects(store.migrate(), (error: Error) => error instanceof TablesBusyError);
    assert.ok(Date.now() - started < 5_000);
    await other.query("DO RELEASE_LOCK(CONCAT('runlight:', LEFT(SHA2(COALESCE(DATABASE(), ''), 256), 48)))");
    await store.migrate();
  } finally {
    lockWaitInTests(null);
    await other.end();
    await store.close();
  }
});

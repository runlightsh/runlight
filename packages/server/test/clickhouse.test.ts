import assert from "node:assert/strict";
import { test } from "node:test";
import { runlight } from "@runlight/sdk";
import { ClickHouseStore, clickhouse } from "@runlight/sdk/clickhouse";
import { sqlite } from "@runlight/sdk/sqlite";
import { runClickhouse } from "../src/clickhouse.js";

const CLICKHOUSE = process.env.RUNLIGHT_TEST_CLICKHOUSE;

/** What a clickhouse command writes, and the exit code it sets, with no terminal to ask in. */
async function run(args: string[], store: ClickHouseStore): Promise<{ out: string; code: number | undefined }> {
  let out = "";
  const write = { stdout: process.stdout.write, stderr: process.stderr.write };
  const tty = process.stdin.isTTY;
  process.stdout.write = process.stderr.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
  process.stdin.isTTY = false;
  const code = process.exitCode;
  process.exitCode = undefined;
  try {
    await runClickhouse(args, store, "SQLite");
    return { out, code: process.exitCode as number | undefined };
  } finally {
    Object.assign(process.stdout, { write: write.stdout });
    Object.assign(process.stderr, { write: write.stderr });
    process.stdin.isTTY = tty;
    process.exitCode = code;
  }
}

/** A server's SQLite with a day of visits, and a ClickHouse database of its own for them. */
async function install(t: { after(fn: () => Promise<void>): void }) {
  const rows = sqlite({ path: ":memory:" });
  const plain = runlight({ store: rows, site: { hostnames: ["example.com"], timezone: "UTC" } });
  const routes = plain.routes({ token: null });
  for (let i = 1; i <= 3; i++) {
    const headers = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", "x-forwarded-for": `203.0.113.${i}` };
    await routes.POST(new Request("https://example.com/runlight/e", { method: "POST", body: JSON.stringify({ k: "pageview", u: "https://example.com/", i: `v${i}` }), headers }));
  }
  const url = new URL(CLICKHOUSE!);
  url.pathname = `/rl_test_${Math.random().toString(36).slice(2, 10)}`;
  const store = clickhouse({ url: url.href, store: rows, copyInBackground: false });
  t.after(() => store.clickhouse.dropDatabase());
  await store.migrateOther();
  return { rows, store };
}

const visits = async (store: ClickHouseStore) => Number((await store.db.all<{ n: unknown }>(`SELECT COUNT(*) AS n FROM rl_sessions`))[0]?.n);

test("clickhouse status, copy, drop-old, and copy --back, start to finish", { skip: !CLICKHOUSE }, async (t) => {
  const { store } = await install(t);
  assert.match((await run(["status"], store)).out, /no Runlight tables yet/);
  assert.match((await run(["copy", "--back"], store)).out, /no Runlight tables yet/);

  assert.match((await run(["copy"], store)).out, /Every visit from SQLite is in ClickHouse/);
  assert.match((await run(["status"], store)).out, /ClickHouse holds 3 visits[\s\S]*Run clickhouse drop-old/);

  // Without a terminal to ask in, a command that deletes needs --yes, and does nothing without it.
  const asked = await run(["drop-old"], store);
  assert.equal(asked.code, 1);
  assert.match(asked.out, /--yes/);
  assert.equal(await visits(store), 3);
  assert.match((await run(["drop-old", "--yes"], store)).out, /Done/);
  assert.equal(await visits(store), 0);
  assert.match((await run(["drop-old", "--yes"], store)).out, /already empty/);

  assert.match((await run(["copy", "--back", "--yes"], store)).out, /Everything is back in SQLite/);
  assert.equal(await visits(store), 3);
  // A second copy back finds nothing to do and leaves the visits be.
  await assert.rejects(run(["copy", "--back", "--yes"], store), /nothing to copy back/);
  assert.equal(await visits(store), 3);
});

test("drop-old refuses before anything is copied", { skip: !CLICKHOUSE }, async (t) => {
  const { store } = await install(t);
  await store.migrate();
  await (store as unknown as { setMeta(key: string, value: string): Promise<void> }).setMeta("move", "");
  await assert.rejects(run(["drop-old", "--yes"], store), /Nothing has been copied/);
  assert.equal(await visits(store), 3);
  await store.close();
});

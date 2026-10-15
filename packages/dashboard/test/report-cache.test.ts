import assert from "node:assert/strict";
import { test } from "node:test";
import { reportCache } from "../src/report-cache.js";

test("reports share in-flight work, expire, and stay separate by key", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const cache = reportCache(100);
  let calls = 0;
  const load = async () => ++calls;
  const first = cache.read("site-a", load);
  assert.equal(cache.read("site-a", load), first);
  assert.equal(await first, 1);
  assert.equal(await cache.read("site-a", load), 1);
  assert.equal(await cache.read("site-b", load), 2);
  t.mock.timers.tick(101);
  assert.equal(await cache.read("site-a", load), 3);
});

test("saving clears reports, and an older pending request cannot repopulate them", async () => {
  const cache = reportCache();
  let finish!: (value: number) => void;
  const old = cache.read("report", () => new Promise<number>((resolve) => { finish = resolve; }));
  await Promise.resolve();
  cache.clear();
  assert.equal(await cache.read("report", async () => 2), 2);
  finish(1);
  assert.equal(await old, 1);
  assert.equal(await cache.read("report", async () => 3), 2);
});

test("failed reports are retried and old entries are bounded", async () => {
  const cache = reportCache(10000, 2);
  await assert.rejects(cache.read("a", async () => { throw new Error("offline"); }), /offline/);
  assert.equal(await cache.read("a", async () => 1), 1);
  await cache.read("b", async () => 2);
  await cache.read("c", async () => 3);
  assert.equal(await cache.read("a", async () => 4), 4);
});

test("known setup state remains readable during refresh and is removed on invalidation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const cache = reportCache(100);
  assert.equal(cache.peek("assistant"), undefined);
  await cache.read("assistant", async () => ({ configured: false }));
  t.mock.timers.tick(101);
  assert.deepEqual(cache.peek("assistant"), { configured: false });
  let finish!: (value: { configured: boolean }) => void;
  const refresh = cache.read("assistant", () => new Promise<{ configured: boolean }>((resolve) => { finish = resolve; }));
  await Promise.resolve();
  assert.deepEqual(cache.peek("assistant"), { configured: false });
  finish({ configured: true });
  await refresh;
  assert.deepEqual(cache.peek("assistant"), { configured: true });
  cache.clear();
  assert.equal(cache.peek("assistant"), undefined);
});

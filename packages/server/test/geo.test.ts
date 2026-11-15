import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Geo, lookupFrom } from "../src/geo.js";

test("DB-IP records become a country code, a readable region, and a plain city", () => {
  const records: Record<string, unknown> = {
    "24.114.0.1": { country: { iso_code: "CA" }, subdivisions: [{ names: { en: "Ontario" } }], city: { names: { en: "Toronto (Old Toronto)" } } },
    "8.8.8.8": { country: { iso_code: "US" }, subdivisions: [{ iso_code: "CA", names: { en: "California" } }], city: { names: { en: "Mountain View" } } },
    "10.0.0.1": null,
  };
  const lookup = lookupFrom({ get: (ip: string) => records[ip] ?? null } as never);
  assert.deepEqual(lookup("24.114.0.1"), { country: "CA", region: "Ontario", city: "Toronto" });
  assert.deepEqual(lookup("8.8.8.8"), { country: "US", region: "CA", city: "Mountain View" }, "a code wins when the database has one");
  assert.equal(lookup("10.0.0.1"), null);
  assert.equal(lookupFrom({ get: () => { throw new Error("bad address"); } } as never)("nonsense"), null);
});

test("a failed download leaves lookups empty and the folder clean, and is tried again later", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rl-geo-"));
  const asked: string[] = [];
  const lines: string[] = [];
  const geo = new Geo(dir, "city", (line) => lines.push(line), (async (url: string) => {
    asked.push(url);
    return new Response("nope", { status: 404 });
  }) as never);
  await geo.refresh(Date.UTC(2026, 9, 1, 3));
  assert.deepEqual(asked, [
    "https://download.db-ip.com/free/dbip-city-lite-2026-10.mmdb.gz",
    "https://download.db-ip.com/free/dbip-city-lite-2026-09.mmdb.gz",
  ], "early in a month, last month's release stands in");
  assert.equal(await geo.lookup("8.8.8.8"), null);
  assert.deepEqual(readdirSync(dir), []);
  await geo.refresh(Date.UTC(2026, 9, 1, 4));
  assert.equal(asked.length, 4, "tried again on the next check");
});

test("a file that keeps being missing or bad is asked for less and less often, up to every six hours", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rl-geo-"));
  let asked = 0;
  const geo = new Geo(dir, "city", () => {}, (async () => {
    asked++;
    return new Response("nope", { status: 404 });
  }) as never);
  const start = Date.UTC(2026, 9, 1, 3);
  const minute = 60_000;
  // The server checks every five minutes; each try asks for this month's file and last month's.
  const tries: number[] = [];
  for (let at = 0; at <= 24 * 60; at += 5) {
    const before = asked;
    await geo.refresh(start + at * minute);
    if (asked > before) tries.push(at);
  }
  assert.deepEqual(tries.slice(0, 8), [0, 5, 15, 35, 75, 155, 315, 635], "each wait is twice the last");
  assert.deepEqual(tries.slice(8), [995, 1355], "and none is longer than six hours");
  assert.equal(asked, tries.length * 2);
});

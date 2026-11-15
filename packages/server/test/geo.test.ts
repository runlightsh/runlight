import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { Geo, checkDatabase, lookupFrom, publishedChecksum } from "../src/geo.js";

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

/** MMDB's data format, enough of it to write a database: maps, strings, arrays, and unsigned integers. */
function encode(value: unknown): Buffer {
  const control = (type: number, size: number) => {
    const head = type < 8 ? [(type << 5) | Math.min(size, size < 29 ? size : size < 285 ? 29 : 30)] : [Math.min(size, 28), type - 7];
    if (type >= 8 && size >= 29) throw new Error("too long for this writer");
    if (type < 8 && size >= 29) return size < 285 ? Buffer.from([head[0]!, size - 29]) : Buffer.from([head[0]!, (size - 285) >> 8, (size - 285) & 255]);
    return Buffer.from(head);
  };
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([control(2, text.length), text]);
  }
  if (typeof value === "number") {
    const bytes = value < 0x10000 ? 2 : value < 0x100000000 ? 4 : 8;
    const out = Buffer.alloc(8);
    out.writeBigUInt64BE(BigInt(value));
    return Buffer.concat([control(bytes === 2 ? 5 : bytes === 4 ? 6 : 9, bytes), out.subarray(8 - bytes)]);
  }
  if (Array.isArray(value)) return Buffer.concat([control(11, value.length), ...value.map(encode)]);
  const entries = Object.entries(value as object);
  return Buffer.concat([control(7, entries.length), ...entries.flatMap(([k, v]) => [encode(k), encode(v)])]);
}

/**
 * A whole MMDB file of one megabyte or so, in which every address has the same record. `meta` overrides the
 * metadata, and `record` the record (null leaves every address without one).
 */
function mmdb(meta: Record<string, unknown> = {}, record: unknown = { country: { iso_code: "US", names: { en: "United States" } }, city: { names: { en: "Mountain View" } } }, pad = 1024 * 1024): Buffer {
  // One node whose two records both point at the first thing in the data section, or at "no data".
  const pointer = record === null ? 1 : 1 + 16;
  const node = Buffer.from([0, 0, pointer, 0, 0, pointer]);
  const data = Buffer.concat([encode(record ?? {}), Buffer.alloc(pad)]);
  const metadata = encode({
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: Date.UTC(2026, 9, 1, 2) / 1000,
    database_type: "DBIP-City-Lite",
    description: { en: "A test database" },
    ip_version: 6,
    languages: ["en"],
    node_count: 1,
    record_size: 24,
    ...meta,
  });
  return Buffer.concat([node, Buffer.alloc(16), data, Buffer.from("\xab\xcd\xefMaxMind.com", "latin1"), metadata]);
}

const sha1 = (bytes: Buffer) => createHash("sha1").update(bytes).digest("hex");

/** DB-IP's download page as it reads, with the CSV file's card before the MMDB file's. */
const page = (mode: string, release: string, sum: string) => `<div class="card"><dl class="card-body"><dt>Format</dt><dd>CSV</dd><dt>MD5SUM</dt>
<dd class="small">93c945395f0bc2ceefea7dd55750417a</dd><dt>SHA1SUM</dt><dd class="small">e2061015c43ec91c94a12191a6a613279eb94c0c</dd></dl>
<a href='https://download.db-ip.com/free/dbip-${mode}-lite-${release}.csv.gz' class='btn'>Download CSV</a></div>
<div class="card"><dl class="card-body"><dt>Format</dt><dd>MMDB</dd><dt>MD5SUM</dt><dd class="small">5974b336a7409ec854f67eacd52c2061</dd>
<dt>SHA1SUM</dt>
					<dd class="small">${sum}</dd></dl>
<a href='https://download.db-ip.com/free/dbip-${mode}-lite-${release}.mmdb.gz' class='btn'>Download MMDB</a></div>`;

const PAGE = "https://db-ip.com/db/download/ip-to-city-lite";
const FILE = (release: string) => `https://download.db-ip.com/free/dbip-city-lite-${release}.mmdb.gz`;
const OCTOBER = Date.UTC(2026, 9, 3, 3);

/** A Geo whose downloads are answered from `answers`, by URL, with every URL asked for and every line logged kept. */
function geoWith(answers: Record<string, () => Response>) {
  const dir = mkdtempSync(path.join(tmpdir(), "rl-geo-"));
  const asked: string[] = [];
  const lines: string[] = [];
  const geo = new Geo(dir, "city", (line) => lines.push(line), (async (url: string, init: RequestInit) => {
    asked.push(url);
    assert.equal(init.redirect, "manual", "no redirect is ever followed");
    return answers[url]?.() ?? new Response("nope", { status: 404 });
  }) as never);
  return { geo, dir, asked, lines, answers };
}

/** Answers for one release: the page with `sum` (the file's own by default), and the file, gzipped. */
function release(name: string, file: Buffer, sum = sha1(file)): Record<string, () => Response> {
  return { [PAGE]: () => new Response(page("city", name, sum)), [FILE(name)]: () => new Response(new Uint8Array(gzipSync(file))) };
}

test("a download whose checksum matches DB-IP's page is put to use", async () => {
  const file = mmdb();
  const t = geoWith(release("2026-10", file));
  await t.geo.refresh(OCTOBER);
  assert.deepEqual(t.asked, [PAGE, FILE("2026-10")]);
  assert.equal(t.geo.release, "2026-10");
  assert.deepEqual(await t.geo.lookup("8.8.8.8"), { country: "US", region: "", city: "Mountain View" });
  assert.deepEqual(readdirSync(t.dir), ["dbip-city-lite-2026-10.mmdb"]);
  assert.equal(sha1(readFileSync(path.join(t.dir, "dbip-city-lite-2026-10.mmdb"))), sha1(file));
  assert.match(t.lines.join("\n"), /\(2026-10\) is ready/);
});

test("early in a month the page still offers last month's release, and that is the one fetched", async () => {
  const t = geoWith(release("2026-09", mmdb({ build_epoch: Date.UTC(2026, 8, 1) / 1000 })));
  await t.geo.refresh(Date.UTC(2026, 9, 1, 3));
  assert.deepEqual(t.asked, [PAGE, FILE("2026-09")]);
  assert.equal(t.geo.release, "2026-09");
  await t.geo.refresh(Date.UTC(2026, 9, 1, 4));
  assert.deepEqual(t.asked.slice(2), [PAGE], "later the page is read again, and the file on disk is not fetched twice");
});

test("a download that does not match the published checksum is never used, and the database in use stays", async () => {
  const good = mmdb({ build_epoch: Date.UTC(2026, 8, 1) / 1000 });
  const t = geoWith(release("2026-09", good));
  await t.geo.refresh(Date.UTC(2026, 8, 20));
  assert.equal(t.geo.release, "2026-09");

  // October's file is not the one DB-IP's page describes: one byte differs.
  const swapped = mmdb({}, { country: { iso_code: "ZZ" } });
  Object.assign(t.answers, release("2026-10", swapped, sha1(mmdb())));
  await t.geo.refresh(OCTOBER);
  assert.equal(t.geo.release, "2026-09", "last month's is still in use");
  assert.deepEqual(await t.geo.lookup("8.8.8.8"), { country: "US", region: "", city: "Mountain View" });
  assert.deepEqual(readdirSync(t.dir), ["dbip-city-lite-2026-09.mmdb"], "nothing of the bad download is left");
  assert.match(t.lines.at(-1)!, new RegExp(`not updated from ${FILE("2026-10").replace(/\./g, "\\.")}: its SHA-1 is ${sha1(swapped)}, and DB-IP publishes ${sha1(mmdb())}`));

  // Bytes after the end of the gzip stream never reach the file: what is kept is what was hashed.
  const october = mmdb();
  Object.assign(t.answers, release("2026-10", october), { [FILE("2026-10")]: () => new Response(new Uint8Array(Buffer.concat([gzipSync(october), Buffer.from("extra")]))) });
  await t.geo.refresh(OCTOBER + 6 * 3_600_000);
  for (const name of readdirSync(t.dir)) assert.ok([sha1(good), sha1(october)].includes(sha1(readFileSync(path.join(t.dir, name)))), "only checked bytes are on disk");
});

test("when no checksum can be read at all, the newest release is taken on its structure alone, with a warning", async () => {
  const file = mmdb();
  for (const [what, answer, why] of [
    ["the page is down", () => new Response("no", { status: 503 }), /could not read DB-IP's checksums.*answered 503/],
    ["the page redirects", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }), /answered 302/],
    ["the page has no checksum", () => new Response(page("city", "2026-10", "")), /found no checksum/],
    ["the page is for another database", () => new Response(page("country", "2026-10", sha1(file))), /found no checksum/],
    ["the page never ends", () => new Response("x".repeat(2 * 1024 * 1024)), /more than 1024 KB/],
  ] as const) {
    const t = geoWith({ ...release("2026-10", file), [PAGE]: answer });
    await t.geo.refresh(OCTOBER);
    assert.deepEqual(t.asked, [PAGE, FILE("2026-10")], what);
    assert.equal(t.geo.release, "2026-10", what);
    assert.deepEqual(readdirSync(t.dir), ["dbip-city-lite-2026-10.mmdb"], what);
    const warnings = t.lines.filter((line) => line.includes("could not be checked against DB-IP's published checksum"));
    assert.equal(warnings.length, 1, what);
    assert.match(warnings[0]!, /^Runlight: warning: location data from DB-IP \(2026-10\)/, what);
    assert.match(warnings[0]!, why, what);
  }

  // As before the page was read: this month's file, then last month's, and a month not out yet is no failure.
  const early = geoWith({ [FILE("2026-09")]: () => new Response(new Uint8Array(gzipSync(mmdb({ build_epoch: Date.UTC(2026, 8, 1) / 1000 })))) });
  await early.geo.refresh(Date.UTC(2026, 9, 1, 3));
  assert.deepEqual(early.asked, [PAGE, FILE("2026-10"), FILE("2026-09")]);
  assert.equal(early.geo.release, "2026-09");
  assert.deepEqual(early.lines.map((line) => line.slice(0, 50)), ["Runlight: warning: location data from DB-IP (2026-", "Runlight: location data from DB-IP (2026-09) is re"]);

  // The other checks still hold: what is not a DB-IP city database is not used, checksum or no checksum.
  const wrong = geoWith({ [FILE("2026-10")]: () => new Response(new Uint8Array(gzipSync(mmdb({ database_type: "GeoLite2-City" })))) });
  await wrong.geo.refresh(OCTOBER);
  assert.equal(wrong.geo.release, "");
  assert.deepEqual(readdirSync(wrong.dir), []);
  assert.match(wrong.lines.join("\n"), /not updated from .*2026-10\.mmdb\.gz: it is a "GeoLite2-City" database/);
  assert.match(wrong.lines.at(-1)!, /not updated: could not read DB-IP's checksums.*and no release could be downloaded without them/);
  assert.ok(!wrong.lines.some((line) => line.includes("warning")), "the warning is for a download that was accepted");
});

test("a page that is read is held to: a release it does not offer is not fetched, and a mismatch is never a fallback", async () => {
  const file = mmdb();
  const old = geoWith({ ...release("2026-10", file), [PAGE]: () => new Response(page("city", "2026-05", sha1(file))) });
  await old.geo.refresh(OCTOBER);
  assert.deepEqual(old.asked, [PAGE]);
  assert.equal(old.geo.release, "");
  assert.match(old.lines.join("\n"), /offers the 2026-05 release/);

  // A good October file is on offer, but the page describes another: refused, with no try at last month's.
  const mismatch = geoWith({ ...release("2026-09", file), ...release("2026-10", file, "0".repeat(40)) });
  await mismatch.geo.refresh(OCTOBER);
  assert.deepEqual(mismatch.asked, [PAGE, FILE("2026-10")]);
  assert.equal(mismatch.geo.release, "");
  assert.deepEqual(readdirSync(mismatch.dir), []);
  assert.match(mismatch.lines.join("\n"), /its SHA-1 is [0-9a-f]{40}, and DB-IP publishes 0{40}/);
  assert.ok(!mismatch.lines.some((line) => line.includes("warning")));
});

test("a download that redirects, is not gzip, or is too large is refused", async () => {
  const file = mmdb();
  for (const [what, answer, said] of [
    ["a redirect", () => new Response(null, { status: 301, headers: { location: "http://download.db-ip.com/x" } }), /answered 301/],
    ["not gzip", () => new Response(new Uint8Array(file)), /header|gzip/i],
    ["cut short", () => new Response(new Uint8Array(gzipSync(file).subarray(0, 300))), /unexpected end/i],
    ["a length past the limit", () => new Response(new Uint8Array(gzipSync(file)), { headers: { "content-length": String(300 * 1024 * 1024) } }), /more than 256 MB/],
  ] as const) {
    const t = geoWith({ ...release("2026-10", file), [FILE("2026-10")]: answer });
    await t.geo.refresh(OCTOBER);
    assert.equal(t.geo.release, "", what);
    assert.match(t.lines.join("\n"), said, what);
    assert.deepEqual(readdirSync(t.dir), [], what);
  }
});

test("a file with the right checksum is still read as a DB-IP database before it is used", async () => {
  const refused = (file: Buffer, inUse = 0) => {
    try {
      checkDatabase(file, "city", OCTOBER, inUse);
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  };
  assert.equal(refused(mmdb()), "");
  assert.match(refused(mmdb({}, undefined, 1000)), /too few/);
  assert.match(refused(Buffer.alloc(2 * 1024 * 1024)), /not an MMDB file/);
  assert.match(refused(mmdb({ database_type: "GeoLite2-City" })), /"GeoLite2-City" database/);
  assert.match(refused(mmdb({ database_type: "DBIP-Country-Lite" })), /not DB-IP's city one/);
  assert.match(refused(mmdb({ binary_format_major_version: 3 })), /version 3/);
  assert.match(refused(mmdb({ ip_version: 4 })), /IP version 4/);
  assert.match(refused(mmdb({ record_size: 20 })), /20 bits|does not open/);
  assert.match(refused(mmdb({ node_count: 900_000 })), /search tree does not fit|does not open/);
  assert.match(refused(mmdb({ build_epoch: Date.UTC(2026, 4, 1) / 1000 })), /built on 2026-05-01/);
  assert.match(refused(mmdb({ build_epoch: Date.UTC(2026, 11, 1) / 1000 })), /built on 2026-12-01/);
  assert.match(refused(mmdb(), Date.UTC(2026, 9, 2)), /older than the database in use/);
  assert.match(refused(mmdb({}, null)), /no country for 8\.8\.8\.8/);
  assert.match(refused(mmdb({}, { city: { names: { en: "Nowhere" } } })), /no country for 8\.8\.8\.8/);

  // And through a download: the page vouches for a file that is not a city database, so it is not used.
  const wrong = mmdb({ database_type: "DBIP-Country-Lite" });
  const t = geoWith(release("2026-10", wrong));
  await t.geo.refresh(OCTOBER);
  assert.equal(t.geo.release, "");
  assert.deepEqual(readdirSync(t.dir), []);
});

test("the checksum read from DB-IP's page is the MMDB file's, not the CSV file's", () => {
  const sum = "09eea8433fe3eed71984fd6aac9d8ab3d9ca51f0";
  assert.deepEqual(publishedChecksum(page("country", "2026-11", sum.toUpperCase()), "country"), { release: "2026-11", sha1: sum });
  assert.equal(publishedChecksum(page("country", "2026-11", sum), "city"), null);
  assert.equal(publishedChecksum(page("city", "2026-11", "abc"), "city"), null, "the CSV file's checksum never stands in");
  assert.equal(publishedChecksum("<html></html>", "city"), null);
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
  assert.deepEqual(asked, [PAGE, FILE("2026-10"), FILE("2026-09")], "the checksum comes first; with none, this month's file and then last month's");
  assert.equal(await geo.lookup("8.8.8.8"), null);
  assert.deepEqual(readdirSync(dir), []);
  await geo.refresh(Date.UTC(2026, 9, 1, 4));
  assert.equal(asked.length, 6, "tried again on the next check");
  assert.match(lines.at(-1)!, /not updated: could not read DB-IP's checksums/);
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
  // The server checks every five minutes; each try asks for the checksum, this month's file, and last month's.
  const tries: number[] = [];
  for (let at = 0; at <= 24 * 60; at += 5) {
    const before = asked;
    await geo.refresh(start + at * minute);
    if (asked > before) tries.push(at);
  }
  assert.deepEqual(tries.slice(0, 8), [0, 5, 15, 35, 75, 155, 315, 635], "each wait is twice the last");
  assert.deepEqual(tries.slice(8), [995, 1355], "and none is longer than six hours");
  assert.equal(asked, tries.length * 3);
});

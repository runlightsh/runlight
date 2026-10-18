import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { importStep } from "../src/importers/index.js";
import { importUmamiVisits } from "../src/importers/visits.js";
import { runlight } from "../src/index.js";
import { publicFetchThroughGlobal } from "../src/safefetch.js";
import type { SqlStore } from "../src/store.js";
import type { ClickHouseStore } from "../src/stores/clickhouse.js";
import { cleanup, freshStore } from "./helpers.js";

// Fetches go to the stand-in fetch below; ClickHouse's requests keep the fetch there was when it loaded.
publicFetchThroughGlobal(true);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
after(cleanup);

type Row = { sessionId: string; createdAt: string; hostname: string; urlPath: string; eventType: number; eventName?: string };

const ev = (sessionId: string, iso: string, urlPath: string, eventName?: string): Row => ({
  sessionId,
  createdAt: new Date(iso).toISOString(),
  hostname: "blog.example.com",
  urlPath,
  eventType: eventName ? 2 : 1,
  ...(eventName ? { eventName } : {}),
});

/** Three weeks of an Umami site: visits of one and several pages, one past midnight, one across two steps. */
const EVENTS = [
  ev("s0", "2026-03-02T10:00:00Z", "/"),
  ev("s0", "2026-03-02T10:02:00Z", "/pricing"),
  ev("s0", "2026-03-02T10:03:00Z", "/pricing", "Signup"),
  ev("s1", "2026-03-14T23:50:00Z", "/a"),
  ev("s1", "2026-03-15T00:10:00Z", "/b"),
  ev("s1", "2026-03-15T00:11:00Z", "/b", "Signup"),
  ev("s2", "2026-03-20T10:00:00Z", "/"),
  ev("s3", "2026-03-20T11:00:00Z", "/a"),
  ev("s3", "2026-03-20T11:20:00Z", "/b"),
  ev("s3", "2026-03-20T12:30:00Z", "/c"),
];

/** A stand-in Umami that answers with EVENTS. */
function umami(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/websites/w1") return reply({ id: "w1", createdAt: "2026-03-01T00:00:00.000Z" });
    const from = Number(url.searchParams.get("startAt"));
    const to = Number(url.searchParams.get("endAt"));
    if (url.pathname === "/api/websites/w1/events") {
      const rows = EVENTS.filter((e) => Date.parse(e.createdAt) >= from && Date.parse(e.createdAt) <= to).reverse();
      return reply({ data: rows, count: rows.length });
    }
    if (url.pathname === "/api/websites/w1/sessions") return reply({ data: [], count: 0 });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

/** A stand-in Dub with one link and its clicks over two days. */
function dub(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (/api\.dub\.co\/links\?.*startingAfter=l1/.test(url.href)) return reply([]);
    if (/api\.dub\.co\/links\?/.test(url.href)) return reply([{ id: "l1", domain: "dub.sh", key: "launch", url: "https://a.com/launch", title: "Launch", createdAt: "2026-01-02T00:00:00Z" }]);
    if (/\/events\?.*linkId=l1/.test(url.href)) {
      return reply([
        { timestamp: "2026-03-01T10:00:00Z", click: { id: "c1", country: "CA", device: "Mobile", browser: "Chrome", os: "iOS", referer: "instagram.com", refererUrl: "https://instagram.com/" } },
        { timestamp: "2026-03-01T10:00:30Z", click: { id: "c2", country: "CA", device: "Mobile", browser: "Chrome", os: "iOS", referer: "instagram.com" } },
        { timestamp: "2026-03-02T10:00:00Z", click: { id: "c3", country: "US", device: "Desktop", browser: "Safari", os: "Mac OS", referer: "(direct)" } },
      ]);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

function install(store: SqlStore) {
  const rl = runlight({ store, site: { hostnames: ["blog.example.com"], timezone: "UTC" }, now: () => Date.parse("2026-03-25T12:00:00Z") });
  const { GET } = rl.routes({ token: null });
  const get = async (path: string) => (await GET(new Request(`https://x.com/runlight${path}`))).json() as Promise<any>;
  return { rl, get };
}

async function importVisits(rl: ReturnType<typeof install>["rl"]): Promise<void> {
  let cursor: string | null = null;
  do cursor = (await importUmamiVisits(rl, "default", { url: "https://umami.example.com", apiKey: "key" }, "w1", cursor)).cursor;
  while (cursor);
}

async function importLinks(rl: ReturnType<typeof install>["rl"]): Promise<void> {
  let cursor: string | null = null;
  let done = 0;
  do {
    const step = await importStep(rl, "default", "dub", { apiKey: "dub_test" }, cursor, done, async (domain) => domain);
    cursor = step.cursor;
    done = step.done;
  } while (cursor);
}

/** What the dashboard shows over the imported weeks. */
async function reports(get: ReturnType<typeof install>["get"]) {
  const range = "from=2026-03-01&to=2026-03-24&compare=off";
  return {
    stats: (await get(`/api/stats?${range}`)).stats,
    pages: (await get(`/api/breakdown?${range}&dimension=page`)).rows,
    entry: (await get(`/api/breakdown?${range}&dimension=entry`)).rows,
    exit: (await get(`/api/breakdown?${range}&dimension=exit`)).rows,
    events: (await get(`/api/breakdown?${range}&dimension=event`)).rows,
    series: (await get(`/api/series?${range}`)).points,
  };
}

if (process.env.RUNLIGHT_TEST_CLICKHOUSE) {
  test("a visit import reads the same on ClickHouse as on SQLite, and again after a re-run", async () => {
    umami();
    const plain = install(freshStore("sqlite"));
    await importVisits(plain.rl);
    const expected = await reports(plain.get);
    assert.equal(expected.stats.visits, 5);

    const own = install(freshStore("clickhouse"));
    await importVisits(own.rl);
    assert.deepEqual(await reports(own.get), expected);
    // Every step written again counts each visit once.
    await importVisits(own.rl);
    assert.deepEqual(await reports(own.get), expected);
  });

  test("a link import counts the same clicks on ClickHouse as on SQLite", async () => {
    dub();
    const plain = install(freshStore("sqlite"));
    await importLinks(plain.rl);
    const own = install(freshStore("clickhouse"));
    await importLinks(own.rl);
    const clicks = async (store: SqlStore) => (await store.links("default", 0, Date.parse("2026-03-25T00:00:00Z"))).map((l) => [l.slug, l.clicks, l.visitors]);
    assert.deepEqual(await clicks(own.rl.store), await clicks(plain.rl.store));
    assert.deepEqual(await clicks(own.rl.store), [["launch", 3, 3]]);
  });

  test("imports are turned away while visits are still being copied into ClickHouse", async () => {
    const own = install(freshStore("clickhouse"));
    await own.rl.init();
    const store = own.rl.store as ClickHouseStore;
    const at = Date.parse("2026-03-25T00:00:00Z");
    await (store as unknown as { setMeta(key: string, value: string): Promise<void> }).setMeta("move", JSON.stringify({ at, through: at - 86_400_000, done: false }));
    umami();
    await assert.rejects(importVisits(own.rl), /still being copied/);
    dub();
    await assert.rejects(importLinks(own.rl), /still being copied/);
    assert.deepEqual(await store.links("default", 0, at), []);
  });
}

// A year of made-up traffic for one site, written straight into a SQLite file, for trying Runlight at size.
//
//   node --import tsx scripts/bench-data.mts --visits 10000000 --out runlight-data/runlight.db
//
// The file is what the standalone server keeps in DATA_DIR, so it opens with the server as it is, or with
// CLICKHOUSE_URL set to move the visits into ClickHouse. The visits end now, so the last two days are
// copied first, as they are on a real install. About 1.8 GB and a minute a million visits.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { sqlite } from "../packages/sdk/src/stores/sqlite.ts";

const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1]! : fallback;
};
const VISITS = Number(arg("visits", "1000000"));
const OUT = arg("out", "runlight-data/runlight.db");
const SITE = arg("site", "example.com");
const DAY = 86_400_000;
if (!Number.isSafeInteger(VISITS) || VISITS < 1) throw new Error("--visits should be a whole number");
if (existsSync(OUT)) throw new Error(`${OUT} is already there; pick another --out, or delete it first`);

// The tables as the store makes them, then the indexes dropped while the rows go in, and made again after.
const store = sqlite({ path: OUT });
await store.migrate();
await store.upsertSite({ id: SITE, name: SITE, hostnames: [SITE], timezone: "UTC" }, Date.now());
await store.close();
const db = new Database(OUT);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = OFF");
const indexes = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name IN ('rl_sessions', 'rl_events')`).all() as Array<{ name: string; sql: string }>;
for (const index of indexes) db.exec(`DROP INDEX ${index.name}`);

/** One of `items`, the earlier ones more often. */
const pick = <T,>(items: readonly T[]): T => items[Math.floor(items.length * Math.random() ** 2)]!;
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");

const PAGES = ["/", "/pricing", "/blog", "/blog/launch", "/docs", "/docs/install", "/about", "/blog/privacy", "/contact", "/changelog", "/blog/benchmarks", "/careers", ...Array.from({ length: 200 }, (_, i) => `/blog/post-${i}`)];
const SOURCES = [
  { source: "", channel: "Direct", host: "" },
  { source: "Google", channel: "Organic Search", host: "www.google.com" },
  { source: "Bing", channel: "Organic Search", host: "www.bing.com" },
  { source: "DuckDuckGo", channel: "Organic Search", host: "duckduckgo.com" },
  { source: "Hacker News", channel: "Social", host: "news.ycombinator.com" },
  { source: "Reddit", channel: "Social", host: "www.reddit.com" },
  { source: "ChatGPT", channel: "AI", host: "chatgpt.com" },
  { source: "Newsletter", channel: "Email", host: "" },
  { source: "GitHub", channel: "Referral", host: "github.com" },
];
const PLACES = [["US", "CA", "San Francisco"], ["GB", "ENG", "London"], ["DE", "BE", "Berlin"], ["FR", "IDF", "Paris"], ["CA", "ON", "Toronto"], ["IN", "KA", "Bengaluru"], ["BR", "SP", "São Paulo"], ["JP", "13", "Tokyo"], ["AU", "NSW", "Sydney"], ["ES", "MD", "Madrid"]] as const;
const CLIENTS = [["Chrome", "Mac", "desktop", "1512x982"], ["Safari", "iOS", "mobile", "390x844"], ["Chrome", "Windows", "desktop", "1920x1080"], ["Chrome", "Android", "mobile", "412x915"], ["Firefox", "Windows", "desktop", "1920x1080"], ["Edge", "Windows", "desktop", "1536x864"], ["Safari", "Mac", "desktop", "1440x900"]] as const;
const LANGUAGES = ["en-US", "en-GB", "de-DE", "fr-FR", "es-ES", "pt-BR", "ja-JP"];

const visit = db.prepare(`INSERT INTO rl_sessions (id, site, visitor, started_at, last_at, entry_path, exit_path, pageviews, events, engaged_ms, imported,
  hostname, referrer_host, referrer_path, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
  country, region, city, browser, browser_version, os, os_version, device, screen, language)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '', ?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, '', ?, '', ?, ?, ?)`);
const event = db.prepare(`INSERT INTO rl_events (site, ts, kind, visitor, session, pageview, path, hostname, title, name, props, engaged_ms, scroll, link)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, '')`);

const end = Date.now() - 60_000;
const start = end - 365 * DAY;
// A year of growth, quieter weekends, and a busier day now and then, scaled so the days add up to VISITS.
const weights = Array.from({ length: 365 }, (_, day) => {
  const weekday = new Date(start + day * DAY).getUTCDay();
  return (0.7 + (0.6 * day) / 365) * (weekday === 0 || weekday === 6 ? 0.75 : 1.08) * (day % 47 === 0 ? 1.8 : 1);
});
const perWeight = VISITS / weights.reduce((sum, w) => sum + w, 0);
let written = 0;
let events = 0;
const began = Date.now();
for (let day = 0; day < 365; day++) {
  const dayStart = start + day * DAY;
  const count = day === 364 ? VISITS - written : Math.round(perWeight * weights[day]!);
  // A visitor id lasts a day, so each day has its own.
  const visitors = Array.from({ length: Math.max(1, Math.round(count * 0.85)) }, () => hex(16));
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const at = dayStart + Math.floor(Math.random() * DAY);
      if (at > end) continue;
      const id = hex(24);
      const who = visitors[Math.floor(Math.random() * visitors.length)]!;
      const from = pick(SOURCES);
      const [country, region, city] = pick(PLACES);
      const [browser, os, device, screen] = pick(CLIENTS);
      const campaign = from.channel === "Email" ? "weekly" : Math.random() < 0.05 ? "launch" : "";
      const views = 1 + Math.floor(Math.random() ** 3 * 6);
      let ts = at;
      let entry = "";
      let exit = "";
      let engaged = 0;
      let signups = 0;
      for (let v = 0; v < views; v++) {
        const path = v === 0 ? pick(PAGES) : PAGES[Math.floor(Math.random() * PAGES.length)]!;
        const pageview = hex(16);
        const time = Math.floor(5_000 + Math.random() * 120_000);
        event.run(SITE, ts, "pageview", who, id, pageview, path, SITE, "", null, 0, null);
        event.run(SITE, ts + time, "engagement", who, id, pageview, path, SITE, "", null, time, Math.floor(20 + Math.random() * 80));
        if (path === "/pricing" && Math.random() < 0.2) {
          event.run(SITE, ts + Math.floor(time / 2), "event", who, id, pageview, path, SITE, "Signup", JSON.stringify({ plan: Math.random() < 0.3 ? "pro" : "free" }), 0, null);
          signups++;
          events++;
        }
        entry ||= path;
        exit = path;
        engaged += time;
        events += 2;
        if (v < views - 1) ts += time + Math.floor(Math.random() * 30_000);
      }
      visit.run(id, SITE, who, at, ts, entry, exit, views, signups, engaged, SITE, from.host, from.source, from.channel,
        campaign ? from.source.toLowerCase() || "newsletter" : "", campaign ? "email" : "", campaign, country, region, city, browser, os, device, screen, pick(LANGUAGES));
      written++;
    }
  })();
  if (day % 30 === 29 || day === 364) console.log(`${new Date(dayStart).toISOString().slice(0, 10)}: ${written.toLocaleString("en")} visits, ${events.toLocaleString("en")} events, ${Math.round((Date.now() - began) / 1000)} s`);
}
console.log("Making the indexes again...");
for (const index of indexes) db.exec(index.sql);
db.exec("ANALYZE");
db.close();
console.log(`Done in ${Math.round((Date.now() - began) / 1000)} s: ${written.toLocaleString("en")} visits and ${events.toLocaleString("en")} events for ${SITE} in ${OUT}.`);

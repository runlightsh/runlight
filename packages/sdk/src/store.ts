import {
  EVENT_DIMENSIONS,
  SESSION_DIMENSIONS,
  isSessionDimension,
  type Dimension,
  type Filter,
  type Query,
  type SessionDimension,
} from "./query.js";
import { recordedPath } from "./sources.js";

/**
 * The little a store needs from a database driver. SQL uses `?` placeholders and
 * "double quotes" around a name that is a keyword somewhere; the Postgres driver
 * numbers the placeholders, and the MySQL driver fills them in and quotes names
 * its own way. ClickHouse holds only the visits and events, for a ClickHouseStore,
 * and is only ever read through this; its driver types the placeholders.
 */
export interface Db {
  dialect: "sqlite" | "postgres" | "mysql" | "clickhouse";
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  /** Runs an UPDATE or DELETE and says how many rows it matched. MySQL has no RETURNING, so its driver has this. */
  affected?(sql: string, params?: unknown[]): Promise<number>;
  /**
   * Runs `fn` while holding a database-wide lock, so two processes starting
   * at once do not race to create the same tables. Waits for the lock at most
   * LOCK_WAIT_MS, then throws a TablesBusyError. Optional: SQLite's file lock
   * already serialises its writers.
   */
  exclusive?<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  /**
   * Runs `fn` in one transaction on one connection. Optional: without it the
   * store sends BEGIN and COMMIT itself, which is only safe when nothing else
   * can run on the connection meanwhile. A store with one shared connection
   * should wrap its Db in `oneConnection()`, which provides this.
   */
  transaction?<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
  /**
   * True for a database reached one statement at a time over the network with a cap on statements per
   * request (Cloudflare D1), so long jobs send fewer, larger pieces.
   */
  metered?: boolean;
}

/** The longest a process waits for another one creating or upgrading the tables before it gives up. */
export const LOCK_WAIT_MS = 30_000;

let lockWait = LOCK_WAIT_MS;

/** How long the stores wait for the lock for creating tables: LOCK_WAIT_MS, unless a test has set another. */
export const lockWaitMs = (): number => lockWait;

/** For tests: the stores wait this long for the lock instead, or LOCK_WAIT_MS again with null. */
export function lockWaitInTests(ms: number | null): void {
  lockWait = ms ?? LOCK_WAIT_MS;
}

/**
 * Another process held the lock for creating tables past LOCK_WAIT_MS, such as one building an index on a
 * big table after an upgrade. The request that waited fails with this, rather than waiting for good.
 */
export class TablesBusyError extends Error {
  constructor(waited: number = LOCK_WAIT_MS) {
    super(`Runlight: another process is creating or upgrading the tables, and had not finished after ${Math.round(waited / 1000)} seconds. Try again in a minute.`);
    this.name = "TablesBusyError";
  }
}

/** Lets other work run: resolves once the event loop has come round. */
const pause = (): Promise<void> => new Promise((resolve) => (typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0)));

/**
 * For a store with one connection shared by every request (SQLite through
 * better-sqlite3 or Bun). Statements and transactions take turns, so a
 * request's insert can never land inside an import's open transaction, and
 * a rollback can only undo the transaction's own writes.
 */
export function oneConnection(inner: Db): Db {
  let tail: Promise<unknown> = Promise.resolve();
  const turn = <T>(fn: () => Promise<T>): Promise<T> => {
    // Each statement waits for the event loop to come round first. A driver that runs statements
    // synchronously holds the whole process while one runs, so this lets requests that arrived
    // meanwhile (a tracker hit during a long export) have their turn between two statements.
    const result = tail.then(pause, pause).then(fn);
    tail = result.catch(() => {});
    return result;
  };
  return {
    ...inner,
    all: (sql, params) => turn(() => inner.all(sql, params)),
    run: (sql, params) => turn(() => inner.run(sql, params)),
    // Statements inside the transaction use the connection directly; they already hold the turn.
    transaction: (fn) =>
      turn(async () => {
        await inner.run("BEGIN");
        try {
          const result = await fn(inner);
          await inner.run("COMMIT");
          return result;
        } catch (error) {
          await inner.run("ROLLBACK");
          throw error;
        }
      }),
  };
}

export interface SiteRow {
  id: string;
  name: string;
  hostnames: string[];
  timezone: string;
}

/** What the dashboard may change about a site. */
export interface SiteOverrides {
  name?: string;
  timezone?: string;
}

/**
 * Something worth counting. An event goal counts a named event; a page goal
 * counts pageviews of a path or pattern (`/thanks*`); a click goal is a rule
 * the tracker applies itself, sending an event named after the goal. Event and
 * page goals are worked out when stats are read, so a new one counts past visits
 * too; a click goal counts from when the tracker starts sending its event.
 */
export interface GoalRow {
  id: string;
  site: string;
  name: string;
  kind: "event" | "page" | "click";
  /** The event name, the path pattern, or for a click goal a CSS selector or URL pattern. */
  match: string;
  /** For click goals: what `match` is. */
  clickBy: "selector" | "link" | "";
  /** No money, the same amount each time, or the amount sent in an event property. */
  valueMode: "none" | "fixed" | "prop";
  value: number;
  valueProp: string;
  currency: string;
  createdAt: number;
}

/** Someone who gets a site's report by email. `token` is the unsubscribe key. */
export interface ReportRow {
  id: string;
  site: string;
  email: string;
  frequency: "weekly" | "monthly";
  lang: string;
  token: string;
  /** Where the dashboard lives, for the links in the email. */
  origin: string;
  /** The last period sent, like w:2026-09-28 or m:2026-09, so nothing goes out twice. */
  lastPeriod: string;
  lastSentAt: number | null;
  createdAt: number;
}

export interface GoalTotals {
  conversions: number;
  visitors: number;
  revenue: number;
}

/** A public, read-only view of one site's stats, opened by its unguessable id. */
export interface ShareRow {
  id: string;
  site: string;
  name: string;
  createdAt: number;
}

/** One step of a funnel: reaching a page (with * as a wildcard), or sending an event. */
export interface FunnelStep {
  kind: "page" | "event";
  match: string;
}

/** Steps a visit is expected to take in order, such as pricing, then signup, then the welcome page. */
export interface FunnelRow {
  id: string;
  site: string;
  name: string;
  steps: FunnelStep[];
  createdAt: number;
}

/** An API token. Only its hash is stored; the token itself is shown once. */
export interface TokenRow {
  id: string;
  name: string;
  /** "" reads every site; otherwise the one site it may read. */
  site: string;
  /**
   * "read" reads stats. "manage", for a Runlight hub, also changes its one site's goals, funnels, short links,
   * link domains, email reports, and share links, along with its name, timezone, and retention, and gets
   * tickets for the element picker. "embed", for a CMS plugin, only gets tickets that open its one site's
   * reports inside the CMS's admin pages, and reads nothing itself.
   */
  scope: "read" | "manage" | "embed";
  hash: string;
  /** The token's last four characters, so people can tell theirs apart. */
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface LinkRow {
  id: string;
  site: string;
  /** A custom link domain, or "" for the app's own. */
  domain: string;
  slug: string;
  name: string;
  url: string;
  createdAt: number;
  updatedAt: number;
}

export interface LinkStats {
  clicks: number;
  visitors: number;
}

export interface SessionRow {
  id: string;
  site: string;
  visitor: string;
  startedAt: number;
  hostname: string;
  referrerHost: string;
  referrerPath: string;
  source: string;
  channel: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
  country: string;
  region: string;
  city: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  device: string;
  screen: string;
  language: string;
}

export interface EventRow {
  site: string;
  ts: number;
  kind: "pageview" | "event" | "engagement" | "click" | "fetch";
  visitor: string;
  session: string;
  pageview: string;
  path: string;
  hostname: string;
  title: string;
  name: string;
  props: Record<string, string> | null;
  engagedMs: number;
  scroll: number | null;
  link: string;
}

export interface Stats {
  visitors: number;
  visits: number;
  pageviews: number;
  viewsPerVisit: number;
  /** 0 to 1. */
  bounceRate: number;
  /** Mean engaged time per visit, milliseconds. */
  visitDuration: number;
}

export interface Bucket {
  start: number;
  end: number;
}

export interface SeriesPoint {
  start: number;
  visitors: number;
  visits: number;
  pageviews: number;
  /** Of the visits that started in this bucket. */
  viewsPerVisit: number;
  bounceRate: number;
  visitDuration: number;
}

export interface BreakdownRow {
  value: string;
  visitors: number;
  visits?: number;
  pageviews?: number;
  events?: number;
  bounceRate?: number;
  /** Mean engaged time per pageview, milliseconds, for pages. A view under a second counts as none. */
  timeOnPage?: number;
  /** Mean deepest scroll, percent, for pages, over the pageviews that reported one. */
  scrollDepth?: number;
  /** Mean engaged time per visit, milliseconds, for visit dimensions. */
  visitDuration?: number;
  fetches?: number;
}

export interface Realtime {
  visitors: number;
  pages: Array<{ value: string; visitors: number }>;
  sources: Array<{ value: string; visitors: number }>;
  countries: Array<{ value: string; visitors: number }>;
  /** Pageviews per minute for the last 30 minutes, oldest first. */
  minutes: number[];
  /** The latest pageviews and events, newest first: what happened, never who. */
  recent: Array<{ ts: number; kind: string; path: string; name: string; country: string; city: string; source: string; device: string }>;
}

/** A session's bounce: one page, nothing clicked that was tracked, under ten seconds engaged. */
export const BOUNCE_MS = 10_000;
const BOUNCE = `(s.pageviews = 1 AND s.events = 0 AND (s.engaged_ms IS NULL OR s.engaged_ms < ${BOUNCE_MS}))`;
const VISIT_KINDS = "e.kind IN ('pageview', 'event')";
/**
 * Cloudflare D1 takes at most 100 bound parameters a statement, so lists that grow with the
 * range (chart buckets, values) go in pieces, and built days are chosen by their dates.
 */
const BUCKETS_PER_QUERY = 30;
const VALUES_PER_QUERY = 50;
/** The most values one statement binds: D1's 100, less a little. */
const MAX_PARAMS = 96;
/** The built days inside a range, as a subquery taking (site, from, to). */
const BUILT_DAYS = "SELECT day FROM rl_rollup_days WHERE site = ? AND start_at >= ? AND end_at <= ?";

/** Orders text by code point, as SQLite and Postgres's "C" collation do (JavaScript's < compares UTF-16 units). */
function codeOrder(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return x.length - y.length;
}

/** Runs a query over pieces of a list and joins the answers, in order. */
async function inPieces<T, R>(items: T[], size: number, run: (piece: T[]) => Promise<R[]>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await run(items.slice(i, i + size))));
  return out;
}

/** The most visits journeys reads, newest first. */
export const JOURNEY_VISITS = 20_000;
/** The most visits a funnel is counted over: the newest in the range, so its rows fit in memory over any range. */
export const FUNNEL_VISITS = 100_000;

/** How long after a visit starts its events are looked for: far past any real visit. */
export const EVENT_TAIL_MS = 2 * 86_400_000;

/** How many engagement rows ClickHouse adds up per pageview in one query: about 500 MB of memory. */
const ENGAGED_PER_SLICE = 3_000_000;

/** What every table and index name starts with, unless a store is given another prefix in its place. */
export const PREFIX = "rl_";

/**
 * Runlight's tables, after the prefix: the store's, and the sign-in accounts' two. An app dropping
 * Runlight's tables drops these by name, never every table that starts with the prefix.
 */
export const TABLES = [
  "meta", "sites", "salts", "sessions", "events", "links", "link_domains", "shares", "goals", "settings",
  "reports", "tokens", "funnels", "rollup_days", "rollups", "users", "invites",
] as const;

/** The prefix each prefixed Db was made with, so a store over one keeps it. */
const prefixes = new WeakMap<Db, string>();

/**
 * A Db whose tables and indexes start with `prefix` in place of `rl_`, such as `wp_rl_` inside WordPress, so
 * two apps sharing one database each keep a set of their own. Runlight's SQL names every table and index
 * `rl_` and something, and those names alone are rewritten on the way through, in each statement and in the
 * names a schema check compares as text. A store given a prefix puts one in front of its Db, so the accounts
 * and importers that reach the Db through the store follow it too.
 */
export function prefixed(inner: Db, prefix: string): Db {
  // A name in a statement, and short enough that the longest index name stays inside MySQL's 64.
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(prefix)) {
    throw new Error("Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit");
  }
  const sql = (text: string) => text.replace(/\brl_(?=[a-z])/g, prefix);
  const wrap = (db: Db): Db => (db === inner ? outer : prefixed(db, prefix));
  const outer: Db = {
    dialect: inner.dialect,
    all: (text, params) => inner.all(sql(text), params),
    run: (text, params) => inner.run(sql(text), params),
    ...(inner.affected ? { affected: (text: string, params?: unknown[]) => inner.affected!(sql(text), params) } : {}),
    ...(inner.exclusive ? { exclusive: <T>(fn: (db: Db) => Promise<T>) => inner.exclusive!((db) => fn(wrap(db))) } : {}),
    ...(inner.transaction ? { transaction: <T>(fn: (db: Db) => Promise<T>) => inner.transaction!((db) => fn(wrap(db))) } : {}),
    ...(inner.close ? { close: () => inner.close!() } : {}),
    ...(inner.metered ? { metered: true } : {}),
  };
  prefixes.set(outer, prefix);
  return outer;
}

const PIECE_MS = 86_400_000;

/** Text cut to at most `max` characters, as a VARCHAR(max) holds it, never through the middle of one. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}


/**
 * Pageviews that can report engaged time: the tracker's, which carry a pageview id. Imported history has
 * none, so time on page is the mean over these, counting a view that reported nothing (under a second) as none.
 */
const LIVE_VIEWS = "SUM(CASE WHEN e.pageview <> '' THEN 1 ELSE 0 END)";

/** A session that is a visit: a short link click alone opens one that is not. */
const IS_VISIT = "(s.pageviews > 0 OR s.events > 0)";

/** Engaged time, or for imported visits with none, first to last request. */
const DURATION = "COALESCE(s.engaged_ms, s.last_at - s.started_at)";

const SCHEMA_VERSION = 11;

/**
 * MySQL's text collation: UTF-8 compared and sorted by code point, case and trailing spaces included,
 * as SQLite and Postgres's "C" collation do. MariaDB has it too, from 11.4.
 */
export const MYSQL_COLLATION = "utf8mb4_0900_bin";

function schema(dialect: Db["dialect"]): string[] {
  const my = dialect === "mysql";
  const id = dialect === "postgres" ? "BIGSERIAL PRIMARY KEY" : my ? "BIGINT AUTO_INCREMENT PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
  // MySQL keys and indexes TEXT only by a prefix, so there a column that is keyed, indexed, grouped, or
  // sorted is VARCHAR, sized past anything Runlight writes to it. Elsewhere text is text.
  const str = (n: number) => (my ? `VARCHAR(${n})` : "TEXT");
  const text = (n: number) => `${str(n)} NOT NULL DEFAULT ''`;
  // Free text that is never keyed. MySQL takes a default for it only as an expression.
  const long = (fallback: string) => (my ? `MEDIUMTEXT NOT NULL DEFAULT ('${fallback}')` : `TEXT NOT NULL DEFAULT '${fallback}'`);
  const table = my ? ` DEFAULT CHARSET=utf8mb4 COLLATE=${MYSQL_COLLATION}` : "";
  const site = str(100);
  const key = str(100);
  const path = 1000;
  return [
    `CREATE TABLE IF NOT EXISTS rl_meta ("key" ${str(100)} PRIMARY KEY, value ${my ? "MEDIUMTEXT" : "TEXT"} NOT NULL)${table}`,
    `CREATE TABLE IF NOT EXISTS rl_sites (
      id ${site} PRIMARY KEY, name ${text(200)}, hostnames ${long("[]")},
      timezone ${str(64)} NOT NULL DEFAULT 'UTC', created_at BIGINT NOT NULL,
      overrides ${long("{}")})${table}`,
    `CREATE TABLE IF NOT EXISTS rl_salts (day ${str(32)} PRIMARY KEY, salt ${str(255)} NOT NULL)${table}`,
    `CREATE TABLE IF NOT EXISTS rl_sessions (
      id ${key} PRIMARY KEY, site ${site} NOT NULL, visitor ${key} NOT NULL,
      started_at BIGINT NOT NULL, last_at BIGINT NOT NULL,
      entry_path ${text(path)}, exit_path ${text(path)},
      pageviews INTEGER NOT NULL DEFAULT 0, events INTEGER NOT NULL DEFAULT 0,
      engaged_ms BIGINT, imported INTEGER NOT NULL DEFAULT 0,
      hostname ${text(255)}, referrer_host ${text(255)}, referrer_path ${text(500)},
      source ${text(200)}, channel ${text(100)},
      utm_source ${text(200)}, utm_medium ${text(200)}, utm_campaign ${text(200)}, utm_term ${text(200)}, utm_content ${text(200)},
      country ${text(16)}, region ${text(100)}, city ${text(100)},
      browser ${text(100)}, browser_version ${text(100)}, os ${text(100)}, os_version ${text(100)},
      device ${text(50)}, screen ${text(50)}, language ${text(50)})${table}`,
    `CREATE INDEX IF NOT EXISTS rl_sessions_site_started ON rl_sessions (site, started_at)`,
    // MySQL takes an index that leads with the site as a way to read all of a site's rows, even where a
    // range of time would read far fewer, so there an index for looking a value up leads with that value.
    `CREATE INDEX IF NOT EXISTS rl_sessions_visitor ON rl_sessions (${my ? "visitor, site" : "site, visitor"}, last_at)`,
    // Keep exact visitor counts in index order without loading every session row.
    ...(dialect === "sqlite" ? [`CREATE INDEX IF NOT EXISTS rl_sessions_visit_visitors ON rl_sessions (site, visitor, started_at) WHERE pageviews > 0 OR events > 0`] : []),
    `CREATE TABLE IF NOT EXISTS rl_events (
      id ${id}, site ${site} NOT NULL, ts BIGINT NOT NULL, kind ${str(20)} NOT NULL,
      visitor ${text(100)}, session ${text(100)}, pageview ${text(100)},
      path ${text(path)}, hostname ${text(255)}, title ${text(500)}, name ${text(255)}, props ${my ? "MEDIUMTEXT" : "TEXT"},
      engaged_ms BIGINT NOT NULL DEFAULT 0, scroll INTEGER, link ${text(100)})${table}`,
    `CREATE INDEX IF NOT EXISTS rl_events_site_ts ON rl_events (site, ts)`,
    // Goals and events read one kind of row in a range; created on start for older databases too.
    `CREATE INDEX IF NOT EXISTS rl_events_site_kind_ts ON rl_events (site, kind, ts)`,
    `CREATE INDEX IF NOT EXISTS rl_events_pageview ON rl_events (${my ? "pageview, site" : "site, pageview"})`,
    // Page and event filters find the visits they pick through these, rather than reading every row in the range.
    // MySQL indexes the first 255 characters of a path, which is enough to find it.
    `CREATE INDEX IF NOT EXISTS rl_events_site_path ON rl_events (${my ? "path(255), site" : "site, path"}, ts)`,
    ...(dialect === "sqlite" ? [`CREATE INDEX IF NOT EXISTS rl_events_hostname_suggest ON rl_events (site, hostname, ts, session) WHERE kind = 'pageview'`] : []),
    // MySQL has no partial index, so its index of event names holds the kind too.
    my
      ? `CREATE INDEX IF NOT EXISTS rl_events_site_name ON rl_events (name, site, kind, ts)`
      : `CREATE INDEX IF NOT EXISTS rl_events_site_name ON rl_events (site, name, ts) WHERE kind = 'event'`,
    // Version 3: short links; "" is the app's own domain. Version 4: a slug is unique
    // across every domain, so a link whose domain is removed can fall back to the
    // app's own link path without colliding with another. MySQL has no partial index,
    // so there a generated column holds the slug of a live link only, and is unique.
    `CREATE TABLE IF NOT EXISTS rl_links (
      id ${key} PRIMARY KEY, site ${site} NOT NULL, domain ${text(255)}, slug ${str(255)} NOT NULL,
      name ${text(255)}, url ${str(4000)} NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      deleted_at BIGINT${my ? ", live_slug VARCHAR(255) AS (CASE WHEN deleted_at IS NULL THEN slug END) VIRTUAL" : ""})${table}`,
    my
      ? `CREATE UNIQUE INDEX IF NOT EXISTS rl_links_slug_unique ON rl_links (live_slug)`
      : `CREATE UNIQUE INDEX IF NOT EXISTS rl_links_slug_unique ON rl_links (slug) WHERE deleted_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS rl_events_link ON rl_events (link, ts)`,
    `CREATE TABLE IF NOT EXISTS rl_link_domains (domain ${str(255)} PRIMARY KEY, site ${site} NOT NULL, created_at BIGINT NOT NULL)${table}`,
    // Version 5: share links.
    `CREATE TABLE IF NOT EXISTS rl_shares (id ${key} PRIMARY KEY, site ${site} NOT NULL, name ${text(255)}, created_at BIGINT NOT NULL)${table}`,
    // Version 6: goals.
    `CREATE TABLE IF NOT EXISTS rl_goals (
      id ${key} PRIMARY KEY, site ${site} NOT NULL, name ${str(255)} NOT NULL, kind ${str(20)} NOT NULL, "match" ${str(1000)} NOT NULL,
      click_by ${text(20)}, value_mode ${str(20)} NOT NULL DEFAULT 'none', value ${my ? "DOUBLE" : "REAL"} NOT NULL DEFAULT 0,
      value_prop ${text(255)}, currency ${str(10)} NOT NULL DEFAULT 'USD', created_at BIGINT NOT NULL)${table}`,
    // Version 7: install-wide settings (the mail service) and email report subscriptions.
    `CREATE TABLE IF NOT EXISTS rl_settings ("key" ${str(255)} PRIMARY KEY, value ${my ? "MEDIUMTEXT" : "TEXT"} NOT NULL)${table}`,
    `CREATE TABLE IF NOT EXISTS rl_reports (
      id ${key} PRIMARY KEY, site ${site} NOT NULL, email ${str(320)} NOT NULL, frequency ${str(20)} NOT NULL,
      lang ${str(20)} NOT NULL DEFAULT 'en', token ${str(128)} NOT NULL, origin ${text(500)},
      last_period ${text(40)}, last_sent_at BIGINT, created_at BIGINT NOT NULL)${table}`,
    `CREATE UNIQUE INDEX IF NOT EXISTS rl_reports_token ON rl_reports (token)`,
    // Version 8: read-only API tokens, for scripts and AI assistants over MCP.
    `CREATE TABLE IF NOT EXISTS rl_tokens (
      id ${key} PRIMARY KEY, name ${str(255)} NOT NULL, site ${text(100)}, hash ${str(128)} NOT NULL, hint ${text(20)},
      created_at BIGINT NOT NULL, last_used_at BIGINT, scope ${str(20)} NOT NULL DEFAULT 'read')${table}`,
    `CREATE UNIQUE INDEX IF NOT EXISTS rl_tokens_hash ON rl_tokens (hash)`,
    // Version 9: funnels.
    `CREATE TABLE IF NOT EXISTS rl_funnels (id ${key} PRIMARY KEY, site ${site} NOT NULL, name ${str(255)} NOT NULL, steps ${my ? "MEDIUMTEXT" : "TEXT"} NOT NULL, created_at BIGINT NOT NULL)${table}`,
    // Version 11: daily rollups. A day is the site's own local day; rl_rollup_days
    // says which days are built and where they begin and end.
    `CREATE TABLE IF NOT EXISTS rl_rollup_days (site ${site} NOT NULL, day ${str(32)} NOT NULL, start_at BIGINT NOT NULL, end_at BIGINT NOT NULL, PRIMARY KEY (site, day))${table}`,
    `CREATE INDEX IF NOT EXISTS rl_rollup_days_range ON rl_rollup_days (site, start_at)`,
    // A value can be a whole path, longer than MySQL's keys allow, so there the rows of a day are
    // found by an index without it; a day's rows are only ever written all at once.
    `CREATE TABLE IF NOT EXISTS rl_rollups (
      site ${site} NOT NULL, day ${str(32)} NOT NULL, dim ${str(32)} NOT NULL, value ${text(path)},
      visitors BIGINT NOT NULL DEFAULT 0, visits BIGINT NOT NULL DEFAULT 0, pageviews BIGINT NOT NULL DEFAULT 0,
      bounced BIGINT NOT NULL DEFAULT 0, duration BIGINT NOT NULL DEFAULT 0,
      engaged BIGINT NOT NULL DEFAULT 0, views BIGINT NOT NULL DEFAULT 0, scroll_sum BIGINT NOT NULL DEFAULT 0, scroll_n BIGINT NOT NULL DEFAULT 0,
      events BIGINT NOT NULL DEFAULT 0,
      ${my ? "KEY rl_rollups_day (site, dim, day)" : "PRIMARY KEY (site, dim, day, value)"})${table}`,
  ];
}

function goalRow(r: Record<string, unknown>): GoalRow {
  return {
    id: String(r.id),
    site: String(r.site),
    name: String(r.name),
    kind: String(r.kind) as GoalRow["kind"],
    match: String(r.match),
    clickBy: String(r.click_by ?? "") as GoalRow["clickBy"],
    valueMode: String(r.value_mode) as GoalRow["valueMode"],
    value: Number(r.value ?? 0),
    valueProp: String(r.value_prop ?? ""),
    currency: String(r.currency ?? "USD"),
    createdAt: Number(r.created_at),
  };
}

/** A `*` pattern as SQLite GLOB, everything else taken literally ([ and ? are GLOB's own). */
const globPattern = (pattern: string): string => pattern.split("*").map((part) => part.replace(/[[?]/g, (c) => `[${c}]`)).join("*");

/** A `*` pattern as SQL LIKE, everything else taken literally. */
const likePattern = (pattern: string): string => pattern.split("*").map(escapeLike).join("%");

/**
 * An INSERT that updates the row already there with the same key, or with `update` empty leaves it be.
 * MySQL says it its own way, and has no other unique key on these tables to trip over.
 */
function upsert(dialect: Db["dialect"], table: string, columns: string[], key: string[], update: string[]): string {
  const insert = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  if (dialect === "mysql") return `${insert} ON DUPLICATE KEY UPDATE ${(update.length ? update : [key[0]!]).map((c) => `${c} = ${update.length ? `VALUES(${c})` : c}`).join(", ")}`;
  return `${insert} ON CONFLICT (${key.join(", ")}) DO ${update.length ? `UPDATE SET ${update.map((c) => `${c} = excluded.${c}`).join(", ")}` : "NOTHING"}`;
}

/** Whole-number division, which MySQL's and ClickHouse's `/` is not. */
const div = (dialect: Db["dialect"], a: string, b: number): string => (dialect === "mysql" ? `(${a} DIV ${b})` : dialect === "clickhouse" ? `intDiv(${a}, ${b})` : `(${a} / ${b})`);

/** A value as text: MySQL casts to CHAR, and has no TEXT type to cast to. */
const asText = (dialect: Db["dialect"], value: string): string => `CAST(${value} AS ${dialect === "mysql" ? "CHAR" : "TEXT"})`;

/**
 * A table of buckets (i, bs, be) as a WITH clause's `b`. Postgres is told the first row's types; MySQL
 * and MariaDB write a table of values differently from each other, and ClickHouse has no VALUES in
 * FROM, so they get a UNION of rows, which names its own columns.
 */
function bucketTable(dialect: Db["dialect"], buckets: Bucket[]): string {
  if (dialect === "mysql" || dialect === "clickhouse") {
    const union = buckets.map((_, i) => (i === 0 ? "SELECT ? AS i, ? AS bs, ? AS be" : "SELECT ?, ?, ?")).join(" UNION ALL ");
    return dialect === "clickhouse" ? `b AS (${union})` : `b (i, bs, be) AS (${union})`;
  }
  const cast = dialect === "postgres";
  return `b (i, bs, be) AS (VALUES ${buckets.map((_, i) => (cast && i === 0 ? "(CAST(? AS INTEGER), CAST(? AS BIGINT), CAST(? AS BIGINT))" : "(?, ?, ?)")).join(", ")})`;
}

function linkRow(row: Record<string, unknown>): LinkRow {
  return {
    id: String(row.id),
    site: String(row.site),
    domain: String(row.domain ?? ""),
    slug: String(row.slug),
    name: String(row.name ?? ""),
    url: String(row.url),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * `col LIKE ?` with a backslash escaping % and _. ClickHouse escapes with a backslash already and has no
 * ESCAPE clause.
 */
const like = (dialect: Db["dialect"], col: string): string => (dialect === "clickhouse" ? `${col} LIKE ?` : `${col} LIKE ? ESCAPE '\\'`);

/** Text in lower case, any letter: ClickHouse's LOWER folds ASCII letters only, and lowerUTF8 the rest. */
const lower = (dialect: Db["dialect"], col: string): string => (dialect === "clickhouse" ? `lowerUTF8(${col})` : `LOWER(${col})`);

function column(dimension: Filter["dimension"]): string {
  return isSessionDimension(dimension) ? `s.${SESSION_DIMENSIONS[dimension]}` : `e.${EVENT_DIMENSIONS[dimension]}`;
}

const PATH_DIMENSIONS = new Set(["page", "entry", "exit"]);

/** Text in the form a recorded path holds it, percent-encoded, as part of a path or as a whole one. */
function asRecorded(value: string, whole: boolean): string {
  const path = recordedPath(whole || value.startsWith("/") ? value : `/${value}`);
  if (path === null) return value;
  return whole || value.startsWith("/") ? path : path.slice(1);
}

/** A GLOB pattern for text containing `value` in any mix of upper and lower case, letter by letter. */
function anyCase(value: string): string {
  let out = "*";
  for (const ch of value) {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (lower !== upper && [...lower].length === 1 && [...upper].length === 1) out += `[${lower}${upper}]`;
    else out += ch === "*" || ch === "?" || ch === "[" ? `[${ch}]` : ch;
  }
  return `${out}*`;
}

/** One filter as a condition on its own column (or `col`), with "is not" flipped to "is" when `positive` asks. */
function condition(filter: Filter, dialect: Db["dialect"], positive = false, col = column(filter.dimension)): { sql: string; params: unknown[] } {
  const op = positive && filter.op === "not" ? "is" : filter.op;
  // Paths are recorded percent-encoded, as the browser's URL parser writes them, so "/café" is matched as
  // "/caf%C3%A9", just as a goal for it is.
  const path = PATH_DIMENSIONS.has(filter.dimension);
  if (op === "is" || op === "not") return { sql: `${col} ${op === "is" ? "=" : "<>"} ?`, params: [path ? asRecorded(filter.value, true) : filter.value] };
  if (path) {
    // An encoded letter's case is in its bytes (%C3%9C is Ü, %C3%BC is ü), which no database folds, so a
    // path is also tried in lower, upper, and title case, encoded each way.
    const title = filter.value.toLowerCase().replace(/(^|[\s\-/_.])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toUpperCase());
    const forms = [...new Set([filter.value, filter.value.toLowerCase(), filter.value.toUpperCase(), title].map((f) => asRecorded(f, false)))];
    const folds = dialect !== "sqlite";
    const one = like(dialect, folds ? lower(dialect, col) : col);
    return { sql: `(${forms.map(() => one).join(" OR ")})`, params: forms.map((f) => `%${escapeLike(folds ? f.toLowerCase() : f)}%`) };
  }
  // Postgres and MySQL lower case any letter, so both sides lowered find any mix. Their LIKE then
  // compares exactly: Postgres's always, MySQL's under Runlight's binary collation.
  if (dialect !== "sqlite") return { sql: like(dialect, lower(dialect, col)), params: [`%${escapeLike(filter.value.toLowerCase())}%`] };
  // SQLite's LIKE and LOWER ignore case for ASCII letters only, so "über" would never find "Über". GLOB with
  // both cases of every letter finds any mix, Unicode included.
  return { sql: `${col} GLOB ?`, params: [anyCase(filter.value)] };
}

/**
 * The visits a query's filters pick, as conditions on `s`. A filter on the visit (source, country,
 * entry page) applies to it directly. A filter on a page, hostname, or event picks the visits that
 * had a matching row, or for "is not", that never had one. Every number then describes those whole
 * visits, and a visit belongs to the range it started in, as it does with no filter. Rows count up to
 * EVENT_TAIL_MS past the range, for a visit still going when it ends.
 */
function visitScope(filters: Filter[], site: string, from: number, to: number, dialect: Db["dialect"]): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const filter of filters) {
    const c = condition(filter, dialect, true);
    if (isSessionDimension(filter.dimension)) {
      const own = condition(filter, dialect);
      parts.push(own.sql);
      params.push(...own.params);
    } else {
      // An event filter reads events only, which lets it use the index of event names.
      const kinds = filter.dimension === "event" ? "e.kind = 'event'" : VISIT_KINDS;
      const rows = `FROM rl_events e WHERE e.site = ? AND e.ts >= ? AND e.ts < ? AND ${kinds} AND ${c.sql}`;
      // Postgres plans NOT IN over a list too big for its memory as a scan of the list for every visit,
      // which runs for hours, so it gets NOT EXISTS, an anti join. SQLite reads NOT IN through a
      // temporary index, and runs NOT EXISTS once a visit.
      if (filter.op === "not" && dialect === "postgres") parts.push(`NOT EXISTS (SELECT 1 ${rows} AND e.session = s.id)`);
      // ClickHouse holds the set of every matching visit's id in memory; their 64-bit hashes take under half
      // of that, and two visits sharing a hash in one report is far too unlikely to matter.
      else if (dialect === "clickhouse") parts.push(`cityHash64(s.id) ${filter.op === "not" ? "NOT IN" : "IN"} (SELECT cityHash64(e.session) ${rows})`);
      else parts.push(`s.id ${filter.op === "not" ? "NOT IN" : "IN"} (SELECT e.session ${rows})`);
      params.push(site, from, to + EVENT_TAIL_MS, ...c.params);
    }
  }
  return { sql: parts.map((p) => ` AND ${p}`).join(""), params };
}

/**
 * Conditions on `e` from the filters on the given row dimensions that keep rows (is, contains). With
 * "page is /pricing", pageviews mean views of /pricing, as people expect, while the visits are whole.
 * A row counts when it matches any filter on each of its dimensions: two page filters count the views
 * of either page, and a hostname filter beside them keeps those on that host.
 */
function rowScope(filters: Filter[], dimensions: string[], dialect: Db["dialect"]): { sql: string; params: unknown[] } {
  let sql = "";
  const params: unknown[] = [];
  for (const dimension of dimensions) {
    const kept = filters.filter((f) => f.dimension === dimension && f.op !== "not").map((f) => condition(f, dialect));
    if (!kept.length) continue;
    sql += ` AND (${kept.map((c) => c.sql).join(" OR ")})`;
    params.push(...kept.flatMap((c) => c.params));
  }
  return { sql, params };
}

/** The visit's columns a ClickHouse event carries, as `visit_<column>`: all but the entry and exit pages, which change as it goes on. */
export const CARRIED_COLUMNS = Object.values(SESSION_DIMENSIONS).filter((col) => col !== "entry_path" && col !== "exit_path");

/**
 * On ClickHouse, the rows of the visits the filters pick, as conditions on the rows themselves, with no list
 * of the visits to hold: each event carries its visit's start and columns. A filter on one of `dimensions`,
 * the kind of row read, is met by any row that `rowScope` keeps, when it is the only filter on it. Null when
 * a filter needs the visits themselves: on the entry or exit page, or another kind of row.
 */
function carriedScope(filters: Filter[], dimensions: string[], from: number, to: number, dialect: Db["dialect"]): { sql: string; params: unknown[] } | null {
  let sql = " AND e.started_at >= ? AND e.started_at < ?";
  const params: unknown[] = [from, to];
  for (const filter of filters) {
    if (isSessionDimension(filter.dimension)) {
      if (filter.dimension === "entry" || filter.dimension === "exit") return null;
      const c = condition(filter, dialect, false, `e.visit_${SESSION_DIMENSIONS[filter.dimension]}`);
      sql += ` AND ${c.sql}`;
      params.push(...c.params);
    } else if (!dimensions.includes(filter.dimension) || filter.op === "not" || filters.filter((f) => f.dimension === filter.dimension).length > 1) return null;
  }
  return { sql, params };
}

/**
 * Pageviews for each visit a filter picks, as a table to LEFT JOIN on `pv.session = s.id`, when a page or
 * hostname filter narrows what counts as a pageview. Null when every pageview of a visit counts.
 */
function pageviewsOf(filters: Filter[], site: string, from: number, to: number, dialect: Db["dialect"]): { sql: string; params: unknown[] } | null {
  const rows = rowScope(filters, ["page", "hostname"], dialect);
  if (!rows.sql) return null;
  return {
    sql: `(SELECT e.session AS session, COUNT(*) AS n FROM rl_events e WHERE e.site = ? AND e.ts >= ? AND e.ts < ? AND e.kind = 'pageview'${rows.sql} GROUP BY e.session)`,
    params: [site, from, to + EVENT_TAIL_MS, ...rows.params],
  };
}

/**
 * The visits the filters pick (see visitScope), and their pageviews as `pv` to join to them, when a filter
 * narrows what counts as one (see pageviewsOf). On ClickHouse a lone filter on the page or the hostname is
 * read once for both: the visits it picks are the ones with a matching pageview or event, which the join
 * keeps, by their ids' hashes as visitScope matches them.
 */
function visitsAndPageviews(filters: Filter[], site: string, from: number, to: number, dialect: Db["dialect"]): { scope: { sql: string; params: unknown[] }; pv: { join: string; params: unknown[] } | null } {
  const rows = filters.filter((f) => !isSessionDimension(f.dimension));
  const lone = dialect === "clickhouse" && rows.length === 1 && rows[0]!.op !== "not" && rows[0]!.dimension !== "event" ? rows[0]! : null;
  if (lone) {
    const c = condition(lone, dialect);
    return {
      scope: visitScope(filters.filter((f) => f !== lone), site, from, to, dialect),
      pv: {
        join: `INNER JOIN (SELECT cityHash64(e.session) AS h, countIf(e.kind = 'pageview') AS n FROM rl_events e WHERE e.site = ? AND e.ts >= ? AND e.ts < ? AND ${VISIT_KINDS} AND ${c.sql} GROUP BY h) pv ON pv.h = cityHash64(s.id)`,
        params: [site, from, to + EVENT_TAIL_MS, ...c.params],
      },
    };
  }
  const pv = pageviewsOf(filters, site, from, to, dialect);
  return { scope: visitScope(filters, site, from, to, dialect), pv: pv && { join: `LEFT JOIN ${pv.sql} pv ON pv.session = s.id`, params: pv.params } };
}

// SQLite can prefer the path index to avoid a sort, reading the site's entire history.
// Reports bounded by event kind and time should use the matching range index instead.
function eventKindTable(dialect: Db["dialect"]): string {
  return dialect === "sqlite" ? "rl_events e INDEXED BY rl_events_site_kind_ts" : "rl_events e";
}

/**
 * For reports that count rows (goals, event properties, funnels): the rows of the visits a query picks,
 * as a FROM list and conditions over `e` and `s`. These count visits the way every other report does,
 * with or without a filter: a visit belongs to the range it started in, and its rows count up to
 * EVENT_TAIL_MS past the range. Written as a CROSS JOIN so SQLite reads the events through their (site,
 * kind, ts) index and looks each visit up by its id, whatever its statistics say.
 */
function visitRows(filters: Filter[], site: string, from: number, to: number, dialect: Db["dialect"], kindBound = false): { from: string; sql: string; params: unknown[] } {
  const scope = visitScope(filters, site, from, to, dialect);
  return {
    from: `${kindBound ? eventKindTable(dialect) : "rl_events e"} CROSS JOIN rl_sessions s`,
    sql: `e.site = ? AND e.ts >= ? AND e.ts < ? AND s.id = e.session AND s.site = ? AND s.started_at >= ? AND s.started_at < ? AND ${IS_VISIT}${scope.sql}`,
    params: [site, from, to + EVENT_TAIL_MS, site, from, to, ...scope.params],
  };
}

export class SqlStore {
  private ready: Promise<void> | null = null;
  readonly db: Db;
  /** What the store's table and index names start with: `rl_` unless it was given another. */
  readonly prefix: string;
  /** Whether upkeep adds up each day into rollups for reports to read. A ClickHouseStore keeps none. */
  readonly keepsRollups: boolean = true;
  /** On ClickHouse, how many engagement rows the pages report adds up in one query; smaller in tests, to try the slices. */
  engagedPerSlice = ENGAGED_PER_SLICE;
  /** The most visits a funnel is counted over; smaller in tests, to try the cap. */
  funnelVisits = FUNNEL_VISITS;
  /**
   * On ClickHouse, the earliest visit start from which every event carries its visit's columns (see
   * CARRIED_COLUMNS), so reports over those visits can filter the events by them. Null elsewhere.
   */
  carriedFrom: number | null = null;

  /**
   * `prefix` takes the place of `rl_` at the start of every table and index name, so two apps can each keep
   * Runlight's tables in one database. A Db that is already prefixed keeps its own.
   */
  constructor(db: Db, prefix: string = PREFIX) {
    const own = prefixes.get(db);
    if (own !== undefined) prefix = own;
    else if (prefix !== PREFIX) db = prefixed(db, prefix);
    this.db = db;
    this.prefix = prefix;
  }

  /**
   * The store's tables as named in the database, for an app removing Runlight: each one by name, since
   * another app's tables may well start with the same letters.
   */
  tables(): string[] {
    return TABLES.map((table) => `${this.prefix}${table}`);
  }

  /**
   * Whether hits the store could not take can wait in it, to be sent again: only a ClickHouseStore keeps them,
   * in its other store, for while ClickHouse is down or too busy. Every other store takes a hit or loses it.
   */
  readonly keepsWaiting: boolean = false;

  /** True for an error after which a hit is worth keeping to send again, rather than dropping. */
  waitable(_error: unknown): boolean {
    return false;
  }

  /** Keeps a hit, as text, that arrived at `at`, to send again. */
  async wait(_at: number, _hit: string): Promise<void> {
    throw new Error("Runlight: this store keeps no waiting hits");
  }

  /**
   * The oldest waiting hits, in the order they came, after dropping any that arrived before `since`, and how
   * many are left in all. Null while another process is sending them.
   */
  async waiting(_limit: number, _since: number): Promise<{ hits: Array<{ id: string; hit: string }>; left: number } | null> {
    return { hits: [], left: 0 };
  }

  /** Lets go of waiting hits once sent. */
  async doneWaiting(_ids: string[]): Promise<void> {}

  /** A name as the database has it, under the store's prefix, as Runlight's SQL writes it, under rl_. */
  private unnamed(name: string): string {
    return name.startsWith(this.prefix) ? `${PREFIX}${name.slice(this.prefix.length)}` : name;
  }

  /** A table or index name as the database has it, under the store's prefix. */
  private named(name: string): string {
    return name.startsWith(PREFIX) ? `${this.prefix}${name.slice(PREFIX.length)}` : name;
  }

  /** Creates the tables on first use. Safe to call any number of times. */
  migrate(): Promise<void> {
    const create = async (db: Db) => {
      // On Postgres an index on a big table takes a while to build, so the build may run past the
      // statement timeout, and goes CONCURRENTLY, so another process still serving keeps writing meanwhile.
      const postgres = db.dialect === "postgres";
      if (postgres) await db.run("SET statement_timeout = 0");
      try {
        await upgrade(db, postgres);
      } finally {
        if (postgres) await db.run("RESET statement_timeout").catch(() => {});
      }
    };
    const upgrade = async (db: Db, postgres: boolean) => {
      const statements = schema(db.dialect);
      await db.run(statements[0]!);
      const [found] = await db.all<{ value: string }>(`SELECT value FROM rl_meta WHERE "key" = 'schema'`);
      const from = found ? Number(found.value) : SCHEMA_VERSION;
      if (postgres) {
        // A concurrent build that was stopped leaves its index unusable; it goes, and is built again below.
        const broken = await db.all<{ name: string }>(
          `SELECT c.relname AS name FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
           WHERE NOT i.indisvalid AND c.relname LIKE '${this.prefix.replace(/_/g, "\\_")}%' AND c.relnamespace = current_schema()::regnamespace`,
        );
        // The name comes back as the database has it, so it goes back under rl_ before the prefix is put on again,
        // which would otherwise be put on twice for a prefix that itself starts rl_, such as rl_wp_.
        for (const { name } of broken) await db.run(`DROP INDEX IF EXISTS "${this.unnamed(name).replace(/"/g, "")}"`);
      }
      for (const statement of statements) {
        const index = /^CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+) ON (\w+)/.exec(statement);
        if (index && db.dialect === "mysql") {
          // MySQL has no CREATE INDEX IF NOT EXISTS, so it is looked for first.
          const [, unique, name, table] = index;
          const there = await db.all(`SELECT 1 AS there FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`, [this.named(table!), this.named(name!)]);
          if (!there.length) await db.run(statement.replace(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS/, `CREATE ${unique ?? ""}INDEX`));
        } else {
          await db.run(postgres ? statement.replace(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS/, "CREATE $1INDEX CONCURRENTLY IF NOT EXISTS") : statement);
        }
      }
      // A column added by an upgrade that stopped before it recorded the new version is already there.
      const addColumn = (sql: string) =>
        db.run(sql).catch((error) => {
          if (!/duplicate column|already exists/i.test(String(error))) throw error;
        });
      // Version 2: settings changed in the dashboard, kept apart from the ones in code.
      if (from < 2) await addColumn(`ALTER TABLE rl_sites ADD COLUMN overrides TEXT NOT NULL DEFAULT '{}'`);
      if (from < 4) await db.run(`DROP INDEX IF EXISTS rl_links_slug`);
      // Version 10: tokens that may change one site's settings, for a hub.
      if (from >= 8 && from < 10) await addColumn(`ALTER TABLE rl_tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'read'`);
      // Written only when it changes, so a database opened read-only can still be read.
      if (!found || found.value !== String(SCHEMA_VERSION)) {
        await db.run(upsert(db.dialect, "rl_meta", ['"key"', "value"], ['"key"'], ["value"]), ["schema", String(SCHEMA_VERSION)]);
      }
    };
    this.ready ??= (this.db.exclusive ? this.db.exclusive(create) : create(this.db)).catch((error) => {
      this.ready = null;
      throw error;
    });
    return this.ready;
  }

  /**
   * Keeps SQLite's planner statistics current, which it never gathers by itself. Without them it can
   * choose a plan that reads a table once for every row of another. A sample of each index is enough,
   * so this takes a few seconds at most even on a large database. Postgres gathers its own.
   *
   * With `onlyWhenStale`, only when there are none, or the events have more than doubled since they were
   * gathered. Statistics gathered on a new, empty database say every table is empty, and a goal over a
   * million visits then took a minute rather than milliseconds.
   */
  async optimize(onlyWhenStale = false): Promise<void> {
    if (this.db.dialect !== "sqlite") return;
    try {
      const [top] = await this.db.all(`SELECT MAX(id) AS n FROM rl_events`);
      const events = num(top?.n);
      if (onlyWhenStale) {
        const [seen] = await this.db.all<{ value: string }>(`SELECT value FROM rl_meta WHERE "key" = 'statistics_events'`);
        const then = seen ? Number(seen.value) : NaN;
        const gathered = (await this.db.all(`SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'`)).length > 0;
        if (gathered && Number.isFinite(then) && !(events > 2 * then && events - then >= 1000)) return;
      }
      try {
        await this.db.run("PRAGMA analysis_limit = 1000");
        await this.db.run("ANALYZE");
      } catch {
        // Some hosted SQLite services refuse these, and gather statistics themselves.
      }
      // Noted even when refused, so a service that refuses is not asked again until the events double.
      await this.db.run(upsert(this.db.dialect, "rl_meta", ['"key"', "value"], ['"key"'], ["value"]), ["statistics_events", String(events)]);
    } catch {
      // Statistics only help; a failure here never stops the app.
    }
  }

  async close(): Promise<void> {
    await this.db.close?.();
  }

  /** While visits are still being copied into another database, the start of the oldest copied so far. */
  async moving(): Promise<{ through: number } | null> {
    return null;
  }

  /** How many rows an UPDATE or DELETE of rows with an id matched. */
  private async changed(sql: string, params: unknown[]): Promise<number> {
    if (this.db.affected) return this.db.affected(sql, params);
    return (await this.db.all(`${sql} RETURNING id`, params)).length;
  }

  /** Runs `fn` with a store whose every query is in one transaction. */
  async transaction<T>(fn: (store: SqlStore) => Promise<T>): Promise<T> {
    if (this.db.transaction) return this.db.transaction((db) => fn(new SqlStore(db)));
    await this.db.run("BEGIN");
    try {
      const result = await fn(this);
      await this.db.run("COMMIT");
      return result;
    } catch (error) {
      await this.db.run("ROLLBACK");
      throw error;
    }
  }

  /** Runs one step of an import, whose rows go in together: here in one transaction. */
  async importStep<T>(fn: (store: SqlStore) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  // Sites

  async upsertSite(site: SiteRow, now: number): Promise<void> {
    // Unchanged sites are left alone, so starting needs no write and a read-only database still opens.
    const [row] = await this.db.all(`SELECT name, hostnames, timezone FROM rl_sites WHERE id = ?`, [site.id]);
    if (row && row.name === site.name && row.hostnames === JSON.stringify(site.hostnames) && row.timezone === site.timezone) return;
    await this.db.run(
      upsert(this.db.dialect, "rl_sites", ["id", "name", "hostnames", "timezone", "created_at"], ["id"], ["name", "hostnames", "timezone"]),
      [site.id, site.name, JSON.stringify(site.hostnames), site.timezone, now],
    );
  }

  /** Settings changed in the dashboard, by site. They win over the ones in code. */
  async siteOverrides(): Promise<Map<string, SiteOverrides>> {
    const rows = await this.db.all<{ id: string; overrides: string }>(`SELECT id, overrides FROM rl_sites`);
    const out = new Map<string, SiteOverrides>();
    for (const row of rows) {
      try {
        out.set(row.id, JSON.parse(row.overrides) as SiteOverrides);
      } catch {
        out.set(row.id, {});
      }
    }
    return out;
  }

  /**
   * Deletes a site and everything recorded for it. Used by the standalone server's "Delete site". Its
   * events and visits go a day at a time first, so a big site does not hold the database (on SQLite,
   * the whole server) for minutes, and what is left goes in one transaction.
   */
  async deleteSite(id: string): Promise<void> {
    const piece = this.db.metered ? 30 * PIECE_MS : PIECE_MS;
    for (const [table, col] of [["rl_events", "ts"], ["rl_sessions", "started_at"]] as const) {
      // A piece at a time from the oldest row, skipping straight over stretches with none.
      for (let from = await this.oldest(table, col, id, -Infinity); from !== null; from = await this.oldest(table, col, id, from + piece)) {
        await this.db.run(`DELETE FROM ${table} WHERE site = ? AND ${col} < ?`, [id, from + piece]);
        await pause();
      }
    }
    await this.transaction(async (store) => {
      for (const table of ["rl_events", "rl_sessions", "rl_links", "rl_link_domains", "rl_shares", "rl_goals", "rl_funnels", "rl_reports", "rl_tokens", "rl_rollups", "rl_rollup_days", "rl_sites"]) {
        await store.db.run(`DELETE FROM ${table} WHERE ${table === "rl_sites" ? "id" : "site"} = ?`, [id]);
      }
    });
  }

  /** When a site's oldest row at or after `from` is, or null when there is none. */
  private async oldest(table: "rl_events" | "rl_sessions", col: "ts" | "started_at", site: string, from: number): Promise<number | null> {
    const [row] = await this.db.all(`SELECT MIN(${col}) AS t FROM ${table} WHERE site = ?${from === -Infinity ? "" : ` AND ${col} >= ?`}`, from === -Infinity ? [site] : [site, from]);
    return row?.t === null || row?.t === undefined ? null : num(row.t);
  }

  /** Deletes a site's visits and events from before a time, for its retention setting. */
  async dropBefore(site: string, ts: number): Promise<void> {
    // A day at a time from the oldest, each its own short transaction, with a pause between, so a long
    // history goes without holding the database (on SQLite, the whole server) for minutes. Stretches
    // with nothing in them are skipped, so one stray old row does not cost a piece for every day since.
    const piece = this.db.metered ? 30 * PIECE_MS : PIECE_MS;
    const next = async (at: number) => {
      const found = [await this.oldest("rl_sessions", "started_at", site, at), await this.oldest("rl_events", "ts", site, at)].filter((t): t is number => t !== null);
      return found.length ? Math.max(at, Math.min(...found)) : null;
    };
    for (let from = await next(-Infinity); from !== null && from < ts; from = await next(Math.min(from + piece, ts))) {
      const to = Math.min(from + piece, ts);
      await this.transaction(async (store) => {
        // A visit's events go with it, even ones after the cutoff, so nothing is left without its visit.
        // They come after it starts and within EVENT_TAIL_MS, so the time bounds let the (site, ts) index find them.
        await store.db.run(
          `DELETE FROM rl_events WHERE site = ? AND ts >= ? AND ts < ? AND session IN (SELECT id FROM rl_sessions WHERE site = ? AND started_at >= ? AND started_at < ?)`,
          [site, from, to + EVENT_TAIL_MS, site, from, to],
        );
        await store.db.run(`DELETE FROM rl_events WHERE site = ? AND ts < ?`, [site, to]);
        await store.db.run(`DELETE FROM rl_sessions WHERE site = ? AND started_at < ?`, [site, to]);
      });
      await pause();
    }
    // A day that lost any of its visits is built again later, from what is left.
    await this.clearRollups(site, { before: ts });
  }

  /** Deletes a site's events from `from` on whose visit no longer exists, a day at a time. */
  async dropOrphans(site: string, from: number, until: number): Promise<void> {
    const piece = this.db.metered ? 30 * PIECE_MS : PIECE_MS;
    for (let at = await this.oldest("rl_events", "ts", site, from); at !== null && at < until; at = await this.oldest("rl_events", "ts", site, at + piece)) {
      await this.db.run(
        `DELETE FROM rl_events WHERE site = ? AND ts >= ? AND ts < ? AND session <> '' AND NOT EXISTS (SELECT 1 FROM rl_sessions s WHERE s.id = rl_events.session)`,
        [site, at, at + piece],
      );
      await pause();
    }
  }

  // Daily rollups

  /**
   * Adds up one local day of a site: totals, each visit dimension, and pages.
   * A visit belongs to the day it started. Visitor ids change every day, so
   * the days of a range add up to exactly what counting the range would give.
   */
  async buildRollupDay(site: string, day: string, start: number, end: number): Promise<void> {
    // A day with no visits still gets its row of zeros, so it counts as built.
    const sums = `COUNT(DISTINCT s.visitor), COUNT(*), COALESCE(SUM(s.pageviews), 0), COALESCE(SUM(CASE WHEN ${BOUNCE} THEN 1 ELSE 0 END), 0), COALESCE(SUM(${DURATION}), 0)`;
    const cols = "(site, day, dim, value, visitors, visits, pageviews, bounced, duration)";
    // Each piece names its own site and day, as text, so Postgres knows their type inside a UNION.
    const dialect = this.db.dialect;
    const head = `${asText(dialect, "?")}, ${asText(dialect, "?")}`;
    const quarter = div(dialect, "s.started_at", 900000);
    // The day's totals, each visit dimension, and the heatmap's quarter hours (counted as hourly() counts
    // them: every visit that started), in one statement over the day's visits, since a Cloudflare D1
    // check may only send so many.
    const pieces = [
      `SELECT ${head}, '', '', ${sums} FROM v s`,
      ...Object.entries(SESSION_DIMENSIONS).map(([dim, col]) => `SELECT ${head}, '${dim}', s.${col}, ${sums} FROM v s WHERE s.${col} <> '' GROUP BY s.${col}`),
      `SELECT ${head}, 'quarter', ${asText(dialect, quarter)}, COUNT(DISTINCT s.visitor), COUNT(*), COALESCE(SUM(s.pageviews), 0), COALESCE(SUM(CASE WHEN ${BOUNCE} THEN 1 ELSE 0 END), 0), 0 FROM v s GROUP BY ${asText(dialect, quarter)}`,
    ];
    // Pages and events, from the rows of the day's visits. The time bounds let the (site, kind, ts) index
    // find them; a visit's last row comes at most EVENT_TAIL_MS after it starts.
    const ofDay = (kind: string) =>
      `FROM ${eventKindTable(dialect)} CROSS JOIN rl_sessions s
       WHERE s.id = e.session AND e.site = ? AND e.kind = '${kind}' AND e.ts >= ? AND e.ts < ? AND s.started_at >= ? AND s.started_at < ? AND ${IS_VISIT}`;
    const window = [site, start, end + EVENT_TAIL_MS, start, end];
    await this.transaction(async (store) => {
      const db = store.db;
      // MySQL keys a day's rows by no unique key, since a path is longer than its keys allow, so two processes
      // building one day could each add its rows. There the day is marked first: the second waits on that
      // mark until the first commits, then fails, and the day counts as built elsewhere. Elsewhere the rows'
      // own key refuses a second set, and a database without transactions (D1) must not mark a day first.
      if (dialect === "mysql") {
        await db.run(`DELETE FROM rl_rollup_days WHERE site = ? AND day = ?`, [site, day]);
        await db.run(`INSERT INTO rl_rollup_days (site, day, start_at, end_at) VALUES (?, ?, ?, ?)`, [site, day, start, end]);
      }
      await db.run(`DELETE FROM rl_rollups WHERE site = ? AND day = ?`, [site, day]);
      // The WITH goes after INSERT INTO, the one place every database takes it.
      await db.run(
        `INSERT INTO rl_rollups ${cols}
         WITH v AS (SELECT * FROM rl_sessions s WHERE s.site = ? AND s.started_at >= ? AND s.started_at < ? AND ${IS_VISIT})
         ${pieces.join(" UNION ALL ")}`,
        [site, start, end, ...pieces.flatMap(() => [site, day])],
      );
      // A page's engaged time and scroll come per pageview first (its time added up, its deepest scroll),
      // as the raw report counts them.
      await db.run(
        `INSERT INTO rl_rollups (site, day, dim, value, visitors, visits, pageviews, views, engaged, scroll_sum, scroll_n)
         SELECT ?, ?, 'page', p.value, p.visitors, p.visits, p.pageviews, p.views, COALESCE(t.engaged, 0), COALESCE(t.scroll_sum, 0), COALESCE(t.scroll_n, 0)
         FROM (SELECT e.path AS value, COUNT(DISTINCT e.visitor) AS visitors, COUNT(DISTINCT e.session) AS visits, COUNT(*) AS pageviews, ${LIVE_VIEWS} AS views
               ${ofDay("pageview")} GROUP BY e.path) p
         LEFT JOIN (SELECT value, SUM(total) AS engaged, SUM(deepest) AS scroll_sum, COUNT(deepest) AS scroll_n FROM (
               SELECT e.path AS value, SUM(e.engaged_ms) AS total, MAX(e.scroll) AS deepest ${ofDay("engagement")} GROUP BY e.path, e.pageview) x
               GROUP BY value) t ON t.value = p.value`,
        [site, day, ...window, ...window],
      );
      await db.run(
        `INSERT INTO rl_rollups (site, day, dim, value, visitors, events)
         SELECT ?, ?, 'event', e.name, COUNT(DISTINCT e.visitor), COUNT(*) ${ofDay("event")} GROUP BY e.name`,
        [site, day, ...window],
      );
      if (dialect !== "mysql") {
        await db.run(`DELETE FROM rl_rollup_days WHERE site = ? AND day = ?`, [site, day]);
        await db.run(`INSERT INTO rl_rollup_days (site, day, start_at, end_at) VALUES (?, ?, ?, ?)`, [site, day, start, end]);
      }
    });
  }

  /** The days of a site already built. */
  async rollupDays(site: string): Promise<Set<string>> {
    return new Set((await this.db.all(`SELECT day FROM rl_rollup_days WHERE site = ?`, [site])).map((r) => String(r.day)));
  }

  /** Forgets built days, all of a site's or those touching a stretch of time, so they are built again. */
  async clearRollups(site: string, range: { before?: number; from?: number; to?: number } = {}): Promise<void> {
    let where = "site = ?";
    const params: unknown[] = [site];
    if (range.before !== undefined) {
      where += " AND start_at < ?";
      params.push(range.before);
    } else if (range.from !== undefined && range.to !== undefined) {
      where += " AND start_at < ? AND end_at > ?";
      params.push(range.to, range.from);
    }
    const days = (await this.db.all(`SELECT day FROM rl_rollup_days WHERE ${where}`, params)).map((r) => String(r.day));
    // The days stop counting as built first, so if this stops part way, no day is left marked built
    // without its rows. Rows of a day not built are never read, and building it replaces them. Another
    // process may build a day between the two deletes, so its mark goes again after its rows: the day
    // is then simply built once more.
    await this.db.run(`DELETE FROM rl_rollup_days WHERE ${where}`, params);
    for (const day of days) {
      await this.db.run(`DELETE FROM rl_rollups WHERE site = ? AND day = ?`, [site, day]);
      await this.db.run(`DELETE FROM rl_rollup_days WHERE site = ? AND day = ?`, [site, day]);
    }
  }

  /**
   * How to answer a range from rollups: the built days that lie wholly inside
   * it, and the stretches left over, which are read from the visits as usual.
   * Null when no built day helps.
   */
  private async rollupPlan(query: Omit<Query, "from" | "to">, from: number, to: number): Promise<{ days: Array<{ day: string; start: number; end: number }>; rest: Array<[number, number]> } | null> {
    // ClickHouse reads the visits themselves faster than the others read their rollups, and keeps none. This
    // asks the dialect rather than keepsRollups: reports run on a ClickHouseStore's `visits`, a plain SqlStore.
    if (query.filters.length || this.db.dialect === "clickhouse") return null;
    const rows = await this.db.all(`SELECT day, start_at, end_at FROM rl_rollup_days WHERE site = ? AND start_at >= ? AND end_at <= ? ORDER BY start_at`, [query.site, from, to]);
    if (!rows.length) return null;
    const days = rows.map((r) => ({ day: String(r.day), start: num(r.start_at), end: num(r.end_at) }));
    const rest: Array<[number, number]> = [];
    let at = from;
    for (const d of days) {
      if (d.start > at) rest.push([at, d.start]);
      at = Math.max(at, d.end);
    }
    if (at < to) rest.push([at, to]);
    return { days, rest };
  }

  /** SQL for "a visit that started in one of these stretches". */
  private static within(rest: Array<[number, number]>, started = "s.started_at"): { sql: string; params: number[] } {
    if (!rest.length) return { sql: "1 = 0", params: [] };
    return { sql: `(${rest.map(() => `(${started} >= ? AND ${started} < ?)`).join(" OR ")})`, params: rest.flat() };
  }

  /**
   * A breakdown of a visit dimension or of pages from rollups and the visits
   * left over, merged, then sorted and cut to the page asked for.
   */
  private async rolledBreakdown(query: Query, dimension: Dimension, limit: number, offset: number): Promise<BreakdownRow[] | null> {
    const page = dimension === "page";
    const event = dimension === "event";
    if (!page && !event && !isSessionDimension(dimension)) return null;
    if (query.filters.length) return null;
    // Pages and events always go this way without filters, so a range gives the same answer whether its days are built or not.
    const plan = (await this.rollupPlan(query, query.from, query.to)) ?? (page || event ? { days: [], rest: [[query.from, query.to]] as Array<[number, number]> } : null);
    if (!plan) return null;
    type Sums = { visitors: number; visits: number; pageviews: number; bounced: number; duration: number; engaged: number; views: number; scroll_sum: number; scroll_n: number; events: number };
    const sums = new Map<string, Sums>();
    const bump = (row: Record<string, unknown>) => {
      const key = String(row.value);
      const into: Sums = sums.get(key) ?? { visitors: 0, visits: 0, pageviews: 0, bounced: 0, duration: 0, engaged: 0, views: 0, scroll_sum: 0, scroll_n: 0, events: 0 };
      for (const k of Object.keys(into) as Array<keyof Sums>) into[k] += num(row[k]);
      sums.set(key, into);
    };
    if (plan.days.length) {
      const rolled = await this.db.all(
        `SELECT value, SUM(visitors) AS visitors, SUM(visits) AS visits, SUM(pageviews) AS pageviews, SUM(bounced) AS bounced, SUM(duration) AS duration,
           SUM(engaged) AS engaged, SUM(views) AS views, SUM(scroll_sum) AS scroll_sum, SUM(scroll_n) AS scroll_n, SUM(events) AS events
         FROM rl_rollups WHERE site = ? AND dim = ? AND day IN (${BUILT_DAYS}) GROUP BY value`,
        [query.site, dimension, query.site, query.from, query.to],
      );
      for (const row of rolled) bump(row);
    }
    const w = SqlStore.within(plan.rest);
    if ((page || event) && plan.rest.length) {
      // A visit's pageviews and events belong to the day it started, as in the rollups.
      // Bounded by time as well, so the events index finds them (see buildRollupDay).
      const lo = Math.min(...plan.rest.map(([a]) => a));
      const hi = Math.max(...plan.rest.map(([, b]) => b)) + EVENT_TAIL_MS;
      // ClickHouse's events carry the start of their visit, which saves joining each one to it: a pageview or
      // an event is counted into its visit, and an engagement belongs to a pageview, so the visit counts.
      const own = this.db.dialect === "clickhouse";
      const started = own ? SqlStore.within(plan.rest, "e.started_at") : w;
      const ofRest = (kind: string) =>
        own
          ? `FROM rl_events e WHERE e.site = ? AND e.kind = '${kind}' AND e.ts >= ? AND e.ts < ? AND ${started.sql}`
          : `FROM ${eventKindTable(this.db.dialect)} CROSS JOIN rl_sessions s WHERE s.id = e.session AND e.site = ? AND e.kind = '${kind}' AND e.ts >= ? AND e.ts < ? AND ${IS_VISIT} AND ${w.sql}`;
      const at = [query.site, lo, hi, ...started.params];
      if (page) {
        for (const row of await this.db.all(`SELECT e.path AS value, COUNT(DISTINCT e.visitor) AS visitors, COUNT(*) AS pageviews, ${LIVE_VIEWS} AS views ${ofRest("pageview")} GROUP BY e.path`, at)) bump(row);
        // Engaged time is added up per pageview first. On ClickHouse a big range goes in slices by when each visit
        // started, so each pageview is in one slice, and each slice reads only its own stretch of the events and
        // holds about ENGAGED_PER_SLICE of them in memory at once.
        let slices: Array<[number, number] | null> = [null];
        if (own) {
          const [n] = await this.db.all(`SELECT COUNT(*) AS n ${ofRest("engagement")}`, at);
          const count = Math.min(64, Math.max(1, Math.ceil(num(n?.n) / this.engagedPerSlice)));
          const from = lo;
          const span = hi - EVENT_TAIL_MS - lo;
          if (count > 1) slices = Array.from({ length: count }, (_, i) => [from + Math.floor((span * i) / count), from + Math.floor((span * (i + 1)) / count)]);
        }
        const engaged = await Promise.all(
          slices.map((slice) =>
            this.db.all(
              `SELECT value, SUM(total) AS engaged, SUM(deepest) AS scroll_sum, COUNT(deepest) AS scroll_n FROM (
                 SELECT e.path AS value, SUM(e.engaged_ms) AS total, MAX(e.scroll) AS deepest ${ofRest("engagement")}${slice ? " AND e.started_at >= ? AND e.started_at < ? AND e.ts >= ? AND e.ts < ?" : ""}
                 GROUP BY e.path, e.pageview) t GROUP BY value`,
              slice ? [...at, slice[0], slice[1], slice[0], slice[1] + EVENT_TAIL_MS] : at,
            ),
          ),
        );
        for (const row of engaged.flat()) bump(row);
      } else {
        for (const row of await this.db.all(`SELECT e.name AS value, COUNT(DISTINCT e.visitor) AS visitors, COUNT(*) AS events ${ofRest("event")} GROUP BY e.name`, at)) bump(row);
      }
    } else if (page || event) {
      // Every day of the range is built.
    } else {
      const col = `s.${SESSION_DIMENSIONS[dimension as SessionDimension]}`;
      for (const row of await this.db.all(
        `SELECT ${col} AS value, COUNT(DISTINCT s.visitor) AS visitors, COUNT(*) AS visits, SUM(s.pageviews) AS pageviews,
           SUM(CASE WHEN ${BOUNCE} THEN 1 ELSE 0 END) AS bounced, SUM(${DURATION}) AS duration
         FROM rl_sessions s WHERE s.site = ? AND ${IS_VISIT} AND ${w.sql} AND ${col} <> '' GROUP BY ${col}`,
        [query.site, ...w.params],
      )) bump(row);
    }
    const entryExit = dimension === "entry" || dimension === "exit";
    const rows = [...sums.entries()].filter(([value, x]) => (event || value !== "") && (page ? x.pageviews > 0 : event ? x.events > 0 : x.visits > 0));
    rows.sort(([a, x], [b, y]) =>
      entryExit ? y.visits - x.visits || codeOrder(a, b)
      : event ? y.visitors - x.visitors || y.events - x.events || codeOrder(a, b)
      : page ? y.visitors - x.visitors || y.pageviews - x.pageviews || codeOrder(a, b)
      : y.visitors - x.visitors || y.visits - x.visits || codeOrder(a, b),
    );
    return rows.slice(offset, offset + limit).map(([value, x]) => {
      if (event) return { value, visitors: x.visitors, events: x.events };
      if (page) {
        return {
          value,
          visitors: x.visitors,
          pageviews: x.pageviews,
          // Over every pageview that could report its time, counting those that sent none (under a second) as none.
          timeOnPage: x.views > 0 ? Math.round(x.engaged / x.views) : 0,
          scrollDepth: x.scroll_n > 0 ? Math.round(x.scroll_sum / x.scroll_n) : 0,
        };
      }
      const out: BreakdownRow = { value, visitors: x.visitors, visits: x.visits, bounceRate: x.visits > 0 ? x.bounced / x.visits : 0 };
      if (!entryExit) {
        out.pageviews = x.pageviews;
        out.visitDuration = x.visits > 0 ? Math.round(x.duration / x.visits) : 0;
      }
      return out;
    });
  }

  private async rolledStats(query: Query): Promise<Stats | null> {
    const plan = await this.rollupPlan(query, query.from, query.to);
    if (!plan) return null;
    const [rolled] = await this.db.all(
      `SELECT SUM(visitors) AS visitors, SUM(visits) AS visits, SUM(pageviews) AS pageviews, SUM(bounced) AS bounced, SUM(duration) AS duration
       FROM rl_rollups WHERE site = ? AND dim = '' AND day IN (${BUILT_DAYS})`,
      [query.site, query.site, query.from, query.to],
    );
    const w = SqlStore.within(plan.rest);
    const [raw] = await this.db.all(
      `SELECT COUNT(DISTINCT s.visitor) AS visitors, COUNT(*) AS visits, SUM(s.pageviews) AS pageviews,
         SUM(CASE WHEN ${BOUNCE} THEN 1 ELSE 0 END) AS bounced, SUM(${DURATION}) AS duration
       FROM rl_sessions s WHERE s.site = ? AND ${IS_VISIT} AND ${w.sql}`,
      [query.site, ...w.params],
    );
    const add = (k: string) => num(rolled?.[k]) + num(raw?.[k]);
    const visits = add("visits");
    const pageviews = add("pageviews");
    return {
      visitors: add("visitors"),
      visits,
      pageviews,
      viewsPerVisit: visits > 0 ? Math.round((pageviews / visits) * 100) / 100 : 0,
      bounceRate: visits > 0 ? add("bounced") / visits : 0,
      visitDuration: visits > 0 ? Math.round(add("duration") / visits) : 0,
    };
  }

  async setSiteOverrides(id: string, overrides: SiteOverrides): Promise<void> {
    await this.db.run(`UPDATE rl_sites SET overrides = ? WHERE id = ?`, [JSON.stringify(overrides), id]);
  }

  /** When the site last recorded a visit, or null if it never has. */
  async lastSeen(site: string): Promise<number | null> {
    // One MAX for each kind, which every database reads from the end of its (site, kind, ts) index. Asked for
    // both kinds at once, MySQL read every pageview and event of the site: 2 s on a million visits.
    const [row] = await this.db.all(
      `SELECT MAX(t) AS t FROM (SELECT MAX(ts) AS t FROM rl_events WHERE site = ? AND kind = 'pageview'
       UNION ALL SELECT MAX(ts) AS t FROM rl_events WHERE site = ? AND kind = 'event') x`,
      [site, site],
    );
    return row?.t === null || row?.t === undefined ? null : num(row.t);
  }

  async sites(): Promise<SiteRow[]> {
    const rows = await this.db.all<{ id: string; name: string; hostnames: string; timezone: string }>(
      `SELECT id, name, hostnames, timezone FROM rl_sites ORDER BY name, id`,
    );
    return rows.map((row) => ({ ...row, hostnames: JSON.parse(row.hostnames) as string[] }));
  }

  // Salts

  /** The salt for a day, made on first ask. Two racing callers agree on one. */
  async salt(day: string, fresh: string): Promise<string> {
    await this.db.run(upsert(this.db.dialect, "rl_salts", ["day", "salt"], ["day"], []), [day, fresh]);
    const rows = await this.db.all<{ salt: string }>(`SELECT salt FROM rl_salts WHERE day = ?`, [day]);
    return rows[0]?.salt ?? fresh;
  }

  async saltIfExists(day: string): Promise<string | null> {
    const rows = await this.db.all<{ salt: string }>(`SELECT salt FROM rl_salts WHERE day = ?`, [day]);
    return rows[0]?.salt ?? null;
  }

  /** Deletes every salt but those of these days, so the hashes made with them can never be made again. */
  async dropSaltsExcept(days: string[]): Promise<void> {
    await this.db.run(`DELETE FROM rl_salts WHERE day NOT IN (${days.map(() => "?").join(", ")})`, days);
  }

  /** Whether a visit to one of these sites that started in a stretch of time was still going at `since`. */
  async visitOpen(sites: string[], from: number, to: number, since: number): Promise<boolean> {
    // As many sites a statement as keep it under D1's 100.
    const open = await inPieces(sites, MAX_PARAMS - 3, (piece) =>
      this.db.all(
        `SELECT 1 AS open FROM rl_sessions WHERE site IN (${piece.map(() => "?").join(", ")}) AND started_at >= ? AND started_at < ? AND last_at >= ? LIMIT 1`,
        [...piece, from, to, since],
      ),
    );
    return open.length > 0;
  }

  // Ingest

  /** The visitor's open session: any of their hashes, active since `since`. */
  async openSession(site: string, visitors: string[], since: number): Promise<{ id: string; visitor: string } | null> {
    if (visitors.length === 0) return null;
    const rows = await this.db.all<{ id: string; visitor: string }>(
      `SELECT id, visitor FROM rl_sessions WHERE site = ? AND visitor IN (${visitors.map(() => "?").join(", ")}) AND last_at >= ?
       ORDER BY last_at DESC, id LIMIT 1`,
      [site, ...visitors, since],
    );
    return rows[0] ?? null;
  }

  /**
   * After opening a visit: the visitor's earliest visit still going, which is this one unless another
   * process opened one for the same visitor at the same moment. Then both settle on the earliest, and the
   * one that is not drops its own, before anything is counted into it.
   */
  async settleOpenSession(site: string, visitors: string[], since: number, opened: { id: string; visitor: string }): Promise<{ id: string; visitor: string }> {
    const rows = await this.db.all<{ id: string; visitor: string }>(
      // One already counting a hit first: the other process went on with it.
      `SELECT id, visitor FROM rl_sessions WHERE site = ? AND visitor IN (${visitors.map(() => "?").join(", ")}) AND last_at >= ?
       ORDER BY CASE WHEN pageviews > 0 OR events > 0 THEN 0 ELSE 1 END, started_at, id LIMIT 1`,
      [site, ...visitors, since],
    );
    const first = rows[0] ?? opened;
    if (first.id !== opened.id) await this.db.run(`DELETE FROM rl_sessions WHERE id = ? AND pageviews = 0 AND events = 0`, [opened.id]);
    return { id: String(first.id), visitor: String(first.visitor) };
  }

  async insertSession(row: SessionRow): Promise<void> {
    const c = clip;
    await this.db.run(
      `INSERT INTO rl_sessions (id, site, visitor, started_at, last_at, engaged_ms, hostname, referrer_host, referrer_path,
        source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, country, region, city,
        browser, browser_version, os, os_version, device, screen, language)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        // Each text cut to its column's width, as MySQL's columns would hold it, so every database keeps the
        // same, and no header, however long, can make a row Postgres's indexes refuse.
        row.id, row.site, row.visitor, row.startedAt, row.startedAt, c(row.hostname, 255), c(row.referrerHost, 255), c(row.referrerPath, 500),
        c(row.source, 200), c(row.channel, 100), c(row.utmSource, 200), c(row.utmMedium, 200), c(row.utmCampaign, 200), c(row.utmTerm, 200), c(row.utmContent, 200),
        c(row.country, 16), c(row.region, 100), c(row.city, 100), c(row.browser, 100), c(row.browserVersion, 100), c(row.os, 100), c(row.osVersion, 100), c(row.device, 50),
        c(row.screen, 50), c(row.language, 50),
      ],
    );
  }

  /**
   * Counts a row into its session. An event with `reopen` false, one that joins a visit already ended,
   * counts without moving the session's last activity.
   */
  async touchSession(id: string, ts: number, kind: "pageview" | "event" | "click", path: string, reopen = true): Promise<void> {
    if (kind === "click") {
      await this.db.run(`UPDATE rl_sessions SET last_at = ? WHERE id = ?`, [ts, id]);
    } else if (kind === "pageview") {
      await this.db.run(
        `UPDATE rl_sessions SET pageviews = pageviews + 1, last_at = ?, exit_path = ?,
           entry_path = CASE WHEN entry_path = '' THEN ? ELSE entry_path END WHERE id = ?`,
        [ts, clip(path, 1000), clip(path, 1000), id],
      );
    } else if (reopen) {
      await this.db.run(`UPDATE rl_sessions SET events = events + 1, last_at = ? WHERE id = ?`, [ts, id]);
    } else {
      await this.db.run(`UPDATE rl_sessions SET events = events + 1 WHERE id = ?`, [id]);
    }
  }

  async addEngagement(id: string, ms: number): Promise<void> {
    await this.db.run(`UPDATE rl_sessions SET engaged_ms = COALESCE(engaged_ms, 0) + ? WHERE id = ?`, [ms, id]);
  }

  /**
   * The pageview an engagement ping or event belongs to, with when its visit started and was last active.
   * `since` is the earliest it can be and still count, which a store may use to look in fewer rows.
   */
  async pageview(
    site: string,
    pageview: string,
    _since = 0,
  ): Promise<{ session: string; visitor: string; path: string; hostname: string; ts: number; startedAt: number; lastAt: number } | null> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT e.session AS session, e.visitor AS visitor, e.path AS path, e.hostname AS hostname, e.ts AS ts, s.started_at AS started_at, s.last_at AS last_at
       FROM rl_events e JOIN rl_sessions s ON s.id = e.session WHERE e.site = ? AND e.pageview = ? AND e.kind = 'pageview' LIMIT 1`,
      [site, pageview],
    );
    const row = rows[0];
    return row
      ? {
          session: String(row.session),
          visitor: String(row.visitor),
          path: String(row.path),
          hostname: String(row.hostname),
          ts: num(row.ts),
          startedAt: num(row.started_at),
          lastAt: num(row.last_at),
        }
      : null;
  }

  /**
   * After a late event or engagement ping joins an old visit (a tab left open overnight), the day
   * that visit started may already be added up. Forget that day so the next check builds it again.
   */
  async touchedOldVisit(site: string, started: number, before: number): Promise<void> {
    if (started < before) await this.clearRollups(site, { from: started, to: started + 1 });
  }

  async insertEvent(row: EventRow): Promise<void> {
    await this.db.run(
      `INSERT INTO rl_events (site, ts, kind, visitor, session, pageview, path, hostname, title, name, props, engaged_ms, scroll, link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.site, row.ts, row.kind, row.visitor, row.session, row.pageview, clip(row.path, 1000), clip(row.hostname, 255), clip(row.title, 500),
        clip(row.name, 255), row.props ? JSON.stringify(row.props) : null, row.engagedMs, row.scroll, row.link,
      ],
    );
  }

  // Imports

  async deleteSession(id: string): Promise<void> {
    await this.db.run(`DELETE FROM rl_sessions WHERE id = ?`, [id]);
  }

  /**
   * Marks a visit as imported from another tool. With `unknownEngagement`, its engaged time is unknown
   * rather than none, so its duration falls back to first to last request.
   */
  async markImported(id: string, unknownEngagement: boolean): Promise<void> {
    await this.db.run(unknownEngagement ? "UPDATE rl_sessions SET imported = 1, engaged_ms = NULL WHERE id = ?" : "UPDATE rl_sessions SET imported = 1 WHERE id = ?", [id]);
  }

  /** Deletes an imported link's clicks, and the visits they opened. */
  async deleteLinkHistory(link: string): Promise<void> {
    await this.db.run(`DELETE FROM rl_sessions WHERE id IN (SELECT DISTINCT session FROM rl_events WHERE link = ? AND session <> '')`, [link]);
    await this.db.run(`DELETE FROM rl_events WHERE link = ?`, [link]);
  }

  /** Clears what an earlier import left in [from, to), so a step of a visit import can always run again. */
  async clearImportedVisits(site: string, from: number, to: number): Promise<void> {
    const imported = `SELECT id FROM rl_sessions WHERE site = ? AND imported = 1`;
    await this.db.run(`DELETE FROM rl_events WHERE site = ? AND ts >= ? AND ts < ? AND kind IN ('pageview', 'event') AND session IN (${imported})`, [site, from, to, site]);
    // Visits of these days that kept no rows go too. Their rows would come within EVENT_TAIL_MS of the step,
    // so the time bounds let the (site, ts) index find them, with no scan of every event. That reaches back
    // EVENT_TAIL_MS too, for a visit an earlier import began before this step whose rows were all in it: a
    // CSV imported again has new ids, so its new visit does not take that one's place.
    await this.db.run(
      `DELETE FROM rl_sessions WHERE site = ? AND imported = 1 AND started_at >= ? AND started_at < ?
         AND id NOT IN (SELECT e.session FROM rl_events e WHERE e.site = ? AND e.ts >= ? AND e.ts < ?)`,
      [site, from - EVENT_TAIL_MS, to, site, from - EVENT_TAIL_MS, to + EVENT_TAIL_MS],
    );
  }

  /**
   * After a step of a visit import: a visit that began in an earlier step and went on into this one, [from, to),
   * is counted again from its rows, so a repeated step cannot leave it with doubled totals. The days those visits
   * began may already be built, so they are built again too.
   */
  async recountCarriedVisits(site: string, from: number, to: number): Promise<void> {
    const carried = await this.db.all<{ id: string; started_at: unknown }>(
      `SELECT s.id AS id, s.started_at AS started_at FROM rl_sessions s
       WHERE s.site = ? AND s.imported = 1 AND s.started_at < ? AND s.started_at >= ?
         AND s.id IN (SELECT e.session FROM rl_events e WHERE e.site = ? AND e.ts >= ? AND e.ts < ?)`,
      [site, from, from - EVENT_TAIL_MS, site, from, to],
    );
    if (!carried.length) return;
    const earliest = Math.min(...carried.map((c) => Number(c.started_at)));
    await this.clearRollups(site, { from: earliest, to: from });
    // Their rows lie between the earliest start and this step's end, which the (site, ts) index reads in one pass.
    // Ninety ids a statement, within Cloudflare D1's 100 values.
    const rows: Array<{ session: string; kind: string; ts: unknown; path: string }> = [];
    for (let i = 0; i < carried.length; i += 90) {
      const ids = carried.slice(i, i + 90).map((c) => c.id);
      rows.push(
        ...(await this.db.all<{ session: string; kind: string; ts: unknown; path: string }>(
          `SELECT e.session AS session, e.kind AS kind, e.ts AS ts, e.path AS path FROM rl_events e
           WHERE e.site = ? AND e.ts >= ? AND e.ts < ? AND e.kind IN ('pageview', 'event') AND e.session IN (${ids.map(() => "?").join(", ")})
           ORDER BY e.ts, e.id`,
          [site, earliest, to, ...ids],
        )),
      );
    }
    const totals = new Map<string, { pageviews: number; events: number; last: number; exit: string | null }>();
    for (const r of rows) {
      const t = totals.get(r.session) ?? { pageviews: 0, events: 0, last: 0, exit: null };
      if (r.kind === "pageview") {
        t.pageviews++;
        t.exit = r.path;
      } else t.events++;
      t.last = Math.max(t.last, Number(r.ts));
      totals.set(r.session, t);
    }
    for (const [id, t] of totals) {
      await this.db.run(`UPDATE rl_sessions SET pageviews = ?, events = ?, last_at = ?, exit_path = COALESCE(?, exit_path) WHERE id = ?`, [t.pageviews, t.events, t.last, t.exit, id]);
    }
  }

  // Links

  /** The live link with a slug. Slugs are unique across every domain. */
  async linkBySlug(slug: string): Promise<LinkRow | null> {
    const rows = await this.db.all(`SELECT * FROM rl_links WHERE slug = ? AND deleted_at IS NULL LIMIT 1`, [slug]);
    return rows[0] ? linkRow(rows[0]) : null;
  }

  async linkById(id: string): Promise<LinkRow | null> {
    const rows = await this.db.all(`SELECT * FROM rl_links WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [id]);
    return rows[0] ? linkRow(rows[0]) : null;
  }

  async insertLink(link: LinkRow): Promise<void> {
    await this.db.run(
      `INSERT INTO rl_links (id, site, domain, slug, name, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [link.id, link.site, link.domain, link.slug, link.name, link.url, link.createdAt, link.updatedAt],
    );
  }

  async updateLink(link: LinkRow): Promise<void> {
    await this.db.run(`UPDATE rl_links SET domain = ?, slug = ?, name = ?, url = ?, updated_at = ? WHERE id = ?`, [
      link.domain, link.slug, link.name, link.url, link.updatedAt, link.id,
    ]);
  }

  /** Hides a link and frees its slug; its clicks stay in the history. */
  async deleteLink(id: string, now: number): Promise<void> {
    await this.db.run(`UPDATE rl_links SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, [now, id]);
  }

  // Shares

  async shares(site: string): Promise<ShareRow[]> {
    const rows = await this.db.all(`SELECT id, site, name, created_at FROM rl_shares WHERE site = ? ORDER BY created_at DESC, id`, [site]);
    return rows.map((r) => ({ id: String(r.id), site: String(r.site), name: String(r.name ?? ""), createdAt: Number(r.created_at) }));
  }

  async shareById(id: string): Promise<ShareRow | null> {
    const [r] = await this.db.all(`SELECT id, site, name, created_at FROM rl_shares WHERE id = ?`, [id]);
    return r ? { id: String(r.id), site: String(r.site), name: String(r.name ?? ""), createdAt: Number(r.created_at) } : null;
  }

  async insertShare(share: ShareRow): Promise<void> {
    await this.db.run(`INSERT INTO rl_shares (id, site, name, created_at) VALUES (?, ?, ?, ?)`, [share.id, share.site, share.name, share.createdAt]);
  }

  async renameShare(id: string, name: string): Promise<void> {
    await this.db.run(`UPDATE rl_shares SET name = ? WHERE id = ?`, [name, id]);
  }

  /** Deleting a share is how it is revoked: the link stops working at once. */
  async deleteShare(id: string): Promise<void> {
    await this.db.run(`DELETE FROM rl_shares WHERE id = ?`, [id]);
  }

  // Funnels

  async funnels(site: string): Promise<FunnelRow[]> {
    const rows = await this.db.all(`SELECT * FROM rl_funnels WHERE site = ? ORDER BY created_at, id`, [site]);
    return rows.map((r) => ({ id: String(r.id), site: String(r.site), name: String(r.name), steps: JSON.parse(String(r.steps)) as FunnelStep[], createdAt: Number(r.created_at) }));
  }

  async saveFunnel(f: FunnelRow): Promise<void> {
    await this.db.run(
      upsert(this.db.dialect, "rl_funnels", ["id", "site", "name", "steps", "created_at"], ["id"], ["name", "steps"]),
      [f.id, f.site, f.name, JSON.stringify(f.steps), f.createdAt],
    );
  }

  async deleteFunnel(id: string): Promise<void> {
    await this.db.run(`DELETE FROM rl_funnels WHERE id = ?`, [id]);
  }

  /**
   * How many visits reached each step, in order, within the same visit. Step
   * one is the first matching row in the range; each later step must come
   * after the step before it. Filters choose which visits enter the funnel.
   */
  async funnelCounts(query: Query, funnel: FunnelRow): Promise<{ counts: number[]; sampled: boolean }> {
    // Past FUNNEL_VISITS visits in the range, only the newest are counted: the range starts where the oldest
    // of them began.
    const scope = visitScope(query.filters, query.site, query.from, query.to, this.db.dialect);
    const [first] = await this.db.all(
      `SELECT COUNT(*) AS n, MIN(started_at) AS t FROM (SELECT s.started_at AS started_at FROM rl_sessions s WHERE s.site = ? AND s.started_at >= ? AND s.started_at < ? AND ${IS_VISIT}${scope.sql}
         ORDER BY s.started_at DESC, s.id LIMIT ${this.funnelVisits + 1}) x`,
      [query.site, query.from, query.to, ...scope.params],
    );
    const sampled = num(first?.n) > this.funnelVisits;
    if (sampled) query = { ...query, from: Math.max(query.from, num(first?.t) + 1) };
    // The rows of the picked visits that match any step, in order, read once and walked here: a join from
    // each step to the next is planned badly by Postgres, which cannot guess how many visits go on.
    const v = visitRows(query.filters, query.site, query.from, query.to, this.db.dialect, true);
    const scopes = funnel.steps.map((step) => this.goalScope({ kind: step.kind, match: step.match, name: step.match } as GoalRow));
    // Separate seeks let SQLite use the path/name indexes for each step. UNION
    // keeps one copy of an event matching several steps, preserving step order.
    const seek = this.db.dialect === "sqlite" && !this.db.metered;
    const candidates = scopes.map((scope) => `SELECT e.id, e.site, e.session, e.ts, e.kind, e.path, e.name FROM rl_events e WHERE e.site = ? AND e.ts >= ? AND e.ts < ? AND ${scope.sql}`);
    const from = seek ? `(${candidates.join(" UNION ")}) e CROSS JOIN rl_sessions s` : v.from;
    const candidateParams = seek ? scopes.flatMap((scope) => [query.site, query.from, query.to + EVENT_TAIL_MS, ...scope.params]) : [];
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT e.session AS session, ${scopes.map((scope, i) => `CASE WHEN ${scope.sql} THEN 1 ELSE 0 END AS m${i}`).join(", ")}
       FROM ${from} WHERE ${v.sql} AND e.kind IN ('pageview', 'event') AND (${scopes.map((scope) => `(${scope.sql})`).join(" OR ")})
       ORDER BY e.session, e.ts, e.id`,
      [...scopes.flatMap((scope) => scope.params), ...candidateParams, ...v.params, ...scopes.flatMap((scope) => scope.params)],
    );
    const counts = funnel.steps.map(() => 0);
    let session: unknown = undefined;
    let reached = 0;
    const close = () => {
      for (let i = 0; i < reached; i++) counts[i]!++;
    };
    for (const row of rows) {
      if (row.session !== session) {
        close();
        session = row.session;
        reached = 0;
      }
      // Each step is the first matching row after the step before, so two steps in the same millisecond
      // both count, and one row never counts as two steps.
      if (reached < counts.length && num(row[`m${reached}`]) === 1) reached++;
    }
    close();
    return { counts, sampled };
  }

  /**
   * Each visit's pageviews in order, at most `perVisit` of them, for journeys.
   * A window function keeps the first ones of each visit, so a long visit
   * cannot crowd the rest out. Visits belong to the range they started in.
   */
  async journeyPages(query: Query, perVisit: number): Promise<{ rows: Array<{ session: string; path: string }>; sampled: boolean }> {
    const scope = visitScope(query.filters, query.site, query.from, query.to, this.db.dialect);
    // The newest visits the filters pick, JOURNEY_VISITS at most, so a long range stays quick and small in memory.
    const newest = (columns: string, limit: number) => `SELECT ${columns} FROM rl_sessions s WHERE s.site = ? AND s.started_at >= ? AND s.started_at < ? AND ${IS_VISIT}${scope.sql}
         ORDER BY s.started_at DESC, s.id LIMIT ${limit}`;
    const visitParams = [query.site, query.from, query.to, ...scope.params];
    // How many there are, one past the cap telling whether it was reached, and when the oldest of them began,
    // so the rows are read from there on rather than from the start of a long range.
    const [first] = await this.db.all(`SELECT COUNT(*) AS n, MIN(started_at) AS t FROM (${newest("s.started_at AS started_at", JOURNEY_VISITS + 1)}) x`, visitParams);
    if (!num(first?.n)) return { rows: [], sampled: false };
    const from = Math.max(query.from, num(first?.t));
    // MySQL takes no LIMIT in an IN list, but does in a table inside one.
    const visits = this.db.dialect === "mysql" ? `SELECT id FROM (${newest("s.id AS id", JOURNEY_VISITS)}) x` : newest("s.id", JOURNEY_VISITS);
    // ClickHouse has no LAG, and its own leaves the first row NULL only for a column that may be NULL.
    const lag =
      this.db.dialect === "clickhouse"
        ? "lagInFrame(toNullable(e.path)) OVER (PARTITION BY e.session ORDER BY e.ts, e.id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)"
        : "LAG(e.path) OVER (PARTITION BY e.session ORDER BY e.ts, e.id)";
    const rows = await this.db.all(
      // The visits are read as an IN list, which every database probes from the events side, so the
      // plan does not depend on the planner's statistics. Refreshes (the same page twice in a row) are
      // dropped before counting, so they never use up the steps.
      `WITH raw AS (
         SELECT e.session AS session, e.path AS path, e.ts AS ts, e.id AS id,
           ${lag} AS prev
         FROM rl_events e
         WHERE e.site = ? AND e.kind = 'pageview' AND e.ts >= ? AND e.ts < ? AND e.session IN (${visits})),
       v AS (
         SELECT session, path, ROW_NUMBER() OVER (PARTITION BY session ORDER BY ts, id) AS n
         FROM raw WHERE prev IS NULL OR prev <> path)
       SELECT session, path FROM v WHERE n <= ? ORDER BY session, n`,
      [query.site, from, query.to + EVENT_TAIL_MS, ...visitParams, perVisit],
    );
    return { rows: rows.map((r) => ({ session: String(r.session), path: String(r.path) })), sampled: num(first?.n) > JOURNEY_VISITS };
  }

  // API tokens

  private tokenRow(r: Record<string, unknown>): TokenRow {
    return {
      id: String(r.id),
      name: String(r.name),
      site: String(r.site ?? ""),
      scope: r.scope === "manage" ? "manage" : r.scope === "embed" ? "embed" : "read",
      hash: String(r.hash),
      hint: String(r.hint ?? ""),
      createdAt: Number(r.created_at),
      lastUsedAt: r.last_used_at === null || r.last_used_at === undefined ? null : Number(r.last_used_at),
    };
  }

  async tokens(): Promise<TokenRow[]> {
    return (await this.db.all(`SELECT * FROM rl_tokens ORDER BY created_at DESC, id`)).map((r) => this.tokenRow(r));
  }

  async tokenByHash(hash: string): Promise<TokenRow | null> {
    const [row] = await this.db.all(`SELECT * FROM rl_tokens WHERE hash = ?`, [hash]);
    return row ? this.tokenRow(row) : null;
  }

  async insertToken(t: TokenRow): Promise<void> {
    await this.db.run(`INSERT INTO rl_tokens (id, name, site, scope, hash, hint, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      t.id,
      t.name,
      t.site,
      t.scope,
      t.hash,
      t.hint,
      t.createdAt,
      t.lastUsedAt,
    ]);
  }

  async touchToken(id: string, now: number): Promise<void> {
    await this.db.run(`UPDATE rl_tokens SET last_used_at = ? WHERE id = ?`, [now, id]);
  }

  /** Deleting a token is how it is revoked: it stops working at once. */
  async deleteToken(id: string): Promise<boolean> {
    return (await this.changed(`DELETE FROM rl_tokens WHERE id = ?`, [id])) === 1;
  }

  // Settings

  async setting(key: string): Promise<string | null> {
    const [row] = await this.db.all(`SELECT value FROM rl_settings WHERE "key" = ?`, [key]);
    return row ? String(row.value) : null;
  }

  /** Every setting whose key starts with a prefix, such as each connected install's. */
  async settingsStartingWith(prefix: string): Promise<Array<{ key: string; value: string }>> {
    const rows = await this.db.all(`SELECT "key", value FROM rl_settings WHERE "key" LIKE ? ESCAPE '\\'`, [`${escapeLike(prefix)}%`]);
    return rows.map((r) => ({ key: String(r.key), value: String(r.value) }));
  }

  /** Reads a setting and deletes it. Of two callers at once, only the one whose delete took the row gets its value. */
  async takeSetting(key: string): Promise<string | null> {
    const value = await this.setting(key);
    if (value === null) return null;
    return (await this.settingChanged(`DELETE FROM rl_settings WHERE "key" = ?`, [key])) === 1 ? value : null;
  }

  /** Writes a setting only if it is not there yet. Of two callers at once, only one gets true. */
  async addSetting(key: string, value: string): Promise<boolean> {
    // mysql2 counts a row a duplicate key found as written, so MySQL ignores the insert instead.
    const sql = this.db.dialect === "mysql" ? `INSERT IGNORE INTO rl_settings ("key", value) VALUES (?, ?)` : upsert(this.db.dialect, "rl_settings", ['"key"', "value"], ['"key"'], []);
    return (await this.settingChanged(sql, [key, value])) === 1;
  }

  /**
   * A setting, or `made()` written as it when there is none yet, such as a signing key made on first use. Of two
   * callers at once, both get the value written first, so nothing signed with a key that lost is left invalid.
   */
  async settingOrAdd(key: string, made: () => string): Promise<string> {
    for (let tries = 0; tries < 5; tries++) {
      const saved = await this.setting(key);
      if (saved !== null) return saved;
      const value = made();
      if (await this.addSetting(key, value)) return value;
    }
    throw new Error(`Runlight: could not read or write the setting ${key}`);
  }

  /** Changes a setting only if it still holds `from`. Of two callers at once, only one gets true. */
  async swapSetting(key: string, from: string, to: string): Promise<boolean> {
    return (await this.settingChanged(`UPDATE rl_settings SET value = ? WHERE "key" = ? AND value = ?`, [to, key, from])) === 1;
  }

  /** How many settings a statement wrote. SQLite and D1 have no lock to lean on, so this is how a write knows it won. */
  private async settingChanged(sql: string, params: unknown[]): Promise<number> {
    if (this.db.affected) return this.db.affected(sql, params);
    return (await this.db.all(`${sql} RETURNING "key"`, params)).length;
  }

  async setSetting(key: string, value: string | null): Promise<void> {
    if (value === null) await this.db.run(`DELETE FROM rl_settings WHERE "key" = ?`, [key]);
    else await this.db.run(upsert(this.db.dialect, "rl_settings", ['"key"', "value"], ['"key"'], ["value"]), [key, value]);
  }

  // Email reports

  private reportRow(r: Record<string, unknown>): ReportRow {
    return {
      id: String(r.id),
      site: String(r.site),
      email: String(r.email),
      frequency: String(r.frequency) as ReportRow["frequency"],
      lang: String(r.lang ?? "en"),
      token: String(r.token),
      origin: String(r.origin ?? ""),
      lastPeriod: String(r.last_period ?? ""),
      lastSentAt: r.last_sent_at === null || r.last_sent_at === undefined ? null : Number(r.last_sent_at),
      createdAt: Number(r.created_at),
    };
  }

  async reports(site?: string): Promise<ReportRow[]> {
    const rows = site
      ? await this.db.all(`SELECT * FROM rl_reports WHERE site = ? ORDER BY created_at, id`, [site])
      : await this.db.all(`SELECT * FROM rl_reports ORDER BY created_at, id`);
    return rows.map((r) => this.reportRow(r));
  }

  async reportBy(field: "id" | "token", value: string): Promise<ReportRow | null> {
    const [row] = await this.db.all(`SELECT * FROM rl_reports WHERE ${field === "id" ? "id" : "token"} = ?`, [value]);
    return row ? this.reportRow(row) : null;
  }

  async insertReport(r: ReportRow): Promise<void> {
    await this.db.run(
      `INSERT INTO rl_reports (id, site, email, frequency, lang, token, origin, last_period, last_sent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.site, r.email, r.frequency, r.lang, r.token, r.origin, r.lastPeriod, r.lastSentAt, r.createdAt],
    );
  }

  /** Records a period as sent. Only one caller wins, so two cron runs at once cannot both send it. */
  async claimReport(id: string, period: string, now: number): Promise<boolean> {
    // One statement, so of two cron runs at once only one gets the row back.
    return (await this.changed(`UPDATE rl_reports SET last_period = ?, last_sent_at = ? WHERE id = ? AND last_period <> ?`, [period, now, id, period])) === 1;
  }

  /** Puts a period back when its email failed, so the next run tries again. */
  async releaseReport(id: string, period: string, previous: string): Promise<void> {
    await this.db.run(`UPDATE rl_reports SET last_period = ? WHERE id = ? AND last_period = ?`, [previous, id, period]);
  }

  async deleteReport(id: string): Promise<void> {
    await this.db.run(`DELETE FROM rl_reports WHERE id = ?`, [id]);
  }

  // Goals

  async goals(site?: string): Promise<GoalRow[]> {
    const rows = site
      ? await this.db.all(`SELECT * FROM rl_goals WHERE site = ? ORDER BY created_at, id`, [site])
      : await this.db.all(`SELECT * FROM rl_goals ORDER BY created_at, id`);
    return rows.map(goalRow);
  }

  async goalById(id: string): Promise<GoalRow | null> {
    const [row] = await this.db.all(`SELECT * FROM rl_goals WHERE id = ?`, [id]);
    return row ? goalRow(row) : null;
  }

  async saveGoal(g: GoalRow, before?: GoalRow): Promise<void> {
    const write = (db: Db) =>
      db.run(
        upsert(
          db.dialect,
          "rl_goals",
          ["id", "site", "name", "kind", '"match"', "click_by", "value_mode", "value", "value_prop", "currency", "created_at"],
          ["id"],
          ["name", "kind", '"match"', "click_by", "value_mode", "value", "value_prop", "currency"],
        ),
        [g.id, g.site, g.name, g.kind, g.match, g.clickBy, g.valueMode, g.value, g.valueProp, g.currency, g.createdAt],
      );
    // A click goal is counted by its name, which the tracker sends as the event
    // name. Renaming one renames its past clicks too, so its history stays.
    if (!(before?.kind === "click" && g.kind === "click" && before.name !== g.name)) return write(this.db);
    await this.transaction(async (store) => {
      const db = store.db;
      await db.run(`UPDATE rl_events SET name = ? WHERE site = ? AND kind = 'event' AND name = ?`, [g.name, g.site, before.name]);
      // The daily rollups count events by name too, and goals read them, so they take the new name as well.
      // A day that already has events under the new name counts both together now, so it is built again.
      const both = (await db.all(
        `SELECT day FROM rl_rollups WHERE site = ? AND dim = 'event' AND value = ?
         AND day IN (SELECT day FROM rl_rollups WHERE site = ? AND dim = 'event' AND value = ?)`,
        [g.site, before.name, g.site, g.name],
      )).map((r) => String(r.day));
      for (const day of both) {
        await db.run(`DELETE FROM rl_rollup_days WHERE site = ? AND day = ?`, [g.site, day]);
        await db.run(`DELETE FROM rl_rollups WHERE site = ? AND day = ?`, [g.site, day]);
      }
      await db.run(`UPDATE rl_rollups SET value = ? WHERE site = ? AND dim = 'event' AND value = ?`, [g.name, g.site, before.name]);
      await write(db);
    });
  }

  async deleteGoal(id: string): Promise<void> {
    await this.db.run(`DELETE FROM rl_goals WHERE id = ?`, [id]);
  }

  /** The events a goal counts, as a WHERE fragment over rl_events e. */
  private goalScope(goal: GoalRow): { sql: string; params: unknown[] } {
    if (goal.kind === "page") {
      return goal.match.includes("*")
        ? this.db.dialect !== "sqlite"
          ? // Postgres's LIKE heeds case, and so do ClickHouse's and MySQL's under Runlight's binary collation.
            { sql: `e.kind = 'pageview' AND ${like(this.db.dialect, "e.path")}`, params: [likePattern(goal.match)] }
          : // SQLite's LIKE ignores case; GLOB does not, so every database agrees with the others and with exact matches.
            { sql: `e.kind = 'pageview' AND e.path GLOB ?`, params: [globPattern(goal.match)] }
        : { sql: `e.kind = 'pageview' AND e.path = ?`, params: [goal.match] };
    }
    // Event goals count the named event; click goals count the event the tracker sends for them.
    return { sql: `e.kind = 'event' AND e.name = ?`, params: [goal.kind === "click" ? goal.name : goal.match] };
  }

  /** A numeric event property for one row, as SQL (0 when it is not a number). Property names are checked before they get here. */
  private propValue(prop: string): { sql: string; params: unknown[] } {
    if (this.db.dialect === "postgres") {
      return {
        sql: `(CASE WHEN (e.props::jsonb ->> ?) ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (e.props::jsonb ->> ?)::numeric ELSE 0 END)`,
        params: [prop, prop],
      };
    }
    if (this.db.dialect === "clickhouse") {
      // As Postgres's pattern: a JSON number, or text of digits with an optional sign and one decimal point.
      return {
        sql: `multiIf(JSONType(e.props, ?) IN ('Int64', 'UInt64', 'Double'), JSONExtractFloat(e.props, ?),
          JSONType(e.props, ?) = 'String' AND match(JSONExtractString(e.props, ?), '^-?[0-9]+([.][0-9]+)?$'), toFloat64OrZero(JSONExtractString(e.props, ?)), 0)`,
        params: new Array(5).fill(prop),
      };
    }
    const path = `$."${prop}"`;
    if (this.db.dialect === "mysql") {
      // As SQLite: a JSON number as it is, or text of digits with an optional sign and one decimal point.
      const value = `JSON_EXTRACT(e.props, ?)`;
      return {
        sql: `(CASE
          WHEN JSON_TYPE(${value}) IN ('INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL') THEN CAST(${value} AS DOUBLE)
          WHEN JSON_TYPE(${value}) = 'STRING' AND JSON_UNQUOTE(${value}) REGEXP '^-?[0-9]+([.][0-9]+)?$' THEN CAST(JSON_UNQUOTE(${value}) AS DOUBLE)
          ELSE 0 END)`,
        params: new Array(5).fill(path),
      };
    }
    // As Postgres's pattern: a JSON number, or text of digits with an optional sign and one decimal point.
    const text = `CAST(json_extract(e.props, ?) AS TEXT)`;
    return {
      sql: `(CASE
        WHEN json_type(e.props, ?) IN ('integer', 'real') THEN json_extract(e.props, ?)
        WHEN json_type(e.props, ?) = 'text' AND ${text} GLOB '[0-9]*' AND ${text} NOT GLOB '*[^0-9.]*' AND ${text} NOT GLOB '*.*.*' AND ${text} NOT GLOB '*.' THEN CAST(${text} AS REAL)
        WHEN json_type(e.props, ?) = 'text' AND ${text} GLOB '-[0-9]*' AND substr(${text}, 2) NOT GLOB '*[^0-9.]*' AND ${text} NOT GLOB '*.*.*' AND ${text} NOT GLOB '*.' THEN CAST(${text} AS REAL)
        ELSE 0 END)`,
      params: new Array(14).fill(path),
    };
  }

  /** The property names sent with an event in a query's range, most used first. */
  async eventPropKeys(query: Query, event: string): Promise<Array<{ key: string; events: number }>> {
    const v = visitRows(query.filters, query.site, query.from, query.to, this.db.dialect);
    const where = `${v.sql} AND e.kind = 'event' AND e.name = ? AND e.props IS NOT NULL`;
    const params = [...v.params, event];
    const rows =
      this.db.dialect === "mysql"
        ? // Each key as a row of its own, compared and sorted by code point like every other value.
          await this.db.all(
            `SELECT j.k AS "key", COUNT(*) AS events FROM ${v.from}
             CROSS JOIN JSON_TABLE(JSON_KEYS(CASE WHEN JSON_TYPE(e.props) = 'OBJECT' THEN e.props ELSE '{}' END), '$[*]' COLUMNS (k VARCHAR(255) COLLATE ${MYSQL_COLLATION} PATH '$')) j
             WHERE ${where} GROUP BY j.k ORDER BY events DESC, j.k LIMIT 30`,
            params,
          )
        : this.db.dialect === "clickhouse"
        ? await this.db.all(
            `SELECT k AS "key", COUNT(*) AS events FROM ${v.from} ARRAY JOIN JSONExtractKeys(ifNull(e.props, '')) AS k
             WHERE ${where} GROUP BY k ORDER BY events DESC, k LIMIT 30`,
            params,
          )
        : this.db.dialect === "postgres"
        ? await this.db.all(
            `SELECT k AS "key", COUNT(*) AS events FROM ${v.from} CROSS JOIN LATERAL jsonb_object_keys(CASE WHEN jsonb_typeof(e.props::jsonb) = 'object' THEN e.props::jsonb ELSE '{}'::jsonb END) AS k
             WHERE ${where} GROUP BY k ORDER BY events DESC, k${this.textOrder} LIMIT 30`,
            params,
          )
        : await this.db.all(
            `SELECT j.key AS "key", COUNT(*) AS events FROM ${v.from}, json_each(e.props) j
             WHERE ${where} AND json_type(e.props) = 'object' GROUP BY j.key ORDER BY events DESC, key${this.textOrder} LIMIT 30`,
            params,
          );
    return rows.map((r) => ({ key: String(r.key), events: num(r.events) }));
  }

  /** The values one property of an event took, with how often and by how many visitors. */
  async eventPropValues(query: Query, event: string, key: string, limit: number): Promise<Array<{ value: string; events: number; visitors: number }>> {
    const v = visitRows(query.filters, query.site, query.from, query.to, this.db.dialect);
    // ClickHouse's value names the key three times: text as it is, anything else as its JSON, and JSON null as none.
    const value =
      this.db.dialect === "postgres"
        ? `(e.props::jsonb ->> ?)`
        : this.db.dialect === "mysql"
          ? `(JSON_UNQUOTE(JSON_EXTRACT(e.props, ?)) COLLATE ${MYSQL_COLLATION})`
          : this.db.dialect === "clickhouse"
            ? `multiIf(JSONType(e.props, ?) = 'String', JSONExtractString(e.props, ?), JSONType(e.props, ?) = 'Null', NULL, JSONExtractRaw(e.props, ?))`
            : `CAST(json_extract(e.props, ?) AS TEXT)`;
    const path = this.db.dialect === "postgres" || this.db.dialect === "clickhouse" ? key : `$."${key}"`;
    const paths = new Array(this.db.dialect === "clickhouse" ? 4 : 1).fill(path);
    const rows = await this.db.all(
      `SELECT * FROM (SELECT ${value} AS value, COUNT(*) AS events, COUNT(DISTINCT e.visitor) AS visitors FROM ${v.from}
         WHERE ${v.sql} AND e.kind = 'event' AND e.name = ? AND ${value} IS NOT NULL GROUP BY 1) t
       ORDER BY events DESC, value${this.textOrder} LIMIT ?`,
      [...paths, ...v.params, event, ...paths, limit],
    );
    return rows.map((r) => ({ value: String(r.value), events: num(r.events), visitors: num(r.visitors) }));
  }

  /** The floating point type to cast to, which MySQL names in one word. */
  private get double(): string {
    return this.db.dialect === "mysql" ? "DOUBLE" : this.db.dialect === "clickhouse" ? "Float64" : "DOUBLE PRECISION";
  }

  /** A goal's worth for one converting row, as SQL. */
  private revenueValue(goal: GoalRow): { sql: string; params: unknown[] } {
    if (goal.valueMode === "prop" && goal.valueProp) return this.propValue(goal.valueProp);
    if (goal.valueMode === "fixed") return { sql: `CAST(? AS ${this.double})`, params: [goal.value] };
    return { sql: `0`, params: [] };
  }

  /**
   * Every goal's totals in one pass over the range's events, instead of a query
   * per goal: each goal adds a conditional count, distinct count, and sum.
   */
  async goalTotalsAll(query: Query, goals: GoalRow[]): Promise<Map<string, GoalTotals>> {
    // A goal the daily rollups count exactly comes from the built days and the visits of the rest: a page
    // by its whole path, or an event or click by name, worth nothing or a fixed amount. Visitor ids last a
    // day, so each day's visitors add up, as they do for every other report. A pattern or a value sent with
    // each event needs the events themselves.
    const rollable = (goal: GoalRow) => goal.valueMode !== "prop" && !(goal.kind === "page" && goal.match.includes("*"));
    const plan = goals.some(rollable) ? await this.rollupPlan(query, query.from, query.to) : null;
    if (!plan?.days.length) return this.rawGoalTotalsAll(query, goals);
    const rolled = goals.filter(rollable);
    const out = await this.rawGoalTotalsAll(query, goals.filter((goal) => !rollable(goal)));
    const counted = new Map<string, { visitors: number; n: number }>();
    for (const [dim, column, values] of [
      ["page", "pageviews", rolled.filter((g) => g.kind === "page").map((g) => g.match)],
      ["event", "events", rolled.filter((g) => g.kind !== "page").map((g) => (g.kind === "click" ? g.name : g.match))],
    ] as const) {
      const rows = await inPieces([...new Set(values)], VALUES_PER_QUERY, (piece) =>
        this.db.all(
          `SELECT value, SUM(visitors) AS visitors, SUM(${column}) AS n FROM rl_rollups
           WHERE site = ? AND dim = '${dim}' AND day IN (${BUILT_DAYS}) AND value IN (${piece.map(() => "?").join(", ")}) GROUP BY value`,
          [query.site, query.site, query.from, query.to, ...piece],
        ),
      );
      for (const row of rows) counted.set(`${dim}:${String(row.value)}`, { visitors: num(row.visitors), n: num(row.n) });
    }
    const rest = await Promise.all(plan.rest.map(([from, to]) => this.rawGoalTotalsAll({ ...query, from, to }, rolled)));
    for (const goal of rolled) {
      const key = goal.kind === "page" ? `page:${goal.match}` : `event:${goal.kind === "click" ? goal.name : goal.match}`;
      const sum = { conversions: counted.get(key)?.n ?? 0, visitors: counted.get(key)?.visitors ?? 0 };
      for (const part of rest) {
        sum.visitors += part.get(goal.id)!.visitors;
        sum.conversions += part.get(goal.id)!.conversions;
      }
      const revenue = goal.valueMode === "fixed" ? Math.round(sum.conversions * goal.value * 100) / 100 : 0;
      out.set(goal.id, { ...sum, revenue });
    }
    // In the goals' own order, however each was counted.
    return new Map(goals.map((goal) => [goal.id, out.get(goal.id)!]));
  }

  /** Every goal's totals read from the events of the range's visits. */
  private async rawGoalTotalsAll(query: Query, goals: GoalRow[]): Promise<Map<string, GoalTotals>> {
    const out = new Map<string, GoalTotals>();
    if (!goals.length) return out;
    // Local SQLite can seek each goal's path or event name instead of scanning
    // every pageview for a mixed set of goals. Metered stores keep the batch.
    if (this.db.dialect === "sqlite" && !this.db.metered) {
      for (const goal of goals) out.set(goal.id, await this.goalTotals(query, goal));
      return out;
    }
    const v = visitRows(query.filters, query.site, query.from, query.to, this.db.dialect, true);
    // As many goals per query as keep it under D1's parameter limit.
    const chunks: GoalRow[][] = [[]];
    let count = v.params.length;
    for (const goal of goals) {
      const cost = this.goalScope(goal).params.length * 4 + this.revenueValue(goal).params.length;
      if (chunks[chunks.length - 1]!.length && count + cost > MAX_PARAMS) {
        chunks.push([]);
        count = v.params.length;
      }
      chunks[chunks.length - 1]!.push(goal);
      count += cost;
    }
    for (const chunk of chunks) {
      if (!chunk.length) continue;
      const columns: string[] = [];
      const params: unknown[] = [];
      // Only rows some goal of the chunk counts are read.
      const any: string[] = [];
      const anyParams: unknown[] = [];
      chunk.forEach((goal, i) => {
        const scope = this.goalScope(goal);
        const value = this.revenueValue(goal);
        columns.push(
          `SUM(CASE WHEN ${scope.sql} THEN 1 ELSE 0 END) AS c${i}`,
          `COUNT(DISTINCT CASE WHEN ${scope.sql} THEN e.visitor END) AS v${i}`,
          `SUM(CASE WHEN ${scope.sql} THEN ${value.sql} ELSE 0 END) AS r${i}`,
        );
        params.push(...scope.params, ...scope.params, ...scope.params, ...value.params);
        any.push(`(${scope.sql})`);
        anyParams.push(...scope.params);
      });
      const [row] = await this.db.all(
        `SELECT ${columns.join(", ")} FROM ${v.from}
         WHERE ${v.sql} AND e.kind IN ('pageview', 'event') AND (${any.join(" OR ")})`,
        [...params, ...v.params, ...anyParams],
      );
      chunk.forEach((goal, i) =>
        out.set(goal.id, { conversions: num(row?.[`c${i}`]), visitors: num(row?.[`v${i}`]), revenue: Math.round(num(row?.[`r${i}`]) * 100) / 100 }),
      );
    }
    return out;
  }

  private revenueSql(goal: GoalRow): { sql: string; params: unknown[] } {
    if (goal.valueMode === "prop" && goal.valueProp) {
      const value = this.propValue(goal.valueProp);
      return { sql: `SUM(${value.sql})`, params: value.params };
    }
    // Cast, so Postgres does not read the bound value as a bigint and refuse 9.99.
    if (goal.valueMode === "fixed") return { sql: `COUNT(*) * CAST(? AS ${this.double})`, params: [goal.value] };
    return { sql: `0`, params: [] };
  }

  /** One goal's conversions, converting visitors, and revenue for a query's range and filters. */
  async goalTotals(query: Query, goal: GoalRow): Promise<GoalTotals> {
    const v = visitRows(query.filters, query.site, query.from, query.to, this.db.dialect);
    const scope = this.goalScope(goal);
    const revenue = this.revenueSql(goal);
    const [row] = await this.db.all(
      `SELECT COUNT(*) AS conversions, COUNT(DISTINCT e.visitor) AS visitors, ${revenue.sql} AS revenue
       FROM ${v.from} WHERE ${v.sql} AND ${scope.sql}`,
      [...revenue.params, ...v.params, ...scope.params],
    );
    return { conversions: num(row?.conversions), visitors: num(row?.visitors), revenue: Math.round(num(row?.revenue) * 100) / 100 };
  }

  /** A goal's conversions split by where the visit came from, or by the page it happened on. */
  async goalBreakdown(query: Query, goal: GoalRow, by: "source" | "channel" | "path", limit = 10): Promise<Array<{ value: string } & GoalTotals>> {
    const v = visitRows(query.filters, query.site, query.from, query.to, this.db.dialect);
    const col = by === "path" ? "e.path" : `s.${by}`;
    const scope = this.goalScope(goal);
    const revenue = this.revenueSql(goal);
    const rows = await this.db.all(
      `SELECT ${col} AS value, COUNT(*) AS conversions, COUNT(DISTINCT e.visitor) AS visitors, ${revenue.sql} AS revenue
       FROM ${v.from} WHERE ${v.sql} AND ${scope.sql}
       GROUP BY ${col} ORDER BY conversions DESC, ${col}${this.textOrder} LIMIT ?`,
      [...revenue.params, ...v.params, ...scope.params, limit],
    );
    return rows.map((r) => ({
      value: String(r.value ?? ""),
      conversions: num(r.conversions),
      visitors: num(r.visitors),
      revenue: Math.round(num(r.revenue) * 100) / 100,
    }));
  }

  /** A goal's conversions and revenue in each bucket, by when each visit started. */
  async goalSeries(query: Omit<Query, "from" | "to">, goal: GoalRow, buckets: Bucket[]): Promise<Array<{ start: number; conversions: number; revenue: number }>> {
    if (buckets.length === 0) return [];
    const scope = this.goalScope(goal);
    const revenue = this.revenueSql(goal);
    // Each bucket binds three values; the rest are fixed. As many buckets a statement as keep it under D1's 100.
    const fixed = revenue.params.length + scope.params.length + visitRows(query.filters, query.site, 0, 0, this.db.dialect).params.length;
    const size = Math.max(1, Math.min(BUCKETS_PER_QUERY, Math.floor((MAX_PARAMS - fixed) / 3)));
    if (buckets.length > size) return inPieces(buckets, size, (piece) => this.goalSeries(query, goal, piece));
    const v = visitRows(query.filters, query.site, buckets[0]!.start, buckets[buckets.length - 1]!.end, this.db.dialect);
    const rows = await this.db.all(
      `WITH ${bucketTable(this.db.dialect, buckets)}
       SELECT b.i AS i, COUNT(*) AS conversions, ${revenue.sql} AS revenue
       FROM ${v.from} CROSS JOIN b
       WHERE ${v.sql} AND s.started_at >= b.bs AND s.started_at < b.be AND ${scope.sql}
       GROUP BY b.i`,
      [...buckets.flatMap((b, i) => [i, b.start, b.end]), ...revenue.params, ...v.params, ...scope.params],
    );
    const found = new Map(rows.map((r) => [num(r.i), r]));
    return buckets.map((b, i) => ({ start: b.start, conversions: num(found.get(i)?.conversions), revenue: Math.round(num(found.get(i)?.revenue) * 100) / 100 }));
  }

  async linkDomains(): Promise<Array<{ domain: string; site: string }>> {
    return this.db.all(`SELECT domain, site FROM rl_link_domains ORDER BY domain`);
  }

  async addLinkDomain(domain: string, site: string, now: number): Promise<void> {
    await this.db.run(upsert(this.db.dialect, "rl_link_domains", ["domain", "site", "created_at"], ["domain"], []), [domain, site, now]);
  }

  /**
   * Removes a domain. Its links keep it as their home and fall back to the
   * app's own link path until the domain is added again.
   */
  async removeLinkDomain(domain: string): Promise<void> {
    await this.db.run(`DELETE FROM rl_link_domains WHERE domain = ?`, [domain]);
  }

  /**
   * A site's links, newest first, with their clicks in a range. Clicks
   * imported as daily counts have no visitor, so they add to clicks only.
   */
  async links(site: string, from: number, to: number): Promise<Array<LinkRow & LinkStats>> {
    const rows = await this.db.all(
      `SELECT l.*, COALESCE(c.clicks, 0) AS clicks, COALESCE(c.visitors, 0) AS visitors
       FROM rl_links l LEFT JOIN (
         SELECT link, COUNT(*) AS clicks, COUNT(DISTINCT NULLIF(visitor, '')) AS visitors FROM rl_events
         WHERE site = ? AND kind = 'click' AND ts >= ? AND ts < ? GROUP BY link
       ) c ON c.link = l.id
       WHERE l.site = ? AND l.deleted_at IS NULL
       ORDER BY l.created_at DESC, l.id`,
      [site, from, to, site],
    );
    return rows.map((row) => ({ ...linkRow(row), clicks: num(row.clicks), visitors: num(row.visitors) }));
  }

  /** One link's clicks per bucket. */
  async linkSeries(site: string, link: string, buckets: Bucket[]): Promise<Array<{ start: number; clicks: number; visitors: number }>> {
    if (buckets.length === 0) return [];
    if (buckets.length > BUCKETS_PER_QUERY) return inPieces(buckets, BUCKETS_PER_QUERY, (piece) => this.linkSeries(site, link, piece));
    const rows = await this.db.all(
      `WITH ${bucketTable(this.db.dialect, buckets)}
       SELECT b.i AS i, COUNT(*) AS clicks, COUNT(DISTINCT NULLIF(e.visitor, '')) AS visitors
       FROM b JOIN rl_events e ON e.link = ? AND e.ts >= b.bs AND e.ts < b.be
       WHERE e.site = ? AND e.kind = 'click' GROUP BY b.i`,
      [...buckets.flatMap((b, i) => [i, b.start, b.end]), link, site],
    );
    const found = new Map(rows.map((row) => [num(row.i), row]));
    return buckets.map((bucket, i) => ({ start: bucket.start, clicks: num(found.get(i)?.clicks), visitors: num(found.get(i)?.visitors) }));
  }

  /** One link's clicks by a visit dimension: where they came from, where they were, what they used. */
  async linkBreakdown(site: string, link: string, from: number, to: number, dimension: SessionDimension, limit: number): Promise<BreakdownRow[]> {
    const col = `s.${SESSION_DIMENSIONS[dimension]}`;
    const rows = await this.db.all(
      `SELECT ${col} AS value, COUNT(*) AS clicks, COUNT(DISTINCT e.visitor) AS visitors
       FROM rl_events e JOIN rl_sessions s ON s.id = e.session
       WHERE e.site = ? AND e.link = ? AND e.kind = 'click' AND e.ts >= ? AND e.ts < ? AND ${col} <> ''
       GROUP BY ${col} ORDER BY clicks DESC, ${col}${this.textOrder} LIMIT ?`,
      [site, link, from, to, limit],
    );
    return rows.map((row) => ({ value: String(row.value), visitors: num(row.visitors), events: num(row.clicks) }));
  }

  // Reports

  /**
   * Ties are broken by the value in code point order, the order the rolled-up path sorts in, so a report
   * reads the same before and after its days are built. Postgres would otherwise use its locale's order.
   * MySQL's columns already sort this way; a value worked out from JSON may not.
   */
  private get textOrder(): string {
    // SQLite and ClickHouse compare text byte by byte, which for UTF-8 is by code point.
    return this.db.dialect === "postgres" ? ' COLLATE "C"' : this.db.dialect === "mysql" ? ` COLLATE ${MYSQL_COLLATION}` : "";
  }

  /** When Runlight itself first counted a visit, leaving out imported history. */
  async firstOwnVisit(site: string): Promise<number | null> {
    // A session opened only by a short link click is not a visit, so it does not count as the first.
    const [row] = await this.db.all(`SELECT MIN(started_at) AS t FROM rl_sessions s WHERE s.site = ? AND s.imported = 0 AND ${IS_VISIT}`, [site]);
    return row?.t === null || row?.t === undefined ? null : num(row.t);
  }

  /** When the site's first visit was recorded, or null with no data yet. */
  async firstSeen(site: string): Promise<number | null> {
    const [row] = await this.db.all(`SELECT MIN(started_at) AS t FROM rl_sessions WHERE site = ?`, [site]);
    return row?.t === null || row?.t === undefined ? null : num(row.t);
  }

  /** Just the visitor count from stats(), in one query, for conversion rates. */
  async visitors(query: Query): Promise<number> {
    // Built days add up their visitors, as the stats do.
    const rolled = await this.rolledStats(query);
    if (rolled) return rolled.visitors;
    const scope = visitScope(query.filters, query.site, query.from, query.to, this.db.dialect);
    const table = this.db.dialect === "sqlite" && query.filters.length === 0 ? "rl_sessions s INDEXED BY rl_sessions_visit_visitors" : "rl_sessions s";
    const [row] = await this.db.all(
      `SELECT COUNT(DISTINCT s.visitor) AS visitors FROM ${table} WHERE s.site = ? AND s.started_at >= ? AND s.started_at < ? AND ${IS_VISIT}${scope.sql}`,
      [query.site, query.from, query.to, ...scope.params],
    );
    return num(row?.visitors);
  }

  async stats(query: Query): Promise<Stats> {
    const rolled = await this.rolledStats(query);
    if (rolled) return rolled;
    // Filtered or not, the numbers describe visits that started in the range (see visitScope).
    const { scope, pv } = visitsAndPageviews(query.filters, query.site, query.from, query.to, this.db.dialect);
    const [row] = await this.db.all(
      `SELECT COUNT(DISTINCT s.visitor) AS visitors, COUNT(*) AS visits, SUM(${pv ? "COALESCE(pv.n, 0)" : "s.pageviews"}) AS pageviews,
         SUM(CASE WHEN ${BOUNCE} THEN 1 ELSE 0 END) AS bounced, SUM(${DURATION}) AS duration
       FROM rl_sessions s ${pv?.join ?? ""}
       WHERE s.site = ? AND s.started_at >= ? AND s.started_at < ? AND ${IS_VISIT}${scope.sql}`,
      [...(pv?.params ?? []), query.site, query.from, query.to, ...scope.params],
    );
    const visits = num(row?.visits);
    const pageviews = num(row?.pageviews);
    return {
      visitors: num(row?.visitors),
      visits,
      pageviews,
      viewsPerVisit: visits > 0 ? Math.round((pageviews / visits) * 100) / 100 : 0,
      bounceRate: visits > 0 ? num(row?.bounced) / visits : 0,
      visitDuration: visits > 0 ? Math.round(num(row?.duration) / visits) : 0,
    };
  }

  async series(query: Omit<Query, "from" | "to">, buckets: Bucket[]): Promise<SeriesPoint[]> {
    if (buckets.length === 0) return [];
    if (buckets.length > BUCKETS_PER_QUERY) return inPieces(buckets, BUCKETS_PER_QUERY, (piece) => this.series(query, piece));
    const params: unknown[] = buckets.flatMap((b, i) => [i, b.start, b.end]);
    // Filtered or not, each bucket counts the visits that started in it (see visitScope).
    const { scope, pv } = visitsAndPageviews(query.filters, query.site, buckets[0]!.start, buckets[buckets.length - 1]!.end, this.db.dialect);
    // Built days that fit inside one bucket come from rollups; the rest from the visits.
    const plan = await this.rollupPlan(query, buckets[0]!.start, buckets[buckets.length - 1]!.end);
    const inBucket = (d: { start: number; end: number }) => buckets.findIndex((b) => b.start <= d.start && d.end <= b.end);
    const used = plan ? plan.days.filter((d) => inBucket(d) >= 0) : [];
    let rest: Array<[number, number]> | null = null;
    if (used.length) {
      rest = [];
      let from = buckets[0]!.start;
      for (const d of used) {
        if (d.start > from) rest.push([from, d.start]);
        from = Math.max(from, d.end);
      }
      if (from < buckets[buckets.length - 1]!.end) rest.push([from, buckets[buckets.length - 1]!.end]);
    }
    // MySQL and ClickHouse join the buckets to every visit of the site unless told the whole range as well.
    const w = rest ? SqlStore.within(rest) : this.db.dialect === "mysql" || this.db.dialect === "clickhouse" ? SqlStore.within([[buckets[0]!.start, buckets[buckets.length - 1]!.end]]) : { sql: "1 = 1", params: [] };
    // Filters and scattered unbuilt days add values of their own; when they would pass D1's 100, the
    // buckets go in halves.
    if (params.length + 1 + w.params.length + scope.params.length + (pv?.params.length ?? 0) > MAX_PARAMS && buckets.length > 1) {
      const half = Math.ceil(buckets.length / 2);
      return [...(await this.series(query, buckets.slice(0, half))), ...(await this.series(query, buckets.slice(half)))];
    }
    const sums = new Map<number, Record<string, number>>();
    const bump = (i: number, row: Record<string, unknown>) => {
      const into = sums.get(i) ?? { visitors: 0, n: 0, views: 0, bounced: 0, duration: 0 };
      for (const k of Object.keys(into)) into[k]! += num(row[k]);
      sums.set(i, into);
    };
    if (used.length) {
      const rolled = await this.db.all(
        `SELECT day, visitors, visits AS n, pageviews AS views, bounced, duration FROM rl_rollups WHERE site = ? AND dim = '' AND day IN (${BUILT_DAYS})`,
        [query.site, query.site, buckets[0]!.start, buckets[buckets.length - 1]!.end],
      );
      const at = new Map(used.map((d) => [d.day, inBucket(d)]));
      for (const row of rolled) if (at.has(String(row.day))) bump(at.get(String(row.day))!, row);
    }
    const totals = `COUNT(DISTINCT s.visitor) AS visitors, COUNT(*) AS n, SUM(${pv ? "COALESCE(pv.n, 0)" : "s.pageviews"}) AS views,
         SUM(CASE WHEN ${BOUNCE} THEN 1 ELSE 0 END) AS bounced, SUM(${DURATION}) AS duration`;
    const rows =
      this.db.dialect === "clickhouse"
        ? // ClickHouse would hold every visit of the site in memory to join them to the buckets, so each visit
          // finds its bucket in a list instead.
          await this.db.all<Record<string, unknown>>(
            `SELECT i, ${totals} FROM (
               SELECT s.*, arrayFirstIndex((a, z) -> s.started_at >= a AND s.started_at < z, [${buckets.map((b) => Math.trunc(b.start)).join(", ")}], [${buckets.map((b) => Math.trunc(b.end)).join(", ")}]) - 1 AS i
               FROM rl_sessions s WHERE s.site = ? AND s.started_at >= ? AND s.started_at < ?) s
             ${pv?.join ?? ""}
             WHERE i >= 0 AND ${IS_VISIT}${scope.sql} AND ${w.sql}
             GROUP BY i`,
            [query.site, buckets[0]!.start, buckets[buckets.length - 1]!.end, ...(pv?.params ?? []), ...scope.params, ...w.params],
          )
        : await this.db.all<Record<string, unknown>>(
            `WITH ${bucketTable(this.db.dialect, buckets)}
             SELECT b.i AS i, ${totals}
             FROM b JOIN rl_sessions s ON s.site = ? AND s.started_at >= b.bs AND s.started_at < b.be
             ${pv?.join ?? ""}
             WHERE ${IS_VISIT}${scope.sql} AND ${w.sql}
             GROUP BY b.i`,
            [...params, query.site, ...(pv?.params ?? []), ...scope.params, ...w.params],
          );
    for (const row of rows) bump(num(row.i), row);
    return buckets.map((bucket, i) => {
      const row = sums.get(i);
      const n = num(row?.n);
      return {
        start: bucket.start,
        visitors: num(row?.visitors),
        visits: n,
        pageviews: num(row?.views),
        viewsPerVisit: n > 0 ? Math.round((num(row?.views) / n) * 100) / 100 : 0,
        bounceRate: n > 0 ? num(row?.bounced) / n : 0,
        visitDuration: n > 0 ? Math.round(num(row?.duration) / n) : 0,
      };
    });
  }

  /** Seek one matching event per hostname, skipping its remaining events before the next seek. */
  async hostnameSuggestions(query: Query, limit: number): Promise<Array<{ value: string }>> {
    const v = visitRows(query.filters, query.site, query.from, query.to, this.db.dialect);
    const within = rowScope(query.filters, ["page", "hostname"], this.db.dialect);
    const table = this.db.dialect === "sqlite" ? "rl_events e INDEXED BY rl_events_hostname_suggest" : "rl_events e";
    const rows: Array<{ value: string }> = [];
    let after: string | undefined;
    while (rows.length < limit) {
      const [row] = await this.db.all<{ value: string }>(
        `SELECT e.hostname AS value FROM ${table} CROSS JOIN rl_sessions s
         WHERE ${v.sql} AND e.kind = 'pageview'${within.sql}${after === undefined ? "" : ` AND e.hostname${this.textOrder} > ?`}
         ORDER BY e.hostname${this.textOrder} LIMIT 1`,
        [...v.params, ...within.params, ...(after === undefined ? [] : [after])],
      );
      if (!row) break;
      after = String(row.value);
      rows.push({ value: after });
    }
    return rows;
  }

  async breakdown(query: Query, dimension: Dimension, limit: number, offset: number): Promise<BreakdownRow[]> {
    const page = [limit, offset];
    if (dimension === "ai_agent" || dimension === "ai_page") {
      const col = dimension === "ai_agent" ? "e.name" : "e.path";
      const rows = await this.db.all(
        `SELECT ${col} AS value, COUNT(*) AS fetches FROM rl_events e
         WHERE e.site = ? AND e.ts >= ? AND e.ts < ? AND e.kind = 'fetch'
         GROUP BY ${col} ORDER BY fetches DESC, ${col}${this.textOrder} LIMIT ? OFFSET ?`,
        [query.site, query.from, query.to, ...page],
      );
      return rows.map((row) => ({ value: String(row.value), visitors: 0, fetches: num(row.fetches) }));
    }

    const rolled = await this.rolledBreakdown(query, dimension, limit, offset);
    if (rolled) return rolled;

    // Filtered or not, the visits are those that started in the range (see visitScope).
    const scope = visitScope(query.filters, query.site, query.from, query.to, this.db.dialect);
    if (isSessionDimension(dimension)) {
      const { scope, pv } = visitsAndPageviews(query.filters, query.site, query.from, query.to, this.db.dialect);
      const col = `s.${SESSION_DIMENSIONS[dimension]}`;
      const entryExit = dimension === "entry" || dimension === "exit";
      const rows = await this.db.all(
        `SELECT ${col} AS value, COUNT(DISTINCT s.visitor) AS visitors, COUNT(*) AS visits, SUM(${pv ? "COALESCE(pv.n, 0)" : "s.pageviews"}) AS pageviews,
           SUM(CASE WHEN ${BOUNCE} THEN 1 ELSE 0 END) AS bounced, SUM(${DURATION}) AS duration
         FROM rl_sessions s ${pv?.join ?? ""}
         WHERE s.site = ? AND s.started_at >= ? AND s.started_at < ? AND ${IS_VISIT}${scope.sql} AND ${col} <> ''
         GROUP BY ${col} ORDER BY ${entryExit ? "visits DESC" : "visitors DESC, visits DESC"}, ${col}${this.textOrder} LIMIT ? OFFSET ?`,
        [...(pv?.params ?? []), query.site, query.from, query.to, ...scope.params, ...page],
      );
      return rows.map((row) => {
        const visits = num(row.visits);
        const out: BreakdownRow = {
          value: String(row.value),
          visitors: num(row.visitors),
          visits,
          bounceRate: visits > 0 ? num(row.bounced) / visits : 0,
        };
        if (!entryExit) {
          out.pageviews = num(row.pageviews);
          out.visitDuration = visits > 0 ? Math.round(num(row.duration) / visits) : 0;
        }
        return out;
      });
    }

    // Rows from the visits that started in the range and that the filters pick, narrowed by any filter on
    // the same kind of row ("page is /pricing" on pages), as the rollups count them.
    const within = (dimensions: string[]) => {
      const rows = rowScope(query.filters, dimensions, this.db.dialect);
      const carried = this.carriedFrom !== null && query.from >= this.carriedFrom ? carriedScope(query.filters, dimensions, query.from, query.to, this.db.dialect) : null;
      if (carried) return { sql: `${carried.sql}${rows.sql}`, params: [...carried.params, ...rows.params], to: query.to + EVENT_TAIL_MS };
      return {
        // On ClickHouse, by the ids' hashes, which the set holds in under half the memory.
        sql:
          this.db.dialect === "clickhouse"
            ? ` AND cityHash64(e.session) IN (SELECT cityHash64(s.id) FROM rl_sessions s WHERE s.site = ? AND s.started_at >= ? AND s.started_at < ? AND ${IS_VISIT}${scope.sql})${rows.sql}`
            : ` AND e.session IN (SELECT s.id FROM rl_sessions s WHERE s.site = ? AND s.started_at >= ? AND s.started_at < ? AND ${IS_VISIT}${scope.sql})${rows.sql}`,
        params: [query.site, query.from, query.to, ...scope.params, ...rows.params],
        to: query.to + EVENT_TAIL_MS,
      };
    };

    if (dimension === "page" || dimension === "hostname") {
      const col = `e.${EVENT_DIMENSIONS[dimension]}`;
      const w = within(["page", "hostname"]);
      const rows = await this.db.all(
        `SELECT ${col} AS value, COUNT(DISTINCT e.visitor) AS visitors, COUNT(*) AS pageviews, ${LIVE_VIEWS} AS views
         FROM rl_events e
         WHERE e.site = ? AND e.ts >= ? AND e.ts < ? AND e.kind = 'pageview'${w.sql}
         GROUP BY ${col} ORDER BY visitors DESC, pageviews DESC, ${col}${this.textOrder} LIMIT ? OFFSET ?`,
        [query.site, query.from, w.to, ...w.params, ...page],
      );
      const out: BreakdownRow[] = rows.map((row) => ({ value: String(row.value), visitors: num(row.visitors), pageviews: num(row.pageviews) }));
      const live = new Map(rows.map((row) => [String(row.value), num(row.views)]));
      if (dimension === "page" && out.length > 0) {
        // Each pageview's engaged time added up and its deepest scroll, then the mean over pageviews. Filters add
        // values of their own, so fewer paths go in each statement, keeping it within D1's 100.
        const size = Math.max(1, Math.min(VALUES_PER_QUERY, MAX_PARAMS - 3 - w.params.length));
        const times = await inPieces(out, size, (piece) =>
          this.db.all(
            `SELECT value, SUM(total) AS total, COUNT(*) AS views, AVG(deepest) AS scroll FROM (
               SELECT e.path AS value, SUM(e.engaged_ms) AS total, MAX(e.scroll) AS deepest
               FROM rl_events e WHERE e.site = ? AND e.ts >= ? AND e.ts < ? AND e.kind = 'engagement'${w.sql}
               AND e.path IN (${piece.map(() => "?").join(", ")}) GROUP BY e.path, e.pageview) t GROUP BY value`,
            [query.site, query.from, w.to, ...w.params, ...piece.map((row) => row.value)],
          ),
        );
        const byPath = new Map(times.map((t) => [String(t.value), t]));
        for (const row of out) {
          const time = byPath.get(row.value);
          const views = live.get(row.value) ?? 0;
          row.timeOnPage = time && views ? Math.round(num(time.total) / views) : 0;
          row.scrollDepth = time?.scroll === null || time?.scroll === undefined ? 0 : Math.round(num(time.scroll));
        }
      }
      return out;
    }

    if (dimension === "event") {
      const w = within(["event"]);
      const rows = await this.db.all(
        `SELECT e.name AS value, COUNT(DISTINCT e.visitor) AS visitors, COUNT(*) AS events
         FROM rl_events e
         WHERE e.site = ? AND e.ts >= ? AND e.ts < ? AND e.kind = 'event'${w.sql}
         GROUP BY e.name ORDER BY visitors DESC, events DESC, e.name${this.textOrder} LIMIT ? OFFSET ?`,
        [query.site, query.from, w.to, ...w.params, ...page],
      );
      return rows.map((row) => ({ value: String(row.value), visitors: num(row.visitors), events: num(row.events) }));
    }

    return [];
  }

  /**
   * Visits by quarter hour since the epoch, which the caller folds into local weekdays and hours,
   * keeping time zones (DST included) out of SQL. Quarters, not hours, so a site in a
   * half-hour or 45-minute timezone (India, Nepal) folds each into the right local hour.
   */
  async hourly(query: Query): Promise<Array<{ quarter: number; visits: number; visitors: number; pageviews: number; bounced: number }>> {
    const plan = await this.rollupPlan(query, query.from, query.to);
    if (plan) {
      const sums = new Map<number, { quarter: number; visits: number; visitors: number; pageviews: number; bounced: number }>();
      const bump = (quarter: number, row: Record<string, unknown>) => {
        const into = sums.get(quarter) ?? { quarter, visits: 0, visitors: 0, pageviews: 0, bounced: 0 };
        into.visits += num(row.visits);
        into.visitors += num(row.visitors);
        into.pageviews += num(row.pageviews);
        into.bounced += num(row.bounced);
        sums.set(quarter, into);
      };
      const rolled = await this.db.all(
        `SELECT value, visits, visitors, pageviews, bounced FROM rl_rollups WHERE site = ? AND dim = 'quarter' AND day IN (${BUILT_DAYS})`,
        [query.site, query.site, query.from, query.to],
      );
      for (const row of rolled) bump(Number(row.value), row);
      const w = SqlStore.within(plan.rest);
      const raw = await this.db.all(
        `SELECT ${div(this.db.dialect, "s.started_at", 900000)} AS quarter, COUNT(*) AS visits, COUNT(DISTINCT s.visitor) AS visitors,
           SUM(s.pageviews) AS pageviews, SUM(CASE WHEN ${BOUNCE} THEN 1 ELSE 0 END) AS bounced
         FROM rl_sessions s WHERE s.site = ? AND ${w.sql} AND ${IS_VISIT} GROUP BY 1`,
        [query.site, ...w.params],
      );
      for (const row of raw) bump(Math.floor(num(row.quarter)), row);
      return [...sums.values()];
    }
    // A page filter counts that page's views as pageviews here too, as the cards do.
    const { scope: matching, pv } = visitsAndPageviews(query.filters, query.site, query.from, query.to, this.db.dialect);
    const rows = await this.db.all(
      `SELECT ${div(this.db.dialect, "s.started_at", 900000)} AS quarter, COUNT(*) AS visits, COUNT(DISTINCT s.visitor) AS visitors,
         SUM(${pv ? "COALESCE(pv.n, 0)" : "s.pageviews"}) AS pageviews, SUM(CASE WHEN ${BOUNCE} THEN 1 ELSE 0 END) AS bounced
       FROM rl_sessions s ${pv?.join ?? ""}
       WHERE s.site = ? AND s.started_at >= ? AND s.started_at < ? AND ${IS_VISIT}${matching.sql}
       GROUP BY 1`,
      [...(pv?.params ?? []), query.site, query.from, query.to, ...matching.params],
    );
    return rows.map((row) => ({
      quarter: Math.floor(num(row.quarter)),
      visits: num(row.visits),
      visitors: num(row.visitors),
      pageviews: num(row.pageviews),
      bounced: num(row.bounced),
    }));
  }

  async realtime(site: string, now: number): Promise<Realtime> {
    const since = now - 5 * 60_000;
    const [active] = await this.db.all(
      `SELECT COUNT(DISTINCT visitor) AS n FROM rl_events WHERE site = ? AND ts >= ? AND kind IN ('pageview', 'event', 'engagement')`,
      [site, since],
    );
    const pages = await this.db.all(
      // Through the kind and time index: SQLite otherwise reads the site's whole history by path to group it.
      `SELECT e.path AS value, COUNT(DISTINCT e.visitor) AS visitors FROM ${eventKindTable(this.db.dialect)}
       WHERE e.site = ? AND e.ts >= ? AND e.kind = 'pageview' GROUP BY e.path ORDER BY visitors DESC, e.path${this.textOrder} LIMIT 10`,
      [site, since],
    );
    const sources = await this.db.all(
      `SELECT s.source AS value, COUNT(DISTINCT e.visitor) AS visitors FROM rl_events e JOIN rl_sessions s ON s.id = e.session
       WHERE e.site = ? AND e.ts >= ? AND e.kind IN ('pageview', 'event')
       GROUP BY s.source ORDER BY visitors DESC, s.source${this.textOrder} LIMIT 10`,
      [site, since],
    );
    const start = Math.floor(now / 60_000) * 60_000 - 29 * 60_000;
    const perMinute = await this.db.all(
      `SELECT ${div(this.db.dialect, "(ts - ?)", 60000)} AS m, COUNT(*) AS n FROM rl_events
       WHERE site = ? AND ts >= ? AND kind = 'pageview' GROUP BY 1`,
      [start, site, start],
    );
    const minutes = new Array<number>(30).fill(0);
    for (const row of perMinute) {
      const index = Math.floor(num(row.m));
      if (index >= 0 && index < 30) minutes[index] = (minutes[index] ?? 0) + num(row.n);
    }
    const countries = await this.db.all(
      `SELECT s.country AS value, COUNT(DISTINCT e.visitor) AS visitors FROM rl_events e JOIN rl_sessions s ON s.id = e.session
       WHERE e.site = ? AND e.ts >= ? AND e.kind IN ('pageview', 'event') AND s.country <> ''
       GROUP BY s.country ORDER BY visitors DESC, s.country${this.textOrder} LIMIT 10`,
      [site, since],
    );
    const recent = await this.db.all(
      `SELECT e.ts, e.kind, e.path, e.name, s.country, s.city, s.source, s.device FROM rl_events e JOIN rl_sessions s ON s.id = e.session
       WHERE e.site = ? AND e.ts >= ? AND e.kind IN ('pageview', 'event') ORDER BY e.ts DESC, e.id DESC LIMIT 20`,
      [site, start],
    );
    const pairs = (rows: Record<string, unknown>[]) => rows.map((row) => ({ value: String(row.value), visitors: num(row.visitors) }));
    return {
      visitors: num(active?.n),
      pages: pairs(pages),
      sources: pairs(sources),
      countries: pairs(countries),
      minutes,
      recent: recent.map((r) => ({
        ts: num(r.ts),
        kind: String(r.kind),
        path: String(r.path ?? ""),
        name: String(r.name ?? ""),
        country: String(r.country ?? ""),
        city: String(r.city ?? ""),
        source: String(r.source ?? ""),
        device: String(r.device ?? ""),
      })),
    };
  }
}

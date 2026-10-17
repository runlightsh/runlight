import { EVENT_TAIL_MS, SqlStore, clip, type Db, type EventRow, type GoalRow, type LinkRow, type SessionRow } from "../store.js";

export interface ClickHouseOptions {
  /**
   * An http:// or https:// URL with the user, password, and database, such as process.env.CLICKHOUSE_URL:
   * https://user:password@host:8443/runlight. The database is made if it is not there.
   */
  url: string;
  /** Where everything but the visits lives: sites, goals, links, settings, and the rest. */
  store: SqlStore;
  /**
   * The most queries sent to ClickHouse at once; the rest wait their turn. Default 4. A dashboard asks for
   * a dozen reports at once, and each can take a few hundred megabytes over a long range.
   */
  maxQueries?: number;
  /** The longest one query may run, in milliseconds. Default 120000. 0 means no limit. */
  queryTimeout?: number;
}

/** The fetch there was when Runlight loaded, so an app or a test that wraps the global one later cannot reach ClickHouse's requests. */
const ownFetch = globalThis.fetch.bind(globalThis);

/** A visit's first pageview, before it has had one: later than any, so the earliest real one wins. */
const NO_ENTRY = "9223372036854775807";

/** How many visits' keys are remembered, so a hit need not look its visit up. */
const KEYS_KEPT = 50_000;

/**
 * Runlight's visits and events in ClickHouse. Each hit adds a row of what changed (one more pageview,
 * when, on which page) and ClickHouse adds them up, so nothing is read before it is written, no count can
 * be lost, and any number of processes can share it. `rl_sessions` is a view over those rows, added up,
 * so reports read it as any other database's table. Events carry the start of their visit, so "the rows
 * of the visits that started in a range" is a range of the events themselves.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rl_meta ("key" String, value String, at Int64) ENGINE = ReplacingMergeTree(at) ORDER BY "key"`,
  `CREATE TABLE IF NOT EXISTS rl_visits (
    site LowCardinality(String), started_at Int64, id String, visitor String,
    last_at SimpleAggregateFunction(max, Int64),
    pageviews SimpleAggregateFunction(sum, Int64),
    events SimpleAggregateFunction(sum, Int64),
    engaged_ms SimpleAggregateFunction(sum, Int64),
    engaged_unknown SimpleAggregateFunction(max, UInt8),
    imported SimpleAggregateFunction(max, UInt8),
    entry SimpleAggregateFunction(min, Tuple(Int64, String)),
    exit SimpleAggregateFunction(max, Tuple(Int64, String)),
    hostname SimpleAggregateFunction(max, String), referrer_host SimpleAggregateFunction(max, String),
    referrer_path SimpleAggregateFunction(max, String), source SimpleAggregateFunction(max, String),
    channel SimpleAggregateFunction(max, String), utm_source SimpleAggregateFunction(max, String),
    utm_medium SimpleAggregateFunction(max, String), utm_campaign SimpleAggregateFunction(max, String),
    utm_term SimpleAggregateFunction(max, String), utm_content SimpleAggregateFunction(max, String),
    country SimpleAggregateFunction(max, String), region SimpleAggregateFunction(max, String),
    city SimpleAggregateFunction(max, String), browser SimpleAggregateFunction(max, String),
    browser_version SimpleAggregateFunction(max, String), os SimpleAggregateFunction(max, String),
    os_version SimpleAggregateFunction(max, String), device SimpleAggregateFunction(max, String),
    screen SimpleAggregateFunction(max, String), language SimpleAggregateFunction(max, String),
    INDEX id_index id TYPE bloom_filter GRANULARITY 4,
    INDEX visitor_index visitor TYPE bloom_filter GRANULARITY 4
  ) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(started_at)) ORDER BY (site, started_at, id)`,
  // Every visit as one row, as the other databases keep it. A visit's engaged time is unknown, rather than
  // none, when it was imported from a tool that kept none.
  `CREATE VIEW IF NOT EXISTS rl_sessions AS SELECT id, site, visitor, started_at, last_at, pageviews, events,
    if(engaged_unknown = 1, NULL, engaged_ms) AS engaged_ms, imported,
    if(entry.1 = ${NO_ENTRY}, '', entry.2) AS entry_path, exit.2 AS exit_path,
    hostname, referrer_host, referrer_path, source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
    country, region, city, browser, browser_version, os, os_version, device, screen, language
    FROM rl_visits FINAL`,
  `CREATE TABLE IF NOT EXISTS rl_events (
    id UInt64 DEFAULT generateSnowflakeID(), site LowCardinality(String), ts Int64, kind LowCardinality(String),
    visitor String, session String, started_at Int64, pageview String, path String, hostname String, title String,
    name String, props Nullable(String), engaged_ms Int64, scroll Nullable(Int32), link String,
    INDEX session_index session TYPE bloom_filter GRANULARITY 4,
    INDEX pageview_index pageview TYPE bloom_filter GRANULARITY 4,
    INDEX path_index path TYPE bloom_filter GRANULARITY 4,
    INDEX name_index name TYPE bloom_filter GRANULARITY 4,
    INDEX link_index link TYPE bloom_filter GRANULARITY 4
  ) ENGINE = MergeTree PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(ts)) ORDER BY (site, kind, ts)`,
];

/** The version of the tables above, kept in ClickHouse's own rl_meta. */
const SCHEMA_VERSION = 1;

/** A ClickHouse type for a value bound to a placeholder, and the value as ClickHouse reads a parameter. */
function typed(value: unknown): { type: string; text: string } {
  if (value === null || value === undefined) return { type: "Nullable(String)", text: "\\N" };
  if (typeof value === "bigint") return { type: "Int64", text: String(value) };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "Int64" : "Float64", text: String(value) };
  if (typeof value === "boolean") return { type: "Bool", text: value ? "true" : "false" };
  // Parameters are read escaped, as in tab-separated values.
  return { type: "String", text: String(value).replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r") };
}

/** `?` placeholders to ClickHouse's typed `{p0:Type}`, leaving quoted text alone, and the values to send. */
export function bindPlaceholders(sql: string, params: unknown[]): { sql: string; values: Record<string, string> } {
  let out = "";
  let n = 0;
  let quote: string | null = null;
  const values: Record<string, string> = {};
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      out += ch;
      if (ch === "\\") out += sql[++i] ?? "";
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
    } else if (ch === "?") {
      if (n >= params.length) throw new Error("Runlight: more placeholders than values in a ClickHouse query");
      const { type, text } = typed(params[n]);
      values[`p${n}`] = text;
      out += `{p${n}:${type}}`;
      n++;
    } else {
      out += ch;
    }
  }
  return { sql: out, values };
}

/** Lets at most `max` calls run at once; the rest wait in order. */
function limiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (fn) => {
    if (running >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** ClickHouse over HTTP, with what a ClickHouseStore needs beyond a Db: inserting rows, and its own settings. */
export interface ClickHouseDb extends Db {
  /** Inserts rows. `wait` waits until they can be read, which ingest needs; a copy sends big batches instead. */
  insert(table: string, rows: Array<Record<string, unknown>>, options?: { batched?: boolean }): Promise<void>;
  /** Makes the database named in the URL, if it is not there. */
  createDatabase(): Promise<void>;
  /** Drops the database named in the URL, and everything in it. */
  dropDatabase(): Promise<void>;
  readonly database: string;
}

/**
 * Settings every query runs with. With them, an aggregate over no rows is NULL and an outer join leaves
 * NULL where nothing matched, as in SQL, so the store's SQL reads the same here as anywhere.
 */
const SETTINGS: Record<string, string> = {
  aggregate_functions_null_for_empty: "1",
  join_use_nulls: "1",
  output_format_json_quote_64bit_integers: "0",
  output_format_json_quote_64bit_floats: "0",
  // A delete or a rename is done before the statement returns, as everywhere else.
  lightweight_deletes_sync: "2",
  mutations_sync: "2",
};

export function clickhouseDb(options: { url: string; maxQueries?: number; queryTimeout?: number }): ClickHouseDb {
  const url = new URL(options.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Runlight: CLICKHOUSE_URL should start http:// or https://");
  const database = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, "")) || "default";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) throw new Error("Runlight: the ClickHouse database name should be letters, digits, and underscores");
  const user = decodeURIComponent(url.username) || "default";
  const password = decodeURIComponent(url.password);
  const endpoint = `${url.protocol}//${url.host}/`;
  const timeout = options.queryTimeout ?? 120_000;
  const turn = limiter(Math.max(1, options.maxQueries ?? 4));

  async function send(body: string, params: Record<string, string>, inDatabase = true): Promise<string> {
    const search = new URLSearchParams({ ...SETTINGS, ...params });
    if (inDatabase) search.set("database", database);
    if (timeout > 0) search.set("max_execution_time", String(Math.ceil(timeout / 1000)));
    const response = await ownFetch(`${endpoint}?${search}`, {
      method: "POST",
      headers: { "X-ClickHouse-User": user, "X-ClickHouse-Key": password, "Content-Type": "text/plain; charset=utf-8" },
      body,
      signal: timeout > 0 ? AbortSignal.timeout(timeout + 5_000) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Runlight: ClickHouse said ${text.trim().split("\n")[0]}`);
    return text;
  }

  const query = (sql: string, params: unknown[], extra: Record<string, string> = {}) => {
    const bound = bindPlaceholders(sql, params);
    const values = Object.fromEntries(Object.entries(bound.values).map(([k, v]) => [`param_${k}`, v]));
    return turn(() => send(bound.sql, { ...values, ...extra }));
  };

  return {
    dialect: "clickhouse",
    database,
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const text = await query(sql, params, { default_format: "JSONEachRow" });
      return text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as T);
    },
    async run(sql: string, params: unknown[] = []): Promise<void> {
      await query(sql, params);
    },
    async insert(table, rows, opts = {}) {
      if (!rows.length) return;
      const body = `INSERT INTO ${table} FORMAT JSONEachRow\n${rows.map((row) => JSON.stringify(row)).join("\n")}`;
      // A hit at a time would make a part of the table for every row, which ClickHouse merges at great cost;
      // it batches them itself, and answers once the row can be read.
      const settings: Record<string, string> = opts.batched ? {} : { async_insert: "1", wait_for_async_insert: "1" };
      await send(body, settings);
    },
    async createDatabase() {
      await send(`CREATE DATABASE IF NOT EXISTS ${database}`, {}, false);
    },
    async dropDatabase() {
      await send(`DROP DATABASE IF EXISTS ${database}`, {}, false);
    },
  };
}

/** The columns of a visit's row that never change, which every row added to it carries. */
interface VisitKey {
  site: string;
  startedAt: number;
  visitor: string;
}

/**
 * A store whose visits and events are in ClickHouse, and everything else in another store, such as SQLite
 * or Postgres. Reports run the same SQL every store runs, on ClickHouse, through `visits`.
 */
export class ClickHouseStore extends SqlStore {
  override readonly keepsRollups = false;
  /** Reads the visits and events, with the SQL every store shares. */
  readonly visits: SqlStore;
  readonly clickhouse: ClickHouseDb;
  private readonly rows: SqlStore;
  private readonly keys: Map<string, VisitKey>;
  private schema: Promise<void> | null = null;

  constructor(rows: SqlStore, clickhouse: ClickHouseDb, keys: Map<string, VisitKey> = new Map()) {
    super(rows.db, rows.prefix);
    this.rows = rows;
    this.clickhouse = clickhouse;
    this.visits = new SqlStore(clickhouse);
    this.keys = keys;
  }

  /** The tables in the other store, then ClickHouse's. Safe to call any number of times. */
  override async migrate(): Promise<void> {
    await super.migrate();
    this.schema ??= (async () => {
      await this.clickhouse.createDatabase();
      for (const statement of SCHEMA) await this.clickhouse.run(statement);
      const [found] = await this.clickhouse.all<{ value: string }>(`SELECT argMax(value, at) AS value FROM rl_meta WHERE "key" = 'schema'`);
      if (found?.value !== String(SCHEMA_VERSION)) await this.clickhouse.insert("rl_meta", [{ key: "schema", value: String(SCHEMA_VERSION), at: Date.now() }], { batched: true });
    })().catch((error) => {
      this.schema = null;
      throw error;
    });
    return this.schema;
  }

  override async transaction<T>(fn: (store: SqlStore) => Promise<T>): Promise<T> {
    // The other store's statements are in a transaction; ClickHouse has none, and each write stands alone.
    return this.rows.transaction((rows) => fn(rows === this.rows ? this : new ClickHouseStore(rows, this.clickhouse, this.keys)));
  }

  /**
   * Merges the rows of the last two months' visits, which ClickHouse would otherwise leave for a while, so
   * reading them stays quick. Older months it merges by itself. The other store keeps its own statistics.
   */
  override async optimize(onlyWhenStale = false): Promise<void> {
    await super.optimize(onlyWhenStale);
    if (onlyWhenStale) return;
    try {
      const now = new Date();
      for (const back of [1, 0]) {
        const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
        const partition = month.getUTCFullYear() * 100 + month.getUTCMonth() + 1;
        await this.clickhouse.run(`OPTIMIZE TABLE rl_visits PARTITION ${partition} FINAL`);
      }
    } catch (error) {
      console.error("Runlight: could not merge the visits in ClickHouse", error);
    }
  }

  // Reports: the shared SQL, run on ClickHouse.

  override visitOpen(...a: Parameters<SqlStore["visitOpen"]>) {
    return this.visits.visitOpen(...a);
  }
  override lastSeen(...a: Parameters<SqlStore["lastSeen"]>) {
    return this.visits.lastSeen(...a);
  }
  override firstSeen(...a: Parameters<SqlStore["firstSeen"]>) {
    return this.visits.firstSeen(...a);
  }
  override firstOwnVisit(...a: Parameters<SqlStore["firstOwnVisit"]>) {
    return this.visits.firstOwnVisit(...a);
  }
  override visitors(...a: Parameters<SqlStore["visitors"]>) {
    return this.visits.visitors(...a);
  }
  override stats(...a: Parameters<SqlStore["stats"]>) {
    return this.visits.stats(...a);
  }
  override series(...a: Parameters<SqlStore["series"]>) {
    return this.visits.series(...a);
  }
  override breakdown(...a: Parameters<SqlStore["breakdown"]>) {
    return this.visits.breakdown(...a);
  }
  override hourly(...a: Parameters<SqlStore["hourly"]>) {
    return this.visits.hourly(...a);
  }
  override realtime(...a: Parameters<SqlStore["realtime"]>) {
    return this.visits.realtime(...a);
  }
  override hostnameSuggestions(...a: Parameters<SqlStore["hostnameSuggestions"]>) {
    return this.visits.hostnameSuggestions(...a);
  }
  override funnelCounts(...a: Parameters<SqlStore["funnelCounts"]>) {
    return this.visits.funnelCounts(...a);
  }
  override journeyPages(...a: Parameters<SqlStore["journeyPages"]>) {
    return this.visits.journeyPages(...a);
  }
  override goalTotalsAll(...a: Parameters<SqlStore["goalTotalsAll"]>) {
    return this.visits.goalTotalsAll(...a);
  }
  override goalTotals(...a: Parameters<SqlStore["goalTotals"]>) {
    return this.visits.goalTotals(...a);
  }
  override goalBreakdown(...a: Parameters<SqlStore["goalBreakdown"]>) {
    return this.visits.goalBreakdown(...a);
  }
  override goalSeries(...a: Parameters<SqlStore["goalSeries"]>) {
    return this.visits.goalSeries(...a);
  }
  override eventPropKeys(...a: Parameters<SqlStore["eventPropKeys"]>) {
    return this.visits.eventPropKeys(...a);
  }
  override eventPropValues(...a: Parameters<SqlStore["eventPropValues"]>) {
    return this.visits.eventPropValues(...a);
  }
  override linkSeries(...a: Parameters<SqlStore["linkSeries"]>) {
    return this.visits.linkSeries(...a);
  }
  override linkBreakdown(...a: Parameters<SqlStore["linkBreakdown"]>) {
    return this.visits.linkBreakdown(...a);
  }

  /** The links from the other store, their clicks from ClickHouse. */
  override async links(site: string, from: number, to: number): Promise<Array<LinkRow & { clicks: number; visitors: number }>> {
    const links = await super.links(site, 0, 0);
    if (!links.length) return links;
    const clicks = await this.clickhouse.all<{ link: string; clicks: unknown; visitors: unknown }>(
      `SELECT link, COUNT(*) AS clicks, COUNT(DISTINCT NULLIF(visitor, '')) AS visitors FROM rl_events
       WHERE site = ? AND kind = 'click' AND ts >= ? AND ts < ? GROUP BY link`,
      [site, from, to],
    );
    const by = new Map(clicks.map((c) => [String(c.link), c]));
    return links.map((link) => ({ ...link, clicks: Number(by.get(link.id)?.clicks ?? 0), visitors: Number(by.get(link.id)?.visitors ?? 0) }));
  }

  // Rollups: none to keep.

  override async rollupDays(): Promise<Set<string>> {
    return new Set();
  }
  override async buildRollupDay(): Promise<void> {}

  // Ingest

  /** Where a visit's rows go: its site, start, and visitor, remembered or looked up by its id. */
  private async key(id: string): Promise<VisitKey | null> {
    const known = this.keys.get(id);
    if (known) return known;
    const [row] = await this.clickhouse.all<{ site: string; started_at: unknown; visitor: string }>(
      `SELECT site, started_at, visitor FROM rl_visits WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!row) return null;
    return this.remember(id, { site: row.site, startedAt: Number(row.started_at), visitor: row.visitor });
  }

  private remember(id: string, key: VisitKey): VisitKey {
    this.keys.delete(id);
    this.keys.set(id, key);
    // The oldest goes first, so the visits still going stay.
    if (this.keys.size > KEYS_KEPT) this.keys.delete(this.keys.keys().next().value!);
    return key;
  }

  /** Adds a row to a visit: what changed, over a row of nothing. */
  private async add(id: string, change: Record<string, unknown>): Promise<void> {
    const key = await this.key(id);
    if (!key) return;
    await this.clickhouse.insert("rl_visits", [
      { site: key.site, started_at: key.startedAt, id, visitor: key.visitor, last_at: key.startedAt, entry: [NO_ENTRY, ""], exit: [0, ""], ...change },
    ]);
  }

  override async openSession(site: string, visitors: string[], since: number): Promise<{ id: string; visitor: string } | null> {
    if (visitors.length === 0) return null;
    // A visit still going started within EVENT_TAIL_MS, which keeps the read to the newest days.
    const rows = await this.clickhouse.all<{ id: string; visitor: string; started_at: unknown }>(
      `SELECT id, visitor, started_at FROM rl_sessions WHERE site = ? AND started_at >= ? AND visitor IN (${visitors.map(() => "?").join(", ")}) AND last_at >= ?
       ORDER BY last_at DESC, id LIMIT 1`,
      [site, since - EVENT_TAIL_MS, ...visitors, since],
    );
    const row = rows[0];
    if (!row) return null;
    this.remember(row.id, { site, startedAt: Number(row.started_at), visitor: row.visitor });
    return { id: row.id, visitor: row.visitor };
  }

  override async settleOpenSession(site: string, visitors: string[], since: number, opened: { id: string; visitor: string }): Promise<{ id: string; visitor: string }> {
    const rows = await this.clickhouse.all<{ id: string; visitor: string; started_at: unknown }>(
      `SELECT id, visitor, started_at FROM rl_sessions WHERE site = ? AND started_at >= ? AND visitor IN (${visitors.map(() => "?").join(", ")}) AND last_at >= ?
       ORDER BY CASE WHEN pageviews > 0 OR events > 0 THEN 0 ELSE 1 END, started_at, id LIMIT 1`,
      [site, since - EVENT_TAIL_MS, ...visitors, since],
    );
    const first = rows[0];
    if (!first || first.id === opened.id) return opened;
    this.remember(first.id, { site, startedAt: Number(first.started_at), visitor: first.visitor });
    // The one opened here goes, unless something was counted into it meanwhile.
    const [mine] = await this.clickhouse.all<{ n: unknown }>(`SELECT pageviews + events AS n FROM rl_sessions WHERE site = ? AND started_at >= ? AND id = ?`, [site, since - EVENT_TAIL_MS, opened.id]);
    if (mine && Number(mine.n) === 0) await this.deleteSession(opened.id);
    return { id: first.id, visitor: first.visitor };
  }

  override async insertSession(row: SessionRow): Promise<void> {
    const c = clip;
    this.remember(row.id, { site: row.site, startedAt: row.startedAt, visitor: row.visitor });
    // Each text cut as the other databases cut it, so every database keeps the same.
    await this.clickhouse.insert("rl_visits", [
      {
        site: row.site, started_at: row.startedAt, id: row.id, visitor: row.visitor, last_at: row.startedAt,
        pageviews: 0, events: 0, engaged_ms: 0, engaged_unknown: 0, imported: 0, entry: [NO_ENTRY, ""], exit: [0, ""],
        hostname: c(row.hostname, 255), referrer_host: c(row.referrerHost, 255), referrer_path: c(row.referrerPath, 500),
        source: c(row.source, 200), channel: c(row.channel, 100), utm_source: c(row.utmSource, 200), utm_medium: c(row.utmMedium, 200),
        utm_campaign: c(row.utmCampaign, 200), utm_term: c(row.utmTerm, 200), utm_content: c(row.utmContent, 200),
        country: c(row.country, 16), region: c(row.region, 100), city: c(row.city, 100), browser: c(row.browser, 100),
        browser_version: c(row.browserVersion, 100), os: c(row.os, 100), os_version: c(row.osVersion, 100), device: c(row.device, 50),
        screen: c(row.screen, 50), language: c(row.language, 50),
      },
    ]);
  }

  override async touchSession(id: string, ts: number, kind: "pageview" | "event" | "click", path: string, reopen = true): Promise<void> {
    if (kind === "click") return this.add(id, { last_at: ts });
    if (kind === "pageview") {
      const page = [ts, clip(path, 1000)];
      return this.add(id, { pageviews: 1, last_at: ts, entry: page, exit: page });
    }
    return this.add(id, reopen ? { events: 1, last_at: ts } : { events: 1 });
  }

  override async addEngagement(id: string, ms: number): Promise<void> {
    await this.add(id, { engaged_ms: ms });
  }

  override async pageview(site: string, pageview: string): ReturnType<SqlStore["pageview"]> {
    // The pageview first, then its visit by the start it carries, which ClickHouse finds by its sort order.
    const [row] = await this.clickhouse.all<Record<string, unknown>>(
      `SELECT session, visitor, path, hostname, ts, started_at FROM rl_events WHERE site = ? AND kind = 'pageview' AND pageview = ? LIMIT 1`,
      [site, pageview],
    );
    if (!row) return null;
    const startedAt = Number(row.started_at);
    const [visit] = await this.clickhouse.all<{ last_at: unknown; visitor: string }>(
      `SELECT last_at, visitor FROM rl_sessions WHERE site = ? AND started_at = ? AND id = ?`,
      [site, startedAt, String(row.session)],
    );
    if (!visit) return null;
    this.remember(String(row.session), { site, startedAt, visitor: visit.visitor });
    return {
      session: String(row.session),
      visitor: String(row.visitor),
      path: String(row.path),
      hostname: String(row.hostname),
      ts: Number(row.ts),
      startedAt,
      lastAt: Number(visit.last_at),
    };
  }

  override async insertEvent(row: EventRow): Promise<void> {
    const key = row.session ? await this.key(row.session) : null;
    await this.clickhouse.insert("rl_events", [
      {
        site: row.site, ts: row.ts, kind: row.kind, visitor: row.visitor, session: row.session, started_at: key?.startedAt ?? 0,
        pageview: row.pageview, path: clip(row.path, 1000), hostname: clip(row.hostname, 255), title: clip(row.title, 500),
        name: clip(row.name, 255), props: row.props ? JSON.stringify(row.props) : null, engaged_ms: row.engagedMs, scroll: row.scroll, link: row.link,
      },
    ]);
  }

  // Imports

  override async deleteSession(id: string): Promise<void> {
    this.keys.delete(id);
    await this.clickhouse.run(`DELETE FROM rl_visits WHERE id = ?`, [id]);
  }

  override async markImported(id: string, unknownEngagement: boolean): Promise<void> {
    await this.add(id, { imported: 1, engaged_unknown: unknownEngagement ? 1 : 0 });
  }

  override async deleteLinkHistory(link: string): Promise<void> {
    await this.clickhouse.run(`DELETE FROM rl_visits WHERE id IN (SELECT DISTINCT session FROM rl_events WHERE link = ? AND session <> '')`, [link]);
    await this.clickhouse.run(`DELETE FROM rl_events WHERE link = ?`, [link]);
    this.keys.clear();
  }

  override async clearImportedVisits(site: string, from: number, to: number): Promise<void> {
    const imported = `SELECT id FROM rl_sessions WHERE site = ? AND imported = 1`;
    await this.clickhouse.run(`DELETE FROM rl_events WHERE site = ? AND ts >= ? AND ts < ? AND kind IN ('pageview', 'event') AND session IN (${imported})`, [site, from, to, site]);
    await this.clickhouse.run(
      `DELETE FROM rl_visits WHERE site = ? AND started_at >= ? AND started_at < ? AND id IN (${imported})
         AND id NOT IN (SELECT e.session FROM rl_events e WHERE e.site = ? AND e.ts >= ? AND e.ts < ?)`,
      [site, from - EVENT_TAIL_MS, to, site, site, from - EVENT_TAIL_MS, to + EVENT_TAIL_MS],
    );
    this.keys.clear();
  }

  override async recountCarriedVisits(site: string, from: number, to: number): Promise<void> {
    const carried = await this.clickhouse.all<Record<string, unknown>>(
      `SELECT * FROM rl_sessions s WHERE s.site = ? AND s.imported = 1 AND s.started_at < ? AND s.started_at >= ?
         AND s.id IN (SELECT e.session FROM rl_events e WHERE e.site = ? AND e.ts >= ? AND e.ts < ?)`,
      [site, from, from - EVENT_TAIL_MS, site, from, to],
    );
    if (!carried.length) return;
    const ids = carried.map((c) => String(c.id));
    const rows = await this.clickhouse.all<{ session: string; kind: string; ts: unknown; path: string }>(
      `SELECT session, kind, ts, path FROM rl_events WHERE site = ? AND ts >= ? AND ts < ? AND kind IN ('pageview', 'event') AND session IN (${ids.map(() => "?").join(", ")})`,
      [site, Math.min(...carried.map((c) => Number(c.started_at))), to, ...ids],
    );
    const totals = new Map<string, { pageviews: number; events: number; last: number; exit: [number, string] }>();
    for (const r of rows) {
      const t = totals.get(r.session) ?? { pageviews: 0, events: 0, last: 0, exit: [0, ""] };
      if (r.kind === "pageview") {
        t.pageviews++;
        if (Number(r.ts) >= t.exit[0]) t.exit = [Number(r.ts), r.path];
      } else t.events++;
      t.last = Math.max(t.last, Number(r.ts));
      totals.set(r.session, t);
    }
    // Each visit is written again whole, as one row, in place of the rows it had.
    for (const visit of carried) {
      const id = String(visit.id);
      const t = totals.get(id);
      if (!t) continue;
      const [entry] = await this.clickhouse.all<{ ts: unknown; path: string }>(`SELECT entry.1 AS ts, entry.2 AS path FROM rl_visits FINAL WHERE site = ? AND started_at = ? AND id = ?`, [
        site,
        Number(visit.started_at),
        id,
      ]);
      await this.clickhouse.run(`DELETE FROM rl_visits WHERE site = ? AND started_at = ? AND id = ?`, [site, Number(visit.started_at), id]);
      const { entry_path: _entry, exit_path: _exit, engaged_ms, ...rest } = visit;
      await this.clickhouse.insert("rl_visits", [
        {
          ...rest,
          pageviews: t.pageviews,
          events: t.events,
          last_at: t.last,
          engaged_ms: Number(engaged_ms ?? 0),
          engaged_unknown: engaged_ms === null ? 1 : 0,
          entry: entry ? [String(entry.ts), entry.path] : [NO_ENTRY, ""],
          exit: t.pageviews ? t.exit : [0, String(_exit ?? "")],
        },
      ]);
    }
  }

  // Deletes

  /** A site's visits and events go from ClickHouse, then everything else from the other store. */
  override async deleteSite(id: string): Promise<void> {
    await this.clickhouse.run(`DELETE FROM rl_events WHERE site = ?`, [id]);
    await this.clickhouse.run(`DELETE FROM rl_visits WHERE site = ?`, [id]);
    this.keys.clear();
    await super.deleteSite(id);
  }

  /** A visit's events go with it, even ones after the cutoff, so nothing is left without its visit. */
  override async dropBefore(site: string, ts: number): Promise<void> {
    await this.clickhouse.run(`DELETE FROM rl_events WHERE site = ? AND (ts < ? OR (session <> '' AND started_at < ?))`, [site, ts, ts]);
    await this.clickhouse.run(`DELETE FROM rl_visits WHERE site = ? AND started_at < ?`, [site, ts]);
    this.keys.clear();
  }

  override async dropOrphans(site: string, from: number, until: number): Promise<void> {
    await this.clickhouse.run(
      `DELETE FROM rl_events WHERE site = ? AND ts >= ? AND ts < ? AND session <> '' AND session NOT IN (SELECT id FROM rl_visits WHERE site = ?)`,
      [site, from, until, site],
    );
  }

  /** A click goal renamed takes its past clicks with it, which are in ClickHouse. */
  override async saveGoal(g: GoalRow, before?: GoalRow): Promise<void> {
    await super.saveGoal(g, before);
    if (before?.kind === "click" && g.kind === "click" && before.name !== g.name) {
      await this.clickhouse.run(`ALTER TABLE rl_events UPDATE name = ? WHERE site = ? AND kind = 'event' AND name = ?`, [g.name, g.site, before.name]);
    }
  }
}

/**
 * Runlight's visits and events in ClickHouse, and everything else in `store`, such as SQLite or Postgres.
 * Worth it past a few million visits a month, or for reports filtered over long ranges.
 */
export function clickhouse(options: ClickHouseOptions): ClickHouseStore {
  return new ClickHouseStore(options.store, clickhouseDb(options));
}

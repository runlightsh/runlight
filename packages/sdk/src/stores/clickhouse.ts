import { publicAddress } from "../safefetch.js";
import { CARRIED_COLUMNS, EVENT_TAIL_MS, SqlStore, clip, type Db, type EventRow, type GoalRow, type LinkRow, type SessionRow } from "../store.js";

export interface ClickHouseOptions {
  /**
   * An http:// or https:// URL with the user, password, and database, such as process.env.CLICKHOUSE_URL:
   * https://user:password@host:8443/runlight. The database is made if it is not there.
   */
  url: string;
  /** Where everything but the visits lives: sites, goals, links, settings, and the rest. */
  store: SqlStore;
  /**
   * The most queries sent to ClickHouse at once; the rest wait their turn. Default 2. A dashboard asks for
   * a dozen reports at once, and over a year of 10 million visits the biggest take 3 GB each, so two at a
   * time fit in 8 GB, and open the dashboard sooner than four that fight over the memory.
   */
  maxQueries?: number;
  /** The longest one query may run, in milliseconds. Default 120000. 0 means no limit. */
  queryTimeout?: number;
  /**
   * Copies the visits `store` already holds into ClickHouse in the background, newest first. Default true.
   * The visits of the last two days are copied before the store is ready either way, so a visit going on
   * when ClickHouse took over carries on. False leaves the rest for `copy()`, as the server's `clickhouse
   * copy` command runs it.
   */
  copyInBackground?: boolean;
}

/** How far copying the other store's visits into ClickHouse has got. */
export interface MoveState {
  /** When ClickHouse took over. The other store holds every visit that started before it. */
  at: number;
  /** Every visit that started from here until `at` is in ClickHouse. */
  through: number;
  done: boolean;
  /**
   * Set while `copyBack()` runs: "copying" until the other store holds everything, then "copied" until
   * ClickHouse is emptied, so a copy back stopped part way can be run again without losing a visit.
   */
  back?: "copying" | "copied";
}

/** The fetch there was when Runlight loaded, so an app or a test that wraps the global one later cannot reach ClickHouse's requests. */
const ownFetch = globalThis.fetch.bind(globalThis);

/** A visit's first pageview, before it has had one: later than any, so the earliest real one wins. */
const NO_ENTRY = "9223372036854775807";

/** How many visits' keys are remembered, so a hit need not look its visit up. */
const KEYS_KEPT = 50_000;

/**
 * The visits a hit can still reach: one that began up to EVENT_TAIL_MS ago and was active in the last
 * half hour. They are copied first, before any hit is counted, and no hit reaches an older one.
 */
const RECENT_MS = EVENT_TAIL_MS + 30 * 60_000;

/** How many rows are read from one store and written to the other at a time. */
const COPY_BATCH = 5_000;

/** How many times in a row a piece of the copy may fail, a second's pause doubling each time up to five minutes, before the copy stops. */
const COPY_TRIES = 10;

/** How long one process's claim on the copy lasts, unless it renews it. */
const LEASE_MS = 120_000;

/** How often the copying process renews its claim, well inside LEASE_MS, whatever its queries are doing. */
const RENEW_MS = 20_000;

/** The setting in the other store that says which process is copying. */
const LEASE_KEY = "clickhouse-copy";

/** The setting that says which process is sending the hits that waited for ClickHouse. */
const WAITING_KEY = "clickhouse-waiting";

/**
 * An event copied from the other store has its row id there with the top bit set, where ClickHouse's own
 * ids (Snowflake ids) never have it. So a piece of the copy tried again clears what the copy wrote, and
 * leaves alone an event a hit wrote into the same days meanwhile, such as an AI fetch read from a log.
 */
const COPIED_ID = 1n << 63n;

/** How often a store taking hits says so in ClickHouse, and how long after its last word it counts as gone. */
const LIVE_EVERY_MS = 30_000;
const LIVE_FOR_MS = 90_000;

/** The text columns of a visit, alike in both stores. */
const VISIT_TEXT = [
  "hostname", "referrer_host", "referrer_path", "source", "channel", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "country", "region", "city", "browser", "browser_version", "os", "os_version", "device", "screen", "language",
] as const;

/** A ClickHouse event's copy of its visit's column (see CARRIED_COLUMNS), and its type: few values each, but for two of the campaign tags. */
const carried = (col: string) => `visit_${col}`;
const CARRIED_TYPES = CARRIED_COLUMNS.map((col) => `${carried(col)} ${col === "utm_term" || col === "utm_content" ? "String" : "LowCardinality(String)"}`);

/** The columns of an event, alike in both stores. */
const EVENT_COLUMNS = ["site", "ts", "kind", "visitor", "session", "pageview", "path", "hostname", "title", "name", "props", "engaged_ms", "scroll", "link"] as const;

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v));
// Whole numbers, as ClickHouse's columns take them, so one odd row cannot stop a copy.
const int = (v: unknown) => Math.trunc(Number(v ?? 0));

/** A visit from the other store as one row of ClickHouse's: all of it at once, as if every hit were in. */
function visitFrom(r: Record<string, unknown>): Record<string, unknown> {
  const startedAt = int(r.started_at);
  const lastAt = int(r.last_at);
  return {
    site: text(r.site), started_at: startedAt, id: text(r.id), visitor: text(r.visitor), last_at: lastAt,
    pageviews: int(r.pageviews), events: int(r.events), engaged_ms: int(r.engaged_ms), engaged_unknown: r.engaged_ms === null || r.engaged_ms === undefined ? 1 : 0,
    imported: int(r.imported) ? 1 : 0,
    // The first page was seen when the visit began and the last when it was last active, which is as
    // early and as late as any hit after the copy can be.
    entry: text(r.entry_path) ? [startedAt, text(r.entry_path)] : [NO_ENTRY, ""],
    exit: text(r.exit_path) ? [lastAt, text(r.exit_path)] : [0, ""],
    ...Object.fromEntries(VISIT_TEXT.map((col) => [col, text(r[col])])),
  };
}

/** An event from the other store, with the start of its visit, or 0 when it has none, as ingest writes it. */
function eventFrom(r: Record<string, unknown>): Record<string, unknown> {
  return {
    // As text: the id is past what a JavaScript number holds exactly.
    id: String(COPIED_ID + BigInt(int(r.row_id))),
    site: text(r.site), ts: int(r.ts), kind: text(r.kind), visitor: text(r.visitor), session: text(r.session),
    started_at: r.visit_started === null || r.visit_started === undefined ? 0 : int(r.visit_started),
    pageview: text(r.pageview), path: text(r.path), hostname: text(r.hostname), title: text(r.title), name: text(r.name),
    props: r.props === null || r.props === undefined ? null : String(r.props), engaged_ms: int(r.engaged_ms),
    scroll: r.scroll === null || r.scroll === undefined ? null : int(r.scroll), link: text(r.link),
    ...Object.fromEntries(CARRIED_COLUMNS.map((col) => [carried(col), text(r[carried(col)])])),
  };
}

/**
 * Runlight's visits and events in ClickHouse. Each hit adds a row of what changed (one more pageview,
 * when, on which page) and ClickHouse adds them up, so nothing is read before it is written, no count can
 * be lost, and any number of processes can share it. `rl_sessions` is a view over those rows, added up,
 * so reports read it as any other database's table. Events carry the start of their visit and the columns
 * that never change after it began, so "the rows of the Organic Search visits that started in a range" is
 * a range of the events themselves, with no list of millions of visits to hold.
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
    ${CARRIED_TYPES.join(", ")},
    INDEX session_index session TYPE bloom_filter GRANULARITY 4,
    INDEX pageview_index pageview TYPE bloom_filter GRANULARITY 4,
    INDEX path_index path TYPE bloom_filter GRANULARITY 4,
    INDEX name_index name TYPE bloom_filter GRANULARITY 4,
    INDEX link_index link TYPE bloom_filter GRANULARITY 4
  ) ENGINE = MergeTree PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(ts)) ORDER BY (site, kind, ts)`,
];

/** The version of the tables above, kept in ClickHouse's own rl_meta. 2 added the visits' columns to the events. */
const SCHEMA_VERSION = 2;

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

/** What a lane of queries turns away, as a busy database does, so a hit is tried again a moment later. */
const BUSY = "Runlight: ClickHouse is busy";

/**
 * Lets at most `max` calls run at once; the rest wait in order, at most `queue` of them and for at most
 * `wait` ms (0 for no limit), so a ClickHouse that has slowed down cannot pile up work without end.
 */
export function limiter(max: number, queue: number, wait: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (fn) => {
    if (running >= max) {
      if (waiting.length >= queue) throw new Error(`${BUSY}: ${queue} queries are waiting`);
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer =
          wait > 0
            ? setTimeout(() => {
                waiting.splice(waiting.indexOf(go), 1);
                reject(new Error(`${BUSY}: a query waited ${Math.round(wait / 1000)} s for its turn`));
              }, wait)
            : undefined;
        waiting.push(go);
      });
    }
    running++;
    try {
      return await fn();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/** The longest a hit's own read may run, in milliseconds: one taking longer is better given up and tried again. */
const LOOKUP_TIMEOUT_MS = 10_000;

/** The ClickHouse error codes worth sending again: too many queries at once, and the server going away. */
const AGAIN_CODES = /^Code: (202|209|210)\b/;

/** True when a request never reached ClickHouse, or ClickHouse turned it away before running it. */
function transient(error: unknown): boolean {
  const code = ((error as { cause?: { code?: string } })?.cause?.code ?? "") as string;
  if (/^(ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED)$/.test(code)) return true;
  return error instanceof ClickHouseError && AGAIN_CODES.test(error.reply);
}

/** An answer from ClickHouse that was an error, with the first line of what it said. */
class ClickHouseError extends Error {
  constructor(readonly reply: string) {
    super(`Runlight: ClickHouse said ${reply}`);
  }
}

/** ClickHouse over HTTP, with what a ClickHouseStore needs beyond a Db: inserting rows, and its own settings. */
export interface ClickHouseDb extends Db {
  /**
   * Inserts rows. A hit's rows are gathered with others for a moment and sent together, and answer once
   * they can be read, which ingest needs; `batched` sends a copy's big batches at once instead.
   */
  insert(table: string, rows: Array<Record<string, unknown>>, options?: { batched?: boolean }): Promise<void>;
  /** As `all`, without waiting behind reports for a turn: for the small reads a hit makes, so it is counted at once. At most 64 run at a time. */
  lookup<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /**
   * A DELETE or ALTER ... UPDATE over a big table: ClickHouse runs it in the background and this waits for it
   * to finish, however long it takes, where `run` would give up after the query timeout.
   */
  mutate(table: string, sql: string, params?: unknown[]): Promise<void>;
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
  // A visit's rows all fall in the month it started, so each month's are added up apart, and sooner.
  do_not_merge_across_partitions_select_final: "1",
  // Visitors and visits are counted exactly up to about 4,000, and to within about 1% beyond, in a
  // fraction of the memory: an exact count of a year's visitors per page needs gigabytes at 10 million visits.
  count_distinct_implementation: "uniqCombined64",
};

/**
 * True for an http:// URL to a host that may be across the internet, where the password would go unencrypted:
 * a public address, or a name with a dot in it that is not a private network's. Not for localhost, a private
 * address, or a one-word name such as a Docker Compose service's.
 */
export function plainAcross(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (/^[\d.]+$/.test(host) || host.includes(":")) return publicAddress(host);
  return host.includes(".") && !/(^|\.)(localhost|local|internal|lan|home\.arpa|localdomain)$/.test(host);
}

export function clickhouseDb(options: { url: string; maxQueries?: number; queryTimeout?: number }): ClickHouseDb {
  const url = new URL(options.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Runlight: CLICKHOUSE_URL should start http:// or https://");
  if (plainAcross(url)) {
    console.warn(`Runlight: ClickHouse is reached over http://, so its password goes unencrypted to ${url.hostname} with every request. Use https:// unless it is on a private network.`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, "")) || "default";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) throw new Error("Runlight: the ClickHouse database name should be letters, digits, and underscores");
  const user = decodeURIComponent(url.username) || "default";
  const password = decodeURIComponent(url.password);
  const endpoint = `${url.protocol}//${url.host}/`;
  const timeout = options.queryTimeout ?? 120_000;
  const turn = limiter(Math.max(1, options.maxQueries ?? 2), 1_000, timeout);
  // A hit's reads skip the reports' line but have one of their own, so a flood of hits waits here rather than
  // passing ClickHouse's limit of queries at once, where it would turn them away.
  // The wait is what bounds it, at the hits of so many seconds; the count only stops a burst far past that.
  const quick = limiter(64, 20_000, LOOKUP_TIMEOUT_MS);
  // Inserts have a line of their own too, so a slow ClickHouse cannot be sent a request per hit without end.
  const writes = limiter(32, 20_000, 30_000);

  /** One request. `limit` is the query's own timeout, in ms; 0 for none. */
  async function sendOnce(body: string, params: Record<string, string>, inDatabase: boolean, limit: number): Promise<string> {
    const search = new URLSearchParams({ ...SETTINGS, ...params });
    if (inDatabase) search.set("database", database);
    if (limit > 0) search.set("max_execution_time", String(Math.ceil(limit / 1000)));
    let response: Response;
    try {
      response = await ownFetch(`${endpoint}?${search}`, {
        method: "POST",
        headers: { "X-ClickHouse-User": user, "X-ClickHouse-Key": password, "Content-Type": "text/plain; charset=utf-8" },
        body,
        signal: limit > 0 ? AbortSignal.timeout(limit + 5_000) : undefined,
      });
    } catch (error) {
      if ((error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError") throw error;
      // "fetch failed" says nothing; the reason is in its cause, such as ECONNREFUSED.
      const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
      throw new Error(`Runlight: could not reach ClickHouse at ${url.host} (${cause?.code ?? cause?.message ?? String(error)})`, { cause });
    }
    const text = await response.text();
    if (!response.ok) throw new ClickHouseError(text.trim().split("\n")[0] ?? "");
    return text;
  }

  /** A request, sent again after a pause when it never reached ClickHouse or ClickHouse turned it away unrun. */
  async function send(body: string, params: Record<string, string>, inDatabase = true, limit = timeout): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await sendOnce(body, params, inDatabase, limit);
      } catch (error) {
        if (attempt >= 3 || !transient(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * 3 ** (attempt - 1)));
      }
    }
  }

  const bind = (sql: string, params: unknown[]) => {
    const bound = bindPlaceholders(sql, params);
    return { sql: bound.sql, values: Object.fromEntries(Object.entries(bound.values).map(([k, v]) => [`param_${k}`, v])) };
  };
  // A read stops in ClickHouse as well when its request is given up, rather than running on unseen.
  const READ = { default_format: "JSONEachRow", cancel_http_readonly_queries_on_client_close: "1" };
  const parsed = <T,>(text: string): T[] =>
    text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const row = JSON.parse(line) as T & { exception?: string };
        // An error after the first rows went out comes at the end of a 200 answer, as a row of its own.
        if (row && typeof row === "object" && typeof row.exception === "string" && Object.keys(row).length === 1) throw new ClickHouseError(row.exception);
        return row;
      });

  /** Whether this user can see system.mutations, to wait for a change to finish there. Asked once. */
  let watchable: Promise<boolean> | null = null;

  // A hit's rows, gathered per table for a moment and sent as one insert, so ClickHouse gets a request for
  // many hits rather than one for each, and each hit's row can still be read once its insert answers. A
  // batch waiting for its turn in the inserts' line takes more rows meanwhile, so it grows as ClickHouse slows.
  type Batch = { rows: string[]; done: Array<{ resolve: () => void; reject: (error: unknown) => void }>; queued: boolean };
  const gathering = new Map<string, Batch>();
  const sendGathered = (table: string, batch: Batch) => {
    if (batch.queued) return;
    batch.queued = true;
    writes(() => {
      // From here on the batch is closed: rows that come now start the next one.
      if (gathering.get(table) === batch) gathering.delete(table);
      // Each batch is its own, so one sent again after a dropped connection is not counted twice where
      // ClickHouse deduplicates (replicated tables, and ClickHouse Cloud).
      const settings = { async_insert: "1", wait_for_async_insert: "1", async_insert_deduplicate: "1", insert_deduplication_token: crypto.randomUUID() };
      return send(`INSERT INTO ${table} FORMAT JSONEachRow\n${batch.rows.join("\n")}`, settings);
    }).then(
      () => {
        for (const d of batch.done) d.resolve();
      },
      (error) => {
        if (gathering.get(table) === batch) gathering.delete(table);
        for (const d of batch.done) d.reject(error);
      },
    );
  };

  return {
    dialect: "clickhouse",
    database,
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const q = bind(sql, params);
      return parsed<T>(await turn(() => send(q.sql, { ...q.values, ...READ })));
    },
    async lookup<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const q = bind(sql, params);
      return parsed<T>(await quick(() => send(q.sql, { ...q.values, ...READ }, true, LOOKUP_TIMEOUT_MS)));
    },
    async run(sql: string, params: unknown[] = []): Promise<void> {
      const q = bind(sql, params);
      await turn(() => send(q.sql, q.values));
    },
    async mutate(table: string, sql: string, params: unknown[] = []): Promise<void> {
      const q = bind(sql, params);
      // A user granted only its own database cannot see system.mutations, so waits in the request instead,
      // as far as the request's own limits allow.
      watchable ??= send(`SELECT 1 FROM system.mutations LIMIT 0`, READ, true, LOOKUP_TIMEOUT_MS).then(
        () => true,
        () => false,
      );
      if (!(await watchable)) return void (await turn(() => send(q.sql, q.values, true, 0)));
      await turn(() => send(q.sql, { ...q.values, lightweight_deletes_sync: "0", mutations_sync: "0" }));
      // Done once no change to the table is left to run. A change that keeps failing says why.
      for (let wait = 100; ; wait = Math.min(wait * 2, 2_000)) {
        const [left] = parsed<{ n: unknown; reason: string }>(
          await quick(() =>
            send(`SELECT count() AS n, any(latest_fail_reason) AS reason FROM system.mutations WHERE database = {d:String} AND table = {t:String} AND NOT is_done`, { param_d: database, param_t: table, ...READ }, true, LOOKUP_TIMEOUT_MS),
          ),
        );
        if (!Number(left?.n)) return;
        if (left?.reason) throw new Error(`Runlight: ClickHouse could not change ${table}: ${left.reason.split("\n")[0]}`);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    },
    async insert(table, rows, opts = {}) {
      if (!rows.length) return;
      const lines = rows.map((row) => JSON.stringify(row));
      if (opts.batched) {
        // Sent again after a dropped connection, the same rows must go in; ClickHouse Cloud would otherwise
        // drop a block it saw before, such as a piece of the copy tried a second time.
        await writes(() => send(`INSERT INTO ${table} FORMAT JSONEachRow\n${lines.join("\n")}`, { insert_deduplicate: "0" }));
        return;
      }
      await new Promise<void>((resolve, reject) => {
        let batch = gathering.get(table);
        if (!batch || batch.rows.length >= 5_000) {
          const fresh: Batch = { rows: [], done: [], queued: false };
          batch = fresh;
          gathering.set(table, fresh);
          setTimeout(() => sendGathered(table, fresh), 5);
        }
        batch.rows.push(...lines);
        batch.done.push({ resolve, reject });
      });
    },
    async createDatabase() {
      // A user given only its own database cannot create one, so it is only made when it is not there.
      const [found] = parsed(await send(`SELECT 1 AS x FROM system.databases WHERE name = {d:String}`, { param_d: database, ...READ }, false));
      if (!found) await send(`CREATE DATABASE IF NOT EXISTS ${database}`, {}, false);
    },
    async dropDatabase() {
      await send(`DROP DATABASE IF EXISTS ${database}`, {}, false);
    },
  };
}

/**
 * Past about 4,000, visitors are an estimate and visits an exact count, so a range of one-visit visitors could
 * show a few more visitors than visits. A visitor has at least one visit, pageview, event, or conversion, so
 * the estimate is held to that count.
 */
function capped<T extends { visitors: number; visits?: number; pageviews?: number; events?: number; conversions?: number }>(row: T): T {
  const most = row.visits ?? row.conversions ?? row.pageviews ?? row.events;
  return most !== undefined && row.visitors > most ? { ...row, visitors: most } : row;
}

/** The columns of a visit's row that never change, which every row added to it carries. */
interface VisitKey {
  site: string;
  startedAt: number;
  visitor: string;
  /** The visit's columns its events carry, as `visit_<column>`. */
  carried: Record<string, string>;
}

/** The carried columns of a visit's row, or of a SessionRow's names for them, as its events take them. */
function carriedOf(row: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(CARRIED_COLUMNS.map((col) => [carried(col), text(row[col])]));
}

/**
 * A store whose visits and events are in ClickHouse, and everything else in another store, such as SQLite
 * or Postgres. Reports run the same SQL every store runs, on ClickHouse, through `visits`.
 */
export class ClickHouseStore extends SqlStore {
  override readonly keepsRollups = false;
  override readonly keepsWaiting = true;
  /** Reads the visits and events, with the SQL every store shares. */
  readonly visits: SqlStore;
  readonly clickhouse: ClickHouseDb;
  private readonly rows: SqlStore;
  protected readonly keys: Map<string, VisitKey>;
  private schema: Promise<void> | null = null;
  private readonly background: boolean;
  /** The copy running in the background, if one is. */
  private copying: Promise<void> | null = null;
  private closed = false;
  /** Wakes the background copy from its wait, so closing need not wait it out. */
  private wake: (() => void) | null = null;
  /** Who this process is, in the claim on the copy, and the claim as last written. */
  private readonly owner = crypto.randomUUID();
  private claimed: string | null = null;
  /** This process's claim on sending the waiting hits, as last written. */
  private sending: string | null = null;
  /** The claim being written, so the next waits for it. */
  private claims: Promise<boolean> = Promise.resolve(true);
  /** Set when this process finds another has taken the copy over, so it stops before writing more. */
  private lost = false;
  private metaAt = 0;
  /** Says now and then that this store is taking hits, so copy --back can tell a server is still running. */
  private live: ReturnType<typeof setInterval> | null = null;
  /** Once the copy is done it stays done, so the dashboard need not ask ClickHouse on every load. */
  private moved = false;

  constructor(rows: SqlStore, clickhouse: ClickHouseDb, keys: Map<string, VisitKey> = new Map(), copyInBackground = false) {
    super(rows.db, rows.prefix);
    this.rows = rows;
    this.clickhouse = clickhouse;
    this.visits = new SqlStore(clickhouse);
    this.keys = keys;
    this.background = copyInBackground;
  }

  /**
   * The tables in the other store, then ClickHouse's. Safe to call any number of times. When the other store
   * has visits and ClickHouse none, it starts copying them: the last two days now, the rest after.
   */
  override async migrate(): Promise<void> {
    await super.migrate();
    await this.makeWaiting();
    this.schema ??= (async () => {
      await this.clickhouse.createDatabase();
      for (const statement of SCHEMA) await this.clickhouse.run(statement);
      const version = await this.meta("schema");
      if (version === "1") {
        // Events written before carry no visit columns, so reports read them through their visits as before.
        for (const type of CARRIED_TYPES) await this.clickhouse.run(`ALTER TABLE rl_events ADD COLUMN IF NOT EXISTS ${type}`);
        await this.setMeta("carried-from", String(Date.now()));
      }
      if (version !== String(SCHEMA_VERSION)) await this.setMeta("schema", String(SCHEMA_VERSION));
      this.visits.carriedFrom = Number((await this.meta("carried-from")) ?? 0);
      if ((await this.moveState())?.back) throw new Error("Runlight: the visits are being copied back out of ClickHouse. Run clickhouse copy --back to finish, then remove CLICKHOUSE_URL.");
      await this.sayLive();
      this.live ??= setInterval(() => void this.sayLive().catch(() => {}), LIVE_EVERY_MS);
      this.live.unref?.();
      await this.prepareMove();
    })().catch((error) => {
      this.schema = null;
      throw error;
    });
    return this.schema;
  }

  /** The other store's tables only, leaving ClickHouse and the copy be, for the server's clickhouse commands. */
  async migrateOther(): Promise<void> {
    await super.migrate();
    await this.makeWaiting();
  }

  override tables(): string[] {
    return [...super.tables(), `${this.prefix}waiting_hits`];
  }

  // Hits that wait in the other store while ClickHouse cannot take them (see Waiting).

  private async makeWaiting(): Promise<void> {
    const dialect = this.db.dialect;
    const id = dialect === "postgres" ? "BIGSERIAL PRIMARY KEY" : dialect === "mysql" ? "BIGINT AUTO_INCREMENT PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
    await this.db.run(`CREATE TABLE IF NOT EXISTS rl_waiting_hits (id ${id}, at BIGINT NOT NULL, hit ${dialect === "mysql" ? "MEDIUMTEXT" : "TEXT"} NOT NULL)${dialect === "mysql" ? " DEFAULT CHARSET=utf8mb4" : ""}`);
  }

  /** ClickHouse could not be reached, was too busy, ran out of time or memory, or had too many parts to merge. */
  override waitable(error: unknown): boolean {
    if (transient(error) || (error as Error)?.name === "TimeoutError") return true;
    if (error instanceof ClickHouseError) return /^Code: (159|241|252)\b/.test(error.reply);
    return /ClickHouse is busy|could not reach ClickHouse/.test(String((error as Error)?.message ?? error));
  }

  override async wait(at: number, hit: string): Promise<void> {
    await this.db.run(`INSERT INTO rl_waiting_hits (at, hit) VALUES (?, ?)`, [at, hit]);
  }

  override async waiting(limit: number, since: number): Promise<{ hits: Array<{ id: string; hit: string }>; left: number } | null> {
    // A closed store sends nothing, and reads nothing: the other store would open a database afresh.
    if (this.closed) return null;
    if (!(await this.db.all(`SELECT 1 AS x FROM rl_waiting_hits LIMIT 1`)).length) {
      // None left: another process may send the next ones at once.
      if (this.sending) await this.swapSetting(WAITING_KEY, this.sending, JSON.stringify({ by: "", until: 0 }));
      this.sending = null;
      return { hits: [], left: 0 };
    }
    const mine = JSON.stringify({ by: this.owner, until: Date.now() + LEASE_MS });
    const held = await this.settingOrAdd(WAITING_KEY, () => mine);
    if (held !== mine) {
      const { by, until } = JSON.parse(held) as { by: string; until: number };
      if (by !== this.owner && until > Date.now()) return null;
      if (!(await this.swapSetting(WAITING_KEY, held, mine))) return null;
    }
    this.sending = mine;
    await this.db.run(`DELETE FROM rl_waiting_hits WHERE at < ?`, [since]);
    const hits = await this.db.all<{ id: unknown; hit: unknown }>(`SELECT id, hit FROM rl_waiting_hits ORDER BY id LIMIT ${Math.trunc(limit)}`);
    const [left] = await this.db.all<{ n: unknown }>(`SELECT COUNT(*) AS n FROM rl_waiting_hits`);
    return { hits: hits.map((h) => ({ id: String(h.id), hit: String(h.hit) })), left: Number(left?.n ?? 0) };
  }

  override async doneWaiting(ids: string[]): Promise<void> {
    // Ninety at a time, within Cloudflare D1's 100 values a statement.
    for (let i = 0; i < ids.length; i += 90) {
      const piece = ids.slice(i, i + 90);
      await this.db.run(`DELETE FROM rl_waiting_hits WHERE id IN (${piece.map(() => "?").join(", ")})`, piece.map(Number));
    }
  }

  override async close(): Promise<void> {
    this.closed = true;
    this.wake?.();
    await this.copying;
    await this.release().catch(() => {});
    if (this.sending) await this.swapSetting(WAITING_KEY, this.sending, JSON.stringify({ by: "", until: 0 })).catch(() => {});
    if (this.live) {
      clearInterval(this.live);
      this.live = null;
      await this.setMeta(`live:${this.owner}`, "0").catch(() => {});
    }
    await super.close();
  }

  /** Writes that this store is taking hits, until LIVE_FOR_MS from now. */
  private async sayLive(): Promise<void> {
    await this.setMeta(`live:${this.owner}`, String(Date.now() + LIVE_FOR_MS));
  }

  /** How long ago a store that is still taking hits last said so, or null when none is. */
  private async liveAgo(): Promise<number | null> {
    const rows = await this.clickhouse.all<{ v: string }>(`SELECT argMax(value, at) AS v FROM rl_meta WHERE startsWith("key", 'live:') AND "key" <> ? GROUP BY "key"`, [`live:${this.owner}`]);
    const until = Math.max(0, ...rows.map((r) => Number(r.v) || 0));
    return until > Date.now() ? Date.now() - (until - LIVE_FOR_MS) : null;
  }

  override async transaction<T>(fn: (store: SqlStore) => Promise<T>): Promise<T> {
    // The other store's statements are in a transaction; ClickHouse has none, and each write stands alone.
    return this.rows.transaction((rows) => fn(rows === this.rows ? this : new ClickHouseStore(rows, this.clickhouse, this.keys)));
  }

  /**
   * An import's step, without holding the other store's transaction: it writes nothing there but its progress,
   * and on SQLite a transaction would hold the whole server while the step's rows go to ClickHouse. The rows
   * are gathered and sent a few big inserts at a time, and the step reads its own visits back from memory.
   */
  override async importStep<T>(fn: (store: SqlStore) => Promise<T>): Promise<T> {
    const step = new ImportStep(this.rows, this.clickhouse, this.keys);
    const result = await fn(step.store);
    await step.flush();
    return result;
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
        // A month already merged into one part is left alone rather than written again.
        await this.clickhouse.run(`OPTIMIZE TABLE rl_visits PARTITION ${partition} FINAL SETTINGS optimize_skip_merged_partitions = 1`);
      }
      // A delete only hides rows until their part is written again, which an old month may never be. The
      // parts with deleted rows are written again in the background (the rest are left as they are), so
      // deleted visits leave the disk too.
      for (const table of ["rl_visits", "rl_events"]) await this.clickhouse.run(`ALTER TABLE ${table} APPLY DELETED MASK SETTINGS mutations_sync = 0`);
      await this.clickhouse.run(`DELETE FROM rl_meta WHERE startsWith("key", 'live:') AND at < ?`, [Date.now() - 86_400_000]);
    } catch (error) {
      console.error("Runlight: could not merge the visits in ClickHouse", error);
    }
  }

  // Reports: the shared SQL, run on ClickHouse.

  override async visitOpen(sites: string[], from: number, to: number, since: number): Promise<boolean> {
    // A hit asks this as the day turns, so it goes ahead of any reports waiting their turn.
    const open = await this.clickhouse.lookup(
      `SELECT 1 AS open FROM rl_sessions WHERE site IN (${sites.map(() => "?").join(", ")}) AND started_at >= ? AND started_at < ? AND last_at >= ? LIMIT 1`,
      [...sites, from, to, since],
    );
    return open.length > 0;
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
  override async stats(...a: Parameters<SqlStore["stats"]>) {
    return capped(await this.visits.stats(...a));
  }
  override async series(...a: Parameters<SqlStore["series"]>) {
    return (await this.visits.series(...a)).map(capped);
  }
  override async breakdown(...a: Parameters<SqlStore["breakdown"]>) {
    return (await this.visits.breakdown(...a)).map(capped);
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
  override async goalTotalsAll(...a: Parameters<SqlStore["goalTotalsAll"]>) {
    const all = await this.visits.goalTotalsAll(...a);
    for (const [id, totals] of all) all.set(id, capped(totals));
    return all;
  }
  override async goalTotals(...a: Parameters<SqlStore["goalTotals"]>) {
    return capped(await this.visits.goalTotals(...a));
  }
  override async goalBreakdown(...a: Parameters<SqlStore["goalBreakdown"]>) {
    return (await this.visits.goalBreakdown(...a)).map(capped);
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
  protected async key(id: string): Promise<VisitKey | null> {
    const known = this.keys.get(id);
    if (known) return known;
    // Its columns are in the row that began it, and empty in the rest, so the largest of each is the one.
    const [row] = await this.clickhouse.lookup<Record<string, unknown>>(
      `SELECT site, started_at, visitor, ${CARRIED_COLUMNS.map((col) => `max(${col}) AS ${col}`).join(", ")} FROM rl_visits WHERE id = ? GROUP BY site, started_at, visitor LIMIT 1`,
      [id],
    );
    if (!row) return null;
    return this.remember(id, { site: String(row.site), startedAt: Number(row.started_at), visitor: String(row.visitor), carried: carriedOf(row) });
  }

  protected remember(id: string, key: VisitKey): VisitKey {
    this.keys.delete(id);
    this.keys.set(id, key);
    // The oldest goes first, so the visits still going stay.
    if (this.keys.size > KEYS_KEPT) this.keys.delete(this.keys.keys().next().value!);
    return key;
  }

  /** Writes a hit's row into a table. An import's step gathers them instead. */
  protected async write(table: "rl_visits" | "rl_events", row: Record<string, unknown>): Promise<void> {
    await this.clickhouse.insert(table, [row]);
  }

  /** Adds a row to a visit: what changed, over a row of nothing. */
  private async add(id: string, change: Record<string, unknown>): Promise<void> {
    const key = await this.key(id);
    if (!key) return;
    await this.write("rl_visits", { site: key.site, started_at: key.startedAt, id, visitor: key.visitor, last_at: key.startedAt, entry: [NO_ENTRY, ""], exit: [0, ""], ...change });
  }

  override async openSession(site: string, visitors: string[], since: number): Promise<{ id: string; visitor: string } | null> {
    if (visitors.length === 0) return null;
    // A visit still going started within EVENT_TAIL_MS, which keeps the read to the newest days.
    const rows = await this.clickhouse.lookup<Record<string, unknown> & { id: string; visitor: string }>(
      `SELECT id, visitor, started_at, ${CARRIED_COLUMNS.join(", ")} FROM rl_sessions WHERE site = ? AND started_at >= ? AND visitor IN (${visitors.map(() => "?").join(", ")}) AND last_at >= ?
       ORDER BY last_at DESC, id LIMIT 1`,
      [site, since - EVENT_TAIL_MS, ...visitors, since],
    );
    const row = rows[0];
    if (!row) return null;
    this.remember(row.id, { site, startedAt: Number(row.started_at), visitor: row.visitor, carried: carriedOf(row) });
    return { id: row.id, visitor: row.visitor };
  }

  override async settleOpenSession(site: string, visitors: string[], since: number, opened: { id: string; visitor: string }): Promise<{ id: string; visitor: string }> {
    const rows = await this.clickhouse.lookup<Record<string, unknown> & { id: string; visitor: string }>(
      `SELECT id, visitor, started_at, ${CARRIED_COLUMNS.join(", ")} FROM rl_sessions WHERE site = ? AND started_at >= ? AND visitor IN (${visitors.map(() => "?").join(", ")}) AND last_at >= ?
       ORDER BY CASE WHEN pageviews > 0 OR events > 0 THEN 0 ELSE 1 END, started_at, id LIMIT 1`,
      [site, since - EVENT_TAIL_MS, ...visitors, since],
    );
    const first = rows[0];
    if (!first || first.id === opened.id) return opened;
    this.remember(first.id, { site, startedAt: Number(first.started_at), visitor: first.visitor, carried: carriedOf(first) });
    // The one opened here is left, rather than deleted: another process may be counting a hit into it this
    // moment, and a visit with no pageview or event is no visit to any report.
    return { id: first.id, visitor: first.visitor };
  }

  override async insertSession(row: SessionRow): Promise<void> {
    const c = clip;
    // Each text cut as the other databases cut it, so every database keeps the same.
    const columns = {
      hostname: c(row.hostname, 255), referrer_host: c(row.referrerHost, 255), referrer_path: c(row.referrerPath, 500),
      source: c(row.source, 200), channel: c(row.channel, 100), utm_source: c(row.utmSource, 200), utm_medium: c(row.utmMedium, 200),
      utm_campaign: c(row.utmCampaign, 200), utm_term: c(row.utmTerm, 200), utm_content: c(row.utmContent, 200),
      country: c(row.country, 16), region: c(row.region, 100), city: c(row.city, 100), browser: c(row.browser, 100),
      browser_version: c(row.browserVersion, 100), os: c(row.os, 100), os_version: c(row.osVersion, 100), device: c(row.device, 50),
      screen: c(row.screen, 50), language: c(row.language, 50),
    };
    this.remember(row.id, { site: row.site, startedAt: row.startedAt, visitor: row.visitor, carried: carriedOf(columns) });
    await this.write("rl_visits", {
      site: row.site, started_at: row.startedAt, id: row.id, visitor: row.visitor, last_at: row.startedAt,
      pageviews: 0, events: 0, engaged_ms: 0, engaged_unknown: 0, imported: 0, entry: [NO_ENTRY, ""], exit: [0, ""],
      ...columns,
    });
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

  /**
   * Nothing to do: there are no rollups to build again. Doing it anyway would write to the other store after
   * the engaged time went in, and a busy SQLite there would have the hit tried again and its time counted twice.
   */
  override async touchedOldVisit(): Promise<void> {}

  override async pageview(site: string, pageview: string, since = 0): ReturnType<SqlStore["pageview"]> {
    // The pageview first, among the recent ones by the events' sort order, then its visit by the start it carries.
    const [row] = await this.clickhouse.lookup<Record<string, unknown>>(
      `SELECT session, visitor, path, hostname, ts, started_at FROM rl_events WHERE site = ? AND kind = 'pageview' AND ts >= ? AND pageview = ? LIMIT 1`,
      [site, since, pageview],
    );
    if (!row) return null;
    const startedAt = Number(row.started_at);
    const [visit] = await this.clickhouse.lookup<Record<string, unknown> & { visitor: string }>(
      `SELECT last_at, visitor, ${CARRIED_COLUMNS.join(", ")} FROM rl_sessions WHERE site = ? AND started_at = ? AND id = ?`,
      [site, startedAt, String(row.session)],
    );
    if (!visit) return null;
    this.remember(String(row.session), { site, startedAt, visitor: visit.visitor, carried: carriedOf(visit) });
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
    await this.write("rl_events", {
      site: row.site, ts: row.ts, kind: row.kind, visitor: row.visitor, session: row.session, started_at: key?.startedAt ?? 0,
      pageview: row.pageview, path: clip(row.path, 1000), hostname: clip(row.hostname, 255), title: clip(row.title, 500),
      name: clip(row.name, 255), props: row.props ? JSON.stringify(row.props) : null, engaged_ms: row.engagedMs, scroll: row.scroll, link: row.link,
      ...key?.carried,
    });
  }

  // Imports

  override async deleteSession(id: string): Promise<void> {
    // By its key, so the delete reads one visit's rows rather than the whole table, and not at all for a
    // visit that is not there, as for each new visit an import makes.
    const key = await this.key(id);
    this.keys.delete(id);
    if (key) await this.clickhouse.run(`DELETE FROM rl_visits WHERE site = ? AND started_at = ? AND id = ?`, [key.site, key.startedAt, id]);
  }

  override async markImported(id: string, unknownEngagement: boolean): Promise<void> {
    await this.add(id, { imported: 1, engaged_unknown: unknownEngagement ? 1 : 0 });
  }

  override async deleteLinkHistory(link: string): Promise<void> {
    await this.clickhouse.mutate("rl_visits", `DELETE FROM rl_visits WHERE id IN (SELECT DISTINCT session FROM rl_events WHERE link = ? AND session <> '')`, [link]);
    await this.clickhouse.mutate("rl_events", `DELETE FROM rl_events WHERE link = ?`, [link]);
    this.keys.clear();
  }

  override async clearImportedVisits(site: string, from: number, to: number): Promise<void> {
    const imported = `SELECT id FROM rl_sessions WHERE site = ? AND imported = 1`;
    await this.clickhouse.mutate("rl_events", `DELETE FROM rl_events WHERE site = ? AND ts >= ? AND ts < ? AND kind IN ('pageview', 'event') AND session IN (${imported})`, [site, from, to, site]);
    await this.clickhouse.mutate(
      "rl_visits",
      `DELETE FROM rl_visits WHERE site = ? AND started_at >= ? AND started_at < ? AND id IN (${imported})
         AND id NOT IN (SELECT e.session FROM rl_events e WHERE e.site = ? AND e.ts >= ? AND e.ts < ?)`,
      [site, from - EVENT_TAIL_MS, to, site, site, from - EVENT_TAIL_MS, to + EVENT_TAIL_MS],
    );
    this.keys.clear();
  }

  override async recountCarriedVisits(site: string, from: number, to: number): Promise<void> {
    const carried = await this.clickhouse.all<{ id: string; started_at: unknown; visitor: string; pageviews: unknown; events: unknown }>(
      `SELECT id, started_at, visitor, pageviews, events FROM rl_sessions s WHERE s.site = ? AND s.imported = 1 AND s.started_at < ? AND s.started_at >= ?
         AND s.id IN (SELECT e.session FROM rl_events e WHERE e.site = ? AND e.ts >= ? AND e.ts < ?)`,
      [site, from, from - EVENT_TAIL_MS, site, from, to],
    );
    if (!carried.length) return;
    const totals = new Map<string, { pageviews: number; events: number }>();
    // A few hundred visits to a query, so their ids fit in the request's address.
    for (let i = 0; i < carried.length; i += 500) {
      const piece = carried.slice(i, i + 500);
      const rows = await this.clickhouse.all<{ session: string; pageviews: unknown; events: unknown }>(
        `SELECT session, countIf(kind = 'pageview') AS pageviews, countIf(kind = 'event') AS events FROM rl_events
         WHERE site = ? AND ts >= ? AND ts < ? AND kind IN ('pageview', 'event') AND session IN (${piece.map(() => "?").join(", ")}) GROUP BY session`,
        [site, Math.min(...piece.map((c) => Number(c.started_at))), to, ...piece.map((c) => c.id)],
      );
      for (const r of rows) totals.set(r.session, { pageviews: Number(r.pageviews), events: Number(r.events) });
    }
    // Each visit gets a row of the difference between what it counts and what its rows say, which ClickHouse
    // adds to the rest. Its first and last page and its last moment already come from its rows, as maxima.
    const fixes = carried.flatMap((v) => {
      const t = totals.get(v.id) ?? { pageviews: 0, events: 0 };
      const pageviews = t.pageviews - Number(v.pageviews);
      const events = t.events - Number(v.events);
      if (!pageviews && !events) return [];
      const startedAt = Number(v.started_at);
      return [{ site, started_at: startedAt, id: v.id, visitor: v.visitor, last_at: startedAt, pageviews, events, entry: [NO_ENTRY, ""], exit: [0, ""] }];
    });
    await this.clickhouse.insert("rl_visits", fixes, { batched: true });
  }

  // Deletes

  /** A site's visits and events go from ClickHouse, then everything else from the other store. */
  override async deleteSite(id: string): Promise<void> {
    await this.clickhouse.mutate("rl_events", `DELETE FROM rl_events WHERE site = ?`, [id]);
    await this.clickhouse.mutate("rl_visits", `DELETE FROM rl_visits WHERE site = ?`, [id]);
    this.keys.clear();
    await super.deleteSite(id);
  }

  /**
   * A visit's events go with it, even ones after the cutoff, so nothing is left without its visit. Retention
   * asks every few minutes, so it first looks whether anything is that old, which costs next to nothing.
   */
  override async dropBefore(site: string, ts: number): Promise<void> {
    // Only the months before the cutoff are read, which once retention has run hold nothing.
    const any = await this.clickhouse.all(
      `SELECT 1 AS x FROM (SELECT 1 FROM rl_visits WHERE site = ? AND started_at < ? LIMIT 1 UNION ALL SELECT 1 FROM rl_events WHERE site = ? AND ts < ? LIMIT 1)`,
      [site, ts, site, ts],
    );
    if (!any.length) return;
    // A visit's events come within EVENT_TAIL_MS of its start, which bounds the months read.
    await this.clickhouse.mutate("rl_events", `DELETE FROM rl_events WHERE site = ? AND ts < ? AND (ts < ? OR (started_at > 0 AND started_at < ?))`, [site, ts + EVENT_TAIL_MS, ts, ts]);
    await this.clickhouse.mutate("rl_visits", `DELETE FROM rl_visits WHERE site = ? AND started_at < ?`, [site, ts]);
    this.keys.clear();
  }

  override async dropOrphans(site: string, from: number, until: number): Promise<void> {
    await this.clickhouse.mutate(
      "rl_events",
      `DELETE FROM rl_events WHERE site = ? AND ts >= ? AND ts < ? AND session <> '' AND session NOT IN (SELECT id FROM rl_visits WHERE site = ?)`,
      [site, from, until, site],
    );
  }

  /** A click goal renamed takes its past clicks with it, which are in ClickHouse. */
  override async saveGoal(g: GoalRow, before?: GoalRow): Promise<void> {
    await super.saveGoal(g, before);
    if (before?.kind === "click" && g.kind === "click" && before.name !== g.name) {
      await this.clickhouse.mutate("rl_events", `ALTER TABLE rl_events UPDATE name = ? WHERE site = ? AND kind = 'event' AND name = ?`, [g.name, g.site, before.name]);
    }
  }

  // Moving: the visits the other store held before ClickHouse took over, copied across, newest first.
  // One process copies at a time, by a claim in the other store's settings, and records how far it got
  // in ClickHouse, so a restart carries on from there.

  private async meta(key: string, quick = false): Promise<string | null> {
    const sql = `SELECT argMax(value, at) AS value FROM rl_meta WHERE "key" = ?`;
    const [row] = quick ? await this.clickhouse.lookup<{ value: string | null }>(sql, [key]) : await this.clickhouse.all<{ value: string | null }>(sql, [key]);
    return row?.value ?? null;
  }

  private async setMeta(key: string, value: string): Promise<void> {
    // The newest write wins, so two written in the same millisecond still go in order.
    this.metaAt = Math.max(Date.now(), this.metaAt + 1);
    await this.clickhouse.insert("rl_meta", [{ key, value, at: this.metaAt }], { batched: true });
  }

  /** How far the copy has got, or null when there has been none, or it was undone by `copyBack()`. */
  async moveState(quick = false): Promise<MoveState | null> {
    const value = await this.meta("move", quick);
    return value ? (JSON.parse(value) as MoveState) : null;
  }

  /** The start of the oldest visit copied so far, while the copy is still going, for the dashboard to say. */
  override async moving(): Promise<{ through: number } | null> {
    if (this.moved) return null;
    // Asked on every dashboard load, so it goes ahead of the reports waiting their turn.
    const state = await this.moveState(true);
    if (state?.done && !state.back) this.moved = true;
    return state && !state.done ? { through: state.through } : null;
  }

  /**
   * Claims the copy for this process, or renews its claim. False while another process holds it. One at a
   * time, so the renewal on a timer and a piece's own claim never swap the setting from under each other.
   */
  private claim(): Promise<boolean> {
    const next = this.claims.then(() => this.claimOnce());
    this.claims = next.catch(() => false);
    return next;
  }

  private async claimOnce(): Promise<boolean> {
    const mine = JSON.stringify({ by: this.owner, until: Date.now() + LEASE_MS });
    const held = await this.settingOrAdd(LEASE_KEY, () => mine);
    if (held !== mine) {
      const { by, until } = JSON.parse(held) as { by: string; until: number };
      if (by !== this.owner && until > Date.now()) return false;
      if (!(await this.swapSetting(LEASE_KEY, held, mine))) return false;
    }
    this.claimed = mine;
    return true;
  }

  private async release(): Promise<void> {
    if (!this.claimed) return;
    await this.swapSetting(LEASE_KEY, this.claimed, JSON.stringify({ by: "", until: 0 }));
    this.claimed = null;
  }

  /**
   * Runs `fn` while renewing this process's claim on a timer, however long its queries take, so another
   * process never takes over a piece this one is still writing. Losing the claim anyway (this process stalled
   * past LEASE_MS) stops it at its next write, through `still()`.
   */
  private async holding<T>(fn: () => Promise<T>): Promise<T> {
    this.lost = false;
    const timer = setInterval(() => {
      this.claim().then(
        (held) => {
          if (!held) this.lost = true;
        },
        () => {},
      );
    }, RENEW_MS);
    timer.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(timer);
    }
  }

  /** Stops a piece of the copy before its next write, once the store closes or another process takes over. */
  private still(): void {
    if (this.closed) throw new Error("Runlight: the store closed while copying visits into ClickHouse");
    if (this.lost) throw new Error("Runlight: another process took over copying visits into ClickHouse");
  }

  /**
   * Waits up to `ms`, or until the store closes. Only the copy in the background lets the process exit
   * meanwhile; one a caller waits for, such as the server's clickhouse copy command, keeps it running.
   */
  private async pause(ms: number, background = false): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (background) timer.unref?.();
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.wake = null;
  }

  /**
   * On the first start with ClickHouse, decides whether there is anything to copy. Then copies the visits a
   * hit can still reach before the store is ready, so a visit going on at the switch carries on rather than
   * starting again, and starts copying the rest in the background.
   */
  private async prepareMove(): Promise<void> {
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      let state = await this.moveState();
      if (state?.done) return;
      if (state && state.through < state.at) break;
      if (await this.claim()) {
        state ??= await this.planMove();
        if (!state.done) {
          const first = state;
          await this.holding(() => this.copyStep(first, true));
        }
        break;
      }
      // Another process is copying the newest visits; this one starts once they are in.
      if (Date.now() > deadline) throw new Error("Runlight: another process has been copying the newest visits into ClickHouse for ten minutes. Try again shortly.");
      await this.pause(1_000);
    }
    if (this.background) {
      this.copying ??= this.copyAll(undefined, undefined, true).then(
        () => {},
        (error) => console.error("Runlight: copying visits into ClickHouse stopped, and carries on at the next start", error),
      );
    } else {
      // Left for copy(), here or in another process, which need not wait for this claim to run out.
      await this.release();
    }
  }

  /** The first time: a copy to make when the other store has visits and ClickHouse has none. */
  private async planMove(): Promise<MoveState> {
    const at = Date.now();
    const any = async (db: Db, table: string) => (await db.all(`SELECT 1 AS x FROM ${table} LIMIT 1`)).length > 0;
    const needed = ((await any(this.db, "rl_sessions")) || (await any(this.db, "rl_events"))) && !(await any(this.clickhouse, "rl_visits")) && !(await any(this.clickhouse, "rl_events"));
    const state = { at, through: at, done: !needed };
    await this.setMeta("move", JSON.stringify(state));
    return state;
  }

  /**
   * Copies every visit and event from the other store that ClickHouse does not have yet, newest first, and
   * returns once all are in. Runs in the background unless `copyInBackground` is false; the server's
   * `clickhouse copy` command runs it in the foreground. While another process holds the copy, it waits,
   * and calls `onWait` once to say so.
   */
  async copy(onProgress?: (state: MoveState) => void, onWait?: () => void): Promise<MoveState | null> {
    return this.copyAll(onProgress, onWait, false);
  }

  private async copyAll(onProgress: ((state: MoveState) => void) | undefined, onWait: (() => void) | undefined, background: boolean): Promise<MoveState | null> {
    let first = true;
    let failed = 0;
    let waited = false;
    for (;;) {
      const state = await this.moveState();
      if (this.closed) return state;
      if (!state || state.done) {
        await this.release();
        return state;
      }
      if (!(await this.claim())) {
        if (!waited) onWait?.();
        waited = true;
        first = true;
        await this.pause(5_000, background);
        continue;
      }
      let next: MoveState;
      try {
        next = await this.holding(() => this.copyStep(state, first));
      } catch (error) {
        if (this.closed) return state;
        // A dropped connection or a busy database: the piece is cleared and copied again after a pause.
        if (++failed >= COPY_TRIES) throw error;
        const wait = Math.min(1_000 * 2 ** (failed - 1), 300_000);
        const reason = error instanceof Error ? [error.message, (error.cause as Error | undefined)?.message].filter(Boolean).join(": ") : String(error);
        console.error(`Runlight: copying visits into ClickHouse failed (${reason}), and tries again in ${Math.round(wait / 1000)} s`);
        first = true;
        await this.pause(wait, background);
        continue;
      }
      first = false;
      failed = 0;
      onProgress?.(next);
    }
  }

  /**
   * Copies the next piece back in time, and records it as copied. `resuming` first clears what a process
   * stopped part way through it left in ClickHouse: the visits that started in it, which no hit reaches (the
   * piece of the last two days is copied before any hit is counted), and the events the copy wrote into it.
   */
  private async copyStep(state: MoveState, resuming: boolean): Promise<MoveState> {
    const sites = (await this.db.all<{ id: string }>(`SELECT id FROM rl_sites`)).map((s) => String(s.id));
    const to = state.through;
    let from: number;
    if (to === state.at) from = to - RECENT_MS;
    else {
      // A day back from the newest start before this point, skipping straight over stretches with none.
      let latest: number | null = null;
      for (const site of sites) {
        for (const [table, col] of [["rl_sessions", "started_at"], ["rl_events", "ts"]] as const) {
          const [row] = await this.db.all(`SELECT MAX(${col}) AS t FROM ${table} WHERE site = ? AND ${col} < ?`, [site, to]);
          if (row?.t !== null && row?.t !== undefined) latest = Math.max(latest ?? -Infinity, Number(row.t));
        }
      }
      if (latest === null) {
        const done = { ...state, done: true };
        await this.setMeta("move", JSON.stringify(done));
        return done;
      }
      from = latest + 1 - 86_400_000;
    }
    if (resuming) {
      this.still();
      await this.clickhouse.mutate("rl_visits", `DELETE FROM rl_visits WHERE started_at >= ? AND started_at < ?`, [from, to]);
      await this.clickhouse.mutate("rl_events", `DELETE FROM rl_events WHERE ts >= ? AND ts < ? AND id >= ${COPIED_ID}`, [from, to]);
    }
    for (const site of sites) await this.copyPiece(site, from, to);
    this.still();
    if (!(await this.claim())) throw new Error("Runlight: another process took over copying visits into ClickHouse");
    const next = { ...state, through: from };
    await this.setMeta("move", JSON.stringify(next));
    return next;
  }

  /** One site's visits that started in [from, to), and its events in [from, to), each with its visit's start and columns. */
  private async copyPiece(site: string, from: number, to: number): Promise<void> {
    let after: { at: number; id: string } | null = null;
    for (;;) {
      const rows: Array<Record<string, unknown>> = await this.db.all(
        `SELECT * FROM rl_sessions WHERE site = ? AND started_at >= ? AND started_at < ?${after ? " AND (started_at > ? OR (started_at = ? AND id > ?))" : ""}
         ORDER BY started_at, id LIMIT ${COPY_BATCH}`,
        after ? [site, from, to, after.at, after.at, after.id] : [site, from, to],
      );
      if (!rows.length) break;
      this.still();
      await this.clickhouse.insert("rl_visits", rows.map(visitFrom), { batched: true });
      if (rows.length < COPY_BATCH) break;
      const last = rows[rows.length - 1]!;
      after = { at: Number(last.started_at), id: String(last.id) };
    }
    // By the events' own time, so each read is one day of them; a visit's start is looked up by its id.
    let next: { ts: number; id: number } | null = null;
    for (;;) {
      const rows: Array<Record<string, unknown>> = await this.db.all(
        `SELECT ${EVENT_COLUMNS.map((c) => `e.${c}`).join(", ")}, e.id AS row_id, s.started_at AS visit_started, ${CARRIED_COLUMNS.map((c) => `s.${c} AS ${carried(c)}`).join(", ")}
         FROM rl_events e LEFT JOIN rl_sessions s ON s.id = e.session
         WHERE e.site = ? AND e.ts >= ? AND e.ts < ?${next ? " AND (e.ts > ? OR (e.ts = ? AND e.id > ?))" : ""}
         ORDER BY e.ts, e.id LIMIT ${COPY_BATCH}`,
        [site, from, to, ...(next ? [next.ts, next.ts, next.id] : [])],
      );
      if (!rows.length) break;
      this.still();
      await this.clickhouse.insert("rl_events", rows.map(eventFrom), { batched: true });
      if (rows.length < COPY_BATCH) break;
      const last = rows[rows.length - 1]!;
      next = { ts: Number(last.ts), id: Number(last.row_id) };
    }
  }

  /**
   * How many visits and events each store holds, for the server's `clickhouse status` command. `late` is the
   * visits in the other store that started after ClickHouse took over, which only a process running without
   * CLICKHOUSE_URL can have written there, and which are not in ClickHouse.
   */
  async counts(): Promise<{ clickhouse: { visits: number; events: number }; other: { visits: number; events: number; copied: number | null; late: number } }> {
    const count = async (db: Db, sql: string, params: unknown[] = []) => Number((await db.all<{ n: unknown }>(sql, params))[0]?.n ?? 0);
    const state = await this.moveState();
    return {
      // Each month's visits are added up apart, so this counts a year of them in little memory.
      clickhouse: { visits: await count(this.clickhouse, `SELECT count() AS n FROM rl_sessions`), events: await count(this.clickhouse, `SELECT count() AS n FROM rl_events`) },
      other: {
        visits: await count(this.db, `SELECT COUNT(*) AS n FROM rl_sessions`),
        events: await count(this.db, `SELECT COUNT(*) AS n FROM rl_events`),
        copied: state && !state.done ? await count(this.db, `SELECT COUNT(*) AS n FROM rl_sessions WHERE started_at >= ? AND started_at < ?`, [state.through, state.at]) : null,
        late: state ? await count(this.db, `SELECT COUNT(*) AS n FROM rl_sessions WHERE started_at >= ?`, [state.at]) : 0,
      },
    };
  }

  /**
   * Empties the other store of the visits and events copied into ClickHouse, which reads them from then on,
   * and of its rollups. Visits that started there after ClickHouse took over were never copied, so they stay.
   * For the server's `clickhouse drop-old` command.
   */
  async dropOld(): Promise<void> {
    const state = await this.moveState();
    if (!state) throw new Error("Runlight: nothing has been copied into ClickHouse, so the visits in the other store are the only ones.");
    if (!state.done || state.back) throw new Error("Runlight: visits are still being copied into ClickHouse. Run clickhouse copy to finish first.");
    const sites = (await this.db.all<{ id: string }>(`SELECT id FROM rl_sites`)).map((s) => String(s.id));
    // A day at a time, as retention deletes, so a big history does not hold the database for minutes.
    for (const site of sites) {
      await this.rows.dropBefore(site, state.at);
      await this.rows.clearRollups(site);
    }
    // Rows of sites deleted since, which nothing reads, and the rollups, which ClickHouse does without.
    for (const table of ["rl_events", "rl_sessions"]) await this.db.run(`DELETE FROM ${table} WHERE site NOT IN (SELECT id FROM rl_sites)`);
    for (const table of ["rl_rollups", "rl_rollup_days"]) await this.db.run(`DELETE FROM ${table}`);
  }

  private async emptyOther(): Promise<void> {
    const sites = (await this.db.all<{ id: string }>(`SELECT id FROM rl_sites`)).map((s) => String(s.id));
    for (const site of sites) {
      await this.rows.dropBefore(site, Number.MAX_SAFE_INTEGER);
      await this.rows.clearRollups(site);
    }
    for (const table of ["rl_events", "rl_sessions", "rl_rollups", "rl_rollup_days"]) await this.db.run(`DELETE FROM ${table}`);
  }

  /**
   * Copies every visit and event in ClickHouse into the other store, in place of what it held, then empties
   * ClickHouse, for going back to the other store alone. Only with the copy done and no server taking hits;
   * the server's `clickhouse copy --back` command runs it. Rollups are built again from the rows. Stopped
   * part way, it can be run again: it records when the other store holds everything, before emptying ClickHouse.
   */
  async copyBack(onProgress?: (copied: { visits: number; events: number }) => void): Promise<void> {
    const state = await this.moveState();
    if (!state) throw new Error("Runlight: ClickHouse has nothing to copy back: it was never switched on here, or everything was copied back already.");
    if (!state.done) throw new Error("Runlight: visits are still being copied into ClickHouse. Run clickhouse copy to finish first.");
    const ago = await this.liveAgo();
    if (ago !== null) {
      throw new Error(
        `Runlight: a server is still taking hits into ClickHouse (it last said so ${Math.round(ago / 1000)} s ago). Stop every server first; one that stopped without shutting down counts as gone ${LIVE_FOR_MS / 1000} s after it last said so.`,
      );
    }
    // Without ClickHouse they would never be sent.
    const [waiting] = await this.db.all<{ n: unknown }>(`SELECT COUNT(*) AS n FROM rl_waiting_hits`);
    const left = Number(waiting?.n ?? 0);
    if (left) throw new Error(`Runlight: ${left === 1 ? "a hit is" : `${left.toLocaleString("en")} hits are`} still waiting to go into ClickHouse. Start a server until they are in, then stop it and copy back.`);
    if (state.back !== "copied") {
      const held = await this.clickhouse.all(`SELECT 1 AS x FROM (SELECT 1 FROM rl_visits LIMIT 1 UNION ALL SELECT 1 FROM rl_events LIMIT 1)`);
      if (!held.length && state.back !== "copying") {
        const other = await this.db.all(`SELECT 1 AS x FROM rl_sessions LIMIT 1`);
        if (other.length) throw new Error("Runlight: ClickHouse holds no visits, so copying back would only empty the other store. Nothing was changed.");
      }
      await this.setMeta("move", JSON.stringify({ ...state, back: "copying" }));
      await this.emptyOther();
      await this.copyOut(onProgress);
      await this.setMeta("move", JSON.stringify({ ...state, back: "copied" }));
    }
    await this.clickhouse.run(`TRUNCATE TABLE rl_visits`);
    await this.clickhouse.run(`TRUNCATE TABLE rl_events`);
    this.keys.clear();
    this.moved = false;
    // Switched on again later, ClickHouse copies everything afresh.
    await this.setMeta("move", "");
  }

  /** Every visit and event in ClickHouse into the other store, a day at a time. */
  private async copyOut(onProgress?: (copied: { visits: number; events: number }) => void): Promise<void> {
    const copied = { visits: 0, events: 0 };
    const sites = (await this.clickhouse.all<{ site: string }>(`SELECT DISTINCT site FROM rl_visits UNION DISTINCT SELECT DISTINCT site FROM rl_events`)).map((s) => s.site);
    const visitColumns = ["id", "site", "visitor", "started_at", "last_at", "entry_path", "exit_path", "pageviews", "events", "engaged_ms", "imported", ...VISIT_TEXT];
    // A day at a time, so each query reads and sorts one day's rows rather than the whole table.
    for (const site of sites) {
      for (let day = await this.firstFrom("rl_visits", "started_at", site, 0); day !== null; day = await this.firstFrom("rl_visits", "started_at", site, day + 86_400_000)) {
        let after: { at: number; id: string } | null = null;
        for (;;) {
          const rows: Array<Record<string, unknown>> = await this.clickhouse.all(
            `SELECT ${visitColumns.join(", ")} FROM rl_sessions WHERE site = ? AND started_at >= ? AND started_at < ?${after ? " AND (started_at > ? OR (started_at = ? AND id > ?))" : ""} ORDER BY started_at, id LIMIT ${COPY_BATCH}`,
            [site, day, day + 86_400_000, ...(after ? [after.at, after.at, after.id] : [])],
          );
          if (!rows.length) break;
          await this.insertRows("rl_sessions", visitColumns, rows);
          copied.visits += rows.length;
          onProgress?.(copied);
          if (rows.length < COPY_BATCH) break;
          const last = rows[rows.length - 1]!;
          after = { at: Number(last.started_at), id: String(last.id) };
        }
      }
      for (let day = await this.firstFrom("rl_events", "ts", site, 0); day !== null; day = await this.firstFrom("rl_events", "ts", site, day + 86_400_000)) {
        let next: { ts: number; id: string } | null = null;
        for (;;) {
          const rows: Array<Record<string, unknown>> = await this.clickhouse.all(
            `SELECT ${EVENT_COLUMNS.join(", ")}, toString(id) AS row_id FROM rl_events WHERE site = ? AND ts >= ? AND ts < ?${next ? " AND (ts > ? OR (ts = ? AND toString(id) > ?))" : ""} ORDER BY ts, row_id LIMIT ${COPY_BATCH}`,
            [site, day, day + 86_400_000, ...(next ? [next.ts, next.ts, next.id] : [])],
          );
          if (!rows.length) break;
          await this.insertRows("rl_events", [...EVENT_COLUMNS], rows);
          copied.events += rows.length;
          onProgress?.(copied);
          if (rows.length < COPY_BATCH) break;
          const last = rows[rows.length - 1]!;
          next = { ts: Number(last.ts), id: String(last.row_id) };
        }
      }
    }
  }

  /** The earliest `col` in a ClickHouse table for `site` at `from` or later, or null when there is none. */
  private async firstFrom(table: string, col: string, site: string, from: number): Promise<number | null> {
    const [row] = await this.clickhouse.all<{ t: unknown }>(`SELECT min(${col}) AS t FROM ${table} WHERE site = ? AND ${col} >= ?`, [site, from]);
    return row?.t === null || row?.t === undefined ? null : Number(row.t);
  }

  /** Rows into the other store, a few hundred to a statement, each statement its own transaction. */
  private async insertRows(table: string, columns: string[], rows: Array<Record<string, unknown>>): Promise<void> {
    const per = Math.floor(6_000 / columns.length);
    for (let i = 0; i < rows.length; i += per) {
      const piece = rows.slice(i, i + per);
      const values = piece.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
      await this.rows.transaction((store) => store.db.run(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values}`, piece.flatMap((r) => columns.map((c) => r[c] ?? null))));
    }
  }
}

/** The store calls an import's step makes that go into memory; any other call sends what is gathered first. */
const GATHERED = new Set(["insertSession", "touchSession", "insertEvent", "markImported", "openSession", "deleteSession"]);

/**
 * One step of an import on ClickHouse. Its visits and events are gathered in memory and sent in a few big
 * inserts, where a hit at a time would wait on ClickHouse for each row. The visits it makes are found again
 * from memory, so a later row of the step joins its visit as it would have once that was written.
 */
class ImportStep extends ClickHouseStore {
  /** The store the step's code is given: every call but the gathered ones sends what is gathered first. */
  readonly store: SqlStore;
  private visitRows: Array<Record<string, unknown>> = [];
  private eventRows: Array<Record<string, unknown>> = [];
  /** The visits this step made, by visitor, and the latest moment each visit it wrote to reached. */
  private readonly made = new Map<string, Array<{ id: string } & VisitKey>>();
  private readonly madeKeys = new Map<string, VisitKey>();
  private readonly lastAt = new Map<string, number>();

  constructor(rows: SqlStore, clickhouse: ClickHouseDb, keys: Map<string, VisitKey>) {
    super(rows, clickhouse, keys);
    this.store = new Proxy(this, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function" || prop === "constructor") return value;
        if (GATHERED.has(String(prop))) return value.bind(target);
        return async (...args: unknown[]) => {
          await target.flush();
          return value.apply(target, args);
        };
      },
    });
  }

  /** Sends what the step has gathered. */
  async flush(): Promise<void> {
    const visits = this.visitRows;
    const events = this.eventRows;
    this.visitRows = [];
    this.eventRows = [];
    for (let i = 0; i < visits.length; i += 10_000) await this.clickhouse.insert("rl_visits", visits.slice(i, i + 10_000), { batched: true });
    for (let i = 0; i < events.length; i += 10_000) await this.clickhouse.insert("rl_events", events.slice(i, i + 10_000), { batched: true });
  }

  protected override async write(table: "rl_visits" | "rl_events", row: Record<string, unknown>): Promise<void> {
    if (table === "rl_events") return void this.eventRows.push(row);
    const id = String(row.id);
    this.lastAt.set(id, Math.max(this.lastAt.get(id) ?? 0, Number(row.last_at)));
    this.visitRows.push(row);
  }

  protected override async key(id: string): Promise<VisitKey | null> {
    return this.madeKeys.get(id) ?? super.key(id);
  }

  override async insertSession(row: SessionRow): Promise<void> {
    await super.insertSession(row);
    const key = this.keys.get(row.id)!;
    this.madeKeys.set(row.id, key);
    this.made.set(row.visitor, [...(this.made.get(row.visitor) ?? []), { id: row.id, ...key }]);
  }

  override async deleteSession(id: string): Promise<void> {
    const mine = this.madeKeys.get(id);
    if (!mine) return super.deleteSession(id);
    this.visitRows = this.visitRows.filter((r) => r.id !== id);
    this.eventRows = this.eventRows.filter((r) => r.session !== id);
    this.madeKeys.delete(id);
    this.lastAt.delete(id);
    this.made.set(mine.visitor, (this.made.get(mine.visitor) ?? []).filter((v) => v.id !== id));
  }

  /** The visit to join, from ClickHouse and from what this step has gathered, by the same rule as ClickHouse's. */
  override async openSession(site: string, visitors: string[], since: number): Promise<{ id: string; visitor: string } | null> {
    if (visitors.length === 0) return null;
    const found = new Map<string, { id: string; visitor: string; startedAt: number; lastAt: number; carried: Record<string, string> }>();
    const rows = await this.clickhouse.lookup<Record<string, unknown> & { id: string; visitor: string }>(
      `SELECT id, visitor, started_at, last_at, ${CARRIED_COLUMNS.join(", ")} FROM rl_sessions WHERE site = ? AND started_at >= ? AND visitor IN (${visitors.map(() => "?").join(", ")})`,
      [site, since - EVENT_TAIL_MS, ...visitors],
    );
    for (const r of rows) found.set(r.id, { id: r.id, visitor: r.visitor, startedAt: Number(r.started_at), lastAt: Number(r.last_at), carried: carriedOf(r) });
    for (const visitor of visitors) {
      for (const v of this.made.get(visitor) ?? []) {
        if (v.site === site && v.startedAt >= since - EVENT_TAIL_MS) found.set(v.id, { id: v.id, visitor, startedAt: v.startedAt, lastAt: v.startedAt, carried: v.carried });
      }
    }
    const open = [...found.values()]
      .map((v) => ({ ...v, lastAt: Math.max(v.lastAt, this.lastAt.get(v.id) ?? 0) }))
      .filter((v) => v.lastAt >= since)
      .sort((a, b) => b.lastAt - a.lastAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const row = open[0];
    if (!row) return null;
    this.remember(row.id, { site, startedAt: row.startedAt, visitor: row.visitor, carried: row.carried });
    return { id: row.id, visitor: row.visitor };
  }
}

/**
 * Runlight's visits and events in ClickHouse, and everything else in `store`, such as SQLite or Postgres.
 * Worth it past a few million visits a month, or for reports filtered over long ranges.
 */
export function clickhouse(options: ClickHouseOptions): ClickHouseStore {
  return new ClickHouseStore(options.store, clickhouseDb(options), new Map(), options.copyInBackground ?? true);
}

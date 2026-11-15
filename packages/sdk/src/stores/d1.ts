import { SqlStore, type Db } from "../store.js";

/** The parts of Cloudflare's D1 binding Runlight uses, so there is no dependency on its types. */
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  /** Several statements as one request, and one transaction: all of them, or none. */
  batch?(statements: D1PreparedStatement[]): Promise<Array<{ results?: unknown[] }>>;
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Options {
  /** The D1 binding from your Worker's environment, such as env.DB. */
  database: D1Database;
  /**
   * What every table and index name starts with, in place of `rl_`, so two apps sharing one database each
   * keep a set of their own: up to 32 letters, digits, and underscores, not starting with a digit.
   */
  prefix?: string;
}

/**
 * Runlight's tables in Cloudflare D1, for Workers and Pages.
 *
 *   export default { fetch: (request, env) => runlight({ store: d1({ database: env.DB }) }).routes().handler(request) };
 *
 * D1 has no interactive transactions, and a Worker may send it only so many queries a request (50 on the
 * free plan, 1,000 on a paid one), with a batch of statements counting as one. So an import gathers a step's
 * writes and sends them in batches of up to 2,000 statements, each batch all or nothing. A link whose history
 * fits one batch is written whole or not at all; a longer one goes in several batches with the link itself
 * last, so a failure part way leaves clicks without a link, which the next try clears before it starts again.
 */
export function d1(options: D1Options): SqlStore {
  const stmt = (sql: string, params: unknown[]) => {
    const prepared = options.database.prepare(sql);
    return params.length ? prepared.bind(...params.map((p) => (p === undefined ? null : p))) : prepared;
  };
  const db: Db = {
    dialect: "sqlite",
    // A Worker may only send so many queries per request, so long jobs go in fewer, larger pieces.
    metered: true,
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await stmt(sql, params).all<T>()).results;
    },
    async run(sql: string, params: unknown[] = []): Promise<void> {
      await stmt(sql, params).run();
    },
    async transaction<T>(fn: (inner: Db) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
  if (options.database.batch) {
    db.batch = async (statements) => (await options.database.batch!(statements.map((s) => stmt(s.sql, s.params ?? [])))).map((result) => result.results ?? []);
  }
  return new SqlStore(db, options.prefix);
}

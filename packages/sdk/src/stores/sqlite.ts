import { chmodSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import { SqlStore, oneConnection, type Db } from "../store.js";

export interface SqliteOptions {
  /** A file path, or ":memory:". */
  path: string;
  /**
   * What every table and index name starts with, in place of `rl_`, so two apps sharing one database each
   * keep a set of their own: up to 32 letters, digits, and underscores, not starting with a digit.
   */
  prefix?: string;
}

/**
 * Runlight's tables in a SQLite file, through better-sqlite3. Tables are
 * prefixed `rl_` (or `prefix`), so the file can be the app's own database.
 */
export function sqlite(options: SqliteOptions): SqlStore {
  let handle: Database.Database | null = null;
  const open = (): Database.Database => {
    if (!handle) {
      const made = options.path !== ":memory:" && !options.path.startsWith("file:") && !existsSync(options.path);
      handle = new Database(options.path);
      if (made) ownerAndGroup(options.path);
      handle.pragma("journal_mode = WAL");
      handle.pragma("synchronous = NORMAL");
      handle.pragma("busy_timeout = 5000");
      // Deleted rows, such as a day's salt once it is gone, are overwritten where that costs no extra writes,
      // so they do not linger in the file's free space.
      handle.pragma("secure_delete = FAST");
    }
    return handle;
  };
  // better-sqlite3 binds every JS number as REAL, which turns integer
  // arithmetic in SQL (minute buckets, for one) into fractions.
  const bind = (params: unknown[]) => params.map((p) => (typeof p === "number" && Number.isSafeInteger(p) ? BigInt(p) : p));
  const db: Db = {
    dialect: "sqlite",
    async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return open().prepare(sql).all(...bind(params)) as T[];
    },
    async run(sql: string, params: unknown[] = []): Promise<void> {
      open().prepare(sql).run(...bind(params));
    },
    async close(): Promise<void> {
      handle?.close();
      handle = null;
    },
  };
  return new SqlStore(oneConnection(db), options.prefix);
}

/**
 * A database file just made is for its owner and group alone (0660), whatever the umask: the visits in it are
 * nobody else's to read, and a scheduled job running as another user of the same group can still write to
 * it. SQLite gives the -wal and -shm files it makes later the same mode. Systems without such modes ignore it.
 */
function ownerAndGroup(path: string): void {
  try {
    chmodSync(path, 0o660);
  } catch {
    // Not a file this process may change, or a system with no such modes.
  }
}

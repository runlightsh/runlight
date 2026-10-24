import type { SqlStore } from "./store.js";

/**
 * How long a hit may wait: a day. Past that its visitor's hash would outlive the day it was made for, and
 * the visit it belongs to is long over.
 */
export const WAIT_KEEP_MS = 86_400_000;

/** The most hits kept waiting, a gigabyte or so, so a long outage cannot fill the other store's disk. */
const WAIT_MOST = 2_000_000;

/** How many waiting hits are read at a time, and how many visitors' hits are sent at once. */
const BATCH = 500;
const AT_ONCE = 64;
/** How many sent hits are let go of together. */
const LET_GO = 50;

/** How long to wait after a round that could not send, and between looks for hits another process left. */
const RETRY_MS = 5_000;
const LOOK_MS = 30_000;

/**
 * Hits the store could not take just now (ClickHouse down or too busy), kept in its other store and sent
 * again in the order they came once it answers. While any wait, new hits queue behind them, so a visitor's
 * hits still arrive in order. Another process sharing the store sends the ones it finds there, one at a time.
 */
export class Waiting<T> {
  /** True while this process knows of hits waiting, so a new hit queues behind them rather than overtaking them. */
  active = false;
  private count = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private round: Promise<void> | null = null;
  private started = false;
  /** Hits a round could not finish, as far as they got, so the next round carries on rather than starting over. */
  private readonly tried = new Map<string, T>();
  /** How many waiting hits this round sent. */
  private sent = 0;

  constructor(
    private readonly store: SqlStore,
    /** Records one hit. Throws what the store threw when it could not. */
    private readonly send: (hit: T) => Promise<void>,
    /** Which visitor sent a hit: one visitor's hits go one after another, in order, and different visitors' at once. */
    private readonly visitor: (hit: T) => string,
    private readonly now: () => number,
  ) {}

  /** Keeps a hit to send later. False when too many are waiting already, and the hit is lost. */
  async add(at: number, hit: T): Promise<boolean> {
    if (this.count >= WAIT_MOST) return false;
    // Counted before the write, so hits added at once cannot all pass the check.
    this.count++;
    try {
      await this.store.wait(at, JSON.stringify(hit));
    } catch (error) {
      this.count--;
      throw error;
    }
    if (!this.active) {
      this.active = true;
      console.error("Runlight: hits wait in the database until ClickHouse can take them again");
    }
    this.soon(RETRY_MS);
    return true;
  }

  /** Starts looking now and then for hits waiting, such as ones a process that stopped left behind. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.soon(0);
  }

  /** Sends what is waiting now, after any round under way, rather than at the next look. */
  async flush(): Promise<void> {
    await this.round;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.go();
  }

  /** One round at a time, then the next look. */
  private go(): Promise<void> {
    this.round ??= this.sendAll()
      .catch((error) => console.error("Runlight: could not send the hits waiting for ClickHouse", error))
      .finally(() => {
        this.round = null;
        this.soon(this.active ? RETRY_MS : LOOK_MS);
      });
    return this.round;
  }

  private soon(ms: number): void {
    if (this.timer || this.round) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.go();
    }, ms);
    this.timer.unref?.();
  }

  /** Lets go of hits that were sent or dropped. */
  private async finished(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.store.doneWaiting(ids);
    for (const id of ids) this.tried.delete(id);
    this.sent += ids.length;
    this.count = Math.max(0, this.count - ids.length);
  }

  /** Sends waiting hits, a batch at a time, until none are left or the store cannot take them yet. */
  private async sendAll(): Promise<void> {
    this.sent = 0;
    for (;;) {
      const batch = await this.store.waiting(BATCH, this.now() - WAIT_KEEP_MS);
      // Another process is sending them.
      if (batch === null) return;
      this.count = batch.left;
      if (!batch.hits.length) {
        if (this.active && this.sent) console.error(`Runlight: ClickHouse took the ${this.sent.toLocaleString("en")} hits that waited for it`);
        this.active = false;
        return;
      }
      this.active = true;
      const byVisitor = new Map<string, Array<{ id: string; hit: T }>>();
      // One that cannot be read never will be, so it goes.
      const unreadable: string[] = [];
      for (const row of batch.hits) {
        let hit: T;
        try {
          hit = this.tried.get(row.id) ?? (JSON.parse(row.hit) as T);
        } catch {
          unreadable.push(row.id);
          continue;
        }
        const key = this.visitor(hit);
        byVisitor.set(key, [...(byVisitor.get(key) ?? []), { id: row.id, hit }]);
      }
      await this.finished(unreadable);
      let stalled: unknown = null;
      const queue = [...byVisitor.values()];
      // Sent, or dropped, and let go a few visitors' at a time, so a process that stops part way through a
      // batch leaves little it had sent already to be sent again.
      const done: string[] = [];
      const worker = async () => {
        for (let hits = queue.shift(); hits && !stalled; hits = queue.shift()) {
          for (const { id, hit } of hits) {
            try {
              await this.send(hit);
            } catch (error) {
              // The store cannot take it yet: it and the visitor's later hits wait for the next round.
              if (this.store.waitable(error)) {
                this.tried.set(id, hit);
                stalled = error;
                break;
              }
              console.error("Runlight: dropped a hit that waited for ClickHouse, as it could not be recorded", error);
            }
            done.push(id);
          }
          if (done.length >= LET_GO) await this.finished(done.splice(0));
        }
      };
      await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, worker));
      await this.finished(done.splice(0));
      if (stalled) return;
    }
  }
}

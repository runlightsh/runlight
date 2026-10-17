/**
 * npx @runlight/server clickhouse: looks after moving the visits into ClickHouse. The server copies them
 * by itself once CLICKHOUSE_URL is set; these say how far it has got, run the copy in the foreground,
 * empty the old tables once it is done, and go back.
 */
import { createInterface } from "node:readline/promises";
import type { ClickHouseStore, MoveState } from "@runlight/sdk/clickhouse";

export const CLICKHOUSE_HELP = `Move the visits and events into ClickHouse, and back. Set CLICKHOUSE_URL first.

Usage:
  npx @runlight/server clickhouse status         How far the copy has got, and what each database holds
  npx @runlight/server clickhouse copy           Copy the rest now, rather than in the background
  npx @runlight/server clickhouse drop-old       Empty the old tables, once everything is in ClickHouse
  npx @runlight/server clickhouse copy --back    Copy everything back, then empty ClickHouse

  --yes    Skip the question drop-old and copy --back ask first

The server starts copying by itself the first time it runs with CLICKHOUSE_URL.
Stop the server before copy --back, and remove CLICKHOUSE_URL once it is done.

Docs: https://runlight.sh/docs/clickhouse/
`;

const n = (count: number) => count.toLocaleString("en");
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Asks to type yes, unless --yes was given. Without a terminal to ask in, the answer is no. */
async function confirmed(args: string[], question: string): Promise<boolean> {
  if (args.includes("--yes")) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write(`${question}\nRun it again with --yes to go ahead.\n`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question}\nType yes to go ahead: `)).trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

function progress(state: MoveState): string {
  return state.done ? "Copied everything." : `Copied the visits back to ${date(state.through)}.`;
}

export async function runClickhouse(args: string[], store: ClickHouseStore, other: string): Promise<void> {
  const [command] = args;
  if (!command || command === "--help" || command === "-h" || args.includes("--help")) return void process.stdout.write(CLICKHOUSE_HELP);

  if (command === "status") {
    let state: MoveState | null;
    let counts: Awaited<ReturnType<ClickHouseStore["counts"]>>;
    try {
      state = await store.moveState();
      counts = await store.counts();
    } catch (error) {
      if (!/UNKNOWN_(TABLE|DATABASE)|does not exist/i.test(String(error))) throw error;
      return void process.stdout.write("ClickHouse has no Runlight tables yet. Start the server with CLICKHOUSE_URL, or run clickhouse copy.\n");
    }
    const lines = [`ClickHouse holds ${n(counts.clickhouse.visits)} visits and ${n(counts.clickhouse.events)} events.`];
    if (!state) lines.push("Nothing copied yet: the server starts copying the first time it runs with CLICKHOUSE_URL, or run clickhouse copy.");
    else if (state.done) lines.push(state.through < state.at ? `Every visit from ${other} is in ClickHouse, which took over on ${date(state.at)}.` : "There was nothing to copy.");
    else lines.push(`Copying from ${other}: back to ${date(state.through)} so far, ${n(counts.other.copied ?? 0)} of ${n(counts.other.visits)} visits.`);
    if (state?.done && counts.other.visits + counts.other.events > 0) lines.push(`${other} still holds the old ${n(counts.other.visits)} visits and ${n(counts.other.events)} events, which nothing reads. Run clickhouse drop-old to empty them.`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  if (command === "copy" && args.includes("--back")) {
    const state = await store.moveState();
    if (state && !state.done) throw new Error("The copy into ClickHouse has not finished. Run clickhouse copy first, then copy --back.");
    const counts = await store.counts();
    const question = `This replaces the visits and events in ${other} with ClickHouse's ${n(counts.clickhouse.visits)} visits and ${n(counts.clickhouse.events)} events, then empties ClickHouse. Stop the server first.`;
    if (!(await confirmed(args, question))) return void (process.exitCode = 1);
    let shown = 0;
    await store.copyBack((copied) => {
      if (Date.now() - shown < 2_000) return;
      shown = Date.now();
      process.stdout.write(`Copied ${n(copied.visits)} visits and ${n(copied.events)} events.\n`);
    });
    process.stdout.write(`Done. Everything is back in ${other}. Remove CLICKHOUSE_URL and start the server; the reports' daily totals are built again as it runs.\n`);
    return;
  }

  if (command === "copy") {
    await store.migrate();
    let shown = 0;
    const state = await store.copy((step) => {
      if (Date.now() - shown < 2_000 && !step.done) return;
      shown = Date.now();
      process.stdout.write(`${progress(step)}\n`);
    });
    process.stdout.write(state && state.through < state.at ? `Every visit from ${other} is in ClickHouse.\n` : "There was nothing to copy.\n");
    return;
  }

  if (command === "drop-old") {
    const state = await store.moveState();
    if (!state) throw new Error("Nothing has been copied into ClickHouse yet, so the old tables are all there is. Start the server with CLICKHOUSE_URL, or run clickhouse copy.");
    if (!state.done) throw new Error(`The copy is back to ${date(state.through)} so far. Let it finish, or run clickhouse copy, then drop-old.`);
    const counts = await store.counts();
    if (counts.other.visits + counts.other.events === 0) return void process.stdout.write(`The old tables in ${other} are already empty.\n`);
    const question = `This empties the old visits and events in ${other}: ${n(counts.other.visits)} visits and ${n(counts.other.events)} events, all of them copied into ClickHouse.`;
    if (!(await confirmed(args, question))) return void (process.exitCode = 1);
    await store.dropOld();
    process.stdout.write(`Done. ${other} keeps the sites, goals, accounts, and settings; the visits are in ClickHouse.\n`);
    return;
  }

  throw new Error(`Unknown command "clickhouse ${command}". Run npx @runlight/server clickhouse --help.`);
}

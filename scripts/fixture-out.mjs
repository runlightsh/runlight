/**
 * How the fixture generators write their files. A generator calls
 * emit(file, text) where it used to call writeFileSync. Run with --check, it
 * writes nothing: each file is compared with what the generator would write
 * now, and the process ends with status 1 when any differs, naming the file
 * and the first place the two part. CI runs every generator this way
 * (npm run check:fixtures, scripts/check-fixtures.mjs), so a change to the
 * TypeScript that moves a fixture cannot land without the fixture, and the
 * ports that replay it, moving too.
 *
 * A generator that writes records the ICU it ran on in
 * scripts/node-data.json; --check fails only on that ICU, and on another
 * reports that it could not compare (scripts/node-data.mjs).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { record, recorded, skipped } from "./node-data.mjs";

export const CHECK = process.argv.includes("--check");
// For trying a generator without touching the tree: every file goes to this folder instead, by its name alone.
const ELSEWHERE = process.env.RUNLIGHT_FIXTURE_OUT || null;
/** Whether this run writes the fixtures in the tree: a generator that writes a file without emit() asks this first. */
export const WRITING = !CHECK && !ELSEWHERE;

const script = path.basename(process.argv[1] ?? "generator").replace(/\.m?[jt]s$/, "");
const stale = [];
let compared = 0;
let written = 0;

/** The first place two texts part, with a little of each side, on one line. */
export function firstDifference(current, text) {
  let at = 0;
  while (at < current.length && at < text.length && current[at] === text[at]) at++;
  const show = (s) => JSON.stringify(s.slice(Math.max(0, at - 40), at + 60));
  return `at character ${at}: the file has ${show(current)}, the generator writes ${show(text)}`;
}

/** The top-level keys of two JSON objects whose values differ, or null when either text is not one. */
export function differingKeys(current, text) {
  let a;
  let b;
  try {
    a = JSON.parse(current);
    b = JSON.parse(text);
  } catch {
    return null;
  }
  const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!object(a) || !object(b)) return null;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
}

/**
 * Writes `text` to `file` (a path or a file URL), or with --check compares
 * the two. `random` names the top-level keys of a JSON file whose values hold
 * something drawn at random each run (a salt, an IV), which --check leaves
 * out of the comparison: the ports check those by opening them, not by
 * matching bytes.
 */
export function emit(file, text, { random = [] } = {}) {
  if (ELSEWHERE) {
    mkdirSync(ELSEWHERE, { recursive: true });
    writeFileSync(path.join(ELSEWHERE, path.basename(file instanceof URL ? fileURLToPath(file) : file)), text);
    return;
  }
  if (!CHECK) {
    writeFileSync(file, text);
    written++;
    return;
  }
  compared++;
  const name = path.relative(process.cwd(), file instanceof URL ? fileURLToPath(file) : path.resolve(file));
  let current = null;
  try {
    current = readFileSync(file, "utf8");
  } catch {}
  if (current === null) stale.push(`${name} is missing`);
  else if (current !== text) {
    const keys = differingKeys(current, text);
    const real = keys?.filter((key) => !random.includes(key));
    if (keys !== null && keys.length > 0 && real.length === 0) return;
    stale.push(`${name} is stale${real?.length ? ` under ${real.join(", ")}` : ""}, ${firstDifference(current, text)}`);
  }
}

/**
 * Makes crypto.getRandomValues, which the SDK draws its ids and salts from,
 * answer the same bytes on every run (SHA-256 of the seed and a counter), so
 * a generator whose fixture holds such ids writes the same file twice and
 * --check can compare it. Call it before the generator does any work.
 */
export function seedRandom(seed) {
  let counter = 0;
  let pool = Buffer.alloc(0);
  globalThis.crypto.getRandomValues = (array) => {
    const out = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    while (pool.length < out.length) pool = Buffer.concat([pool, createHash("sha256").update(`${seed}:${counter++}`).digest()]);
    out.set(pool.subarray(0, out.length));
    pool = pool.subarray(out.length);
    return array;
  };
}

process.on("exit", (code) => {
  if (code !== 0 || ELSEWHERE) return;
  if (!CHECK) {
    if (written > 0) record(script);
    return;
  }
  if (stale.length === 0) {
    console.log(`${script}: ${compared} file(s) up to date`);
    return;
  }
  // Many fixtures hold what Intl formats, and another ICU formats otherwise, so a difference on an ICU other
  // than the one that wrote them (scripts/node-data.json) proves nothing: it is reported, never failed.
  const icu = recorded(script)?.icu;
  if (typeof icu === "string" && icu !== process.versions.icu) {
    skipped(script, "ICU", icu, process.versions.icu);
    return;
  }
  console.error(`${script}: ${stale.length} of ${compared} file(s) differ from what the TypeScript writes now:`);
  for (const line of stale) console.error(`  ${line}`);
  console.error("Run the generator again without --check (see its header), then the ports' tests.");
  process.exitCode = 1;
});

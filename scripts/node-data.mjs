/**
 * For the generators that copy what Node's ICU says (region names, currency
 * symbols, collation) or its Unicode tables (case, IDNA) into a port. Another
 * ICU or Unicode release writes other data, so a --check run compares a file
 * only on the release that wrote it. On any other release it cannot tell a
 * stale file from a current one, and says so out loud rather than passing in
 * silence: skipped() prints the reason, as a warning on the run's summary
 * page when GitHub Actions runs it on the Node major the files are written
 * with (.nvmrc). It never fails the run: a new Node minor on the runners must
 * not turn main red by itself. The cure for the warning is to run the named
 * generators again on that Node and commit what they write.
 *
 * A file that does not record the release that wrote it (the Java port's,
 * and the fixtures scripts/fixture-out.mjs writes) has it recorded in
 * scripts/node-data.json instead: record() when the generator writes,
 * recorded() when it checks.
 */
import { readFileSync, writeFileSync } from "node:fs";

const SIDECAR = new URL("node-data.json", import.meta.url);

/** The Node major the generated files are written with: .nvmrc's. */
function writingMajor() {
  try {
    return /\d+/.exec(readFileSync(new URL("../.nvmrc", import.meta.url), "utf8"))?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Says that `script` did not compare its files: they were written from
 * `what` (ICU or Unicode) `written`, and this Node has `mine`.
 */
export function skipped(script, what, written, mine) {
  const message = `${script}: not compared. Its files were written from ${what} ${written}, and this Node (${process.versions.node}) has ${what} ${mine}. Run the generator again on this Node and commit the result, so the check compares again.`;
  if (process.env.GITHUB_ACTIONS === "true" && process.versions.node.split(".")[0] === writingMajor()) {
    console.log(`::warning title=${script} did not compare its files::${message}`);
  } else {
    console.log(message);
  }
}

function sidecar() {
  try {
    return JSON.parse(readFileSync(SIDECAR, "utf8"));
  } catch {
    return {};
  }
}

/** What scripts/node-data.json records for `script`: { icu, unicode }, or null. */
export function recorded(script) {
  return sidecar()[script] ?? null;
}

/** Records this Node's ICU and Unicode releases as the ones `script` wrote its files from. */
export function record(script) {
  // A run on GitHub Actions that writes (the Dependabot rebuild, which moves hashes only) leaves the record alone:
  // the record is of the machine a person regenerated on, and that workflow may push generated files only.
  if (process.env.GITHUB_ACTIONS === "true") return;
  const all = sidecar();
  const entry = { icu: process.versions.icu, unicode: process.versions.unicode };
  if (JSON.stringify(all[script]) === JSON.stringify(entry)) return;
  all[script] = entry;
  const sorted = Object.fromEntries(Object.keys(all).sort().map((key) => [key, all[key]]));
  writeFileSync(SIDECAR, `${JSON.stringify(sorted, null, 2)}\n`);
}

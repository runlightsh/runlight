/**
 * Runs every fixture generator with --check, so a fixture the ports replay
 * cannot fall behind the TypeScript that writes it. Nothing is written.
 *
 *   node scripts/check-fixtures.mjs        (npm run check:fixtures)
 *
 * The fixtures are written with the Node major in .nvmrc, and another major
 * may format a number or a date otherwise, so on any other major this says
 * so and passes: CI's leg on .nvmrc's major is the one that compares. Within
 * that major, a generator whose fixture differs on another ICU than the one
 * that wrote it warns instead of failing (scripts/node-data.mjs).
 *
 * Not covered: scripts/dotnet-zones.mjs and scripts/dotnet-tzdata.mjs, which
 * read the machine's zoneinfo, and scripts/agent-ranges.mts, which downloads
 * lists that change by the day. In packages/php/tests/fixtures/store.db only
 * the reads over it (store.json) are compared, not the file's bytes.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** In the order they are regenerated: a later one reads what an earlier one writes. */
export const GENERATORS = [
  "conformance-url.mts",
  "php-fixtures-core.mts",
  "php-fixtures-core2.mts",
  "php-fixtures-routes.mts",
  "php-fixtures-ai.mts",
  "php-fixtures-agents.mts",
  "php-fixtures-outbound.mts",
  "php-fixtures-store.mts",
  "python-fixtures-crypto.mts",
  "python-fixtures-reports.mts",
  "rust-fixtures-reports.mts",
  "dotnet-case.mjs",
];

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const major = /\d+/.exec(readFileSync(new URL("../.nvmrc", import.meta.url), "utf8"))?.[0];
  if (major && process.versions.node.split(".")[0] !== major) {
    console.log(`check-fixtures: skipped on Node ${process.versions.node}; the fixtures are written and compared on Node ${major}.`);
    return;
  }
  const failed = [];
  for (const name of GENERATORS) {
    const args = name.endsWith(".mts") ? ["--import", "tsx", `scripts/${name}`, "--check"] : [`scripts/${name}`, "--check"];
    // The generators that read the clock's zone ask for UTC, as the ports' tests run. The server's tsconfig maps
    // @runlight/sdk to its source, so a generator importing the server runs before the SDK is built, as in CI.
    const env = { ...process.env, TZ: "UTC", TSX_TSCONFIG_PATH: "packages/server/tsconfig.json" };
    const run = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8" });
    // A generator's own chatter is dropped; what the check says is its last lines.
    const said = `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").filter((line) => line.startsWith(name.replace(/\.m?[jt]s$/, "")) || line.startsWith("  ") || line.startsWith("::warning") || line.startsWith("Run the generator"));
    if (run.status !== 0) {
      failed.push(name);
      console.error(said.length > 0 && !run.error ? said.join("\n") : `${name} did not run:\n${run.error?.message ?? ""}${run.stdout ?? ""}${run.stderr ?? ""}`);
    } else {
      console.log(said.join("\n"));
    }
  }
  if (failed.length > 0) {
    console.error(`\ncheck-fixtures: ${failed.length} of ${GENERATORS.length} generators differ: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log(`check-fixtures: ${GENERATORS.length} generators up to date`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

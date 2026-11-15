/**
 * Runs before `npm publish` in packages/sdk and packages/server (each one's
 * prepublishOnly). npm publishes the dist folder as it stands, which git
 * ignores, so without this a build left over from other work would ship
 * under the release's version. It refuses unless:
 *
 *   - HEAD is the commit the tag v<the package's version> names,
 *   - no tracked file has changes, and
 *   - no untracked file sits under a folder the build reads,
 *
 * then builds the package again from that commit (the SDK first for the
 * server, which loads it), and refuses if the build moved a tracked file,
 * which would mean a generated file was stale in the release.
 *
 *   node ../../scripts/prepublish.mjs      (from the package's folder, as npm runs it)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** The folders a build of the npm packages reads. */
export const BUILD_FOLDERS = ["packages/sdk/", "packages/server/", "packages/dashboard/", "packages/tracker/"];

/** The first ten of a list, and how many more there are. */
const some = (list) => (list.length > 10 ? [...list.slice(0, 10), `and ${list.length - 10} more`] : list);

/**
 * Why the package cannot be published from this checkout, as a list (empty
 * when it can). `tagCommit` is null when the tag does not exist; `status` is
 * `git status --porcelain --untracked-files=all`.
 */
export function problems({ version, head, tagCommit, status }) {
  const out = [];
  const tag = `v${version}`;
  if (tagCommit === null) out.push(`there is no tag ${tag}; npm run release -- ${version} makes it`);
  else if (head !== tagCommit) out.push(`HEAD is ${head.slice(0, 12)}, and ${tag} is ${tagCommit.slice(0, 12)}; check out the tag (git switch --detach ${tag}) and publish from there`);
  const lines = status.split("\n").filter(Boolean);
  const changed = lines.filter((line) => !line.startsWith("??")).map((line) => line.slice(3));
  if (changed.length > 0) out.push(`tracked files have changes, so the build would not be the tag's:\n    ${some(changed).join("\n    ")}`);
  const untracked = lines.filter((line) => line.startsWith("??")).map((line) => line.slice(3)).filter((file) => BUILD_FOLDERS.some((folder) => file.startsWith(folder)));
  if (untracked.length > 0) out.push(`untracked files sit where the build reads, so they could end up in the package:\n    ${some(untracked).join("\n    ")}`);
  return out;
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trimEnd();
}

function fail(name, list) {
  console.error(`prepublish: ${name} is not published.\n  ${list.join("\n  ")}`);
  process.exit(1);
}

function main() {
  const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const builds = { "@runlight/sdk": ["packages/sdk"], "@runlight/server": ["packages/sdk", "packages/server"] }[pkg.name];
  if (!builds) fail(pkg.name, ["scripts/prepublish.mjs does not know this package; run it from packages/sdk or packages/server"]);
  let tagCommit = null;
  try {
    tagCommit = git("rev-parse", "--verify", "--quiet", `refs/tags/v${pkg.version}^{commit}`);
  } catch {}
  const state = () => ({ version: pkg.version, head: git("rev-parse", "HEAD"), tagCommit, status: git("status", "--porcelain", "--untracked-files=all") });
  const before = problems(state());
  if (before.length > 0) fail(`${pkg.name} ${pkg.version}`, before);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const workspace of builds) {
    console.log(`prepublish: building ${workspace} from v${pkg.version}`);
    const run = spawnSync(npm, ["run", "build", "--workspace", workspace], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
    if (run.status !== 0) fail(`${pkg.name} ${pkg.version}`, [`the build of ${workspace} failed`]);
  }
  const after = problems(state());
  if (after.length > 0) fail(`${pkg.name} ${pkg.version}`, ["the build changed the checkout:", ...after]);
  console.log(`prepublish: ${pkg.name} ${pkg.version} is built from v${pkg.version} (${tagCommit.slice(0, 12)})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

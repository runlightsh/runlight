// The helpers the generators share: scripts/fixture-out.mjs (what --check
// compares), scripts/node-data.mjs (what a check on another ICU says), and
// scripts/prefix-bound.mjs (the widest prefix agent-ranges.mts takes).
//
//   node --test scripts/generators.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GENERATORS } from "./check-fixtures.mjs";
import { differingKeys, firstDifference } from "./fixture-out.mjs";
import { recorded } from "./node-data.mjs";
import { refusedPrefixes, WIDEST } from "./prefix-bound.mjs";

const SCRIPTS = import.meta.dirname;

test("the first difference between two texts is found and shown", () => {
  assert.match(firstDifference("abcdef", "abcxef"), /^at character 3: the file has "abcdef", the generator writes "abcxef"$/);
  assert.match(firstDifference("abc", "abcd"), /^at character 3:/);
});

test("the keys of two JSON objects that differ are named, and other texts have none", () => {
  assert.deepEqual(differingKeys('{"a":1,"b":[1,2],"c":3}', '{"a":1,"b":[1,3],"d":4}'), ["b", "c", "d"]);
  assert.deepEqual(differingKeys('{"a":1}', '{"a":1}'), []);
  assert.equal(differingKeys("[1]", "[2]"), null);
  assert.equal(differingKeys("not json", "{}"), null);
});

// A generator in a folder of its own, beside copies of the helpers and a record of the ICU that wrote its file.
function scratch(icu) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "runlight-generators-"));
  for (const name of ["fixture-out.mjs", "node-data.mjs"]) writeFileSync(path.join(dir, name), readFileSync(path.join(SCRIPTS, name)));
  writeFileSync(path.join(dir, "node-data.json"), `${JSON.stringify({ gen: { icu, unicode: process.versions.unicode } })}\n`);
  writeFileSync(
    path.join(dir, "gen.mjs"),
    'import { emit } from "./fixture-out.mjs";\nemit(new URL("out.json", import.meta.url), process.env.TEXT, { random: ["salt"] });\n',
  );
  const run = (text, args = [], env = {}) => {
    const clean = { ...process.env, TEXT: text, ...env };
    if (!("GITHUB_ACTIONS" in env)) delete clean.GITHUB_ACTIONS;
    if (!("RUNLIGHT_FIXTURE_OUT" in env)) delete clean.RUNLIGHT_FIXTURE_OUT;
    const result = spawnSync(process.execPath, ["gen.mjs", ...args], { cwd: dir, encoding: "utf8", env: clean });
    return { status: result.status, out: result.stdout, err: result.stderr };
  };
  return { dir, run, file: path.join(dir, "out.json") };
}

test("--check writes nothing, passes a current file, and fails a stale one, naming where", () => {
  const { dir, run, file } = scratch(process.versions.icu);
  try {
    assert.equal(run('{"a":1,"salt":"x"}').status, 0);
    assert.equal(readFileSync(file, "utf8"), '{"a":1,"salt":"x"}');
    const same = run('{"a":1,"salt":"x"}', ["--check"]);
    assert.equal(same.status, 0, same.err);
    assert.match(same.out, /gen: 1 file\(s\) up to date/);
    const stale = run('{"a":2,"salt":"x"}', ["--check"]);
    assert.equal(stale.status, 1);
    assert.match(stale.err, /out\.json is stale under a, at character 5/);
    assert.equal(readFileSync(file, "utf8"), '{"a":1,"salt":"x"}', "--check wrote the file");
    rmSync(file);
    const missing = run('{"a":1}', ["--check"]);
    assert.equal(missing.status, 1);
    assert.match(missing.err, /out\.json is missing/);
    assert.ok(!existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--check leaves a key drawn at random out of the comparison, and nothing else", () => {
  const { dir, run } = scratch(process.versions.icu);
  try {
    run('{"a":1,"salt":"x"}');
    assert.equal(run('{"a":1,"salt":"y"}', ["--check"]).status, 0);
    assert.equal(run('{"a":2,"salt":"y"}', ["--check"]).status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale file on another ICU than the one that wrote it is reported, never failed", () => {
  const { dir, run } = scratch("1.0-not-this-one");
  try {
    run('{"a":1}', [], { GITHUB_ACTIONS: "true" });
    // Written on GitHub Actions, the record is left as it was.
    assert.equal(JSON.parse(readFileSync(path.join(dir, "node-data.json"), "utf8")).gen.icu, "1.0-not-this-one");
    const stale = run('{"a":2}', ["--check"]);
    assert.equal(stale.status, 0, stale.err);
    assert.match(stale.out, /gen: not compared\. Its files were written from ICU 1\.0-not-this-one, and this Node \(.*\) has ICU /);
    // A current file is still said to be current, whatever the ICU.
    assert.match(run('{"a":1}', ["--check"]).out, /up to date/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a generator that writes records the ICU it ran on", () => {
  const { dir, run } = scratch("1.0-not-this-one");
  try {
    run('{"a":1}');
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "node-data.json"), "utf8")).gen, { icu: process.versions.icu, unicode: process.versions.unicode });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RUNLIGHT_FIXTURE_OUT sends the files elsewhere and leaves the tree alone", () => {
  const { dir, run, file } = scratch(process.versions.icu);
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "runlight-generators-out-"));
  try {
    assert.equal(run('{"a":1}', [], { RUNLIGHT_FIXTURE_OUT: elsewhere }).status, 0);
    assert.ok(!existsSync(file));
    assert.equal(readFileSync(path.join(elsewhere, "out.json"), "utf8"), '{"a":1}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("every generator the check runs exists, and each that writes through fixture-out has its ICU on record", () => {
  for (const name of GENERATORS) {
    const text = readFileSync(path.join(SCRIPTS, name), "utf8");
    assert.match(text, /--check|fixture-out\.mjs/, `${name} has no --check`);
    if (text.includes("./fixture-out.mjs")) assert.equal(typeof recorded(name.replace(/\.m?[jt]s$/, ""))?.icu, "string", `${name} is not in scripts/node-data.json`);
  }
  for (const name of ["java-intl", "java-collation"]) assert.equal(typeof recorded(name)?.icu, "string", name);
});

test("a prefix wider than the bound, or one that is not a prefix, is refused", () => {
  assert.deepEqual(refusedPrefixes(["216.73.216.0/22", "34.162.230.222/32", "8.8.8.8", "2600:1900::/28", "2a01:4f8::1", `10.0.0.0/${WIDEST.ipv4}`, `2000::/${WIDEST.ipv6}`]), []);
  const refused = refusedPrefixes(["0.0.0.0/0", "10.0.0.0/8", "::/0", "2000::/3", "1.2.3.4/33", "example.com", 7]);
  assert.equal(refused.length, 7);
  assert.match(refused[0], /0\.0\.0\.0\/0 is wider than \/10/);
  assert.match(refused[2], /::\/0 is wider than \/24/);
  assert.match(refused[4], /past \/32/);
  assert.match(refused[5], /not an address prefix/);
  assert.match(refused[6], /not text/);
});

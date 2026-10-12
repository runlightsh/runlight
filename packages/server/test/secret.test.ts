import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { secretIn } from "../src/secret.js";

const module = fileURLToPath(new URL("../src/secret.ts", import.meta.url));

/** secretIn in a process of its own, as a second server starting on the same folder would call it. */
const inProcess = (dir: string) =>
  new Promise<string>((resolve, reject) =>
    execFile(process.execPath, ["--import", "tsx", "-e", `import(${JSON.stringify(module)}).then((m) => process.stdout.write(m.secretIn(${JSON.stringify(dir)})))`], (error, out) => (error ? reject(error) : resolve(out))),
  );

test("servers starting at once on one folder agree on one secret, kept readable only by this user", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runlight-secret-"));
  const secrets = await Promise.all(Array.from({ length: 6 }, () => inProcess(dir)));
  assert.equal(new Set(secrets).size, 1, secrets.join(" "));
  assert.match(secrets[0]!, /^[a-f0-9]{64}$/);
  assert.equal(secretIn(dir), secrets[0]);
  assert.equal(statSync(path.join(dir, "secret")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["secret"], "no file made on the way is left behind");
});

test("a secret file read empty or short is waited for, and refused rather than used", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "runlight-secret-"));
  writeFileSync(path.join(dir, "secret"), "abc\n");
  const started = Date.now();
  assert.throws(() => secretIn(dir), /holds no whole secret/);
  assert.ok(Date.now() - started >= 1000, "it waited for a writer to finish first");
  writeFileSync(path.join(dir, "secret"), "");
  assert.throws(() => secretIn(dir), /holds no whole secret/);
  const own = "a".repeat(40);
  writeFileSync(path.join(dir, "secret"), `${own}\n`);
  assert.equal(secretIn(dir), own, "one that is whole is kept as it is");
});

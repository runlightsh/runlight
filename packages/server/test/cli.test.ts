import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("a taken port ends the start with one line, and a short token or secret is warned about first", async () => {
  // Something else already listens where the server is told to.
  const taken = createServer();
  await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
  const port = (taken.address() as { port: number }).port;
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    DATA_DIR: mkdtempSync(path.join(tmpdir(), "runlight-cli-")),
    RUNLIGHT_GEO: "off",
    RUNLIGHT_AGENT_RANGES: "off",
    RUNLIGHT_TOKEN: "test",
    RUNLIGHT_SECRET: "x".repeat(40),
    DATABASE_URL: "",
    CLICKHOUSE_URL: "",
    CRONWATCH_MAIL_TO: "",
  };
  try {
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) =>
      execFile(process.execPath, ["--import", "tsx", cli], { env, timeout: 30_000 }, (error, _out, stderr) => resolve({ code: error ? ((error as { code?: number }).code ?? null) : 0, stderr })),
    );
    assert.equal(code, 1);
    assert.match(stderr, /WARNING: RUNLIGHT_TOKEN is only 4 characters long/);
    assert.doesNotMatch(stderr, /RUNLIGHT_SECRET/, "a long secret is not warned about");
    assert.match(stderr, new RegExp(`Runlight: could not listen on 127\\.0\\.0\\.1:${port}: .*EADDRINUSE`));
    assert.doesNotMatch(stderr, /\n\s+at /, "no stack trace");
  } finally {
    taken.close();
  }
});

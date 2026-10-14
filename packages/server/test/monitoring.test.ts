import assert from "node:assert/strict";
import { test } from "node:test";
import { memory } from "@cronwatch/sdk";
import type { Runlight } from "@runlight/sdk";
import { sqlite } from "@runlight/sdk/sqlite";
import { createMonitoring } from "../src/monitoring.js";
import { createServer } from "../src/server.js";

test("maintenance records legitimate no-work runs, reports partial email failures, and recovers", async () => {
  const messages: Array<{ to: string; subject: string }> = [];
  let failed = 0;
  const runlight = {
    sites: [],
    check: async () => ({ ok: true, reports: { sent: 0, failed } }),
    sendMail: async (message: { to: string; subject: string }) => { messages.push(message); },
  } as unknown as Runlight;
  const monitor = createMonitoring({ runlight, dataDir: "/unused", to: "alerts@example.com", store: memory() });
  try {
    await monitor.maintenance();
    assert.equal((await monitor.client.runs("runlight-maintenance"))[0]!.status, "ok");
    assert.equal(messages.length, 0);
    failed = 1;
    await assert.rejects(monitor.maintenance(), /scheduled email reports failed/);
    await monitor.client.check();
    assert.ok(messages.some((message) => message.to === "alerts@example.com" && /failed/i.test(message.subject)));
    failed = 0;
    await monitor.maintenance();
    await monitor.client.check();
    assert.ok(messages.some((message) => /recovered/i.test(message.subject)));
  } finally { await monitor.close(); }
});

test("location monitoring rejects silent download failures and declares only enabled jobs", async () => {
  const runlight = { sites: [], sendMail: async () => {} } as unknown as Runlight;
  const geo = { release: "", refresh: async () => {} };
  const monitor = createMonitoring({ runlight, dataDir: "/unused", to: "alerts@example.com", store: memory(), geo });
  try {
    await assert.rejects(monitor.locations(), /No usable location database/);
    geo.release = "2000-01";
    await assert.rejects(monitor.locations(), /more than one release behind/);
    geo.release = new Date().toISOString().slice(0, 7);
    await monitor.locations();
    assert.equal((await monitor.client.runs("runlight-location-data"))[0]!.status, "ok");
  } finally { await monitor.close(); }
  const disabled = createMonitoring({ runlight, dataDir: "/unused", to: "alerts@example.com", store: memory() });
  try { assert.equal(await disabled.client.jobSummary("runlight-location-data"), null); }
  finally { await disabled.close(); }
});

test("monitoring routes require an unrestricted owner or admin even when a bearer token is provided", async () => {
  const store = sqlite({ path: ":memory:" });
  const server = createServer({ store, secret: "s".repeat(64), token: "api-token", monitoring: async () => new Response("monitoring") });
  const request = (cookie = "", method = "GET") => new Request("https://stats.example.com/cronwatch/api/jobs", { method, headers: { cookie, authorization: "Bearer api-token" } });
  try {
    assert.equal((await server.handler(request())).status, 303);
    assert.equal((await server.handler(request("", "POST"))).status, 401);
    for (const role of ["owner", "admin", "member", "viewer"] as const) {
      const user = await server.accounts.setPassword(`${role}@example.com`, "a long password", Date.now(), role);
      const cookie = `runlight_session=${encodeURIComponent(await server.accounts.sessionFor(user, Date.now()))}`;
      assert.equal((await server.handler(request(cookie))).status, role === "owner" || role === "admin" ? 200 : 403);
    }
    const scoped = await server.accounts.setPassword("scoped@example.com", "a long password", Date.now(), "member", "alpha");
    const cookie = `runlight_session=${encodeURIComponent(await server.accounts.sessionFor(scoped, Date.now()))}`;
    assert.equal((await server.handler(request(cookie))).status, 403);
  } finally { await store.close(); }
});

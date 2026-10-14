import assert from "node:assert/strict";
import { test } from "node:test";
import { sqlite } from "@runlight/sdk/sqlite";
import { createServer } from "../src/server.js";

const origin = "https://stats.example.com";

test("home-screen artwork and the manifest are local and public before account setup", async () => {
  const store = sqlite({ path: ":memory:" });
  const server = createServer({ store, secret: "s".repeat(64), url: origin });
  try {
    for (const [path, size] of [["/apple-touch-icon.png", 180], ["/icon-192.png", 192], ["/icon-512.png", 512]] as const) {
      const response = await server.handler(new Request(origin + path));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/png");
      const png = Buffer.from(await response.arrayBuffer());
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), size);
      assert.equal(png.readUInt32BE(20), size);
      const head = await server.handler(new Request(origin + path, { method: "HEAD" }));
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
    }
    const favicon = await server.handler(new Request(origin + "/favicon.ico"));
    assert.equal(Buffer.from(await favicon.arrayBuffer()).subarray(0, 4).toString("hex"), "00000100");
    const svg = await server.handler(new Request(origin + "/favicon.svg"));
    assert.match(await svg.text(), /<circle[^>]+fill="#22c55e"/);
    const manifest = await server.handler(new Request(origin + "/manifest.webmanifest"));
    assert.equal(manifest.headers.get("content-type"), "application/manifest+json");
    const body = await manifest.json();
    assert.equal(body.start_url, "/");
    assert.deepEqual(body.icons.map((icon: { src: string }) => icon.src), ["/icon-192.png", "/icon-512.png"]);
    assert.equal((await server.handler(new Request(origin + "/api/sites"))).status, 401);
  } finally {
    await store.close();
  }
});

test("setup, sign-in, and dashboard pages declare icons without weakening account protection", async () => {
  const store = sqlite({ path: ":memory:" });
  const server = createServer({ store, secret: "s".repeat(64), url: origin, token: "test-token" });
  try {
    const setup = await server.handler(new Request(`${origin}/setup?code=${server.setupCode}`));
    await server.accounts.setPassword("preview@example.com", "a long test password", Date.now());
    const login = await server.handler(new Request(origin + "/login"));
    const signedIn = await server.handler(new Request(origin + "/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "preview@example.com", password: "a long test password" }),
    }));
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
    const dashboard = await server.handler(new Request(origin + "/", { headers: { cookie } }));
    for (const response of [setup, login, dashboard]) {
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /rel="apple-touch-icon" href="\/apple-touch-icon.png" sizes="180x180"/);
      assert.match(html, /rel="icon" href="\/favicon.svg" type="image\/svg\+xml"/);
      assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
      const csp = response.headers.get("content-security-policy")!;
      assert.match(csp, /manifest-src 'self'/);
      assert.match(csp, /img-src 'self' data:/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /default-src 'none'/);
    }
  } finally {
    await store.close();
  }
});

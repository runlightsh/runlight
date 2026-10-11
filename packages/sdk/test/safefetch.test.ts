import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { MetadataAddressError, PrivateAddressError, installAddress, installFetch, metadataAddress, metadataHost, publicAddress, publicFetch, resolvesPrivately, serviceFetch } from "../src/safefetch.js";

test("link-local and cloud metadata addresses are told apart from loopback and private ones", async () => {
  for (const ip of ["169.254.169.254", "169.254.0.1", "100.100.100.200", "fe80::1", "fe80::a9fe:a9fe", "fd00:ec2::254", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe"]) {
    assert.equal(metadataAddress(ip), true, ip);
  }
  for (const ip of ["127.0.0.1", "::1", "10.0.0.5", "192.168.1.20", "fd00::1", "fd00:ec2::253", "93.184.215.14", "not an address"]) assert.equal(metadataAddress(ip), false, ip);
  assert.equal(await metadataHost("metadata.google.internal"), true);
  assert.equal(await metadataHost("[fd00:ec2::254]"), true);
  assert.equal(await metadataHost("169.254.169.254"), true);
  assert.equal(await metadataHost("localhost"), false, "a model on this computer is fine");
  assert.equal(await metadataHost("192.168.1.20"), false);
});

test("only addresses on the public internet count as public", () => {
  for (const ip of ["93.184.215.14", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:82a::200e"]) assert.equal(publicAddress(ip), true, ip);
  for (const ip of [
    "127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fd00::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:169.254.169.254", "64:ff9b::a00:1",
    "2002:a00:1::", "2001:db8::1", "2001:0:4136:e378::1", "[::1]", "not an address", "1.2.3", "1.2.3.256",
  ]) assert.equal(publicAddress(ip), false, ip);
});

test("a public fetch never reaches the install's own network, however the address is written", async () => {
  // Something listening locally, which none of these may reach.
  let reached = 0;
  const inside = createServer((_, res) => {
    reached++;
    res.end("secret");
  });
  await new Promise<void>((resolve) => inside.listen(0, "127.0.0.1", resolve));
  const port = (inside.address() as { port: number }).port;
  try {
    for (const url of [`http://127.0.0.1:${port}/`, `https://127.0.0.1:${port}/`, `https://[::1]:${port}/`, `https://[::ffff:127.0.0.1]:${port}/`, `https://localhost:${port}/`]) {
      await assert.rejects(publicFetch(url, { timeoutMs: 2000 }), PrivateAddressError, url);
    }
    assert.equal(reached, 0);
    assert.equal(await resolvesPrivately("localhost"), true);
    assert.equal(await resolvesPrivately("name.that.does.not.resolve.invalid"), false);
  } finally {
    inside.close();
  }
});

test("a fetch that sends something follows no redirect, and says what it asked", async () => {
  const asked: Array<{ url: string; method: string; body: string }> = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    asked.push({ url: String(input), method: String(init.method), body: String(init.body) });
    return new Response(null, { status: 307, headers: { location: "https://93.184.215.15/elsewhere" } });
  }) as typeof globalThis.fetch;
  const answer = await publicFetch("https://93.184.215.14/token", { timeoutMs: 2000, method: "POST", body: "code=1", redirects: 3, fetch });
  assert.equal(answer.status, 307, "the redirect comes back as it is");
  assert.deepEqual(asked, [{ url: "https://93.184.215.14/token", method: "POST", body: "code=1" }]);
});

test("another install is only fetched at a public https address, with no redirect followed", async () => {
  let reached = 0;
  const inside = createServer((_, res) => {
    reached++;
    res.writeHead(302, { location: "http://169.254.169.254/" }).end();
  });
  await new Promise<void>((resolve) => inside.listen(0, "127.0.0.1", resolve));
  const port = (inside.address() as { port: number }).port;
  try {
    for (const url of ["https://example.com/runlight", "https://example.com"]) assert.equal(installAddress(url, false), true, url);
    for (const url of [`http://127.0.0.1:${port}/runlight`, "http://localhost", "http://example.com", "ftp://example.com"]) assert.equal(installAddress(url, false), false, url);
    // Only code allows an install on this machine, and then only at these two names.
    for (const url of [`http://127.0.0.1:${port}/runlight`, "http://localhost", "http://localhost:3000/runlight"]) assert.equal(installAddress(url, true), true, url);
    for (const url of ["http://10.0.0.1", "http://localhost.example.com", "http://localhost@example.com", "http://127.0.0.1:80@example.com"]) assert.equal(installAddress(url, true), false, url);

    for (const url of [`http://127.0.0.1:${port}/api/sites`, `https://127.0.0.1:${port}/api/sites`, `https://localhost:${port}/api/sites`, "https://169.254.169.254/latest/meta-data/"]) {
      await assert.rejects(installFetch(url, { timeoutMs: 2000, local: false }), PrivateAddressError, url);
    }
    assert.equal(reached, 0, "nothing on this machine was asked");
    // Allowed in code, a local install is asked, and its redirect is handed back, not followed.
    const answer = await installFetch(`http://127.0.0.1:${port}/api/sites`, { timeoutMs: 2000, local: true });
    assert.equal(answer.status, 302);
    assert.equal(reached, 1);
  } finally {
    inside.close();
  }
});

test("a service's redirects are followed only while each one stays off link-local and metadata addresses", async () => {
  const seen: Array<{ method: string; url: string; body: string; authorization: string; type: string }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: String(req.method), url: String(req.url), body, authorization: String(req.headers.authorization ?? ""), type: String(req.headers["content-type"] ?? "") });
    const port = (server.address() as { port: number }).port;
    if (req.url === "/metadata") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    if (req.url === "/metadata-v6") return res.writeHead(307, { location: "http://[fd00:ec2::254]/" }).end();
    if (req.url === "/see-other") return res.writeHead(303, { location: "/landed" }).end();
    if (req.url === "/keep") return res.writeHead(307, { location: "/landed" }).end();
    if (req.url === "/elsewhere") return res.writeHead(307, { location: `http://localhost:${port}/landed` }).end();
    if (req.url === "/loop") return res.writeHead(302, { location: "/loop" }).end();
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const ask = { method: "POST", headers: { authorization: "Bearer key", "content-type": "application/json" }, body: "{}" };
  try {
    // A service on this computer is fine; a redirect to a metadata address is refused before it is asked.
    await assert.rejects(serviceFetch(`${base}/metadata`, ask), (error: Error) => error instanceof MetadataAddressError && (error as MetadataAddressError).host === "169.254.169.254");
    await assert.rejects(serviceFetch(`${base}/metadata-v6`, ask), (error: Error) => error instanceof MetadataAddressError && (error as MetadataAddressError).host === "fd00:ec2::254");
    await assert.rejects(serviceFetch("http://169.254.169.254/v1/models", {}), MetadataAddressError);
    // Followed as fetch follows them: a 303 goes on as a GET with no body, a 307 keeps both, and the key
    // goes no further than the origin it was meant for.
    seen.length = 0;
    assert.equal(await (await serviceFetch(`${base}/see-other`, ask)).text(), "ok");
    assert.deepEqual(seen[1], { method: "GET", url: "/landed", body: "", authorization: "Bearer key", type: "" });
    seen.length = 0;
    await serviceFetch(`${base}/keep`, ask);
    assert.deepEqual(seen[1], { method: "POST", url: "/landed", body: "{}", authorization: "Bearer key", type: "application/json" });
    seen.length = 0;
    await serviceFetch(`${base}/elsewhere`, ask);
    assert.deepEqual(seen[1], { method: "POST", url: "/landed", body: "{}", authorization: "", type: "application/json" });
    // Past the last redirect, the redirect comes back as it is.
    seen.length = 0;
    assert.equal((await serviceFetch(`${base}/loop`, { redirects: 2 })).status, 302);
    assert.equal(seen.length, 3);
    // The AI assistant and a mail webhook refuse such a redirect with the address it led to.
    const { listModels } = await import("../src/assistant.js");
    await assert.rejects(listModels({ provider: "custom", baseUrl: `${base}/metadata#`, key: "" }), (error: Error & { code?: string; params?: Record<string, string> }) => error.code === "address_refused");
    const { send, MailError } = await import("../src/mail/transports.js");
    const message = { to: "me@example.com", from: "reports@example.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi" };
    await assert.rejects(
      send({ service: "webhook", url: `http://localhost:${(server.address() as { port: number }).port}/metadata` }, message),
      (error: Error) => error instanceof MailError && error.code === "address_refused" && error.message === "169.254.169.254 is a link-local or cloud metadata address, which Runlight never connects to",
    );
  } finally {
    server.close();
  }
});

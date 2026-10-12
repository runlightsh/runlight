import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { MetadataAddressError, PrivateAddressError, RedirectRefusedError, installAddress, installFetch, metadataAddress, metadataHost, publicAddress, publicFetch, publicFetchThroughGlobal, resolvesPrivately, serviceFetch } from "../src/safefetch.js";

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
    // Another origin, even the same computer under another name, is never asked.
    seen.length = 0;
    await assert.rejects(serviceFetch(`${base}/elsewhere`, ask), (error: Error) => error instanceof RedirectRefusedError && (error as RedirectRefusedError).to === `http://localhost:${(server.address() as { port: number }).port}`);
    assert.equal(seen.length, 1);
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

test("a service's redirect to another origin is refused before anything, its key or its body, is sent there", async () => {
  const real = globalThis.fetch;
  publicFetchThroughGlobal(true);
  const asked: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    asked.push({ url: String(input), headers: { ...(init.headers as Record<string, string>) }, body: String(init.body ?? "") });
    return new Response(null, { status: 307, headers: { location: "http://198.51.100.7/steal" } });
  }) as typeof fetch;
  try {
    const refusedTo = (error: Error & { code?: string; params?: Record<string, string> }) => error.code === "redirect_refused" && error.params?.to === "http://198.51.100.7";
    // Every header a service names its key in, and a 307 that would keep the body.
    for (const key of ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key", "x-postmark-server-token"]) {
      asked.length = 0;
      await assert.rejects(serviceFetch("https://93.184.215.14/v1/messages", { method: "POST", headers: { [key]: "secret" }, body: "a conversation" }), RedirectRefusedError);
      assert.equal(asked.length, 1, `${key}: nothing goes to the other origin`);
    }
    // https to http on the same host is another origin too.
    globalThis.fetch = (async (input: string | URL | Request) => {
      asked.push({ url: String(input), headers: {}, body: "" });
      return new Response(null, { status: 308, headers: { location: "http://93.184.215.14/v1/messages" } });
    }) as typeof fetch;
    asked.length = 0;
    await assert.rejects(serviceFetch("https://93.184.215.14/v1/messages", { method: "POST", body: "{}" }), (error: Error) => error instanceof RedirectRefusedError && (error as RedirectRefusedError).to === "http://93.184.215.14");
    assert.equal(asked.length, 1);
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      asked.push({ url: String(input), headers: { ...(init.headers as Record<string, string>) }, body: String(init.body ?? "") });
      return new Response(null, { status: 307, headers: { location: "http://198.51.100.7/steal" } });
    }) as typeof fetch;

    // The assistant, with Anthropic's x-api-key, both listing models and asking a question.
    const { chat, listModels } = await import("../src/assistant.js");
    asked.length = 0;
    await assert.rejects(listModels({ provider: "anthropic", baseUrl: "https://93.184.215.14/v1", key: "sk-ant-secret" }), refusedTo);
    await assert.rejects(
      chat({ provider: "anthropic", model: "m", baseUrl: "https://93.184.215.14/v1", key: "sk-ant-secret" }, [{ role: "user", content: "How many visitors?" }], { site: { id: "a", name: "A", timezone: "UTC" }, today: "2026-10-12", view: "today", language: "en" }, async () => new Response("{}")),
      refusedTo,
    );
    assert.deepEqual(asked.map((a) => [a.url, a.headers["x-api-key"]]), [["https://93.184.215.14/v1/models?limit=100", "sk-ant-secret"], ["https://93.184.215.14/v1/messages", "sk-ant-secret"]]);

    // Mail services, with Brevo's api-key and Postmark's server token, and a webhook.
    const { send, MailError } = await import("../src/mail/transports.js");
    const message = { to: "me@example.com", from: "reports@example.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi" };
    const configs: Array<Record<string, string> & { service: string }> = [{ service: "brevo", apiKey: "xkeysib-secret" }, { service: "postmark", serverToken: "pm-secret" }, { service: "webhook", url: "https://93.184.215.14/hook" }];
    for (const config of configs) {
      asked.length = 0;
      await assert.rejects(send(config, message), (error: Error) => error instanceof MailError && refusedTo(error));
      assert.equal(asked.length, 1, `${config.service}: the email goes nowhere else`);
    }
  } finally {
    globalThis.fetch = real;
    publicFetchThroughGlobal(false);
  }
});

test("a service is fetched from the address its name was checked at, and a name that cannot be looked up is refused", async () => {
  const dns = (await import("node:dns")).default;
  const realLookup = dns.lookup;
  let answers: Record<string, string> = {};
  let reached = 0;
  const server = createServer((req, res) => {
    reached++;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  // The resolver the connection itself asks, so what it answers is what gets connected to.
  dns.lookup = ((name: string, options: unknown, callback: (error: Error | null, addresses?: Array<{ address: string; family: number }>) => void) => {
    const address = answers[name];
    if (!address) return callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: "ENOTFOUND" }));
    callback(null, [{ address, family: address.includes(":") ? 6 : 4 }]);
  }) as typeof dns.lookup;
  try {
    // A model on this computer, by a name of its own, is fine.
    answers = { "models.example": "127.0.0.1" };
    assert.equal(await (await serviceFetch(`http://models.example:${port}/v1/models`, {})).text(), "ok");
    assert.equal(reached, 1);
    // The same name answering with a metadata address next time is refused at the connection, before anything is sent.
    answers = { "models.example": "169.254.169.254" };
    await assert.rejects(serviceFetch(`http://models.example:${port}/v1/models`, { method: "POST", headers: { "x-api-key": "secret" }, body: "{}" }), MetadataAddressError);
    answers = { "models.example": "fd00:ec2::254" };
    await assert.rejects(serviceFetch(`http://models.example:${port}/v1/models`, {}), MetadataAddressError);
    // A name that cannot be looked up gets nowhere, rather than being let through to a lookup of fetch's own.
    answers = {};
    await assert.rejects(serviceFetch(`http://models.example:${port}/v1/models`, {}), /ENOTFOUND/);
    assert.equal(reached, 1);
  } finally {
    dns.lookup = realLookup;
    server.close();
  }
});

/**
 * Fetches from addresses that other people's input names, such as the icon
 * links on a site's home page or a link domain, and only from the public
 * internet. Only https is fetched, never a private, loopback, link-local,
 * or metadata address, and redirects are followed by hand under the same
 * rules. The check runs on the address the connection uses, so a name that
 * answers differently a moment later (DNS rebinding) gets nowhere: on Node
 * and Deno through the lookup their https module connects with, and on Bun
 * by fetching the checked address itself, with the name in the Host header,
 * which Bun checks the certificate against.
 *
 * Elsewhere, such as Cloudflare Workers and other edge runtimes, fetch
 * cannot be told which address to use, so only the name is checked, where
 * the runtime can resolve one at all, and a name that resolves to a public
 * address for the check and a private one a moment later is not caught.
 * Those runtimes reach no private network of the install's own, which is
 * what the check protects.
 */
import type { LookupAddress } from "node:dns";

/** Refused before anything was fetched, because the address is not on the public internet. */
export class PrivateAddressError extends Error {
  constructor(what: string) {
    super(`${what} is not a public address`);
    this.name = "PrivateAddressError";
  }
}

const v4 = (text: string): number[] | null => {
  const parts = text.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.map(Number);
};

function publicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a! >= 224) return false;
  if (a === 100 && b! >= 64 && b! < 128) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b! >= 16 && b! < 32) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** An IPv6 address as eight 16-bit groups, or null when it is not one. */
function v6(text: string): number[] | null {
  let address = text.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  // A trailing IPv4 address becomes the last two groups.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (tail) {
    const four = v4(tail[1]!);
    if (!four) return null;
    address = `${address.slice(0, -tail[1]!.length)}${((four[0]! << 8) | four[1]!).toString(16)}:${((four[2]! << 8) | four[3]!).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** Whether an IP address, v4 or v6, is on the public internet. Anything that is not an address is not. */
export function publicAddress(ip: string): boolean {
  const four = v4(ip);
  if (four) return publicV4(four);
  const g = v6(ip);
  if (!g) return false;
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  // IPv4 inside IPv6: mapped (::ffff:0:0/96), the old compatible form (::/96), translated (::ffff:0:0:0/96),
  // and NAT64 (64:ff9b::/96).
  const v4inside = embeddedV4(g);
  if (v4inside) return g[5] === 0 && g[4] === 0 && g[6] === 0 && g[7]! <= 1 ? false : publicV4(v4inside);
  // 6to4 carries an IPv4 address in its second and third groups.
  if (g[0] === 0x2002) return publicV4(embedded(g[1]!, g[2]!));
  // Only global unicast (2000::/3) is public, which leaves out unique local, link-local, the old site-local,
  // multicast, discard, and local-use NAT64 (64:ff9b:1::/48), which may carry any address.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  // The protocol assignments (2001::/23, with Teredo and ORCHID) and the documentation prefixes.
  if (g[0] === 0x2001 && (g[1]! < 0x200 || g[1] === 0xdb8)) return false;
  if ((g[0]! & 0xfff0) === 0x3ff0) return false;
  return true;
}

/** The IPv4 address inside a mapped, compatible, translated, or NAT64 IPv6 address, or null. */
function embeddedV4(g: number[]): number[] | null {
  const inside =
    (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) ||
    (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) ||
    (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0));
  return inside ? [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255] : null;
}

/** Names clouds give their metadata services. */
const METADATA_NAMES = new Set(["metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal"]);

/**
 * Whether an address is link-local (169.254.0.0/16, fe80::/10) or a cloud's metadata service (fd00:ec2::254,
 * Alibaba's 100.100.100.200), in any of its IPv6 spellings. A model's API or a mail server is never there,
 * though it may well be on this computer or a private network, so those stay allowed where this is checked.
 */
export function metadataAddress(ip: string): boolean {
  const four = v4(ip);
  const g = four ? null : v6(ip);
  // IPv4 inside IPv6, mapped, compatible, translated, or NAT64, is read as IPv4.
  const inner = four ?? (g ? embeddedV4(g) : null);
  if (inner) return (inner[0] === 169 && inner[1] === 254) || inner.join(".") === "100.100.100.200";
  if (!g) return false;
  if ((g[0]! & 0xffc0) === 0xfe80) return true;
  return g[0] === 0xfd00 && g[1] === 0xec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254;
}

/**
 * Whether a host, by its name, its address, or any address its name resolves to now, is link-local or a
 * metadata service. A name that does not resolve here, or a runtime with no resolver, is let through,
 * since the connection then goes nowhere such a check could have stopped.
 */
export async function metadataHost(host: string): Promise<boolean> {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (METADATA_NAMES.has(name) || metadataAddress(name)) return true;
  if (v4(name) || v6(name)) return false;
  const dns = await resolver();
  if (!dns) return false;
  try {
    return (await dns.lookup(name, { all: true })).some((a) => metadataAddress(a.address));
  } catch {
    return false;
  }
}

type Http = typeof import("node:http");
type Https = typeof import("node:https");
type Dns = typeof import("node:dns");
type Stream = typeof import("node:stream");

/**
 * Node's own modules where the runtime has them, found without an import a bundler would follow.
 * Workers reach no private network, and their https module may only be a stand-in, so they use fetch.
 * So does Bun, whose https module connects by address and then checks the certificate against it; there
 * the name is resolved and checked just before each request instead.
 */
function builtins(): { http: Http; https: Https; dns: Dns; stream: Stream } | null {
  const scope = globalThis as { process?: { getBuiltinModule?: (id: string) => unknown }; navigator?: { userAgent?: string }; Bun?: unknown };
  const get = scope.process?.getBuiltinModule;
  if (typeof get !== "function" || scope.navigator?.userAgent === "Cloudflare-Workers" || scope.Bun !== undefined) return null;
  try {
    const http = get("node:http") as Http | undefined;
    const https = get("node:https") as Https | undefined;
    const dns = get("node:dns") as Dns | undefined;
    const stream = get("node:stream") as Stream | undefined;
    return typeof http?.request === "function" && typeof https?.request === "function" && typeof dns?.lookup === "function" && typeof stream?.Readable?.toWeb === "function"
      ? { http, https, dns, stream }
      : null;
  } catch {
    return null;
  }
}

/** A resolver for names, where the runtime has one, even without the rest of Node's modules. */
async function resolver(): Promise<Dns["promises"] | null> {
  const node = builtins();
  if (node) return node.dns.promises;
  try {
    const dns = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule?.("node:dns") as Dns | undefined;
    if (typeof dns?.promises?.lookup === "function") return dns.promises;
  } catch {
    // Looked for below instead.
  }
  try {
    // A name in a variable, so a bundler for an edge runtime leaves the import alone.
    const id = "node:dns";
    const dns = (await import(id)) as Dns;
    return typeof dns.promises?.lookup === "function" ? dns.promises : null;
  } catch {
    return null;
  }
}

/** The public addresses a name resolves to, for setting up DNS records. None where it does not resolve, or cannot be looked up here. */
export async function publicAddresses(name: string): Promise<string[]> {
  const dns = await resolver();
  if (!dns) return [];
  try {
    return [...new Set((await dns.lookup(name, { all: true })).map((a) => a.address).filter(publicAddress))];
  } catch {
    return [];
  }
}

/** Whether a name resolves to an address off the public internet. False when it does not resolve, or cannot be looked up here. */
export async function resolvesPrivately(name: string): Promise<boolean> {
  const dns = await resolver();
  if (!dns) return false;
  try {
    const found = await dns.lookup(name, { all: true });
    return found.some((a) => !publicAddress(a.address));
  } catch {
    return false;
  }
}

/** What one request sends. */
interface Ask {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Which addresses a request may connect to, and what it throws for one it may not. */
interface Rule {
  allowed(ip: string): boolean;
  refused(host: string): Error;
}

const PUBLIC: Rule = { allowed: publicAddress, refused: (host) => new PrivateAddressError(host) };

/**
 * One request with no redirects, connecting only to addresses `rule` allows: by default, public ones over https.
 * A host written as an address is never looked up, so the caller checks it first.
 */
function once(node: NonNullable<ReturnType<typeof builtins>>, url: URL, ask: Ask, signal: AbortSignal | undefined, rule: Rule = PUBLIC): Promise<Response> {
  // The lookup Node calls when it connects, so the address checked is the address used.
  const lookup = (hostname: string, options: { all?: boolean }, callback: (error: Error | null, address?: string | LookupAddress[], family?: number) => void) => {
    node.dns.lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return callback(error);
      const bad = addresses.find((a) => !rule.allowed(a.address));
      if (bad || !addresses.length) return callback(rule.refused(hostname));
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
  return new Promise((resolve, reject) => {
    const headers = ask.body === undefined ? ask.headers : { ...ask.headers, "content-length": String(new TextEncoder().encode(ask.body).byteLength) };
    // An agent of its own, never the global one: with NODE_USE_ENV_PROXY that one goes through a proxy, which
    // looks the name up again itself, so the checked address would not be the one used.
    const request = (url.protocol === "http:" ? node.http : node.https).request(url, { method: ask.method, headers, signal, lookup: lookup as never, agent: false }, (answer) => {
      const back = new Headers();
      for (const [name, value] of Object.entries(answer.headers)) {
        for (const one of Array.isArray(value) ? value : value === undefined ? [] : [value]) back.append(name, one);
      }
      const status = answer.statusCode ?? 502;
      const empty = status === 204 || status === 205 || status === 304;
      if (empty) answer.resume();
      resolve(new Response(empty ? null : (node.stream.Readable.toWeb(answer) as ReadableStream), { status, headers: back }));
    });
    request.on("error", reject);
    request.end(ask.body);
  });
}

const onBun = () => (globalThis as { Bun?: unknown }).Bun !== undefined;

/**
 * On Bun, the URL with its name swapped for one public address the name resolves to now, after every address it
 * resolves to has been checked. Bun takes the Host header for the TLS name and the certificate check, so the
 * request still goes to, and is verified as, the name. A name that does not resolve is refused.
 */
async function pin(url: URL, rule: Rule = PUBLIC): Promise<URL> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (v4(host) || v6(host)) return url;
  const dns = await resolver();
  if (!dns) throw rule.refused(host);
  const found = await dns.lookup(host, { all: true }).catch(() => []);
  if (!found.length || found.some((a) => !rule.allowed(a.address))) throw rule.refused(host);
  const pinned = new URL(url);
  pinned.hostname = found[0]!.family === 6 ? `[${found[0]!.address}]` : found[0]!.address;
  return pinned;
}

/**
 * For tests: publicFetch and serviceFetch ask the runtime's fetch, as a test
 * has replaced it, instead of connecting themselves. Addresses written as an
 * IP, and localhost, are still refused by publicFetch; names are not looked
 * up by it, since a test makes them up.
 */
let throughGlobalFetch = false;
export function publicFetchThroughGlobal(on: boolean): void {
  throughGlobalFetch = on;
}

/**
 * Fetches an https URL on the public internet, following up to `redirects`
 * redirects that stay on it, within `timeoutMs` in all. Only a GET follows
 * redirects; anything else comes back with the redirect as it is. Throws a
 * PrivateAddressError for an address off it, and the timeout's own error
 * when time runs out. A redirect past the last one comes back as it is.
 * `fetch` stands in for the runtime's, in tests, and checks names before
 * each hop the way a runtime without Node's https module does. `signal`
 * stops it early, such as when a browser waiting on it leaves.
 */
export async function publicFetch(
  target: string,
  init: { timeoutMs: number; method?: string; headers?: Record<string, string>; body?: string; redirects?: number; signal?: AbortSignal; fetch?: typeof fetch },
): Promise<Response> {
  const signal = init.signal ? AbortSignal.any([AbortSignal.timeout(init.timeoutMs), init.signal]) : AbortSignal.timeout(init.timeoutMs);
  const ask: Ask = { method: (init.method ?? "GET").toUpperCase(), headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }) };
  const node = init.fetch || throughGlobalFetch ? null : builtins();
  const redirects = ask.method === "GET" ? (init.redirects ?? 0) : 0;
  let url = new URL(target);
  for (let hop = 0; ; hop++) {
    if (url.protocol !== "https:") throw new PrivateAddressError(url.href);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if ((v4(host) || v6(host)) && !publicAddress(host)) throw new PrivateAddressError(host);
    if (host === "localhost" || host.endsWith(".localhost")) throw new PrivateAddressError(host);
    // On Bun the address checked is the one fetched; elsewhere, without a connection of its own to check,
    // the name is resolved first where the runtime can.
    const pinned = !node && !init.fetch && !throughGlobalFetch && onBun() ? await pin(url) : null;
    if (!node && !pinned && !throughGlobalFetch && (await resolvesPrivately(host))) throw new PrivateAddressError(host);
    let answer: Response;
    try {
      answer = node
        ? await once(node, url, ask, signal)
        : pinned
          ? await fetch(pinned, { ...ask, headers: { ...ask.headers, host: url.host }, redirect: "manual", signal })
          : await (init.fetch ?? fetch)(url, { ...ask, redirect: "manual", signal });
    } catch (error) {
      // Whichever way the runtime says it gave up, the caller hears that time ran out.
      if (signal.aborted) throw signal.reason;
      throw error;
    }
    const location = answer.headers.get("location");
    if (answer.status < 300 || answer.status >= 400 || !location || hop >= redirects) return answer;
    await answer.body?.cancel().catch(() => {});
    url = new URL(location, url);
  }
}

/** Refused before anything was fetched, because the address is link-local or a cloud's metadata service. */
export class MetadataAddressError extends Error {
  constructor(readonly host: string) {
    super(`${host} is a link-local or cloud metadata address, which Runlight never connects to`);
    this.name = "MetadataAddressError";
  }
}

/** A service may be on this computer or a private network, but never at a link-local or metadata address. */
const SERVICE: Rule = { allowed: (ip) => !metadataAddress(ip), refused: (host) => new MetadataAddressError(host) };

/**
 * Where fetch looks a name up itself, its addresses are checked just before. A name that cannot be looked up
 * here is refused, since fetch may find an address for it a moment later; a runtime with no resolver at all
 * reaches no network of the install's own, so there the name alone was checked.
 */
async function checkServiceName(host: string): Promise<void> {
  if (v4(host) || v6(host)) return;
  const dns = await resolver();
  if (!dns) return;
  const found = await dns.lookup(host, { all: true }).catch(() => null);
  if (!found?.length) throw new Error(`Could not look up ${host}`);
  if (found.some((a) => metadataAddress(a.address))) throw new MetadataAddressError(host);
}

/** Refused before anything was sent there, because a service's redirect led to another origin. */
export class RedirectRefusedError extends Error {
  constructor(
    readonly host: string,
    readonly to: string,
  ) {
    super(`${host} redirected to ${to}. Runlight sends a service's key and request only to the address it was set up with, so set it up with that address instead`);
    this.name = "RedirectRefusedError";
  }
}

/** Headers that describe a body, dropped with it when a redirect turns a request into a GET. */
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];

/**
 * Fetches from a service someone set up, such as an AI model's API or a mail webhook, which may well be on
 * this computer or a private network, but is never at a link-local or cloud metadata address. The address
 * the connection uses is checked, as publicFetch checks it, so a name that answers differently a moment
 * later gets nowhere, and no proxy from the environment looks it up again; a name that cannot be looked up
 * is refused. On a runtime with no resolver, such as Workers, only the name is checked. Every redirect is
 * checked the same way, up to `redirects` of them (default 5), each followed as fetch
 * follows it: a 303, or a 301 or 302 answering a POST, goes on as a GET with no body. Only a redirect on
 * the same origin is followed: the request carries a key, in whatever header the service names it, and a
 * 307 or 308 would carry its body too, an email or a conversation, so a redirect to another origin, https
 * to http among them, is refused before anything is sent there. A redirect past the last one comes back as
 * it is. Throws a MetadataAddressError or a RedirectRefusedError for an address it refuses.
 */
export async function serviceFetch(target: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirects?: number }): Promise<Response> {
  const redirects = init.redirects ?? 5;
  let url = new URL(target);
  let method = (init.method ?? "GET").toUpperCase();
  let headers: Record<string, string> = { ...init.headers };
  let body = init.body;
  const node = throughGlobalFetch ? null : builtins();
  for (let hop = 0; ; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (METADATA_NAMES.has(host.toLowerCase().replace(/\.+$/, "")) || metadataAddress(host)) throw new MetadataAddressError(host);
    const ask: Ask = { method, headers, ...(body === undefined ? {} : { body }) };
    const web = url.protocol === "http:" || url.protocol === "https:";
    let answer: Response;
    try {
      if (node && web) {
        // Node connects itself, checking the address it connects to, with no proxy from the environment between.
        answer = await once(node, url, ask, init.signal, SERVICE);
      } else {
        // Bun connects to the address checked; elsewhere a runtime with a resolver checks the name first, and
        // refuses one that does not resolve. Without one, as on Workers, there is no network of the install's own.
        const pinned = !throughGlobalFetch && web && onBun() ? await pin(url, SERVICE) : null;
        if (!pinned && !throughGlobalFetch) await checkServiceName(host);
        answer = pinned
          ? await fetch(pinned, { ...ask, headers: { ...headers, host: url.host }, redirect: "manual", ...(init.signal ? { signal: init.signal } : {}) })
          : await fetch(url, { ...ask, redirect: "manual", ...(init.signal ? { signal: init.signal } : {}) });
      }
    } catch (error) {
      // Whichever way the runtime says it gave up, the caller hears why the signal stopped it, such as time running out.
      if (init.signal?.aborted) throw init.signal.reason;
      throw error;
    }
    const location = answer.headers.get("location");
    if (answer.status < 300 || answer.status >= 400 || !location || hop >= redirects) return answer;
    await answer.body?.cancel().catch(() => {});
    const next = new URL(location, url);
    if (next.origin !== url.origin) {
      const there = next.hostname.replace(/^\[|\]$/g, "");
      if (await metadataHost(there).catch(() => false)) throw new MetadataAddressError(there);
      throw new RedirectRefusedError(url.host, next.protocol === "https:" || next.protocol === "http:" ? next.origin : next.protocol);
    }
    if (answer.status === 303 || ((answer.status === 301 || answer.status === 302) && method === "POST")) {
      method = method === "HEAD" ? "HEAD" : "GET";
      body = undefined;
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !BODY_HEADERS.includes(name.toLowerCase())));
    }
    url = next;
  }
}

/** An install on this machine: http://localhost or http://127.0.0.1, with any port. */
const LOCAL_INSTALL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

/**
 * Whether an address can be another Runlight install's: https, or, with
 * `local`, an install on this machine, which only code can allow.
 */
export function installAddress(url: string, local: boolean): boolean {
  return /^https:\/\/[^/]+/.test(url) || (local && LOCAL_INSTALL.test(url));
}

/**
 * Fetches from another Runlight install, which someone signed in named: a
 * public address as publicFetch fetches it, with no redirect followed, so a
 * token sent there goes nowhere else. With `local`, an install on this
 * machine is fetched as it is, still without following a redirect.
 */
export function installFetch(target: string, init: { timeoutMs: number; local: boolean; method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<Response> {
  const { local, ...rest } = init;
  if (local && LOCAL_INSTALL.test(target)) {
    const signal = init.signal ? AbortSignal.any([AbortSignal.timeout(init.timeoutMs), init.signal]) : AbortSignal.timeout(init.timeoutMs);
    return fetch(target, { method: init.method ?? "GET", headers: init.headers ?? {}, ...(init.body === undefined ? {} : { body: init.body }), redirect: "manual", signal });
  }
  return publicFetch(target, { ...rest, redirects: 0 });
}

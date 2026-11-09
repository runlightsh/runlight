/**
 * Checks a request that names an AI agent against the addresses that agent's company publishes. Every
 * list is in the same shape, {"prefixes": [{"ipv4Prefix": "a.b.c.d/n"} or {"ipv6Prefix": "x::/n"}]}.
 *
 * The answer is "verified" when the address is in the list, "mismatch" when the company publishes a list
 * and the address is not in it, and "" when there is nothing to check against: no list for that agent,
 * or no usable address. The address is only compared, never kept.
 */
import type { AiAgent } from "./data/agents.js";

export type AgentCheck = "verified" | "mismatch" | "";

/** A list of more prefixes than this, or a reply bigger than MAX_LIST_BYTES, is not a list we read. */
const MAX_PREFIXES = 20_000;
const MAX_LIST_BYTES = 4_000_000;

type Address = { v: 4; n: number } | { v: 6; n: bigint };

function ipv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    n = n * 256 + byte;
  }
  return n;
}

function ipv6(text: string): bigint | null {
  if (!/^[0-9a-f:.]+$/i.test(text) || text.split("::").length > 2) return null;
  // A dotted IPv4 tail ("::ffff:1.2.3.4") stands for the last two groups.
  let groups = text;
  const dot = text.lastIndexOf(":");
  if (text.includes(".")) {
    const tail = ipv4(text.slice(dot + 1));
    if (tail === null) return null;
    groups = `${text.slice(0, dot + 1)}${(tail >>> 16).toString(16)}:${(tail & 0xffff).toString(16)}`;
  }
  const [head, rest] = groups.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = rest === undefined ? [] : rest ? rest.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 1) return null;
  const all = [...left, ...Array<string>(rest === undefined ? 0 : missing).fill("0"), ...right];
  let n = 0n;
  for (const group of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    n = (n << 16n) | BigInt(parseInt(group, 16));
  }
  return n;
}

/**
 * An address as the check reads it: surrounding space, [brackets], and an IPv6 zone ("%eth0") are
 * ignored, and an IPv4 address written as IPv6 (::ffff:1.2.3.4) is read as IPv4. Null when it is not one.
 */
export function parseAddress(text: string): Address | null {
  let s = text.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s) return null;
  if (!s.includes(":")) {
    const n = ipv4(s);
    return n === null ? null : { v: 4, n };
  }
  const n = ipv6(s);
  if (n === null) return null;
  if (n >> 32n === 0xffffn) return { v: 4, n: Number(n & 0xffffffffn) };
  return { v: 6, n };
}

interface Prefix {
  v: 4 | 6;
  base: bigint;
  bits: number;
}

/** A prefix such as 20.171.206.0/24 or 2600:1f28::/56, or null. Bits past the length are ignored. */
function parsePrefix(text: string): Prefix | null {
  const slash = text.indexOf("/");
  if (slash === -1) return null;
  const bitsText = text.slice(slash + 1);
  if (!/^\d{1,3}$/.test(bitsText)) return null;
  const bits = Number(bitsText);
  const head = text.slice(0, slash);
  if (head.includes(":")) {
    const n = ipv6(head);
    if (n === null || bits > 128) return null;
    return { v: 6, base: n, bits };
  }
  const n = ipv4(head);
  if (n === null || bits > 32) return null;
  return { v: 4, base: BigInt(n), bits };
}

function covers(prefix: Prefix, address: Address): boolean {
  if (prefix.v !== address.v) return false;
  const width = prefix.v === 4 ? 32 : 128;
  const shift = BigInt(width - prefix.bits);
  return BigInt(address.n) >> shift === prefix.base >> shift;
}

/**
 * The prefixes in a published list, or null when the reply is not a list in the expected shape (not an
 * object, no prefixes, an entry that is not a prefix, or too many). One bad entry rejects the whole list,
 * so a half broken download never replaces a good copy.
 */
export function readRangeList(body: unknown): string[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const prefixes = (body as { prefixes?: unknown }).prefixes;
  if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.length > MAX_PREFIXES) return null;
  const out: string[] = [];
  for (const entry of prefixes) {
    if (!entry || typeof entry !== "object") return null;
    const { ipv4Prefix, ipv6Prefix } = entry as { ipv4Prefix?: unknown; ipv6Prefix?: unknown };
    const text = typeof ipv4Prefix === "string" ? ipv4Prefix : typeof ipv6Prefix === "string" ? ipv6Prefix : null;
    if (text === null) return null;
    const prefix = parsePrefix(text.trim());
    if (!prefix || (typeof ipv4Prefix === "string") !== (prefix.v === 4)) return null;
    out.push(text.trim());
  }
  return out;
}

/** Downloads one published list. Null when it cannot be fetched or read; the caller keeps what it had. */
export async function downloadRangeList(url: string, timeoutMs = 15_000): Promise<string[] | null> {
  try {
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "Runlight (+https://runlight.sh)" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_LIST_BYTES) return null;
    const text = await response.text();
    if (text.length > MAX_LIST_BYTES) return null;
    return readRangeList(JSON.parse(text));
  } catch {
    return null;
  }
}

const compiled = new WeakMap<string[], Prefix[]>();

function prefixesOf(list: string[]): Prefix[] {
  let parsed = compiled.get(list);
  if (!parsed) {
    parsed = list.map(parsePrefix).filter((p): p is Prefix => p !== null);
    compiled.set(list, parsed);
  }
  return parsed;
}

/** Whether `ip` is inside any of the prefixes. False for an address that cannot be read. */
export function inRanges(ip: string, list: string[]): boolean {
  const address = parseAddress(ip);
  return address !== null && prefixesOf(list).some((p) => covers(p, address));
}

/** The check for one request that names `agent`, made from `ip` (see the top of this file). */
export function checkAgent(agent: AiAgent, ip: string, lists: Record<string, string[]>): AgentCheck {
  const list = agent.ranges ? lists[agent.ranges] : undefined;
  if (!list || parseAddress(ip) === null) return "";
  return inRanges(ip, list) ? "verified" : "mismatch";
}

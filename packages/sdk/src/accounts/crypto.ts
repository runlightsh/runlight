/**
 * The cryptography accounts need, on WebCrypto so it runs on every runtime Runlight does, edge ones included.
 * Passwords use Node's scrypt where it is there, as the standalone server always has, and PBKDF2 elsewhere.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const plain = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) out[i] = plain.charCodeAt(i);
  return out;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const bytesOf = (value: string | Uint8Array): Uint8Array<ArrayBuffer> => (typeof value === "string" ? encoder.encode(value) : new Uint8Array(value));

export async function sha256(value: string | Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytesOf(value)));
}

export async function hmac(hash: "SHA-1" | "SHA-256", key: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", bytesOf(key), { name: "HMAC", hash }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, bytesOf(data)));
}

/** Compares two strings in time that does not depend on where they differ. */
export function sameText(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

type Scrypt = (password: string, salt: Uint8Array, keylen: number, options: { N: number; r: number; p: number; maxmem: number }, done: (error: Error | null, key: Uint8Array) => void) => void;
type ScryptCost = { N: number; r: number; p: number };
/**
 * What a new hash costs: one of OWASP's scrypt settings, 32 MiB a check, so several sign-ins at once stay
 * within a small server's memory. Each hash records its own cost, so this can rise again.
 */
const SCRYPT: ScryptCost = { N: 32768, r: 8, p: 3 };
/** What a hash written as scrypt$salt$key costs: the setting before hashes recorded theirs. */
const SCRYPT_BEFORE: ScryptCost = { N: 16384, r: 8, p: 1 };

/** Node's scrypt, where the runtime has it: Node, Bun, and Deno do, and edge runtimes mostly do not. */
async function nodeScrypt(): Promise<Scrypt | null> {
  try {
    const found = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule?.("node:crypto") as { scrypt?: Scrypt } | undefined;
    if (typeof found?.scrypt === "function") return found.scrypt;
  } catch {
    // Looked for below instead.
  }
  try {
    // A name in a variable, so a bundler for an edge runtime leaves the import alone.
    const id = "node:crypto";
    const found = (await import(id)) as { scrypt?: Scrypt };
    return typeof found.scrypt === "function" ? found.scrypt : null;
  } catch {
    return null;
  }
}

const runScrypt = (scrypt: Scrypt, password: string, salt: Uint8Array, length: number, cost: ScryptCost) =>
  new Promise<Uint8Array>((resolve, reject) =>
    // Memory is 128 * N * r bytes; room for twice that.
    scrypt(password, salt, length, { ...cost, maxmem: 256 * cost.N * cost.r }, (error, key) => (error ? reject(error) : resolve(new Uint8Array(key)))),
  );

/** A scrypt hash's cost: recorded in it (scrypt$N$r$p$salt$key), or the old setting (scrypt$salt$key). Null for one out of bounds. */
function scryptCost(parts: string[]): ScryptCost | null {
  if (parts.length === 3) return SCRYPT_BEFORE;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  const whole = (n: number, max: number) => Number.isInteger(n) && n >= 1 && n <= max;
  // N a power of two up to 2^20, and r and p small, so a stored hash cannot ask for a huge amount of memory or time.
  // N must also be below 2^(16r), as scrypt itself requires, so a stored hash past that fails to match rather than throws.
  if (!whole(N, 1 << 20) || N < 2 || (N & (N - 1)) !== 0 || !whole(r, 32) || !whole(p, 16) || Math.log2(N) >= 16 * r) return null;
  return { N, r, p };
}

/** As many PBKDF2 rounds as Cloudflare Workers allow, the strictest runtime Runlight runs on. */
const PBKDF2_ROUNDS = 100_000;

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, rounds: number, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, key, length * 8));
}

/** A password hash: scrypt where the runtime has it, else PBKDF2. Each says which it is, so either can be checked later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const scrypt = await nodeScrypt();
  if (scrypt) return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${base64url(salt)}$${base64url(await runScrypt(scrypt, password, salt, 32, SCRYPT))}`;
  return `pbkdf2$${PBKDF2_ROUNDS}$${base64url(salt)}$${base64url(await pbkdf2(password, salt, PBKDF2_ROUNDS, 32))}`;
}

/** The shortest stored key accepted. Ours are 32 bytes; an empty or cut key would match too easily, or anything. */
const MIN_KEY_BYTES = 16;

/** Whether a password matches a hash. A scrypt hash only checks out where the runtime has scrypt. */
export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  // A stored hash whose salt or key is not base64url matches nothing, rather than failing the sign-in.
  const decode = (text: string): Uint8Array<ArrayBuffer> | null => {
    try {
      return fromBase64url(text);
    } catch {
      return null;
    }
  };
  if (parts[0] === "scrypt" && (parts.length === 3 || parts.length === 6)) {
    const scrypt = await nodeScrypt();
    const cost = scryptCost(parts);
    if (!scrypt || !cost) return false;
    const expected = decode(parts[parts.length - 1]!);
    const salt = decode(parts[parts.length - 2]!);
    if (!expected || !salt || expected.length < MIN_KEY_BYTES) return false;
    return sameBytes(await runScrypt(scrypt, password, salt, expected.length, cost), expected);
  }
  if (parts[0] === "pbkdf2" && parts.length === 4) {
    const rounds = Number(parts[1]);
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10_000_000) return false;
    const expected = decode(parts[3]!);
    const salt = decode(parts[2]!);
    if (!expected || !salt || expected.length < MIN_KEY_BYTES) return false;
    return sameBytes(await pbkdf2(password, salt, rounds, expected.length), expected);
  }
  return false;
}

/**
 * Whether a stored hash costs less than a new one would here, so the password it matched is hashed again: an
 * scrypt hash with a lower cost, or a PBKDF2 one where scrypt is now there.
 */
export async function weakerThanNow(stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (!(await nodeScrypt())) return false;
  if (parts[0] === "pbkdf2") return true;
  if (parts[0] !== "scrypt") return false;
  const cost = scryptCost(parts);
  return cost !== null && cost.N * cost.r * cost.p < SCRYPT.N * SCRYPT.r * SCRYPT.p;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const sealKey = async (secret: string) => crypto.subtle.importKey("raw", await sha256(`totp:${secret}`), "AES-GCM", false, ["encrypt", "decrypt"]);

/**
 * Seals text with AES-256-GCM under a key from the secret, as "iv.body.tag" in base64url, the form the standalone
 * server has always stored two-factor secrets in.
 */
export async function sealText(text: string, secret: string): Promise<string> {
  const iv = randomBytes(12);
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(secret), encoder.encode(text)));
  return `${base64url(iv)}.${base64url(out.subarray(0, out.length - 16))}.${base64url(out.subarray(out.length - 16))}`;
}

export async function unsealText(sealed: string, secret: string): Promise<string | null> {
  try {
    const [iv, body, tag] = sealed.split(".");
    if (!iv || body === undefined || !tag) return null;
    const joined = new Uint8Array([...fromBase64url(body), ...fromBase64url(tag)]);
    return decoder.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(iv) }, await sealKey(secret), joined));
  } catch {
    return null;
  }
}

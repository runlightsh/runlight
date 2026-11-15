/**
 * Location for servers with no platform headers (Cloudflare, Vercel, and
 * Netlify send their own, and those always win). Uses DB-IP's free
 * databases (CC BY 4.0, https://db-ip.com), downloaded on first start and
 * refreshed each month, or any MMDB file the owner points at.
 *
 * A download is used only once it is checked: its SHA-1 against the one DB-IP
 * publishes on its download page, and the file itself as a DB-IP database of
 * the kind asked for, no older than the one in use. That catches a damaged or
 * swapped file, and a download server serving something else. It is not a
 * signature: DB-IP publishes none, so whoever can change DB-IP's own page can
 * change both. A checksum that does not match always refuses the download.
 * Only when none can be read at all (the page is down, or no longer reads as
 * it did) is a download accepted on the other checks alone, with a warning,
 * so a change to that page does not stop location data everywhere.
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Reader, type CityResponse } from "mmdb-lib";
import type { GeoLookup, Location } from "@runlight/sdk";

export type GeoMode = "city" | "country" | "off";

/** DB-IP's records follow MaxMind's city layout, with names but no subdivision codes. */
type Record = CityResponse;

/** "2026-10", the month DB-IP names each release after. */
const month = (ts: number) => new Date(ts).toISOString().slice(0, 7);

/** A city as people say it: DB-IP adds districts in brackets, as in "Toronto (Old Toronto)". */
const cityName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, "").trim();

export function lookupFrom(reader: Reader<Record>): GeoLookup {
  return (ip: string): Partial<Location> | null => {
    let found: Record | null = null;
    try {
      found = reader.get(ip);
    } catch {
      return null;
    }
    if (!found?.country?.iso_code) return null;
    const sub = found.subdivisions?.[0];
    return {
      country: found.country.iso_code,
      region: sub?.iso_code ?? sub?.names?.en ?? "",
      city: cityName(found.city?.names?.en ?? ""),
    };
  };
}

/**
 * Keeps a DB-IP database current in `dir` and answers lookups from it. Lookups
 * return nothing until the first download finishes, so startup never waits.
 */
export class Geo {
  private reader: Reader<Record> | null = null;
  private loaded = "";
  private fetching: Promise<void> | null = null;
  /** After a try that left this month's file missing: how long the next waits, and when it may start. */
  private wait = 0;
  private retryAt = 0;
  /** The release actually available for lookups, for monitoring download failures and stale data. */
  get release(): string { return this.loaded; }
  readonly lookup: GeoLookup = (ip) => (this.reader ? lookupFrom(this.reader)(ip) : null);

  constructor(
    private readonly dir: string,
    private readonly mode: Exclude<GeoMode, "off">,
    private readonly log: (line: string) => void = console.log,
    private readonly download: typeof fetch = fetch,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private file(release: string) {
    return path.join(this.dir, `dbip-${this.mode}-lite-${release}.mmdb`);
  }

  /**
   * Opens the newest file on disk, then fetches this month's if it is missing. Safe to call often: while the
   * month's file is not published yet, or a download keeps failing, each try waits twice as long as the last,
   * from five minutes up to six hours, so neither DB-IP nor the disk is asked for the whole file every few minutes.
   */
  async refresh(now = Date.now()): Promise<void> {
    const current = month(now);
    if (this.loaded === current) return;
    const newest = readdirSync(this.dir)
      .filter((f) => f.startsWith(`dbip-${this.mode}-lite-`) && f.endsWith(".mmdb"))
      .sort()
      .pop();
    if (newest && newest !== path.basename(this.file(this.loaded || "none"))) this.open(path.join(this.dir, newest));
    if (existsSync(this.file(current))) return;
    if (now < this.retryAt) return this.fetching ?? undefined;
    this.fetching ??= this.fetch(current, now).finally(() => {
      this.fetching = null;
      if (existsSync(this.file(current))) this.wait = 0;
      else {
        this.wait = Math.min(this.wait * 2 || FIRST_WAIT, LONGEST_WAIT);
        this.retryAt = now + this.wait;
      }
    });
    return this.fetching;
  }

  private open(file: string) {
    this.reader = new Reader<Record>(readFileSync(file));
    this.loaded = path.basename(file).slice(-12, -5);
  }

  /** One GET that goes nowhere but where it was sent: https, and no redirect followed. */
  private async get(url: string, timeoutMs: number): Promise<Response> {
    const answer = await this.download(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    if (answer.status !== 200 || !answer.body) {
      await answer.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`it answered ${answer.status}`), { status: answer.status });
    }
    return answer;
  }

  /** The release DB-IP's download page offers for this kind of database, and the SHA-1 it gives for the unpacked file. */
  private async published(): Promise<{ release: string; sha1: string }> {
    const url = `https://db-ip.com/db/download/ip-to-${this.mode}-lite`;
    let page: string;
    try {
      const answer = await this.get(url, 30_000);
      const bytes = await collect(Readable.fromWeb(answer.body as never), MOST_PAGE_BYTES);
      page = bytes.toString("utf8");
    } catch (error) {
      throw new Error(`could not read DB-IP's checksums at ${url}: ${(error as Error).message}`);
    }
    const found = publishedChecksum(page, this.mode);
    if (!found) throw new Error(`found no checksum for the ${this.mode} database at ${url}`);
    return found;
  }

  private async fetch(release: string, now: number): Promise<void> {
    // A new month's file appears a day or so after the month starts; until then, last month's is current.
    const tries = [release, month(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 15))];
    // The page says which release there is and what it must hash to, so only that file is asked for. When the
    // page cannot be read, the newest release there is goes unchecked against it, and the log says so.
    let published: { release: string; sha1: string } | null = null;
    let unchecked = "";
    try {
      published = await this.published();
    } catch (error) {
      unchecked = (error as Error).message;
    }
    if (published && !tries.includes(published.release)) {
      return this.log(`Runlight: location data was not updated: DB-IP offers the ${published.release} release, which is neither this month's nor last month's`);
    }
    for (const name of published ? [published.release] : tries) {
      if (existsSync(this.file(name))) {
        if (this.loaded !== name) this.open(this.file(name));
        return;
      }
      const url = `https://download.db-ip.com/free/dbip-${this.mode}-lite-${name}.mmdb.gz`;
      const partial = `${this.file(name)}.partial.${process.pid}`;
      try {
        await this.save(url, partial, published?.sha1 ?? null, now);
        renameSync(partial, this.file(name));
        this.open(this.file(name));
        // Older releases go once the new one opens.
        for (const old of readdirSync(this.dir)) if (old.startsWith(`dbip-${this.mode}-lite-`) && old !== path.basename(this.file(name))) rmSync(path.join(this.dir, old), { force: true });
        if (!published) this.log(`Runlight: warning: location data from DB-IP (${name}) could not be checked against DB-IP's published checksum (${unchecked}). It was accepted as a DB-IP database of the right kind, without that check.`);
        this.log(`Runlight: location data from DB-IP (${name}) is ready.`);
        return;
      } catch (error) {
        rmSync(partial, { force: true });
        // Without the page to say which release there is, this month's not being out yet is no failure.
        if (!published && (error as { status?: number }).status === 404) continue;
        // Whatever went wrong, the database in use stays in use.
        this.log(`Runlight: location data was not updated from ${url}: ${(error as Error).message}`);
      }
    }
    if (!published) this.log(`Runlight: location data was not updated: ${unchecked}, and no release could be downloaded without them`);
  }

  /**
   * Downloads one release to `partial`, unpacked, and throws unless it is fit to use: the published SHA-1's
   * (when there is one to hold it to), and a DB-IP database of this kind no older than the one in use.
   */
  private async save(url: string, partial: string, sha1: string | null, now: number): Promise<void> {
    const answer = await this.get(url, 10 * 60_000);
    if (Number(answer.headers.get("content-length") ?? 0) > MOST_PACKED_BYTES) {
      await answer.body!.cancel().catch(() => {});
      throw new Error(`the download is more than ${MOST_PACKED_BYTES / 1024 / 1024} MB`);
    }
    const hash = createHash("sha1");
    await pipeline(Readable.fromWeb(answer.body as never), capped(MOST_PACKED_BYTES), createGunzip(), capped(MOST_BYTES, hash), createWriteStream(partial));
    const got = hash.digest("hex");
    if (sha1 !== null && got !== sha1) throw new Error(`its SHA-1 is ${got}, and DB-IP publishes ${sha1}`);
    checkDatabase(readFileSync(partial), this.mode, now, this.reader?.metadata.buildEpoch.getTime() ?? 0);
  }
}

/**
 * The release and SHA-1 on DB-IP's download page for the MMDB file of one kind: the last SHA1SUM before the
 * link to that file, and after the link to any other. Null when the page does not read that way.
 */
export function publishedChecksum(page: string, mode: Exclude<GeoMode, "off">): { release: string; sha1: string } | null {
  const link = new RegExp(`download\\.db-ip\\.com/free/dbip-${mode}-lite-(\\d{4}-\\d{2})\\.mmdb\\.gz`).exec(page);
  if (!link) return null;
  const before = page.slice(0, link.index);
  const others = [...before.matchAll(/download\.db-ip\.com\/free\/dbip-/g)];
  const card = before.slice(others.length ? others[others.length - 1]!.index : 0);
  const sums = [...card.matchAll(/SHA1SUM[\s\S]{0,200}?\b([0-9a-f]{40})\b/gi)];
  const sha1 = sums[sums.length - 1]?.[1]?.toLowerCase();
  return sha1 ? { release: link[1]!, sha1 } : null;
}

const MARKER = Buffer.from("\xab\xcd\xefMaxMind.com", "latin1");

/**
 * Throws unless `bytes` is a DB-IP database of the kind asked for that a lookup can be made in: of a
 * believable size, its search tree inside the file, built lately and not before the one in use (`inUse`, a
 * time, or 0 for none), and answering for addresses everyone knows.
 */
export function checkDatabase(bytes: Buffer, mode: Exclude<GeoMode, "off">, now: number, inUse = 0): void {
  if (bytes.length < FEWEST_BYTES) throw new Error(`it unpacks to ${bytes.length} bytes, too few for a location database`);
  const marker = bytes.lastIndexOf(MARKER);
  if (marker < 0) throw new Error("it is not an MMDB file");
  let reader: Reader<Record>;
  try {
    reader = new Reader<Record>(bytes);
  } catch (error) {
    throw new Error(`it does not open as an MMDB file: ${(error as Error).message}`);
  }
  const meta = reader.metadata;
  if (meta.binaryFormatMajorVersion !== 2) throw new Error(`its format is version ${meta.binaryFormatMajorVersion}, not 2`);
  if (meta.databaseType.toLowerCase() !== `dbip-${mode}-lite`) throw new Error(`it is a "${meta.databaseType}" database, not DB-IP's ${mode} one`);
  if (meta.ipVersion !== 6) throw new Error(`it covers IP version ${meta.ipVersion}, not 6`);
  if (![24, 28, 32].includes(meta.recordSize)) throw new Error(`its records are ${meta.recordSize} bits`);
  if (!(meta.nodeCount > 0) || (meta.nodeCount * meta.recordSize) / 4 + 16 > marker) throw new Error("its search tree does not fit in the file");
  const built = meta.buildEpoch.getTime();
  if (!(built <= now + 2 * DAY) || built < now - OLDEST_BUILD) throw new Error(`it was built on ${Number.isNaN(built) ? "no date" : meta.buildEpoch.toISOString().slice(0, 10)}`);
  if (built < inUse) throw new Error("it is older than the database in use");
  for (const ip of KNOWN) {
    let found: Record | null = null;
    try {
      found = reader.get(ip);
    } catch {}
    if (!/^[A-Z]{2}$/.test(found?.country?.iso_code ?? "")) throw new Error(`it has no country for ${ip}`);
  }
}

const DAY = 86_400_000;
/** A release is built at the start of its month and stands in until the next appears, so one is two months old at most. */
const OLDEST_BUILD = 100 * DAY;
/** Addresses any location database knows: Google's and Cloudflare's resolvers, over IPv4 and IPv6. */
const KNOWN = ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"];

/** How long after a first failed try the next one waits, and the longest any waits. */
const FIRST_WAIT = 5 * 60_000;
const LONGEST_WAIT = 6 * 3_600_000;

/** The most a database may unpack to, several times the city file's size, so a bad download cannot fill the disk. */
const MOST_BYTES = 512 * 1024 * 1024;

/** The most the download itself may weigh, and the least a database unpacks to (the country one is 8 MB). */
const MOST_PACKED_BYTES = 256 * 1024 * 1024;
const FEWEST_BYTES = 1024 * 1024;
/** The most of DB-IP's download page that is read; it is about 25 KB. */
const MOST_PAGE_BYTES = 1024 * 1024;

/** Passes bytes through, hashing them when given a hash, and fails once more than `most` have gone by. */
function capped(most: number, hash?: { update(chunk: Buffer): unknown }): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > most) return done(new Error(`the location data is more than ${most / 1024 / 1024} MB`));
      hash?.update(chunk);
      done(null, chunk);
    },
  });
}

/** A stream's bytes, or an error once there are more than `most`. */
async function collect(stream: Readable, most: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of stream) {
    seen += (chunk as Buffer).length;
    if (seen > most) throw new Error(`it is more than ${most / 1024} KB`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** A lookup from an MMDB file the owner supplies, such as MaxMind's GeoLite2 City. */
export function fileLookup(file: string): GeoLookup {
  return lookupFrom(new Reader<Record>(readFileSync(file)));
}

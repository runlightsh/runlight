#!/usr/bin/env node
/**
 * npx @runlight/server starts the server. Settings come from the environment:
 *
 *   PORT              where to listen (3000)
 *   HOST              which address to listen on (0.0.0.0)
 *   DATA_DIR          where the SQLite file and the secret live (./runlight-data)
 *   DATABASE_URL      a postgres://, mysql://, or mariadb:// URL, to use that database instead of SQLite
 *   CLICKHOUSE_URL    an http:// or https:// URL, to keep the visits and events in ClickHouse
 *   RUNLIGHT_SECRET   signs sessions and encrypts saved keys (made and kept in DATA_DIR if unset)
 *   RUNLIGHT_TOKEN    also accepted as a bearer token on the API
 *   RUNLIGHT_URL      the dashboard's public address, which can never become a link domain
 *   TRUST_PROXY       unset believes forwarded addresses only from a private network; "false" never,
 *                     "true" from anywhere, or the one header a CDN sets, such as cf-connecting-ip
 *   RUNLIGHT_GEO      city (the default), country, off, or the path to an MMDB file
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import type { SqlStore } from "@runlight/sdk";
import type { ClickHouseStore } from "@runlight/sdk/clickhouse";
import { BodyTooLarge, toRequest, writeResponse } from "@runlight/sdk/node";
import { Geo, fileLookup } from "./geo.js";
import { secretIn } from "./secret.js";
import { createServer } from "./server.js";
import { VERSION } from "./version.js";
import { createMonitoring } from "./monitoring.js";

const env = (name: string) => process.env[name]?.trim() || undefined;

const HELP = `Runlight ${VERSION}, privacy friendly web analytics for any number of sites.

Usage:
  npx @runlight/server                      Start the server
  npx @runlight/server password <email>     Make an account, or give one a new password
  npx @runlight/server agents --log <file>  Count AI agents from a web server's access log
  npx @runlight/server clickhouse <command> Move the visits into ClickHouse, and back (see clickhouse --help)
  npx @runlight/server --version            Print the version

Settings are environment variables. PORT (3000) and HOST (0.0.0.0) set where it
listens. DATA_DIR (./runlight-data) holds the SQLite file and the secret, and
DATABASE_URL switches to Postgres, MySQL, or MariaDB, and CLICKHOUSE_URL keeps
the visits and events in ClickHouse, with the rest where it was. RUNLIGHT_SECRET signs
sessions and encrypts saved keys, RUNLIGHT_TOKEN also works as a bearer token
on the API. Forwarded addresses count only from a proxy on this computer or a
private network; TRUST_PROXY=false ignores them, and behind a CDN that connects
from public addresses, TRUST_PROXY names its header, such as cf-connecting-ip.
RUNLIGHT_URL is the dashboard's public address, such as
https://stats.example.com, which short links can never take over.
RUNLIGHT_GEO picks where locations come from when no platform header gives
them. It is city by default, which downloads DB-IP's free city database into
DATA_DIR and refreshes it each month. Set it to country for a smaller file, to
off, or to the path of your own MMDB file.

Docs: https://runlight.sh/docs/server/
`;

async function openStore(dataDir: string, copyInBackground = true): Promise<SqlStore> {
  const rows = await openRowStore(dataDir);
  const url = env("CLICKHOUSE_URL");
  if (!url) return rows;
  const { clickhouse } = await import("@runlight/sdk/clickhouse");
  return clickhouse({ url, store: rows, copyInBackground });
}

/** The database that holds everything but the visits, as the startup log and the clickhouse commands name it. */
function rowDatabase(dataDir: string): string {
  const database = env("DATABASE_URL") ?? "";
  return /^postgres(ql)?:\/\//.test(database) ? "Postgres" : /^mysql:\/\//.test(database) ? "MySQL" : /^mariadb:\/\//.test(database) ? "MariaDB" : path.join(dataDir, "runlight.db");
}

/** Where everything but the visits lives, and the visits too without ClickHouse. */
async function openRowStore(dataDir: string): Promise<SqlStore> {
  const url = env("DATABASE_URL");
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const { postgres } = await import("@runlight/sdk/postgres");
    return postgres({ url });
  }
  if (url && /^(mysql|mariadb):\/\//.test(url)) {
    const { mysql } = await import("@runlight/sdk/mysql");
    return mysql({ url });
  }
  const { sqlite } = await import("@runlight/sdk/sqlite");
  return sqlite({ path: path.join(dataDir, "runlight.db") });
}

/**
 * TRUST_PROXY: "false" with nothing in front, "true" for a CDN that connects from public addresses, or the one
 * header your proxy sets, such as cf-connecting-ip behind Cloudflare. Unset stays unset, so the library's
 * default applies: forwarding headers count only from a private address. Anything else is a mistake, said so
 * rather than guessed at, since "0" or "off" read as on would let any client choose its address.
 */
function trustProxyFrom(given: string | undefined): boolean | "x-forwarded-for" | "x-real-ip" | "cf-connecting-ip" | undefined {
  const value = given?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  if (value === "x-forwarded-for" || value === "x-real-ip" || value === "cf-connecting-ip") return value;
  throw new Error(`Set TRUST_PROXY to true, false, or the header your proxy sets (x-forwarded-for, x-real-ip, or cf-connecting-ip), not "${given}"`);
}

/** RUNLIGHT_SECRET, or one made on first run and kept beside the data, readable only by this user. */
function secretFor(dataDir: string): string {
  return env("RUNLIGHT_SECRET") ?? secretIn(dataDir);
}

const AGENTS_HELP = `Count AI agents on a site that has only the script tag, from its web server's log.

Usage:
  RUNLIGHT_OBSERVE_KEY=rlo_... npx @runlight/server agents --log /var/log/nginx/access.log --to https://stats.example.com

  --log <file>    The access log, in nginx or Apache's combined format, or Caddy's JSON
  --to <url>      Your Runlight, as its dashboard address (or RUNLIGHT_URL)
  --key <key>     The site's agents key from Settings, Install. Better in RUNLIGHT_OBSERVE_KEY,
                  since other people on this computer can see a command's arguments
  --site <url>    The site's address, such as https://example.com, when the log has no host in it
  --follow        Keep running and send fetches as they happen
  --state <file>  Remember where it stopped, so the next run, or a restarted --follow, starts there.
                  Only one run at a time can use it.

Docs: https://runlight.sh/docs/server/#ai-agents-from-a-log
`;

async function agents(args: string[]): Promise<void> {
  const flag = (name: string) => {
    const at = args.indexOf(`--${name}`);
    if (at < 0) return undefined;
    const value = args[at + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Give --${name} a value`);
    return value;
  };
  if (args.includes("--help") || args.includes("-h")) return void process.stdout.write(AGENTS_HELP);
  const log = flag("log");
  const to = flag("to") ?? env("RUNLIGHT_URL");
  const key = flag("key") ?? env("RUNLIGHT_OBSERVE_KEY");
  if (!log || !to || !key) {
    process.stderr.write(AGENTS_HELP);
    process.exitCode = 1;
    return;
  }
  const { runAgents } = await import("./agents.js");
  const site = flag("site");
  const state = flag("state");
  await runAgents({ log: path.resolve(log), to, key, follow: args.includes("--follow"), ...(site ? { site } : {}), ...(state ? { state: path.resolve(state) } : {}) });
}

async function clickhouseCommand(args: string[], dataDir: string): Promise<void> {
  const { CLICKHOUSE_HELP, runClickhouse } = await import("./clickhouse.js");
  if (!args[0] || args.includes("--help") || args.includes("-h")) return void process.stdout.write(CLICKHOUSE_HELP);
  if (!env("CLICKHOUSE_URL")) throw new Error("Set CLICKHOUSE_URL to the ClickHouse to use, such as https://user:password@host:8443/runlight");
  const store = (await openStore(dataDir, false)) as ClickHouseStore;
  try {
    // The other database's tables, as the server makes them, so a first run of these finds them.
    await store.migrateOther();
    await runClickhouse(args, store, rowDatabase(dataDir));
  } finally {
    await store.close();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || command === "help") return void process.stdout.write(HELP);
  if (command === "--version" || command === "-v") return void process.stdout.write(`${VERSION}\n`);
  if (command === "agents") return agents(args);

  const dataDir = path.resolve(env("DATA_DIR") ?? "./runlight-data");
  // Only this user's: the database, the secret, and the location data are in it.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (command === "clickhouse") return clickhouseCommand(args, dataDir);
  const store = await openStore(dataDir);
  const geoSetting = env("RUNLIGHT_GEO") ?? "city";
  const geo = geoSetting === "city" || geoSetting === "country" ? new Geo(path.join(dataDir, "geo"), geoSetting) : null;
  if (!geo && geoSetting !== "off" && !existsSync(path.resolve(geoSetting))) {
    throw new Error(`Set RUNLIGHT_GEO to city, country, off, or the path of an .mmdb file; there is no file at ${path.resolve(geoSetting)}`);
  }
  const lookup = geo ? geo.lookup : geoSetting !== "off" ? fileLookup(path.resolve(geoSetting)) : undefined;
  const url = env("RUNLIGHT_URL");
  if (url && !/^https?:\/\/[^/?#]+\/?$/.test(url)) throw new Error("Set RUNLIGHT_URL to the dashboard's address only, such as https://stats.example.com");
  let monitoring: ReturnType<typeof createMonitoring> | null = null;
  const mailTo = env("CRONWATCH_MAIL_TO");
  const server = createServer({
    ...(mailTo ? { monitoring: (request: Request) => monitoring!.handler(request) } : {}),
    ...(lookup ? { geo: lookup } : {}),
    ...(url ? { url } : {}),
    geoCredit: Boolean(geo),
    store,
    secret: secretFor(dataDir),
    ...(env("RUNLIGHT_TOKEN") ? { token: env("RUNLIGHT_TOKEN") } : {}),
    trustProxy: trustProxyFrom(env("TRUST_PROXY")),
  });

  if (command === "password") {
    const email = args[0];
    if (!email) throw new Error("Name the account: npx @runlight/server password you@example.com");
    await server.runlight.init();
    const password = randomBytes(12).toString("base64url");
    const existed = Boolean(await server.accounts.byEmail(email));
    const user = await server.accounts.setPassword(email, password, Date.now());
    // Someone at the server is who they say, so a lost authenticator is no longer in the way.
    const reset = user.twoFactor;
    if (reset) await server.accounts.disableTwoFactor(user.id);
    process.stdout.write(
      `${existed ? "New password" : `Account made, as ${user.role === "owner" ? "the owner" : "an admin"},`} for ${email.trim().toLowerCase()}: ${password}\n${reset ? "Two-factor sign-in is now off for this account; turn it on again under Account.\n" : ""}Sign in, and change it by running this again whenever you like.\n`,
    );
    await store.close();
    return;
  }
  if (command && command !== "start") throw new Error(`Unknown command "${command}". Run npx @runlight/server --help.`);

  await server.runlight.init();
  if (mailTo) {
    if (!(await server.runlight.mailSettings())) throw new Error("Configure Runlight's mail service before enabling CronWatch alerts");
    monitoring = createMonitoring({ runlight: server.runlight, dataDir, to: mailTo, ...(url ? { url } : {}), ...(geo ? { geo } : {}) });
    monitoring.start();
  }
  const port = Number(env("PORT") ?? 3000);
  const host = env("HOST") ?? "0.0.0.0";
  const http = createHttpServer(async (req, res) => {
    try {
      const response = await server.handler(await toRequest(req, res), { ip: req.socket.remoteAddress ?? "" });
      await writeResponse(res, response);
    } catch (error) {
      // An upload cut off part way leaves the connection unfit for another request, so it closes.
      if (error instanceof BodyTooLarge) return void (res.headersSent || res.writeHead(413, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ error: "That request is too large" })));
      console.error("Runlight:", error);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  http.listen(port, host, async () => {
    const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
    console.log(`Runlight ${VERSION} is listening on http://${shown}:${port}`);
    console.log(`Data: ${rowDatabase(dataDir)}`);
    if (env("CLICKHOUSE_URL")) console.log(`Visits: ClickHouse, ${new URL(env("CLICKHOUSE_URL")!).host}`);
    if ((await server.accounts.count()) === 0) {
      console.log(`\nNo account yet. Open this link to create the first one:\n  http://${shown}:${port}/setup?code=${server.setupCode}\n`);
    }
  });

  // The scheduled check (salts, email reports, retention, and rollups) and this month's location data: now, then every five minutes.
  const tick = () => {
    (monitoring ? monitoring.maintenance() : server.check()).catch((error) => console.error("Runlight: the scheduled check failed", error));
    (monitoring ? monitoring.locations() : geo?.refresh())?.catch((error) => console.error("Runlight: could not refresh location data", error));
  };
  void tick();
  const timer = setInterval(tick, 5 * 60_000);
  timer.unref();

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    // Hits waiting for ClickHouse that are being sent now finish first, so the next start does not send them again.
    const settled = Promise.race([server.runlight.flushWaiting(), new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
    http.close(() => void settled.catch(() => {}).then(() => monitoring?.close()).finally(() => store.close()).finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((error) => {
  console.error(`Runlight: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

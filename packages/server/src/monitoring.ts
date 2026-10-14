import path from "node:path";
import { cronwatch, custom, type Store } from "@cronwatch/sdk";
import { sqlite } from "@cronwatch/sdk/sqlite";
import type { Runlight } from "@runlight/sdk";
import type { Geo } from "./geo.js";

export interface MonitoringOptions {
  runlight: Runlight;
  dataDir: string;
  to: string;
  url?: string;
  geo?: Pick<Geo, "refresh" | "release">;
  store?: Store;
}

/** Uses the instance's saved mail settings, including its verified sender and encrypted credentials. */
export function createMonitoring(options: MonitoringOptions) {
  const to = options.to.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("Set CRONWATCH_MAIL_TO to an email address");
  const cw = cronwatch({
    store: options.store ?? sqlite({ path: path.join(options.dataDir, "cronwatch.db") }),
    alerts: [custom("runlight-mail", async (alert) => {
      const link = options.url ? `${options.url.replace(/\/$/, "")}/cronwatch` : "";
      const text = `${alert.message}\n${alert.run?.error ? `\n${alert.run.error}\n` : ""}${link ? `\n${link}\n` : ""}`;
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      await options.runlight.sendMail({
        to,
        subject: `[CronWatch] ${alert.title.replace(/[\r\n]/g, " ")}`,
        text,
        html: `<pre style="white-space:pre-wrap;font:15px/1.6 sans-serif">${escaped}</pre>`,
      });
    })],
  });
  const maintenance = cw.job("runlight-maintenance", {
    schedule: "every 5m", grace: "2m", timeout: "15m", maxDuration: "2m",
    floor: { reports_sent: 0, reports_failed: 0, sites_checked: 0, completed: 1 },
    expect: "Maintenance completed",
    description: "Daily salts, due email reports, retention cleanup, and daily rollups.",
  });
  const locations = options.geo ? cw.job("runlight-location-data", {
    schedule: "every 5m", grace: "2m", timeout: "25m", maxDuration: "12m",
    floor: { database_available: 1 },
    expect: "Location data checked",
    description: "Check the DB-IP database and download a newer release when needed.",
  }) : null;
  let maintenanceRun: Promise<void> | null = null;
  let locationsRun: Promise<void> | null = null;
  return {
    client: cw,
    handler: cw.routes({ token: null, basePath: "/cronwatch", ...(options.url ? { origin: new URL(options.url).origin } : {}) }).handler,
    maintenance(): Promise<void> {
      maintenanceRun ??= maintenance.run(async (job) => {
        const result = await options.runlight.check();
        job.metrics({ reports_sent: result.reports.sent, reports_failed: result.reports.failed, sites_checked: options.runlight.sites.length });
        if (result.reports.failed) throw new Error(`${result.reports.failed} scheduled email reports failed`);
        job.metric("completed", 1);
        job.log("Maintenance completed");
      }).finally(() => { maintenanceRun = null; });
      return maintenanceRun;
    },
    locations(): Promise<void> {
      if (!locations || !options.geo) return Promise.resolve();
      const geo = options.geo;
      locationsRun ??= locations.run(async (job) => {
        await geo.refresh();
        job.metric("database_available", geo.release ? 1 : 0);
        if (!geo.release) throw new Error("No usable location database is available");
        const now = new Date();
        const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
        if (geo.release < oldest) throw new Error("The location database is more than one release behind");
        job.log("Location data checked", geo.release);
      }).finally(() => { locationsRun = null; });
      return locationsRun;
    },
    start: () => cw.startChecking(),
    async close() {
      cw.stop();
      await Promise.allSettled([maintenanceRun, locationsRun]);
      await cw.close();
    },
  };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { buckets, compareRange, localDate, resolveRange, startOf } from "../src/time.js";

test("a local day starts at local midnight", () => {
  assert.equal(new Date(startOf("2026-07-01", "Europe/London")).toISOString(), "2026-06-30T23:00:00.000Z");
  assert.equal(new Date(startOf("2026-01-15", "America/Toronto")).toISOString(), "2026-01-15T05:00:00.000Z");
  assert.equal(new Date(startOf("2026-01-15", "Asia/Kolkata")).toISOString(), "2026-01-14T18:30:00.000Z");
  assert.equal(new Date(startOf("2026-01-15", "UTC")).toISOString(), "2026-01-15T00:00:00.000Z");
});

test("the spring DST change makes a 23 hour day", () => {
  const range = resolveRange({ from: "2026-03-07", to: "2026-03-09" }, "America/Toronto", Date.UTC(2026, 2, 10))!;
  const days = buckets(range, "America/Toronto");
  assert.equal(days.length, 3);
  assert.deepEqual(days.map((d) => (d.end - d.start) / 3_600_000), [24, 23, 24]);
});

test("named periods resolve in the site's timezone", () => {
  const now = Date.UTC(2026, 9, 6, 2, 0); // 2026-10-06 02:00 UTC is still the 5th in Toronto
  assert.equal(localDate(now, "America/Toronto"), "2026-10-05");
  const today = resolveRange({ period: "today" }, "America/Toronto", now)!;
  assert.equal(today.fromDate, "2026-10-05");
  assert.equal(today.interval, "hour");
  const week = resolveRange({ period: "7d" }, "UTC", now)!;
  assert.equal(week.fromDate, "2026-09-30");
  assert.equal(week.toDate, "2026-10-06");
  const lastMonth = resolveRange({ period: "last_month" }, "UTC", now)!;
  assert.deepEqual([lastMonth.fromDate, lastMonth.toDate], ["2026-09-01", "2026-09-30"]);
  assert.equal(resolveRange({ period: "12mo" }, "UTC", now)!.interval, "month");
  assert.equal(resolveRange({ period: "nope" }, "UTC", now), null);
  assert.equal(resolveRange({ from: "2026-10-05", to: "2026-10-01" }, "UTC", now), null);
  assert.equal(resolveRange({ from: "2026-02-30", to: "2026-03-01" }, "UTC", now), null);
});

test("month buckets start on the first", () => {
  const range = resolveRange({ from: "2026-01-15", to: "2026-03-10", interval: "month" }, "UTC", Date.UTC(2026, 3, 1))!;
  const months = buckets(range, "UTC");
  assert.equal(months.length, 3);
  assert.equal(new Date(months[0]!.start).toISOString(), "2026-01-15T00:00:00.000Z");
  assert.equal(new Date(months[1]!.start).toISOString(), "2026-02-01T00:00:00.000Z");
  assert.equal(new Date(months[2]!.end).toISOString(), "2026-03-11T00:00:00.000Z");
});

test("comparison ranges: previous, a year back, custom, and off", () => {
  const now = Date.UTC(2026, 9, 6, 12);
  const week = resolveRange({ period: "7d" }, "UTC", now)!;
  const prev = compareRange(week, "previous", "UTC")!;
  assert.deepEqual([prev.fromDate, prev.toDate], ["2026-09-23", "2026-09-29"]);
  assert.equal(prev.to, week.from);
  const year = compareRange(week, "year", "UTC")!;
  assert.deepEqual([year.fromDate, year.toDate], ["2025-09-30", "2025-10-06"]);
  const leap = compareRange(resolveRange({ from: "2028-02-29", to: "2028-02-29" }, "UTC", now)!, "year", "UTC")!;
  assert.equal(leap.fromDate, "2027-02-28");
  const custom = compareRange(week, "custom", "UTC", { from: "2026-01-01", to: "2026-01-07" })!;
  assert.equal(custom.fromDate, "2026-01-01");
  assert.equal(compareRange(week, "custom", "UTC", { from: "2026-01-07", to: "2026-01-01" }), null);
  assert.equal(compareRange(week, "off", "UTC"), null);
});

test("a day whose midnight is skipped by the clocks begins when they land", () => {
  // Santiago, Havana, and the Azores move their clocks forward at midnight.
  for (const [date, zone, start] of [
    ["2026-09-06", "America/Santiago", "2026-09-06T04:00:00.000Z"],
    ["2026-03-08", "America/Havana", "2026-03-08T05:00:00.000Z"],
    ["2026-03-29", "Atlantic/Azores", "2026-03-29T01:00:00.000Z"],
  ] as const) {
    const at = startOf(date, zone);
    assert.equal(new Date(at).toISOString(), start, zone);
    assert.equal(localDate(at, zone), date);
    assert.notEqual(localDate(at - 1, zone), date);
  }
});

test("a date with a month or day that does not exist is not a date, rather than an error", async () => {
  const { isDate } = await import("../src/time.js");
  for (const bad of ["2026-13-01", "2026-00-05", "2026-02-30", "2026-04-31", "2026-1-01", "9999-12-31", "0001-01-01"]) assert.equal(isDate(bad), false, bad);
  assert.equal(isDate("2028-02-29"), true);
  const { setup } = await import("./helpers.js");
  const t = setup("sqlite");
  const answer = await t.routes.GET(new Request("https://example.com/runlight/api/stats?from=2026-13-01&to=2026-13-05", { headers: { authorization: "Bearer secret" } }));
  assert.equal(answer.status, 400);
});

test("an interval too fine for a long range moves up to one that fits, and no bucket takes in the rest", () => {
  const now = Date.UTC(2026, 9, 12, 12);
  const DAY = 86_400_000;
  const hourly = resolveRange({ from: "2026-08-01", to: "2026-09-09", interval: "hour" }, "UTC", now)!;
  assert.equal(hourly.interval, "day", "40 days of hours is too many hours");
  assert.equal(buckets(hourly, "UTC").length, 40);
  assert.equal(resolveRange({ from: "2026-08-01", to: "2026-08-31", interval: "hour" }, "UTC", now)!.interval, "hour", "a month of hours still fits");

  const daily = resolveRange({ from: "2018-01-03", to: "2026-10-12", interval: "day" }, "Europe/London", now)!;
  assert.equal(daily.interval, "week");
  const weeks = buckets(daily, "Europe/London");
  assert.equal(weeks[0]!.start, daily.from);
  assert.equal(weeks.at(-1)!.end, daily.to, "the buckets reach the end of the range");
  for (const [i, week] of weeks.entries()) {
    if (i > 0) assert.equal(week.start, weeks[i - 1]!.end);
    // A week across a clock change is an hour short or long; none is longer than that.
    assert.ok(week.end - week.start <= 7 * DAY + 3_600_000, `week ${i} is ${(week.end - week.start) / DAY} days`);
    if (i > 0 && i < weeks.length - 1) assert.ok(week.end - week.start >= 7 * DAY - 3_600_000);
  }

  const decades = resolveRange({ from: "1990-01-01", to: "2026-10-12", interval: "day" }, "UTC", now)!;
  assert.equal(decades.interval, "month");
  const months = buckets(decades, "UTC");
  assert.equal(months.length, 442);
  assert.ok(months.every((m) => m.end - m.start <= 31 * DAY));
  assert.equal(resolveRange({ from: "1900-01-01", to: "2026-10-12" }, "UTC", now), null, "past 1,000 months there is no interval that fits");

  // A comparison longer than its range keeps whole buckets, cut off at a boundary.
  const longer = { ...decades, from: Date.UTC(2000, 0, 1), fromDate: "2000-01-01", toDate: "2026-10-12", interval: "day" as const };
  const cut = buckets(longer, "UTC");
  assert.equal(cut.length, 1000);
  assert.equal(cut.at(-1)!.end - cut.at(-1)!.start, DAY);
});

test("a day where clocks fall back across midnight begins at the first midnight", () => {
  // Amman in 2019, Gaza and Hebron in 2020, an hour each, and three hours at Casey station in 2019.
  for (const [date, zone] of [["2019-10-25", "Asia/Amman"], ["2020-10-24", "Asia/Gaza"], ["2020-10-24", "Asia/Hebron"], ["2019-03-17", "Antarctica/Casey"]] as const) {
    const start = startOf(date, zone);
    assert.equal(localDate(start, zone), date, zone);
    assert.ok(localDate(start - 1, zone) < date, `${zone}: the moment before is the day before`);
  }
});

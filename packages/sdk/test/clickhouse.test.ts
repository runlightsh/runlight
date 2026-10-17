import assert from "node:assert/strict";
import { test } from "node:test";
import { SqlStore } from "../src/store.js";
import { ClickHouseStore, bindPlaceholders } from "../src/stores/clickhouse.js";

test("ClickHouse placeholders are typed by their values, outside quotes only", () => {
  const bound = bindPlaceholders("SELECT ? WHERE a = '?' AND b = ? AND c = 'it\\'s ?' AND d IN (?, ?) AND e = ?", [1, "x\ty", 2.5, null, true]);
  assert.equal(bound.sql, "SELECT {p0:Int64} WHERE a = '?' AND b = {p1:String} AND c = 'it\\'s ?' AND d IN ({p2:Float64}, {p3:Nullable(String)}) AND e = {p4:Bool}");
  assert.deepEqual(bound.values, { p0: "1", p1: "x\\ty", p2: "2.5", p3: "\\N", p4: "true" });
  assert.throws(() => bindPlaceholders("SELECT ?, ?", [1]), /more placeholders than values/);
});

test("every store method that reads or writes visits or events has its ClickHouse version", () => {
  // A method whose SQL names the visit tables, or that builds on the helpers that do, would otherwise read
  // the other store's tables, which ClickHouse leaves empty. Methods that only clear rollups, and private
  // helpers called only from methods ClickHouseStore has its own of, are left be.
  const visitSql = /rl_sessions|rl_events|rl_rollups|rl_rollup_days|visitRows\(|visitScope\(|rolledStats\(|rolledBreakdown\(|rollupPlan\(/;
  const leftBe = new Set(["constructor", "clearRollups", "touchedOldVisit", "rollupPlan", "rolledStats", "rolledBreakdown", "oldest", "optimize", "deleteGoal", "migrate", "rawGoalTotalsAll"]);
  const missing: string[] = [];
  for (const name of Object.getOwnPropertyNames(SqlStore.prototype)) {
    if (leftBe.has(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(SqlStore.prototype, name)!;
    if (typeof descriptor.value !== "function") continue;
    if (!visitSql.test(String(descriptor.value))) continue;
    if (!Object.hasOwn(ClickHouseStore.prototype, name)) missing.push(name);
  }
  assert.deepEqual(missing, [], "Add these to ClickHouseStore, or to the list above if they never touch visits");
});

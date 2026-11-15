import assert from "node:assert/strict";
import { test } from "node:test";
import { ignoreHolds } from "../src/ignore.js";

test("the opt-out flag holds as the tracker reads it: the switch's for good, a link's for a year", () => {
  const now = Date.UTC(2026, 10, 14);
  const year = 365 * 86_400_000;
  assert.equal(ignoreHolds(null, now), false);
  assert.equal(ignoreHolds("1", now), true);
  assert.equal(ignoreHolds(String(now - year + 1), now), true);
  assert.equal(ignoreHolds(String(now - year), now), false);
});

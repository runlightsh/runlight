import assert from "node:assert/strict";
import { after, test } from "node:test";
import { STORES, cleanup, setup } from "./helpers.js";

after(cleanup);

for (const kind of STORES) {
  test(`${kind}: hostname suggestions respect visits, filters, dates, and sites without counting totals`, async () => {
    const t = setup(kind, { sites: [
      { id: "a", hostnames: ["a.example.com", "b.example.com", "old.example.com", "event.example.com"] },
      { id: "other", hostnames: ["private.example.com"] },
    ] });
    await t.send({ s: "a", k: "pageview", u: "https://old.example.com/", i: "old" });
    t.advance(86_400_000);
    await t.send({ s: "a", k: "pageview", u: "https://b.example.com/pricing", i: "b" });
    await t.send({ s: "a", k: "pageview", u: "https://a.example.com/", i: "a" }, { ip: "203.0.113.2" });
    await t.send({ s: "a", k: "pageview", u: "https://a.example.com/", i: "a2" }, { ip: "203.0.113.3" });
    await t.send({ s: "a", k: "event", u: "https://event.example.com/", n: "Signup" }, { ip: "203.0.113.4" });
    await t.send({ s: "other", k: "pageview", u: "https://private.example.com/", i: "private" });
    const path = "/api/breakdown?site=a&period=today&dimension=hostname&suggestions=1";
    t.rl.store.breakdown = async () => { throw new Error("Suggestions must not calculate breakdown totals"); };
    assert.deepEqual((await t.get(path)).rows, [{ value: "a.example.com" }, { value: "b.example.com" }]);
    assert.deepEqual((await t.get(`${path}&limit=1`)).rows, [{ value: "a.example.com" }]);
    assert.deepEqual((await t.get(`${path}&filter=${encodeURIComponent("page:is:/pricing")}`)).rows, [{ value: "b.example.com" }]);
    assert.deepEqual((await t.get(`${path}&filter=${encodeURIComponent("page:is:/missing")}`)).rows, []);
    const denied = await t.routes.GET(new Request(`https://example.com/runlight${path}`));
    assert.equal(denied.status, 401);
  });
}

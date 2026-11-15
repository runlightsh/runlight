import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { STORES, cleanup, setup, visitsDb, type StoreKind } from "./helpers.js";

after(cleanup);

for (const kind of STORES) describe(kind, () => suite(kind));

function suite(kind: StoreKind) {
  test("an event's properties and their values, filtered like everything else", async () => {
    const t = setup(kind);
    const out = (url: string, ip: string, path = "/") => t.send({ k: "event", u: `https://example.com${path}`, n: "Outbound link", p: { url } }, { ip });
    await out("https://github.com/x", "203.0.113.1");
    await out("https://github.com/x", "203.0.113.2", "/blog");
    await out("https://news.ycombinator.com/", "203.0.113.1");
    await t.send({ k: "event", u: "https://example.com/missing", n: "404", p: { path: "/missing" } });
    await t.send({ k: "event", u: "https://example.com/", n: "Signup", p: { plan: "pro", seats: 3 } });
    await t.send({ k: "event", u: "https://example.com/", n: "Signup", p: { plan: "team" } });

    const links = await t.get("/api/event-props?period=today&event=Outbound%20link");
    assert.deepEqual(links.keys, [{ key: "url", events: 3 }]);
    assert.equal(links.key, "url");
    assert.deepEqual(links.rows, [
      { value: "https://github.com/x", events: 2, visitors: 2 },
      { value: "https://news.ycombinator.com/", events: 1, visitors: 1 },
    ]);

    const signup = await t.get("/api/event-props?period=today&event=Signup");
    assert.deepEqual(signup.keys.map((k: { key: string }) => k.key), ["plan", "seats"]);
    assert.deepEqual((await t.get("/api/event-props?period=today&event=Signup&key=seats")).rows, [{ value: "3", events: 1, visitors: 1 }]);

    const blog = await t.get("/api/event-props?period=today&event=Outbound%20link&filter=page:is:/blog");
    assert.deepEqual(blog.rows.map((r: { value: string }) => r.value), ["https://github.com/x"]);

    const none = await t.get("/api/event-props?period=today&event=Nothing");
    assert.deepEqual({ keys: none.keys, key: none.key, rows: none.rows }, { keys: [], key: null, rows: [] });
    const bad = await t.routes.GET(new Request('https://example.com/runlight/api/event-props?period=today&event=Signup&key=a"b', { headers: { authorization: "Bearer secret" } }));
    assert.equal(bad.status, 400);
  });

  test("props a database cannot read as JSON count as none, and the rest are still read", async () => {
    const t = setup(kind);
    await t.send({ k: "event", u: "https://example.com/", n: "Purchase", p: { revenue: 10 } }, { ip: "203.0.113.1" });
    await t.send({ k: "event", u: "https://example.com/", n: "Purchase", p: { revenue: "20.5" } }, { ip: "203.0.113.2" });
    // Rows as an earlier version stored them: an escaped NUL, which Postgres refuses, and half a surrogate
    // pair (an emoji cut in two), which Postgres and MySQL refuse.
    const [seen] = await visitsDb(t.rl.store).all<{ visitor: string; session: string }>(`SELECT visitor, session FROM rl_events WHERE kind = 'event' LIMIT 1`);
    for (const note of ["a\u0000b", "cut\ud83d"]) {
      await t.rl.store.insertEvent({
        site: "default", ts: t.now, kind: "event", visitor: seen!.visitor, session: seen!.session, pageview: "", path: "/", hostname: "example.com",
        title: "", name: "Purchase", props: { note }, engagedMs: 0, scroll: null, link: "",
      });
    }
    const props = await t.get("/api/event-props?period=today&event=Purchase&key=revenue");
    assert.deepEqual(props.keys.find((k: { key: string }) => k.key === "revenue"), { key: "revenue", events: 2 });
    assert.deepEqual(props.rows, [
      { value: "10", events: 1, visitors: 1 },
      { value: "20.5", events: 1, visitors: 1 },
    ]);
    const goal = { id: "g1", site: "default", name: "Purchase", kind: "event", match: "Purchase", clickBy: "", valueMode: "prop", value: 0, valueProp: "revenue", currency: "USD", createdAt: t.now } as const;
    await t.rl.store.saveGoal(goal);
    const query = { site: "default", from: t.now - 86_400_000, to: t.now + 86_400_000, filters: [] };
    const totals = (await t.rl.store.goalTotalsAll(query, [goal])).get("g1");
    assert.deepEqual(totals, { conversions: 4, visitors: 2, revenue: 30.5 });
    assert.deepEqual(await t.rl.store.goalTotals(query, goal), totals);
  });
}

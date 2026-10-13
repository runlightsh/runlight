import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { TRACKER } from "../src/generated/tracker.js";

function browser(hook: string, beacon = true, configured = true) {
  const sent: string[] = [];
  const listeners: Record<string, () => void> = {};
  let clock = 1000;
  const location = new URL("https://app.example.com/s/private-token?token=secret#private");
  const context: Record<string, unknown> = {
    URL, Uint8Array, location, screen: { width: 1200, height: 800 },
    Date: { now: () => clock },
    navigator: { language: "en", sendBeacon: (_url: string, body: string) => { if (beacon) sent.push(body); return beacon; } },
    localStorage: { getItem: () => null },
    history: { pushState() {}, replaceState() {} },
    document: {
      title: "Private note title", referrer: "https://app.example.com/notes/secret-id?key=secret",
      currentScript: { src: "https://analytics.example.com/s.js?site=example.com", getAttribute: (key: string) => key === "data-before-send" && configured ? "scrub" : key === "data-site" ? "example.com" : null },
      visibilityState: "visible", hasFocus: () => true, documentElement: { scrollHeight: 1000, scrollTop: 0 },
      addEventListener: (name: string, fn: () => void) => { listeners[name] = fn; },
    },
    addEventListener: (name: string, fn: () => void) => { listeners[name] = fn; },
    innerHeight: 800,
    fetch: (_url: string, init: { body: string }) => { sent.push(init.body); return Promise.resolve(); },
  };
  context.window = context;
  runInNewContext(hook + "\n" + TRACKER, context);
  return { sent, context, leave: () => { clock += 2000; listeners.pagehide!(); } };
}

test("the before-send hook scrubs pageviews, SPA referrers, events, and engagement on both transports", () => {
  for (const beacon of [true, false]) {
    const b = browser(`window.scrub=function(p){p.u="https://app.example.com/s/:id";if("r" in p)p.r="https://app.example.com";if("t" in p)p.t="/s/:id";if(p.p)p.p={safe:true};return p;};`, beacon);
    const track = b.context.runlight as ((name: string, props: object) => void) & { pageview: (url: string) => void };
    track("Test", { url: "https://app.example.com/s/secret", title: "Private note title" });
    b.leave();
    track.pageview("/notes/secret-id?token=secret");
    assert.equal(b.sent.length, 4);
    assert.deepEqual(b.sent.map(s => JSON.parse(s).k), ["pageview", "event", "engagement", "pageview"]);
    for (const body of b.sent) {
      assert.doesNotMatch(body, /private-token|secret|Private note title/);
      assert.equal(JSON.parse(body).u, "https://app.example.com/s/:id");
      assert.match(JSON.parse(body).i, /^[a-z0-9]{12}$/);
    }
  }
});

test("a configured scrubber fails closed when absent, throwing, or returning an invalid value", () => {
  for (const hook of ["", "window.scrub=()=>{throw Error('no')}", ...["null", "false", "'text'", "[]", "Promise.resolve({})"].map(value => `window.scrub=()=>${value};`)]) {
    const b = browser(hook);
    (b.context.runlight as (name: string) => void)("Test");
    b.leave();
    assert.equal(b.sent.length, 0, hook);
  }
});

test("without the attribute, normal tracking remains enabled", () => {
  const b = browser("", true, false);
  assert.equal(b.sent.length, 1);
  assert.equal(JSON.parse(b.sent[0]!).t, "Private note title");
});

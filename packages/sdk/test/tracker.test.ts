import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { TRACKER } from "../src/generated/tracker.js";

/** A Blob that keeps its parts and type, so a test can read what the tracker sent and as what. */
class FakeBlob {
  constructor(readonly parts: string[], options?: { type?: string }) { this.type = options?.type ?? ""; }
  type: string;
}
const text = (body: string | FakeBlob) => (typeof body === "string" ? body : body.parts.join(""));

function browser(hook: string, beacon: boolean | "throws" = true, configured = true, stand: { webdriver?: boolean; manual?: boolean; ignored?: boolean; src?: string } = {}) {
  const sent: string[] = [];
  const types: string[] = [];
  const via: string[] = [];
  const later: Array<() => void> = [];
  const listeners: Record<string, () => void> = {};
  let clock = 1000;
  const location = new URL("https://app.example.com/s/private-token?token=secret#private");
  const context: Record<string, unknown> = {
    URL, Uint8Array, crypto: globalThis.crypto, Blob: FakeBlob, location, screen: { width: 1200, height: 800 }, scrollY: 0,
    Date: { now: () => clock },
    navigator: {
      language: "en", webdriver: stand.webdriver ?? false,
      sendBeacon: (_url: string, body: string | FakeBlob) => {
        if (beacon === "throws") throw new TypeError("not allowed");
        if (beacon) { sent.push(text(body)); types.push(typeof body === "string" ? "string" : body.type); via.push("beacon"); }
        return beacon;
      },
    },
    localStorage: { getItem: (key: string) => (key === "runlight_ignore" && stand.ignored ? "1" : null), setItem() {}, removeItem() {} },
    history: { pushState(_s: unknown, _t: string, to: string) { location.href = new URL(to, location.href).href; }, replaceState() {} },
    setTimeout: (fn: () => void) => { later.push(fn); },
    document: {
      title: "Private note title", referrer: "https://app.example.com/notes/secret-id?key=secret",
      currentScript: { src: stand.src ?? "https://analytics.example.com/s.js?site=example.com", getAttribute: (key: string) => key === "data-before-send" && configured ? "scrub" : key === "data-site" ? "example.com" : key === "data-manual" && stand.manual ? "" : null },
      visibilityState: "visible", hasFocus: () => true, documentElement: { scrollHeight: 1000, scrollTop: 0 },
      addEventListener: (name: string, fn: () => void) => { listeners[name] = fn; },
    },
    addEventListener: (name: string, fn: () => void) => { listeners[name] = fn; },
    innerHeight: 800,
    fetch: (_url: string, init: { body: string | FakeBlob }) => { sent.push(text(init.body)); types.push(typeof init.body === "string" ? "string" : init.body.type); via.push("fetch"); return Promise.resolve(); },
  };
  context.window = context;
  runInNewContext(hook + "\n" + TRACKER, context);
  return { sent, types, via, context, leave: () => { clock += 2000; listeners.pagehide!(); }, wait: () => later.splice(0).forEach((fn) => fn()) };
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

test("a tracker standing down still answers every call, runlight.pageview() included, and sends nothing", () => {
  // An automated browser (a site's own end-to-end tests) and the owner's ignore flag, with manual pageviews,
  // as a single page app calls them on each route change.
  for (const stand of [{ webdriver: true, manual: true }, { ignored: true, manual: true }, { webdriver: true }]) {
    const b = browser("", true, false, stand);
    const track = b.context.runlight as ((name: string, props?: object) => void) & { pageview: (url?: string) => void };
    assert.doesNotThrow(() => {
      track.pageview("/checkout");
      track.pageview();
      track("Signup", { plan: "pro" });
    }, JSON.stringify(stand));
    b.leave();
    assert.equal(b.sent.length, 0, JSON.stringify(stand));
  }
});

test("a single page app's pageview carries the title the new page sets, not the one before", () => {
  const b = browser("", true, false);
  const doc = b.context.document as { title: string };
  const history = b.context.history as { pushState: (s: unknown, t: string, to: string) => void };
  // A router changes the address first, then renders the page, which sets its title.
  history.pushState({}, "", "/pricing");
  doc.title = "Pricing";
  b.wait();
  const last = JSON.parse(b.sent[b.sent.length - 1]!);
  assert.deepEqual([last.k, new URL(last.u).pathname, last.t], ["pageview", "/pricing", "Pricing"]);
});

test("visits go as JSON to the page's own site and as text/plain to another, by beacon or else by fetch", () => {
  // OWASP's rule set, which many shared hosts run, refuses a text/plain body; to another site, text/plain needs
  // no CORS preflight.
  const same = { src: "https://app.example.com/runlight/s.js" };
  for (const [beacon, stand, type, via] of [
    [true, same, "application/json", "beacon"],
    [false, same, "application/json", "fetch"],
    ["throws", same, "application/json", "fetch"],
    [true, {}, "text/plain", "beacon"],
    [false, {}, "text/plain", "fetch"],
    ["throws", {}, "text/plain", "fetch"],
  ] as const) {
    const b = browser("", beacon, false, stand);
    (b.context.runlight as (name: string) => void)("Signup");
    const label = `${JSON.stringify(stand)} beacon=${beacon}`;
    assert.deepEqual(b.sent.map((s) => JSON.parse(s).k), ["pageview", "event"], label);
    assert.deepEqual(b.types, [type, type], label);
    assert.deepEqual(b.via, [via, via], label);
  }
  // Only the page's own origin is the page's own site: not a host that begins with its name, nor another port.
  for (const src of ["https://app.example.com.other.test/runlight/s.js", "https://app.example.com:8443/runlight/s.js", "http://app.example.com/runlight/s.js"]) {
    assert.deepEqual(browser("", true, false, { src }).types, ["text/plain"], src);
  }
});

test("a copy inlined into the page, with no src, sets up without throwing", () => {
  // An optimizer that inlines scripts leaves currentScript with an empty src; site code calling runlight() must
  // still find it.
  const b = browser("", true, false, { src: "" });
  assert.equal(typeof b.context.runlight, "function");
  assert.doesNotThrow(() => (b.context.runlight as (name: string) => void)("Signup"));
});

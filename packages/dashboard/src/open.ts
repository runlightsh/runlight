import { cms, embedOrigin } from "./api.js";

/** Inside a CMS's admin the whole dashboard sits in a frame, too small for modals, sheets, and drawers. */
export const framed = Boolean(cms) && window.top !== window.self;

/**
 * The origin of the admin page around this one when it is framed there, whole by the CMS itself or read-only
 * from another Runlight, or empty. Messages to that page go only to it, and only its messages are heard.
 */
const host = window.parent === window.self ? "" : embedOrigin || (framed ? location.origin : "");

/**
 * Framed in an admin page, tells it how tall the dashboard is, so the frame grows to fit and the admin page
 * scrolls like any other. The frame's viewport is then the whole dashboard, so the page reports which slice of
 * the frame is on screen, and drawers and sheets cover that slice, through the custom properties it sets.
 */
export function fitFrame(): void {
  if (!host) return;
  const root = document.documentElement;
  root.classList.add("framed");
  let sent = 0;
  let queued = false;
  // Many changes can land in one frame, such as every box filling in, so the height goes once per frame.
  new ResizeObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const height = Math.ceil(root.getBoundingClientRect().height);
      if (height === sent) return;
      sent = height;
      window.parent.postMessage({ type: "runlight:height", height }, host);
    });
  }).observe(root);
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== host) return;
    const data = event.data as { type?: unknown; top?: unknown; height?: unknown } | null;
    if (data?.type !== "runlight:viewport" || typeof data.top !== "number" || typeof data.height !== "number") return;
    if (!Number.isFinite(data.top) || !Number.isFinite(data.height)) return;
    root.style.setProperty("--frame-top", `${Math.max(0, data.top)}px`);
    root.style.setProperty("--frame-height", `${Math.max(0, data.height)}px`);
  });
}

/**
 * What this tab was opened to show, from `?open=`. It is read once: writeUrl never writes it back, so it is
 * gone from the address after the first load, and each opener takes its match so closing it keeps it closed.
 */
let wanted = new URLSearchParams(location.search).get("open") ?? "";

/**
 * Framed, opens the dashboard in a new tab with `what` open and says so; anywhere else does nothing and says
 * so, and the caller opens it in place. The new tab keeps the site, range, and filters, which are in the query.
 */
export function openInTab(what: string): boolean {
  if (!framed) return false;
  const params = new URLSearchParams(location.search);
  params.set("open", what);
  window.open(`${location.pathname}?${params}`, "_blank", "noopener");
  return true;
}

/** Whether this tab was opened to show `what`, for an opener's first state. */
export function opening(what: string): boolean {
  if (wanted !== what) return false;
  wanted = "";
  return true;
}

/** For an opener that carries a name or an id: what follows `prefix:` when this tab was opened to show it, or null. */
export function openingIn(prefix: string): string | null {
  if (!wanted.startsWith(`${prefix}:`)) return null;
  const rest = wanted.slice(prefix.length + 1);
  wanted = "";
  return rest;
}

/*
 * Runlight's dashboard in a frame on a CMS's admin page, for the WordPress, Drupal, and Craft plugins alike:
 * runlightFrame(frame) grows the frame to the dashboard's height, tells the dashboard which part of it is on
 * screen, and reloads the page when the dashboard asks, which it does once its session has run out.
 *
 * The frame says the rest in data attributes: data-runlight-origin, the dashboard's origin, which alone may
 * talk to the page; data-runlight-bars, a selector for the admin's own bars that stay on screen over the page;
 * and data-runlight-gap, the room in pixels to leave below the frame until the dashboard says how tall it is.
 */
window.runlightFrame = function (frame) {
  if (!frame) return;
  var origin = frame.getAttribute("data-runlight-origin");
  var bars = frame.getAttribute("data-runlight-bars") || "";
  var gap = Number(frame.getAttribute("data-runlight-gap")) || 0;
  // Until the dashboard says how tall it is, the frame fills the window below it; an older Runlight never says.
  var sized = false;
  function fit() {
    if (sized) return;
    var top = frame.getBoundingClientRect().top + window.scrollY;
    frame.style.height = Math.max(600, window.innerHeight - top - gap) + "px";
  }
  // The admin's own bars stay on screen over the page, so the visible slice starts below them.
  function covered() {
    var bottom = 0;
    if (!bars) return bottom;
    document.querySelectorAll(bars).forEach(function (bar) {
      var position = getComputedStyle(bar).position;
      var box = bar.getBoundingClientRect();
      if ((position === "fixed" || position === "sticky") && box.top <= 1 && box.height > 0) bottom = Math.max(bottom, box.bottom);
    });
    return bottom;
  }
  // Tells the dashboard which slice of the frame is on screen, so its drawers and sheets cover just that.
  var queued = false;
  function viewport() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      var rect = frame.getBoundingClientRect();
      var top = Math.max(rect.top, covered());
      var height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - top);
      if (frame.contentWindow) frame.contentWindow.postMessage({ type: "runlight:viewport", top: top - rect.top, height: height }, origin);
    });
  }
  fit();
  window.addEventListener("resize", function () {
    fit();
    viewport();
  });
  window.addEventListener("scroll", viewport, { passive: true, capture: true });
  frame.addEventListener("load", viewport);
  window.addEventListener("message", function (event) {
    if (event.origin !== origin || event.source !== frame.contentWindow || !event.data) return;
    if (event.data.type === "runlight:reload") location.reload();
    if (event.data.type === "runlight:height" && typeof event.data.height === "number" && isFinite(event.data.height)) {
      sized = true;
      frame.style.height = Math.max(600, Math.ceil(event.data.height)) + "px";
      viewport();
    }
  });
};

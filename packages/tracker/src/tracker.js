// The Runlight tracker. No cookies, nothing in storage except the owner's
// opt-out flag, and no id that outlives the page.
//
//   <script defer src="/runlight/s.js"></script>
//
// Attributes on the script tag:
//   data-site="id"         which site, for the standalone server
//   data-hash              count changes to location.hash as pageviews
//   data-404               this page is a 404, record it as one
//   data-dnt               honour Do Not Track
//   data-outbound="false"  do not record outbound link clicks
//   data-downloads="false" do not record file downloads
//   data-exclude="/admin/*,/preview/*"  record nothing on these pages
//   data-manual            no automatic pageviews; call runlight.pageview(url?)
//   data-before-send="fn"  synchronous window function that scrubs each payload
//
// The server swaps the string below for each site's click goals.
// Arrow functions keep it under its size budget; every browser with sendBeacon or fetch has them.
(function () {
  var w = window;
  var d = document;
  var n = navigator;
  var loc = location;
  var script = d.currentScript;
  if (!script) return;

  var attr = (name) => script.getAttribute("data-" + name);
  var has = (name) => attr(name) !== null;
  var now = Date.now;
  var on = (target, name, fn, options) => target.addEventListener(name, fn, options);
  var base = script.src.replace(/s\.js(\?.*)?$/, "");
  var endpoint = base + "e";
  // To the page's own site, JSON, which web application firewalls expect: OWASP's rule set, on many shared
  // hosts, refuses a text/plain body outright. To another site, text/plain, which needs no CORS preflight.
  // script.src is absolute and spelled as an origin is, so a prefix match is a same-origin test that, unlike
  // new URL, cannot throw, even on an inlined copy with no src.
  var type = endpoint.indexOf(loc.origin + "/") ? "text/plain" : "application/json";
  var site = attr("site");
  var useHash = has("hash");
  var manual = has("manual");
  var beforeSend = attr("before-send");
  // A pattern with * as a wildcard, everything else literal.
  var glob = (p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  var excludes = (attr("exclude") || "").split(",").filter(Boolean).map((p) => glob(p.trim()));
  var skip = false;
  var queued = (w.runlight && w.runlight.q) || [];
  var all = "__RUNLIGHT_RULES__";
  var rules = (typeof all === "object" && (all[site] || all[loc.hostname.replace(/^www\./, "")] || all["*"])) || [];

  // ?runlight=ignore stops counting this browser on this site for a year, from when it was last opened;
  // ?runlight=track starts again. The owner's opt-out, never a visitor id. It holds the time it was set, so a
  // link someone else spread cannot hide a visitor for good. The "1" older versions kept, and the dashboard's
  // own switch still keeps, has no end.
  // Standing down sends nothing, but the script still sets up, so every call a site makes, runlight.pageview()
  // included, still works.
  var off = n.webdriver || (has("dnt") && (n.doNotTrack == 1 || w.doNotTrack == 1));
  var mode = (/[?&]runlight=(ignore|track|pick)\b/.exec(loc.search) || [])[1];
  try {
    var store = localStorage;
    var key = "runlight_ignore";
    if (mode === "ignore") store.setItem(key, now());
    if (mode === "track") store.removeItem(key);
    var since = store.getItem(key);
    if (since == 1 || now() - since < 31536e6) off = true;
  } catch (e) {}

  // Counts the page afresh: one the browser brought back whole, or one whose picker never started.
  var fresh = () => {
    pageUrl = "";
    manual || pageview();
  };

  // ?runlight=pick, opened from the dashboard with a ticket, loads the element picker and counts nothing. The
  // dashboard leaves this tab no handle on itself, so the ticket, which the install checks, is what tells: the
  // picker it serves for a good one says so on runlight.pick. For any other, or none, counting carries on once
  // the picker has loaded and said nothing, so a made-up ticket in a link hides nobody.
  var picking = mode === "pick";
  if (picking) {
    var picker = d.createElement("script");
    picker.src = base + "pick.js" + loc.search;
    picker.onload = picker.onerror = () => {
      picking = track.pick;
      fresh();
    };
    d.head.appendChild(picker);
  }

  var send = (kind, extra) => {
    // A page loaded ahead of time, which may never be opened, sends nothing until it is shown.
    if (skip || off || picking || d.prerendering) return;
    var body = Object.assign({ k: kind, u: pageUrl }, site && { s: site }, extra);
    // A configured scrubber fails closed, including when it has not loaded.
    if (beforeSend !== null) {
      try {
        body = w[beforeSend](body);
        if (!body || body.constructor !== Object) return;
      } catch (e) { return; }
    }
    // The Blob's type is the request's content type, for the beacon and for fetch alike. A browser that will
    // not send it as a beacon, or has none, sends it with fetch.
    var data = new Blob([JSON.stringify(body)], { type: type });
    try {
      if (n.sendBeacon(endpoint, data)) return;
    } catch (e) {}
    if (w.fetch) fetch(endpoint, { method: "POST", body: data, keepalive: true }).catch(() => {});
  };

  // Engaged time: visible and focused. Sent as a delta on every hide, so
  // the server adds them up per pageview.
  var notFound = has("404");
  var pageUrl = "";
  var pageviewId = "";
  var engaged = 0;
  var activeSince = 0;
  var scrolled = 0;

  var pause = () => {
    if (activeSince) engaged += now() - activeSince;
    activeSince = 0;
  };
  var resume = () => {
    if (!activeSince && !d.hidden && d.hasFocus()) activeSince = now();
  };
  var flush = () => {
    pause();
    if (pageviewId && engaged >= 1000) {
      send("engagement", { i: pageviewId, e: engaged, d: scrolled });
      engaged = 0;
    }
  };
  var measureScroll = () => {
    var el = d.documentElement;
    var total = Math.max(el.scrollHeight, d.body ? d.body.scrollHeight : 0);
    var seen = w.scrollY + w.innerHeight;
    var depth = total > 0 ? Math.min(100, Math.round((seen / total) * 100)) : 100;
    if (depth > scrolled) scrolled = depth;
  };


  var pageview = (to) => {
    // Counted once the page is shown, when it was loaded ahead of time.
    if (d.prerendering) return on(d, "prerenderingchange", () => pageview(to));
    // Listeners pass events; only a string is a URL from runlight.pageview().
    // The page's origin is its scheme and host, never a username or password in the address.
    var url = typeof to == "string" ? new URL(to, loc.href).href : loc.origin + loc.pathname + loc.search + (useHash ? loc.hash : "");
    if (url === pageUrl) return;
    var referrer = pageUrl || d.referrer;
    flush();
    pageUrl = url;
    skip = excludes.some((x) => x.test(new URL(url).pathname));
    pageviewId = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b + 256).toString(36).slice(-2)).join("");
    engaged = 0;
    scrolled = 0;
    measureScroll();
    resume();
    send("pageview", {
      i: pageviewId,
      r: referrer,
      t: d.title,
      w: screen.width,
      h: screen.height,
      l: n.language,
    });
    if (notFound) track("404", { path: loc.pathname });
    notFound = false;
  };

  var track = (name, props) => {
    if (typeof name !== "string" || !name) return;
    send("event", { i: pageviewId, n: name, p: props && typeof props === "object" ? props : undefined });
  };

  // Single page apps. A replaced address is a new page only when its path changed: a page that keeps a search
  // box or its filters in the query string replaces it on every keystroke.
  var wrap = (method, replaces) => {
    var original = history[method];
    history[method] = function () {
      var path = loc.pathname;
      var result = original.apply(this, arguments);
      // The router sets the new page's title after the address, so the pageview waits a turn for it.
      if (!replaces || path !== loc.pathname) setTimeout(pageview);
      return result;
    };
  };
  if (!manual) {
    wrap("pushState");
    wrap("replaceState", 1);
    on(w, "popstate", pageview);
    if (useHash) on(w, "hashchange", pageview);
    // Back or Forward to a page the browser kept whole runs no script again, so it is counted here.
    on(w, "pageshow", (event) => event.persisted && fresh());
  }

  on(d, "visibilitychange", () => {
    d.hidden ? flush() : resume();
  });
  on(w, "pagehide", flush);
  on(w, "blur", pause);
  on(w, "focus", resume);
  on(w, "scroll", () => {
    measureScroll();
    resume();
  }, { passive: true });
  // A page can load without window focus; any input means someone is there.
  on(d, "pointerdown", resume, true);
  on(d, "keydown", resume, true);

  var downloads = /\.(pdf|zip|gz|tgz|dmg|pkg|exe|msi|apk|docx?|xlsx?|pptx?|csv|txt|rtf|epub|mp3|wav|mp4|mov|avi|mkv|psd|ai|svg|key|numbers|pages)$/i;

  on(
    d,
    "click",
    (event) => {
      var target = event.target;
      if (!target || !target.closest) return;

      var link = target.closest("a[href]");
      // Click goals from the dashboard: a CSS selector, or a link whose address matches.
      rules.forEach((rule) => {
        try {
          var match = rule[1];
          if (
            rule[0] === "s"
              ? target.closest(match)
              : link &&
                glob(match).test(match[0] === "/" ? link.pathname : link.href)
          )
            track(rule[2]);
        } catch (e) {}
      });

      var tagged = target.closest("[data-runlight]");
      if (tagged) {
        var props = {};
        Array.from(tagged.attributes).forEach((a) => {
          if (!a.name.indexOf("data-runlight-")) props[a.name.slice(14)] = a.value;
        });
        track(tagged.getAttribute("data-runlight"), props);
      }

      if (!link || tagged) return;
      var href = link.href;
      if (!/^https?:/.test(href)) return;
      if (attr("downloads") !== "false" && downloads.test(link.pathname)) {
        track("File download", { url: href });
      } else if (attr("outbound") !== "false" && link.host !== loc.host) {
        track("Outbound link", { url: href });
      }
    },
    true
  );

  w.runlight = track;
  track.pageview = pageview;
  if (!manual) pageview();
  queued.forEach((q) => track.apply(null, q));
})();

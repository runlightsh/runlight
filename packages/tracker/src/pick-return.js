// The picker's relay page, on the dashboard's origin. The picker sends its tab
// here with the choice in the fragment; this hands it to the dashboard tab
// that started the pick, over a channel only this origin's pages share, and
// closes. The dashboard keeps the pick's nonce and takes nothing else.
(function () {
  var w = window;
  var d = document;
  var hash = location.hash.slice(1);
  // Off the address at once, so the choice is not kept in history.
  history.replaceState(null, "", location.pathname);
  var got = {};
  hash.split("&").forEach(function (pair) {
    var at = pair.indexOf("=");
    try {
      if (at > 0) got[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
    } catch (e) {}
  });
  // Only a pick this browser's dashboard started, once: it noted the nonce before it opened the site.
  var started = null;
  try {
    started = localStorage.getItem("runlight-pick");
  } catch (e) {}
  var ok = /^[a-f0-9]{32}$/.test(got.n || "") && got.n === started && typeof got.s === "string" && !!w.BroadcastChannel;
  if (ok) {
    try {
      localStorage.removeItem("runlight-pick");
    } catch (e) {}
    var channel = new BroadcastChannel("runlight-pick");
    channel.postMessage({ runlight: "pick", nonce: got.n, selector: got.s, href: got.h || "", text: got.t || "" });
    channel.close();
    setTimeout(function () {
      w.close();
    }, 900);
  }
  d.getElementById(ok ? "done" : "gone").hidden = false;
})();

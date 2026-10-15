(function () {
  // Only the rows for where Runlight runs show: its address and keys for another one, locations for this one.
  var mode = document.getElementById("runlight-mode");
  if (!mode) return;
  function show() {
    var chosen = mode.querySelector("input:checked");
    var local = chosen && chosen.value === "local";
    document.querySelectorAll(".runlight-remote").forEach(function (row) { row.hidden = local; });
    document.querySelectorAll(".runlight-local").forEach(function (row) { row.hidden = !local; });
  }
  mode.addEventListener("change", show);
  show();
})();
(function () {
  var status = document.getElementById("runlight-status");
  if (!status) return;
  var line = status.firstElementChild;
  function failed() {
    status.className = "notice notice-error inline";
    line.textContent = runlightCheck.failed;
  }
  var body = new URLSearchParams({ action: "runlight_check", _ajax_nonce: runlightCheck.nonce });
  fetch(runlightCheck.url, { method: "POST", credentials: "same-origin", body: body })
    .then(function (response) { return response.json(); })
    .then(function (answer) {
      if (!answer || !answer.success) return failed();
      var result = answer.data;
      if (!result) { status.remove(); return; }
      status.className = "notice inline " + (result.ok ? "notice-success" : "notice-error");
      line.textContent = result.message + " ";
      if (result.ok) {
        var link = document.createElement("a");
        link.href = runlightCheck.dashboard;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = runlightCheck.open;
        line.appendChild(link);
      }
    })
    .catch(failed);
})();

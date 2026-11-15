/**
 * @file
 * Asks whether the saved Runlight address answers once the settings page has
 * loaded, so a slow or missing Runlight never holds the page up. The check
 * is a POST, so it carries Drupal's session token, asked for first.
 */
(function (Drupal, drupalSettings, once) {
  Drupal.behaviors.runlightSettings = {
    attach(context) {
      var config = drupalSettings.runlight;
      if (!config) return;
      once("runlight-status", "#runlight-status", context).forEach(function (status) {
        function failed() {
          status.className = "messages messages--error";
          status.textContent = config.failed;
        }
        fetch(Drupal.url("session/token"), { credentials: "same-origin" })
          .then(function (response) {
            if (!response.ok) throw new Error(String(response.status));
            return response.text();
          })
          .then(function (token) {
            return fetch(config.check, { method: "POST", credentials: "same-origin", headers: { Accept: "application/json", "X-CSRF-Token": token } });
          })
          .then(function (response) {
            if (!response.ok) throw new Error(String(response.status));
            return response.json();
          })
          .then(function (result) {
            if (!result) {
              status.remove();
              return;
            }
            status.className = "messages " + (result.ok ? "messages--status" : "messages--error");
            status.textContent = result.message + " ";
            if (result.ok) {
              var link = document.createElement("a");
              link.href = config.dashboard;
              link.target = "_blank";
              link.rel = "noopener";
              link.textContent = config.open;
              status.appendChild(link);
            }
          })
          .catch(failed);
      });
    },
  };
})(Drupal, drupalSettings, once);

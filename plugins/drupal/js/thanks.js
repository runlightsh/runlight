/**
 * @file
 * Closing the thank you above the dashboard sends its form without leaving
 * the page, then lets the frame fit the space it leaves.
 */
(function () {
  var form = document.getElementById("runlight-thanks");
  if (!form) return;
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    fetch(form.getAttribute("action"), { method: "POST", body: new FormData(form, event.submitter), credentials: "same-origin", redirect: "manual" });
    form.remove();
    window.dispatchEvent(new Event("resize"));
  });
})();

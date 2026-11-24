window.runlightFrame(document.getElementById("runlight-embed"));

// Closing the thank you sends its form without leaving the page, then lets the frame fit the space it leaves.
(function () {
  var thanks = document.getElementById("runlight-thanks");
  var form = thanks && thanks.querySelector("form");
  if (!form) return;
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    // The form has a field named action, which hides form.action, so the attribute is read.
    fetch(form.getAttribute("action"), { method: "POST", body: new FormData(form, event.submitter), credentials: "same-origin", redirect: "manual" });
    thanks.remove();
    window.dispatchEvent(new Event("resize"));
  });
})();

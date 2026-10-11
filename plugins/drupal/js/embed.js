/**
 * @file
 * Hands the Runlight frame to runlightFrame() from js/frame.js, which grows
 * it to the dashboard's height, tells the dashboard which part of it is on
 * screen, and reloads the page when the dashboard asks, which it does once
 * its session has run out.
 */
(function (Drupal, once) {
  Drupal.behaviors.runlightEmbed = {
    attach(context) {
      once("runlight-embed", "#runlight-embed", context).forEach(window.runlightFrame);
    },
  };
})(Drupal, once);

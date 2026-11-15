import assert from "node:assert/strict";
import { test } from "node:test";
import { initialLocale } from "../src/i18n.js";

test("the dashboard starts in the language picked in it, else its host's, else the browser's", () => {
  const french = ["fr-CA", "en"];
  // With no host, as on a standalone Runlight, the browser decides, by its first language the dashboard has.
  assert.equal(initialLocale(null, "", french), "fr");
  assert.equal(initialLocale(null, "", ["nl", "de-AT", "fr"]), "de");
  assert.equal(initialLocale(null, "", ["nl"]), "en");
  // A CMS names its own language, and the browser's is not asked: an English site reads in English.
  assert.equal(initialLocale(null, "en", french), "en");
  assert.equal(initialLocale(null, "pt-br", french), "pt");
  assert.equal(initialLocale(null, "ES", french), "es");
  assert.equal(initialLocale(null, "zh_hans", french), "en");
  // One the dashboard does not have is English, not the browser's.
  assert.equal(initialLocale(null, "nl", french), "en");
  assert.equal(initialLocale(null, "<script>", french), "en");
  // A language picked in the dashboard's footer holds over both, unless it is not one of the dashboard's.
  assert.equal(initialLocale("de", "en", french), "de");
  assert.equal(initialLocale("xx", "es", french), "es");
  assert.equal(initialLocale("xx", "", french), "fr");
});

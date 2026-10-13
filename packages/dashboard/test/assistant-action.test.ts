import assert from "node:assert/strict";
import { test } from "node:test";
import { actionDraft } from "../src/assistant-action.js";

test("assistant drafts whitelist creation fields and reject missing or privileged inputs", () => {
  assert.equal(actionDraft({ action: "invite", email: "alex@example.com", role: "owner" }), null);
  assert.equal(actionDraft({ action: "invite", email: "alex@example.com" }), null);
  assert.equal(actionDraft({ action: "report", email: "alex@example.com", frequency: "daily", lang: "en" }), null);
  assert.equal(actionDraft({ action: "goal", name: "Signup", kind: "page" }), null);
  assert.equal(actionDraft({ action: "goal", name: "Signup", kind: "page", match: "/thanks", valueMode: "fixed", value: 50 }), null);
  assert.equal(actionDraft({ action: "funnel", name: "Signup", steps: [{ kind: "page", match: "/" }] }), null);
  assert.equal(actionDraft({ action: "delete", id: "anything" }), null);
  assert.equal(actionDraft(null), null);
  assert.deepEqual(actionDraft({ action: "share", name: "Client", site: "another-site", endpoint: "/api/people", role: "owner" }), { action: "share", input: { name: "Client" } });
  assert.deepEqual(actionDraft({ action: "report", email: "alex@example.com", frequency: "weekly", lang: "en" }), { action: "report", input: { email: "alex@example.com", frequency: "weekly", lang: "en" } });
  assert.equal(actionDraft({ action: "goal", name: "Signup", kind: "page", match: "/thanks", valueMode: "fixed", value: 0, currency: "CAD" })?.action, "goal");
});

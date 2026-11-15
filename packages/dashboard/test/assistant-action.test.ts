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

test("a kept chat never holds a link an action made, is kept per person, and goes when they sign out", async () => {
  const { chatKey, forgetChats, keptChat } = await import("../src/assistant-action.js");
  const draft = { action: "invite" as const, input: { email: "alex@example.com", role: "viewer" as const } };
  const kept = JSON.parse(keptChat([
    { role: "user", content: "Invite Alex" },
    { role: "assistant", content: "Ready", action: { draft, status: "done" as const, result: "Invited", link: "https://stats.example.com/invite?code=secret" } },
  ]));
  assert.doesNotMatch(JSON.stringify(kept), /secret|invite\?code/);
  assert.deepEqual(kept[1].action, { draft, status: "done", result: "Invited" });
  assert.equal(JSON.parse(keptChat(Array.from({ length: 50 }, (_, i) => ({ role: "user", content: String(i) })))).length, 40);
  assert.notEqual(chatKey("owner-id", "blog"), chatKey("viewer-id", "blog"));

  const data = new Map([[chatKey("owner-id", "blog"), "[]"], ["runlight_assistant:blog", "[]"], ["runlight-theme", "dark"]]);
  forgetChats({ get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null, removeItem: (key: string) => void data.delete(key) });
  assert.deepEqual([...data.keys()], ["runlight-theme"], "chats go, in the older key too, and nothing else does");
  assert.doesNotThrow(() => forgetChats(undefined));
});

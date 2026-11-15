import assert from "node:assert/strict";
import { test } from "node:test";
import { problems } from "./prepublish.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);

test("HEAD on the tag with a clean tree may publish", () => {
  assert.deepEqual(problems({ version: "1.2.3", head: A, tagCommit: A, status: "" }), []);
});

test("an untracked file outside the build's folders is no obstacle", () => {
  assert.deepEqual(problems({ version: "1.2.3", head: A, tagCommit: A, status: "?? notes.txt\n?? packages/ruby/runlight-1.2.3.gem" }), []);
});

test("a missing tag refuses", () => {
  const [problem] = problems({ version: "1.2.3", head: A, tagCommit: null, status: "" });
  assert.match(problem, /no tag v1\.2\.3/);
});

test("HEAD off the tag refuses", () => {
  const [problem] = problems({ version: "1.2.3", head: A, tagCommit: B, status: "" });
  assert.match(problem, /HEAD is aaaaaaaaaaaa, and v1\.2\.3 is bbbbbbbbbbbb/);
});

test("a changed tracked file refuses, wherever it is", () => {
  const list = problems({ version: "1.2.3", head: A, tagCommit: A, status: " M README.md\nA  packages/go/x.go" });
  assert.equal(list.length, 1);
  assert.match(list[0], /README\.md/);
  assert.match(list[0], /packages\/go\/x\.go/);
});

test("an untracked file where the build reads refuses", () => {
  const list = problems({ version: "1.2.3", head: A, tagCommit: A, status: "?? packages/sdk/src/extra.ts\n?? elsewhere.txt" });
  assert.equal(list.length, 1);
  assert.match(list[0], /packages\/sdk\/src\/extra\.ts/);
  assert.doesNotMatch(list[0], /elsewhere/);
});

test("every obstacle is reported at once", () => {
  assert.equal(problems({ version: "1.2.3", head: A, tagCommit: B, status: " M a\n?? packages/tracker/b" }).length, 3);
});

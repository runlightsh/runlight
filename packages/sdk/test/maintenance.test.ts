import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cleanup, setup } from "./helpers.js";

after(cleanup);

test("scheduled retention failures reject the check without poisoning later checks", async () => {
  const { rl } = setup("sqlite", { site: { id: "blog", hostnames: ["example.com"] } });
  await rl.init();
  await rl.setRetention("blog", 12);
  await rl.idle();
  const dropBefore = rl.store.dropBefore.bind(rl.store);
  let attempts = 0;
  rl.store.dropBefore = async (...args) => {
    attempts++;
    if (attempts === 1) throw new Error("retention storage unavailable");
    return dropBefore(...args);
  };
  await assert.rejects(rl.check(), /retention storage unavailable/);
  assert.equal((await rl.check()).ok, true);
  assert.equal(attempts, 2);
});

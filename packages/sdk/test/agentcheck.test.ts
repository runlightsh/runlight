import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAgent, inRanges, parseAddress, readRangeList } from "../src/agentcheck.js";
import { AGENT_RANGES } from "../src/data/agent-ranges.js";
import { AI_AGENTS } from "../src/data/agents.js";

test("addresses: IPv4, IPv6, IPv4 written as IPv6, brackets and zones, and junk", () => {
  assert.deepEqual(parseAddress("20.171.206.17"), { v: 4, n: 0x14abce11 });
  assert.deepEqual(parseAddress(" ::ffff:20.171.206.17 "), { v: 4, n: 0x14abce11 });
  assert.deepEqual(parseAddress("::ffff:14ab:ce11"), { v: 4, n: 0x14abce11 });
  assert.deepEqual(parseAddress("[2600:1f28:365:8000::1]"), { v: 6, n: 0x26001f2803658000n << 64n | 1n });
  assert.deepEqual(parseAddress("fe80::1%eth0"), { v: 6, n: 0xfe80n << 112n | 1n });
  assert.deepEqual(parseAddress("::"), { v: 6, n: 0n });
  for (const junk of ["", "unknown", "256.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4x", "1::2::3", "12345::", ":1::", "1:2:3:4:5:6:7:8:9", "::ffff:1.2.3.256", "-"]) {
    assert.equal(parseAddress(junk), null, junk);
  }
});

test("ranges: prefixes of any length, both families, and host bits past the length ignored", () => {
  const list = ["20.171.206.0/24", "34.162.230.222/32", "10.1.2.3/8", "2600:1f28:365:8000::/56", "0.0.0.0/0"];
  assert.ok(inRanges("20.171.206.255", list.slice(0, 1)));
  assert.ok(!inRanges("20.171.207.0", list.slice(0, 1)));
  assert.ok(inRanges("34.162.230.222", list.slice(1, 2)));
  assert.ok(!inRanges("34.162.230.223", list.slice(1, 2)));
  assert.ok(inRanges("10.200.0.1", list.slice(2, 3)), "10.1.2.3/8 covers all of 10/8");
  assert.ok(inRanges("2600:1f28:365:80ff:ffff::1", list.slice(3, 4)));
  assert.ok(!inRanges("2600:1f28:365:8100::1", list.slice(3, 4)));
  assert.ok(!inRanges("20.171.206.1", list.slice(3, 4)), "an IPv4 address is never in an IPv6 prefix");
  assert.ok(inRanges("203.0.113.9", list.slice(4)), "/0 covers every IPv4 address");
  assert.ok(!inRanges("not an address", list));
});

test("published lists: the shape every company uses, and anything else refused whole", () => {
  assert.deepEqual(readRangeList({ creationTime: "x", prefixes: [{ ipv4Prefix: "20.171.206.0/24" }, { ipv6Prefix: " 2600:1f28::/56 " }] }), ["20.171.206.0/24", "2600:1f28::/56"]);
  for (const bad of [null, [], "x", {}, { prefixes: [] }, { prefixes: "1.2.3.0/24" }, { prefixes: [{ ipv4Prefix: "1.2.3.0" }] }, { prefixes: [{ ipv4Prefix: "1.2.3.0/33" }] }, { prefixes: [{ ipv4Prefix: "2600::/56" }] }, { prefixes: [{ ipv6Prefix: "1.2.3.0/24" }] }, { prefixes: [{ ipv4Prefix: "1.2.3.0/24" }, { other: "x" }] }]) {
    assert.equal(readRangeList(bad), null, JSON.stringify(bad));
  }
  assert.equal(readRangeList({ prefixes: Array.from({ length: 20_001 }, () => ({ ipv4Prefix: "1.2.3.0/24" })) }), null);
});

test("an agent checks out, does not, or has nothing to check against", () => {
  const gptbot = AI_AGENTS.find((a) => a.name === "GPTBot")!;
  const meta = AI_AGENTS.find((a) => a.name === "meta-externalagent")!;
  const lists = AGENT_RANGES.lists;
  assert.equal(checkAgent(gptbot, "20.171.206.17", lists), "verified");
  assert.equal(checkAgent(gptbot, "198.51.100.23", lists), "mismatch");
  assert.equal(checkAgent(gptbot, "", lists), "", "no address");
  assert.equal(checkAgent(gptbot, "garbage", lists), "");
  assert.equal(checkAgent(meta, "157.240.0.1", lists), "", "Meta publishes no list");
  assert.equal(checkAgent(gptbot, "20.171.206.17", {}), "", "a list that is missing is nothing to check against");
});

test("every agent with a list has it bundled, and every bundled list is read whole", () => {
  for (const agent of AI_AGENTS) if (agent.ranges) assert.ok(AGENT_RANGES.lists[agent.ranges]?.length, `${agent.name}: ${agent.ranges}`);
  for (const [url, list] of Object.entries(AGENT_RANGES.lists)) {
    const again = readRangeList({ prefixes: list.map((p) => (p.includes(":") ? { ipv6Prefix: p } : { ipv4Prefix: p })) });
    assert.deepEqual(again, list, url);
  }
});

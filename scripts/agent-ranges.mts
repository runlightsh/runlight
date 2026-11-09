// Downloads the address lists AI companies publish for their agents and writes them to
// packages/sdk/src/data/agent-ranges.ts, the copy every install starts from. Run before a release,
// then npm run build (the language ports copy the lists from there) and npm run conformance.
//   node --import tsx scripts/agent-ranges.mts
import { writeFileSync } from "node:fs";
import { AI_AGENTS } from "../packages/sdk/src/data/agents.ts";
import { downloadRangeList } from "../packages/sdk/src/agentcheck.ts";

const urls = [...new Set(AI_AGENTS.map((a) => a.ranges).filter((u): u is string => Boolean(u)))].sort();
const lists: Record<string, string[]> = {};
for (const url of urls) {
  const prefixes = await downloadRangeList(url);
  if (!prefixes) throw new Error(`Could not read ${url}`);
  lists[url] = prefixes;
  console.log(`${url}: ${prefixes.length}`);
}

const file = new URL("../packages/sdk/src/data/agent-ranges.ts", import.meta.url);
writeFileSync(
  file,
  `// Written by scripts/agent-ranges.mts from the lists each company publishes. Do not edit.\n` +
    `export const AGENT_RANGES: { fetchedAt: string; lists: Record<string, string[]> } = ${JSON.stringify({ fetchedAt: new Date().toISOString().slice(0, 10), lists }, null, 2)};\n`,
);
console.log(`agent-ranges: ${urls.length} lists written`);

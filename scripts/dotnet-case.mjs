// Writes packages/dotnet/src/Runlight/CaseTables.cs: every code point whose
// String.prototype.toLowerCase or toUpperCase in Node differs from itself, with
// what it becomes, so the .NET port changes case exactly as JavaScript does
// (full mappings such as U+0130 to "i" and U+0307, and the German sharp s to
// "SS", which .NET's simple mappings leave alone). The one context-sensitive
// rule, a final capital sigma, is applied in Js.cs.
//
//   node scripts/dotnet-case.mjs [--check]
//
// With --check it writes nothing and fails if the file is stale. The second
// line names the Node that wrote it, so it is left out of the comparison,
// and the tables are compared only on the Unicode release that wrote them.
import { readFileSync, writeFileSync } from "node:fs";
import { skipped } from "./node-data.mjs";

function table(map) {
  const rows = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    const mapped = map(ch);
    if (mapped !== ch) rows.push([cp, mapped]);
  }
  return rows;
}

function escape(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) out += `\\u${text.charCodeAt(i).toString(16).padStart(4, "0")}`;
  return out;
}

function literal(rows) {
  // code point in hex, a colon, the mapping escaped, rows joined by a newline.
  return rows.map(([cp, mapped]) => `        "${cp.toString(16)}:${escape(mapped)}\\n" +`).join("\n");
}

const lower = table((c) => c.toLowerCase());
const upper = table((c) => c.toUpperCase());
const out = [
  "// Written by scripts/dotnet-case.mjs; do not edit by hand.",
  `// From Node ${process.version} (ICU ${process.versions.icu}, Unicode ${process.versions.unicode}).`,
  "namespace Runlight;",
  "",
  "/// <summary>JavaScript's toLowerCase and toUpperCase, as code point and mapping rows: \"hex:text\\n\".</summary>",
  "internal static class CaseTables",
  "{",
  "    public const string Lower =",
  literal(lower),
  '        "";',
  "",
  "    public const string Upper =",
  literal(upper),
  '        "";',
  "}",
  "",
];
const file = new URL("../packages/dotnet/src/Runlight/CaseTables.cs", import.meta.url);
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(file, "utf8");
  } catch {}
  const written = /^\/\/ From Node \S+ \(ICU \S+, Unicode ([^)]+)\)\.$/m.exec(current)?.[1];
  const tables = (text) => text.split("\n").filter((_, i) => i !== 1).join("\n");
  if (written && written !== process.versions.unicode) {
    skipped("dotnet-case", "Unicode", written, process.versions.unicode);
  } else if (tables(current) !== tables(out.join("\n"))) {
    console.error("dotnet-case: packages/dotnet/src/Runlight/CaseTables.cs is stale. Run node scripts/dotnet-case.mjs");
    process.exit(1);
  } else {
    console.log("dotnet-case: up to date");
  }
} else {
  writeFileSync(file, out.join("\n"));
  console.log(`${lower.length} lower and ${upper.length} upper mappings written`);
}

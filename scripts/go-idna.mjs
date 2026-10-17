// Writes packages/go/internal/whatwg/idna.json: how this Node turns a host name into the one a URL keeps, which
// Go's standard library cannot (it has no UTS 46 mapping, and no Unicode normalization). Found by asking Node
// itself, so the Go port reads a host as new URL() does, whatever Unicode version Go was built with:
//   map         every non-ASCII character the mapping changes, to what it becomes ("" where it is dropped)
//   disallowed  the ranges of characters that make a host invalid
//   rtl         the ranges of characters only a right-to-left label may hold (Hebrew, Arabic, and the like)
//   viramas     characters a zero-width joiner may follow
//   nfd         the full canonical decomposition of every character that has one (Hangul is worked out in code)
//   ccc         the order of the combining marks, as [first, last, rank] ranges (only their order matters)
//   pairs       the compositions: [first, second, composite]
// Run with Node 24:
//   node scripts/go-idna.mjs [--check]
import { readFileSync, writeFileSync } from "node:fs";
import { domainToUnicode } from "node:url";

const hex = (cp) => cp.toString(16);
const text = (cp) => String.fromCodePoint(cp);
const inRange = (cp) => !(cp >= 0xd800 && cp <= 0xdfff);

// A host is read between two letters that compose with nothing, so a mark keeps its place, and the letter
// is a right-to-left one for the characters that only a right-to-left name may hold.
const left = "q";
const right = "א";
const host = (name) => {
  try {
    const hostname = new URL(`http://${name}/`).hostname;
    return domainToUnicode(hostname);
  } catch {
    return null;
  }
};
const between = (cp, side) => {
  const out = host(side + text(cp) + side);
  return out !== null && out.startsWith(side) && out.endsWith(side) && out.length >= 2 * side.length ? out.slice(side.length, out.length - side.length) : null;
};

const map = {};
const failed = [];
const rtlOnly = [];
for (let cp = 0x80; cp <= 0x10ffff; cp++) {
  if (!inRange(cp)) continue;
  const ltr = between(cp, left);
  const rtl = ltr === null ? between(cp, right) : null;
  const mapped = ltr ?? rtl;
  if (ltr === null && rtl !== null) rtlOnly.push(cp);
  if (mapped === null) {
    failed.push(cp);
    continue;
  }
  if (mapped !== text(cp)) map[hex(cp)] = mapped;
}

// The zero-width joiners fail between letters on purpose: they are only allowed where a virama comes before.
const joiners = [0x200c, 0x200d];
const viramas = [];
const failedSet = new Set(failed);
for (const joiner of joiners) failedSet.delete(joiner);
for (let cp = 0x80; cp <= 0x10ffff; cp++) {
  if (!inRange(cp) || failedSet.has(cp) || map[hex(cp)] !== undefined) continue;
  if (!/\p{M}/u.test(text(cp))) continue;
  const out = host(`${left}${text(cp)}‍${left}`);
  if (out !== null) viramas.push(cp);
}

const ranges = (cps) => {
  const out = [];
  for (const cp of [...cps].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] === cp - 1) last[1] = cp;
    else out.push([cp, cp]);
  }
  return out;
};
const disallowed = ranges(failedSet);
// What a right-to-left character maps to is what it is mapped from; the check is on the characters written.
const rtl = ranges(rtlOnly);

// Normalization. A composition needs the marks in canonical order, so they are ranked by asking which swaps.
const nfd = {};
const composites = [];
for (let cp = 0x80; cp <= 0x10ffff; cp++) {
  if (!inRange(cp) || (cp >= 0xac00 && cp <= 0xd7a3)) continue;
  const ch = text(cp);
  const decomposed = ch.normalize("NFD");
  if (decomposed === ch) continue;
  nfd[hex(cp)] = decomposed;
  if ([...decomposed].length > 1 && decomposed.normalize("NFC") === ch) composites.push(cp);
}
const swapped = (a, b) => a !== b && `${left}${a}${b}`.normalize("NFD") === `${left}${b}${a}`;
const marks = [];
for (let cp = 0x80; cp <= 0x10ffff; cp++) {
  if (!inRange(cp) || nfd[hex(cp)] !== undefined || (cp >= 0xac00 && cp <= 0xd7a3)) continue;
  const ch = text(cp);
  // Not a starter when it moves before a mark of the middle order, or after the lowest one.
  if (swapped("́", ch) || swapped(ch, "̴")) marks.push(cp);
}
const compare = (a, b) => (swapped(text(a), text(b)) ? 1 : swapped(text(b), text(a)) ? -1 : 0);
marks.sort((a, b) => compare(a, b) || a - b);
// Marks of one class are those neither swaps with; they sort together, so a new rank starts at each difference.
const ranks = new Map();
let rank = 0;
for (let i = 0; i < marks.length; i++) {
  if (i === 0 || compare(marks[i - 1], marks[i]) !== 0) rank++;
  ranks.set(marks[i], rank);
}
const ccc = [];
for (const cp of [...marks].sort((a, b) => a - b)) {
  const last = ccc[ccc.length - 1];
  if (last && last[1] === cp - 1 && last[2] === ranks.get(cp)) last[1] = cp;
  else ccc.push([cp, cp, ranks.get(cp)]);
}

const pairs = [];
for (const cp of composites) {
  const parts = [...nfd[hex(cp)]];
  const second = parts[parts.length - 1];
  const first = parts.slice(0, -1).join("").normalize("NFC");
  if ([...first].length !== 1 || `${first}${second}`.normalize("NFC") !== text(cp)) throw new Error(`U+${hex(cp)} does not compose from a pair`);
  pairs.push([first.codePointAt(0), second.codePointAt(0), cp]);
}
pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
for (const [first, second] of pairs) if (text(first) === left || text(second) === left || text(first) === right || text(second) === right) throw new Error("the probe letters compose");

// The two long dashes are written as escapes, which the repository allows nowhere as characters.
const out = `${JSON.stringify({ unicode: process.versions.unicode, map, disallowed, rtl, viramas, nfd, ccc, pairs }).replace(/\u2013/g, "\\u2013").replace(/\u2014/g, "\\u2014")}\n`;
const file = new URL("../packages/go/internal/whatwg/idna.json", import.meta.url);
if (process.argv.includes("--check")) {
  const old = readFileSync(file, "utf8");
  if (JSON.parse(old).unicode !== process.versions.unicode) {
    console.log(`idna.json was written from Unicode ${JSON.parse(old).unicode}, this Node has ${process.versions.unicode}`);
  } else if (old !== out) {
    console.error("packages/go/internal/whatwg/idna.json is stale: run node scripts/go-idna.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(file, out);
}

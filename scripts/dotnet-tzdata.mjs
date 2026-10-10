// Writes packages/dotnet/src/Runlight/Zoneinfo/tzdata.gz: the compiled IANA
// database files (TZif) for every name in ZoneNames.cs, so the .NET port knows
// every zone even where the system has no zoneinfo, as in slim containers. The
// system's files are read first when it has them; these come next.
//
// The files come from a zoneinfo folder, by default the system's; another can
// be given (keep it the same release ZoneNames.cs was written from):
//
//   node scripts/dotnet-tzdata.mjs [path/to/zoneinfo]
//
// The format, before gzip, all numbers big-endian: the count of distinct
// files, then each as a 32-bit length and its bytes; then the count of names,
// then each as a 16-bit length, its UTF-8 bytes, and the 32-bit index of its file.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";

const source = process.argv[2] ?? "/usr/share/zoneinfo";
const names = [...readFileSync(new URL("../packages/dotnet/src/Runlight/ZoneNames.cs", import.meta.url), "utf8").matchAll(/^ {8}"([^"]+)",$/gm)].map((m) => m[1]);

const files = [];
const byHash = new Map();
const entries = [];
const missing = [];
for (const name of names) {
  const path = `${source}/${name}`;
  if (!existsSync(path)) {
    missing.push(name);
    continue;
  }
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 4).toString("latin1") !== "TZif") {
    missing.push(name);
    continue;
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (!byHash.has(hash)) {
    byHash.set(hash, files.length);
    files.push(bytes);
  }
  entries.push([name, byHash.get(hash)]);
}

const parts = [];
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
parts.push(u32(files.length));
for (const f of files) parts.push(u32(f.length), f);
parts.push(u32(entries.length));
for (const [name, index] of entries) {
  const text = Buffer.from(name, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(text.length);
  parts.push(len, text, u32(index));
}

const dir = new URL("../packages/dotnet/src/Runlight/Zoneinfo/", import.meta.url);
mkdirSync(dir, { recursive: true });
// mtime 0 in the gzip header, so the same files always give the same bytes.
const out = gzipSync(Buffer.concat(parts), { level: 9 });
writeFileSync(new URL("tzdata.gz", dir), out);
console.log(`${entries.length} names, ${files.length} files, ${out.length} bytes${missing.length ? `; not found: ${missing.join(", ")}` : ""}`);

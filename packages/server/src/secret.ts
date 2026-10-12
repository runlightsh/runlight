import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Shorter than any secret this file has ever been given, so a file caught half written is never used. */
const SHORTEST = 32;

/**
 * The secret kept in `dataDir`, made on first run, readable only by this user. Two servers starting at once
 * on one folder agree on it: the new secret is written whole to a file of its own, then linked into place,
 * which refuses to replace a file already there, and the one that loses reads the winner's. A file read
 * empty or short, such as one an older version was still writing, is read again for a moment, and then
 * refused, never used.
 */
export function secretIn(dataDir: string): string {
  const file = path.join(dataDir, "secret");
  const found = readWhole(file);
  if (found !== null) return found;
  const made = randomBytes(32).toString("hex");
  const temp = path.join(dataDir, `.secret-${process.pid}-${randomBytes(6).toString("hex")}`);
  writeFileSync(temp, `${made}\n`, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(temp, 0o600);
    try {
      linkSync(temp, file);
      return made;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return readWhole(file) ?? refuse(file);
      // A file system with no hard links still creates the file only if it is not there; a reader that
      // catches it before its contents land reads it again below.
      try {
        writeFileSync(file, `${made}\n`, { mode: 0o600, flag: "wx" });
        chmodSync(file, 0o600);
        return made;
      } catch (fallback) {
        if ((fallback as NodeJS.ErrnoException).code !== "EEXIST") throw fallback;
        return readWhole(file) ?? refuse(file);
      }
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Gone already.
    }
  }
}

/** The secret in a file, waiting up to two seconds for one too short to be whole; null when there is no file. */
function readWhole(file: string): string | null {
  for (let tries = 0; ; tries++) {
    let text: string;
    try {
      text = readFileSync(file, "utf8").trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (text.length >= SHORTEST) return text;
    if (tries >= 20) refuse(file);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}

function refuse(file: string): never {
  throw new Error(`${file} holds no whole secret. Delete it to have a new one made, which signs everyone out, or set RUNLIGHT_SECRET.`);
}

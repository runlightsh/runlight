import { useState } from "preact/hooks";
import { base, type Site } from "./api.js";

export function Avatar({ site }: { site: Site }) {
  // Remembers which site's icon failed. A failure cached by the browser can fire
  // before any effect runs, so resetting a flag in an effect would lose it.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = failedFor === site.id;
  const letter = (site.name.replace(/^www\./, "")[0] ?? "R").toUpperCase();
  return failed ? (
    <span class="avatar letter" aria-hidden="true">
      {letter}
    </span>
  ) : (
    <img class="avatar" src={`${base}/api/icon?site=${encodeURIComponent(site.id)}`} alt="" width={40} height={40} onError={() => setFailedFor(site.id)} />
  );
}

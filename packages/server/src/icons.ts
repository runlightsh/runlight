import { readFileSync } from "node:fs";
import { RUNLIGHT_ICON } from "@runlight/sdk";

/** Local artwork for browser tabs and home-screen shortcuts, also available before sign-in. */
const assets = new Map<string, { body: Uint8Array<ArrayBuffer>; type: string }>();
for (const [name, type] of [
  ["favicon.ico", "image/x-icon"],
  ["apple-touch-icon.png", "image/png"],
  ["icon-192.png", "image/png"],
  ["icon-512.png", "image/png"],
] as const) {
  assets.set(`/${name}`, { body: new Uint8Array(readFileSync(new URL(`../assets/${name}`, import.meta.url))), type });
}
assets.set("/favicon.svg", {
  body: new TextEncoder().encode(decodeURIComponent(RUNLIGHT_ICON.slice(RUNLIGHT_ICON.indexOf(",") + 1))),
  type: "image/svg+xml",
});
assets.set("/manifest.webmanifest", {
  body: new TextEncoder().encode(JSON.stringify({
    name: "Runlight",
    short_name: "Runlight",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [192, 512].map((size) => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png", purpose: "any" })),
  })),
  type: "application/manifest+json",
});

export const ICON_PATHS = new Set(assets.keys());

export function iconResponse(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const asset = assets.get(new URL(request.url).pathname);
  if (!asset) return null;
  return new Response(request.method === "HEAD" ? null : asset.body, {
    headers: { "content-type": asset.type, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff" },
  });
}

const links = `<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-title" content="Runlight">`;

/** The standalone installation owns the root icon URLs; embedded SDK dashboards keep their own host's metadata. */
export async function withAppIcons(response: Response): Promise<Response> {
  if (!response.headers.get("content-type")?.startsWith("text/html")) return response;
  const html = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const policy = headers.get("content-security-policy");
  if (policy) {
    headers.set("content-security-policy", policy.replace(/img-src data:/, "img-src 'self' data:") + "; manifest-src 'self'");
  }
  return new Response(html.replace(/<link rel="icon" href="[^"]*">/, links), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

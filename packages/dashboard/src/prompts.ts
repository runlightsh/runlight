/**
 * Setup instructions to paste into a coding assistant, filled in with this
 * install's real addresses. Kept in English whatever the dashboard's language,
 * since that is what coding assistants follow best.
 */

export function domainPrompt(opts: { domain: string; host: string; origin: string; base: string; linkPath: string }): string {
  const { domain, host, origin, base, linkPath } = opts;
  return `Set up a custom short link domain for Runlight, the analytics in this project.

Runlight's dashboard runs at ${origin}${base}. Short links are served at ${origin}${linkPath}/<slug>. I want them also served at the root of ${domain}, like https://${domain}/<slug>.

Please do these steps, and tell me anything I have to do by hand:

1. DNS. Tell me the record to add at my DNS provider: a CNAME for ${domain} pointing to ${host}. If ${domain} has no subdomain, it needs an A or ALIAS record to the same server instead.

2. Hosting. Make the app accept requests for ${domain} over HTTPS. On Vercel or Netlify, that means adding ${domain} to the project's domains. On my own server, add it to the web server config (for nginx: a server_name and a certificate, for example with certbot; for Caddy: list it beside the main domain) and proxy it to the app the same way as the main domain.

3. App. A request on ${domain} has to reach Runlight before the app's own routes see it, because its short links sit at the root of the name. Find how Runlight is set up in this project (package.json, composer.json, pyproject.toml or requirements.txt, Gemfile, go.mod, pom.xml or build.gradle, a .csproj, mix.exs, or Cargo.toml), then follow the matching part below. Every adapter answers only on link domains added in the dashboard and passes every other host on untouched, so the rest of the app is unaffected. Keep any middleware already there, and change only what is needed. Each part names the docs page with the details.

   Standalone server. If ${origin} is a Runlight of its own (the runlight command in any language, the Docker image, or PHP's drop-in), there is no code to change: point the domain at that server and skip to step 4. https://runlight.sh/docs/server/

   TypeScript (@runlight/sdk). https://runlight.sh/docs/links/#custom-domains
   - Next.js 16 and later: in proxy.ts, answer link domains first:

       import { rl } from "@/lib/runlight";

       export async function proxy(request: Request) {
         const link = await rl.linkDomainResponse(request);
         if (link) return link;
         // ...whatever the proxy already does
       }

     Next.js 15 and earlier use middleware.ts, with the same body in export async function middleware(request: Request). From 15.5, also add export const config = { runtime: "nodejs" }; so it can reach a SQLite or Postgres store. Before 15.5, middleware only runs on the edge, where only an edge store (Turso over HTTP, D1) works; without one, keep to ${linkPath}/<slug> links.
   - Express, Connect, and NestJS: app.use(shortLinks(rl)) from "@runlight/sdk/node", before the app's own routes. A plain http server calls await links(req, res) first and stops when it returns true.
   - Fastify: an onRequest hook that calls shortLinks(rl)(req.raw, reply.raw) and calls reply.hijack() when it answers. Koa: a middleware that sets ctx.respond = false when it answers, and otherwise calls next().
   - Hono, SvelteKit (handle in src/hooks.server.ts), Astro (src/middleware.ts), Bun, Deno, and Cloudflare Workers: return (await rl.linkDomainResponse(request)) when it is not null, before anything else. A Worker needs ${domain} routed to it too. Nuxt and h3: a server middleware that builds new Request(getRequestURL(event), { method: event.method, headers: event.headers }) and returns the answer when there is one.

   PHP (runlight/runlight). https://runlight.sh/docs/php/
   - Laravel: in bootstrap/app.php, ->withMiddleware(fn (Middleware $middleware) => $middleware->prepend(\\Runlight\\Bridge\\ShortLinks::class)).
   - Symfony: a kernel.request listener (priority 64) that calls (new \\Runlight\\Bridge\\ShortLinks($rl))->onKernelRequest($event).
   - Plain PHP: at the top of the front controller, $linked = $rl->linkDomainResponse($request, ['ip' => $request->remoteAddress]); and when it is not null, $linked->emit() and stop.
   - The standalone drop-in needs no code, as above.

   Python (runlight). https://runlight.sh/docs/python/
   - Django: runlight.django.RunlightMiddleware first in MIDDLEWARE already answers link domains. Add ${domain} to ALLOWED_HOSTS.
   - Flask (runlight.flask.init_app), FastAPI and Starlette (runlight.fastapi.init_app), and the WSGI and ASGI RunlightMiddleware already answer link domains. Check that Runlight is added this way and wraps the whole app.

   Ruby (runlight gem). Rack apps: use Runlight::RackApp in config.ru already answers link domains. https://runlight.sh/docs/ruby/
   Rails: the engine's middleware already answers them. If the app sets config.hosts, add ${domain} to it. https://runlight.sh/docs/rails/

   Go (runlight.sh/go). https://runlight.sh/docs/go/
   - net/http: wrap the handler the server runs in rl.LinkDomains(...), or send every request through routes.Middleware(next).
   - chi: runlightchi.Mount(r, rl, routes) on the top router, before the app's own routes. Echo: runlightecho.Register(e, rl, routes).
   - Any other router: wrap its http.Handler in rl.LinkDomains.

   Java (sh.runlight). https://runlight.sh/docs/java/
   - The JDK's HttpServer: JdkServer.mount(server, rl, routes, yourHandler) serves the app behind a filter that answers link domains.
   - Servlet containers: register RunlightFilter on /* as well as RunlightServlet. The app must be at the root context.
   - Spring Boot: the starter already answers link domains before the app's routing.

   .NET (Runlight). app.MapRunlight() or app.UseRunlight() already answers link domains. If the app sets AllowedHosts, add ${domain} to it. https://runlight.sh/docs/dotnet/

   Elixir (runlight). https://runlight.sh/docs/elixir/
   - Phoenix: plug Runlight.Plug.LinkDomains in the endpoint, just before plug MyAppWeb.Router, since the router only runs plugs for paths it matches.
   - Plug.Router: plug Runlight.Plug.LinkDomains before plug :match.

   Rust (runlight crate). https://runlight.sh/docs/rust/
   - axum: keep .layer(axum::middleware::from_fn_with_state(rl.clone(), runlight::adapters::axum_support::middleware)) on the whole app, beside .merge(rl.link_router()).
   - hyper or another tower server: the Routes service and rl.link_service() answer link domains as they are.

   Any other stack: answer a request whose host is a link domain before anything else, using the language's link domain check from its docs page.

4. Check. https://${domain}/.well-known/runlight-link-domain should answer {"runlight":true,"domain":"${domain}"}. Once it does, ${domain} shows as Working under Settings, Custom domains in the Runlight dashboard (add it there if it is not listed yet). A slug opened on ${domain} should then redirect like ${origin}${linkPath}/<slug> does.

Do not change anything else about how links or analytics work.
`;
}

/** For a site counted by a standalone Runlight server: only the script tag goes on the site. */
export function scriptPrompt(opts: { script: string; host?: string }): string {
  return `Add Runlight, privacy friendly web analytics, to this site${opts.host ? ` (${opts.host})` : ""}.

Add this script tag to every page, just before </head>, in the shared layout or template so it is on every page:

   ${opts.script}

Runlight sets no cookies and stores no personal data, so do not add a cookie banner for it. To count a custom event, add data-runlight="Event name" to an element, or call runlight("Event name") in JavaScript.

Keep the site's existing behaviour unchanged otherwise.
`;
}

export function installPrompt(opts: { origin: string; base: string; site?: string }): string {
  const { origin, base, site } = opts;
  return `Add Runlight, privacy friendly web analytics, to this project.

The dashboard should live at ${base} on this site (it is at ${origin}${base} here).

1. Install the package: npm install @runlight/sdk (and better-sqlite3 for a SQLite file, or pg for Postgres; use Postgres on Vercel or anywhere without a persistent disk).

2. Create lib/runlight.ts:

   import { runlight } from "@runlight/sdk";
   import { sqlite } from "@runlight/sdk/sqlite";
   export const rl = runlight({ store: sqlite({ path: "./data/runlight.db" }) });

   For Postgres: import { postgres } from "@runlight/sdk/postgres" and use postgres({ url: process.env.DATABASE_URL }).

3. Mount the routes. In Next.js, app${base}/[[...path]]/route.ts:

   import { rl } from "@/lib/runlight";
   export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = rl.routes(${base === "/runlight" ? "" : `{ basePath: "${base}" }`});

   For Express or plain Node, use toNodeHandler(rl.routes().handler) from "@runlight/sdk/node".

4. Short links: app/go/[slug]/route.ts with export const GET = rl.linkHandler();

5. Add the tracker to every page, just before </head>:

   <script defer src="${base}/s.js"${site ? ` data-site="${site}"` : ""}></script>

6. Set RUNLIGHT_TOKEN to a long random string in the environment; open ${base}?token=<that string> once to sign in to the dashboard.

7. Optional, to see AI agents like ChatGPT and Claude reading pages: call void rl.observe(request) for every request in the middleware: export function proxy in proxy.ts in Next.js 16 and later, or export async function middleware in middleware.ts in Next.js 15 and earlier, with export const config = { runtime: "nodejs" }; from 15.5.

Keep the site's existing behaviour unchanged otherwise.
`;
}

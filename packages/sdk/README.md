# @runlight/sdk

Runlight is privacy friendly web analytics that runs inside your own app. It counts visitors without cookies and without storing anyone’s IP address. The numbers stay in your database, and the dashboard is served from your domain at `/runlight`.

It works with Next.js, Nuxt, SvelteKit, Astro, Remix, Express, NestJS, Fastify, Koa, Hono, and anything else that handles a web `Request`, on Node 22 or later, Bun, Deno, or Cloudflare Workers.

## Get started

Install the library with a database driver. This one uses SQLite.

```bash
npm install @runlight/sdk better-sqlite3
```

Create one instance for your app, here in `lib/runlight.ts`.

```ts
import { runlight } from "@runlight/sdk";
import { sqlite } from "@runlight/sdk/sqlite";

export const rl = runlight({
  store: sqlite({ path: "./data/runlight.db" }),
  site: { name: "example.com", hostnames: ["example.com"], timezone: "Europe/London" },
});
```

Mount its routes. In the Next.js App Router that is one catch-all route at `app/runlight/[[...path]]/route.ts`.

```ts
import { rl } from "@/lib/runlight";

export const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = rl.routes();
```

Add the script to every page, just before `</head>`.

```html
<script defer src="/runlight/s.js"></script>
```

Set `RUNLIGHT_TOKEN` to a long random string and open `/runlight/?token=` followed by that string once to sign in.

The [documentation](https://runlight.sh/docs/) covers every framework and every database, Postgres, MySQL, Turso, and Cloudflare D1 among them. It also covers goals, short links, email reports, and the API.

## License

Runlight is MIT licensed.

### Create things with the dashboard assistant

Ask the assistant to create a goal, a funnel, an email report, or a share link in natural language. Standalone installations with accounts also support member invitations. The assistant asks for missing details and prepares one draft at a time for the site on screen. Review the exact fields in the chat and click its creation button to save. A text reply such as "yes" does not execute an action. Sending another message cancels the previous pending draft so you can revise it.

The model only prepares drafts. Confirmation calls the existing authenticated APIs, with the same permissions and validation as the settings forms. Viewers cannot create things, and only owners and admins can invite people. Invitations made this way are for the site on screen only, as a member or a viewer, and anyone holding a share link can read its site's shared dashboard.

Email reports use the existing weekly or monthly schedule and require a working mail service and scheduler. The assistant cannot install event tracking code, choose a custom delivery time, edit existing objects, or delete them. If a creation request fails after it was sent, check Settings before trying again to avoid duplicates. The MCP tools remain read-only.

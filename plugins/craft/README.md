# Runlight for Craft CMS

Counts your site's visitors with [Runlight](https://runlight.sh/): privacy friendly analytics with no cookies, kept in your own database.

- Runs Runlight inside your Craft site, with its numbers in Craft's own database, or sends to a Runlight you run elsewhere.
- Adds Runlight's script to every front-end page, and marks 404 pages.
- Leaves out Control Panel users' own visits, if you want.
- Records AI agents such as ChatGPT and Claude that fetch your pages, after the response has been sent.
- Adds a Runlight item to the Control Panel that shows your dashboard there.

Nothing is counted until you choose where Runlight runs. Installing the plugin opens its settings, with two choices.

## In this Craft site

Press Run Runlight in this Craft site and it starts counting. Its dashboard shows under Runlight in the Control Panel, and on its own at `/runlight/` on your site, for admins and anyone allowed to use the plugin. Short links answer at `/go/<name>`.

Runlight keeps its numbers in Craft's database, in tables starting `rl_` whatever table prefix Craft uses, when that is Postgres, MySQL 8.4, or MariaDB 11.4 or later. Otherwise it keeps them in a SQLite file in `storage/runlight`, which needs PHP's pdo_sqlite. That folder also holds the secret Runlight signs with; on several servers, share the folder or set `RUNLIGHT_SECRET` to the same value on each. Turn on Locations to see visitors' countries from DB-IP's free data, which is downloaded once a month and kept in the same folder.

Its hourly upkeep (daily salts, email reports, retention, and daily totals) runs from Craft's queue, queued by a visit when an hour has passed. Craft's queue runs when someone uses the Control Panel, unless you run it yourself, so for steady upkeep add a cron job:

```
0 * * * * php /path/to/craft runlight/check
```

Uninstalling the plugin removes Runlight's tables and its folder.

## On a Runlight you run elsewhere

Enter your Runlight's address, shown in Runlight under Settings, Install, and press Connect. Runlight asks you to pick this site, then fills in the site id, the agents key, and the dashboard key. Connecting needs the Control Panel on https, or on this computer while trying things out; without it, copy the keys from Runlight's Settings, Install instead.

The address, site id, and keys accept environment variables, so the keys can stay out of project config. Connect saves the keys themselves, so set those fields to variables afterwards to keep them out. Full steps: [runlight.sh/docs/craft](https://runlight.sh/docs/craft/).

Only the Control Panel's own origin may frame the dashboard. When a proxy in front of Craft ends HTTPS, set `baseCpUrl` in `config/general.php` (or `CRAFT_BASE_CP_URL`), so the plugin asks for the right one.

# Runlight for Craft CMS

Counts your site's visitors with [Runlight](https://runlight.sh/): privacy friendly analytics with no cookies, kept in your own database.

- Runs Runlight inside your Craft site, with its numbers in Craft's own database, or sends to a Runlight you run elsewhere.
- Adds Runlight's script to every front-end page, and marks 404 pages.
- Leaves out Control Panel users' own visits, if you want.
- Records AI agents such as ChatGPT and Claude that fetch your pages, after the response has been sent.
- Adds a Runlight item to the Control Panel that shows your dashboard there.

Nothing is counted until you choose where Runlight runs. Installing the plugin opens its settings, with two choices.

## In this Craft site

Press Run Runlight in this Craft site and it starts counting. Its dashboard shows under Runlight in the Control Panel, and on its own at `/runlight/` on your site. Admins and people with the Manage Runlight permission own it, and people with See Runlight's numbers can read it, under Users, Permissions, Runlight. Short links answer at `/go/<name>`.

Runlight keeps its numbers in Craft's database, when that is Postgres, MySQL 8.4, or MariaDB 11.4 or later, in tables named after Craft's table prefix and `rl_`, such as `craft_rl_events`, marked as this install's. Tables of those names that are not this install's Runlight's, such as a standalone Runlight's, are left alone. Otherwise it keeps them in a SQLite file in `storage/runlight`, which needs PHP's pdo_sqlite and belongs to one server. Nothing records the choice beside the numbers, so it holds on every server and through every deploy. The secret Runlight signs with comes from Craft's `securityKey`. Turn on Locations to see visitors' countries from DB-IP's free data, which is downloaded once a month into `storage/runlight` on each server.

The visitor's address is the one Craft works out, which follows its `trustedHosts` and `ipHeaders` settings. Craft trusts proxy headers from any host by default, so set `trustedHosts` to the proxies in front of your site. Rate counts go in Craft's cache.

Its hourly upkeep (daily salts, email reports, retention, and daily totals) runs from Craft's queue, queued by a visit to the site when an hour has passed and no earlier one is waiting. Craft's queue runs when someone uses the Control Panel, unless you run it yourself, so for steady upkeep add a cron job:

```
0 * * * * php /path/to/craft runlight/check
```

Email reports and test emails go through Craft's own mailer when Settings, Email uses a transport other than Sendmail, such as SMTP, from Craft's system email address and sender name. With Sendmail, Runlight's dashboard asks for a mail service under Settings, Email service, where you can also choose one in place of Craft's mailer, and go back to it later.

Uninstalling the plugin drops Runlight's tables, each by name and only this install's, even when its folder is gone, and removes its folder.

## On a Runlight you run elsewhere

Enter your Runlight's address, shown in Runlight under Settings, Install, and press Connect. Runlight asks you to pick this site, then fills in the site id, the agents key, and the dashboard key. Connecting needs the Control Panel on https, or on this computer while trying things out; without it, copy the keys from Runlight's Settings, Install instead.

Connect writes the keys into Craft's `.env` as `RUNLIGHT_AGENTS_KEY` and `RUNLIGHT_DASHBOARD_KEY` and saves the settings as `$RUNLIGHT_AGENTS_KEY` and `$RUNLIGHT_DASHBOARD_KEY`, so project config holds no key. Where `.env` cannot be written, it saves the keys themselves and says how to move them. The address, site id, and keys all accept environment variables. Full steps: [runlight.sh/docs/craft](https://runlight.sh/docs/craft/).

Only the Control Panel's own origin may frame the dashboard. When a proxy in front of Craft ends HTTPS, set `baseCpUrl` in `config/general.php` (or `CRAFT_BASE_CP_URL`), so the plugin asks for the right one.

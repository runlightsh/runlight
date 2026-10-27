# Release Notes for Runlight

## Unreleased

### Changed
- Updated the Runlight library to 0.3.2, a maintenance release with updated dependencies. Nothing changes in how the plugin works.

## 0.3.1 - 2026-10-26

### Changed
- Updated the Runlight library to 0.3.1. Email reports draw the Runlight logo in HTML instead of loading an image from runlight.sh.

## 0.3.0 - 2026-10-24

### Changed
- Updated the Runlight library to 0.3.0. Outbound link and File download events keep the link without its query string or fragment, and a funnel over more than 100,000 visits counts the newest 100,000.

### Fixed
- A hit tried again after the database was busy no longer counts twice in its visit.

### Security
- Fetches that must reach the public internet refuse more IPv6 forms of private addresses.

## 0.2.0 - 2026-10-18

### Changed
- Released with Runlight 0.2.0, whose new ClickHouse support is for the standalone server. Nothing in the plugin changed.

## 0.1.8 - 2026-10-16

### Changed
- Updated the Runlight library to 0.1.8, with shorter-lived daily salts, stronger password hashing, faster reports on big sites, and dashboard accessibility fixes.

### Fixed
- Each MySQL connection drops `NO_BACKSLASH_ESCAPES`, so values are written correctly on a server set to that mode.

## 0.1.7 - 2026-10-15

### Changed
- Released with Runlight 0.1.7.

## 0.1.6 - 2026-10-14

### Changed
- Updated the Runlight library to 0.1.6, keeping the dashboard, account-security, and database migration improvements from 0.1.5.

## 0.1.5 - 2026-10-14

### Changed
- Updated the bundled Runlight library to 0.1.5, including account security, site-scoped access, and prefixed-table migration fixes.
- Improved dashboard loading states, Campaigns tabs, Goals and Funnels shortcuts, and AI agent reporting guidance.

## 0.1.4 - 2026-10-13

### Changed
- Released with Runlight 0.1.4.

## 0.1.3 - 2026-10-12

### Security
- A mail service, mail webhook, or AI assistant that redirects to another address is refused before anything is sent there, so its key and the message never leave for a server you didn't choose.
- Those requests connect to the address Runlight checked, so a name that changes between the check and the connection can't lead them to a cloud metadata address.
- The AI assistant's limits hold when questions are sent all at once, so a viewer can't go past the daily limit.
- Behind Cloudflare, countries still come from Cloudflare's headers, now only for requests that came through Cloudflare's own addresses.

### Fixed
- Changing a site in Runlight's dashboard checks every field before it changes anything, so a change refused for a bad or taken domain no longer shortens how long visits are kept or deletes older ones.
- Answers from AI models, mail services, and link domains are read only up to a sensible size.
- A chart over a long range with an interval too fine for it moves up to the next interval that fits, instead of lumping the rest of the range into its last point.

## 0.1.2 - 2026-10-12

### Added
- Runlight can now run inside your Craft site, with its numbers in Craft's database (Postgres, MySQL 8.0.20, or MariaDB 11.4 or later) or else in a SQLite file under `storage/runlight`, its dashboard under Runlight in the Control Panel and at `/runlight/` on the site, and short links at `/go/<name>`. Its tables are named after Craft's table prefix, such as `craft_rl_events`, and marked as this install's, and tables of those names that are someone else's, such as a standalone Runlight's, are left alone. The choice is read from the database and the storage folder, so it holds on every server and through every deploy, and the secret Runlight signs with comes from Craft's security key.
- Two permissions, under Users, Permissions, Runlight: See Runlight's numbers, and Manage Runlight, which with admins owns Runlight in your site. Changes are taken only from the site's own pages.
- Running in your site, Runlight counts each visitor by the address the connection came from, believing X-Forwarded-For only from a proxy on this server or a private network and Cloudflare's header only from Cloudflare, until you set Craft's `trustedHosts`, when it takes the address Craft works out from that and `ipHeaders`. It keeps its rate counts in Craft's cache. It reads no environment variables of its own, and its notes go to Craft's log.
- A setup screen, shown once the plugin is installed, to choose where Runlight runs: in this Craft site with one press, or on a Runlight you run elsewhere. Nothing is counted until you choose.
- A Locations setting, with Runlight in your site, shows visitors' countries from DB-IP's free data, downloaded once a month.
- `php craft runlight/check` runs Runlight's hourly upkeep for a cron job; without one, a visit to the site queues it in Craft's queue once an hour, unless one is still waiting. The settings say when it has not run for a day.
- Uninstalling drops Runlight's tables, each by name and only this install's, even when its folder under `storage` is gone, and removes the folder.
- A Connect button under the Runlight address in the settings. It asks your Runlight to pick this site, then fills in the site id and both keys, so nothing needs copying. It writes the keys into `.env` as `RUNLIGHT_AGENTS_KEY` and `RUNLIGHT_DASHBOARD_KEY` and saves the settings as those variables, so project config holds no key.
- With Runlight in your site, email reports go through Craft's own mailer when its email settings use a transport other than Sendmail, such as SMTP. Runlight's dashboard can still pick another mail service, and go back to Craft's.

### Changed
- The plugin needs the runlight/runlight package, which Composer installs with it.
- The observe key is now called the agents key, as Runlight calls it, and each setting says where in Runlight it is shown.
- The dashboard in the Control Panel grows to its full height, so the page scrolls like any other, and its sheets open over the part on screen.
- While a Runlight elsewhere does not answer, reports of AI agent fetches pause for a minute, so a server that is down never ties up PHP once for every fetch.

## 0.1.1 - 2026-10-10

### Changed
- Typed keys are hidden like passwords in the settings, while keys that name an environment variable still show.
- The dashboard is framed for the Control Panel's own address, so it works behind a proxy that ends HTTPS.

## 0.1.0 - 2026-10-10

### Added
- The plugin adds Runlight's script to every front-end page and marks 404 pages.
- Control Panel users' own visits can be left out of the count, and the pages they see without the script are kept out of Blitz and other caches.
- AI agents such as ChatGPT and Claude that fetch your pages are reported to Runlight after the page has been sent, and under PHP-FPM or LiteSpeed after the connection has closed, so they never wait on it there.
- The address, site id, and keys may each name an environment variable, and saved keys are cleared when the Runlight address changes, so they are never sent to another server.
- A Runlight item in the Control Panel shows the site's dashboard, read-only, once a dashboard key is set, with a link to open it in your Runlight.

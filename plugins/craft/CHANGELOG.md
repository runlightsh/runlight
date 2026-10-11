# Release Notes for Runlight

## Unreleased

### Added
- Runlight can now run inside your Craft site, with its numbers in Craft's database (Postgres, MySQL 8.4, or MariaDB 11.4 or later) or else in a SQLite file under `storage/runlight`, its dashboard under Runlight in the Control Panel and at `/runlight/` on the site, and short links at `/go/<name>`. Admins and anyone allowed to use the plugin can open it.
- A setup screen, shown once the plugin is installed, to choose where Runlight runs: in this Craft site with one press, or on a Runlight you run elsewhere. Nothing is counted until you choose.
- A Locations setting, with Runlight in your site, shows visitors' countries from DB-IP's free data, downloaded once a month.
- `php craft runlight/check` runs Runlight's hourly upkeep for a cron job; without one, a visit queues it in Craft's queue once an hour.
- Uninstalling removes Runlight's tables and its folder under `storage`.
- A Connect button under the Runlight address in the settings. It asks your Runlight to pick this site, then fills in the site id and both keys, so nothing needs copying.
- With Runlight in your site, email reports go through Craft's own mailer when its email settings use a transport other than Sendmail, such as SMTP. Runlight's dashboard can still pick another mail service, and go back to Craft's.

### Changed
- The plugin needs the runlight/runlight package, which Composer installs with it.
- The observe key is now called the agents key, as Runlight calls it, and each setting says where in Runlight it is shown.

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

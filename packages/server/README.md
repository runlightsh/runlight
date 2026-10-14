# runlight.sh

Runlight is privacy friendly web analytics that you run yourself. This package is Runlight as a server of its own, for sites that are not Node apps or for one dashboard across many sites. It counts visitors without cookies and without storing anyone’s IP address, so there is no consent banner to show.

## Start it

With Node 22 or later, run this.

```bash
npx runlight.sh
```

The server listens on port 3000 and keeps its data in a `runlight-data` folder in the directory you start it from. On its first start it prints a setup link with a one-time code. Open it to make the first account, then add a site and put its script tag on your pages.

The same server runs in Docker.

```bash
docker run -d --name runlight -p 3000:3000 -v runlight:/data ghcr.io/runlightsh/runlight
```

The owner invites other people as admins, members, or viewers, and everyone can turn on two-factor sign-in. The server also makes short links on your own domains and emails weekly or monthly reports. It can show sites counted by Runlight inside other apps too.

The [server guide](https://runlight.sh/docs/server/) covers its settings, Postgres, MySQL, and running it behind a proxy.

Browser favicons, Apple touch icons, and a web manifest are served by the installation itself. Add the dashboard to your phone's home screen to use the Runlight icon. If an existing shortcut shows older artwork, remove that shortcut and add it again after updating the server.

## Monitor scheduled work

Set `CRONWATCH_MAIL_TO` to your alert recipient after configuring Runlight's mail service. CronWatch uses the same sender and credentials. It records maintenance and automatic location-data checks on their existing five-minute schedule, stores history in `DATA_DIR/cronwatch.db`, and checks for missed or stuck runs every minute. Owners and administrators can open `/cronwatch` after signing in. No separate CronWatch token is needed.

Failed email reports, unavailable or stale location data, slow runs, and unexpected metric changes can send alerts. Zero emails sent is normal when no reports are due, and location checks can succeed without downloading anything. Keep the CronWatch database with your persistent data. This optional SQLite configuration is for a single standalone server, not multiple replicas. It does not monitor an entire server outage while its process is stopped.

## License

Runlight is MIT licensed.

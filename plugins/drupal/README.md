# Runlight for Drupal

Counts your site's visitors with [Runlight](https://runlight.sh/): privacy friendly analytics with no cookies, kept in your own database.

- Runs Runlight inside this site, with its numbers in this site's database, or sends to a Runlight you run elsewhere.
- Adds Runlight's script to every page (not admin pages), and marks 404 pages.
- Leaves out the visits of people who can administer Runlight, if you want.
- Records AI agents such as ChatGPT and Claude that fetch your pages, after the response has gone out.
- Adds Reports, Runlight, which shows your dashboard in the admin.

Install it with Composer, which brings the Runlight library with it (PHP 8.2 or later):

```sh
composer require drupal/runlight
drush en runlight
```

Then choose where Runlight runs under Configuration, System, Runlight. Nothing is counted until you do. Full steps: [runlight.sh/docs/drupal](https://runlight.sh/docs/drupal/).

## In this Drupal site

One press and Runlight runs inside the site: its dashboard is at `/runlight` as well as under Reports, Runlight, and anyone with the Administer Runlight permission can open it. Short links answer at `/go/{name}`.

Runlight keeps its numbers in Drupal's own database, in tables that start with `rl_`, when that is Postgres, or MySQL 8.4 or MariaDB 11.4 or later. Otherwise it keeps them in a SQLite file in the private files folder, or in the public one under a name no one can guess, with a `.htaccess` that keeps Apache from serving it. The choice is made once and kept.

Run cron hourly: it rolls the day's salts, sends reports, applies retention, and builds the daily totals. With Locations on, it also downloads DB-IP's free country data once a month. Visitors' addresses are looked up on this server and never sent anywhere.

Uninstalling the module removes Runlight's tables or file, its folder, and its secret and keys.

## On a Runlight you run elsewhere

Enter your Runlight's address, press Connect, and pick this site in Runlight, which fills in the site id and keys. Connecting needs the admin on https (or localhost).

### Keys outside exported configuration

Drupal exports the module's settings, keys included, with the rest of the site's configuration. To keep the keys (the agents key and the dashboard key) out of your repository, leave them blank on the settings page rather than connecting, copy them from Runlight under Settings, Install, and set them in `settings.php`, which overrides the saved values and is never exported:

```php
$config['runlight.settings']['observe_key'] = getenv('RUNLIGHT_OBSERVE_KEY');
$config['runlight.settings']['dashboard_key'] = getenv('RUNLIGHT_DASHBOARD_KEY');
```

## Behind a proxy that ends HTTPS

Only the admin's own origin may frame the dashboard, and the module reads it from the request. When a load balancer or proxy in front of Drupal ends HTTPS, tell Drupal about it in `settings.php`, so the origin stays https:

```php
$settings['reverse_proxy'] = TRUE;
$settings['reverse_proxy_addresses'] = ['10.0.0.2'];
```

Or name the admin's origin outright:

```php
$settings['runlight_admin_origin'] = 'https://www.example.com';
```

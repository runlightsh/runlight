# Runlight for Drupal

Counts your site's visitors with [Runlight](https://runlight.sh/): privacy
friendly analytics with no cookies, kept in your own database.

- Runs Runlight inside this site, with its numbers in this site's database, or
  sends to a Runlight you run elsewhere.
- Adds Runlight's script to every page (not admin pages), and marks 404 pages.
- Leaves out the visits of people who can administer Runlight, if you want.
- Records AI agents such as ChatGPT and Claude that fetch your pages, after the
  response has gone out.
- Adds Reports, Runlight, which shows your dashboard in the admin.

## Requirements

Drupal 10.3 or 11, and PHP 8.2 or later. Running Runlight inside the site also
needs the `pdo`, `mbstring`, and `openssl` extensions, and either Drupal's
database on Postgres, MySQL 8.0.20, or MariaDB 11.4 or later, or else a private
files folder and `pdo_sqlite`.

## Installation

Install it with Composer, which brings the Runlight library with it:

```sh
composer require drupal/runlight
drush en runlight
```

## Configuration

Choose where Runlight runs under Configuration, System, Runlight. Nothing is
counted until you do. Full steps:
[runlight.sh/docs/drupal](https://runlight.sh/docs/drupal/).

### In this Drupal site

One press and Runlight runs inside the site: its dashboard is at `/runlight` as
well as under Reports, Runlight. People with the Administer Runlight permission
own it, and people with View Runlight see the same dashboard without changing
anything. Short links answer at `/go/{name}`.

Runlight keeps its numbers in Drupal's own database, when that is Postgres, or
MySQL 8.0.20 or MariaDB 11.4 or later, in tables named after Drupal's table prefix
and `rl_`, such as `rl_events`, marked as this site's. Tables of those names
that are not this site's Runlight's, such as a standalone Runlight's, are left
alone. It opens a connection of its own through Drupal's database driver, from
Drupal's connection settings, `pdo` options and `init_commands` included.
Otherwise it keeps them in a SQLite file in the private files folder, which
needs `$settings['file_private_path']`. Nothing goes under public files. The
choice is made once and kept.

The visitor's address is the one Drupal works out for each request, which
follows `$settings['reverse_proxy']` and `$settings['reverse_proxy_addresses']`,
so name the proxies in front of the site there. Rate counts go in Drupal's
cache.

Run cron hourly: it rolls the day's salts, sends reports, applies retention,
and builds the daily totals. With Locations on, it also downloads DB-IP's free
country data once a month into the private files folder, or else the temporary
one. Visitors' addresses are looked up on this server and never sent anywhere.

Email reports and test emails go through Drupal's own mailer when the site has
one beyond PHP's `mail()`, such as the SMTP module or Symfony Mailer, from the
site's email address and name. Without one, Runlight's dashboard asks for a mail
service under Settings, Email service, where you can also choose one in place of
Drupal's mailer, and go back to it later. After updating the module, run
`drush cr` so Drupal finds `runlight_mail()`.

Uninstalling the module drops Runlight's tables, each by name and only this
site's, or removes its folder, along with its secret, its keys, and what it kept
in the cache.

### On a Runlight you run elsewhere

Enter your Runlight's address, press Connect, and pick this site in Runlight,
which fills in the site id and keys. Connecting needs the admin on https (or
localhost).

### Keys and environments

Where Runlight runs, its address, the site id, and both keys belong to one
environment, so the module keeps them in Drupal's state, which configuration
export leaves out. What it counts stays in configuration. Values an earlier
version saved in configuration count until the settings are next saved, which
moves them to state. To set any of them in code, use `settings.php`, which wins
over the settings page:

```php
$runlight = &$config['runlight.settings'];
$runlight['observe_key'] = getenv('RUNLIGHT_AGENTS_KEY');
$runlight['dashboard_key'] = getenv('RUNLIGHT_DASHBOARD_KEY');
```

### Behind a proxy that ends HTTPS

Only the admin's own origin may frame the dashboard, and the module reads it
from the request. When a load balancer or proxy in front of Drupal ends HTTPS,
tell Drupal about it in `settings.php`, so the origin stays https:

```php
$settings['reverse_proxy'] = TRUE;
$settings['reverse_proxy_addresses'] = ['10.0.0.2'];
```

Or name the admin's origin outright:

```php
$settings['runlight_admin_origin'] = 'https://www.example.com';
```

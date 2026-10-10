# Runlight for Drupal

Counts your site's visitors with [Runlight](https://runlight.sh/): privacy friendly analytics with no cookies, kept in your own database.

- Adds Runlight's script to every page (not admin pages), and marks 404 pages.
- Leaves out the visits of people who can administer Runlight, if you want.
- Reports AI agents such as ChatGPT and Claude that fetch your pages, after the response has gone out.
- Adds Reports, Runlight, which shows your dashboard in the admin with a dashboard key, and links to your Runlight.

Set it up under Configuration, System, Runlight. Full steps: [runlight.sh/docs/drupal](https://runlight.sh/docs/drupal/).

## Keys outside exported configuration

Drupal exports the module's settings, keys included, with the rest of the site's configuration. To keep the keys out of your repository, leave them blank on the settings page and set them in `settings.php`, which overrides the saved values and is never exported:

```php
$config['runlight.settings']['observe_key'] = getenv('RUNLIGHT_OBSERVE_KEY');
$config['runlight.settings']['dashboard_key'] = getenv('RUNLIGHT_DASHBOARD_KEY');
```

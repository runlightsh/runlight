# runlight

Runlight is privacy friendly web analytics that runs inside your own Ruby app. It counts visitors without cookies and without storing anyone’s IP address. The numbers stay in your database, and the dashboard is served from your domain at `/runlight`.

This gem is the Ruby version of [Runlight](https://runlight.sh). It works in Rails 7.2 or later and in any Rack app on Ruby 3.2 or later, and it can also run on a domain of its own. It answers every request the way the TypeScript library does and uses the same tables, so any of them can read the others’ database.

## Rails

Add the gem and run the generator.

```bash
bundle add runlight
bin/rails generate runlight:install
bin/rails db:migrate
```

The generator writes `config/initializers/runlight.rb`, where you set the site’s hostnames, and a migration for Runlight’s tables. Add the script to your layout, just before `</head>`.

```html
<script defer src="/runlight/s.js"></script>
```

Set `RUNLIGHT_TOKEN` to a long random string, then open `/runlight/?token=` followed by that string to sign in. Run `bin/rails runlight:check` every few minutes for the email reports and upkeep.

If nothing sits in front of your app (no load balancer, CDN, or reverse proxy), add `trust_proxy: false` beside `store:` and `site:` (in `Runlight.configure` or `Runlight.new`), so a visitor cannot pick their own address with an `X-Forwarded-For` header. Runlight logs a warning once when it sees requests arrive that way with the default left on.

## Rack

Add the gem with the driver for your database: `sqlite3`, `pg` for Postgres, or `trilogy` or `mysql2` for MySQL and MariaDB.

```bash
bundle add runlight sqlite3
```

```ruby
require "runlight"

RL = Runlight.new(
  store: Runlight::Stores.sqlite("data/runlight.db"),
  site: { name: "example.com", hostnames: ["example.com"], timezone: "Europe/London" },
)

use Runlight::RackApp, runlight: RL
run MyApp
```

The [Ruby guide](https://runlight.sh/docs/ruby/) and the [Rails guide](https://runlight.sh/docs/rails/) cover the Postgres, MySQL, and MariaDB stores, accounts, the scheduled check, and the standalone server.

## License

Runlight is MIT licensed.

# Runlight

Privacy friendly web analytics that you run yourself.

Runlight counts visitors without cookies and without storing anyone’s IP address, so there is no consent banner to show. Your numbers stay in your own database, and the dashboard is served from your own domain. The tracking script is under 2 KB gzipped.

[Website](https://runlight.sh) · [Documentation](https://runlight.sh/docs/) · [Changelog](CHANGELOG.md)

## What you get

- Visitors, pages, sources, countries, devices, and campaigns, over any period you choose.
- Goals and the revenue they bring, funnels, and the paths visits take through your site.
- AI agents such as ChatGPT and Claude counted when they read your pages.
- Short links on your own domains, with their clicks counted.
- Weekly or monthly email reports, and a read-only dashboard you can share by link.
- An assistant in the dashboard, and an MCP server for AI apps, that answer questions about your numbers.
- Imports of your history from Umami or a CSV file, and of short links from Bitly, Dub, Rebrandly, and Short.io.

## Get started

### Inside an app you already have

Install the library, mount its routes, and add one script tag. Your stats are at `/runlight`.

```bash
npm install @runlight/sdk better-sqlite3
```

It works with Next.js, Nuxt, SvelteKit, Astro, Remix, Express, NestJS, Fastify, Koa, Hono, and anything else that handles a web `Request`, on Node 22 or later, Bun, Deno, or Cloudflare Workers. It stores its data in SQLite, Postgres, MySQL, MariaDB, Turso, or Cloudflare D1. The [install guide](https://runlight.sh/docs/install/) has a section for each framework.

### As a server of its own

The standalone server suits sites that are not Node apps, and gives any number of sites one dashboard, with sign-in for the people you invite.

```bash
npx runlight.sh
```

Or with Docker:

```bash
docker run -d --name runlight -p 3000:3000 -v runlight:/data ghcr.io/runlightsh/runlight
```

See [the standalone server docs](https://runlight.sh/docs/server/) for running it behind a proxy, on a domain, and with Postgres or MySQL.

## Other languages and platforms

Runlight is also available for eight more languages and three CMSs. Each language serves the same dashboard and uses the same tables, so you can switch between them without losing your data.

| Platform | Install | Docs |
| --- | --- | --- |
| PHP | `composer require runlight/runlight` (PHP 8.2 or later) | [PHP](https://runlight.sh/docs/php/) |
| WordPress | `wp plugin install https://github.com/runlightsh/runlight/releases/latest/download/runlight.zip --activate`, or upload that zip under Plugins, Add New | [WordPress](https://runlight.sh/docs/wordpress/) |
| Drupal | `composer require drupal/runlight`, then `drush pm:install runlight` (Drupal 10.3 or 11) | [Drupal](https://runlight.sh/docs/drupal/) |
| Craft CMS | From the [Plugin Store](https://plugins.craftcms.com/runlight), or `composer require runlight/craft`, then `php craft plugin/install runlight` (Craft 5) | [Craft CMS](https://runlight.sh/docs/craft/) |
| Python | `pip install runlight` (Python 3.11 or later), with the `postgres` or `mysql` extra for those databases | [Python](https://runlight.sh/docs/python/) |
| Rails | `bundle add runlight`, then `bin/rails generate runlight:install` and `bin/rails db:migrate` (Rails 7.2, 8.0, or 8.1) | [Rails](https://runlight.sh/docs/rails/) |
| Ruby | `bundle add runlight sqlite3` (Ruby 3.2 or later), or `pg`, `trilogy`, or `mysql2` in place of `sqlite3` | [Ruby](https://runlight.sh/docs/ruby/) |
| Go | `go get runlight.sh/go` (Go 1.25 or later), with `runlight.sh/go/chi` or `runlight.sh/go/echo` for those routers | [Go](https://runlight.sh/docs/go/) |
| Java | `sh.runlight:runlight` from Maven Central (Java 21 or later), with `runlight-servlet` or `runlight-spring-boot-starter` | [Java](https://runlight.sh/docs/java/) |
| .NET | `dotnet add package Runlight.AspNetCore` (.NET 10 or later), or `dotnet tool install --global Runlight.Server` for the standalone server | [.NET](https://runlight.sh/docs/dotnet/) |
| Elixir | `{:runlight, "~> 0.1"}` in `mix.exs` (Elixir 1.18 or later) | [Elixir](https://runlight.sh/docs/elixir/) |
| Rust | `cargo add runlight --features axum` and `cargo add runlight-sqlx --features sqlite` (Rust 1.88 or later, and 1.94 or later for `runlight-sqlx`) | [Rust](https://runlight.sh/docs/rust/) |

The WordPress, Drupal, and Craft plugins add the script to your site and report AI agents that read its pages. They send to your own Runlight, wherever you run it.

## Privacy

Runlight never sets a cookie and never stores an IP address, a full user agent, or anything else that could identify a person for longer than a day. Visitors are counted with a hash whose random salt changes every day and is then deleted, so it cannot be reversed. Read [how Runlight counts](https://runlight.sh/docs/privacy/) for the details.

## Contributing

Bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how the repository is laid out and how to run the tests.

## License

MIT

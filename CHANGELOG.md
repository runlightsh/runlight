# Changelog

Every notable change to Runlight is listed here, newest first. The library, the standalone server, the package for every other language, and the WordPress plugin share one version, so each release is one section here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org). The WordPress plugin keeps its changelog in its readme, and the Craft plugin keeps one of its own for the Craft Plugin Store.

## 0.1.1 - 2026-10-10

This release fixes the findings of a full security and code review of every implementation, plugin, and release workflow.

### Security

- Sign-in no longer sends people to another site when the `next` path resolves to one starting `//`, such as `/..//example.com`.
- Sign-in limits and two-factor code limits hold under parallel requests in the PHP, Python, Ruby, Java, and .NET versions, which kept their counts in the database and could be raced past. One-time sign-in links, recovery codes, and two-factor codes are now single use across workers on SQLite too.
- Sign-in counts tries per address across accounts before checking a password, checks only a few passwords at once, and answers `busy` with a 503 past that, so a flood of sign-ins cannot exhaust memory or CPU.
- Counts kept per address no longer hold anything an IP address could be worked out from after a day: the key they are hashed with changes daily and old keys are deleted.
- Tries on a decoy two-factor step no longer count against the real account, so nobody can keep someone else locked out.
- Invites are deleted when the person who sent them is removed or demoted, and accepting one checks that its sender may still invite.
- OAuth codes and connect requests are taken atomically, so a code works once.
- The Elixir, Ruby, and .NET versions turn off MySQL's `NO_BACKSLASH_ESCAPES` mode on every connection, as the TypeScript library does. On a server with that mode on, a tracking hit could otherwise have injected SQL.
- Deeply nested JSON can no longer crash the .NET version, and a JSON object with many keys can no longer tie up the Rust version.
- The Rails engine checks a form posted with `_method` as the POST it is, so it cannot get past the JSON-only rule for changes.
- The dashboard no longer opens to anyone because `MIX_ENV` is unset (Elixir) or the token is `None` (Python, which now uses `runlight.OPEN` for an open dashboard). Ruby asks for a shared secret when accounts are on outside development.
- Imported short links pass the same domain and destination checks as new ones, so an import cannot take over the site's own address.
- Visitor ids from a CSV import are keyed with a secret made for that import and never stored, so a visitor column holding IP addresses or emails cannot be recovered.
- Share links and embedded dashboards keep the number of people here now but no longer get the feed of single visits.
- The assistant's address and the SMTP server refuse link-local and cloud metadata addresses. Embedded dashboards need an https admin origin on its own port, except on localhost. Report links never use an address sent by the person setting them up.
- Outgoing requests are capped while they are read, drop credentials when a redirect changes origin, refuse https to http, and ignore proxy settings that would get around the check on where they connect.
- SQLite databases turn on `secure_delete`, so deleted daily salts do not linger in the file.
- The PHP drop-in refuses to start when its data folder could be downloaded, and its README shows how to deny it in nginx and Caddy. Files Runlight makes are readable by the server's user alone.

### Fixed

- A session cookie that is not valid percent-encoding reads as signed out instead of failing with a 500.
- MCP batches hold at most 20 messages.
- The Go server can no longer crash when work arrives while it waits for background work, and it carries its own time zone data, as the .NET version now does.
- Python closes its database connections, and Java caps its connection pool at ten. A cancelled request in Rust no longer leaves a transaction or lock open in the pool.
- Ruby no longer freezes waiting for a database lock under Rails' query cache, and a Runlight failure no longer breaks the app's own pages.
- The assistant's limits are checked and counted together in the Go, Java, .NET, and Rust versions, and Rust counts them per person.
- The WordPress plugin reports AI agents after the page has been sent, with the right address on sites in a subfolder. Its settings page, and Drupal's, check the Runlight address after they load.
- The Next.js instructions in the dashboard show `middleware.ts` for Next.js 15 and earlier.
- Releases check that the branch matches GitHub before tagging and push the branch and tag together. The Docker image installs exactly what the lockfile names and is started once before it is published.

## 0.1.0 - 2026-10-10

This is Runlight's first release.

### Added

- `@runlight/sdk` is privacy friendly web analytics that runs inside an app you already have. It counts visitors without cookies and without storing anyone's IP address, keeps the numbers in your own SQLite, Postgres, MySQL, MariaDB, Turso, or Cloudflare D1 database, and serves its dashboard at `/runlight` on your own domain. It runs on Node 22 or later, Bun, Deno, and Cloudflare Workers.
- `runlight.sh` is the same code as a server of its own, with one dashboard for any number of sites and sign-in for the people you invite. It starts with `npx runlight.sh`, and the Docker image is `ghcr.io/runlightsh/runlight`.
- `runlight/runlight` is the PHP version of the library, for Laravel, Symfony, or plain PHP on PHP 8.2 or later. It uses the same tables as the TypeScript library, so either one can read the other's database.
- Runlight counts goals and the revenue they bring, funnels, and the paths visits take through a site. It makes short links on your own domains and counts their clicks.
- Runlight emails weekly or monthly reports and shares a read-only dashboard by link.
- An assistant in the dashboard, and an MCP server for AI apps, answer questions about your numbers.
- `runlight` on PyPI is the Python version, for Django, Flask, FastAPI, or any WSGI or ASGI app on Python 3.11 or later, with a standalone server of its own. It answers exactly as the TypeScript library does and shares its tables.
- The `runlight` gem is the Ruby version, a Rails engine with an install generator for Rails 7.2, 8.0, and 8.1, or a Rack app or middleware anywhere else, on Ruby 3.2 or later. It also answers exactly as the TypeScript library does and shares its tables.
- The `runlight.sh/go` module is the Go version, for net/http, chi, Echo, or any router that takes an `http.Handler` on Go 1.25 or later, with a standalone server and a `runlight` command of its own. It answers exactly as the TypeScript library does and shares its tables.
- `runlight` on Hex is the Elixir version, for Phoenix or any Plug app on Elixir 1.18 or later and Erlang/OTP 27 or later, with its tables in your own Ecto repo. It answers exactly as the TypeScript library does and reads and writes the same tables.
- `sh.runlight:runlight` on Maven Central is the Java version, for the JDK's own HTTP server, Tomcat, Jetty, or any Jakarta Servlet 6 container, or Spring Boot 3.5 or 4, on Java 21 or later, with a standalone server of its own. It answers exactly as the TypeScript library does and shares its tables.
- `Runlight` on NuGet is the .NET version, for ASP.NET Core or any other .NET app on .NET 10 or later, with a standalone server that installs as the `runlight` tool. It answers exactly as the TypeScript library does and shares its tables.
- The `runlight` crate is the Rust version, for axum, hyper, or any tokio server that takes a tower service, on Rust 1.88 or later, with its tables in your own database through `runlight-sqlx`, which needs Rust 1.94 or later. It answers exactly as the TypeScript library does and shares its tables.
- Plugins for WordPress, Drupal, and Craft CMS add the script to a site and report the AI agents that read its pages to a Runlight you run elsewhere. With a dashboard key, each one shows the site's read-only dashboard inside the CMS's admin pages.

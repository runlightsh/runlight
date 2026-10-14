# Changelog

Every notable change to Runlight is listed here, newest first. The library, the standalone server, the package for every other language, and the WordPress, Drupal, and Craft plugins share one version, so each release is one section here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org). The WordPress plugin keeps its changelog in its readme, and the Craft plugin keeps one of its own for the Craft Plugin Store.

## 0.1.6 - 2026-10-14

### Fixed

- Corrected a Java account API documentation link that blocked Maven Central release builds. Normal Java CI now builds the release documentation before publishing.

## 0.1.5 - 2026-10-14

### Added

- Optional CronWatch monitoring in the standalone server records maintenance and location-data checks, emails alerts through the saved mail service, and provides an owner/admin dashboard at `/cronwatch`. Set `CRONWATCH_MAIL_TO` to enable it.

### Changed

- Standalone installations serve local favicons, Apple touch icons, and a web manifest with the green Runlight indicator on home-screen artwork.
- Reports, invitations, sign-in recovery emails, and test emails show the Runlight logo at 48 by 48 pixels with more space above the message.
- Team Members replaces People. Invitations default to the current site, with an explicit option for all sites.
- Password setup and invitation pages show password strength, and the settings sidebar includes a sign-out shortcut.
- Dashboard panels use skeleton loading states, and the AI agents empty state explains how to enable server-side reporting.

### Security

- Site-scoped accounts are restricted throughout the dashboard, API, assistant, and MCP reads. They cannot create tokens, authorize OAuth connections, or manage installation-wide settings. Restrictions also apply with custom authorization callbacks and when an invalid bearer header accompanies a session.
- Deleting a site from an authenticated account requires the current password, and the dashboard asks for an explicit acknowledgment. Transferring ownership also explains that ownership applies to every site and requires confirmation.

### Fixed

- Account migrations recognize existing site-scope columns in prefixed Postgres, MySQL, and MariaDB tables when an installation starts again.
- Scheduled checks report retention cleanup failures to the caller, so monitoring can alert instead of treating failed cleanup as a successful run.
- Clicking the active Campaigns tab again leaves its empty state intact instead of starting a loading state that never finishes.
- The Conversions add button opens Goals or Funnels according to the selected tab.

## 0.1.4 - 2026-10-13

### Added

- Tracking scripts support a synchronous `data-before-send` hook to scrub URLs, referrers, titles, and event properties before sending them. A configured scrubber that is missing, throws, or returns an invalid result sends nothing.
- The dashboard assistant can prepare goals, funnels, invitations, email reports, and share links. It asks for missing details and presents a draft for confirmation before using your existing permissions to create anything. MCP tools remain read-only.

### Fixed

- The live visitors modal includes direct traffic in Sources and labels it Direct instead of hiding it. Empty live views explain when there is no recent activity or location data.
- Account settings scroll as one panel, including two-factor setup, and Journeys scrolls its diagram without moving its controls out of view.
- The site comparison table supports sorting by each column and shows site favicons. The site switcher includes a live name and domain search when there are more than seven sites.
- Installation settings explain the optional CMS keys and let you revoke this site's dashboard keys in place. The assistant introduction is shorter, and the element picker explains its tracker requirement and reports blocked pop-ups.
- Goal values explain fixed amounts and event properties. The fixed amount field preserves decimal entry and requires an amount before saving.
- The site switcher keeps keyboard focus outlines visible, and arrow keys navigate every option. Assistant starter questions are more general.
- The All Sites modal has an Add New Site button beside its heading for people who can add sites.

## 0.1.3 - 2026-10-12

### Security

- The assistant's limits hold for questions sent at once. A person's place among their two at a time and thirty an hour is taken before anything else is awaited, and a viewer's daily count is a row of their own for the day, moved only from the number read to the next, so a burst of questions, or several processes on one database, can no longer spend the owner's AI credit past the daily number, and two viewers' counts no longer overwrite each other.
- A service's redirect to another origin is refused, in every language and in the WordPress, Drupal, and Craft plugins, with the code `redirect_refused`, before anything is sent there. Only the `Authorization`, `Proxy-Authorization`, and `Cookie` headers were dropped before, so Anthropic's `x-api-key`, Brevo's `api-key`, and Postmark's `x-postmark-server-token` went on to the new origin, and a 307 or 308 took the email or the conversation with them. A redirect from https to http counts as another origin. A redirect on the same origin is followed as before.
- A six-digit code or a recovery code is accepted once, even when two processes, or two `Accounts` on one database, check it at the same moment. The database takes the code only if no check since has used that step or a later one, or only if the recovery codes are still the ones read, so it no longer depends on a lock SQLite and D1 do not have.
- Location headers from a hosting platform (Cloudflare's `cf-ipcountry`, `cf-region-code`, and `cf-ipcity`, Netlify's `x-nf-geo`, and Vercel's `x-vercel-ip-country` and the rest) are believed only when `trustProxy` is on, as the forwarded address is. With it off, a client could write them itself, and the configured location lookup answers instead. `trustProxy` is still on by default. The WordPress, Drupal, and Craft plugins, which run with it off, still believe Cloudflare's for a connection from Cloudflare's own addresses, and Drupal also for one from a reverse proxy its settings trust.
- A service's request (the AI assistant's API, every HTTP mail service, and a mail webhook) connects to the address that was checked, on every hop, rather than having the name looked up again after the check, and no proxy from the environment looks it up for it. A name that cannot be looked up is refused, where it was let through before. Addresses on this computer and private networks are still allowed, for local models and mail relays. On a runtime with no resolver, such as Cloudflare Workers, only the name is checked, as before.

### Fixed

- Changing a site in the dashboard checks every field, its domains included, before it changes anything, so a change refused for a bad or taken domain no longer shortens how long visits are kept, deleting the older ones, or clears the days built in the old timezone. Visits are pruned only once the change is saved.
- Answers from an AI model's API, its list of models, a mail service's error, a link domain's check, and a connected install's live visitors are read only so far (4 MiB for a model and an install, 64 KiB for an error, 16 KiB for a check), and a body nobody reads is let go, so a service that answers without end cannot fill memory.
- The keys Runlight makes on first use and keeps in the database (the OAuth client key, the goal picker's and the embedded dashboard's signing keys, and a site's agents key) are written only if none is there yet, and every request reads back the one written first, so requests arriving together no longer overwrite each other's key and leave what was signed with the others invalid.
- The standalone server makes its secret in the data folder whole in a file of its own and links it into place, so two servers starting at once on one folder agree on it, and a secret file read empty or short is read again for a moment and then refused, never used. It stays readable only by its user.
- A chart over a long range with an interval too fine for it, such as hours over 40 days or days over 20 years, is counted at the next interval that fits (hours up to 744, and days, weeks, or months up to 1,000), which `range.interval` reports, rather than putting the rest of the range into its last point. Every point follows the interval's calendar boundaries, and only the first and last can be partial. A range of more than 1,000 months is refused with `range_bad`.

## 0.1.2 - 2026-10-12

### Security

- Requests to a service someone set up (the AI assistant's API, every HTTP mail service, and a mail webhook) follow redirects by hand, at most five, and check each one against link-local and cloud metadata addresses, so a redirect can no longer lead to a metadata service. A refused address answers `address_refused`. The public `refuseMetadata` helper is gone from the assistant in PHP, Python, Ruby, Go, Java, .NET, and Rust, since the fetch checks every hop itself.
- A fetch pinned to the address Runlight checked never goes out unpinned: TypeScript gives Node's https its own agent, so an environment proxy cannot look the name up again, and PHP's `CurlFetcher` and the other languages' fetchers refuse a pin they cannot apply, a pin for another host, or a redirect to an unpinned host, and ignore environment proxies for pinned requests. The WordPress, Drupal, and Craft fetchers refuse a transport or proxy that would skip the pin, and follow redirects by hand.
- The goal picker no longer gives the tracked site's tab a handle on the dashboard, which let any script on the site send the dashboard tab somewhere else. The dashboard opens the site cut off from itself, and the picker sends its choice to a relay page at `pick-return` under the dashboard's own address, in the fragment so it never reaches a server. The picker's ticket names that page and a nonce, signed, and the page hands the choice to the dashboard tab that made the nonce over a channel only that origin's pages share. A hub picking on a site whose own install is older asks for that install to be updated first.

### Fixed

- Connect works against a Runlight whose one site lists no domains, which counts any host: its consent page offers that site instead of asking to add one.
- Waiting for another process creating or upgrading the tables has a limit. After 30 seconds a request answers 503 with the code `tables_busy` and `Retry-After: 30`, and a tracker hit waits at most 10 seconds for the tables and is then dropped, so requests no longer pile up behind a long index build. On Postgres, an index left unusable is rebuilt under its own name when the table prefix itself starts `rl_`.
- A new SQLite file is readable and writable by its owner and group (0660), and a folder Runlight makes for it by its owner and group (0770), in every language and in the WordPress plugin, so a cron job or CLI command running as another user of the same group can still open it. PHP and the WordPress plugin made them 0600 and 0700, and the other languages left them to the umask.
- Java's app mailer answers an empty `via` rather than `null`, Rust refuses `mail` and `app_mailer` set together as Go does, and an app mailer in Rust that returns `runlight::Error::Mail` has its error passed on as it is.
- Running inside Craft with `trustedHosts` left at its default, which believes forwarded headers from anyone, the plugin works out each visitor's address itself, as the WordPress plugin does. A site that sets `trustedHosts` gets Craft's own answer.
- The dashboard has words for `mail_url`, `mail_port`, `busy`, and `tables_busy` in every language, and the `mail_service` refusal says the service is not offered here.
- The dashboard has words for `embed_token`, `embed_origin`, `embed_host`, and `token_embed_only` in every language, so a refused dashboard key says what to do in the dashboard's language.
- The prompt to copy for a custom link domain in Settings, Custom domains covers every language and framework Runlight runs in, from Next.js and Express to Laravel, Django, Rails, Go, Spring Boot, ASP.NET Core, Phoenix, and axum, and says no code is needed for a standalone server.
- The dashboard's Powered by Runlight link opens in a new tab everywhere, so it works inside a CMS's admin too.
- Removing a saved mail service in Settings, Email service says why when it fails, and an app's mailer is shown with its sender's name.
- A broken percent escape in a path, such as `%E0`, answers as an unknown goal, share, site, link domain, or short link (a 404) instead of an internal error.
- On a link domain, `/go/<name>` is a 404 like any other path with no link of that domain's, in the standalone server of every language that has one too, which redirected it to any site's link of that name.
- In Laravel and Symfony, the `/go/{slug}` route through `HttpFoundation::handle` raises the framework's own not-found for a short link nobody has, so the app's 404 page answers it, as it does behind `ShortLinks`.
- .NET: `MapRunlight()` inside `UseEndpoints` on a Startup-style host answers link domains, which it left to the app before. On an endpoint builder that reaches no middleware at all it refuses to start and says to use `UseRunlight()`.
- Elixir sorts names the way TypeScript does with punctuation in them, such as `a-b` and `a_b`, and reads a whole number past 2^53 in a location database as its decimal text, as the other languages do.

### Added

- The WordPress plugin runs Runlight inside WordPress: activate it, choose that on its setup screen, and the site is counted, with the dashboard at `/runlight` on the site for anyone who can manage options, AI agents recorded on the server, and the hourly check on WordPress's cron. The numbers go in WordPress's own MySQL 8.0.20 or MariaDB 11.4 database, through `$wpdb`, in tables named after WordPress's table prefix such as `wp_rl_events`, unless tables named that way are already there and are not Runlight's, or else in a SQLite file in uploads, which each site in a network always uses. Deleting the plugin drops those tables by name, and on a network removes what it kept for every site. Countries can come from DB-IP's free data, downloaded once a month when turned on. Sending to a Runlight elsewhere is the other choice in its settings. The plugin carries the PHP package at `vendor/runlight/runlight`, as Composer lays it out, leaving out the parts WordPress never runs, so it passes the plugin directory's checks, and running it this way needs PHP 8.2 with the mbstring and openssl extensions and, without MySQL, sqlite3.
- Running inside WordPress, the plugin works out each visitor's address itself and hands it to Runlight, with `trustProxy` off: the connection's address, unless that is this server or a private network, where the nearest public address in `X-Forwarded-For` counts, and Cloudflare's `CF-Connecting-IP` only from Cloudflare's own addresses. The `runlight_client_ip` filter can change it. It hands Runlight the request without the slashes WordPress adds to `$_SERVER`. It offers no SMTP server in Settings, Email service, since an SMTP plugin covers it and Runlight sends through that plugin. It keeps rate counts and the site's icon in WordPress's object cache, or else in transients, where a minute's counts and the day's key take one each, so nothing piles up in `wp_options` even with WordPress's cron off. It downloads, unpacks, and reads the location data through WordPress's HTTP and filesystem APIs. With plain permalinks it answers at `/index.php/runlight`, which works on every server, and its settings page says so, and says when the hourly check has not run for a day. When wp-admin is served from another address than the site, its Runlight page opens the dashboard in a new tab, since only the site's own address may frame it.
- The Drupal module and the Craft plugin run Runlight inside the CMS too: choose that on their setup screen, and the site is counted, with the dashboard at `/runlight` on the site and under Reports, Runlight in Drupal or the Runlight item in Craft's Control Panel, and short links at `/go/<name>`. The numbers go in the CMS's own Postgres, MySQL 8.0.20, or MariaDB 11.4 database, in tables named after its table prefix such as `craft_rl_events` and marked as that site's, unless tables named that way are already there and are not its own, or else in a SQLite file in Drupal's private files or Craft's `storage`, never in public files. Uninstalling drops those tables by name, and only that site's, even when Craft's storage folder is gone. Drupal opens Runlight's connection through its own database driver, so TLS options and `init_commands` apply, and Craft reads the choice from the database, so it holds on every server, and derives Runlight's secret from its security key. Drupal's Administer Runlight permission owns Runlight and a new View Runlight permission reads it; in Craft, admins and a new Manage Runlight permission own it and See Runlight's numbers reads it. Changes to Runlight are taken only from the site's own pages. Each visitor is counted by the address the CMS works out (Drupal's `reverse_proxy` settings, Craft's `trustedHosts` and `ipHeaders`), with `trustProxy` off, rate counts go in the CMS's cache, notes go to its log, and no environment variable is read. Drupal's cron, or Craft's queue or `php craft runlight/check`, runs the hourly check, and the settings say when it has not run for a day. Both need PHP 8.2, and Composer installs the PHP package with them.
- Drupal keeps where Runlight runs, its address, and both keys in state rather than exported configuration, with `settings.php` overrides still winning, and Craft's Connect writes the keys into `.env` and saves the settings as `$RUNLIGHT_AGENTS_KEY` and `$RUNLIGHT_DASHBOARD_KEY`, so no key reaches a repository. Connect in every plugin shows why a Runlight could not be reached, and treats an address with its default port, such as `https://stats.example.com:443`, as the same address.
- The WordPress, Drupal, and Craft plugins connect to a Runlight with a Connect button: enter its address, allow the connection on its consent page, and the plugin saves the site's id, agents key, and dashboard key itself. This works through a new `cms` OAuth scope, whose token is the site's dashboard key and whose answer also carries the site's agents key. When no site counts the plugin's domain, the consent page offers to add one, where sites are managed in the dashboard.
- A `cms` option on the routes names the CMS that adds the script, such as WordPress, when Runlight runs inside one. The dashboard then opens on its numbers even before the first visit, in place of the welcome with the steps to add the script, Settings, Install says the plugin adds it, and pages on the same origin, the CMS's admin, may show the whole dashboard in a frame. Framed there, every button that opens a modal, sheet, or drawer, such as settings, the assistant, live visitors, a box's full list, map, or journeys, and a link's or goal's report, opens the dashboard in a new tab with it open, on the same site, range, and filters, where there is more room. Filters still open in the frame.
- Settings, Install has a WordPress, Drupal, and Craft section listing every setting the plugins ask for, under the names they use, each with a copy button.
- `mail` can be a mailer of the app's own, `{ send, from, fromName, via }` (in PHP, `send` is a callable taking the message array), such as a CMS's. Unlike a service in code, it is a default: Settings, Email service says reports are sent through it, with a button to use another service instead, and a service saved there takes its place until it is removed. Reports, test emails, invites, and sign-in links go through it, and `GET /api/mail` answers `source: "app"` with an `app` object (`via`, `from`, `fromName`, `replaced`) whenever the app has one. Every language takes it. Go and Rust take it as a field of its own, `AppMailer` and `app_mailer`, and Ruby and Elixir name the sender `from_name`.
- Running inside WordPress, Drupal, or Craft, Runlight sends email through the CMS's own mailer when one is set up: with wp_mail when an SMTP or mail plugin such as WP Mail SMTP or FluentSMTP is active, through Drupal's mail manager when its mailer is not plain PHP `mail()`, or through Craft's mailer when its transport is not Sendmail. Without one, the dashboard asks for a mail service as before.
- A `mailServices` option lists the mail services Settings offers and saves, such as every one but SMTP; `GET /api/mail` lists only those, saving another is refused with `mail_service`, and a service saved earlier that is not in the list counts as none, so the app's mailer sends instead. Every service by default. Every language takes it, as `mail_services` in Python, Ruby, Elixir, and Rust and `MailServices` in Go and .NET.
- PHP: a `cache` option takes a `Runlight\Cache` of the app's own for the small values requests share (rate counts and their daily key, the site's icon, and the once-a-day proxy warning) in place of APCu and files, and `Server\DbIp` takes a `DbIpFiles` that works its folder, so a CMS can keep both in its own storage. PHP's file functions and curl, the defaults, moved to `Scratch`, `MmdbFile`, and `Server\DbIpDisk`, and SMTP's client is loaded only for SMTP.
- Every store, in every language, takes a table prefix in place of `rl_` (`prefix`, or the language's spelling: Go's `Prefixed()` and `NewStoreWithPrefix()`, Rust's `*_with_prefix()` functions, and Java's `prefix` overloads), so two apps sharing a database each keep their own tables, and a store's `tables()` lists them by name. The prefix is up to 32 letters, digits, and underscores, not starting with a digit.
- PHP: a store takes a table prefix in place of `rl_`, as `prefix` in the options of `Stores::sqlite()`, `postgres()`, and `mysql()`, or the second argument of `new SqlStore()` and `Stores::fromDb()`, so two apps sharing a database each keep their own tables, as the WordPress plugin does with WordPress's prefix. Every table and index name, schema check, and upgrade follows it, and `SqlStore::tables()` lists the tables by name for an app removing Runlight. Without one, every name is `rl_` as before.
- PHP: `Runlight\Cms\Connect` is the half of a CMS plugin's Connect button that every plugin shares (the OAuth metadata, the endpoint check, registration, PKCE, the consent page's address, and the token swap), given the CMS's own HTTP client as a Fetcher and its words for each outcome, and `Runlight\Cms\Frame` is the script for the dashboard's frame on an admin page, told the admin's bars by data attributes. The WordPress, Drupal, and Craft plugins use both.
- PHP: `Runlight\Log::to()` sends Runlight's notes, such as a report that could not be sent, somewhere of the app's own in place of PHP's error log, and `Request::fromServer()` reads a request from an array shaped like `$_SERVER`, such as a CMS's unslashed copy of it. `Request::fromGlobals()` reads the superglobals as before.

### Changed

- A short link nobody has on the app's own host is the app's to answer, in every language: middleware hands the request on to the app, and a handler the app routes the link path to answers with the framework's own not found where there is one (chi's NotFound handler, Echo's `ErrNotFound`, Phoenix's `NoRouteError` from `Runlight.Plug.Links`, and a bare 404 from ASP.NET Core's endpoint, for the app's status code pages), so the app's own 404 page shows. A front controller and the standalone server, with no app behind them, still answer the 404 themselves.
- Go: `runlightchi.Mount` after the app's own routes panics with the way to fix it, since chi takes no middleware after a route and a link domain's links then answered only on paths the app does not route. `runlightchi.MountRoutes` adds everything but the link domains, for an app that wraps its router with `rl.LinkDomains`. `LinksHTTP` answers link domains first, and `LinksHTTPOr` hands a slug no link has to a handler of the app's.
- The key for CMS plugins is now called the agents key, and the key for the dashboard in a CMS the dashboard key, in Runlight and in every plugin. The plugins' Observe key field is now Agents key.
- Runlight's tables need MySQL 8.0.20 or later, rather than 8.4, in every language and in the WordPress, Drupal, and Craft plugins, and CI runs the tests on MySQL 8.0 as well. MariaDB still needs 11.4.
- The dashboard key's help says that whoever holds it can read the site's dashboard, so it is kept like a password.
- Ignoring your own visits moved from Settings, Install to Settings, General.
- The WordPress plugin's Runlight menu item sits below the core admin items instead of near the top, as the plugin directory asks.
- In the WordPress, Drupal, and Craft admin, the dashboard's frame grows to the dashboard's full height, so the admin page scrolls like any other instead of the dashboard scrolling inside a frame the size of the window. The dashboard tells the page its height, and the page tells it which part of the frame is on screen, so the filter drawer and other sheets open over that part. A plugin keeps fitting the frame to the window for a Runlight too old to say its height.

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

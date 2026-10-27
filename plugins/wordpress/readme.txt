=== Runlight ===
Contributors: joncphillips
Tags: analytics, privacy, statistics, ai, cookieless
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 8.1
Stable tag: 0.3.2
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Privacy friendly analytics with no cookies, kept in your own database. Counts visitors and the AI agents that read your site, right inside WordPress.

== Description ==

[Runlight](https://runlight.sh/) is open source web analytics that keeps every number in your own database. It counts visitors, pages, sources, places, devices, campaigns, and conversions without cookies and without keeping anything that could say who a visitor was. It sets no cookies and stores nothing on the visitor's device.

Activate the plugin and choose to run Runlight inside WordPress, with nothing else to set up:

* It adds Runlight's script (under 2 KB gzipped) to every page, and marks 404 pages so broken links show up.
* It leaves out administrators' own visits, if you want.
* It records AI agents such as ChatGPT, Claude, and Perplexity when they fetch your pages to answer someone's question. They run no JavaScript, so no script can see them; the plugin records them on the server, after the page has been sent.
* The Runlight item in the admin menu shows this site's numbers in wp-admin, and the full dashboard opens at /runlight on your site, for anyone who can manage options.
* Goals, funnels, short links, email reports, and imports from Umami, Bitly, and other services are all in the dashboard.

The numbers stay in this site's database: in Runlight's own tables, named after WordPress's table prefix (such as wp_runlight_events), when the database is MySQL 8.0.20 or MariaDB 11.4 or later, or else in a SQLite file in the uploads folder. Each site in a network keeps a SQLite file of its own.

If you already run Runlight elsewhere, as the standalone server or inside an app, the plugin can send to that one instead. Press Connect in its settings and that Runlight fills them in, so one dashboard covers all your sites.

= Privacy =

The script sets no cookies and stores nothing in the visitor's browser. Runlight counts a visitor with a hash of a daily salt, your site, their IP address, and their user agent; the address and the user agent are never stored, and the salt is deleted within four days.

= Source code =

The plugin bundles Runlight's own PHP package, runlight/runlight (MIT), at vendor/runlight/runlight, as Composer lays it out, with its built scripts in vendor/runlight/runlight/assets. Their source, and the tools that build them, are at [github.com/runlightsh/runlight](https://github.com/runlightsh/runlight):

* vendor/runlight/runlight/src is the PHP package itself, from packages/php.
* vendor/runlight/runlight/assets/dashboard.js and dashboard.css are the dashboard, built from packages/dashboard.
* vendor/runlight/runlight/assets/tracker.js, picker.js, and pick-return.js are the tracking script, the goal picker, and the picker's relay page, built from packages/tracker.
* vendor/runlight/runlight/assets/world.json is the dashboard's world map: Natural Earth's 1:110m countries (public domain), by way of the world-atlas package, projected by packages/dashboard/scripts/world.mjs.
* composer.json names the package, as Composer would install it into vendor.
* The plugin's own assets/settings.js, assets/frame.js, and assets/dashboard.js are its source, not built.

Running npm install and then npm run build at the top of the repository builds every one of them and copies them into packages/php/assets.

== Installation ==

1. Install and activate the plugin. It opens its setup screen, and nothing is counted until you choose.
2. Press "Run Runlight in this WordPress". Runlight starts counting this site.
3. Open Runlight in the admin menu to see the numbers, or open /runlight on your site for the full dashboard.

To send to a Runlight you run elsewhere instead, choose "Connect to a Runlight you run elsewhere" on the setup screen, enter its address, and press Connect. That Runlight asks you to allow the connection for the site that counts this domain, or offers to add one when its sites are managed in its dashboard, as on the standalone server, and then sends you back with every setting filled in. Connecting needs wp-admin on https. You can also copy the settings by hand from that Runlight's Settings, Install, where they have the same names: Runlight address, Site id, Agents key, and Dashboard key.

Running Runlight inside WordPress needs PHP 8.2 or later with the mbstring and openssl extensions, and either WordPress's database on MySQL 8.0.20 or MariaDB 11.4 or later, which Runlight reaches through WordPress's own connection, or else PHP's sqlite3 extension. Each site in a network always uses a SQLite file, so a network needs sqlite3. The settings page says when something is missing.

With plain permalinks, Runlight answers at /index.php/runlight rather than /runlight, so it works on every server, and the settings page says so.

== Frequently Asked Questions ==

= Does this send my visitors' data to a third party? =

No. Visits are counted in your own WordPress, or in the Runlight you chose, and nowhere else. Only if you add an AI provider's key and ask the assistant a question do the site's totals go to that provider, as External services describes.

= Does Runlight set cookies? =

No. It sets no cookies and stores nothing on the visitor's device. Whether your site needs a consent notice depends on everything else it runs and on where you and your visitors are, so check what applies to your site.

= Where are the numbers? =

In this site's database, unless you chose a Runlight you run elsewhere. The Runlight item in the admin menu shows them, and its Open in Runlight button opens the full dashboard.

= What happens when I delete the plugin? =

Deleting it removes its settings and, when Runlight ran inside WordPress, all of Runlight's numbers: its own tables, each by name, or its folder in uploads. On a network it does this for every site. Deactivating it keeps everything.

= Does it work with page caches? =

Yes. Cached pages still carry the script, so visits are counted. AI agents that fetch a page a cache answers without running WordPress are not recorded.

== External services ==

Running inside WordPress, Runlight fetches one thing on its own: your site's icon. When you open the dashboard, it shows the icon your site's home page links to, which Runlight fetches from your site, or from wherever that link points, sending nothing with the request.

Beyond that, it sends nothing anywhere until you set something up that needs another service. Each of these is off until you turn it on, and each is described where you turn it on.

* Locations: with "Show which countries visitors come from" on, the plugin downloads DB-IP's free country database from download.db-ip.com once a month and keeps it in its folder in uploads. Nothing is sent with the download, and visitors' addresses are looked up on your server and never sent. DB-IP's data is under CC BY 4.0 (https://db-ip.com/db/lite.php). Terms: https://db-ip.com/tos.php. Privacy: https://db-ip.com/privacy.php.

Email reports: when an SMTP or mail plugin such as WP Mail SMTP is active in WordPress, Runlight sends the reports you ask for, and test emails, with wp_mail, so they go wherever that plugin sends your site's other email. Otherwise, or when you choose one in the dashboard instead, it sends them through the mail service you set up there, with the key you enter. A report holds the site's totals for the week or month, and it is sent to the addresses you list, from the address you set, only when a report is due or you send a test. To send through an SMTP server, set it up in an SMTP plugin, which Runlight then uses. The services:

* Amazon SES (email.<region>.amazonaws.com). Terms: https://aws.amazon.com/service-terms/. Privacy: https://aws.amazon.com/privacy/.
* Brevo (api.brevo.com). Terms: https://www.brevo.com/legal/termsofuse/. Privacy: https://www.brevo.com/legal/privacypolicy/.
* MailerSend (api.mailersend.com). Terms: https://www.mailersend.com/legal/terms-of-service. Privacy: https://www.mailersend.com/legal/privacy-policy.
* Mailgun (api.mailgun.net or api.eu.mailgun.net). Terms: https://www.mailgun.com/legal/terms/. Privacy: https://www.mailgun.com/legal/privacy-policy/.
* Mailjet (api.mailjet.com). Terms: https://www.mailjet.com/legal/terms/. Privacy: https://www.mailjet.com/legal/privacy-policy/.
* Postmark (api.postmarkapp.com). Terms: https://postmarkapp.com/terms-of-service. Privacy: https://postmarkapp.com/privacy-policy.
* Resend (api.resend.com). Terms: https://resend.com/legal/terms-of-service. Privacy: https://resend.com/legal/privacy-policy.
* SendGrid (api.sendgrid.com), part of Twilio. Terms: https://www.twilio.com/en-us/legal/tos. Privacy: https://www.twilio.com/en-us/legal/privacy.
* SparkPost (api.sparkpost.com or api.eu.sparkpost.com). Terms: https://www.sparkpost.com/policies/tou/. Privacy: https://www.sparkpost.com/policies/privacy/.
* A webhook: the email goes to the address you enter, which is yours, so its terms are your own.

The assistant: when you set up an AI provider in the dashboard, each question you ask the assistant goes to that provider, with the site's totals and lists it needs to answer it, such as pages, sources, or countries with their counts, and only when you ask. Runlight keeps no IP address or user agent, so none is ever sent. The providers:

* Anthropic (api.anthropic.com). Terms: https://www.anthropic.com/legal/commercial-terms. Privacy: https://www.anthropic.com/legal/privacy.
* OpenAI (api.openai.com). Terms: https://openai.com/policies/services-agreement/. Privacy: https://openai.com/policies/privacy-policy/.
* Google Gemini (generativelanguage.googleapis.com). Terms: https://ai.google.dev/gemini-api/terms. Privacy: https://policies.google.com/privacy.
* OpenRouter (openrouter.ai), which passes the question to the model you pick. Terms: https://openrouter.ai/terms. Privacy: https://openrouter.ai/privacy.
* Ollama and LM Studio run a model on a computer you choose, this server by default (localhost), so the question goes only to the address you enter. Ollama's terms: https://ollama.com/terms, and privacy: https://ollama.com/privacy. LM Studio's terms: https://lmstudio.ai/app-terms, and privacy: https://lmstudio.ai/app-privacy.
* Another OpenAI-compatible service: the question goes to the address you enter, under that service's own terms and privacy policy.

Imports: when you import from one of these in the dashboard, Runlight reads your links, or your visits for Umami, from that service with the key or sign-in you enter, once, and sends nothing else:

* Umami: the address you enter, your own Umami or Umami Cloud. Umami Cloud's terms: https://umami.is/terms, and privacy: https://umami.is/privacy.
* Bitly (api-ssl.bitly.com). Terms: https://bitly.com/pages/terms-of-service. Privacy: https://bitly.com/pages/privacy.
* Dub (api.dub.co). Terms: https://dub.co/legal/terms. Privacy: https://dub.co/legal/privacy.
* Rebrandly (api.rebrandly.com). Terms: https://www.rebrandly.com/terms-conditions. Privacy: https://www.rebrandly.com/privacy-policy.
* Short.io (api.short.io and statistics.short.io). Terms: https://short.io/terms. Privacy: https://short.io/privacy.

Other Runlight installs and link domains, only when you set them up in the dashboard:

* Other installs: when you add another Runlight install to the dashboard, to see its sites beside this one's, Runlight sends the API token you enter, or one you allow on that install's own consent page, to the address you enter, and from then on reads that install's site list and numbers from it with that token while you look at them. Removing the install asks it to delete the token. That install is yours, so its terms are your own.
* Short link domains: when you add a custom domain for short links, Runlight checks it by fetching https://<your domain>/.well-known/runlight-link-domain, a file on that domain, and sends nothing with the request. The domain is yours, so its terms are your own.

Sending to a Runlight you run elsewhere, the plugin talks to that Runlight alone, at the address you enter. You run it yourself, so its terms are your own; Runlight is open source software under the MIT licence, and runlight.sh's terms and privacy policy are at https://runlight.sh/terms/ and https://runlight.sh/privacy/.

* Every page loads Runlight's script from that address. In the visitor's browser, the script sends the page's address, the referring page, the screen size, the browser's language, the page's title, how long it was read, and how far down it was scrolled, with any events you set up. Runlight uses the visitor's IP address and user agent to work out a daily visitor count and never stores them.
* When an AI agent such as ChatGPT or Claude fetches a page and you have entered an agents key, the plugin sends that page's address and the agent's user agent to the same Runlight, from your server.
* When an administrator opens the settings page, or saves it, the plugin asks that address whether it answers as Runlight, to tell you whether it is connected.
* When an administrator presses Connect, the plugin asks that address for its OAuth details and registers this site with it, sending the site's host and the wp-admin address to come back to. The administrator then allows the connection on that Runlight's own page, and on the way back the plugin sends the one-time code it was given and gets this site's id, agents key, and dashboard key, which it saves in its setting.
* When an administrator opens the Runlight page in wp-admin and you have entered a dashboard key, the plugin sends that key and the address wp-admin is served from (its scheme, host, and port) to the same Runlight, from your server, and gets back a ticket that opens the dashboard once. The page then loads the dashboard from that Runlight in a frame, in the administrator's browser.

== Changelog ==

= 0.3.2 =
* Maintenance release with updated dependencies. Nothing changes in how the plugin works.

= 0.3.1 =
* Fixed the Connect button, which stopped with an error before reaching your Runlight. The address it sends you back to now carries a WordPress nonce too.
* Changes made in the dashboard at /runlight, and on its consent page for AI apps, now need a WordPress nonce and must come from your site's own pages.
* Renamed Runlight's tables from wp_rl_ to wp_runlight_ (after your table prefix). Existing tables and their indexes are renamed the first time the new version runs.
* Every value in Runlight's SQL now goes through $wpdb->prepare(), its script is added with wp_enqueue_script(), and its files are written through WordPress's filesystem API.
* Email reports draw the Runlight logo in HTML instead of loading an image from runlight.sh.

= 0.3.0 =
* Updated the bundled Runlight library to 0.3.0. Outbound link and File download events keep the link without its query string or fragment, and a funnel over more than 100,000 visits counts the newest 100,000.
* Fixed a hit tried again after the database was busy counting twice in its visit.
* Refused more IPv6 forms of private addresses where a fetch must reach the public internet.

= 0.2.0 =
* Released with Runlight 0.2.0, whose new ClickHouse support is for the standalone server. Nothing in the plugin changed.

= 0.1.8 =
* Fixed share links and embedded dashboards when the plugin runs Runlight itself. Since 0.1.7 everyone but a signed-in admin was refused.
* Wrote database values to suit a MySQL server set to NO_BACKSLASH_ESCAPES, reading the mode from WordPress's own connection.
* Honoured the X-Forwarded-Proto header behind a proxy.
* Updated the bundled Runlight library to 0.1.8, with shorter-lived daily salts, stronger password hashing, faster reports on big sites, and dashboard accessibility fixes.

= 0.1.7 =
* Sanitized and validated request fields before passing them to Runlight.
* Loaded dashboard and settings scripts from files with WordPress-encoded settings.
* Sanitized the connection address directly when reading the submitted form.

= 0.1.6 =
* Updated the bundled Runlight library to 0.1.6. Includes the dashboard, account-security, and database migration improvements from 0.1.5.

= 0.1.5 =
* Updated the bundled Runlight library to 0.1.5.
* Improved dashboard loading states, Campaigns tabs, and the Goals and Funnels shortcuts.
* Clarified server-side AI agent reporting in the dashboard.
* Fixed account migrations when reopening databases with custom table prefixes.
* Improved account security and site-scoped access in the bundled library.

= 0.1.4 =
* Released with Runlight 0.1.4.

= 0.1.3 =
* Changing a site in Runlight's dashboard checks every field before it changes anything, so a change refused for a bad or taken domain no longer shortens how long visits are kept or deletes older ones.
* A mail service, mail webhook, or AI assistant that redirects to another address is refused before anything is sent there, so its key and the message never leave for a server you didn't choose.
* Those requests connect to the address Runlight checked, so a name that changes between the check and the connection can't lead them to a cloud metadata address.
* The AI assistant's limits hold when questions are sent all at once, so a viewer can't go past the daily limit.
* Behind Cloudflare, countries still come from Cloudflare's headers, now only for requests that came through Cloudflare's own addresses.
* Answers from AI models, mail services, and link domains are read only up to a sensible size.
* A chart over a long range with an interval too fine for it moves up to the next interval that fits, instead of lumping the rest of the range into its last point.

= 0.1.2 =
* Runlight can run inside WordPress. Choose it on the setup screen and the site is counted, with the dashboard in wp-admin and at /runlight on the site, and the numbers in WordPress's database, in tables named after its prefix such as wp_rl_events, or in a SQLite file in uploads. It needs PHP 8.2.
* Running inside WordPress, Runlight counts each visitor by the address the connection came from, and believes X-Forwarded-For only from a proxy on this server or a private network, and Cloudflare's header only from Cloudflare. The runlight_client_ip filter can change it.
* Countries can come from DB-IP's free data, downloaded once a month when you turn it on.
* Email reports go through wp_mail when an SMTP or mail plugin is active.
* A Connect button fills in the site id, agents key, and dashboard key from a Runlight you run elsewhere, once you enter its address, and says why when it cannot reach it.
* The observe key is now called the agents key.
* The dashboard in wp-admin grows to its full height, and the Runlight menu item sits below the core items.
* Deleting the plugin on a network removes what it kept for every site, and drops only Runlight's own tables, each by name.

= 0.1.1 =
* AI agents are reported after the page has been sent, so they never wait on Runlight, and sites in a subfolder report the right address.
* The settings page checks the Runlight address after it loads.
* On a network, only network admins can change the Runlight address.

= 0.1.0 =
* First release: the script, administrators left out, 404s marked, AI agents reported, and the dashboard in wp-admin.

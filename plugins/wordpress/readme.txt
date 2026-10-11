=== Runlight ===
Contributors: joncphillips
Tags: analytics, privacy, statistics, ai, cookieless
Requires at least: 6.3
Tested up to: 7.1
Requires PHP: 8.1
Stable tag: 0.1.1
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Privacy friendly analytics with no cookies, kept in your own database. Counts visitors and the AI agents that read your site, right inside WordPress.

== Description ==

[Runlight](https://runlight.sh/) is open source web analytics that keeps every number in your own database. It counts visitors, pages, sources, places, devices, campaigns, and conversions without cookies and without keeping anything that could say who a visitor was, so there is no cookie banner to add.

Activate the plugin and choose to run Runlight inside WordPress, with nothing else to set up:

* It adds Runlight's script (under 2 KB gzipped) to every page, and marks 404 pages so broken links show up.
* It leaves out administrators' own visits, if you want.
* It records AI agents such as ChatGPT, Claude, and Perplexity when they fetch your pages to answer someone's question. They run no JavaScript, so no script can see them; the plugin records them on the server, after the page has been sent.
* The Runlight item in the admin menu shows this site's numbers in wp-admin, and the full dashboard opens at /runlight on your site, for anyone who can manage options.
* Goals, funnels, short links, email reports, and imports from Umami, Bitly, and other services are all in the dashboard.

The numbers stay in this site's database: in Runlight's own tables when the database is MySQL 8.4 or MariaDB 11.4 or later, or else in a SQLite file in the uploads folder.

If you already run Runlight elsewhere, as the standalone server or inside an app, the plugin can send to that one instead. Press Connect in its settings and that Runlight fills them in, so one dashboard covers all your sites.

= Privacy =

The script sets no cookies and stores nothing in the visitor's browser. Runlight counts a visitor with a hash of a daily salt, your site, their IP address, and their user agent; the address and the user agent are never stored, and the salt is deleted after a day.

= Source code =

The plugin carries Runlight's PHP package in its lib folder, with the dashboard's built script. Their source, and the tools that build them, are at [github.com/runlightsh/runlight](https://github.com/runlightsh/runlight), under packages/php and packages/dashboard.

== Installation ==

1. Install and activate the plugin. It opens its setup screen, and nothing is counted until you choose.
2. Press "Run Runlight in this WordPress". Runlight starts counting this site.
3. Open Runlight in the admin menu to see the numbers, or open /runlight on your site for the full dashboard.

To send to a Runlight you run elsewhere instead, choose "Connect to a Runlight you run elsewhere" on the setup screen, enter its address, and press Connect. That Runlight asks you to allow the connection for the site that counts this domain, or offers to add one, and then sends you back with every setting filled in. Connecting needs wp-admin on https. You can also copy the settings by hand from that Runlight's Settings, Install, where they have the same names: Runlight address, Site id, Agents key, and Dashboard key.

Running Runlight inside WordPress needs PHP 8.2 or later with the pdo, mbstring, and openssl extensions, and either pdo_sqlite or a MySQL 8.4 or MariaDB 11.4 database with pdo_mysql. The settings page says when something is missing.

== Frequently Asked Questions ==

= Does this send my visitors' data to a third party? =

No. Runlight runs in your own WordPress, or in the Runlight you chose, and nowhere else.

= Do I need a cookie banner? =

Not for Runlight: it sets no cookies and stores nothing on the visitor's device.

= Where are the numbers? =

In this site's database, unless you chose a Runlight you run elsewhere. The Runlight item in the admin menu shows them, and its Open in Runlight button opens the full dashboard.

= What happens when I delete the plugin? =

Deleting it removes its settings and, when Runlight ran inside WordPress, all of Runlight's numbers: its tables, or its folder in uploads. Deactivating it keeps everything.

= Does it work with page caches? =

Yes. Cached pages still carry the script, so visits are counted. AI agents that fetch a page a cache answers without running WordPress are not recorded.

== External services ==

Running inside WordPress, Runlight sends nothing anywhere until you set something up that needs another service. Each of these is off until you turn it on, and each is described where you turn it on:

* Locations: with "Show which countries visitors come from" on, the plugin downloads DB-IP's free country database from download.db-ip.com once a month. Visitors' addresses are looked up on your server and never sent. DB-IP's data is under CC BY 4.0 (https://db-ip.com/db/lite.php), and its terms and privacy policy are at https://db-ip.com/terms-of-use and https://db-ip.com/privacy.
* Email reports: when an SMTP or mail plugin such as WP Mail SMTP is set up in WordPress, Runlight sends the reports you ask for with wp_mail, so they go wherever that plugin sends your site's other email. Otherwise, or when you choose one in the dashboard instead, it sends them through the mail service you set up there: an SMTP server you name, or the API of Amazon SES, Brevo, Mailersend, Mailgun, Mailjet, Postmark, Resend, or SendGrid, with the key you enter. A report holds the site's numbers and goes to the addresses you list.
* The assistant: when you add an AI provider's key in the dashboard, questions you ask the assistant go to that provider (Anthropic, OpenAI, Google Gemini, or OpenRouter) with the numbers needed to answer them, and only when you ask.
* Imports: when you import from Umami, Bitly, Dub, Rebrandly, or Short.io in the dashboard, Runlight reads your data there with the key you enter, once.
* Your site's icon: the dashboard shows the icon your site's home page links to, which Runlight fetches from your own site.

Sending to a Runlight you run elsewhere, the plugin talks to that Runlight alone, at the address you enter. You run it yourself, so its terms are your own; Runlight is open source software under the MIT licence, and runlight.sh's terms and privacy policy are at https://runlight.sh/terms/ and https://runlight.sh/privacy/.

* Every page loads Runlight's script from that address. In the visitor's browser, the script sends the page's address, the referring page, the screen size, the browser's language, the page's title, how long it was read, and how far down it was scrolled, with any events you set up. Runlight uses the visitor's IP address and user agent to work out a daily visitor count and never stores them.
* When an AI agent such as ChatGPT or Claude fetches a page and you have entered an agents key, the plugin sends that page's address and the agent's user agent to the same Runlight, from your server.
* When an administrator opens the settings page, or saves it, the plugin asks that address whether it answers as Runlight, to tell you whether it is connected.
* When an administrator presses Connect, the plugin asks that address for its OAuth details and registers this site with it, sending the site's host and the wp-admin address to come back to. The administrator then allows the connection on that Runlight's own page, and on the way back the plugin sends the one-time code it was given and gets this site's id, agents key, and dashboard key, which it saves in its setting.
* When an administrator opens the Runlight page in wp-admin and you have entered a dashboard key, the plugin sends that key and the address wp-admin is served from (its scheme, host, and port) to the same Runlight, from your server, and gets back a ticket that opens the dashboard once. The page then loads the dashboard from that Runlight in a frame, in the administrator's browser.

== Changelog ==

= 0.1.1 =
* AI agents are reported after the page has been sent, so they never wait on Runlight, and sites in a subfolder report the right address.
* The settings page checks the Runlight address after it loads.
* On a network, only network admins can change the Runlight address.

= 0.1.0 =
* First release: the script, administrators left out, 404s marked, AI agents reported, and the dashboard in wp-admin.

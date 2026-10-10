# Release Notes for Runlight

## Unreleased

### Changed
- Typed keys are hidden like passwords in the settings, while keys that name an environment variable still show.
- The dashboard is framed for the Control Panel's own address, so it works behind a proxy that ends HTTPS.

## 0.1.0 - 2026-10-10

### Added
- The plugin adds Runlight's script to every front-end page and marks 404 pages.
- Control Panel users' own visits can be left out of the count, and the pages they see without the script are kept out of Blitz and other caches.
- AI agents such as ChatGPT and Claude that fetch your pages are reported to Runlight after the page has been sent, and under PHP-FPM or LiteSpeed after the connection has closed, so they never wait on it there.
- The address, site id, and keys may each name an environment variable, and saved keys are cleared when the Runlight address changes, so they are never sent to another server.
- A Runlight item in the Control Panel shows the site's dashboard, read-only, once a dashboard key is set, with a link to open it in your Runlight.

# runlight

Runlight is privacy friendly web analytics that runs inside your own Python app. It counts visitors without cookies and without storing anyone’s IP address. The numbers stay in your database, and the dashboard is served from your domain at `/runlight`.

This package is the Python version of [Runlight](https://runlight.sh). It works in Django, Flask, FastAPI, or any WSGI or ASGI app on Python 3.11 or later, and it can also run on its own domain as a standalone server. It answers every request the way the TypeScript library does and uses the same tables, so either one can read the other’s database.

## Get started

Install it with pip.

```bash
pip install runlight
```

SQLite comes with Python. For Postgres, install `runlight[postgres]`, and for MySQL or MariaDB, `runlight[mysql]`. On Windows, add the `tzdata` extra for time zones.

Create one instance for your app.

```python
from runlight import Runlight
from runlight.store import Stores

rl = Runlight(
    store=Stores.sqlite("data/runlight.db"),
    site={"name": "example.com", "hostnames": ["example.com"], "timezone": "Europe/London"},
)
```

Runlight reads the visitor's address from `X-Forwarded-For` and similar headers only when the request comes from this computer or a private network, where proxies and load balancers connect from, so a visitor who reaches your app straight from the internet cannot pick their own address. Behind a CDN that connects from public addresses, such as Cloudflare in front of your server, add `trust_proxy="cf-connecting-ip"` (the header it sets) or `trust_proxy=True`. Runlight logs a warning once when a public address sends forwarding headers that the default did not believe. `trust_proxy=False` never reads them.

Put it in front of your app. In Flask that is one line.

```python
import runlight.flask

runlight.flask.init_app(app, rl)
```

Add the script to every page, just before `</head>`.

```html
<script defer src="/runlight/s.js"></script>
```

Set `RUNLIGHT_TOKEN` to a long random string, then open `/runlight/?token=` followed by that string to sign in.

A `token` passed to `rl.routes()` works the same way. `None` counts as not given, so `os.environ.get()` of a variable that is not set falls back to `RUNLIGHT_TOKEN` and never opens the dashboard. To leave it open on purpose, behind your own sign-in, pass `token=runlight.OPEN`.

The [Python guide](https://runlight.sh/docs/python/) has the code for Django, FastAPI, and plain WSGI or ASGI apps, the Postgres, MySQL, and MariaDB stores, the scheduled check, and the standalone server.

## Slow request bodies

A client that sends a request body slowly, or says how long it is and then stops, is given up on wherever Runlight reads the body: after a minute in all the answer is 408 and the connection is closed.

- The standalone server (`runlight`) reads every request on one thread before it gets a worker, so a slow body never takes one. The head has 10 seconds; the body then has 60 seconds in all and must keep up 8 KB a second after its first 5 seconds. A body with no `Content-Length` is answered 411.
- Under ASGI (FastAPI, Starlette, and any ASGI app through `runlight.asgi`) the minute holds whatever the server does, for Runlight's own paths.
- Under WSGI (Flask, Django, and any WSGI app through `runlight.wsgi`) the minute is checked each time the server hands over a piece of the body. A server whose reads never time out can still be held by a client that stops sending: gunicorn's sync worker ends such a request itself after its `--timeout`, but its gthread and gevent workers, and uWSGI without `socket-timeout` or `harakiri`, do not.
- Django under ASGI reads the whole body before any middleware runs, and your app's own routes read their bodies themselves, so there the limits are the server's.

For the last two, put a proxy that buffers request bodies in front (nginx does by default), or set the server's own timeout.

## License

Runlight is MIT licensed.

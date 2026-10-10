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

If nothing sits in front of your app (no load balancer, CDN, or reverse proxy), add `trust_proxy=False`, so a visitor cannot pick their own address with an `X-Forwarded-For` header. Runlight logs a warning once when it sees requests arrive that way with the default left on.

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

## License

Runlight is MIT licensed.

"""The databases the store and conformance tests run on. See conftest.py."""

from __future__ import annotations

import os
import re
import secrets
import sys
from collections.abc import Callable
from typing import Any

from runlight import db as dbs

PG_URL = "postgres://joncphillips@127.0.0.1:5432/runlight_test_python"
MYSQL_URLS = {
    "mysql": "mysql://root:runlight@127.0.0.1:33084/runlight_test_python",
    "mariadb": "mysql://root:runlight@127.0.0.1:33114/runlight_test_python",
}


def _env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def pg_url() -> str | None:
    value = _env("RUNLIGHT_TEST_PG")
    if value is None:
        return None
    return value if "://" in value else PG_URL


def mysql_urls() -> dict[str, str]:
    value = _env("RUNLIGHT_TEST_MYSQL")
    if value is None:
        return {}
    urls = [u for u in re.split(r"[\s,]+", value) if "://" in u]
    if not urls:
        return dict(MYSQL_URLS)
    return {("mysql" if i == 0 else f"mysql{i}"): url for i, url in enumerate(urls)}


def kinds() -> list[str]:
    """The kinds of database to run on: sqlite always, postgres and the MySQL servers when asked for."""
    out = ["sqlite"]
    if pg_url() is not None:
        out.append("postgres")
    out.extend(mysql_urls())
    return out


# The table prefix the "+prefix" kinds use in place of rl_, as WordPress would give one.
TEST_PREFIX = "wp_rl_"


def store_kinds() -> list[str]:
    """kinds(), and SQLite, Postgres, and the first MySQL server once more with their tables under TEST_PREFIX, as
    the TypeScript tests run each store with a prefix too."""
    out = kinds()
    prefixed = ["sqlite", *(["postgres"] if "postgres" in out else []), *[k for k in out if k.startswith("mysql")][:1]]
    return out + [f"{k}+prefix" for k in prefixed]


class Databases:
    """Fresh, empty databases, dropped by cleanup()."""

    def __init__(self) -> None:
        self._cleanups: list[Callable[[], None]] = []

    def db(self, kind: str) -> Any:
        """A fresh Db of this kind. A "+prefix" kind's tables start with TEST_PREFIX."""
        if kind.endswith("+prefix"):
            return dbs.prefixed(self.db(kind[: -len("+prefix")]), TEST_PREFIX)
        if kind == "sqlite":
            return dbs.sqlite(":memory:")
        if kind == "postgres":
            url = pg_url()
            assert url is not None
            name = "rl_test_" + secrets.token_hex(5)
            admin = dbs.postgres(url)
            admin.run(f'CREATE SCHEMA "{name}"')
            db = dbs.postgres(url, schema=name)

            def drop() -> None:
                db.close()
                admin.run(f'DROP SCHEMA IF EXISTS "{name}" CASCADE')
                admin.close()

            self._cleanups.append(drop)
            return db
        db = dbs.mysql(self._mysql_database(mysql_urls()[kind]))
        self._cleanups.append(db.close)
        return db

    def url(self, kind: str) -> str:
        """The connection URL for a database of this kind (for a test that opens its own connections). For
        Postgres the schema comes in the URL's options."""
        if kind == "postgres":
            url = pg_url()
            assert url is not None
            name = "rl_test_" + secrets.token_hex(5)
            admin = dbs.postgres(url)
            admin.run(f'CREATE SCHEMA "{name}"')

            def drop() -> None:
                admin.run(f'DROP SCHEMA IF EXISTS "{name}" CASCADE')
                admin.close()

            self._cleanups.append(drop)
            sep = "&" if "?" in url else "?"
            return f"{url}{sep}options=-c%20search_path%3D{name}"
        return self._mysql_database(mysql_urls()[kind])

    def _mysql_database(self, url: str) -> str:
        """A database of its own on the server a MySQL URL names, made now and dropped by cleanup(), and the URL
        for it. MySQL has no schemas inside a database, so each test gets a database, as each Postgres test gets a
        schema. Work an earlier test left going on a thread, such as a sweep of sign-in counts by that test's clock,
        then reaches only that test's database, never this one's."""
        name = "rl_test_" + secrets.token_hex(5)
        admin = dbs.mysql(url)
        admin.run(f"CREATE DATABASE `{name}`")

        def drop() -> None:
            admin.run(f"DROP DATABASE IF EXISTS `{name}`")
            admin.close()

        self._cleanups.append(drop)
        return re.sub(r"^([^?]*/)[^/?]*", lambda m: m.group(1) + name, url, count=1)

    def cleanup(self) -> None:
        while self._cleanups:
            fn = self._cleanups.pop()
            try:
                fn()
            except Exception as error:  # pragma: no cover
                print(f"cleanup: {error}", file=sys.stderr)

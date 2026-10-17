"""Keys and the server secret made on first use are made once, however many ask at once (oauth.test.ts and the
server's secret.test.ts, ported)."""

from __future__ import annotations

import stat
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest
from support.databases import store_kinds

from runlight import Runlight
from runlight.oauth import agents_key, open_agents_key
from runlight.server.secret import secret_in
from runlight.store import Stores


@pytest.mark.parametrize("kind", store_kinds())
def test_a_key_made_on_first_use_is_the_same_for_every_request_that_asks_at_once(databases: Any, kind: str) -> None:
    store = Stores.from_db(databases.db(kind))
    store.migrate()
    made = []

    def make() -> str:
        made.append(1)
        return f"key-{len(made)}"

    # Two processes on one database, each making its own key when it finds none.
    with ThreadPoolExecutor(10) as pool:
        keys = list(pool.map(lambda _: store.setting_or_add("embed-key", make), range(10)))
    assert len(set(keys)) == 1, "every caller signs with the one written first"
    assert store.setting("embed-key") == keys[0]
    assert store.add_setting("embed-key", "other") is False
    assert store.swap_setting("embed-key", "not it", "other") is False
    assert store.swap_setting("embed-key", keys[0], "other") is True
    assert store.setting("embed-key") == "other"

    rl = Runlight({"store": store, "site": {"hostnames": ["example.com"]}})
    rl.init()
    with ThreadPoolExecutor(5) as pool:
        agents = list(pool.map(lambda _: agents_key(rl, "default"), range(5)))
    assert len(set(agents)) == 1
    assert open_agents_key(rl, store.setting("observe-key:default")) == agents[0]
    assert agents_key(rl, "default", True) != agents[0], "replacing it still makes a new one"


def _in_process(folder: Path) -> subprocess.Popen[str]:
    code = "import sys; from runlight.server.secret import secret_in; sys.stdout.write(secret_in(sys.argv[1]))"
    return subprocess.Popen([sys.executable, "-I", "-c", code, str(folder)], stdout=subprocess.PIPE, text=True)


def test_servers_starting_at_once_on_one_folder_agree_on_one_secret_kept_readable_only_by_this_user(tmp_path: Path) -> None:
    processes = [_in_process(tmp_path) for _ in range(6)]
    secrets_ = [p.communicate()[0] for p in processes]
    assert len(set(secrets_)) == 1, secrets_
    assert len(secrets_[0]) == 64 and all(c in "0123456789abcdef" for c in secrets_[0])
    assert secret_in(tmp_path) == secrets_[0]
    assert stat.S_IMODE((tmp_path / "secret").stat().st_mode) == 0o600
    assert [p.name for p in tmp_path.iterdir()] == ["secret"], "no file made on the way is left behind"


def test_a_secret_file_read_empty_or_short_is_waited_for_and_refused_rather_than_used(tmp_path: Path) -> None:
    (tmp_path / "secret").write_text("abc\n")
    started = time.monotonic()
    with pytest.raises(RuntimeError, match="holds no whole secret"):
        secret_in(tmp_path)
    assert time.monotonic() - started >= 1, "it waited for a writer to finish first"
    (tmp_path / "secret").write_text("")
    with pytest.raises(RuntimeError, match="holds no whole secret"):
        secret_in(tmp_path)
    own = "a" * 40
    (tmp_path / "secret").write_text(f"{own}\n")
    assert secret_in(tmp_path) == own, "one that is whole is kept as it is"

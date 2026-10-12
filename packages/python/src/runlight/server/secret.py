"""The server's secret, kept in a file in its data folder and made once when servers start together."""

from __future__ import annotations

import os
import secrets
import time
from pathlib import Path

# Shorter than any secret this file has ever been given, so a file caught half written is never used.
SHORTEST = 32


def secret_in(data_dir: str | Path) -> str:
    """The secret kept in `data_dir`, made on first run, readable only by this user. Two servers starting at once
    on one folder agree on it: the new secret is written whole to a file of its own, then linked into place, which
    refuses to replace a file already there, and the one that loses reads the winner's. A file read empty or short,
    such as one an older version was still writing, is read again for a moment, and then refused, never used."""
    folder = Path(data_dir)
    file = folder / "secret"
    found = _read_whole(file)
    if found is not None:
        return found
    made = secrets.token_hex(32)
    temp = folder / f".secret-{os.getpid()}-{secrets.token_hex(6)}"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(f"{made}\n")
    try:
        os.chmod(temp, 0o600)
        try:
            os.link(temp, file)
            return made
        except FileExistsError:
            return _read_whole(file) or _refuse(file)
        except OSError:
            # A file system with no hard links still creates the file only if it is not there; a reader that
            # catches it before its contents land reads it again.
            try:
                fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                return _read_whole(file) or _refuse(file)
            with os.fdopen(fd, "w") as handle:
                handle.write(f"{made}\n")
            os.chmod(file, 0o600)
            return made
    finally:
        try:
            os.unlink(temp)
        except OSError:
            # Gone already.
            pass


def _read_whole(file: Path) -> str | None:
    """The secret in a file, waiting up to two seconds for one too short to be whole; None when there is no file."""
    tries = 0
    while True:
        try:
            text = file.read_text().strip()
        except FileNotFoundError:
            return None
        if len(text) >= SHORTEST:
            return text
        if tries >= 20:
            _refuse(file)
        tries += 1
        time.sleep(0.1)


def _refuse(file: Path) -> str:
    raise RuntimeError(f"{file} holds no whole secret. Delete it to have a new one made, which signs everyone out, or set RUNLIGHT_SECRET.")

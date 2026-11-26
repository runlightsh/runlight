"""The Runlight mark."""

from __future__ import annotations

from typing import Any


def email_logo(home: str) -> str:
    """The mark for emails: the PNG at the sending install's own /logo.png, shown at 48 pixels. Opening an email
    fetches it from that install and from nowhere else; a client that blocks images shows the word Runlight.
    home is the install's address with its base path, such as https://example.com/runlight."""
    src = (home.rstrip("/") + "/logo.png").replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")
    return f'<img src="{src}" width="48" height="48" alt="Runlight" style="display:block;width:48px;height:48px;margin:0 0 24px;border:0;outline:none;text-decoration:none;font:700 16px/48px -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#6b7280">'


def __getattr__(name: str) -> Any:
    if name == "RUNLIGHT_ICON":
        # The Runlight mark for the dashboard's tab: an R in a rounded lamp housing, one corner lit. A data: URL.
        from . import assets

        return str(assets.BUILD["icon"])
    if name == "LOGO_PNG":
        # The mark as a 96 pixel PNG, base64, the same drawing as the website's header and the Mac app's icon. Each
        # install serves it at <base>/logo.png, without signing in, for its emails.
        from . import assets

        return str(assets.BUILD["logoPng"])
    raise AttributeError(name)

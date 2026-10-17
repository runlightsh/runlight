"""The account pages: sign in, the code step, invites, and first-run setup. Everything else is the dashboard.
Each takes the base path the routes answer under: "" on the standalone server, and "/runlight" in an app.
"""

from __future__ import annotations

import re
from typing import Any

from .. import _js
from ..brand import RUNLIGHT_ICON
from ..messages import translator

_ESCAPES = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}
_SPECIAL = re.compile("[&<>\"']")


def _esc(value: str) -> str:
    return _SPECIAL.sub(lambda m: _ESCAPES[m.group(0)], value)


MARK = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="2.5" y="2.5" width="27" height="27" rx="7"/><path d="M11 23V9h6.2a4.3 4.3 0 0 1 0 8.6H11m6 0 5 5.4"/><circle cx="23.6" cy="8.4" r="2.6"/></svg>'

# Light until someone picks otherwise, as in the dashboard, which shares the choice through localStorage.
DARK = "color-scheme: dark; --page: #09090b; --card: #141417; --ink: #fafafa; --muted: #a1a1aa; --line: #27272a; --field: #0c0c0e; --bad: #f87171;"

AUTH_CSS = (
    """:root { color-scheme: light; --page: #f4f4f5; --card: #fff; --ink: #111827; --muted: #6b7280; --line: #e5e7eb; --field: #fff; --bad: #b91c1c; }
:root[data-theme="dark"] { """
    + DARK
    + """ }
@media (prefers-color-scheme: dark) { :root[data-theme="system"] { """
    + DARK
    + """ } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--page); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
main { width: min(400px, 100%); padding: 28px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); }
.brand { display: flex; align-items: center; gap: 9px; margin: 0 0 22px; color: var(--ink); font-weight: 700; font-size: 16px; }
.mark { width: 26px; height: 26px; }
.mark rect { fill: var(--ink); }
.mark path { fill: none; stroke: var(--card); stroke-width: 2.8; stroke-linecap: round; stroke-linejoin: round; }
.mark circle { fill: #22c55e; }
h1 { margin: 0 0 6px; font-size: 21px; }
p { margin: 0 0 18px; color: var(--muted); }
label { display: block; margin: 0 0 14px; font-size: 13px; font-weight: 600; }
input { display: block; width: 100%; height: 40px; margin-top: 6px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--field); color: var(--ink); font: inherit; }
input:focus { outline: 2px solid #2a78d6; outline-offset: -1px; }
main button { width: 100%; height: 40px; margin-top: 6px; border: 0; border-radius: 8px; background: var(--ink); color: var(--card); font: inherit; font-weight: 600; cursor: pointer; }
.error { margin: 0 0 14px; color: var(--bad); font-size: 14px; }
.hint { margin: 16px 0 0; font-size: 13px; }
.hint a { color: var(--ink); }
.theme { position: fixed; right: 16px; bottom: 16px; display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--muted); cursor: pointer; }
.theme:hover { color: var(--ink); }
.theme svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.theme svg:not(.on) { display: none; }
.strength { display: flex; align-items: center; gap: 10px; margin-top: 8px; font-size: 12px; color: var(--muted); }
.strength[hidden] { display: none; }
.strength-bar { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; width: 120px; }
.strength-bar span { height: 4px; border-radius: 2px; background: var(--line); }
.strength[data-score="0"] .strength-label, .strength[data-score="1"] .strength-label { color: var(--bad); }
.strength[data-score="1"] .on { background: var(--bad); }
.strength[data-score="2"] .on { background: #b7791f; }
.strength[data-score="3"] .on, .strength[data-score="4"] .on { background: #22a065; }
.secret { position: relative; display: block; margin-top: 6px; }
.secret input { margin-top: 0; padding-right: 44px; }
.eye { position: absolute; top: 50%; right: 5px; display: grid; place-items: center; width: 32px; height: 30px; margin: 0; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--muted); transform: translateY(-50%); cursor: pointer; }
main .eye { width: 32px; height: 30px; margin: 0; background: none; color: var(--muted); }
.eye:hover, .eye[aria-pressed="true"] { color: var(--ink); }
.eye svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }"""
)

# Applies the saved theme before the page paints, then runs the switch and Cmd+Shift+D (Ctrl+Shift+D).
AUTH_JS = """(() => {
  const COMMON = ["password", "passw0rd", "123456", "qwerty", "azerty", "letmein", "welcome", "admin", "runlight", "iloveyou", "abc123", "monkey", "dragon", "football", "baseball", "sunshine", "princess", "shadow", "master"];
  function strength(password, avoid = []) {
    if (password.length < 10) return 0;
    let pool = 0;
    if (/[a-z]/.test(password)) pool += 26;
    if (/[A-Z]/.test(password)) pool += 26;
    if (/[0-9]/.test(password)) pool += 10;
    if (/[^A-Za-z0-9]/.test(password)) pool += 33;
    // Each character only counts once it adds something new: a pattern repeating ("abab", "Aa1!Aa1!",
    // "aaaa") adds nothing, and a doubled letter or a run like "abc" adds little.
    let effective = 0;
    for (let i = 0; i < password.length; i++) {
      const c = password.charCodeAt(i);
      const prev = password.charCodeAt(i - 1);
      let pattern = false;
      for (let k = 1; k <= 4 && !pattern; k++) pattern = i - 1 - k >= 0 && password[i] === password[i - k] && password[i - 1] === password[i - 1 - k];
      const repeat = i > 0 && c === prev;
      const run = i > 1 && c - prev === prev - password.charCodeAt(i - 2) && Math.abs(c - prev) === 1;
      effective += pattern ? 0 : repeat || run ? 0.25 : 1;
    }
    let bits = effective * Math.log2(Math.max(pool, 10));
    const lower = password.toLowerCase();
    for (const word of [...COMMON, ...avoid.map((a) => a.toLowerCase()).filter((a) => a.length >= 3)]) {
      // Every time it appears, so "jonjonjon" costs three times.
      bits -= (lower.split(word).length - 1) * word.length * 3;
    }
    if (bits < 40) return 1;
    if (bits < 60) return 2;
    if (bits < 80) return 3;
    return 4;
  }
  const KEY = "runlight_theme";
  const root = document.documentElement;
  const read = () => { try { const v = localStorage.getItem(KEY); return v === "dark" || v === "system" ? v : "light"; } catch { return "light"; } };
  const dark = () => { const c = read(); return c === "system" ? matchMedia("(prefers-color-scheme: dark)").matches : c === "dark"; };
  const show = () => {
    const c = read();
    root.dataset.theme = c;
    const button = document.querySelector(".theme");
    if (!button) return;
    for (const icon of button.querySelectorAll("svg")) icon.classList.toggle("on", icon.dataset.choice === c);
    button.title = c === "system" ? "Theme: device setting" : "Theme: " + c;
  };
  const set = (c) => { try { localStorage.setItem(KEY, c); } catch {} show(); };
  show();
  const EYE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>';
  const SHUT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5c1 0 1.9.3 2.7.7M14.5 8s-2.4 4.5-6.5 4.5c-1 0-1.9-.3-2.7-.7M6.6 6.6a2 2 0 0 0 2.8 2.8M2.5 2.5l11 11"/></svg>';
  document.addEventListener("DOMContentLoaded", () => {
    // An eye button in each password field, to show what was typed.
    for (const input of document.querySelectorAll('input[type="password"]')) {
      const wrap = document.createElement("span");
      wrap.className = "secret";
      input.replaceWith(wrap);
      wrap.append(input);
      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "eye";
      const set = (shown) => {
        input.type = shown ? "text" : "password";
        eye.setAttribute("aria-pressed", String(shown));
        eye.setAttribute("aria-label", shown ? "Hide password" : "Show password");
        eye.title = shown ? "Hide password" : "Show password";
        eye.innerHTML = shown ? SHUT : EYE;
      };
      set(false);
      eye.addEventListener("click", () => set(input.type === "password"));
      wrap.append(eye);
    }
    const password = document.querySelector('input[name="password"][autocomplete="new-password"]');
    if (password) {
      const meter = document.createElement("span");
      meter.className = "strength";
      meter.id = "password-strength";
      meter.setAttribute("aria-live", "polite");
      meter.innerHTML = '<span class="strength-bar" aria-hidden="true"><span></span><span></span><span></span><span></span></span><span class="strength-label"></span>';
      password.closest(".secret").after(meter);
      password.setAttribute("aria-describedby", meter.id);
      const email = document.querySelector('input[name="email"]');
      const update = () => {
        const address = email?.value || "";
        const score = strength(password.value, [address, address.split("@")[0]]);
        meter.hidden = !password.value;
        meter.dataset.score = String(score);
        meter.querySelector(".strength-label").textContent = ["Too short", "Weak", "Fair", "Good", "Strong"][score];
        meter.querySelectorAll(".strength-bar span").forEach((bar, i) => bar.classList.toggle("on", score > i));
      };
      password.addEventListener("input", update);
      password.addEventListener("change", update);
      email?.addEventListener("input", update);
      window.addEventListener("pageshow", update);
      update();
    }
    show();
    document.querySelector(".theme")?.addEventListener("click", () => set({ light: "dark", dark: "system", system: "light" }[read()]));
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") { e.preventDefault(); set(dark() ? "light" : "dark"); }
  });
})();"""

def auth_js(lang: str = "en") -> str:
    """AUTH_JS with its words in a language the dashboard speaks. English is served as auth.js, the others as
    auth.js?lang=fr and so on."""
    t, code = translator(lang).t, translator(lang).lang
    if code == "en":
        return AUTH_JS

    def q(key: str) -> str:
        return _js.dumps(t(key))

    def swap(script: str, old: str, new: str) -> str:
        assert old in script, old
        return script.replace(old, new, 1)

    out = swap(
        AUTH_JS,
        'button.title = c === "system" ? "Theme: device setting" : "Theme: " + c;',
        f'button.title = c === "system" ? {q("auth.themeSystem")} : c === "dark" ? {q("auth.themeDark")} : {q("auth.themeLight")};',
    )
    out = swap(
        out,
        'eye.setAttribute("aria-label", shown ? "Hide password" : "Show password");\n        eye.title = shown ? "Hide password" : "Show password";',
        f'eye.setAttribute("aria-label", shown ? {q("auth.hidePassword")} : {q("auth.showPassword")});\n        eye.title = shown ? {q("auth.hidePassword")} : {q("auth.showPassword")};',
    )
    return swap(out, '["Too short", "Weak", "Fair", "Good", "Strong"][score]', f"[{', '.join(q(f'account.strength{n}') for n in range(5))}][score]")


THEME_ICONS = '<svg data-choice="light" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg><svg data-choice="dark" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/></svg><svg data-choice="system" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11.5V14"/></svg>'


def _page(base: str, lang: str, title: str, body: str) -> str:
    t, code = translator(lang).t, translator(lang).lang
    script = "" if code == "en" else f"?lang={code}"
    return f"""<!doctype html>
<html lang="{code}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{_esc(title)} | Runlight</title>
<link rel="icon" href="{RUNLIGHT_ICON}">
<link rel="stylesheet" href="{_esc(base)}/auth.css">
<script src="{_esc(base)}/auth.js{script}"></script>
</head>
<body>
<main>
<p class="brand">{MARK}Runlight</p>
{body}
</main>
<button type="button" class="theme" aria-label="{_esc(t("auth.switchTheme"))}">{THEME_ICONS}</button>
</body>
</html>
"""


def _error(error: Any) -> str:
    return f'<p class="error" role="alert">{_esc(error)}</p>' if error else ""


def login_page(base: str, opts: dict[str, Any], lang: str = "en") -> str:
    """opts: error, email, and next (all optional), and forgot."""
    tr = translator(lang)
    t, html = tr.t, tr.html
    given = opts.get("next")
    nxt = f"{base}/" if given is None else given
    error = _error(opts.get("error"))
    email = _esc(opts.get("email") or "")
    forgot = html("auth.forgot", {"link": f'<a href="{_esc(opts["forgot"])}" target="_blank" rel="noopener">{html("auth.forgotLink")}</a>'})
    return _page(
        base,
        lang,
        t("auth.signIn"),
        f"""<h1>{html("auth.signIn")}</h1>
<p>{html("auth.signInIntro")}</p>
{error}
<form method="post" action="{_esc(base)}/login">
<input type="hidden" name="next" value="{_esc(nxt)}">
<label>{html("auth.email")}<input type="email" name="email" autocomplete="username" required autofocus value="{email}"></label>
<label>{html("auth.password")}<input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">{html("auth.signIn")}</button>
</form>
<p class="hint">{forgot}</p>""",
    )


def code_page(base: str, opts: dict[str, Any], lang: str = "en") -> str:
    """The second step of signing in, for an account with two-factor on. opts: pending, next, and error."""
    tr = translator(lang)
    t, html = tr.t, tr.html
    error = _error(opts.get("error"))
    return _page(
        base,
        lang,
        t("auth.codeTitle"),
        f"""<h1>{html("auth.codeTitle")}</h1>
<p>{html("auth.codeIntro")}</p>
{error}
<form method="post" action="{_esc(base)}/login/code">
<input type="hidden" name="pending" value="{_esc(opts['pending'])}">
<input type="hidden" name="next" value="{_esc(opts['next'])}">
<label>{html("auth.code")}<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required autofocus></label>
<button type="submit">{html("auth.signIn")}</button>
</form>
<p class="hint">{html("auth.codeHint")}</p>""",
    )


def role_text(role: str, site: str | None = None, lang: str = "en") -> str:
    """What someone invited with a role can do, after "as"."""
    t = translator(lang).t
    if site is not None:
        return t("auth.roleViewerSite", {"site": site}) if role == "viewer" else t("auth.roleMemberSite", {"site": site})
    if role == "viewer":
        return t("auth.roleViewer")
    if role == "member":
        return t("auth.roleMember")
    return t("auth.roleAdmin")


def invite_page(base: str, opts: dict[str, Any], lang: str = "en") -> str:
    """Where an invited person chooses a password and joins. opts: code, email, role, host, and error."""
    tr = translator(lang)
    t, html = tr.t, tr.html
    error = _error(opts.get("error"))
    intro = html("auth.joinIntro", {"host": _esc(opts["host"]), "role": _esc(role_text(opts["role"], opts.get("site"), lang))})
    return _page(
        base,
        lang,
        t("auth.joinTitle"),
        f"""<h1>{html("auth.joinTitle")}</h1>
<p>{intro}</p>
{error}
<form method="post" action="{_esc(base)}/invite">
<input type="hidden" name="code" value="{_esc(opts['code'])}">
<label>{html("auth.email")}<input type="email" value="{_esc(opts['email'])}" disabled></label>
<label>{html("auth.password")}<input type="password" name="password" autocomplete="new-password" minlength="10" required autofocus></label>
<label>{html("auth.passwordAgain")}<input type="password" name="again" autocomplete="new-password" minlength="10" required></label>
<button type="submit">{html("auth.join")}</button>
</form>
<p class="hint">{html("auth.passwordHint")}</p>""",
    )


def invite_gone_page(base: str, lang: str = "en") -> str:
    tr = translator(lang)
    t, html = tr.t, tr.html
    return _page(
        base,
        lang,
        t("auth.inviteGoneTitle"),
        f"""<h1>{html("auth.inviteGoneTitle")}</h1>
<p>{html("auth.inviteGone")}</p>""",
    )


def setup_page(base: str, opts: dict[str, Any], lang: str = "en") -> str:
    """opts: code, and optionally error, email, and askCode."""
    tr = translator(lang)
    t, html = tr.t, tr.html
    code = _esc(opts["code"])
    field = (
        f'<label>{html("auth.setupToken")}<input type="password" name="code" autocomplete="off" required value="{code}"></label>'
        if opts.get("askCode")
        else f'<input type="hidden" name="code" value="{code}">'
    )
    error = _error(opts.get("error"))
    email = _esc(opts.get("email") or "")
    return _page(
        base,
        lang,
        t("auth.setupTitle"),
        f"""<h1>{html("auth.setupTitle")}</h1>
<p>{html("auth.setupIntro")}</p>
{error}
<form method="post" action="{_esc(base)}/setup">
{field}
<label>{html("auth.email")}<input type="email" name="email" autocomplete="username" required autofocus value="{email}"></label>
<label>{html("auth.password")}<input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
<label>{html("auth.passwordAgain")}<input type="password" name="again" autocomplete="new-password" minlength="10" required></label>
<button type="submit">{html("auth.createAccount")}</button>
</form>
<p class="hint">{html("auth.passwordHint")}</p>""",
    )


def setup_locked_page(base: str, file: bool = False, lang: str = "en") -> str:
    """For a server with no account yet, which prints a setup link with a one-time code in its log, or, with `file`,
    keeps it in the file setup.txt in its data folder."""
    tr = translator(lang)
    t, html = tr.t, tr.html
    text = html("auth.setupLockedFile", {"command": "<code>runlight setup</code>"}) if file else html("auth.setupLocked")
    return _page(
        base,
        lang,
        t("auth.finishTitle"),
        f"""<h1>{html("auth.finishTitle")}</h1>
<p>{text}</p>""",
    )


def setup_needs_token_page(base: str, lang: str = "en") -> str:
    """For an app with accounts on but nothing to prove the first account with."""
    tr = translator(lang)
    t, html = tr.t, tr.html
    return _page(
        base,
        lang,
        t("auth.finishTitle"),
        f"""<h1>{html("auth.finishTitle")}</h1>
<p>{html("auth.setupNeedsToken")}</p>""",
    )

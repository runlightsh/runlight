<?php

declare(strict_types=1);

namespace Runlight\Accounts;

use Runlight\Json;
use Runlight\Messages;

/**
 * The account pages: sign in, the code step, invites, and first-run setup. Everything else is the dashboard.
 * Each takes the base path the routes answer under: "" on the standalone server, and "/runlight" in an app.
 */
final class Pages
{
    private const MARK = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect x="2.5" y="2.5" width="27" height="27" rx="7"/><path d="M11 23V9h6.2a4.3 4.3 0 0 1 0 8.6H11m6 0 5 5.4"/><circle cx="23.6" cy="8.4" r="2.6"/></svg>';

    // Light until someone picks otherwise, as in the dashboard, which shares the choice through localStorage.
    private const DARK = 'color-scheme: dark; --page: #09090b; --card: #141417; --ink: #fafafa; --muted: #a1a1aa; --line: #27272a; --field: #0c0c0e; --bad: #f87171;';

    public const AUTH_CSS = <<<'CSS'
:root { color-scheme: light; --page: #f4f4f5; --card: #fff; --ink: #111827; --muted: #6b7280; --line: #e5e7eb; --field: #fff; --bad: #b91c1c; }
:root[data-theme="dark"] { 
CSS
        . self::DARK . <<<'CSS'
 }
@media (prefers-color-scheme: dark) { :root[data-theme="system"] { 
CSS
        . self::DARK . <<<'CSS'
 } }
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
.eye svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
CSS;

    /** Applies the saved theme before the page paints, then runs the switch and Cmd+Shift+D (Ctrl+Shift+D). */
    public const AUTH_JS = <<<'JS'
(() => {
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
})();
JS;

    private const THEME_ICONS = '<svg data-choice="light" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg><svg data-choice="dark" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/></svg><svg data-choice="system" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11.5V14"/></svg>';

    private static ?string $icon = null;

    private static function esc(string $value): string
    {
        return strtr($value, ['&' => '&amp;', '<' => '&lt;', '>' => '&gt;', '"' => '&quot;', "'" => '&#39;']);
    }

    /**
     * AUTH_JS with its words in a language the dashboard speaks. English is AUTH_JS itself, served as auth.js; the
     * others come as auth.js?lang=fr and so on, and a language Runlight does not speak is English.
     */
    public static function authJs(string $lang = 'en'): string
    {
        ['t' => $t, 'lang' => $code] = Messages::translator($lang);
        if ($code === 'en') {
            return self::AUTH_JS;
        }
        $q = static fn (string $key): string => Json::encode($t($key));
        $hide = $q('auth.hidePassword');
        $show = $q('auth.showPassword');
        return strtr(self::AUTH_JS, [
            '"Theme: device setting"' => $q('auth.themeSystem'),
            '"Theme: " + c' => 'c === "dark" ? ' . $q('auth.themeDark') . ' : ' . $q('auth.themeLight'),
            'shown ? "Hide password" : "Show password"' => "shown ? $hide : $show",
            '["Too short", "Weak", "Fair", "Good", "Strong"]' => '[' . implode(', ', array_map(static fn (int $n): string => $q("account.strength$n"), [0, 1, 2, 3, 4])) . ']',
        ]);
    }

    /** The Runlight mark for the tab, as the TypeScript's RUNLIGHT_ICON, from the shared assets. */
    private static function icon(): string
    {
        if (self::$icon === null) {
            $build = json_decode((string) file_get_contents(__DIR__ . '/../../assets/build.json'), true);
            self::$icon = (string) ($build['icon'] ?? '');
        }
        return self::$icon;
    }

    private static function page(string $base, string $lang, string $title, string $body): string
    {
        $b = self::esc($base);
        ['t' => $t, 'lang' => $code] = Messages::translator($lang);
        $script = $code === 'en' ? '' : "?lang=$code";
        return "<!doctype html>
<html lang=\"$code\">
<head>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
<meta name=\"robots\" content=\"noindex\">
<title>" . self::esc($title) . " | Runlight</title>
<link rel=\"icon\" href=\"" . self::icon() . "\">
<link rel=\"stylesheet\" href=\"$b/auth.css\">
<script src=\"$b/auth.js$script\"></script>
</head>
<body>
<main>
<p class=\"brand\">" . self::MARK . "Runlight</p>
$body
</main>
<button type=\"button\" class=\"theme\" aria-label=\"" . self::esc($t('auth.switchTheme')) . '">' . self::THEME_ICONS . "</button>
</body>
</html>
";
    }

    private static function error(?string $error): string
    {
        return $error !== null && $error !== '' ? '<p class="error" role="alert">' . self::esc($error) . '</p>' : '';
    }

    /** @param array{error?: string, email?: string, next?: string, forgot: string} $opts */
    public static function loginPage(string $base, array $opts, string $lang = 'en'): string
    {
        $b = self::esc($base);
        ['t' => $t, 'html' => $h] = Messages::translator($lang);
        return self::page(
            $base,
            $lang,
            $t('auth.signIn'),
            '<h1>' . $h('auth.signIn') . '</h1>
<p>' . $h('auth.signInIntro') . '</p>
' . self::error($opts['error'] ?? null) . "
<form method=\"post\" action=\"$b/login\">
<input type=\"hidden\" name=\"next\" value=\"" . self::esc($opts['next'] ?? "$base/") . '">
<label>' . $h('auth.email') . '<input type="email" name="email" autocomplete="username" required autofocus value="' . self::esc($opts['email'] ?? '') . '"></label>
<label>' . $h('auth.password') . '<input type="password" name="password" autocomplete="current-password" required></label>
<button type="submit">' . $h('auth.signIn') . '</button>
</form>
<p class="hint">' . $h('auth.forgot', ['link' => '<a href="' . self::esc($opts['forgot']) . '" target="_blank" rel="noopener">' . $h('auth.forgotLink') . '</a>']) . '</p>',
        );
    }

    /**
     * The second step of signing in, for an account with two-factor on.
     *
     * @param array{pending: string, next: string, error?: string} $opts
     */
    public static function codePage(string $base, array $opts, string $lang = 'en'): string
    {
        $b = self::esc($base);
        ['t' => $t, 'html' => $h] = Messages::translator($lang);
        return self::page(
            $base,
            $lang,
            $t('auth.codeTitle'),
            '<h1>' . $h('auth.codeTitle') . '</h1>
<p>' . $h('auth.codeIntro') . '</p>
' . self::error($opts['error'] ?? null) . "
<form method=\"post\" action=\"$b/login/code\">
<input type=\"hidden\" name=\"pending\" value=\"" . self::esc($opts['pending']) . '">
<input type="hidden" name="next" value="' . self::esc($opts['next']) . '">
<label>' . $h('auth.code') . '<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required autofocus></label>
<button type="submit">' . $h('auth.signIn') . '</button>
</form>
<p class="hint">' . $h('auth.codeHint') . '</p>',
        );
    }

    /** What someone invited with a role can do, after "as". */
    public static function roleText(string $role, ?string $site = null, string $lang = 'en'): string
    {
        ['t' => $t] = Messages::translator($lang);
        if ($site !== null) {
            return $role === 'viewer' ? $t('auth.roleViewerSite', ['site' => $site]) : $t('auth.roleMemberSite', ['site' => $site]);
        }
        if ($role === 'viewer') {
            return $t('auth.roleViewer');
        }
        if ($role === 'member') {
            return $t('auth.roleMember');
        }
        return $t('auth.roleAdmin');
    }

    /**
     * Where an invited person chooses a password and joins.
     *
     * @param array{code: string, email: string, role: string, host: string, site?: ?string, error?: string} $opts
     */
    public static function invitePage(string $base, array $opts, string $lang = 'en'): string
    {
        $b = self::esc($base);
        ['t' => $t, 'html' => $h] = Messages::translator($lang);
        return self::page(
            $base,
            $lang,
            $t('auth.joinTitle'),
            '<h1>' . $h('auth.joinTitle') . '</h1>
<p>' . $h('auth.joinIntro', ['host' => self::esc($opts['host']), 'role' => self::esc(self::roleText($opts['role'], $opts['site'] ?? null, $lang))]) . '</p>
' . self::error($opts['error'] ?? null) . "
<form method=\"post\" action=\"$b/invite\">
<input type=\"hidden\" name=\"code\" value=\"" . self::esc($opts['code']) . '">
<label>' . $h('auth.email') . '<input type="email" value="' . self::esc($opts['email']) . '" disabled></label>
<label>' . $h('auth.password') . '<input type="password" name="password" autocomplete="new-password" minlength="10" required autofocus></label>
<label>' . $h('auth.passwordAgain') . '<input type="password" name="again" autocomplete="new-password" minlength="10" required></label>
<button type="submit">' . $h('auth.join') . '</button>
</form>
<p class="hint">' . $h('auth.passwordHint') . '</p>',
        );
    }

    public static function inviteGonePage(string $base, string $lang = 'en'): string
    {
        ['t' => $t, 'html' => $h] = Messages::translator($lang);
        return self::page(
            $base,
            $lang,
            $t('auth.inviteGoneTitle'),
            '<h1>' . $h('auth.inviteGoneTitle') . '</h1>
<p>' . $h('auth.inviteGone') . '</p>',
        );
    }

    /** @param array{code: string, error?: string, email?: string, askCode?: bool} $opts */
    public static function setupPage(string $base, array $opts, string $lang = 'en'): string
    {
        $b = self::esc($base);
        $code = self::esc($opts['code']);
        ['t' => $t, 'html' => $h] = Messages::translator($lang);
        $field = !empty($opts['askCode'])
            ? '<label>' . $h('auth.setupToken') . "<input type=\"password\" name=\"code\" autocomplete=\"off\" required value=\"$code\"></label>"
            : "<input type=\"hidden\" name=\"code\" value=\"$code\">";
        return self::page(
            $base,
            $lang,
            $t('auth.setupTitle'),
            '<h1>' . $h('auth.setupTitle') . '</h1>
<p>' . $h('auth.setupIntro') . '</p>
' . self::error($opts['error'] ?? null) . "
<form method=\"post\" action=\"$b/setup\">
$field
<label>" . $h('auth.email') . '<input type="email" name="email" autocomplete="username" required autofocus value="' . self::esc($opts['email'] ?? '') . '"></label>
<label>' . $h('auth.password') . '<input type="password" name="password" autocomplete="new-password" minlength="10" required></label>
<label>' . $h('auth.passwordAgain') . '<input type="password" name="again" autocomplete="new-password" minlength="10" required></label>
<button type="submit">' . $h('auth.createAccount') . '</button>
</form>
<p class="hint">' . $h('auth.passwordHint') . '</p>',
        );
    }

    /**
     * For a server with no account yet, which prints a setup link with a one-time code in its log. With `$file`,
     * the link is in the file setup.txt in the data folder instead (the standalone server), in any language.
     */
    public static function setupLockedPage(string $base, bool $file = false, string $lang = 'en'): string
    {
        ['t' => $t, 'html' => $h] = Messages::translator($lang);
        $text = $file ? $h('auth.setupLockedFile', ['command' => '<code>vendor/bin/runlight setup</code>']) : $h('auth.setupLocked');
        return self::page(
            $base,
            $lang,
            $t('auth.finishTitle'),
            '<h1>' . $h('auth.finishTitle') . "</h1>
<p>$text</p>",
        );
    }

    /** For an app with accounts on but nothing to prove the first account with. */
    public static function setupNeedsTokenPage(string $base, string $lang = 'en'): string
    {
        ['t' => $t, 'html' => $h] = Messages::translator($lang);
        return self::page(
            $base,
            $lang,
            $t('auth.finishTitle'),
            '<h1>' . $h('auth.finishTitle') . '</h1>
<p>' . $h('auth.setupNeedsToken') . '</p>',
        );
    }
}

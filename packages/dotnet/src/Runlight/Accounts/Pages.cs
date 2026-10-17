using System.Linq;

namespace Runlight.Accounts;

/// <summary>
/// The account pages: sign in, the code step, invites, and first-run setup. Everything else is the dashboard.
/// Each takes the base path the routes answer under: "" on the standalone server, and "/runlight" in an app.
/// </summary>
public static class Pages
{
    private const string Mark = "<svg class=\"mark\" viewBox=\"0 0 32 32\" aria-hidden=\"true\"><rect x=\"2.5\" y=\"2.5\" width=\"27\" height=\"27\" rx=\"7\"/><path d=\"M11 23V9h6.2a4.3 4.3 0 0 1 0 8.6H11m6 0 5 5.4\"/><circle cx=\"23.6\" cy=\"8.4\" r=\"2.6\"/></svg>";

    // Light until someone picks otherwise, as in the dashboard, which shares the choice through localStorage.
    private const string Dark = "color-scheme: dark; --page: #09090b; --card: #141417; --ink: #fafafa; --muted: #a1a1aa; --line: #27272a; --field: #0c0c0e; --bad: #f87171;";

    public const string AuthCss = """
:root { color-scheme: light; --page: #f4f4f5; --card: #fff; --ink: #111827; --muted: #6b7280; --line: #e5e7eb; --field: #fff; --bad: #b91c1c; }
:root[data-theme="dark"] {
""" + " " + Dark + " }\n@media (prefers-color-scheme: dark) { :root[data-theme=\"system\"] { " + Dark + " } }\n" + """
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
""";

    /// <summary>
    /// The script with its words left as markers: the theme's, the password button's, and the strength meter's.
    /// </summary>
    private const string AuthJsTemplate = """
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
    button.title = c === "system" ? @@THEMESYSTEM@@ : @@THEME@@;
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
        eye.setAttribute("aria-label", shown ? @@HIDE@@ : @@SHOW@@);
        eye.title = shown ? @@HIDE@@ : @@SHOW@@;
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
        meter.querySelector(".strength-label").textContent = [@@STRENGTH@@][score];
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
""";

    /// <summary>
    /// Applies the saved theme before the page paints, then runs the switch and Cmd+Shift+D (Ctrl+Shift+D), with its
    /// words in a language the dashboard speaks. English is served as auth.js, the others as auth.js?lang=fr and so on.
    /// </summary>
    public static string AuthJs(string lang = "en")
    {
        var tr = Messages.Translator(lang);
        string Q(string key) => Json.Stringify(tr.T(key));
        string theme = tr.Lang == "en" ? "\"Theme: \" + c" : "c === \"dark\" ? " + Q("auth.themeDark") + " : " + Q("auth.themeLight");
        return AuthJsTemplate
            .Replace("@@THEMESYSTEM@@", Q("auth.themeSystem"), System.StringComparison.Ordinal)
            .Replace("@@THEME@@", theme, System.StringComparison.Ordinal)
            .Replace("@@HIDE@@", Q("auth.hidePassword"), System.StringComparison.Ordinal)
            .Replace("@@SHOW@@", Q("auth.showPassword"), System.StringComparison.Ordinal)
            .Replace("@@STRENGTH@@", string.Join(", ", Enumerable.Range(0, 5).Select(n => Q("account.strength" + n))), System.StringComparison.Ordinal);
    }

    private const string ThemeIcons = "<svg data-choice=\"light\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"3\"/><path d=\"M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1\"/></svg><svg data-choice=\"dark\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z\"/></svg><svg data-choice=\"system\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><rect x=\"2\" y=\"3\" width=\"12\" height=\"8.5\" rx=\"1.5\"/><path d=\"M5.5 14h5M8 11.5V14\"/></svg>";

    /// <summary>HTML escaping for text and attribute values.</summary>
    public static string Esc(string value) =>
        value.Replace("&", "&amp;", System.StringComparison.Ordinal)
            .Replace("<", "&lt;", System.StringComparison.Ordinal)
            .Replace(">", "&gt;", System.StringComparison.Ordinal)
            .Replace("\"", "&quot;", System.StringComparison.Ordinal)
            .Replace("'", "&#39;", System.StringComparison.Ordinal);

    private static string Page(string basePath, string lang, string title, string body)
    {
        var tr = Messages.Translator(lang);
        string code = tr.Lang;
        string b = Esc(basePath);
        return "<!doctype html>\n<html lang=\"" + code + "\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex\">\n<title>"
            + Esc(title) + " | Runlight</title>\n<link rel=\"icon\" href=\"" + Brand.RunlightIcon + "\">\n<link rel=\"stylesheet\" href=\"" + b + "/auth.css\">\n<script src=\"" + b + "/auth.js" + (code == "en" ? "" : "?lang=" + code) + "\"></script>\n</head>\n<body>\n<main>\n<p class=\"brand\">"
            + Mark + "Runlight</p>\n" + body + "\n</main>\n<button type=\"button\" class=\"theme\" aria-label=\"" + Esc(tr.T("auth.switchTheme")) + "\">" + ThemeIcons + "</button>\n</body>\n</html>\n";
    }

    private static string Error(string? error) =>
        !string.IsNullOrEmpty(error) ? "<p class=\"error\" role=\"alert\">" + Esc(error) + "</p>" : "";

    public static string LoginPage(string basePath, string forgot, string? error = null, string? email = null, string? next = null, string lang = "en")
    {
        var tr = Messages.Translator(lang);
        string b = Esc(basePath);
        string link = "<a href=\"" + Esc(forgot) + "\" target=\"_blank\" rel=\"noopener\">" + tr.Html("auth.forgotLink") + "</a>";
        return Page(
            basePath,
            lang,
            tr.T("auth.signIn"),
            "<h1>" + tr.Html("auth.signIn") + "</h1>\n<p>" + tr.Html("auth.signInIntro") + "</p>\n" + Error(error) + "\n<form method=\"post\" action=\"" + b + "/login\">\n<input type=\"hidden\" name=\"next\" value=\""
                + Esc(next ?? basePath + "/") + "\">\n<label>" + tr.Html("auth.email") + "<input type=\"email\" name=\"email\" autocomplete=\"username\" required autofocus value=\"" + Esc(email ?? "")
                + "\"></label>\n<label>" + tr.Html("auth.password") + "<input type=\"password\" name=\"password\" autocomplete=\"current-password\" required></label>\n<button type=\"submit\">" + tr.Html("auth.signIn") + "</button>\n</form>\n<p class=\"hint\">"
                + tr.Html("auth.forgot", new JsObject { ["link"] = link }) + "</p>");
    }

    /// <summary>The second step of signing in, for an account with two-factor on.</summary>
    public static string CodePage(string basePath, string pending, string next, string? error = null, string lang = "en")
    {
        var tr = Messages.Translator(lang);
        string b = Esc(basePath);
        return Page(
            basePath,
            lang,
            tr.T("auth.codeTitle"),
            "<h1>" + tr.Html("auth.codeTitle") + "</h1>\n<p>" + tr.Html("auth.codeIntro") + "</p>\n" + Error(error) + "\n<form method=\"post\" action=\"" + b
                + "/login/code\">\n<input type=\"hidden\" name=\"pending\" value=\"" + Esc(pending) + "\">\n<input type=\"hidden\" name=\"next\" value=\"" + Esc(next)
                + "\">\n<label>" + tr.Html("auth.code") + "<input type=\"text\" name=\"code\" inputmode=\"numeric\" autocomplete=\"one-time-code\" maxlength=\"12\" required autofocus></label>\n<button type=\"submit\">" + tr.Html("auth.signIn") + "</button>\n</form>\n<p class=\"hint\">" + tr.Html("auth.codeHint") + "</p>");
    }

    /// <summary>What someone invited with a role can do, after "as".</summary>
    public static string RoleText(string role, string? site = null, string lang = "en")
    {
        var tr = Messages.Translator(lang);
        if (site != null)
        {
            return tr.T(role == "viewer" ? "auth.roleViewerSite" : "auth.roleMemberSite", new JsObject { ["site"] = site });
        }
        if (role == "viewer")
        {
            return tr.T("auth.roleViewer");
        }
        return tr.T(role == "member" ? "auth.roleMember" : "auth.roleAdmin");
    }

    /// <summary>Where an invited person chooses a password and joins.</summary>
    public static string InvitePage(string basePath, string code, string email, string role, string host, string? error = null, string? site = null, string lang = "en")
    {
        var tr = Messages.Translator(lang);
        string b = Esc(basePath);
        return Page(
            basePath,
            lang,
            tr.T("auth.joinTitle"),
            "<h1>" + tr.Html("auth.joinTitle") + "</h1>\n<p>" + tr.Html("auth.joinIntro", new JsObject { ["host"] = Esc(host), ["role"] = Esc(RoleText(role, site, lang)) }) + "</p>\n" + Error(error) + "\n<form method=\"post\" action=\""
                + b + "/invite\">\n<input type=\"hidden\" name=\"code\" value=\"" + Esc(code) + "\">\n<label>" + tr.Html("auth.email") + "<input type=\"email\" value=\"" + Esc(email)
                + "\" disabled></label>\n<label>" + tr.Html("auth.password") + "<input type=\"password\" name=\"password\" autocomplete=\"new-password\" minlength=\"10\" required autofocus></label>\n<label>" + tr.Html("auth.passwordAgain")
                + "<input type=\"password\" name=\"again\" autocomplete=\"new-password\" minlength=\"10\" required></label>\n<button type=\"submit\">" + tr.Html("auth.join") + "</button>\n</form>\n<p class=\"hint\">" + tr.Html("auth.passwordHint") + "</p>");
    }

    public static string InviteGonePage(string basePath, string lang = "en")
    {
        var tr = Messages.Translator(lang);
        return Page(
            basePath,
            lang,
            tr.T("auth.inviteGoneTitle"),
            "<h1>" + tr.Html("auth.inviteGoneTitle") + "</h1>\n<p>" + tr.Html("auth.inviteGone") + "</p>");
    }

    public static string SetupPage(string basePath, string code, string? error = null, string? email = null, bool askCode = false, string lang = "en")
    {
        var tr = Messages.Translator(lang);
        string b = Esc(basePath);
        string c = Esc(code);
        string field = askCode
            ? "<label>" + tr.Html("auth.setupToken") + "<input type=\"password\" name=\"code\" autocomplete=\"off\" required value=\"" + c + "\"></label>"
            : "<input type=\"hidden\" name=\"code\" value=\"" + c + "\">";
        return Page(
            basePath,
            lang,
            tr.T("auth.setupTitle"),
            "<h1>" + tr.Html("auth.setupTitle") + "</h1>\n<p>" + tr.Html("auth.setupIntro") + "</p>\n" + Error(error) + "\n<form method=\"post\" action=\""
                + b + "/setup\">\n" + field + "\n<label>" + tr.Html("auth.email") + "<input type=\"email\" name=\"email\" autocomplete=\"username\" required autofocus value=\"" + Esc(email ?? "")
                + "\"></label>\n<label>" + tr.Html("auth.password") + "<input type=\"password\" name=\"password\" autocomplete=\"new-password\" minlength=\"10\" required></label>\n<label>" + tr.Html("auth.passwordAgain")
                + "<input type=\"password\" name=\"again\" autocomplete=\"new-password\" minlength=\"10\" required></label>\n<button type=\"submit\">" + tr.Html("auth.createAccount") + "</button>\n</form>\n<p class=\"hint\">" + tr.Html("auth.passwordHint") + "</p>");
    }

    /// <summary>
    /// For a server with no account yet, which prints a setup link with a one-time code in its log, or keeps it in
    /// the file setup.txt when <paramref name="inFile"/> is true.
    /// </summary>
    public static string SetupLockedPage(string basePath, bool inFile = false, string lang = "en")
    {
        var tr = Messages.Translator(lang);
        string text = inFile ? tr.Html("auth.setupLockedFile", new JsObject { ["command"] = "<code>runlight setup</code>" }) : tr.Html("auth.setupLocked");
        return Page(basePath, lang, tr.T("auth.finishTitle"), "<h1>" + tr.Html("auth.finishTitle") + "</h1>\n<p>" + text + "</p>");
    }

    /// <summary>For an app with accounts on but nothing to prove the first account with.</summary>
    public static string SetupNeedsTokenPage(string basePath, string lang = "en")
    {
        var tr = Messages.Translator(lang);
        return Page(basePath, lang, tr.T("auth.finishTitle"), "<h1>" + tr.Html("auth.finishTitle") + "</h1>\n<p>" + tr.Html("auth.setupNeedsToken") + "</p>");
    }
}

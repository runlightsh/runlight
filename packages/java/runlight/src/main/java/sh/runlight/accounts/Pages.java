package sh.runlight.accounts;

import java.util.Map;
import sh.runlight.Js;
import sh.runlight.Json;
import sh.runlight.Messages;
import sh.runlight.Version;

/**
 * The account pages: sign in, the code step, invites, and first-run setup. Everything else is the
 * dashboard. Each takes the base path the routes answer under: "" on the standalone server, and
 * "/runlight" in an app. Options are maps with the TypeScript's keys.
 */
public final class Pages {
  private Pages() {}

  private static final String MARK =
      "<svg class=\"mark\" viewBox=\"0 0 32 32\" aria-hidden=\"true\"><rect x=\"2.5\" y=\"2.5\" width=\"27\" height=\"27\" rx=\"7\"/><path d=\"M11 23V9h6.2a4.3 4.3 0 0 1 0 8.6H11m6 0 5 5.4\"/><circle cx=\"23.6\" cy=\"8.4\" r=\"2.6\"/></svg>";

  // Light until someone picks otherwise, as in the dashboard, which shares the choice through
  // localStorage.
  private static final String DARK =
      "color-scheme: dark; --page: #09090b; --card: #141417; --ink: #fafafa; --muted: #a1a1aa; --line: #27272a; --field: #0c0c0e; --bad: #f87171;";

  public static final String AUTH_CSS =
      ":root { color-scheme: light; --page: #f4f4f5; --card: #fff; --ink: #111827; --muted: #6b7280; --line: #e5e7eb; --field: #fff; --bad: #b91c1c; }\n"
          + ":root[data-theme=\"dark\"] { "
          + DARK
          + " }\n"
          + "@media (prefers-color-scheme: dark) { :root[data-theme=\"system\"] { "
          + DARK
          + " } }\n"
          + """
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
          .eye svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }""";

  /**
   * Applies the saved theme before the page paints, then runs the switch and Cmd+Shift+D
   * (Ctrl+Shift+D).
   */
  private static final String AUTH_JS_ENGLISH =
      """
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
      })();""";

  /** The script's English, which is served as auth.js. */
  public static final String AUTH_JS = AUTH_JS_ENGLISH;

  /**
   * The script with its words in a language the dashboard speaks. English is served as auth.js, the
   * others as auth.js?lang=fr and so on.
   */
  public static String authJs(String lang) {
    Messages.Translator tr = Messages.translator(lang);
    if (tr.lang().equals("en")) {
      return AUTH_JS_ENGLISH;
    }
    String theme = "c === \"dark\" ? " + q(tr, "auth.themeDark") + " : " + q(tr, "auth.themeLight");
    StringBuilder strength = new StringBuilder("[");
    for (int n = 0; n < 5; n++) {
      strength.append(n > 0 ? ", " : "").append(q(tr, "account.strength" + n));
    }
    strength.append("]");
    return AUTH_JS_ENGLISH
        .replace(
            "button.title = c === \"system\" ? \"Theme: device setting\" : \"Theme: \" + c;",
            "button.title = c === \"system\" ? " + q(tr, "auth.themeSystem") + " : " + theme + ";")
        .replace(
            "eye.setAttribute(\"aria-label\", shown ? \"Hide password\" : \"Show password\");",
            "eye.setAttribute(\"aria-label\", shown ? "
                + q(tr, "auth.hidePassword")
                + " : "
                + q(tr, "auth.showPassword")
                + ");")
        .replace(
            "eye.title = shown ? \"Hide password\" : \"Show password\";",
            "eye.title = shown ? "
                + q(tr, "auth.hidePassword")
                + " : "
                + q(tr, "auth.showPassword")
                + ";")
        .replace(
            "[\"Too short\", \"Weak\", \"Fair\", \"Good\", \"Strong\"][score]",
            strength + "[score]");
  }

  private static String q(Messages.Translator tr, String key) {
    return Json.stringify(tr.t(key));
  }

  private static final String THEME_ICONS =
      "<svg data-choice=\"light\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"3\"/><path d=\"M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1\"/></svg><svg data-choice=\"dark\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z\"/></svg><svg data-choice=\"system\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><rect x=\"2\" y=\"3\" width=\"12\" height=\"8.5\" rx=\"1.5\"/><path d=\"M5.5 14h5M8 11.5V14\"/></svg>";

  private static String esc(String value) {
    StringBuilder out = new StringBuilder(value.length());
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '&' -> out.append("&amp;");
        case '<' -> out.append("&lt;");
        case '>' -> out.append("&gt;");
        case '"' -> out.append("&quot;");
        case '\'' -> out.append("&#39;");
        default -> out.append(c);
      }
    }
    return out.toString();
  }

  /** opts[key] as text, else the fallback, as {@code opts.key ?? fallback} reads. */
  private static String opt(Map<String, Object> opts, String key, String fallback) {
    Object value = opts.get(key);
    return value == null ? fallback : Js.string(value);
  }

  private static String page(String base, String lang, String title, String body) {
    Messages.Translator t = Messages.translator(lang);
    String code = t.lang();
    String b = esc(base);
    return "<!doctype html>\n"
        + "<html lang=\""
        + code
        + "\">\n"
        + "<head>\n"
        + "<meta charset=\"utf-8\">\n"
        + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        + "<meta name=\"robots\" content=\"noindex\">\n"
        + "<title>"
        + esc(title)
        + " | Runlight</title>\n"
        + "<link rel=\"icon\" href=\""
        + Version.runlightIcon()
        + "\">\n"
        + "<link rel=\"stylesheet\" href=\""
        + b
        + "/auth.css\">\n"
        + "<script src=\""
        + b
        + "/auth.js"
        + (code.equals("en") ? "" : "?lang=" + code)
        + "\"></script>\n"
        + "</head>\n"
        + "<body>\n"
        + "<main>\n"
        + "<p class=\"brand\">"
        + MARK
        + "Runlight</p>\n"
        + body
        + "\n</main>\n"
        + "<button type=\"button\" class=\"theme\" aria-label=\""
        + esc(t.t("auth.switchTheme"))
        + "\">"
        + THEME_ICONS
        + "</button>"
        + "\n</body>\n"
        + "</html>\n";
  }

  private static String error(Map<String, Object> opts) {
    String error = opt(opts, "error", "");
    return error.isEmpty() ? "" : "<p class=\"error\" role=\"alert\">" + esc(error) + "</p>";
  }

  public static String loginPage(String base, Map<String, Object> opts) {
    return loginPage(base, opts, "en");
  }

  /** The sign-in page; opts are error, email, next, and forgot. */
  public static String loginPage(String base, Map<String, Object> opts, String lang) {
    Messages.Translator t = Messages.translator(lang);
    String b = esc(base);
    String link =
        "<a href=\""
            + esc(opt(opts, "forgot", ""))
            + "\" target=\"_blank\" rel=\"noopener\">"
            + t.html("auth.forgotLink")
            + "</a>";
    return page(
        base,
        lang,
        t.t("auth.signIn"),
        "<h1>"
            + t.html("auth.signIn")
            + "</h1>\n"
            + "<p>"
            + t.html("auth.signInIntro")
            + "</p>\n"
            + error(opts)
            + "\n<form method=\"post\" action=\""
            + b
            + "/login\">\n"
            + "<input type=\"hidden\" name=\"next\" value=\""
            + esc(opt(opts, "next", base + "/"))
            + "\">\n"
            + "<label>"
            + t.html("auth.email")
            + "<input type=\"email\" name=\"email\" autocomplete=\"username\" required autofocus value=\""
            + esc(opt(opts, "email", ""))
            + "\"></label>\n"
            + "<label>"
            + t.html("auth.password")
            + "<input type=\"password\" name=\"password\" autocomplete=\"current-password\" required></label>\n"
            + "<button type=\"submit\">"
            + t.html("auth.signIn")
            + "</button>\n"
            + "</form>\n"
            + "<p class=\"hint\">"
            + t.html("auth.forgot", Map.of("link", link))
            + "</p>");
  }

  public static String codePage(String base, Map<String, Object> opts) {
    return codePage(base, opts, "en");
  }

  /**
   * The second step of signing in, for an account with two-factor on; opts are pending, next, and
   * error.
   */
  public static String codePage(String base, Map<String, Object> opts, String lang) {
    Messages.Translator t = Messages.translator(lang);
    String b = esc(base);
    return page(
        base,
        lang,
        t.t("auth.codeTitle"),
        "<h1>"
            + t.html("auth.codeTitle")
            + "</h1>\n"
            + "<p>"
            + t.html("auth.codeIntro")
            + "</p>\n"
            + error(opts)
            + "\n<form method=\"post\" action=\""
            + b
            + "/login/code\">\n"
            + "<input type=\"hidden\" name=\"pending\" value=\""
            + esc(opt(opts, "pending", ""))
            + "\">\n"
            + "<input type=\"hidden\" name=\"next\" value=\""
            + esc(opt(opts, "next", ""))
            + "\">\n"
            + "<label>"
            + t.html("auth.code")
            + "<input type=\"text\" name=\"code\" inputmode=\"numeric\" autocomplete=\"one-time-code\" maxlength=\"12\" required autofocus></label>\n"
            + "<button type=\"submit\">"
            + t.html("auth.signIn")
            + "</button>\n"
            + "</form>\n"
            + "<p class=\"hint\">"
            + t.html("auth.codeHint")
            + "</p>");
  }

  /** What someone invited with a role can do, after "as". */
  public static String roleText(String role, String... sites) {
    return roleText(role, sites.length > 0 ? sites[0] : null, "en");
  }

  public static String roleText(String role, String site, String lang) {
    Messages.Translator t = Messages.translator(lang);
    if (site != null) {
      return t.t(
          role.equals("viewer") ? "auth.roleViewerSite" : "auth.roleMemberSite",
          Map.of("site", site));
    }
    if (role.equals("viewer")) {
      return t.t("auth.roleViewer");
    }
    if (role.equals("member")) {
      return t.t("auth.roleMember");
    }
    return t.t("auth.roleAdmin");
  }

  public static String invitePage(String base, Map<String, Object> opts) {
    return invitePage(base, opts, "en");
  }

  /**
   * Where an invited person chooses a password and joins; opts are code, email, role, host, and
   * error.
   */
  public static String invitePage(String base, Map<String, Object> opts, String lang) {
    Messages.Translator t = Messages.translator(lang);
    String b = esc(base);
    return page(
        base,
        lang,
        t.t("auth.joinTitle"),
        "<h1>"
            + t.html("auth.joinTitle")
            + "</h1>\n"
            + "<p>"
            + t.html(
                "auth.joinIntro",
                Map.of(
                    "host",
                    esc(opt(opts, "host", "")),
                    "role",
                    esc(roleText(opt(opts, "role", ""), (String) opts.get("site"), lang))))
            + "</p>\n"
            + error(opts)
            + "\n<form method=\"post\" action=\""
            + b
            + "/invite\">\n"
            + "<input type=\"hidden\" name=\"code\" value=\""
            + esc(opt(opts, "code", ""))
            + "\">\n"
            + "<label>"
            + t.html("auth.email")
            + "<input type=\"email\" value=\""
            + esc(opt(opts, "email", ""))
            + "\" disabled></label>\n"
            + "<label>"
            + t.html("auth.password")
            + "<input type=\"password\" name=\"password\" autocomplete=\"new-password\" minlength=\"10\" required autofocus></label>\n"
            + "<label>"
            + t.html("auth.passwordAgain")
            + "<input type=\"password\" name=\"again\" autocomplete=\"new-password\" minlength=\"10\" required></label>\n"
            + "<button type=\"submit\">"
            + t.html("auth.join")
            + "</button>\n"
            + "</form>\n"
            + "<p class=\"hint\">"
            + t.html("auth.passwordHint")
            + "</p>");
  }

  public static String inviteGonePage(String base) {
    return inviteGonePage(base, "en");
  }

  public static String inviteGonePage(String base, String lang) {
    Messages.Translator t = Messages.translator(lang);
    return page(
        base,
        lang,
        t.t("auth.inviteGoneTitle"),
        "<h1>"
            + t.html("auth.inviteGoneTitle")
            + "</h1>\n<p>"
            + t.html("auth.inviteGone")
            + "</p>");
  }

  public static String setupPage(String base, Map<String, Object> opts) {
    return setupPage(base, opts, "en");
  }

  /** The first account's form; opts are code, error, email, and askCode. */
  public static String setupPage(String base, Map<String, Object> opts, String lang) {
    Messages.Translator t = Messages.translator(lang);
    String b = esc(base);
    String code = esc(opt(opts, "code", ""));
    String field =
        Js.truthy(opts.get("askCode"))
            ? "<label>"
                + t.html("auth.setupToken")
                + "<input type=\"password\" name=\"code\" autocomplete=\"off\" required value=\""
                + code
                + "\"></label>"
            : "<input type=\"hidden\" name=\"code\" value=\"" + code + "\">";
    return page(
        base,
        lang,
        t.t("auth.setupTitle"),
        "<h1>"
            + t.html("auth.setupTitle")
            + "</h1>\n"
            + "<p>"
            + t.html("auth.setupIntro")
            + "</p>\n"
            + error(opts)
            + "\n<form method=\"post\" action=\""
            + b
            + "/setup\">\n"
            + field
            + "\n<label>"
            + t.html("auth.email")
            + "<input type=\"email\" name=\"email\" autocomplete=\"username\" required autofocus value=\""
            + esc(opt(opts, "email", ""))
            + "\"></label>\n"
            + "<label>"
            + t.html("auth.password")
            + "<input type=\"password\" name=\"password\" autocomplete=\"new-password\" minlength=\"10\" required></label>\n"
            + "<label>"
            + t.html("auth.passwordAgain")
            + "<input type=\"password\" name=\"again\" autocomplete=\"new-password\" minlength=\"10\" required></label>\n"
            + "<button type=\"submit\">"
            + t.html("auth.createAccount")
            + "</button>\n"
            + "</form>\n"
            + "<p class=\"hint\">"
            + t.html("auth.passwordHint")
            + "</p>");
  }

  /**
   * For a server with no account yet, which prints a setup link with a one-time code in its log.
   */
  public static String setupLockedPage(String base) {
    return setupLockedPage(base, false, "en");
  }

  public static String setupLockedPage(String base, String lang) {
    return setupLockedPage(base, false, lang);
  }

  /**
   * As {@link #setupLockedPage(String, String)}, for a server that keeps the setup link in the file
   * setup.txt rather than printing it in its log.
   */
  public static String setupLockedPage(String base, boolean inFile, String lang) {
    Messages.Translator t = Messages.translator(lang);
    String text =
        inFile
            ? t.html("auth.setupLockedFile", Map.of("command", "<code>runlight setup</code>"))
            : t.html("auth.setupLocked");
    return page(
        base,
        lang,
        t.t("auth.finishTitle"),
        "<h1>" + t.html("auth.finishTitle") + "</h1>\n<p>" + text + "</p>");
  }

  public static String setupNeedsTokenPage(String base) {
    return setupNeedsTokenPage(base, "en");
  }

  /** For an app with accounts on but nothing to prove the first account with. */
  public static String setupNeedsTokenPage(String base, String lang) {
    Messages.Translator t = Messages.translator(lang);
    return page(
        base,
        lang,
        t.t("auth.finishTitle"),
        "<h1>"
            + t.html("auth.finishTitle")
            + "</h1>\n<p>"
            + t.html("auth.setupNeedsToken")
            + "</p>");
  }
}

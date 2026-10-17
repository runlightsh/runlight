defmodule Runlight.Accounts.Pages do
  @moduledoc false
  # Internal. The account pages: sign in, the code step, invites, and
  # first-run setup (the SDK's accounts/pages.ts), each in a language the dashboard speaks. Everything else is the
  # dashboard. Each takes the base path the routes answer under: "" on a
  # standalone server, and "/runlight" in an app. Options are maps with atom
  # keys: error, email, next, forgot, pending, code, role, host, and ask_code.

  alias Runlight.Assets
  alias Runlight.JS
  alias Runlight.Messages

  @css ":root { color-scheme: light; --page: #f4f4f5; --card: #fff; --ink: #111827; --muted: #6b7280; --line: #e5e7eb; --field: #fff; --bad: #b91c1c; }\n:root[data-theme=\"dark\"] { color-scheme: dark; --page: #09090b; --card: #141417; --ink: #fafafa; --muted: #a1a1aa; --line: #27272a; --field: #0c0c0e; --bad: #f87171; }\n@media (prefers-color-scheme: dark) { :root[data-theme=\"system\"] { color-scheme: dark; --page: #09090b; --card: #141417; --ink: #fafafa; --muted: #a1a1aa; --line: #27272a; --field: #0c0c0e; --bad: #f87171; } }\n* { box-sizing: border-box; }\nbody { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--page); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, \"Segoe UI\", Helvetica, Arial, sans-serif; }\nmain { width: min(400px, 100%); padding: 28px; border: 1px solid var(--line); border-radius: 14px; background: var(--card); }\n.brand { display: flex; align-items: center; gap: 9px; margin: 0 0 22px; color: var(--ink); font-weight: 700; font-size: 16px; }\n.mark { width: 26px; height: 26px; }\n.mark rect { fill: var(--ink); }\n.mark path { fill: none; stroke: var(--card); stroke-width: 2.8; stroke-linecap: round; stroke-linejoin: round; }\n.mark circle { fill: #22c55e; }\nh1 { margin: 0 0 6px; font-size: 21px; }\np { margin: 0 0 18px; color: var(--muted); }\nlabel { display: block; margin: 0 0 14px; font-size: 13px; font-weight: 600; }\ninput { display: block; width: 100%; height: 40px; margin-top: 6px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--field); color: var(--ink); font: inherit; }\ninput:focus { outline: 2px solid #2a78d6; outline-offset: -1px; }\nmain button { width: 100%; height: 40px; margin-top: 6px; border: 0; border-radius: 8px; background: var(--ink); color: var(--card); font: inherit; font-weight: 600; cursor: pointer; }\n.error { margin: 0 0 14px; color: var(--bad); font-size: 14px; }\n.hint { margin: 16px 0 0; font-size: 13px; }\n.hint a { color: var(--ink); }\n.theme { position: fixed; right: 16px; bottom: 16px; display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--muted); cursor: pointer; }\n.theme:hover { color: var(--ink); }\n.theme svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }\n.theme svg:not(.on) { display: none; }\n.strength { display: flex; align-items: center; gap: 10px; margin-top: 8px; font-size: 12px; color: var(--muted); }\n.strength[hidden] { display: none; }\n.strength-bar { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; width: 120px; }\n.strength-bar span { height: 4px; border-radius: 2px; background: var(--line); }\n.strength[data-score=\"0\"] .strength-label, .strength[data-score=\"1\"] .strength-label { color: var(--bad); }\n.strength[data-score=\"1\"] .on { background: var(--bad); }\n.strength[data-score=\"2\"] .on { background: #b7791f; }\n.strength[data-score=\"3\"] .on, .strength[data-score=\"4\"] .on { background: #22a065; }\n.secret { position: relative; display: block; margin-top: 6px; }\n.secret input { margin-top: 0; padding-right: 44px; }\n.eye { position: absolute; top: 50%; right: 5px; display: grid; place-items: center; width: 32px; height: 30px; margin: 0; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--muted); transform: translateY(-50%); cursor: pointer; }\nmain .eye { width: 32px; height: 30px; margin: 0; background: none; color: var(--muted); }\n.eye:hover, .eye[aria-pressed=\"true\"] { color: var(--ink); }\n.eye svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }"
  @js "(() => {\n  const COMMON = [\"password\", \"passw0rd\", \"123456\", \"qwerty\", \"azerty\", \"letmein\", \"welcome\", \"admin\", \"runlight\", \"iloveyou\", \"abc123\", \"monkey\", \"dragon\", \"football\", \"baseball\", \"sunshine\", \"princess\", \"shadow\", \"master\"];\n  function strength(password, avoid = []) {\n    if (password.length < 10) return 0;\n    let pool = 0;\n    if (/[a-z]/.test(password)) pool += 26;\n    if (/[A-Z]/.test(password)) pool += 26;\n    if (/[0-9]/.test(password)) pool += 10;\n    if (/[^A-Za-z0-9]/.test(password)) pool += 33;\n    // Each character only counts once it adds something new: a pattern repeating (\"abab\", \"Aa1!Aa1!\",\n    // \"aaaa\") adds nothing, and a doubled letter or a run like \"abc\" adds little.\n    let effective = 0;\n    for (let i = 0; i < password.length; i++) {\n      const c = password.charCodeAt(i);\n      const prev = password.charCodeAt(i - 1);\n      let pattern = false;\n      for (let k = 1; k <= 4 && !pattern; k++) pattern = i - 1 - k >= 0 && password[i] === password[i - k] && password[i - 1] === password[i - 1 - k];\n      const repeat = i > 0 && c === prev;\n      const run = i > 1 && c - prev === prev - password.charCodeAt(i - 2) && Math.abs(c - prev) === 1;\n      effective += pattern ? 0 : repeat || run ? 0.25 : 1;\n    }\n    let bits = effective * Math.log2(Math.max(pool, 10));\n    const lower = password.toLowerCase();\n    for (const word of [...COMMON, ...avoid.map((a) => a.toLowerCase()).filter((a) => a.length >= 3)]) {\n      // Every time it appears, so \"jonjonjon\" costs three times.\n      bits -= (lower.split(word).length - 1) * word.length * 3;\n    }\n    if (bits < 40) return 1;\n    if (bits < 60) return 2;\n    if (bits < 80) return 3;\n    return 4;\n  }\n  const KEY = \"runlight_theme\";\n  const root = document.documentElement;\n  const read = () => { try { const v = localStorage.getItem(KEY); return v === \"dark\" || v === \"system\" ? v : \"light\"; } catch { return \"light\"; } };\n  const dark = () => { const c = read(); return c === \"system\" ? matchMedia(\"(prefers-color-scheme: dark)\").matches : c === \"dark\"; };\n  const show = () => {\n    const c = read();\n    root.dataset.theme = c;\n    const button = document.querySelector(\".theme\");\n    if (!button) return;\n    for (const icon of button.querySelectorAll(\"svg\")) icon.classList.toggle(\"on\", icon.dataset.choice === c);\n    button.title = c === \"system\" ? \"Theme: device setting\" : \"Theme: \" + c;\n  };\n  const set = (c) => { try { localStorage.setItem(KEY, c); } catch {} show(); };\n  show();\n  const EYE = '<svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z\"/></svg>';\n  const SHUT = '<svg viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M1.5 8s2.4-4.5 6.5-4.5c1 0 1.9.3 2.7.7M14.5 8s-2.4 4.5-6.5 4.5c-1 0-1.9-.3-2.7-.7M6.6 6.6a2 2 0 0 0 2.8 2.8M2.5 2.5l11 11\"/></svg>';\n  document.addEventListener(\"DOMContentLoaded\", () => {\n    // An eye button in each password field, to show what was typed.\n    for (const input of document.querySelectorAll('input[type=\"password\"]')) {\n      const wrap = document.createElement(\"span\");\n      wrap.className = \"secret\";\n      input.replaceWith(wrap);\n      wrap.append(input);\n      const eye = document.createElement(\"button\");\n      eye.type = \"button\";\n      eye.className = \"eye\";\n      const set = (shown) => {\n        input.type = shown ? \"text\" : \"password\";\n        eye.setAttribute(\"aria-pressed\", String(shown));\n        eye.setAttribute(\"aria-label\", shown ? \"Hide password\" : \"Show password\");\n        eye.title = shown ? \"Hide password\" : \"Show password\";\n        eye.innerHTML = shown ? SHUT : EYE;\n      };\n      set(false);\n      eye.addEventListener(\"click\", () => set(input.type === \"password\"));\n      wrap.append(eye);\n    }\n    const password = document.querySelector('input[name=\"password\"][autocomplete=\"new-password\"]');\n    if (password) {\n      const meter = document.createElement(\"span\");\n      meter.className = \"strength\";\n      meter.id = \"password-strength\";\n      meter.setAttribute(\"aria-live\", \"polite\");\n      meter.innerHTML = '<span class=\"strength-bar\" aria-hidden=\"true\"><span></span><span></span><span></span><span></span></span><span class=\"strength-label\"></span>';\n      password.closest(\".secret\").after(meter);\n      password.setAttribute(\"aria-describedby\", meter.id);\n      const email = document.querySelector('input[name=\"email\"]');\n      const update = () => {\n        const address = email?.value || \"\";\n        const score = strength(password.value, [address, address.split(\"@\")[0]]);\n        meter.hidden = !password.value;\n        meter.dataset.score = String(score);\n        meter.querySelector(\".strength-label\").textContent = [\"Too short\", \"Weak\", \"Fair\", \"Good\", \"Strong\"][score];\n        meter.querySelectorAll(\".strength-bar span\").forEach((bar, i) => bar.classList.toggle(\"on\", score > i));\n      };\n      password.addEventListener(\"input\", update);\n      password.addEventListener(\"change\", update);\n      email?.addEventListener(\"input\", update);\n      window.addEventListener(\"pageshow\", update);\n      update();\n    }\n    show();\n    document.querySelector(\".theme\")?.addEventListener(\"click\", () => set({ light: \"dark\", dark: \"system\", system: \"light\" }[read()]));\n  });\n  document.addEventListener(\"keydown\", (e) => {\n    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === \"d\") { e.preventDefault(); set(dark() ? \"light\" : \"dark\"); }\n  });\n})();"
  @mark "<svg class=\"mark\" viewBox=\"0 0 32 32\" aria-hidden=\"true\"><rect x=\"2.5\" y=\"2.5\" width=\"27\" height=\"27\" rx=\"7\"/><path d=\"M11 23V9h6.2a4.3 4.3 0 0 1 0 8.6H11m6 0 5 5.4\"/><circle cx=\"23.6\" cy=\"8.4\" r=\"2.6\"/></svg>"
  @theme_icons "<svg data-choice=\"light\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"3\"/><path d=\"M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1\"/></svg><svg data-choice=\"dark\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><path d=\"M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z\"/></svg><svg data-choice=\"system\" viewBox=\"0 0 16 16\" aria-hidden=\"true\"><rect x=\"2\" y=\"3\" width=\"12\" height=\"8.5\" rx=\"1.5\"/><path d=\"M5.5 14h5M8 11.5V14\"/></svg>"

  @doc "The pages' stylesheet."
  def auth_css, do: @css

  @doc "Applies the saved theme before the page paints, then runs the switch and Cmd+Shift+D (Ctrl+Shift+D)."
  def auth_js, do: @js

  @doc """
  The same script with its words in a language the dashboard speaks. English is served as auth.js, the others as
  auth.js?lang=fr and so on.
  """
  def auth_js(lang) do
    code = Messages.code(lang)

    if code == "en" do
      @js
    else
      q = fn key -> JS.stringify(Messages.t(code, key)) end
      strengths = Enum.map_join(0..4, ", ", &q.("account.strength#{&1}"))

      @js
      |> String.replace(
        ~s("Theme: device setting" : "Theme: " + c;),
        ~s(#{q.("auth.themeSystem")} : c === "dark" ? #{q.("auth.themeDark")} : #{q.("auth.themeLight")};)
      )
      |> String.replace(
        ~s(shown ? "Hide password" : "Show password"),
        ~s(shown ? #{q.("auth.hidePassword")} : #{q.("auth.showPassword")})
      )
      |> String.replace(~s(["Too short", "Weak", "Fair", "Good", "Strong"]), "[#{strengths}]")
    end
  end

  defp esc(value), do: JS.escape_html(value || "")

  defp page(base, lang, title, body) do
    code = Messages.code(lang)
    script = if code == "en", do: "", else: "?lang=#{code}"

    """
    <!doctype html>
    <html lang="#{code}">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>#{esc(title)} | Runlight</title>
    <link rel="icon" href="#{Assets.icon()}">
    <link rel="stylesheet" href="#{esc(base)}/auth.css">
    <script src="#{esc(base)}/auth.js#{script}"></script>
    </head>
    <body>
    <main>
    <p class="brand">#{@mark}Runlight</p>
    #{body}
    </main>
    <button type="button" class="theme" aria-label="#{esc(Messages.t(code, "auth.switchTheme"))}">#{@theme_icons}</button>
    </body>
    </html>
    """
  end

  defp error_line(opts) do
    case opts[:error] do
      e when e in [nil, ""] -> ""
      e -> ~s(<p class="error" role="alert">#{esc(e)}</p>)
    end
  end

  def login_page(base, opts, lang \\ "en") do
    h = &Messages.html(lang, &1, &2)

    page(
      base,
      lang,
      Messages.t(lang, "auth.signIn"),
      "<h1>#{h.("auth.signIn", %{})}</h1>\n<p>#{h.("auth.signInIntro", %{})}</p>\n" <>
        error_line(opts) <>
        "\n" <>
        ~s(<form method="post" action="#{esc(base)}/login">\n) <>
        ~s(<input type="hidden" name="next" value="#{esc(opts[:next] || "#{base}/")}">\n) <>
        ~s(<label>#{h.("auth.email", %{})}<input type="email" name="email" autocomplete="username" required autofocus value="#{esc(opts[:email] || "")}"></label>\n) <>
        ~s(<label>#{h.("auth.password", %{})}<input type="password" name="password" autocomplete="current-password" required></label>\n) <>
        ~s(<button type="submit">#{h.("auth.signIn", %{})}</button>\n</form>\n) <>
        ~s(<p class="hint">#{h.("auth.forgot", %{"link" => ~s(<a href="#{esc(opts[:forgot])}" target="_blank" rel="noopener">#{h.("auth.forgotLink", %{})}</a>)})}</p>)
    )
  end

  @doc "The second step of signing in, for an account with two-factor on."
  def code_page(base, opts, lang \\ "en") do
    h = &Messages.html(lang, &1, &2)

    page(
      base,
      lang,
      Messages.t(lang, "auth.codeTitle"),
      "<h1>#{h.("auth.codeTitle", %{})}</h1>\n<p>#{h.("auth.codeIntro", %{})}</p>\n" <>
        error_line(opts) <>
        "\n" <>
        ~s(<form method="post" action="#{esc(base)}/login/code">\n) <>
        ~s(<input type="hidden" name="pending" value="#{esc(opts[:pending])}">\n) <>
        ~s(<input type="hidden" name="next" value="#{esc(opts[:next])}">\n) <>
        ~s(<label>#{h.("auth.code", %{})}<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required autofocus></label>\n) <>
        ~s(<button type="submit">#{h.("auth.signIn", %{})}</button>\n</form>\n) <>
        ~s(<p class="hint">#{h.("auth.codeHint", %{})}</p>)
    )
  end

  @doc "What someone invited with a role can do, after \"as\"."
  def role_text(role, site \\ nil, lang \\ "en") do
    cond do
      site != nil and role == "viewer" -> Messages.t(lang, "auth.roleViewerSite", %{"site" => site})
      site != nil -> Messages.t(lang, "auth.roleMemberSite", %{"site" => site})
      role == "viewer" -> Messages.t(lang, "auth.roleViewer")
      role == "member" -> Messages.t(lang, "auth.roleMember")
      true -> Messages.t(lang, "auth.roleAdmin")
    end
  end

  @doc "Where an invited person chooses a password and joins."
  def invite_page(base, opts, lang \\ "en") do
    h = &Messages.html(lang, &1, &2)

    page(
      base,
      lang,
      Messages.t(lang, "auth.joinTitle"),
      "<h1>#{h.("auth.joinTitle", %{})}</h1>\n" <>
        "<p>#{h.("auth.joinIntro", %{"host" => esc(opts[:host]), "role" => esc(role_text(opts[:role], opts[:site], lang))})}</p>\n" <>
        error_line(opts) <>
        "\n" <>
        ~s(<form method="post" action="#{esc(base)}/invite">\n) <>
        ~s(<input type="hidden" name="code" value="#{esc(opts[:code])}">\n) <>
        ~s(<label>#{h.("auth.email", %{})}<input type="email" value="#{esc(opts[:email])}" disabled></label>\n) <>
        ~s(<label>#{h.("auth.password", %{})}<input type="password" name="password" autocomplete="new-password" minlength="10" required autofocus></label>\n) <>
        ~s(<label>#{h.("auth.passwordAgain", %{})}<input type="password" name="again" autocomplete="new-password" minlength="10" required></label>\n) <>
        ~s(<button type="submit">#{h.("auth.join", %{})}</button>\n</form>\n) <>
        ~s(<p class="hint">#{h.("auth.passwordHint", %{})}</p>)
    )
  end

  def invite_gone_page(base, lang \\ "en") do
    h = &Messages.html(lang, &1, &2)

    page(
      base,
      lang,
      Messages.t(lang, "auth.inviteGoneTitle"),
      "<h1>#{h.("auth.inviteGoneTitle", %{})}</h1>\n<p>#{h.("auth.inviteGone", %{})}</p>"
    )
  end

  def setup_page(base, opts, lang \\ "en") do
    h = &Messages.html(lang, &1, &2)

    code_field =
      if opts[:ask_code],
        do:
          ~s(<label>#{h.("auth.setupToken", %{})}<input type="password" name="code" autocomplete="off" required value="#{esc(opts[:code])}"></label>),
        else: ~s(<input type="hidden" name="code" value="#{esc(opts[:code])}">)

    page(
      base,
      lang,
      Messages.t(lang, "auth.setupTitle"),
      "<h1>#{h.("auth.setupTitle", %{})}</h1>\n<p>#{h.("auth.setupIntro", %{})}</p>\n" <>
        error_line(opts) <>
        "\n" <>
        ~s(<form method="post" action="#{esc(base)}/setup">\n) <>
        code_field <>
        "\n" <>
        ~s(<label>#{h.("auth.email", %{})}<input type="email" name="email" autocomplete="username" required autofocus value="#{esc(opts[:email] || "")}"></label>\n) <>
        ~s(<label>#{h.("auth.password", %{})}<input type="password" name="password" autocomplete="new-password" minlength="10" required></label>\n) <>
        ~s(<label>#{h.("auth.passwordAgain", %{})}<input type="password" name="again" autocomplete="new-password" minlength="10" required></label>\n) <>
        ~s(<button type="submit">#{h.("auth.createAccount", %{})}</button>\n</form>\n) <>
        ~s(<p class="hint">#{h.("auth.passwordHint", %{})}</p>)
    )
  end

  @doc "For a server with no account yet, which prints a setup link with a one-time code in its log."
  def setup_locked_page(base, lang \\ "en") do
    h = &Messages.html(lang, &1, &2)

    page(
      base,
      lang,
      Messages.t(lang, "auth.finishTitle"),
      "<h1>#{h.("auth.finishTitle", %{})}</h1>\n<p>#{h.("auth.setupLocked", %{})}</p>"
    )
  end

  @doc "For an app with accounts on but nothing to prove the first account with."
  def setup_needs_token_page(base, lang \\ "en") do
    h = &Messages.html(lang, &1, &2)

    page(
      base,
      lang,
      Messages.t(lang, "auth.finishTitle"),
      "<h1>#{h.("auth.finishTitle", %{})}</h1>\n<p>#{h.("auth.setupNeedsToken", %{})}</p>"
    )
  end
end

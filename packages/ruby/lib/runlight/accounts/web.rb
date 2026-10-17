# frozen_string_literal: true

module Runlight
  module Accounts
    # Accounts on the web: sign-in, the code step, invites, first-run setup, and the Account and People APIs, under
    # the base path the routes answer at. The standalone server and an app with routes(accounts: true) share it.
    #
    # Who may create the first account ("firstAccount"): the server's printed one-time code ({"code" => ...}), the
    # app's token ({"token" => ...}), anyone ("open", for development), or nobody yet ("locked").
    class Web
      HTML = {
        "content-type" => "text/html; charset=utf-8",
        "cache-control" => "no-store",
        "content-security-policy" => "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-frame-options" => "DENY",
        "referrer-policy" => "same-origin",
      }.freeze

      DEVICE_COOKIE = "runlight_device"
      # Who made each token, kept beside it as a setting, so removing someone or making them a viewer deletes them.
      MADE_BY = "token-by:"
      # When each account was last sent a sign-in link, at most one a minute; a setting, so every process sees it.
      LINK_SENT = "login-link-sent:"
      ESCAPES = { "&" => "&amp;", "<" => "&lt;", ">" => "&gt;", '"' => "&quot;", "'" => "&#39;" }.freeze
      private_constant :HTML, :DEVICE_COOKIE, :MADE_BY, :LINK_SENT, :ESCAPES

      attr_reader :accounts

      # options: "runlight" (the Core, or anything with store, mail_settings, send_mail, and client_ip), "secret",
      # "base", "now" (a callable giving milliseconds), "firstAccount", "home" (optional, a callable giving the
      # install's own origin or nil), "forgot", and "setupWhere" (optional, true), which says the setup
      # link with the one-time code is in the file setup.txt, not in a log.
      def initialize(options)
        @rl = options["runlight"]
        @store = @rl.store
        @base = options["base"]
        @now = options["now"]
        @first = options["firstAccount"]
        @home = options["home"]
        @forgot = options["forgot"]
        @setup_where = options["setupWhere"]
        @accounts = Accounts.new(@store, options["secret"])
        @cookie_path = @base == "" ? "/" : @base
        @home_path = "#{@base}/"
        @asks_for_token = @first.is_a?(Hash) && @first.key?("token")
        @existing = false
        # Wrong passwords are counted three times. Per account and address, ten tries;
        # per account from anywhere, fifty, so a caller who invents a new address
        # for every try still cannot guess on and on. Addresses come from
        # forwarding headers a client can write, so they never stand alone. And per
        # address across every account, thirty, so one caller trying made-up emails
        # cannot keep the server hashing; a request with no known address skips that one,
        # since it would hold up everyone at once.
        # Each try counts before the password is checked, and a right one is taken back.
        @per_address = Throttle.new(@store, "address", 10)
        @per_account = Throttle.new(@store, "account", 50)
        @per_ip = Throttle.new(@store, "ip", 30)
        # Six-digit codes: five wrong tries an account every fifteen minutes, and five to confirm the first one.
        # Password re-checks in Account: ten.
        @code_tries = Throttle.new(@store, "code", 5)
        @confirm_tries = Throttle.new(@store, "confirm", 5)
        @rechecks = Throttle.new(@store, "recheck", 10)
      end

      # A random one-time code, such as the one a server prints to unlock its first account.
      def self.setup_code
        Crypto.base64url(Crypto.random_bytes(9))
      end

      def has_account?
        @existing = @existing || @accounts.count.positive?
      end

      # Only a path on this install, so a sign-in can never send someone elsewhere.
      # Browsers drop tabs and newlines from a URL and read a backslash as a slash,
      # so "/\t/evil.example" would leave; anything with those is refused outright,
      # and what is left must resolve to this origin. A path that resolves to one
      # starting "//", as "/..//evil.example" does, would leave from the Location
      # header, so that goes home too.
      def safe_next(value)
        return @home_path if value.nil? || value == "" || !value.start_with?("/") || value.match?(/[\x00-\x1f\x7f\\]/)

        url = Http::Url.parse(value, "http://runlight.invalid")
        return @home_path if url.nil? || url.origin != "http://runlight.invalid"

        path = "#{url.pathname}#{url.search}#{url.hash}"
        path.start_with?("//") || path.start_with?("/\\") ? @home_path : path
      end

      def signed_in(request)
        value = read_cookie(request, Accounts::SESSION_COOKIE)
        return nil if value == ""

        # A cookie that is not valid percent-encoding is nobody's session, never an error.
        decoded = Js.decode_uri_component(value)
        return nil if decoded.nil?

        @accounts.from_session(decoded, now)
      end

      # What a signed-in person may do: everything (owner and admin, true), "member", "read" (viewer), or nothing (false).
      def access(request)
        user = signed_in(request)
        return false if user.nil?

        # A member changes everything but the install-wide controls; a viewer reads every site and changes nothing.
        if user["role"] == "owner" || user["role"] == "admin"
          true
        else
          user["role"] == "member" ? "member" : "read"
        end
      end

      def account_of(request)
        signed_in(request)&.fetch("id", nil)
      end

      # Notes who made a token. A viewer makes no tokens; someone removed or made a viewer since allowing an app
      # gets none for it, and false takes the token back.
      def token_made(token, by)
        user = @accounts.by_id(by)
        return false if user.nil? || !user["site"].nil?
        role = user["role"]
        return false if role.nil? || role == "viewer"

        @store.set_setting("#{MADE_BY}#{token["id"]}", by)
        true
      end

      # Answers an account page or API request at a path under the base, or nil for anything else.
      # context: {"ip" => the connection's address}, optional.
      def handle(request, path, context = {})
        if path == "/api/account" || path.start_with?("/api/account/") || path == "/api/people" || path.start_with?("/api/people/") ||
           path.start_with?("/api/invites/")
          return api(request, path)
        end

        page = pages(request, path, context)
        return page unless page.nil?

        # The dashboard itself: straight to sign-in, or to setting up the first account.
        if (path == "/" || path == "") && request.method == "GET" && signed_in(request).nil?
          return @first == "open" || @asks_for_token ? redirect("#{@base}/setup") : setup_locked(Messages.accepted_language(request)) unless has_account?

          search = Http::Url.new(request.url).search
          return redirect("#{@base}/login#{search == "" ? "" : "?next=#{Js.encode_uri_component("#{@home_path}#{search}")}"}")
        end
        nil
      end

      def confirm_password(request)
        user = signed_in(request)
        return coded("Sign in first", "sign_in", 401) if user.nil?
        input = body(request)
        return coded("Send JSON", "send_json", 415) if input.nil?
        recheck(user, input, "password", ["Your password is not right", "password_wrong"])
      end

      private

      def now
        @now.call
      end

      # The store's tables, settings among them, which the throttles keep their counts in (TypeScript keeps them
      # in memory), so a fresh install's first sign-in or two-factor change finds them there.
      def ready
        @rl.init if @rl.respond_to?(:init)
      end

      def home_origin
        @home&.call
      end

      def read_cookie(request, name)
        (request.headers.get("cookie") || "").split(";", -1).each do |part|
          pieces = Js.trim(part).split("=", -1)
          key = pieces.shift || ""
          return pieces.join("=") if key == name
        end
        ""
      end

      def secure?(request)
        Http::Url.new(request.url).protocol == "https:" || request.headers.get("x-forwarded-proto") == "https"
      end

      # An error the dashboard words in its own language, as the routes send them.
      def coded(error, code, status, params = nil)
        body = { "error" => error, "code" => code }
        body["params"] = params unless params.nil?
        headers = { "content-type" => "application/json; charset=utf-8", "cache-control" => "no-store", "x-content-type-options" => "nosniff" }
        Http::Response.new(Json.encode(body), status: status, headers: headers)
      end

      def esc(text)
        text.to_s.gsub(/[&<>"']/, ESCAPES)
      end

      def html(body, status = 200, extra = {})
        Http::Response.new(body, status: status, headers: HTML.merge(extra))
      end

      def redirect(location, extra = {})
        Http::Response.new("", status: 303, headers: { "location" => location, "cache-control" => "no-store" }.merge(extra))
      end

      def reply(body, status = 200, extra = {})
        Http::Response.new(Json.encode(body), status: status, headers: { "content-type" => "application/json; charset=utf-8", "cache-control" => "no-store" }.merge(extra))
      end

      def person(u)
        { **(u["site"].nil? ? {} : { "site" => u["site"] }), "id" => u["id"], "email" => u["email"], "role" => u["role"], "createdAt" => u["createdAt"], "twoFactor" => u["twoFactor"], "recoveryLeft" => u["recoveryLeft"] }
      end

      def invite_view(i)
        { **(i["site"].nil? ? {} : { "site" => i["site"] }), "id" => i["id"], "email" => i["email"], "role" => i["role"], "invitedBy" => i["invitedBy"], "createdAt" => i["createdAt"], "expiresAt" => i["expiresAt"] }
      end

      # The media type of a request's body, as a cross-site form cannot send application/json.
      def media_type(request)
        Js.lower(Js.trim((request.headers.get("content-type") || "").split(";", -1)[0] || ""))
      end

      # A JSON body by its media type, which a cross-site form cannot send.
      def body(request)
        return nil if media_type(request) != "application/json"

        parsed, value = Js.parse_json(request.text)
        parsed && value.is_a?(Hash) ? value : nil
      end

      # `String(input[field] ?? "")`.
      def field(input, name)
        value = Js.get(input, name)
        value.nil? || value.equal?(UNDEFINED) ? "" : Js.string(value)
      end

      def drop_tokens_of(id)
        @store.settings_starting_with(MADE_BY).each do |row|
          next if row["value"] != id

          @store.delete_token(row["key"][MADE_BY.length..])
          @store.set_setting(row["key"], nil)
        end
      end

      def session_cookie(request, value, max_age)
        "#{Accounts::SESSION_COOKIE}=#{Js.encode_uri_component(value)}; Path=#{@cookie_path}; HttpOnly; SameSite=Lax; Max-Age=#{max_age}" \
          "#{secure?(request) ? "; Secure" : ""}"
      end

      # The redirect after signing in: a session, and the mark that this browser has signed in to the account.
      def signed_in_to(request, user, next_path)
        headers = Http::Headers.new({ "location" => next_path, "cache-control" => "no-store" })
        headers.append("set-cookie", session_cookie(request, @accounts.session_for(user, now), Accounts::SESSION_MS / 1000))
        headers.append("set-cookie", "#{DEVICE_COOKIE}=#{Js.encode_uri_component(@accounts.device_for(user))}; Path=#{@cookie_path}; HttpOnly; SameSite=Lax; " \
                                     "Max-Age=#{365 * 86_400}#{secure?(request) ? "; Secure" : ""}")
        Http::Response.new("", status: 303, headers: headers)
      end

      # The first account's gate: what the setup form must carry.
      def setup_ok(given)
        return true if @first == "open"
        return false if @first == "locked"

        Crypto.same_text(given, (@first["code"] || @first["token"]).to_s)
      end

      # Why there is no setup form.
      def setup_locked(lang)
        html(@first == "locked" ? Pages.setup_needs_token_page(@base, lang) : Pages.setup_locked_page(@base, Js.truthy?(@setup_where), lang), 403)
      end

      # An account's problem in the visitor's language, where the dashboard has words for it; English as it was raised.
      def reason(lang, error)
        key = "error.#{error.is_a?(AccountError) ? error.code : ""}"
        t = Messages.translator(lang)["t"]
        lang == "en" || t.call(key) == key ? error.message : t.call(key, error.is_a?(AccountError) ? error.params : {})
      end

      # Emails an invite through the mail service when there is one. The link
      # always comes back too, for the inviter to pass on another way.
      def send_invite(request, invite, code)
        origin = home_origin || Http::Url.new(request.url).origin
        link = "#{origin}#{@base}/invite?code=#{code}"
        host = Http::Url.new(origin).host
        what = Pages.role_text(invite["role"], invite["site"])
        return { "link" => link, "emailed" => false } unless @rl.mail_settings

        begin
          @rl.send_mail({
            "to" => invite["email"],
            "subject" => "#{invite["invitedBy"]} invited you to Runlight",
            "text" => "#{invite["invitedBy"]} invited you to the Runlight at #{host} as #{what}.\n\nChoose a password to join:\n#{link}\n\nThe link works for seven days.\n",
            "html" => "<div style=\"font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;max-width:480px\"><img src=\"https://runlight.sh/icon-192.png\" width=\"48\" height=\"48\" alt=\"Runlight\" style=\"display:block;width:48px;height:48px;margin-bottom:24px;border:0;border-radius:10px\"><p>" \
                      "#{esc(invite["invitedBy"])} invited you to the Runlight at #{esc(host)} as #{esc(what)}.</p><p><a href=\"#{esc(link)}\" " \
                      "style=\"display:inline-block;padding:10px 18px;border-radius:8px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600\">" \
                      "Choose a password and join</a></p><p style=\"color:#6b7280;font-size:13px\">The link works for seven days. If you were not expecting this, " \
                      "you can ignore it.</p></div>",
          })
          { "link" => link, "emailed" => true }
        rescue StandardError => e
          # The mail service's code and its details too, so the dashboard can say what went wrong in its own language.
          # Only a String `code` counts, as TypeScript reads `typeof failed.code === "string"`.
          out = { "link" => link, "emailed" => false, "mailError" => e.message }
          if e.respond_to?(:code) && e.code.is_a?(String)
            out["mailCode"] = e.code
            params = e.respond_to?(:params) ? e.params : nil
            out["mailParams"] = params.is_a?(Hash) ? params : {}
          end
          out
        end
      end

      # Emails a sign-in link to an account held up by others' failed tries, at
      # most once a minute. Only to the install's own address, never the Host of
      # the request, so without one known there is no link.
      def send_link(user, next_path)
        origin = home_origin
        return false if origin.nil? || origin == ""

        key = "#{LINK_SENT}#{user["id"]}"
        return true if now - Js.number(@store.setting(key) || 0) < 60_000

        @store.set_setting(key, now.to_s)
        link = "#{origin}#{@base}/login/link?#{Http::SearchParams.new({ "ticket" => @accounts.link_for(user, now), "next" => next_path })}"
        host = Http::Url.new(origin).host
        @rl.send_mail({
          "to" => user["email"],
          "subject" => "Sign in to Runlight",
          "text" => "Someone, most likely you, signed in to Runlight at #{host} with your password while your account was held up by too many failed tries.\n\n" \
                    "Sign in with this link within fifteen minutes:\n#{link}\n\nIf this was not you, change your password, since someone knows it.\n",
          "html" => "<div style=\"font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;max-width:480px\"><img src=\"https://runlight.sh/icon-192.png\" width=\"48\" height=\"48\" alt=\"Runlight\" style=\"display:block;width:48px;height:48px;margin-bottom:24px;border:0;border-radius:10px\">" \
                    "<p>Someone, most likely you, signed in to Runlight at #{esc(host)} with your password while your account was held up by too many failed tries.</p>" \
                    "<p><a href=\"#{esc(link)}\" style=\"display:inline-block;padding:10px 18px;border-radius:8px;background:#111827;color:#ffffff;" \
                    "text-decoration:none;font-weight:600\">Sign in</a></p><p style=\"color:#6b7280;font-size:13px\">The link works for fifteen minutes. " \
                    "If this was not you, change your password, since someone knows it.</p></div>",
        })
        true
      end

      def pages(request, path, context)
        url = Http::Url.new(request.url)
        query = url.search_params
        method = request.method
        base = @base
        lang = Messages.accepted_language(request)
        t = Messages.translator(lang)["t"]
        if path == "/auth.css"
          return Http::Response.new(Pages::AUTH_CSS, status: 200, headers: { "content-type" => "text/css; charset=utf-8", "cache-control" => "public, max-age=3600" })
        end
        if path == "/auth.js"
          return Http::Response.new(Pages.auth_js(query.get("lang") || "en"), status: 200, headers: { "content-type" => "application/javascript; charset=utf-8", "cache-control" => "public, max-age=3600" })
        end

        if path == "/setup"
          return redirect("#{base}/login") if has_account?

          if method == "GET"
            code = query.get("code") || ""
            return setup_locked(lang) if @first == "locked"
            # The app's token is typed in; the server's code comes in the link it printed.
            return html(Pages.setup_page(base, { "code" => "", "askCode" => @asks_for_token }, lang)) if @asks_for_token || @first == "open"

            return setup_ok(code) ? html(Pages.setup_page(base, { "code" => code }, lang)) : setup_locked(lang)
          end
          if method == "POST"
            form = Http::SearchParams.new(request.text)
            code = form.get("code") || ""
            unless setup_ok(code)
              if @asks_for_token
                return html(Pages.setup_page(base, { "code" => "", "askCode" => true, "error" => t.call("auth.tokenWrong"), "email" => form.get("email") || "" }, lang), 403)
              end

              return setup_locked(lang)
            end
            again = ->(error) { { "code" => @asks_for_token ? "" : code, "askCode" => @asks_for_token, "error" => error, "email" => form.get("email") || "" } }
            # Asked twice, since a typo here would lock the first owner out.
            return html(Pages.setup_page(base, again.call(t.call("auth.mismatch")), lang), 400) if (form.get("password") || "") != (form.get("again") || "")

            begin
              user = @accounts.set_password(form.get("email") || "", form.get("password") || "", now)
              @existing = true
              return redirect(@home_path, { "set-cookie" => session_cookie(request, @accounts.session_for(user, now), Accounts::SESSION_MS / 1000) })
            rescue RangeError => e
              return html(Pages.setup_page(base, again.call(reason(lang, e)), lang), 400)
            end
          end
        end

        if path == "/login"
          unless has_account?
            return setup_locked(lang) if @first == "locked"

            return @first == "open" || @asks_for_token ? redirect("#{base}/setup") : setup_locked(lang)
          end
          return html(Pages.login_page(base, { "next" => safe_next(query.get("next")), "forgot" => @forgot }, lang)) if method == "GET"
          return login(request, context) if method == "POST"
        end

        # The link a locked account's owner is emailed: the code step with two-factor on, else straight in.
        if path == "/login/link" && method == "GET"
          next_path = safe_next(query.get("next"))
          user = @accounts.from_link(query.get("ticket") || "", now)
          if user.nil?
            return html(Pages.login_page(base, { "error" => t.call("auth.linkExpired"), "next" => next_path, "forgot" => @forgot }, lang), 410)
          end
          return html(Pages.code_page(base, { "pending" => @accounts.pending_for(user, now), "next" => next_path }, lang)) if user["twoFactor"]

          return signed_in_to(request, user, next_path)
        end

        if path == "/login/code" && method == "POST"
          ready
          form = Http::SearchParams.new(request.text)
          next_path = safe_next(form.get("next"))
          user = @accounts.from_pending(form.get("pending") || "", now)
          return redirect("#{base}/login?next=#{Js.encode_uri_component(next_path)}") if user.nil?

          # Counted before the check, so a burst cannot get past five.
          unless @code_tries.take(user["id"], now)
            return html(Pages.code_page(base, { "pending" => form.get("pending") || "", "next" => next_path, "error" => t.call("error.too_many_tries") }, lang), 429)
          end
          unless @accounts.check_second_factor(user["id"], form.get("code") || "", now)
            return html(Pages.code_page(base, { "pending" => form.get("pending") || "", "next" => next_path,
                                                "error" => t.call("auth.codeWrong") }, lang), 401)
          end

          @code_tries.clear(user["id"], now)
          return signed_in_to(request, user, next_path)
        end

        return redirect("#{base}/login", { "set-cookie" => session_cookie(request, "", 0) }) if path == "/logout"

        if path == "/invite"
          if method == "GET"
            code = query.get("code") || ""
            invite = @accounts.invite_by_code(code, now)
            return html(Pages.invite_gone_page(base, lang), 410) if invite.nil?

            return html(Pages.invite_page(base, { "code" => code, "email" => invite["email"], "role" => invite["role"], "site" => invite["site"], "host" => url.host }, lang))
          end
          if method == "POST"
            form = Http::SearchParams.new(request.text)
            code = form.get("code") || ""
            invite = @accounts.invite_by_code(code, now)
            return html(Pages.invite_gone_page(base, lang), 410) if invite.nil?

            again = lambda do |error|
              html(Pages.invite_page(base, { "code" => code, "email" => invite["email"], "role" => invite["role"], "site" => invite["site"], "host" => url.host, "error" => error }, lang), 400)
            end
            return again.call(t.call("auth.mismatch")) if (form.get("password") || "") != (form.get("again") || "")

            begin
              user = @accounts.accept_invite(code, form.get("password") || "", now)
              @existing = true
              return redirect(@home_path, { "set-cookie" => session_cookie(request, @accounts.session_for(user, now), Accounts::SESSION_MS / 1000) })
            rescue RangeError => e
              return html(Pages.invite_gone_page(base, lang), 410) if e.is_a?(AccountError) && e.code == "invite_gone"

              return again.call(reason(lang, e))
            end
          end
        end
        nil
      end

      def login(request, context)
        ready
        base = @base
        form = Http::SearchParams.new(request.text)
        email = form.get("email") || ""
        password = form.get("password") || ""
        next_path = safe_next(form.get("next"))
        account = Js.lower(Js.trim(email))
        ip = @rl.client_ip(request, context)
        pair = "#{account}\n#{ip == "" ? "unknown" : ip}"
        lang = Messages.accepted_language(request)
        t = Messages.translator(lang)["t"]
        login_page = ->(opts) { Pages.login_page(base, opts.merge("next" => next_path, "forgot" => @forgot) { |_k, mine, _theirs| mine }, lang) }
        too_many = -> { html(login_page.call({ "error" => t.call("error.too_many_tries"), "email" => email }), 429) }
        return too_many.call if ip != "" && !@per_ip.take(ip, now)
        return too_many.call unless @per_address.take(pair, now)

        # A browser that signed in to the account before is never held up by others' failures.
        known = @accounts.by_email(account)
        trusted = !known.nil? && @accounts.trusts_device(read_cookie(request, DEVICE_COOKIE), known)
        over = !trusted && !@per_account.take(account, now)
        # Past the account's limit, a right password and a wrong one get the same answer, and so does every
        # account, with two-factor on or not, and an email with no account, so guessing from many addresses
        # learns nothing about either. The owner still gets in: a right password emails a sign-in link, which
        # leads to the code step when two-factor is on.
        if over
          home = home_origin
          return too_many.call if !@rl.mail_settings || home.nil? || home == ""

          user = @accounts.sign_in(email, password)
          unless user.nil?
            # Sent once the answer is out, as TypeScript does, so a right password takes no longer to answer than a
            # wrong one.
            @rl.later do
              send_link(user, next_path)
            rescue StandardError => e
              warn "Runlight: could not send a sign-in link #{e.message}"
            end
          end
          return html(login_page.call({ "error" => t.call("auth.tooManyLink"), "email" => email }), 429)
        end
        user = @accounts.sign_in(email, password)
        return html(login_page.call({ "error" => t.call("auth.wrongPassword"), "email" => email }), 401) if user.nil?


        @per_address.clear(pair, now)
        @per_ip.forgive(ip, now) if ip != ""
        @per_account.forgive(account, now) unless trusted
        # With two-factor on, the password only earns the second step.
        return html(Pages.code_page(base, { "pending" => @accounts.pending_for(user, now), "next" => next_path }, lang)) if user["twoFactor"]

        signed_in_to(request, user, next_path)
      rescue AccountError => e
        # Too many password checks already waiting, so this one was never run: try again in a moment.
        raise unless e.code == "busy"

        html(login_page.call({ "error" => reason(lang, e), "email" => email }), 503, { "retry-after" => "5" })
      end

      def recheck(user, input, name, wrong)
        return coded("Too many tries. Wait fifteen minutes and try again.", "too_many_tries", 429) unless @rechecks.take(user["id"], now)
        begin
          right = @accounts.sign_in(user["email"], field(input, name))
        rescue AccountError => e
          raise unless e.code == "busy"

          return coded("Runlight is busy checking other sign-ins. Try again in a moment.", "busy", 503)
        end
        return coded(wrong[0], wrong[1], 400) if right.nil?

        @rechecks.forgive(user["id"], now)
        nil
      end

      # Your own account, and for the owner and admins, everyone else's.
      def api(request, path)
        user = signed_in(request)
        return coded("Sign in first", "sign_in", 401) if user.nil?

        ready
        now = self.now
        method = request.method
        # Writes must be JSON, which a form on another page cannot send, even those with no body.
        return coded("Send JSON", "send_json", 415) if method == "POST" && media_type(request) != "application/json"
        return reply({ "account" => person(user) }) if path == "/api/account" && method == "GET"

        fresh = ->(updated) { { "set-cookie" => session_cookie(request, @accounts.session_for(updated, now), Accounts::SESSION_MS / 1000) } }
        if path == "/api/account/password" && method == "POST"
          input = body(request)
          return coded("Send JSON", "send_json", 415) if input.nil?

          refused = recheck(user, input, "current", ["Your current password is not right", "password_current_wrong"])
          return refused unless refused.nil?

          begin
            updated = @accounts.set_password(user["email"], field(input, "next"), now)
            # The new password ends every other sign-in; this browser gets a fresh one.
            return reply({ "ok" => true }, 200, fresh.call(updated))
          rescue AccountError => e
            return coded(e.message, e.code, 400, e.params)
          end
        end
        # Two-factor: turning it on, confirming the first code, new recovery codes, and turning it off.
        # Each change asks for the password again, so a browser left signed in cannot quietly change it.
        if path.start_with?("/api/account/2fa") && method == "POST"
          input = body(request)
          return coded("Send JSON", "send_json", 415) if input.nil?

          action = path["/api/account/2fa".length..]
          # Confirming asks for no password, so it has its own few tries, after which the set-up starts again.
          if action == "/confirm"
            unless @confirm_tries.take(user["id"], now)
              @accounts.cancel_two_factor_setup(user["id"])
              return coded("Too many wrong codes. Start turning on two-factor sign-in again.", "twofactor_restart", 429)
            end
            codes = @accounts.confirm_two_factor(user["id"], field(input, "code").gsub(/[#{Js::SPACE}]/o, ""), now)
            return coded("That code is not right. Check the time on your phone and try the next one.", "code_wrong", 400) if codes.nil?

            @confirm_tries.clear(user["id"], now)
            # Turning it on signs out every other browser; this one gets a new session.
            updated = @accounts.by_id(user["id"])
            return reply({ "recovery" => codes }, 200, fresh.call(updated))
          end
          refused = recheck(user, input, "password", ["Your password is not right", "password_wrong"])
          return refused unless refused.nil?

          if action == "/start"
            @confirm_tries.clear(user["id"], now)
            secret = @accounts.start_two_factor(user["id"])
            return reply({ "secret" => secret, "uri" => Crypto.otpauth_uri(secret, user["email"], Http::Url.new(request.url).host) })
          end
          if action == "/recovery"
            return coded("Turn on two-factor sign-in first", "twofactor_off", 400) unless user["twoFactor"]

            return reply({ "recovery" => @accounts.new_recovery_codes(user["id"]) })
          end
          if action == "/disable"
            @accounts.disable_two_factor(user["id"])
            # Sessions follow two-factor's state, so this browser gets a new one and stays signed in.
            updated = @accounts.by_id(user["id"])
            return reply({ "ok" => true }, 200, fresh.call(updated))
          end
          return coded("Not found", "not_found", 404)
        end
        return coded("Only the owner or an admin can manage people", "people_owner", 403) if !user["site"].nil? || (user["role"] != "owner" && user["role"] != "admin")

        # The owner or an admin can turn off someone else's two-factor, for a coworker who lost both phone and recovery
        # codes, though never the owner's. It asks for their password like every other two-factor change, and their own
        # goes through Account.
        if (reset = path.match(%r{\A/api/people/([a-f0-9]{24})/2fa\z})) && method == "DELETE"
          return coded("Turn off your own two-factor sign-in under Account", "twofactor_self", 400) if reset[1] == user["id"]

          input = body(request)
          return coded("Send JSON", "send_json", 415) if input.nil?

          refused = recheck(user, input, "password", ["Your password is not right", "password_wrong"])
          return refused unless refused.nil?

          target = @accounts.by_id(reset[1])
          return coded("Unknown account", "unknown_account", 404) if target.nil?
          return coded("Only the owner can change the owner's account", "owner_protected", 403) if target["role"] == "owner"

          @accounts.disable_two_factor(reset[1])
          return reply({ "ok" => true })
        end
        # The owner hands ownership to an admin and becomes an admin, after typing their password again.
        if (hand_over = path.match(%r{\A/api/people/([a-f0-9]{24})/owner\z})) && method == "POST"
          return coded("Only the owner can hand over ownership", "owner_hand_over", 403) if user["role"] != "owner"

          input = body(request)
          return coded("Send JSON", "send_json", 415) if input.nil?

          refused = recheck(user, input, "password", ["Your password is not right", "password_wrong"])
          return refused unless refused.nil?

          begin
            @accounts.hand_over(user["id"], hand_over[1])
            return reply({ "people" => @accounts.list.map { |u| person(u) } })
          rescue AccountError => e
            return coded(e.message, e.code, e.code == "unknown_account" ? 404 : 400, e.params)
          end
        end
        # Nobody is invited as, or made, the owner: there is one, and they hand it over themselves.
        role_of = ->(value) { %w[admin member viewer].include?(value) ? value : nil }
        if path == "/api/people" && method == "GET"
          return reply({ "people" => @accounts.list.map { |u| person(u) }, "invites" => @accounts.invites(now).map { |i| invite_view(i) } })
        end
        if path == "/api/people" && method == "POST"
          input = body(request)
          return coded("Send JSON", "send_json", 415) if input.nil?

          role = role_of.call(Js.get(input, "role"))
          return coded("Pick admin, member, or viewer", "role_needed", 400) if role.nil?

          email = Js.lower(Js.trim(field(input, "email")))
          return coded("#{email} already has an account", "account_exists", 409, { "email" => email }) unless @accounts.by_email(email).nil?

          begin
            @rl.init
            site = input["allSites"] == true ? nil : input["site"]
            return coded("Choose a site or explicitly invite to all sites", "invite_site", 400) if input["allSites"] != true && (!site.is_a?(String) || site.empty?)
            return coded("Unknown site", "unknown_site", 404) if !site.nil? && @rl.site(site).nil?
            made = @accounts.invite(email, role, user["email"], now, site)
            return reply({ "invite" => invite_view(made["invite"]) }.merge(send_invite(request, made["invite"], made["code"])), 201)
          rescue AccountError => e
            return coded(e.message, e.code, 400, e.params)
          end
        end
        if (invite_match = path.match(%r{\A/api/invites/([a-f0-9]{24})(/resend)?\z}))
          resend = !invite_match[2].nil? && invite_match[2] != ""
          if method == "DELETE" && !resend
            return @accounts.cancel_invite(invite_match[1]) ? reply({ "ok" => true }) : coded("Unknown invite", "unknown_invite", 404)
          end
          if method == "POST" && resend
            old = @accounts.invites(now).find { |one| one["id"] == invite_match[1] }
            return coded("Unknown invite", "unknown_invite", 404) if old.nil?

            # A new link replaces the old one, which stops working.
            made = @accounts.invite(old["email"], old["role"], user["email"], now, old["site"])
            return reply({ "invite" => invite_view(made["invite"]) }.merge(send_invite(request, made["invite"], made["code"])))
          end
        end
        if (match = path.match(%r{\A/api/people/([a-f0-9]{24})\z})) && (method == "PATCH" || method == "DELETE")
          begin
            if method == "DELETE"
              return coded("You cannot remove yourself", "remove_self", 400) if match[1] == user["id"]

              @accounts.remove(match[1])
              # The tokens they made, and the apps they connected, stop working with them.
              drop_tokens_of(match[1])
              return reply({ "ok" => true })
            end
            input = body(request)
            return coded("Send JSON", "send_json", 415) if input.nil?

            role = role_of.call(Js.get(input, "role"))
            return coded("Pick admin, member, or viewer", "role_needed", 400) if role.nil?

            changed = @accounts.set_role(match[1], role)
            # A viewer changes nothing, so the tokens they made before go too.
            drop_tokens_of(match[1]) if role == "viewer"
            return reply({ "person" => person(changed) })
          rescue AccountError => e
            status = if e.code == "unknown_account" then 404
                     elsif e.code == "owner_protected" then 403
                     else 400
                     end
            return coded(e.message, e.code, status, e.params)
          end
        end
        coded("Not found", "not_found", 404)
      end

    end
  end
end

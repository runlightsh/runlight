package runlight

import (
	"context"
	"regexp"
	"slices"
	"strings"
	"sync"

	"runlight.sh/go/internal/accounts"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/messages"
	"runlight.sh/go/internal/web"
	"runlight.sh/go/internal/whatwg"
)

// Accounts on the web: sign-in, the code step, invites, first-run setup, and
// the Account and People APIs, under the base path the routes answer at. The
// standalone server and an app with RoutesOptions.Accounts share it.

// FirstAccount says who may create the first account: the server's printed
// one-time code (Mode "code"), the app's token ("token"), anyone in
// development ("open"), or nobody ("locked").
type FirstAccount struct {
	Mode  string
	Code  string
	Token string
}

// AccountsWebOptions configure the accounts.
type AccountsWebOptions struct {
	Runlight *Runlight
	// Secret signs sessions and seals two-factor secrets. Keep it stable across restarts.
	Secret string
	// Base is the path the routes answer under: "" on the standalone server, "/runlight" in an app.
	Base         string
	Now          func() int64
	FirstAccount FirstAccount
	// Home is the address emails link to: the install's public one when known. Without it, a locked
	// account gets no link.
	Home func(context.Context) string
	// Forgot is where the sign-in page sends someone who forgot their password.
	Forgot string
}

// AccountsWeb is the accounts' pages and APIs.
type AccountsWeb struct {
	// Accounts are the accounts themselves.
	Accounts *AccountStore

	o            AccountsWebOptions
	r            *Runlight
	cookiePath   string
	home         string
	perAddress   *Throttle
	perAccount   *Throttle
	perIP        *Throttle
	codeTries    *Throttle
	confirmTries *Throttle
	rechecks     *Throttle
	mu           sync.Mutex
	linkSent     map[string]int64
	existing     bool
}

var htmlHeaders = []string{
	"content-type", "text/html; charset=utf-8",
	"cache-control", "no-store",
	"content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	"x-frame-options", "DENY",
	"referrer-policy", "same-origin",
}

const deviceCookie = "runlight_device"

// madeBy is who made each token, kept beside it as a setting, so removing
// someone or making them a viewer deletes them.
const madeBy = "token-by:"

// NewAccountsWeb makes the accounts' pages and APIs.
func NewAccountsWeb(options AccountsWebOptions) *AccountsWeb {
	// Wrong passwords are counted three times. Per account and address, ten tries; per account from anywhere,
	// fifty, so a caller who invents a new address for every try still cannot guess on and on. And per address
	// across every account, thirty, so one caller trying made-up emails cannot keep the server hashing; a
	// request with no known address skips that one, since it would hold up everyone at once. Six-digit
	// codes: five wrong tries an account every fifteen minutes, and five to confirm the first one.
	// Password re-checks in Account: ten.
	return &AccountsWeb{
		Accounts: NewAccountStore(options.Runlight.Store, options.Secret), o: options, r: options.Runlight,
		cookiePath: firstNonEmpty(options.Base, "/"), home: options.Base + "/",
		perAddress: NewThrottle(10, 0), perAccount: NewThrottle(50, 0), perIP: NewThrottle(30, 0), codeTries: NewThrottle(5, 0), confirmTries: NewThrottle(5, 0), rechecks: NewThrottle(10, 0),
		linkSent: map[string]int64{},
	}
}

// SetupCode is a random one-time code, such as the one a server prints to unlock its first account.
func SetupCode() string { return accounts.Base64url(accounts.RandomBytes(9)) }

func (w *AccountsWeb) now() int64 { return w.o.Now() }

// HasAccount reports whether any account exists yet.
func (w *AccountsWeb) HasAccount(ctx context.Context) (bool, error) {
	w.mu.Lock()
	existing := w.existing
	w.mu.Unlock()
	if existing {
		return true, nil
	}
	n, err := w.Accounts.Count(ctx)
	if err != nil {
		return false, err
	}
	if n > 0 {
		w.mu.Lock()
		w.existing = true
		w.mu.Unlock()
	}
	return n > 0, nil
}

func (w *AccountsWeb) setExisting() {
	w.mu.Lock()
	w.existing = true
	w.mu.Unlock()
}

var unsafeNext = regexp.MustCompile(`[\x00-\x1f\x7f\\]`)

// safeNext is only a path on this install, so a sign-in can never send someone elsewhere.
// A path that resolves to one starting "//", as "/..//evil.example" does, would
// leave from the Location header, so that goes home too.
func (w *AccountsWeb) safeNext(value string) string {
	if value == "" || !strings.HasPrefix(value, "/") || unsafeNext.MatchString(value) {
		return w.home
	}
	u, err := whatwg.Parse(value, "http://runlight.invalid")
	if err != nil || u.Origin() != "http://runlight.invalid" {
		return w.home
	}
	path := u.Pathname + u.Search + u.Hash
	if strings.HasPrefix(path, "//") || strings.HasPrefix(path, "/\\") {
		return w.home
	}
	return path
}

// SignedIn is the account a request is signed in as, or nil.
func (w *AccountsWeb) SignedIn(ctx context.Context, request *Request) (*User, error) {
	value := readCookie(request, SessionCookie)
	if value == "" {
		return nil, nil
	}
	// A cookie that is not valid percent-encoding is nobody's session, never an error.
	decoded, ok := decodeURIComponent(value)
	if !ok {
		return nil, nil
	}
	return w.Accounts.FromSession(ctx, decoded, w.now())
}

func (w *AccountsWeb) dropTokensOf(ctx context.Context, id string) error {
	settings, err := w.r.Store.SettingsStartingWith(ctx, madeBy)
	if err != nil {
		return err
	}
	for _, s := range settings {
		if s.Value != id {
			continue
		}
		if _, err := w.r.Store.DeleteToken(ctx, s.Key[len(madeBy):]); err != nil {
			return err
		}
		if err := w.r.Store.SetSetting(ctx, s.Key, nil); err != nil {
			return err
		}
	}
	return nil
}

func isSecure(request *Request) bool {
	return request.Parsed().Protocol == "https:" || request.Header.Get("x-forwarded-proto") == "https"
}

func (w *AccountsWeb) sessionCookie(request *Request, value string, maxAge int64) string {
	secure := ""
	if isSecure(request) {
		secure = "; Secure"
	}
	return SessionCookie + "=" + encodeURIComponent(value) + "; Path=" + w.cookiePath + "; HttpOnly; SameSite=Lax; Max-Age=" + js.FormatNumber(float64(maxAge)) + secure
}

func (w *AccountsWeb) freshSession(request *Request, user User) (string, error) {
	session, err := w.Accounts.SessionFor(user, w.now())
	if err != nil {
		return "", err
	}
	return w.sessionCookie(request, session, SessionMs/1000), nil
}

// signedInTo is the redirect after signing in: a session, and the mark that this browser has signed in to the account.
func (w *AccountsWeb) signedInTo(request *Request, user User, next string) (*Response, error) {
	cookie, err := w.freshSession(request, user)
	if err != nil {
		return nil, err
	}
	device, err := w.Accounts.DeviceFor(user)
	if err != nil {
		return nil, err
	}
	secure := ""
	if isSecure(request) {
		secure = "; Secure"
	}
	answer := web.NewResponse(303, nil, "location", next, "cache-control", "no-store")
	answer.Header.Append("set-cookie", cookie)
	answer.Header.Append("set-cookie", deviceCookie+"="+encodeURIComponent(device)+"; Path="+w.cookiePath+"; HttpOnly; SameSite=Lax; Max-Age="+js.FormatNumber(365*86_400)+secure)
	return answer, nil
}

func html(body string, status int, extra ...string) *Response {
	r := web.NewResponse(status, []byte(body), htmlHeaders...)
	for i := 0; i+1 < len(extra); i += 2 {
		r.Header.Set(extra[i], extra[i+1])
	}
	return r
}

func redirect(location string, extra ...string) *Response {
	r := web.NewResponse(303, nil, "location", location, "cache-control", "no-store")
	for i := 0; i+1 < len(extra); i += 2 {
		r.Header.Set(extra[i], extra[i+1])
	}
	return r
}

func reply(body any, status int, extra ...string) *Response {
	r := web.NewResponse(status, []byte(js.Stringify(body)), "content-type", "application/json; charset=utf-8", "cache-control", "no-store")
	for i := 0; i+1 < len(extra); i += 2 {
		r.Header.Set(extra[i], extra[i+1])
	}
	return r
}

// accountCoded is an error the dashboard words in its own language, as the routes send them.
func accountCoded(message, code string, status int, p *js.Object) *Response {
	return Coded(message, code, status, p)
}

func person(u User) *js.Object {
	out := js.NewObject("id", u.ID, "email", u.Email, "role", u.Role, "createdAt", u.CreatedAt, "twoFactor", u.TwoFactor, "recoveryLeft", u.RecoveryLeft)
	if u.Site != "" {
		out.Set("site", u.Site)
	}
	return out
}

func inviteView(i Invite) *js.Object {
	out := js.NewObject("id", i.ID, "email", i.Email, "role", i.Role, "invitedBy", i.InvitedBy, "createdAt", i.CreatedAt, "expiresAt", i.ExpiresAt)
	if i.Site != "" {
		out.Set("site", i.Site)
	}
	return out
}

// jsonBody is a JSON body by its media type, which a cross-site form cannot send; nil for anything else.
func jsonBody(request *Request) *js.Object {
	if !isJSON(request) {
		return nil
	}
	parsed, err := request.JSON()
	if err != nil {
		return nil
	}
	o, _ := parsed.(*js.Object)
	return o
}

// setupOk is the first account's gate: whether the setup form carries what it must.
func (w *AccountsWeb) setupOk(given string) bool {
	switch w.o.FirstAccount.Mode {
	case "open":
		return true
	case "code":
		return accounts.SameText(given, w.o.FirstAccount.Code)
	case "token":
		return accounts.SameText(given, w.o.FirstAccount.Token)
	}
	return false
}

func (w *AccountsWeb) setupLocked(lang string) *Response {
	if w.o.FirstAccount.Mode == "locked" {
		return html(accounts.SetupNeedsTokenPage(w.o.Base, lang), 403)
	}
	return html(accounts.SetupLockedPage(w.o.Base, lang), 403)
}

// reason is an account's problem in the visitor's language, where the dashboard has words for it; English as it was thrown.
func reason(tr messages.Translator, err error) string {
	var ae *AccountError
	if tr.Lang == "en" || !asAccountError(err, &ae) {
		return err.Error()
	}
	key := "error." + ae.Code
	vars := map[string]string{}
	if ae.Params != nil {
		ae.Params.Each(func(k string, v any) { vars[k] = js.String(v) })
	}
	if text := tr.T(key, vars); text != key {
		return text
	}
	return err.Error()
}

func (w *AccountsWeb) asksForToken() bool { return w.o.FirstAccount.Mode == "token" }

func (w *AccountsWeb) homeOf(ctx context.Context) string {
	if w.o.Home == nil {
		return ""
	}
	return w.o.Home(ctx)
}

// sendInvite emails an invite through the mail service when there is one.
// The link always comes back too, for the inviter to pass on another way.
func (w *AccountsWeb) sendInvite(ctx context.Context, request *Request, invite Invite, code string) (*js.Object, error) {
	origin := w.homeOf(ctx)
	if origin == "" {
		origin = request.Parsed().Origin()
	}
	link := origin + w.o.Base + "/invite?code=" + code
	host := whatwg.MustParse(origin).Host()
	what := accounts.RoleText(invite.Role, invite.Site, "en")
	settings, err := w.r.MailSettings(ctx)
	if err != nil {
		return nil, err
	}
	if settings == nil {
		return js.NewObject("link", link, "emailed", false), nil
	}
	err = w.r.SendMail(ctx, MailMessage{
		To:      invite.Email,
		Subject: invite.InvitedBy + " invited you to Runlight",
		Text:    invite.InvitedBy + " invited you to the Runlight at " + host + " as " + what + ".\n\nChoose a password to join:\n" + link + "\n\nThe link works for seven days.\n",
		HTML:    `<div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;max-width:480px"><img src="https://runlight.sh/icon-192.png" width="48" height="48" alt="Runlight" style="display:block;width:48px;height:48px;margin-bottom:24px;border:0;border-radius:10px"><p>` + escapeHTML(invite.InvitedBy) + ` invited you to the Runlight at ` + escapeHTML(host) + ` as ` + escapeHTML(what) + `.</p><p><a href="` + escapeHTML(link) + `" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600">Choose a password and join</a></p><p style="color:#6b7280;font-size:13px">The link works for seven days. If you were not expecting this, you can ignore it.</p></div>`,
	})
	if err != nil {
		// The mail service's code and its details too, so the dashboard can say what went wrong in its own language.
		out := js.NewObject("link", link, "emailed", false, "mailError", err.Error())
		if c := mailErrorOf(err); c != nil {
			out.Set("mailCode", c.Code)
			params := c.Params
			if params == nil {
				params = &js.Object{}
			}
			out.Set("mailParams", params)
		} else if c := codedOf(err); c != nil {
			out.Set("mailCode", c.Code)
			out.Set("mailParams", c.Params)
		}
		return out, nil
	}
	return js.NewObject("link", link, "emailed", true), nil
}

// sendLink emails a sign-in link to an account held up by others' failed
// tries, at most once a minute. Only to the install's own address, never
// the Host of the request, so without one known there is no link.
func (w *AccountsWeb) sendLink(ctx context.Context, user User, next string) error {
	origin := w.homeOf(ctx)
	if origin == "" {
		return nil
	}
	w.mu.Lock()
	if w.now()-w.linkSent[user.ID] < 60_000 {
		w.mu.Unlock()
		return nil
	}
	w.linkSent[user.ID] = w.now()
	w.mu.Unlock()
	ticket, err := w.Accounts.LinkFor(user, w.now())
	if err != nil {
		return err
	}
	link := origin + w.o.Base + "/login/link?" + whatwg.NewSearchParams("ticket", ticket, "next", next).String()
	host := whatwg.MustParse(origin).Host()
	return w.r.SendMail(ctx, MailMessage{
		To:      user.Email,
		Subject: "Sign in to Runlight",
		Text:    "Someone, most likely you, signed in to Runlight at " + host + " with your password while your account was held up by too many failed tries.\n\nSign in with this link within fifteen minutes:\n" + link + "\n\nIf this was not you, change your password, since someone knows it.\n",
		HTML:    `<div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827;max-width:480px"><img src="https://runlight.sh/icon-192.png" width="48" height="48" alt="Runlight" style="display:block;width:48px;height:48px;margin-bottom:24px;border:0;border-radius:10px"><p>Someone, most likely you, signed in to Runlight at ` + escapeHTML(host) + ` with your password while your account was held up by too many failed tries.</p><p><a href="` + escapeHTML(link) + `" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#111827;color:#ffffff;text-decoration:none;font-weight:600">Sign in</a></p><p style="color:#6b7280;font-size:13px">The link works for fifteen minutes. If this was not you, change your password, since someone knows it.</p></div>`,
	})
}

func formOf(request *Request) *whatwg.SearchParams { return whatwg.ParseQuery(request.Text()) }

func (w *AccountsWeb) pages(ctx context.Context, request *Request, path string) (*Response, error) {
	u := request.Parsed()
	method := request.Method
	base := w.o.Base
	if path == "/auth.css" {
		return web.NewResponse(200, []byte(accounts.AuthCSS), "content-type", "text/css; charset=utf-8", "cache-control", "public, max-age=3600"), nil
	}
	lang := acceptedLanguage(request)
	tr := messages.New(lang)
	if path == "/auth.js" {
		asked := "en"
		if q := u.SearchParams(); q.Has("lang") {
			asked = q.Value("lang")
		}
		return web.NewResponse(200, []byte(accounts.AuthJSFor(asked)), "content-type", "application/javascript; charset=utf-8", "cache-control", "public, max-age=3600"), nil
	}
	// A form posted from another site, or a sibling one, could sign someone in to an account that is not theirs or
	// plant a session, so these pages take forms only from their own. The browser says where a request came from.
	if site := request.Header.Get("sec-fetch-site"); (site == "cross-site" || site == "same-site") && (method == "POST" || path == "/logout") &&
		slices.Contains([]string{"/setup", "/login", "/login/code", "/invite", "/logout"}, path) {
		home := w.home
		return html(accounts.LoginPage(base, accounts.LoginOptions{Error: tr.T("oauth.anotherSiteTitle", nil), Next: &home, Forgot: w.o.Forgot}, lang), 403), nil
	}
	if path == "/setup" {
		has, err := w.HasAccount(ctx)
		if err != nil {
			return nil, err
		}
		if has {
			return redirect(base + "/login"), nil
		}
		if method == "GET" {
			code := u.SearchParams().Value("code")
			if w.o.FirstAccount.Mode == "locked" {
				return w.setupLocked(lang), nil
			}
			// The app's token is typed in; the server's code comes in the link it printed.
			if w.asksForToken() || w.o.FirstAccount.Mode == "open" {
				return html(accounts.SetupPage(base, accounts.SetupOptions{AskCode: w.asksForToken()}, lang), 200), nil
			}
			if w.setupOk(code) {
				return html(accounts.SetupPage(base, accounts.SetupOptions{Code: code}, lang), 200), nil
			}
			return w.setupLocked(lang), nil
		}
		if method == "POST" {
			form := formOf(request)
			code := form.Value("code")
			if !w.setupOk(code) {
				if w.asksForToken() {
					return html(accounts.SetupPage(base, accounts.SetupOptions{AskCode: true, Error: tr.T("auth.tokenWrong", nil), Email: form.Value("email")}, lang), 403), nil
				}
				return w.setupLocked(lang), nil
			}
			kept := code
			if w.asksForToken() {
				kept = ""
			}
			// Asked twice, since a typo here would lock the first owner out.
			if form.Value("password") != form.Value("again") {
				return html(accounts.SetupPage(base, accounts.SetupOptions{Code: kept, AskCode: w.asksForToken(), Error: tr.T("auth.mismatch", nil), Email: form.Value("email")}, lang), 400), nil
			}
			user, err := w.Accounts.SetPassword(ctx, form.Value("email"), form.Value("password"), w.now(), "")
			if err != nil {
				if isRangeError(err) {
					return html(accounts.SetupPage(base, accounts.SetupOptions{Code: kept, AskCode: w.asksForToken(), Error: reason(tr, err), Email: form.Value("email")}, lang), 400), nil
				}
				return nil, err
			}
			w.setExisting()
			cookie, err := w.freshSession(request, user)
			if err != nil {
				return nil, err
			}
			return redirect(w.home, "set-cookie", cookie), nil
		}
	}

	if path == "/login" {
		has, err := w.HasAccount(ctx)
		if err != nil {
			return nil, err
		}
		if !has {
			if w.o.FirstAccount.Mode != "locked" && (w.o.FirstAccount.Mode == "open" || w.asksForToken()) {
				return redirect(base + "/setup"), nil
			}
			return w.setupLocked(lang), nil
		}
		if method == "GET" {
			next := w.safeNext(u.SearchParams().Value("next"))
			return html(accounts.LoginPage(base, accounts.LoginOptions{Next: &next, Forgot: w.o.Forgot}, lang), 200), nil
		}
		if method == "POST" {
			return w.login(ctx, request)
		}
	}

	// The link a locked account's owner is emailed: the code step with two-factor on, else straight in.
	if path == "/login/link" && method == "GET" {
		q := u.SearchParams()
		next := w.safeNext(q.Value("next"))
		user, err := w.Accounts.FromLink(ctx, q.Value("ticket"), w.now())
		if err != nil {
			return nil, err
		}
		if user == nil {
			return html(accounts.LoginPage(base, accounts.LoginOptions{Error: tr.T("auth.linkExpired", nil), Next: &next, Forgot: w.o.Forgot}, lang), 410), nil
		}
		if user.TwoFactor {
			pending, err := w.Accounts.PendingFor(*user, w.now())
			if err != nil {
				return nil, err
			}
			return html(accounts.CodePage(base, accounts.CodeOptions{Pending: pending, Next: next}, lang), 200), nil
		}
		return w.signedInTo(request, *user, next)
	}

	if path == "/login/code" && method == "POST" {
		form := formOf(request)
		next := w.safeNext(form.Value("next"))
		user, err := w.Accounts.FromPending(ctx, form.Value("pending"), w.now())
		if err != nil {
			return nil, err
		}
		if user == nil {
			return redirect(base + "/login?next=" + encodeURIComponent(next)), nil
		}
		// Counted before the check, so a burst cannot get past five.
		if !w.codeTries.Take(user.ID, w.now()) {
			return html(accounts.CodePage(base, accounts.CodeOptions{Pending: form.Value("pending"), Next: next, Error: tr.T("error.too_many_tries", nil)}, lang), 429), nil
		}
		ok, err := w.Accounts.CheckSecondFactor(ctx, user.ID, form.Value("code"), w.now())
		if err != nil {
			return nil, err
		}
		if !ok {
			return html(accounts.CodePage(base, accounts.CodeOptions{Pending: form.Value("pending"), Next: next, Error: tr.T("auth.codeWrong", nil)}, lang), 401), nil
		}
		w.codeTries.Clear(user.ID)
		return w.signedInTo(request, *user, next)
	}

	// Signing out ends this browser's session; the account page can end them everywhere.
	if path == "/logout" {
		return redirect(base+"/login", "set-cookie", w.sessionCookie(request, "", 0)), nil
	}

	if path == "/invite" {
		if method == "GET" {
			code := u.SearchParams().Value("code")
			invite, err := w.Accounts.InviteByCode(ctx, code, w.now())
			if err != nil {
				return nil, err
			}
			if invite == nil {
				return html(accounts.InviteGonePage(base, lang), 410), nil
			}
			return html(accounts.InvitePage(base, accounts.InviteOptions{Code: code, Email: invite.Email, Role: invite.Role, Site: invite.Site, Host: u.Host()}, lang), 200), nil
		}
		if method == "POST" {
			form := formOf(request)
			code := form.Value("code")
			invite, err := w.Accounts.InviteByCode(ctx, code, w.now())
			if err != nil {
				return nil, err
			}
			if invite == nil {
				return html(accounts.InviteGonePage(base, lang), 410), nil
			}
			again := func(message string) *Response {
				return html(accounts.InvitePage(base, accounts.InviteOptions{Code: code, Email: invite.Email, Role: invite.Role, Site: invite.Site, Host: u.Host(), Error: message}, lang), 400)
			}
			if form.Value("password") != form.Value("again") {
				return again(tr.T("auth.mismatch", nil)), nil
			}
			user, err := w.Accounts.AcceptInvite(ctx, code, form.Value("password"), w.now())
			if err != nil {
				var ae *AccountError
				if asAccountError(err, &ae) && ae.Code == "invite_gone" {
					return html(accounts.InviteGonePage(base, lang), 410), nil
				}
				if isRangeError(err) {
					return again(reason(tr, err)), nil
				}
				return nil, err
			}
			w.setExisting()
			cookie, err := w.freshSession(request, user)
			if err != nil {
				return nil, err
			}
			return redirect(w.home, "set-cookie", cookie), nil
		}
	}
	return nil, nil
}

func (w *AccountsWeb) login(ctx context.Context, request *Request) (*Response, error) {
	base := w.o.Base
	lang := acceptedLanguage(request)
	tr := messages.New(lang)
	form := formOf(request)
	email, password := form.Value("email"), form.Value("password")
	next := w.safeNext(form.Value("next"))
	account := lower(jsTrim(email))
	ip := w.r.ClientIP(request)
	pair := account + "\n" + firstNonEmpty(ip, "unknown")
	page := func(message string) string {
		return accounts.LoginPage(base, accounts.LoginOptions{Error: message, Email: email, Next: &next, Forgot: w.o.Forgot}, lang)
	}
	tooMany := func() *Response { return html(page(tr.T("error.too_many_tries", nil)), 429) }
	// Too many password checks already waiting, so this one was never run: try again in a moment.
	busy := func(err error) (*Response, error) {
		var ae *AccountError
		if asAccountError(err, &ae) && ae.Code == "busy" {
			return html(page(reason(tr, err)), 503, "retry-after", "5"), nil
		}
		return nil, err
	}
	if ip != "" && !w.perIP.Take(ip, w.now()) {
		return tooMany(), nil
	}
	if !w.perAddress.Take(pair, w.now()) {
		return tooMany(), nil
	}
	// A browser that signed in to the account before is never held up by others' failures.
	known, err := w.Accounts.ByEmail(ctx, account)
	if err != nil {
		return nil, err
	}
	trusted := known != nil && w.Accounts.TrustsDevice(readCookie(request, deviceCookie), *known)
	over := !trusted && !w.perAccount.Take(account, w.now())
	// Past the account's limit, a right password and a wrong one get the same answer, and so does every
	// account, with two-factor on or not, and an email with no account, so guessing from many addresses
	// learns nothing about either. The owner still gets in: a right password emails a sign-in link, which
	// leads to the code step when two-factor is on.
	if over {
		settings, err := w.r.MailSettings(ctx)
		if err != nil {
			return nil, err
		}
		if settings == nil || w.homeOf(ctx) == "" {
			return tooMany(), nil
		}
		user, err := w.Accounts.SignIn(ctx, email, password)
		if err != nil {
			return busy(err)
		}
		if user != nil {
			// Sent after the answer, so a right password is no slower than a wrong one.
			signedIn := *user
			w.r.later(func(ctx context.Context) {
				if err := w.sendLink(ctx, signedIn, next); err != nil {
					w.r.logf("Runlight: could not send a sign-in link %v", err)
				}
			})
		}
		return html(page(tr.T("auth.tooManyLink", nil)), 429), nil
	}
	user, err := w.Accounts.SignIn(ctx, email, password)
	if err != nil {
		return busy(err)
	}
	if user == nil {
		return html(page(tr.T("auth.wrongPassword", nil)), 401), nil
	}
	w.perAddress.Clear(pair)
	if ip != "" {
		w.perIP.Forgive(ip)
	}
	if !trusted {
		w.perAccount.Forgive(account)
	}
	// With two-factor on, the password only earns the second step.
	if user.TwoFactor {
		pending, err := w.Accounts.PendingFor(*user, w.now())
		if err != nil {
			return nil, err
		}
		return html(accounts.CodePage(base, accounts.CodeOptions{Pending: pending, Next: next}, lang), 200), nil
	}
	return w.signedInTo(request, *user, next)
}

var (
	resetPath    = regexp.MustCompile(`^/api/people/([a-f0-9]{24})/2fa$`)
	handOverPath = regexp.MustCompile(`^/api/people/([a-f0-9]{24})/owner$`)
	invitePath   = regexp.MustCompile(`^/api/invites/([a-f0-9]{24})(/resend)?$`)
	personPath   = regexp.MustCompile(`^/api/people/([a-f0-9]{24})$`)
)

func accountErrorAnswer(err error, status int) (*Response, error) {
	var ae *AccountError
	if c := codedOf(err); c != nil && asAccountError(err, &ae) {
		return accountCoded(c.Message, c.Code, status, c.Params), nil
	}
	return nil, err
}

func asAccountError(err error, target **AccountError) bool {
	for err != nil {
		if a, ok := err.(*AccountError); ok {
			*target = a
			return true
		}
		u, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

func (w *AccountsWeb) recheck(ctx context.Context, user *User, input *js.Object, key, message, code string) (*Response, error) {
	if !w.rechecks.Take(user.ID, w.now()) {
		return accountCoded("Too many tries. Wait fifteen minutes and try again.", "too_many_tries", 429, nil), nil
	}
	ok, err := w.Accounts.SignIn(ctx, user.Email, field(input, key))
	if err != nil {
		var ae *AccountError
		if asAccountError(err, &ae) && ae.Code == "busy" {
			return accountCoded("Runlight is busy checking other sign-ins. Try again in a moment.", "busy", 503, nil), nil
		}
		return nil, err
	}
	if ok == nil {
		return accountCoded(message, code, 400, nil), nil
	}
	w.rechecks.Forgive(user.ID)
	return nil, nil
}

func (w *AccountsWeb) ConfirmPassword(ctx context.Context, request *Request) (*Response, error) {
	user, err := w.SignedIn(ctx, request)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return accountCoded("Sign in first", "sign_in", 401, nil), nil
	}
	if !isJSON(request) {
		return accountCoded("Send JSON", "send_json", 415, nil), nil
	}
	input := jsonBody(request)
	if input == nil {
		return accountCoded("Send JSON", "send_json", 415, nil), nil
	}
	return w.recheck(ctx, user, input, "password", "Your password is not right", "password_wrong")
}

// api answers your own account, and for the owner and admins, everyone else's.
func (w *AccountsWeb) api(ctx context.Context, request *Request, path string) (*Response, error) {
	user, err := w.SignedIn(ctx, request)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return accountCoded("Sign in first", "sign_in", 401, nil), nil
	}
	// Writes must be JSON, which a form on another page cannot send, even those with no body.
	if request.Method == "POST" && !isJSON(request) {
		return accountCoded("Send JSON", "send_json", 415, nil), nil
	}
	if path == "/api/account" && request.Method == "GET" {
		return reply(js.NewObject("account", person(*user)), 200), nil
	}
	// Ends the account's sessions in every browser, this one too, so a cookie copied before stops working.
	if path == "/api/account/sign-out-everywhere" && request.Method == "POST" {
		if err := w.Accounts.EndSessions(ctx, user.ID); err != nil {
			return nil, err
		}
		return reply(js.NewObject("ok", true), 200, "set-cookie", w.sessionCookie(request, "", 0)), nil
	}
	if path == "/api/account/password" && request.Method == "POST" {
		input := jsonBody(request)
		if input == nil {
			return accountCoded("Send JSON", "send_json", 415, nil), nil
		}
		if refused, err := w.recheck(ctx, user, input, "current", "Your current password is not right", "password_current_wrong"); refused != nil || err != nil {
			return refused, err
		}
		updated, err := w.Accounts.SetPassword(ctx, user.Email, field(input, "next"), w.now(), "")
		if err != nil {
			return accountErrorAnswer(err, 400)
		}
		// Asked for after a password got out: the tokens and apps the account made could still read on.
		if input.Value("revokeTokens") == true {
			if err := w.dropTokensOf(ctx, user.ID); err != nil {
				return nil, err
			}
		}
		// The new password ends every other sign-in; this browser gets a fresh one.
		cookie, err := w.freshSession(request, updated)
		if err != nil {
			return nil, err
		}
		return reply(js.NewObject("ok", true), 200, "set-cookie", cookie), nil
	}
	// Two-factor: turning it on, confirming the first code, new recovery codes, and turning it off. Each
	// change asks for the password again, so a browser left signed in cannot quietly change it.
	if strings.HasPrefix(path, "/api/account/2fa") && request.Method == "POST" {
		input := jsonBody(request)
		if input == nil {
			return accountCoded("Send JSON", "send_json", 415, nil), nil
		}
		action := path[len("/api/account/2fa"):]
		// Confirming asks for no password, so it has its own few tries, after which the set-up starts again.
		if action == "/confirm" {
			if !w.confirmTries.Take(user.ID, w.now()) {
				if err := w.Accounts.CancelTwoFactorSetup(ctx, user.ID); err != nil {
					return nil, err
				}
				return accountCoded("Too many wrong codes. Start turning on two-factor sign-in again.", "twofactor_restart", 429, nil), nil
			}
			codes, err := w.Accounts.ConfirmTwoFactor(ctx, user.ID, jsSpaces.ReplaceAllString(field(input, "code"), ""), w.now())
			if err != nil {
				return nil, err
			}
			if codes == nil {
				return accountCoded("That code is not right. Check the time on your phone and try the next one.", "code_wrong", 400, nil), nil
			}
			w.confirmTries.Clear(user.ID)
			// Turning it on signs out every other browser; this one gets a new session.
			updated, err := w.Accounts.ByID(ctx, user.ID)
			if err != nil {
				return nil, err
			}
			cookie, err := w.freshSession(request, *updated)
			if err != nil {
				return nil, err
			}
			return reply(js.NewObject("recovery", codes), 200, "set-cookie", cookie), nil
		}
		if refused, err := w.recheck(ctx, user, input, "password", "Your password is not right", "password_wrong"); refused != nil || err != nil {
			return refused, err
		}
		switch action {
		case "/start":
			w.confirmTries.Clear(user.ID)
			secret, err := w.Accounts.StartTwoFactor(ctx, user.ID)
			if err != nil {
				return nil, err
			}
			return reply(js.NewObject("secret", secret, "uri", accounts.OtpauthURI(secret, user.Email, request.Parsed().Host())), 200), nil
		case "/recovery":
			if !user.TwoFactor {
				return accountCoded("Turn on two-factor sign-in first", "twofactor_off", 400, nil), nil
			}
			codes, err := w.Accounts.NewRecoveryCodes(ctx, user.ID)
			if err != nil {
				return nil, err
			}
			return reply(js.NewObject("recovery", codes), 200), nil
		case "/disable":
			if err := w.Accounts.DisableTwoFactor(ctx, user.ID); err != nil {
				return nil, err
			}
			// Sessions follow two-factor's state, so this browser gets a new one and stays signed in.
			updated, err := w.Accounts.ByID(ctx, user.ID)
			if err != nil {
				return nil, err
			}
			cookie, err := w.freshSession(request, *updated)
			if err != nil {
				return nil, err
			}
			return reply(js.NewObject("ok", true), 200, "set-cookie", cookie), nil
		}
		return accountCoded("Not found", "not_found", 404, nil), nil
	}
	if user.Site != "" || (user.Role != "owner" && user.Role != "admin") {
		return accountCoded("Only the owner or an admin can manage people", "people_owner", 403, nil), nil
	}
	// The owner or an admin can turn off someone else's two-factor, for a coworker who lost both phone and
	// recovery codes, though never the owner's.
	if m := resetPath.FindStringSubmatch(path); m != nil && request.Method == "DELETE" {
		if m[1] == user.ID {
			return accountCoded("Turn off your own two-factor sign-in under Account", "twofactor_self", 400, nil), nil
		}
		input := jsonBody(request)
		if input == nil {
			return accountCoded("Send JSON", "send_json", 415, nil), nil
		}
		if refused, err := w.recheck(ctx, user, input, "password", "Your password is not right", "password_wrong"); refused != nil || err != nil {
			return refused, err
		}
		target, err := w.Accounts.ByID(ctx, m[1])
		if err != nil {
			return nil, err
		}
		if target == nil {
			return accountCoded("Unknown account", "unknown_account", 404, nil), nil
		}
		if target.Role == "owner" {
			return accountCoded("Only the owner can change the owner's account", "owner_protected", 403, nil), nil
		}
		if err := w.Accounts.DisableTwoFactor(ctx, m[1]); err != nil {
			return nil, err
		}
		return reply(js.NewObject("ok", true), 200), nil
	}
	// The owner hands ownership to an admin and becomes an admin, after typing their password again.
	if m := handOverPath.FindStringSubmatch(path); m != nil && request.Method == "POST" {
		if user.Role != "owner" {
			return accountCoded("Only the owner can hand over ownership", "owner_hand_over", 403, nil), nil
		}
		input := jsonBody(request)
		if input == nil {
			return accountCoded("Send JSON", "send_json", 415, nil), nil
		}
		if refused, err := w.recheck(ctx, user, input, "password", "Your password is not right", "password_wrong"); refused != nil || err != nil {
			return refused, err
		}
		if err := w.Accounts.HandOver(ctx, user.ID, m[1]); err != nil {
			status := 400
			if c := codedOf(err); c != nil && c.Code == "unknown_account" {
				status = 404
			}
			return accountErrorAnswer(err, status)
		}
		return w.people(ctx, false)
	}
	// Nobody is invited as, or made, the owner: there is one, and they hand it over themselves.
	roleOf := func(v any) string {
		if s, ok := v.(string); ok && (s == "admin" || s == "member" || s == "viewer") {
			return s
		}
		return ""
	}
	if path == "/api/people" && request.Method == "GET" {
		return w.people(ctx, true)
	}
	if path == "/api/people" && request.Method == "POST" {
		input := jsonBody(request)
		if input == nil {
			return accountCoded("Send JSON", "send_json", 415, nil), nil
		}
		role := roleOf(input.Value("role"))
		if role == "" {
			return accountCoded("Pick admin, member, or viewer", "role_needed", 400, nil), nil
		}
		email := lower(jsTrim(field(input, "email")))
		existing, err := w.Accounts.ByEmail(ctx, email)
		if err != nil {
			return nil, err
		}
		if existing != nil {
			return accountCoded(email+" already has an account", "account_exists", 409, params("email", email)), nil
		}
		if err := w.r.Init(ctx); err != nil {
			return nil, err
		}
		var sites []string
		if input.Value("allSites") != true {
			site, ok := input.Value("site").(string)
			if !ok || site == "" {
				return accountCoded("Choose a site or explicitly invite to all sites", "invite_site", 400, nil), nil
			}
			if _, ok := w.r.Site(site); !ok {
				return accountCoded("Unknown site", "unknown_site", 404, nil), nil
			}
			sites = []string{site}
		}
		invite, code, err := w.Accounts.InviteSomeone(ctx, email, role, user.Email, w.now(), sites...)
		if err != nil {
			return accountErrorAnswer(err, 400)
		}
		sent, err := w.sendInvite(ctx, request, invite, code)
		if err != nil {
			return nil, err
		}
		out := js.NewObject("invite", inviteView(invite))
		sent.Each(func(k string, v any) { out.Set(k, v) })
		return reply(out, 201), nil
	}
	if m := invitePath.FindStringSubmatch(path); m != nil && request.Method == "DELETE" && m[2] == "" {
		ok, err := w.Accounts.CancelInvite(ctx, m[1])
		if err != nil {
			return nil, err
		}
		if ok {
			return reply(js.NewObject("ok", true), 200), nil
		}
		return accountCoded("Unknown invite", "unknown_invite", 404, nil), nil
	}
	if m := invitePath.FindStringSubmatch(path); m != nil && request.Method == "POST" && m[2] != "" {
		invites, err := w.Accounts.Invites(ctx, w.now())
		if err != nil {
			return nil, err
		}
		var old *Invite
		for i := range invites {
			if invites[i].ID == m[1] {
				old = &invites[i]
			}
		}
		if old == nil {
			return accountCoded("Unknown invite", "unknown_invite", 404, nil), nil
		}
		// A new link replaces the old one, which stops working.
		var sites []string
		if old.Site != "" {
			sites = []string{old.Site}
		}
		invite, code, err := w.Accounts.InviteSomeone(ctx, old.Email, old.Role, user.Email, w.now(), sites...)
		if err != nil {
			return nil, err
		}
		sent, err := w.sendInvite(ctx, request, invite, code)
		if err != nil {
			return nil, err
		}
		out := js.NewObject("invite", inviteView(invite))
		sent.Each(func(k string, v any) { out.Set(k, v) })
		return reply(out, 200), nil
	}
	if m := personPath.FindStringSubmatch(path); m != nil && (request.Method == "PATCH" || request.Method == "DELETE") {
		status := func(err error) int {
			if c := codedOf(err); c != nil {
				switch c.Code {
				case "unknown_account":
					return 404
				case "owner_protected":
					return 403
				}
			}
			return 400
		}
		if request.Method == "DELETE" {
			if m[1] == user.ID {
				return accountCoded("You cannot remove yourself", "remove_self", 400, nil), nil
			}
			if err := w.Accounts.Remove(ctx, m[1]); err != nil {
				return accountErrorAnswer(err, status(err))
			}
			// The tokens they made, and the apps they connected, stop working with them.
			if err := w.dropTokensOf(ctx, m[1]); err != nil {
				return nil, err
			}
			return reply(js.NewObject("ok", true), 200), nil
		}
		input := jsonBody(request)
		if input == nil {
			return accountCoded("Send JSON", "send_json", 415, nil), nil
		}
		role := roleOf(input.Value("role"))
		if role == "" {
			return accountCoded("Pick admin, member, or viewer", "role_needed", 400, nil), nil
		}
		changed, err := w.Accounts.SetRole(ctx, m[1], role)
		if err != nil {
			return accountErrorAnswer(err, status(err))
		}
		// A viewer changes nothing, so the tokens they made before go too.
		if role == "viewer" {
			if err := w.dropTokensOf(ctx, m[1]); err != nil {
				return nil, err
			}
		}
		return reply(js.NewObject("person", person(changed)), 200), nil
	}
	return accountCoded("Not found", "not_found", 404, nil), nil
}

func (w *AccountsWeb) people(ctx context.Context, withInvites bool) (*Response, error) {
	users, err := w.Accounts.List(ctx)
	if err != nil {
		return nil, err
	}
	people := []any{}
	for _, u := range users {
		people = append(people, person(u))
	}
	out := js.NewObject("people", people)
	if withInvites {
		invites, err := w.Accounts.Invites(ctx, w.now())
		if err != nil {
			return nil, err
		}
		views := []any{}
		for _, i := range invites {
			views = append(views, inviteView(i))
		}
		out.Set("invites", views)
	}
	return reply(out, 200), nil
}

// Access is what a signed-in person may do: everything (owner and admin), member, read (viewer), or nothing.
func (w *AccountsWeb) Access(ctx context.Context, request *Request) Access {
	user, err := w.SignedIn(ctx, request)
	if err != nil || user == nil {
		return AccessNone
	}
	// A member changes everything but the install-wide controls; a viewer reads every site and changes nothing.
	switch user.Role {
	case "owner", "admin":
		return AccessFull
	case "member":
		return AccessMember
	}
	return AccessRead
}

// AccountOf is the id of the account a request is signed in as, or "".
func (w *AccountsWeb) AccountOf(ctx context.Context, request *Request) string {
	user, err := w.SignedIn(ctx, request)
	if err != nil || user == nil {
		return ""
	}
	return user.ID
}

// TokenMade notes who made a token. A viewer makes no tokens; someone
// removed or made a viewer since allowing an app gets none for it.
func (w *AccountsWeb) TokenMade(ctx context.Context, token TokenRow, by string) bool {
	user, err := w.Accounts.ByID(ctx, by)
	if err != nil || user == nil || user.Site != "" || user.Role == "viewer" {
		return false
	}
	return w.r.Store.SetSetting(ctx, madeBy+token.ID, &by) == nil
}

// TokensOf is the ids of the tokens an account made.
func (w *AccountsWeb) TokensOf(ctx context.Context, by string) (map[string]bool, error) {
	settings, err := w.r.Store.SettingsStartingWith(ctx, madeBy)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for _, s := range settings {
		if s.Value == by {
			out[s.Key[len(madeBy):]] = true
		}
	}
	return out, nil
}

// Handle answers an account page or API request at a path under the base, or nil for anything else.
func (w *AccountsWeb) Handle(ctx context.Context, request *Request, path string) (*Response, error) {
	if path == "/api/account" || strings.HasPrefix(path, "/api/account/") || path == "/api/people" || strings.HasPrefix(path, "/api/people/") || strings.HasPrefix(path, "/api/invites/") {
		return w.api(ctx, request, path)
	}
	page, err := w.pages(ctx, request, path)
	if err != nil || page != nil {
		return page, err
	}
	// The dashboard itself: straight to sign-in, or to setting up the first account.
	if (path == "/" || path == "") && request.Method == "GET" {
		user, err := w.SignedIn(ctx, request)
		if err != nil {
			return nil, err
		}
		if user != nil {
			return nil, nil
		}
		has, err := w.HasAccount(ctx)
		if err != nil {
			return nil, err
		}
		if !has {
			if w.o.FirstAccount.Mode == "open" || w.asksForToken() {
				return redirect(w.o.Base + "/setup"), nil
			}
			return w.setupLocked(acceptedLanguage(request)), nil
		}
		search := request.Parsed().Search
		target := w.o.Base + "/login"
		if search != "" {
			target += "?next=" + encodeURIComponent(w.home+search)
		}
		return redirect(target), nil
	}
	return nil, nil
}

package dbtest

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	runlight "runlight.sh/go"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/web"
)

func TestTheAppsOwnMailerSendsUntilAServiceSavedInTheDashboardTakesItsPlace(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC).UnixMilli()
	sent := []runlight.AppMessage{}
	fail := ""
	calls := []string{}
	rl, err := runlight.New(runlight.Options{
		Store: Store(t, Kinds()[0]),
		Logf:  func(string, ...any) {},
		Site:  &runlight.SiteOptions{ID: "example", Name: "Example", Hostnames: []string{"example.com"}, Timezone: "UTC"},
		Now:   func() int64 { return now },
		Fetcher: web.FetchFunc(func(_ context.Context, url string, _ web.FetchInit) (*web.Response, error) {
			calls = append(calls, url)
			return web.JSONResponse(js.NewObject("id", "x"), 200), nil
		}),
		AppMailer: &runlight.AppMailer{
			From:     "site@example.com",
			FromName: "Example",
			Via:      "WordPress (WP Mail SMTP)",
			Send: func(_ context.Context, m runlight.AppMessage) error {
				if fail != "" {
					return errors.New(fail)
				}
				sent = append(sent, m)
				return nil
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	secret := "t"
	routes, err := rl.Routes(runlight.RoutesOptions{Token: &secret})
	if err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body string) *runlight.Response {
		t.Helper()
		var b []byte
		if body != "" {
			b = []byte(body)
		}
		return routes.Handle(ctx, web.NewRequest(method, "https://stats.example.com/runlight"+path, web.NewHeaders("authorization", "Bearer t", "content-type", "application/json"), b))
	}
	bodyOf := func(r *runlight.Response) *js.Object {
		t.Helper()
		v, err := js.Parse(string(r.Body))
		if err != nil {
			t.Fatalf("%d %s", r.Status, r.Body)
		}
		return v.(*js.Object)
	}
	pick := func(o *js.Object, keys ...string) string {
		out := &js.Object{}
		for _, k := range keys {
			out.Set(k, o.Value(k))
		}
		return js.Stringify(out)
	}

	app := bodyOf(call("GET", "/api/mail", ""))
	if got, want := pick(app, "source", "service", "from", "fromName", "fields", "saved", "app"),
		`{"source":"app","service":"","from":"site@example.com","fromName":"Example","fields":{},"saved":[],"app":{"via":"WordPress (WP Mail SMTP)","from":"site@example.com","fromName":"Example","replaced":false}}`; got != want {
		t.Errorf("the app's mailer:\n%s\n%s", got, want)
	}
	if keys := app.Keys(); keys[len(keys)-1] != "app" {
		t.Errorf("app comes last: %v", keys)
	}

	if r := call("POST", "/api/mail/test", `{"to":"jon@example.com"}`); r.Status != 200 {
		t.Fatalf("the test email: %d %s", r.Status, r.Body)
	}
	if len(sent) != 1 || sent[0].To != "jon@example.com" || sent[0].From != "site@example.com" || sent[0].FromName != "Example" {
		t.Fatalf("sent: %+v", sent)
	}
	if !strings.Contains(sent[0].Text, "WordPress (WP Mail SMTP)") {
		t.Errorf("the test names the app's mailer: %s", sent[0].Text)
	}

	// Reports go through it too, with the unsubscribe headers.
	if r := call("POST", "/api/reports?site=example", `{"email":"jon@example.com","frequency":"weekly"}`); r.Status != 201 {
		t.Fatalf("a report: %d %s", r.Status, r.Body)
	}
	now += 7 * 86_400_000
	if count, err := rl.SendReports(ctx); err != nil || count != (runlight.ReportsCount{Sent: 1}) {
		t.Fatalf("reports: %+v %v", count, err)
	}
	if len(sent) != 2 || sent[1].Headers == nil {
		t.Fatalf("the report: %+v", sent)
	}
	if v := js.Str(sent[1].Headers.Value("List-Unsubscribe")); !regexp.MustCompile(`^<https://stats\.example\.com/runlight/unsubscribe/[a-f0-9]{32}>$`).MatchString(v) {
		t.Errorf("List-Unsubscribe: %s", v)
	}
	if v := js.Str(sent[1].Headers.Value("List-Unsubscribe-Post")); v != "List-Unsubscribe=One-Click" {
		t.Errorf("List-Unsubscribe-Post: %s", v)
	}

	// A failure comes back as a mail error naming the mailer. (A test through one mailer goes at most once a minute.)
	now += 60_000
	fail = "SMTP connect() failed"
	failed := call("POST", "/api/mail/test", `{"to":"jon@example.com"}`)
	if want := `{"error":"WordPress (WP Mail SMTP) could not send it: SMTP connect() failed","code":"mail_app_failed","params":{"via":"WordPress (WP Mail SMTP)","detail":"SMTP connect() failed"}}`; failed.Status != 400 || string(failed.Body) != want {
		t.Errorf("a failure: %d %s", failed.Status, failed.Body)
	}
	fail = ""

	// A service saved in the dashboard takes its place.
	if r := call("PUT", "/api/mail", `{"service":"resend","apiKey":"re_live_key","from":"reports@example.com"}`); r.Status != 200 {
		t.Fatalf("saving a service: %d %s", r.Status, r.Body)
	}
	replaced := bodyOf(call("GET", "/api/mail", ""))
	if got, want := pick(replaced, "source", "service", "from", "app"),
		`{"source":"dashboard","service":"resend","from":"reports@example.com","app":{"via":"WordPress (WP Mail SMTP)","from":"site@example.com","fromName":"Example","replaced":true}}`; got != want {
		t.Errorf("replaced:\n%s\n%s", got, want)
	}
	if r := call("POST", "/api/mail/test", `{"to":"jon@example.com"}`); r.Status != 200 {
		t.Fatalf("the test email through the service: %d %s", r.Status, r.Body)
	}
	if len(calls) != 1 {
		t.Errorf("through the saved service: %v", calls)
	}
	if len(sent) != 2 {
		t.Errorf("and not the app's mailer: %d", len(sent))
	}

	// Removing it goes back to the app's mailer.
	if r := call("DELETE", "/api/mail", ""); r.Status != 200 {
		t.Fatalf("removing the service: %d %s", r.Status, r.Body)
	}
	if source := bodyOf(call("GET", "/api/mail", "")).Value("source"); source != "app" {
		t.Errorf("back to the app's mailer: %v", source)
	}
	if r := call("POST", "/api/mail/test", `{"to":"jon@example.com"}`); r.Status != 200 || len(sent) != 3 {
		t.Errorf("the test email after: %d %s, %d sent", r.Status, r.Body, len(sent))
	}
	// Another test through it straight away waits a minute, so the button cannot flood an inbox.
	if again := call("POST", "/api/mail/test", `{"to":"jon@example.com"}`); again.Status != 429 || bodyOf(again).Value("code") != "test_soon" || len(sent) != 3 {
		t.Errorf("a second test at once: %d %s, %d sent", again.Status, again.Body, len(sent))
	}
}

func TestTheAppsMailerNeedsAFromAddressAndWithoutOneTheAnswerHasNoApp(t *testing.T) {
	ctx := context.Background()
	store := Store(t, Kinds()[0])
	_, err := runlight.New(runlight.Options{Store: store, Logf: func(string, ...any) {}, AppMailer: &runlight.AppMailer{
		Via: "Drupal", Send: func(context.Context, runlight.AppMessage) error { return nil },
	}})
	if err == nil || !strings.Contains(err.Error(), "from address") {
		t.Errorf("no from address: %v", err)
	}
	rl, err := runlight.New(runlight.Options{Store: store, Logf: func(string, ...any) {}})
	if err != nil {
		t.Fatal(err)
	}
	if rl.AppMailer() != nil {
		t.Error("no app mailer")
	}
	secret := "t"
	routes, err := rl.Routes(runlight.RoutesOptions{Token: &secret})
	if err != nil {
		t.Fatal(err)
	}
	r := routes.Handle(ctx, web.NewRequest("GET", "https://stats.example.com/runlight/api/mail", web.NewHeaders("authorization", "Bearer t"), nil))
	v, err := js.Parse(string(r.Body))
	if err != nil {
		t.Fatalf("%d %s", r.Status, r.Body)
	}
	answer := v.(*js.Object)
	if answer.Value("source") != nil {
		t.Errorf("source: %v", answer.Value("source"))
	}
	if _, ok := answer.Get("app"); ok {
		t.Error("an install without an app mailer answers as before")
	}
}

func TestMailServicesNamesTheServicesSettingsOffers(t *testing.T) {
	ctx := context.Background()
	if _, err := runlight.New(runlight.Options{Store: Store(t, Kinds()[0]), MailServices: []string{"resend", "pigeon"}}); err == nil || err.Error() != `Runlight: MailServices names "pigeon", which is not a mail service` {
		t.Fatalf("%v", err)
	}
	store := Store(t, Kinds()[0])
	app := &runlight.AppMailer{From: "site@example.com", Via: "Drupal", Send: func(context.Context, runlight.AppMessage) error { return nil }}
	secret := "s"
	all, err := runlight.New(runlight.Options{Store: store, Secret: &secret, Logf: func(string, ...any) {}, AppMailer: app})
	if err != nil {
		t.Fatal(err)
	}
	if err := all.SaveMailSettings(ctx, js.NewObject("service", "smtp", "host", "smtp.example.com", "port", "587", "security", "starttls", "from", "reports@example.com")); err != nil {
		t.Fatal(err)
	}
	// Listed in the order of the services, whatever the order given.
	fewer, err := runlight.New(runlight.Options{Store: store, Secret: &secret, Logf: func(string, ...any) {}, AppMailer: app, MailServices: []string{"webhook", "resend"}})
	if err != nil {
		t.Fatal(err)
	}
	// SMTP, saved before and no longer offered, counts as none, so the app's mailer sends.
	settings, err := fewer.MailSettings(ctx)
	if err != nil || js.Stringify(settings) != `{"service":"app","from":"site@example.com","via":"Drupal","source":"app"}` {
		t.Fatalf("%s %v", js.Stringify(settings), err)
	}
	err = fewer.SaveMailSettings(ctx, js.NewObject("service", "smtp", "host", "smtp.example.com", "port", "587", "security", "starttls", "from", "reports@example.com"))
	var refused *runlight.MailError
	if !errors.As(err, &refused) || refused.Code != "mail_service" || refused.Message != "SMTP is not offered here. Pick another mail service" || js.Stringify(refused.Params) != `{"service":"smtp"}` {
		t.Fatalf("%v", err)
	}
	err = fewer.SaveMailSettings(ctx, js.NewObject("service", "pigeon"))
	if !errors.As(err, &refused) || refused.Message != "Pick a mail service" || js.Stringify(refused.Params) != `{}` {
		t.Fatalf("%v", err)
	}
	token := "t"
	routes, err := fewer.Routes(runlight.RoutesOptions{Token: &token})
	if err != nil {
		t.Fatal(err)
	}
	answer := routes.Handle(ctx, web.NewRequest("GET", "https://example.com/runlight/api/mail", web.NewHeaders("authorization", "Bearer t"), nil))
	parsed, _ := js.Parse(answer.Text())
	ids := []string{}
	for _, s := range js.Arr(js.Dig(parsed, "services")) {
		ids = append(ids, js.Str(js.Dig(s, "id")))
	}
	if strings.Join(ids, ",") != "resend,webhook" {
		t.Errorf("services %v", ids)
	}
	none, err := runlight.New(runlight.Options{Store: store, MailServices: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := none.SaveMailSettings(ctx, js.NewObject("service", "resend")); !errors.As(err, &refused) || refused.Code != "mail_service" {
		t.Errorf("an empty list offers none: %v", err)
	}
}

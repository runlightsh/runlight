package runlight

import (
	"context"
	"errors"
	"slices"

	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/mail"
	"runlight.sh/go/internal/web"
)

// seal encrypts a value kept in the database under the install's secret,
// or keeps it readable when there is none.
func (r *Runlight) seal(text string) (string, error) {
	secret := ""
	if r.HasSecret {
		secret = r.Secret
	}
	return mail.Seal(text, secret), nil
}

// unseal opens a sealed value; false when it cannot be opened (a different secret, or damaged).
func (r *Runlight) unseal(sealed string) (string, bool) {
	secret := ""
	if r.HasSecret {
		secret = r.Secret
	}
	return mail.Unseal(sealed, secret)
}

func mailService(id string) *mail.Service {
	for i := range mail.Services {
		if mail.Services[i].ID == id {
			return &mail.Services[i]
		}
	}
	return nil
}

func mailServiceName(id string) string {
	if s := mailService(id); s != nil {
		return s.Name
	}
	return ""
}

func mailErrorOf(err error) *CodedError {
	var me *mail.MailError
	if errors.As(err, &me) {
		return &CodedError{Message: me.Message, Code: me.Code, Params: me.Params}
	}
	return nil
}

// MailMessage is one email.
type MailMessage struct {
	To      string
	Subject string
	Text    string
	HTML    string
	Headers *js.Object
}

// AppMessage is one email as the app's own mailer is given it.
type AppMessage = mail.Message

// MailError is a mail problem to show the person setting it up. An app's
// mailer may return one, and it reaches the dashboard as it is.
type MailError = mail.MailError

// AppMailer is a mailer of the app's own, such as a CMS's, that sends each
// message itself.
type AppMailer struct {
	// Send sends one message. Any error but a *MailError is reported as the
	// mailer's failure, with its text.
	Send func(ctx context.Context, message AppMessage) error
	// From is the address messages come from.
	From     string
	FromName string
	// Via is what the dashboard calls it, such as "WordPress (WP Mail SMTP)".
	Via string
}

// AppMailer is the app's own mailer, used while no service is saved in the
// dashboard; nil when there is none.
func (r *Runlight) AppMailer() *AppMailer {
	if r.appMailer == nil {
		return nil
	}
	app := *r.appMailer
	return &app
}

// MailSettings is the mail Runlight sends with, with its source: a service
// from code, or as saved in the dashboard, or else the app's own mailer, as
// service "app". nil when there is none.
func (r *Runlight) MailSettings(ctx context.Context) (*js.Object, error) {
	if r.mailCode != nil {
		out := r.mailCode.Clone()
		out.Set("source", "code")
		return out, nil
	}
	if err := r.Init(ctx); err != nil {
		return nil, err
	}
	sealed, found, err := r.Store.Setting(ctx, "mail")
	if err != nil {
		return nil, err
	}
	opened, ok := "", false
	if found && sealed != "" {
		opened, ok = r.unseal(sealed)
	}
	// A service no longer offered counts as none, so it is never sent through.
	if ok {
		parsed, err := js.Parse(opened)
		if err != nil {
			return nil, err
		}
		out := js.Obj(parsed)
		if out == nil {
			out = &js.Object{}
		}
		if len(r.mailServices) == len(mail.Services) || r.mailOffered(js.String(out.Value("service"))) {
			out.Set("source", "dashboard")
			return out, nil
		}
	}
	app := r.appMailer
	if app == nil {
		return nil, nil
	}
	out := js.NewObject("service", "app", "from", app.From)
	if app.FromName != "" {
		out.Set("fromName", app.FromName)
	}
	out.Set("via", app.Via)
	out.Set("source", "app")
	return out, nil
}

// mailOffered reports whether Settings offers the mail service with this id.
func (r *Runlight) mailOffered(id string) bool {
	return slices.ContainsFunc(r.mailServices, func(s mail.Service) bool { return s.ID == id })
}

func configOf(settings *js.Object) mail.Config {
	config := mail.Config{}
	settings.Each(func(k string, v any) {
		if v != nil {
			config[k] = js.String(v)
		}
	})
	return config
}

// SaveMailSettings saves the mail service from the dashboard; nil removes
// it. A secret field left blank keeps the saved value, so the browser never
// needs to see it.
func (r *Runlight) SaveMailSettings(ctx context.Context, input *js.Object) error {
	if r.mailCode != nil {
		return &mail.MailError{Message: "The mail service is set in code", Code: "mail_in_code", Params: &js.Object{}}
	}
	if input == nil {
		return r.Store.SetSetting(ctx, "mail", nil)
	}
	before, err := r.MailSettings(ctx)
	if err != nil {
		return err
	}
	// Only a service saved here has secrets to keep, never the app's mailer.
	if before != nil && before.Value("source") != "dashboard" {
		before = nil
	}
	serviceID, _ := input.Value("service").(string)
	service := mailService(serviceID)
	if service == nil {
		return &mail.MailError{Message: "Pick a mail service", Code: "mail_service", Params: &js.Object{}}
	}
	if !r.mailOffered(service.ID) {
		return &mail.MailError{Message: service.Name + " is not offered here. Pick another mail service", Code: "mail_service", Params: js.NewObject("service", service.ID)}
	}
	settings := js.NewObject("service", service.ID)
	for _, f := range service.Fields {
		if !f.Secret {
			settings.Set(f.Name, jsTrim(field(input, f.Name)))
		}
	}
	// A blank secret keeps the saved one only while the connection is the same, so changing the host
	// cannot send a saved password somewhere new.
	same := before != nil && before.Value("service") == service.ID
	if same {
		for _, f := range service.Fields {
			if !f.Secret && field(before, f.Name) != js.Str(settings.Value(f.Name)) {
				same = false
			}
		}
	}
	for _, f := range service.Fields {
		if !f.Secret {
			continue
		}
		given := jsTrim(field(input, f.Name))
		if given == "" && same {
			given = field(before, f.Name)
		}
		settings.Set(f.Name, given)
	}
	from := jsTrim(field(input, "from"))
	if !emailPattern.MatchString(from) {
		return &mail.MailError{Message: "Enter the address reports come from, like reports@example.com", Code: "mail_from", Params: &js.Object{}}
	}
	fromName := head16(jsTrim(field(input, "fromName")), 80)
	settings.Set("from", from)
	if fromName != "" {
		settings.Set("fromName", fromName)
	}
	config := configOf(settings)
	if err := mail.CheckConfig(config); err != nil {
		return err
	}
	if config["service"] == "smtp" && config["host"] != "" && web.MetadataHost(ctx, config["host"]) {
		return &mail.MailError{Message: config["host"] + " is a link-local or cloud metadata address, which Runlight never connects to", Code: "address_refused", Params: js.NewObject("host", config["host"])}
	}
	sealed, err := r.seal(js.Stringify(settings))
	if err != nil {
		return err
	}
	return r.Store.SetSetting(ctx, "mail", &sealed)
}

// SendMail sends one email through the mail service, or the app's own mailer when no service is saved.
func (r *Runlight) SendMail(ctx context.Context, message MailMessage) error {
	settings, err := r.MailSettings(ctx)
	if err != nil {
		return err
	}
	if settings == nil {
		return &mail.MailError{Message: "Set up a mail service first", Code: "mail_unset", Params: &js.Object{}}
	}
	full := mail.Message{
		To: message.To, From: field(settings, "from"), FromName: field(settings, "fromName"),
		Subject: message.Subject, HTML: message.HTML, Text: message.Text, Headers: message.Headers,
	}
	if settings.Value("source") != "app" {
		return mail.Send(ctx, r.fetcher, configOf(settings), full)
	}
	err = r.appMailer.Send(ctx, full)
	if err == nil {
		return nil
	}
	var me *mail.MailError
	if errors.As(err, &me) {
		return err
	}
	via, detail := r.appMailer.Via, err.Error()
	text := via + " could not send it"
	if detail != "" {
		text += ": " + detail
	}
	return &mail.MailError{Message: text, Code: "mail_app_failed", Params: js.NewObject("via", via, "detail", detail)}
}

func (rt *Routes) mailView(c *call) (*Response, error) {
	settings, err := rt.r.MailSettings(c.ctx)
	if err != nil {
		return nil, err
	}
	app := settings != nil && settings.Value("source") == "app"
	var service *mail.Service
	if settings != nil && !app {
		service = mailService(js.String(settings.Value("service")))
	}
	// Secret fields come back only as "saved", never as their value.
	fields := &js.Object{}
	saved := []string{}
	if service != nil {
		for _, f := range service.Fields {
			if f.Secret {
				if js.Truthy(settings.Value(f.Name)) {
					saved = append(saved, f.Name)
				}
			} else {
				fields.Set(f.Name, field(settings, f.Name))
			}
		}
	}
	value := func(key string) any {
		if settings == nil {
			return ""
		}
		v, ok := settings.Get(key)
		if !ok || v == nil {
			return ""
		}
		return v
	}
	var source any
	if settings != nil {
		source = settings.Value("source")
	}
	// A hub with a manage token, or an account kept to one site, learns which service sends the reports and
	// from where, nothing more: a webhook's address is often its own credential.
	scoped, err := rt.sessionScope(c)
	if err != nil {
		return nil, err
	}
	if c.managed != nil || (scoped != nil && scoped.Site != "") {
		fields = &js.Object{}
		saved = []string{}
	}
	serviceID := value("service")
	if app {
		serviceID = ""
	}
	answer := js.NewObject("source", source, "service", serviceID, "from", value("from"), "fromName", value("fromName"),
		"fields", fields, "saved", saved, "encrypted", rt.r.HasSecret, "services", rt.r.mailServices)
	// The app's own mailer, named only when there is one, so the answer without it stays as it was.
	if mailer := rt.r.appMailer; mailer != nil {
		answer.Set("app", js.NewObject("via", mailer.Via, "from", mailer.From, "fromName", mailer.FromName, "replaced", !app))
	}
	return jsonAnswer(answer, 200), nil
}

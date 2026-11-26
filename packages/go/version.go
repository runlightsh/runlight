package runlight

import (
	"encoding/base64"
	"strings"
	"sync"

	"runlight.sh/go/internal/assets"
)

// Version is the release, the same for every Runlight package.
const Version = "0.5.4"

// APIVersion is bumped when the HTTP API changes shape, so the dashboard
// and the hub can tell.
const APIVersion = 1

// Icon is the Runlight mark for the dashboard's tab: an R in a rounded lamp
// housing, one corner lit.
var Icon = assets.Build.Icon

// logoPNG is the mark as a 96 pixel PNG, base64, the same drawing as the
// website's header and the Mac app's icon. Each install serves it at
// <base>/logo.png, without signing in, for its emails.
var logoPNG = assets.Build.LogoPNG

// logoBytes is the email logo's bytes, decoded from base64 the first time it
// is asked for.
var logoBytes = sync.OnceValue(func() []byte {
	b, err := base64.StdEncoding.DecodeString(logoPNG)
	if err != nil {
		panic("runlight: build.json: logoPng: " + err.Error())
	}
	return b
})

// emailLogo is the mark for emails: the PNG at the sending install's own
// /logo.png, shown at 48 pixels. Opening an email fetches it from that
// install and from nowhere else; a client that blocks images shows the word
// Runlight. home is the install's address with its base path, such as
// https://example.com/runlight.
func emailLogo(home string) string {
	src := strings.TrimRight(home, "/") + "/logo.png"
	src = strings.NewReplacer("&", "&amp;", `"`, "&quot;", "<", "&lt;", ">", "&gt;").Replace(src)
	return `<img src="` + src + `" width="48" height="48" alt="Runlight" style="display:block;width:48px;height:48px;margin:0 0 24px;border:0;outline:none;text-decoration:none;font:700 16px/48px -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#6b7280">`
}

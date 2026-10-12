package runlight

import (
	"testing"

	"runlight.sh/go/internal/fixture"
	"runlight.sh/go/internal/js"
)

// The version, the HTTP API's version, and the dashboard icon are the TypeScript SDK's
// (packages/php/tests/fixtures/version.json).
func TestTheVersionsAndIconAreTheTypeScriptSDKs(t *testing.T) {
	f := fixture.PHP(t, "version.json")
	if want := js.Str(js.Dig(f, "version")); Version != want {
		t.Errorf("Version %q, want %q", Version, want)
	}
	if want := int(js.Num(js.Dig(f, "apiVersion"))); APIVersion != want {
		t.Errorf("APIVersion %d, want %d", APIVersion, want)
	}
	if want := js.Str(js.Dig(f, "icon")); Icon != want {
		t.Errorf("Icon %q, want %q", Icon, want)
	}
}

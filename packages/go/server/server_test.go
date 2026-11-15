package server

import (
	"strings"
	"testing"
)

func TestAShortSecretOrTokenIsWarnedAbout(t *testing.T) {
	if got := ShortWarning("RUNLIGHT_SECRET", strings.Repeat("s", 32)); got != "" {
		t.Errorf("32 characters: %s", got)
	}
	if got := ShortWarning("RUNLIGHT_TOKEN", ""); got != "" {
		t.Errorf("unset: %s", got)
	}
	want := "Runlight: WARNING: RUNLIGHT_SECRET is only 6 characters long. It signs every session and encrypts the saved mail and assistant keys. Set it to 32 or more random characters, such as the output of: openssl rand -hex 32"
	if got := ShortWarning("RUNLIGHT_SECRET", "secret"); got != want {
		t.Errorf("got %s", got)
	}
	want = "Runlight: WARNING: RUNLIGHT_TOKEN is only 5 characters long. Anyone who guesses it has the whole API, as the owner. Set it to 32 or more random characters, such as the output of: openssl rand -hex 32"
	if got := ShortWarning("RUNLIGHT_TOKEN", "token"); got != want {
		t.Errorf("got %s", got)
	}
}

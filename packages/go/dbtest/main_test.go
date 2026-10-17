package dbtest

import (
	"os"
	"testing"

	"runlight.sh/go/internal/accounts"
)

// The suites sign in hundreds of times, and a password check at the real cost takes a second under the race
// detector, so they hash at a small one. The tests of the cost itself set the real one back.
func TestMain(m *testing.M) {
	accounts.SetCostForTests(1024, 8, 1)
	os.Exit(m.Run())
}

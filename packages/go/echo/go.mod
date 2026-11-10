// Runlight for Echo apps, a module of its own so Echo is never a
// requirement of the runlight module.
module runlight.sh/go/echo

go 1.25.0

require (
	github.com/labstack/echo/v5 v5.4.4
	runlight.sh/go v0.4.2
)

require golang.org/x/text v0.41.0 // indirect

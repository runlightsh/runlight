package runlight

import "time"

// dateLayouts are the forms of a date Date.parse reads that log readers send.
var dateLayouts = []string{
	time.RFC3339Nano,
	"2006-01-02T15:04:05.999999999",
	"2006-01-02T15:04",
	"2006-01-02",
	time.RFC1123,
	time.RFC1123Z,
	"Mon, 2 Jan 2006 15:04:05 MST",
	"02/Jan/2006:15:04:05 -0700",
}

// parseTime is a time read in a layout, as epoch milliseconds; a time with
// no zone is UTC.
func parseTime(layout, text string) (int64, error) {
	t, err := time.Parse(layout, text)
	if err != nil {
		return 0, err
	}
	return t.UnixMilli(), nil
}

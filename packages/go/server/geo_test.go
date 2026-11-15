package server

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	runlight "runlight.sh/go"
	"runlight.sh/go/mmdb"
)

// kv is one entry of a map as MMDB writes it, in order.
type kv struct {
	key   string
	value any
}

// encode is MMDB's data format, enough of it to write a database: maps, strings, arrays, and unsigned integers.
func encode(value any) []byte {
	control := func(typ, size int) []byte {
		if typ >= 8 {
			if size >= 29 {
				panic("too long for this writer")
			}
			return []byte{byte(size), byte(typ - 7)}
		}
		switch {
		case size < 29:
			return []byte{byte(typ<<5 | size)}
		case size < 285:
			return []byte{byte(typ<<5 | 29), byte(size - 29)}
		}
		return []byte{byte(typ<<5 | 30), byte((size - 285) >> 8), byte((size - 285) & 255)}
	}
	switch v := value.(type) {
	case string:
		return append(control(2, len(v)), v...)
	case int:
		return encode(int64(v))
	case int64:
		size, typ := 8, 9
		if v < 0x10000 {
			size, typ = 2, 5
		} else if v < 0x100000000 {
			size, typ = 4, 6
		}
		var out [8]byte
		binary.BigEndian.PutUint64(out[:], uint64(v))
		return append(control(typ, size), out[8-size:]...)
	case []any:
		out := control(11, len(v))
		for _, e := range v {
			out = append(out, encode(e)...)
		}
		return out
	case []kv:
		out := control(7, len(v))
		for _, e := range v {
			out = append(append(out, encode(e.key)...), encode(e.value)...)
		}
		return out
	}
	panic("this writer does not write that")
}

func utc(year int, month time.Month, day, hour int) int64 {
	return time.Date(year, month, day, hour, 0, 0, 0, time.UTC).UnixMilli()
}

var usRecord = []kv{{"country", []kv{{"iso_code", "US"}, {"names", []kv{{"en", "United States"}}}}}, {"city", []kv{{"names", []kv{{"en", "Mountain View"}}}}}}

// testDb is a whole MMDB file of one megabyte or so, in which every address has the same record. meta
// overrides the metadata, and record the record (nil leaves every address without one).
func testDb(meta map[string]any, record []kv, pad int) []byte {
	// One node whose two records both point at the first thing in the data section, or at "no data".
	pointer := byte(1 + 16)
	data := encode([]kv{})
	if record == nil {
		pointer = 1
	} else {
		data = encode(record)
	}
	fields := []kv{
		{"binary_format_major_version", 2}, {"binary_format_minor_version", 0}, {"build_epoch", utc(2026, 10, 1, 2) / 1000},
		{"database_type", "DBIP-City-Lite"}, {"description", []kv{{"en", "A test database"}}}, {"ip_version", 6},
		{"languages", []any{"en"}}, {"node_count", 1}, {"record_size", 24},
	}
	for i := range fields {
		if v, ok := meta[fields[i].key]; ok {
			fields[i].value = v
		}
	}
	out := []byte{0, 0, pointer, 0, 0, pointer}
	out = append(out, make([]byte, 16)...)
	out = append(out, data...)
	out = append(out, make([]byte, pad)...)
	out = append(out, "\xab\xcd\xefMaxMind.com"...)
	return append(out, encode(fields)...)
}

func goodDb() []byte { return testDb(nil, usRecord, 1024*1024) }

func withMeta(key string, value any) []byte {
	return testDb(map[string]any{key: value}, usRecord, 1024*1024)
}

func sha1Of(b []byte) string {
	sum := sha1.Sum(b)
	return hex.EncodeToString(sum[:])
}

func gzipped(b []byte) []byte {
	var out bytes.Buffer
	w := gzip.NewWriter(&out)
	_, _ = w.Write(b)
	_ = w.Close()
	return out.Bytes()
}

// pageOf is DB-IP's download page as it reads, with the CSV file's card before the MMDB file's.
func pageOf(mode, release, sum string) string {
	return `<div class="card"><dl class="card-body"><dt>Format</dt><dd>CSV</dd><dt>MD5SUM</dt>
<dd class="small">93c945395f0bc2ceefea7dd55750417a</dd><dt>SHA1SUM</dt><dd class="small">e2061015c43ec91c94a12191a6a613279eb94c0c</dd></dl>
<a href='https://download.db-ip.com/free/dbip-` + mode + `-lite-` + release + `.csv.gz' class='btn'>Download CSV</a></div>
<div class="card"><dl class="card-body"><dt>Format</dt><dd>MMDB</dd><dt>MD5SUM</dt><dd class="small">5974b336a7409ec854f67eacd52c2061</dd>
<dt>SHA1SUM</dt>
					<dd class="small">` + sum + `</dd></dl>
<a href='https://download.db-ip.com/free/dbip-` + mode + `-lite-` + release + `.mmdb.gz' class='btn'>Download MMDB</a></div>`
}

const checksumPage = "https://db-ip.com/db/download/ip-to-city-lite"

func fileURL(release string) string {
	return "https://download.db-ip.com/free/dbip-city-lite-" + release + ".mmdb.gz"
}

var october = utc(2026, 10, 3, 3)

// answer is what a URL answers: a status, a body, and the length it declares (0 for none declared).
type answer struct {
	status int
	body   []byte
	length int64
}

func ok(body []byte) answer { return answer{status: 200, body: body} }

type geoTest struct {
	geo     *Geo
	dir     string
	asked   []string
	lines   []string
	answers map[string]answer
}

// geoWith is a Geo whose downloads are answered from answers, by URL, with every URL asked for and every line logged kept.
func geoWith(t *testing.T, answers map[string]answer) *geoTest {
	t.Helper()
	g := &geoTest{dir: t.TempDir(), answers: answers}
	geo, err := NewGeo(g.dir, "city", func(line string) { g.lines = append(g.lines, line) }, func(_ context.Context, url string) (int, int64, io.ReadCloser, error) {
		g.asked = append(g.asked, url)
		a, found := g.answers[url]
		if !found {
			a = answer{status: 404, body: []byte("nope")}
		}
		length := int64(-1)
		if a.length != 0 {
			length = a.length
		}
		return a.status, length, io.NopCloser(bytes.NewReader(a.body)), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	g.geo = geo
	return g
}

func (g *geoTest) refresh(t *testing.T, now int64) {
	t.Helper()
	if err := g.geo.Refresh(context.Background(), now); err != nil {
		t.Fatal(err)
	}
}

func (g *geoTest) release() string {
	g.geo.mu.Lock()
	defer g.geo.mu.Unlock()
	return g.geo.loaded
}

func (g *geoTest) files(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(g.dir)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func (g *geoTest) logged() string { return strings.Join(g.lines, "\n") }

func (g *geoTest) last() string {
	if len(g.lines) == 0 {
		return ""
	}
	return g.lines[len(g.lines)-1]
}

// releaseOf is the answers for one release: the page with sum (the file's own when ""), and the file, gzipped.
func releaseOf(name string, file []byte, sum string) map[string]answer {
	if sum == "" {
		sum = sha1Of(file)
	}
	return map[string]answer{checksumPage: ok([]byte(pageOf("city", name, sum))), fileURL(name): ok(gzipped(file))}
}

func merged(maps ...map[string]answer) map[string]answer {
	out := map[string]answer{}
	for _, m := range maps {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

func mountainView(t *testing.T, g *geoTest) {
	t.Helper()
	found, err := g.geo.Lookup("8.8.8.8")
	if err != nil || found == nil || *found != (runlight.Location{Country: "US", Region: "", City: "Mountain View"}) {
		t.Fatalf("a lookup: %+v %v", found, err)
	}
}

func TestDBIPRecordsBecomeACountryCodeAReadableRegionAndAPlainCity(t *testing.T) {
	lookup := func(record []kv, ip string) *runlight.Location {
		t.Helper()
		reader, err := mmdb.FromBytes(testDb(nil, record, 0))
		if err != nil {
			t.Fatal(err)
		}
		found, _ := runlight.LookupFrom(reader)(ip)
		return found
	}
	toronto := []kv{{"country", []kv{{"iso_code", "CA"}}}, {"subdivisions", []any{[]kv{{"names", []kv{{"en", "Ontario"}}}}}}, {"city", []kv{{"names", []kv{{"en", "Toronto (Old Toronto)"}}}}}}
	if got := lookup(toronto, "24.114.0.1"); got == nil || *got != (runlight.Location{Country: "CA", Region: "Ontario", City: "Toronto"}) {
		t.Errorf("got %+v", got)
	}
	california := []kv{{"country", []kv{{"iso_code", "US"}}}, {"subdivisions", []any{[]kv{{"iso_code", "CA"}, {"names", []kv{{"en", "California"}}}}}}, {"city", []kv{{"names", []kv{{"en", "Mountain View"}}}}}}
	if got := lookup(california, "8.8.8.8"); got == nil || *got != (runlight.Location{Country: "US", Region: "CA", City: "Mountain View"}) {
		t.Errorf("a code wins when the database has one: %+v", got)
	}
	if got := lookup(nil, "10.0.0.1"); got != nil {
		t.Errorf("no record: %+v", got)
	}
	if got := lookup(toronto, "nonsense"); got != nil {
		t.Errorf("a bad address: %+v", got)
	}
}

func TestADownloadWhoseChecksumMatchesDBIPsPageIsPutToUse(t *testing.T) {
	file := goodDb()
	g := geoWith(t, releaseOf("2026-10", file, ""))
	g.refresh(t, october)
	if !reflect.DeepEqual(g.asked, []string{checksumPage, fileURL("2026-10")}) {
		t.Fatal(g.asked)
	}
	if g.release() != "2026-10" {
		t.Fatalf("loaded %q: %s", g.release(), g.logged())
	}
	mountainView(t, g)
	if !reflect.DeepEqual(g.files(t), []string{"dbip-city-lite-2026-10.mmdb"}) {
		t.Fatal(g.files(t))
	}
	kept, _ := os.ReadFile(filepath.Join(g.dir, "dbip-city-lite-2026-10.mmdb"))
	if sha1Of(kept) != sha1Of(file) {
		t.Error("the file on disk is not the one published")
	}
	if !strings.Contains(g.logged(), "(2026-10) is ready") || strings.Contains(g.logged(), "warning") {
		t.Error(g.logged())
	}
}

func TestEarlyInAMonthThePageStillOffersLastMonthsReleaseAndThatIsTheOneFetched(t *testing.T) {
	g := geoWith(t, releaseOf("2026-09", withMeta("build_epoch", utc(2026, 9, 1, 0)/1000), ""))
	g.refresh(t, utc(2026, 10, 1, 3))
	if !reflect.DeepEqual(g.asked, []string{checksumPage, fileURL("2026-09")}) || g.release() != "2026-09" {
		t.Fatal(g.asked, g.release(), g.logged())
	}
	g.refresh(t, utc(2026, 10, 1, 4))
	if !reflect.DeepEqual(g.asked[2:], []string{checksumPage}) {
		t.Errorf("later the page is read again, and the file on disk is not fetched twice: %v", g.asked[2:])
	}
}

func TestADownloadThatDoesNotMatchThePublishedChecksumIsNeverUsedAndTheDatabaseInUseStays(t *testing.T) {
	good := withMeta("build_epoch", utc(2026, 9, 1, 0)/1000)
	g := geoWith(t, releaseOf("2026-09", good, ""))
	g.refresh(t, utc(2026, 9, 20, 0))
	if g.release() != "2026-09" {
		t.Fatal(g.logged())
	}

	// October's file is not the one DB-IP's page describes.
	swapped := testDb(nil, []kv{{"country", []kv{{"iso_code", "ZZ"}}}}, 1024*1024)
	g.answers = merged(g.answers, releaseOf("2026-10", swapped, sha1Of(goodDb())))
	g.refresh(t, october)
	if g.release() != "2026-09" {
		t.Errorf("last month's is no longer in use: %q", g.release())
	}
	mountainView(t, g)
	if !reflect.DeepEqual(g.files(t), []string{"dbip-city-lite-2026-09.mmdb"}) {
		t.Errorf("something of the bad download is left: %v", g.files(t))
	}
	if want := "not updated from " + fileURL("2026-10") + ": its SHA-1 is " + sha1Of(swapped) + ", and DB-IP publishes " + sha1Of(goodDb()); !strings.Contains(g.last(), want) {
		t.Errorf("got %s", g.last())
	}

	// Bytes after the end of the gzip stream never reach the file: what is kept is what was hashed.
	october2 := goodDb()
	g.answers = merged(g.answers, releaseOf("2026-10", october2, ""), map[string]answer{fileURL("2026-10"): ok(append(gzipped(october2), "extra"...))})
	g.refresh(t, october+6*3_600_000)
	for _, name := range g.files(t) {
		kept, _ := os.ReadFile(filepath.Join(g.dir, name))
		if sum := sha1Of(kept); sum != sha1Of(good) && sum != sha1Of(october2) {
			t.Errorf("%s holds bytes that were never checked", name)
		}
	}
	if g.release() != "2026-09" {
		t.Errorf("a download with more after its end was used: %s", g.last())
	}
}

func TestWhenNoChecksumCanBeReadAtAllTheNewestReleaseIsTakenOnItsStructureAloneWithAWarning(t *testing.T) {
	file := goodDb()
	for _, c := range []struct {
		what string
		page answer
		why  string
	}{
		{"the page is down", answer{status: 503, body: []byte("no")}, `could not read DB-IP's checksums.*answered 503`},
		{"the page redirects", answer{status: 302}, `answered 302`},
		{"the page has no checksum", ok([]byte(pageOf("city", "2026-10", ""))), `found no checksum`},
		{"the page is for another database", ok([]byte(pageOf("country", "2026-10", sha1Of(file)))), `found no checksum`},
		{"the page never ends", ok(bytes.Repeat([]byte("x"), 2*1024*1024)), `more than 1024 KB`},
	} {
		g := geoWith(t, merged(releaseOf("2026-10", file, ""), map[string]answer{checksumPage: c.page}))
		g.refresh(t, october)
		if !reflect.DeepEqual(g.asked, []string{checksumPage, fileURL("2026-10")}) || g.release() != "2026-10" || !reflect.DeepEqual(g.files(t), []string{"dbip-city-lite-2026-10.mmdb"}) {
			t.Errorf("%s: asked %v, loaded %q, files %v: %s", c.what, g.asked, g.release(), g.files(t), g.logged())
			continue
		}
		warnings := []string{}
		for _, line := range g.lines {
			if strings.Contains(line, "could not be checked against DB-IP's published checksum") {
				warnings = append(warnings, line)
			}
		}
		if len(warnings) != 1 || !strings.HasPrefix(warnings[0], "Runlight: warning: location data from DB-IP (2026-10)") || !regexp.MustCompile(c.why).MatchString(warnings[0]) {
			t.Errorf("%s: warnings %v", c.what, warnings)
		}
	}

	// As before the page was read: this month's file, then last month's, and a month not out yet is no failure.
	early := geoWith(t, map[string]answer{fileURL("2026-09"): ok(gzipped(withMeta("build_epoch", utc(2026, 9, 1, 0)/1000)))})
	early.refresh(t, utc(2026, 10, 1, 3))
	if !reflect.DeepEqual(early.asked, []string{checksumPage, fileURL("2026-10"), fileURL("2026-09")}) || early.release() != "2026-09" {
		t.Errorf("asked %v, loaded %q", early.asked, early.release())
	}
	starts := []string{}
	for _, line := range early.lines {
		starts = append(starts, line[:50])
	}
	if !reflect.DeepEqual(starts, []string{"Runlight: warning: location data from DB-IP (2026-", "Runlight: location data from DB-IP (2026-09) is re"}) {
		t.Errorf("logged %v", early.lines)
	}

	// The other checks still hold: what is not a DB-IP city database is not used, checksum or no checksum.
	wrong := geoWith(t, map[string]answer{fileURL("2026-10"): ok(gzipped(withMeta("database_type", "GeoLite2-City")))})
	wrong.refresh(t, october)
	if wrong.release() != "" || len(wrong.files(t)) != 0 {
		t.Errorf("loaded %q, files %v", wrong.release(), wrong.files(t))
	}
	if !regexp.MustCompile(`not updated from .*2026-10\.mmdb\.gz: it is a "GeoLite2-City" database`).MatchString(wrong.logged()) ||
		!regexp.MustCompile(`not updated: could not read DB-IP's checksums.*and no release could be downloaded without them`).MatchString(wrong.last()) ||
		strings.Contains(wrong.logged(), "warning") {
		t.Errorf("logged %s", wrong.logged())
	}
}

func TestAPageThatIsReadIsHeldTo(t *testing.T) {
	file := goodDb()
	old := geoWith(t, merged(releaseOf("2026-10", file, ""), map[string]answer{checksumPage: ok([]byte(pageOf("city", "2026-05", sha1Of(file))))}))
	old.refresh(t, october)
	if !reflect.DeepEqual(old.asked, []string{checksumPage}) || old.release() != "" || !strings.Contains(old.logged(), "offers the 2026-05 release") {
		t.Errorf("asked %v, loaded %q: %s", old.asked, old.release(), old.logged())
	}

	// A good October file is on offer, but the page describes another: refused, with no try at last month's.
	mismatch := geoWith(t, merged(releaseOf("2026-09", file, ""), releaseOf("2026-10", file, strings.Repeat("0", 40))))
	mismatch.refresh(t, october)
	if !reflect.DeepEqual(mismatch.asked, []string{checksumPage, fileURL("2026-10")}) || mismatch.release() != "" || len(mismatch.files(t)) != 0 {
		t.Errorf("asked %v, loaded %q, files %v", mismatch.asked, mismatch.release(), mismatch.files(t))
	}
	if !regexp.MustCompile(`its SHA-1 is [0-9a-f]{40}, and DB-IP publishes 0{40}`).MatchString(mismatch.logged()) || strings.Contains(mismatch.logged(), "warning") {
		t.Errorf("logged %s", mismatch.logged())
	}
}

func TestADownloadThatRedirectsIsNotGzipOrIsTooLargeIsRefused(t *testing.T) {
	file := goodDb()
	for _, c := range []struct {
		what string
		file answer
		said string
	}{
		{"a redirect", answer{status: 301}, `answered 301`},
		{"not gzip", ok(file), `(?i)header|gzip`},
		{"cut short", ok(gzipped(file)[:300]), `(?i)unexpected EOF`},
		{"a length past the limit", answer{status: 200, body: gzipped(file), length: 300 * 1024 * 1024}, `more than 256 MB`},
	} {
		g := geoWith(t, merged(releaseOf("2026-10", file, ""), map[string]answer{fileURL("2026-10"): c.file}))
		g.refresh(t, october)
		if g.release() != "" || !regexp.MustCompile(c.said).MatchString(g.logged()) || len(g.files(t)) != 0 {
			t.Errorf("%s: loaded %q, files %v: %s", c.what, g.release(), g.files(t), g.logged())
		}
	}
}

func TestAFileWithTheRightChecksumIsStillReadAsADBIPDatabaseBeforeItIsUsed(t *testing.T) {
	refused := func(file []byte, inUse int64) string {
		if err := checkDatabase(file, "city", october, inUse); err != nil {
			return err.Error()
		}
		return ""
	}
	if got := refused(goodDb(), 0); got != "" {
		t.Fatalf("a good database: %s", got)
	}
	for _, c := range []struct {
		file  []byte
		inUse int64
		said  string
	}{
		{testDb(nil, usRecord, 1000), 0, `too few`},
		{make([]byte, 2*1024*1024), 0, `not an MMDB file`},
		{withMeta("database_type", "GeoLite2-City"), 0, `"GeoLite2-City" database`},
		{withMeta("database_type", "DBIP-Country-Lite"), 0, `not DB-IP's city one`},
		{withMeta("binary_format_major_version", 3), 0, `version 3`},
		{withMeta("ip_version", 4), 0, `IP version 4`},
		{withMeta("record_size", 20), 0, `20 bits|does not open`},
		{withMeta("node_count", 900_000), 0, `search tree does not fit|does not open`},
		{withMeta("build_epoch", utc(2026, 5, 1, 0)/1000), 0, `built on 2026-05-01`},
		{withMeta("build_epoch", utc(2026, 12, 1, 0)/1000), 0, `built on 2026-12-01`},
		{goodDb(), utc(2026, 10, 2, 0), `older than the database in use`},
		{testDb(nil, nil, 1024*1024), 0, `no country for 8\.8\.8\.8`},
		{testDb(nil, []kv{{"city", []kv{{"names", []kv{{"en", "Nowhere"}}}}}}, 1024*1024), 0, `no country for 8\.8\.8\.8`},
	} {
		if got := refused(c.file, c.inUse); !regexp.MustCompile(c.said).MatchString(got) {
			t.Errorf("want %s, got %q", c.said, got)
		}
	}

	// And through a download: the page vouches for a file that is not a city database, so it is not used.
	g := geoWith(t, releaseOf("2026-10", withMeta("database_type", "DBIP-Country-Lite"), ""))
	g.refresh(t, october)
	if g.release() != "" || len(g.files(t)) != 0 {
		t.Errorf("loaded %q, files %v", g.release(), g.files(t))
	}
}

func TestTheChecksumReadFromDBIPsPageIsTheMMDBFilesNotTheCSVFiles(t *testing.T) {
	sum := "09eea8433fe3eed71984fd6aac9d8ab3d9ca51f0"
	if got := publishedChecksum(pageOf("country", "2026-11", strings.ToUpper(sum)), "country"); got == nil || *got != (checksum{"2026-11", sum}) {
		t.Errorf("got %+v", got)
	}
	if got := publishedChecksum(pageOf("country", "2026-11", sum), "city"); got != nil {
		t.Errorf("the other kind: %+v", got)
	}
	if got := publishedChecksum(pageOf("city", "2026-11", "abc"), "city"); got != nil {
		t.Errorf("the CSV file's checksum stood in: %+v", got)
	}
	if got := publishedChecksum("<html></html>", "city"); got != nil {
		t.Errorf("an unrelated page: %+v", got)
	}
}

func TestAFailedDownloadLeavesLookupsEmptyAndTheFolderCleanAndIsTriedAgainLater(t *testing.T) {
	g := geoWith(t, map[string]answer{})
	g.refresh(t, utc(2026, 10, 1, 3))
	// The checksum comes first; with none, this month's file and then last month's.
	if !reflect.DeepEqual(g.asked, []string{checksumPage, fileURL("2026-10"), fileURL("2026-09")}) {
		t.Fatal(g.asked)
	}
	if found, _ := g.geo.Lookup("8.8.8.8"); found != nil {
		t.Fatal(found)
	}
	if len(g.files(t)) != 0 {
		t.Fatal(g.files(t))
	}
	g.refresh(t, utc(2026, 10, 1, 4))
	if len(g.asked) != 6 {
		t.Fatal("not tried again on the next check")
	}
	if !strings.Contains(g.last(), "not updated: could not read DB-IP's checksums") {
		t.Error(g.last())
	}
}

func TestAFileThatKeepsBeingMissingOrBadIsAskedForLessAndLessOften(t *testing.T) {
	g := geoWith(t, map[string]answer{})
	start := utc(2026, 10, 1, 3)
	// The server checks every five minutes; each try asks for the checksum, this month's file, and last month's.
	tries := []int{}
	for at := 0; at <= 24*60; at += 5 {
		before := len(g.asked)
		g.refresh(t, start+int64(at)*60_000)
		if len(g.asked) > before {
			tries = append(tries, at)
		}
	}
	if !reflect.DeepEqual(tries, []int{0, 5, 15, 35, 75, 155, 315, 635, 995, 1355}) {
		t.Errorf("each wait is twice the last, and none is longer than six hours: %v", tries)
	}
	if len(g.asked) != len(tries)*3 {
		t.Errorf("%d requests in %d tries", len(g.asked), len(tries))
	}
}

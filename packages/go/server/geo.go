package server

// Location for servers with no platform headers (Cloudflare, Vercel, and
// Netlify send their own, and those always win). Uses DB-IP's free databases
// (CC BY 4.0, https://db-ip.com), downloaded on first start and refreshed
// each month, or any MMDB file the owner points at.
//
// A download is used only once it is checked: its SHA-1 against the one DB-IP
// publishes on its download page, and the file itself as a DB-IP database of
// the kind asked for, no older than the one in use. That catches a damaged or
// swapped file, and a download server serving something else. It is not a
// signature: DB-IP publishes none, so whoever can change DB-IP's own page can
// change both. A checksum that does not match always refuses the download.
// Only when none can be read at all (the page is down, or no longer reads as
// it did) is a download accepted on the other checks alone, with a warning,
// so a change to that page does not stop location data everywhere.

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	runlight "runlight.sh/go"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/mmdb"
)

// Download makes one GET and hands back its status, the length it declares (-1 when it declares none), and
// its body as a stream. It must follow no redirect: a 3xx is handed back as it is.
type Download func(ctx context.Context, url string) (status int, length int64, body io.ReadCloser, err error)

// noRedirects is a client that goes nowhere but where it was sent.
var noRedirects = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func httpDownload(ctx context.Context, url string) (int, int64, io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return 0, -1, nil, err
	}
	res, err := noRedirects.Do(req)
	if err != nil {
		return 0, -1, nil, err
	}
	return res.StatusCode, res.ContentLength, res.Body, nil
}

// month is "2026-10", the month DB-IP names each release after.
func month(ts int64) string { return time.UnixMilli(ts).UTC().Format("2006-01") }

// Geo keeps a DB-IP database current in a folder and answers lookups from
// it. Lookups return nothing until the first download finishes, so startup
// never waits.
type Geo struct {
	dir      string
	mode     string
	log      func(line string)
	download Download

	mu       sync.Mutex
	reader   *mmdb.Reader
	loaded   string
	fetching chan struct{}
	// After a try that left this month's file missing: how long the next waits, and when it may start.
	wait    int64
	retryAt int64
}

// How long after a first failed try the next one waits, and the longest any waits.
const (
	geoFirstWait   = 5 * 60_000
	geoLongestWait = 6 * 3_600_000
)

// NewGeo keeps DB-IP's "city" or "country" database in dir. log gets a line
// when new data is ready or a download fails; nil prints nothing. download
// nil fetches over HTTPS.
func NewGeo(dir, mode string, log func(line string), download Download) (*Geo, error) {
	if mode != "city" && mode != "country" {
		return nil, fmt.Errorf("runlight: no DB-IP database called %q", mode)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	if log == nil {
		log = func(string) {}
	}
	if download == nil {
		download = httpDownload
	}
	return &Geo{dir: dir, mode: mode, log: log, download: download}, nil
}

// Lookup answers from the newest data, or nil before any has loaded.
func (g *Geo) Lookup(ip string) (*runlight.Location, error) {
	g.mu.Lock()
	reader := g.reader
	g.mu.Unlock()
	if reader == nil {
		return nil, nil
	}
	return runlight.LookupFrom(reader)(ip)
}

func (g *Geo) prefix() string { return "dbip-" + g.mode + "-lite-" }

func (g *Geo) file(release string) string {
	return filepath.Join(g.dir, g.prefix()+release+".mmdb")
}

func exists(file string) bool {
	_, err := os.Stat(file)
	return err == nil
}

func (g *Geo) open(file string) error {
	reader, err := mmdb.Open(file)
	if err != nil {
		return err
	}
	base := filepath.Base(file)
	g.mu.Lock()
	g.reader, g.loaded = reader, base[len(base)-12:len(base)-5]
	g.mu.Unlock()
	return nil
}

// Refresh opens the newest file on disk, then fetches this month's if it is
// missing. Safe to call often; a download under way is shared, and after one
// that left the month's file missing the next waits, from five minutes,
// doubling, up to six hours.
func (g *Geo) Refresh(ctx context.Context, now int64) error {
	current := month(now)
	g.mu.Lock()
	loaded := g.loaded
	g.mu.Unlock()
	if loaded == current {
		return nil
	}
	entries, err := os.ReadDir(g.dir)
	if err != nil {
		return err
	}
	names := []string{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), g.prefix()) && strings.HasSuffix(e.Name(), ".mmdb") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	if len(names) > 0 {
		newest := names[len(names)-1]
		if loaded == "" || newest != filepath.Base(g.file(loaded)) {
			if err := g.open(filepath.Join(g.dir, newest)); err != nil {
				return err
			}
		}
	}
	if exists(g.file(current)) {
		return nil
	}
	g.mu.Lock()
	wait := g.fetching
	// While the month's file is not published yet, or a download keeps failing, each try waits twice as long
	// as the last, so neither DB-IP nor the disk is asked for the whole file every few minutes.
	if wait == nil && now < g.retryAt {
		g.mu.Unlock()
		return nil
	}
	if wait == nil {
		wait = make(chan struct{})
		g.fetching = wait
		g.mu.Unlock()
		g.fetch(ctx, current, now)
		g.mu.Lock()
		g.fetching = nil
		if exists(g.file(current)) {
			g.wait = 0
		} else {
			if g.wait == 0 {
				g.wait = geoFirstWait
			} else {
				g.wait = min(g.wait*2, geoLongestWait)
			}
			g.retryAt = now + g.wait
		}
		close(wait)
	}
	g.mu.Unlock()
	<-wait
	return nil
}

// statusError is an answer that was not a 200.
type statusError struct{ status int }

func (e *statusError) Error() string { return fmt.Sprintf("it answered %d", e.status) }

// get is one GET that goes nowhere but where it was sent: no redirect is followed, and anything but a 200 is an error.
func (g *Geo) get(ctx context.Context, url string) (int64, io.ReadCloser, error) {
	status, length, body, err := g.download(ctx, url)
	if err != nil {
		return 0, nil, err
	}
	if status != 200 || body == nil {
		if body != nil {
			body.Close()
		}
		return 0, nil, &statusError{status}
	}
	return length, body, nil
}

// checksum is a release DB-IP's download page offers and the SHA-1 it gives for the unpacked file.
type checksum struct{ release, sha1 string }

// published is the release DB-IP's download page offers for this kind of database, and its SHA-1.
func (g *Geo) published(ctx context.Context) (*checksum, error) {
	url := "https://db-ip.com/db/download/ip-to-" + g.mode + "-lite"
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	page, err := func() (string, error) {
		_, body, err := g.get(ctx, url)
		if err != nil {
			return "", err
		}
		defer body.Close()
		bytes, err := io.ReadAll(io.LimitReader(body, mostPageBytes+1))
		if err != nil {
			return "", err
		}
		if len(bytes) > mostPageBytes {
			return "", fmt.Errorf("it is more than %d KB", mostPageBytes/1024)
		}
		return string(bytes), nil
	}()
	if err != nil {
		return nil, fmt.Errorf("could not read DB-IP's checksums at %s: %v", url, err)
	}
	found := publishedChecksum(page, g.mode)
	if found == nil {
		return nil, fmt.Errorf("found no checksum for the %s database at %s", g.mode, url)
	}
	return found, nil
}

var (
	otherFile = "download.db-ip.com/free/dbip-"
	sha1Sum   = regexp.MustCompile(`(?is)SHA1SUM.{0,200}?\b([0-9a-f]{40})\b`)
)

// publishedChecksum is the release and SHA-1 on DB-IP's download page for the MMDB file of one kind: the last
// SHA1SUM before the link to that file, and after the link to any other. Nil when the page does not read that way.
func publishedChecksum(page, mode string) *checksum {
	link := regexp.MustCompile(`download\.db-ip\.com/free/dbip-` + regexp.QuoteMeta(mode) + `-lite-(\d{4}-\d{2})\.mmdb\.gz`).FindStringSubmatchIndex(page)
	if link == nil {
		return nil
	}
	card := page[:link[0]]
	if at := strings.LastIndex(card, otherFile); at >= 0 {
		card = card[at:]
	}
	sums := sha1Sum.FindAllStringSubmatch(card, -1)
	if len(sums) == 0 {
		return nil
	}
	return &checksum{release: page[link[2]:link[3]], sha1: strings.ToLower(sums[len(sums)-1][1])}
}

func (g *Geo) fetch(ctx context.Context, release string, now int64) {
	// A new month's file appears a day or so after the month starts; until then, last month's is current.
	t := time.UnixMilli(now).UTC()
	tries := []string{release, month(time.Date(t.Year(), t.Month()-1, 15, 0, 0, 0, 0, time.UTC).UnixMilli())}
	// The page says which release there is and what it must hash to, so only that file is asked for. When the
	// page cannot be read, the newest release there is goes unchecked against it, and the log says so.
	published, err := g.published(ctx)
	unchecked := ""
	sum := ""
	if err != nil {
		unchecked = err.Error()
	} else {
		if published.release != tries[0] && published.release != tries[1] {
			g.log("Runlight: location data was not updated: DB-IP offers the " + published.release + " release, which is neither this month's nor last month's")
			return
		}
		tries, sum = []string{published.release}, published.sha1
	}
	for _, name := range tries {
		if exists(g.file(name)) {
			g.mu.Lock()
			loaded := g.loaded
			g.mu.Unlock()
			if loaded != name {
				if err := g.open(g.file(name)); err != nil {
					g.log("Runlight: could not open location data: " + err.Error())
				}
			}
			return
		}
		url := "https://download.db-ip.com/free/" + g.prefix() + name + ".mmdb.gz"
		partial := fmt.Sprintf("%s.partial.%d", g.file(name), os.Getpid())
		err := g.save(ctx, url, partial, sum, now)
		if err == nil {
			if err = os.Rename(partial, g.file(name)); err == nil {
				err = g.open(g.file(name))
			}
		}
		if err != nil {
			os.Remove(partial)
			// Without the page to say which release there is, this month's not being out yet is no failure.
			var status *statusError
			if published == nil && errors.As(err, &status) && status.status == 404 {
				continue
			}
			// Whatever went wrong, the database in use stays in use.
			g.log("Runlight: location data was not updated from " + url + ": " + err.Error())
			continue
		}
		// Older releases go once the new one opens.
		entries, _ := os.ReadDir(g.dir)
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), g.prefix()) && e.Name() != filepath.Base(g.file(name)) {
				os.Remove(filepath.Join(g.dir, e.Name()))
			}
		}
		if published == nil {
			g.log("Runlight: warning: location data from DB-IP (" + name + ") could not be checked against DB-IP's published checksum (" + unchecked + "). It was accepted as a DB-IP database of the right kind, without that check.")
		}
		g.log("Runlight: location data from DB-IP (" + name + ") is ready.")
		return
	}
	if published == nil {
		g.log("Runlight: location data was not updated: " + unchecked + ", and no release could be downloaded without them")
	}
}

// capped reads through, and fails once more than most bytes have gone by.
type capped struct {
	r    io.Reader
	most int64
	seen int64
}

func (c *capped) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.seen += int64(n)
	if c.seen > c.most {
		return n, fmt.Errorf("the location data is more than %d MB", c.most/1024/1024)
	}
	return n, err
}

// save downloads one release to partial, unpacked, and fails unless it is fit to use: the published SHA-1's
// (when there is one to hold it to), and a DB-IP database of this kind no older than the one in use.
func (g *Geo) save(ctx context.Context, url, partial, published string, now int64) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	length, body, err := g.get(ctx, url)
	if err != nil {
		return err
	}
	defer body.Close()
	if length > mostPackedBytes {
		return fmt.Errorf("the download is more than %d MB", mostPackedBytes/1024/1024)
	}
	// Read a byte at a time by the unpacker, so nothing past the packed file's end is taken from the answer.
	packed := bufio.NewReader(&capped{r: body, most: mostPackedBytes})
	unzipped, err := gzip.NewReader(packed)
	if err != nil {
		return err
	}
	// One packed file and nothing after it: more gzip, or anything else, is not what DB-IP sends.
	unzipped.Multistream(false)
	out, err := os.Create(partial)
	if err != nil {
		return err
	}
	hash := sha1.New()
	_, err = io.Copy(io.MultiWriter(out, hash), &capped{r: unzipped, most: mostBytes})
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if _, more := packed.ReadByte(); more == nil {
		return errors.New("there is more after the end of the packed file")
	} else if more != io.EOF {
		return more
	}
	got := hex.EncodeToString(hash.Sum(nil))
	if published != "" && got != published {
		return fmt.Errorf("its SHA-1 is %s, and DB-IP publishes %s", got, published)
	}
	bytes, err := os.ReadFile(partial)
	if err != nil {
		return err
	}
	g.mu.Lock()
	inUse := int64(0)
	if g.reader != nil {
		inUse = int64(js.Num(g.reader.Metadata.Value("build_epoch"))) * 1000
	}
	g.mu.Unlock()
	return checkDatabase(bytes, g.mode, now, inUse)
}

var (
	mmdbMarker = []byte("\xab\xcd\xefMaxMind.com")
	isoCountry = regexp.MustCompile(`^[A-Z]{2}$`)
	// knownAddresses are addresses any location database knows: Google's and Cloudflare's resolvers, over IPv4 and IPv6.
	knownAddresses = []string{"8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"}
)

const (
	geoDay = int64(86_400_000)
	// A release is built at the start of its month and stands in until the next appears, so one is two months old at most.
	oldestBuild = 100 * geoDay
	// mostBytes is the most a database may unpack to, several times the city file's size, so a bad download cannot fill the disk.
	mostBytes = 512 * 1024 * 1024
	// mostPackedBytes is the most the download itself may weigh, and fewestBytes the least a database unpacks to (the country one is 8 MB).
	mostPackedBytes = 256 * 1024 * 1024
	fewestBytes     = 1024 * 1024
	// mostPageBytes is the most of DB-IP's download page that is read; it is about 25 KB.
	mostPageBytes = 1024 * 1024
)

// checkDatabase fails unless bytes is a DB-IP database of the kind asked for that a lookup can be made in: of
// a believable size, its search tree inside the file, built lately and not before the one in use (inUse, a
// time in milliseconds, or 0 for none), and answering for addresses everyone knows.
func checkDatabase(data []byte, mode string, now, inUse int64) error {
	if len(data) < fewestBytes {
		return fmt.Errorf("it unpacks to %d bytes, too few for a location database", len(data))
	}
	marker := bytes.LastIndex(data, mmdbMarker)
	if marker < 0 {
		return errors.New("it is not an MMDB file")
	}
	reader, err := mmdb.FromBytes(data)
	if err != nil {
		return fmt.Errorf("it does not open as an MMDB file: %v", err)
	}
	meta := reader.Metadata
	number := func(name string) float64 { return js.ToNumber(undefinedOr(meta, name)) }
	if major := number("binary_format_major_version"); major != 2 {
		return fmt.Errorf("its format is version %s, not 2", js.FormatNumber(major))
	}
	kind, _ := meta.Value("database_type").(string)
	if strings.ToLower(kind) != "dbip-"+mode+"-lite" {
		return errors.New(`it is a "` + kind + `" database, not DB-IP's ` + mode + ` one`)
	}
	if version := number("ip_version"); version != 6 {
		return fmt.Errorf("it covers IP version %s, not 6", js.FormatNumber(version))
	}
	size := number("record_size")
	if size != 24 && size != 28 && size != 32 {
		return fmt.Errorf("its records are %s bits", js.FormatNumber(size))
	}
	if nodes := number("node_count"); !(nodes > 0) || nodes*size/4+16 > float64(marker) {
		return errors.New("its search tree does not fit in the file")
	}
	built := number("build_epoch") * 1000
	if !(built <= float64(now+2*geoDay)) || built < float64(now-oldestBuild) {
		when := "no date"
		if !math.IsNaN(built) && !math.IsInf(built, 0) {
			when = time.UnixMilli(int64(built)).UTC().Format("2006-01-02")
		}
		return errors.New("it was built on " + when)
	}
	if built < float64(inUse) {
		return errors.New("it is older than the database in use")
	}
	for _, ip := range knownAddresses {
		found, _ := reader.Get(ip)
		if code, _ := js.Dig(found, "country", "iso_code").(string); !isoCountry.MatchString(code) {
			return errors.New("it has no country for " + ip)
		}
	}
	return nil
}

// undefinedOr is a metadata value, or what a missing one reads as a number: not one.
func undefinedOr(meta *js.Object, name string) any {
	if v, ok := meta.Get(name); ok {
		return v
	}
	return js.Undefined{}
}

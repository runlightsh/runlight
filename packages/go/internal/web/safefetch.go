package web

import (
	"context"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"

	"runlight.sh/go/internal/whatwg"
)

// Fetches from addresses that other people's input names, such as the icon
// links on a site's home page or a link domain, go only to the public
// internet. Only https is fetched, never a private, loopback, link-local,
// or metadata address, and redirects are followed by hand under the same
// rules. The real Fetcher checks the address the connection uses
// (FetchInit.PublicOnly); for any other, the name is looked up first.

var dottedQuad = regexp.MustCompile(`^\d{1,3}$`)

func v4(text string) []int {
	parts := strings.Split(text, ".")
	if len(parts) != 4 {
		return nil
	}
	out := make([]int, 4)
	for i, p := range parts {
		if !dottedQuad.MatchString(p) {
			return nil
		}
		n, _ := strconv.Atoi(p)
		if n > 255 {
			return nil
		}
		out[i] = n
	}
	return out
}

func publicV4(a []int) bool {
	switch {
	case a[0] == 0 || a[0] == 10 || a[0] == 127 || a[0] >= 224:
		return false
	case a[0] == 100 && a[1] >= 64 && a[1] < 128:
		return false
	case a[0] == 169 && a[1] == 254:
		return false
	case a[0] == 172 && a[1] >= 16 && a[1] < 32:
		return false
	case a[0] == 192 && a[1] == 168:
		return false
	case a[0] == 192 && a[1] == 0 && (a[2] == 0 || a[2] == 2):
		return false
	case a[0] == 198 && (a[1] == 18 || a[1] == 19):
		return false
	case a[0] == 198 && a[1] == 51 && a[2] == 100:
		return false
	case a[0] == 203 && a[1] == 0 && a[2] == 113:
		return false
	}
	return true
}

var (
	v4Tail  = regexp.MustCompile(`(\d{1,3}(?:\.\d{1,3}){3})$`)
	v6Group = regexp.MustCompile(`^[0-9a-f]{1,4}$`)
)

// v6 is an IPv6 address as eight 16-bit groups, or nil when it is not one.
func v6(text string) []int {
	address := strings.ToLower(strings.SplitN(strings.TrimSuffix(strings.TrimPrefix(text, "["), "]"), "%", 2)[0])
	// A trailing IPv4 address becomes the last two groups.
	if m := v4Tail.FindStringSubmatch(address); m != nil {
		four := v4(m[1])
		if four == nil {
			return nil
		}
		address = address[:len(address)-len(m[1])] + strconv.FormatInt(int64(four[0]<<8|four[1]), 16) + ":" + strconv.FormatInt(int64(four[2]<<8|four[3]), 16)
	}
	halves := strings.Split(address, "::")
	if len(halves) > 2 {
		return nil
	}
	var head, rest []string
	if halves[0] != "" {
		head = strings.Split(halves[0], ":")
	}
	if len(halves) == 2 && halves[1] != "" {
		rest = strings.Split(halves[1], ":")
	}
	missing := 8 - len(head) - len(rest)
	if (len(halves) == 1 && missing != 0) || (len(halves) == 2 && missing < 1) {
		return nil
	}
	groups := append([]string{}, head...)
	if len(halves) == 2 {
		for i := 0; i < missing; i++ {
			groups = append(groups, "0")
		}
	}
	groups = append(groups, rest...)
	out := make([]int, len(groups))
	for i, g := range groups {
		if !v6Group.MatchString(g) {
			return nil
		}
		n, _ := strconv.ParseInt(g, 16, 32)
		out[i] = int(n)
	}
	return out
}

// PublicAddress reports whether an IP address, v4 or v6, is on the public
// internet. Anything that is not an address is not.
func PublicAddress(ip string) bool {
	if four := v4(ip); four != nil {
		return publicV4(four)
	}
	g := v6(ip)
	if g == nil {
		return false
	}
	embedded := func(hi, lo int) []int { return []int{hi >> 8, hi & 255, lo >> 8, lo & 255} }
	zero := func(from, to int) bool {
		for i := from; i < to; i++ {
			if g[i] != 0 {
				return false
			}
		}
		return true
	}
	// IPv4 inside IPv6: mapped (::ffff:0:0/96), the old compatible form (::/96), and NAT64 (64:ff9b::/96).
	if zero(0, 5) && (g[5] == 0xffff || g[5] == 0) {
		if g[5] == 0 && g[6] == 0 && g[7] <= 1 {
			return false
		}
		return publicV4(embedded(g[6], g[7]))
	}
	if g[0] == 0x64 && g[1] == 0xff9b && zero(2, 6) {
		return publicV4(embedded(g[6], g[7]))
	}
	// 6to4 carries an IPv4 address in its second and third groups.
	if g[0] == 0x2002 {
		return publicV4(embedded(g[1], g[2]))
	}
	if g[0]&0xfe00 == 0xfc00 || g[0]&0xffc0 == 0xfe80 || g[0]&0xff00 == 0xff00 {
		return false
	}
	// Teredo, documentation, and discard prefixes.
	if g[0] == 0x2001 && (g[1] == 0 || g[1] == 0xdb8) {
		return false
	}
	if g[0] == 0x100 && zero(1, 4) {
		return false
	}
	return true
}

// metadataNames are names clouds give their metadata services.
var metadataNames = map[string]bool{"metadata": true, "metadata.google.internal": true, "metadata.goog": true, "instance-data": true, "instance-data.ec2.internal": true}

// MetadataAddress reports whether an address is link-local (169.254.0.0/16, fe80::/10) or a cloud's metadata
// service (fd00:ec2::254, Alibaba's 100.100.100.200), in any of its IPv6 spellings. A model's API or a mail
// server is never there, though it may well be on this computer or a private network, so those stay allowed
// where this is checked.
func MetadataAddress(ip string) bool {
	inner := v4(ip)
	var g []int
	if inner == nil {
		g = v6(ip)
	}
	zero := func(from, to int) bool {
		for i := from; i < to; i++ {
			if g[i] != 0 {
				return false
			}
		}
		return true
	}
	// IPv4 inside IPv6, mapped (::ffff:0:0/96), compatible (::/96), or NAT64 (64:ff9b::/96), is read as IPv4.
	if g != nil && ((zero(0, 5) && (g[5] == 0xffff || g[5] == 0)) || (g[0] == 0x64 && g[1] == 0xff9b && zero(2, 6))) {
		inner = []int{g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255}
	}
	if inner != nil {
		return (inner[0] == 169 && inner[1] == 254) || (inner[0] == 100 && inner[1] == 100 && inner[2] == 100 && inner[3] == 200)
	}
	if g == nil {
		return false
	}
	if g[0]&0xffc0 == 0xfe80 {
		return true
	}
	return g[0] == 0xfd00 && g[1] == 0xec2 && zero(2, 7) && g[7] == 0x254
}

var bracketsAndDots = regexp.MustCompile(`^\[|\]$|\.+$`)

// MetadataHost reports whether a host, by its name, its address, or any address its name resolves to now, is
// link-local or a metadata service. A name that does not resolve here is let through, since the connection
// then goes nowhere such a check could have stopped.
func MetadataHost(ctx context.Context, host string) bool {
	name := bracketsAndDots.ReplaceAllString(strings.ToLower(strings.TrimSpace(host)), "")
	if metadataName(name) {
		return true
	}
	if v4(name) != nil || v6(name) != nil {
		return false
	}
	found, err := Resolver(ctx, name)
	if err != nil {
		return false
	}
	for _, a := range found {
		if MetadataAddress(a) {
			return true
		}
	}
	return false
}

// metadataName reports whether a host, cleaned, is a metadata name or a link-local or metadata address.
func metadataName(name string) bool {
	return metadataNames[name] || MetadataAddress(name)
}

// Resolver looks a name up; net.DefaultResolver unless a test sets another.
var Resolver = func(ctx context.Context, name string) ([]string, error) {
	return net.DefaultResolver.LookupHost(ctx, name)
}

// PublicAddresses are the public addresses a name resolves to, for setting
// up DNS records. None where it does not resolve.
func PublicAddresses(ctx context.Context, name string) []string {
	found, err := Resolver(ctx, name)
	if err != nil {
		return []string{}
	}
	out := []string{}
	seen := map[string]bool{}
	for _, a := range found {
		if PublicAddress(a) && !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}
	return out
}

// ResolvesPrivately reports whether a name resolves to an address off the
// public internet. False when it does not resolve.
func ResolvesPrivately(ctx context.Context, name string) bool {
	found, err := Resolver(ctx, name)
	if err != nil {
		return false
	}
	for _, a := range found {
		if !PublicAddress(a) {
			return true
		}
	}
	return false
}

// checksAtDial reports whether a Fetcher is the built-in one, which with
// PublicOnly refuses to connect to an address off the public internet.
func checksAtDial(fetcher Fetcher) bool {
	switch fetcher.(type) {
	case HTTPFetcher, *HTTPFetcher:
		return true
	}
	return false
}

// PublicFetch fetches an https URL on the public internet as init says,
// following up to redirects redirects that stay on it, within init.Timeout
// in all (30 seconds when zero). Only a GET follows redirects; anything else
// comes back with the redirect as it is. It fails with a
// *PrivateAddressError for an address off it, and a timed-out FetchError
// when time runs out. A redirect past the last one comes back as it is.
func PublicFetch(ctx context.Context, fetcher Fetcher, target string, init FetchInit, redirects int) (*Response, error) {
	if init.Timeout <= 0 {
		init.Timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, init.Timeout)
	defer cancel()
	init.Method = strings.ToUpper(init.Method)
	if init.Method == "" {
		init.Method = "GET"
	}
	if init.Method != "GET" {
		redirects = 0
	}
	init.Redirect = "manual"
	init.PublicOnly = true
	u, err := whatwg.Parse(target)
	if err != nil {
		return nil, &FetchError{Message: "Invalid URL"}
	}
	for hop := 0; ; hop++ {
		if u.Protocol != "https:" {
			return nil, &PrivateAddressError{u.Href()}
		}
		host := strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(u.Hostname, "["), "]"))
		if (v4(host) != nil || v6(host) != nil) && !PublicAddress(host) {
			return nil, &PrivateAddressError{host}
		}
		if host == "localhost" || strings.HasSuffix(host, ".localhost") {
			return nil, &PrivateAddressError{host}
		}
		// The built-in Fetcher checks the address it connects to. Another may
		// not honour PublicOnly, so the name is looked up first, and one that
		// answers with an address off the public internet is never fetched.
		if !checksAtDial(fetcher) && v4(host) == nil && v6(host) == nil && ResolvesPrivately(ctx, host) {
			return nil, &PrivateAddressError{host}
		}
		answer, err := fetcher.Fetch(ctx, u.Href(), init)
		if err != nil {
			// Whichever way the runtime says it gave up, the caller hears that time ran out.
			if ctx.Err() != nil {
				return nil, &FetchError{Message: "The operation was aborted due to timeout", Timeout: true}
			}
			return nil, err
		}
		location := answer.Header.Get("location")
		if answer.Status < 300 || answer.Status >= 400 || location == "" || hop >= redirects {
			return answer, nil
		}
		next, err := whatwg.Parse(location, u.Href())
		if err != nil {
			return nil, &FetchError{Message: "Invalid URL"}
		}
		u = next
	}
}

// MetadataAddressError is a request refused before anything was fetched,
// because the address is link-local or a cloud's metadata service.
type MetadataAddressError struct{ Host string }

func (e *MetadataAddressError) Error() string {
	return e.Host + " is a link-local or cloud metadata address, which Runlight never connects to"
}

// RedirectRefusedError is a request refused before anything was sent there,
// because a service's redirect led to another origin.
type RedirectRefusedError struct{ Host, To string }

func (e *RedirectRefusedError) Error() string {
	return e.Host + " redirected to " + e.To + ". Runlight sends a service's key and request only to the address it was set up with, so set it up with that address instead"
}

// bodyHeaders describe a body, and go with it when a redirect turns a request into a GET.
var bodyHeaders = []string{"content-type", "content-length", "content-encoding", "content-language", "content-location"}

// ServiceFetch fetches from a service someone set up, such as an AI model's
// API or a mail webhook, which may well be on this computer or a private
// network, but is never at a link-local or cloud metadata address. The
// address is checked, and so is every redirect's, up to redirects of them,
// each followed as fetch follows it: a 303, or a 301 or 302 answering a
// POST, goes on as a GET with no body. Only a redirect on the same origin is
// followed: the request carries a key, in whatever header the service names
// it, and a 307 or 308 would carry its body too, an email or a conversation,
// so a redirect to another origin, https to http among them, is refused
// before anything is sent there. A redirect past the last one comes back as
// it is. init.Timeout is the limit for all of it (30 seconds when zero). It
// fails with a *MetadataAddressError or a *RedirectRefusedError for an
// address it refuses. The real Fetcher checks the address the connection
// uses (FetchInit.ServiceOnly); for any other, the name is looked up first.
func ServiceFetch(ctx context.Context, fetcher Fetcher, target string, init FetchInit, redirects int) (*Response, error) {
	if init.Timeout <= 0 {
		init.Timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, init.Timeout)
	defer cancel()
	init.Method = strings.ToUpper(init.Method)
	if init.Method == "" {
		init.Method = "GET"
	}
	init.Redirect = "manual"
	init.ServiceOnly = true
	init.Headers = init.Headers.Clone()
	u, err := whatwg.Parse(target)
	if err != nil {
		return nil, &FetchError{Message: "Invalid URL"}
	}
	for hop := 0; ; hop++ {
		host := strings.TrimSuffix(strings.TrimPrefix(u.Hostname, "["), "]")
		if checksAtDial(fetcher) {
			// The connection looks the name up and checks what it got, so a name that answers differently
			// a moment later, or not at all, gets nowhere.
			if metadataName(bracketsAndDots.ReplaceAllString(strings.ToLower(strings.TrimSpace(host)), "")) {
				return nil, &MetadataAddressError{host}
			}
		} else if MetadataHost(ctx, host) {
			return nil, &MetadataAddressError{host}
		}
		answer, err := fetcher.Fetch(ctx, u.Href(), init)
		if err != nil {
			// Whichever way the runtime says it gave up, the caller hears that time ran out.
			if ctx.Err() != nil {
				return nil, &FetchError{Message: "The operation was aborted due to timeout", Timeout: true}
			}
			return nil, err
		}
		location := answer.Header.Get("location")
		if answer.Status < 300 || answer.Status >= 400 || location == "" || hop >= redirects {
			return answer, nil
		}
		next, err := whatwg.Parse(location, u.Href())
		if err != nil {
			return nil, &FetchError{Message: "Invalid URL"}
		}
		if next.Origin() != u.Origin() {
			there := strings.TrimSuffix(strings.TrimPrefix(next.Hostname, "["), "]")
			if MetadataHost(ctx, there) {
				return nil, &MetadataAddressError{there}
			}
			to := next.Protocol
			if next.Protocol == "https:" || next.Protocol == "http:" {
				to = next.Origin()
			}
			return nil, &RedirectRefusedError{u.Host(), to}
		}
		if answer.Status == 303 || ((answer.Status == 301 || answer.Status == 302) && init.Method == "POST") {
			if init.Method != "HEAD" {
				init.Method = "GET"
			}
			init.Body = nil
			for _, name := range bodyHeaders {
				init.Headers.Delete(name)
			}
		}
		u = next
	}
}

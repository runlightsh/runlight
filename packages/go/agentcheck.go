package runlight

// Checks a request that names an AI agent against the addresses that agent's
// company publishes. Every list is in the same shape, {"prefixes":
// [{"ipv4Prefix": "a.b.c.d/n"} or {"ipv6Prefix": "x::/n"}]}.
//
// The answer is "verified" when the address is in the list, "mismatch" when
// the company publishes a list and the address is not in it, and "" when
// there is nothing to check against: no list for that agent, or no usable
// address. The address is only compared, never kept.

import (
	"context"
	"strconv"
	"strings"
	"time"

	"runlight.sh/go/internal/assets"
	"runlight.sh/go/internal/js"
	"runlight.sh/go/internal/web"
)

// A list of more prefixes than this, or a reply bigger than maxListBytes, is not a list we read.
const (
	maxPrefixes  = 20_000
	maxListBytes = 4_000_000
)

// address is an IPv4 address (v 4, in lo) or an IPv6 one (v 6, hi and lo).
type address struct {
	v      int
	hi, lo uint64
}

// prefix is a list entry such as 20.171.206.0/24, its base held as an address of its family.
type prefix struct {
	base address
	bits int
}

func digits(s string, most int) bool {
	if s == "" || len(s) > most {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func ipv4(text string) (uint32, bool) {
	parts := strings.Split(text, ".")
	if len(parts) != 4 {
		return 0, false
	}
	var n uint32
	for _, part := range parts {
		if !digits(part, 3) {
			return 0, false
		}
		b, _ := strconv.Atoi(part)
		if b > 255 {
			return 0, false
		}
		n = n<<8 | uint32(b)
	}
	return n, true
}

func hexGroup(s string) (uint64, bool) {
	if s == "" || len(s) > 4 {
		return 0, false
	}
	n, err := strconv.ParseUint(s, 16, 16)
	return n, err == nil
}

func ipv6(text string) (hi, lo uint64, ok bool) {
	if text == "" || len(strings.Split(text, "::")) > 2 {
		return 0, 0, false
	}
	for i := 0; i < len(text); i++ {
		c := text[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' || c == ':' || c == '.') {
			return 0, 0, false
		}
	}
	// A dotted IPv4 tail ("::ffff:1.2.3.4") stands for the last two groups.
	groups := text
	if strings.Contains(text, ".") {
		dot := strings.LastIndex(text, ":")
		tail, ok := ipv4(text[dot+1:])
		if !ok {
			return 0, 0, false
		}
		groups = text[:dot+1] + strconv.FormatUint(uint64(tail>>16), 16) + ":" + strconv.FormatUint(uint64(tail&0xffff), 16)
	}
	head, rest, double := strings.Cut(groups, "::")
	var left, right []string
	if head != "" {
		left = strings.Split(head, ":")
	}
	if double && rest != "" {
		right = strings.Split(rest, ":")
	}
	missing := 8 - len(left) - len(right)
	if !double && missing != 0 || double && missing < 1 {
		return 0, 0, false
	}
	all := append([]string{}, left...)
	if double {
		for range missing {
			all = append(all, "0")
		}
	}
	all = append(all, right...)
	for i, group := range all {
		n, ok := hexGroup(group)
		if !ok {
			return 0, 0, false
		}
		if i < 4 {
			hi = hi<<16 | n
		} else {
			lo = lo<<16 | n
		}
	}
	return hi, lo, true
}

// parseAddress is an address as the check reads it: surrounding space,
// [brackets], and an IPv6 zone ("%eth0") are ignored, and an IPv4 address
// written as IPv6 (::ffff:1.2.3.4) is read as IPv4. False when it is not one.
func parseAddress(text string) (address, bool) {
	s := js.Trim(text)
	if strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") {
		s = s[1 : len(s)-1]
	}
	if zone := strings.Index(s, "%"); zone != -1 {
		s = s[:zone]
	}
	if s == "" {
		return address{}, false
	}
	if !strings.Contains(s, ":") {
		n, ok := ipv4(s)
		return address{v: 4, lo: uint64(n)}, ok
	}
	hi, lo, ok := ipv6(s)
	if !ok {
		return address{}, false
	}
	if hi == 0 && lo>>32 == 0xffff {
		return address{v: 4, lo: lo & 0xffffffff}, true
	}
	return address{v: 6, hi: hi, lo: lo}, true
}

// parsePrefix is a prefix such as 20.171.206.0/24 or 2600:1f28::/56. Bits past the length are ignored.
func parsePrefix(text string) (prefix, bool) {
	head, bitsText, found := strings.Cut(text, "/")
	if !found || !digits(bitsText, 3) {
		return prefix{}, false
	}
	bits, _ := strconv.Atoi(bitsText)
	if strings.Contains(head, ":") {
		hi, lo, ok := ipv6(head)
		if !ok || bits > 128 {
			return prefix{}, false
		}
		return prefix{address{v: 6, hi: hi, lo: lo}, bits}, true
	}
	n, ok := ipv4(head)
	if !ok || bits > 32 {
		return prefix{}, false
	}
	return prefix{address{v: 4, lo: uint64(n)}, bits}, true
}

// top is the first bits of a 128-bit number.
func top(hi, lo uint64, width, bits int) (uint64, uint64) {
	shift := width - bits
	switch {
	case shift >= 128:
		return 0, 0
	case shift >= 64:
		return 0, hi >> (shift - 64)
	case shift == 0:
		return hi, lo
	}
	return hi >> shift, lo>>shift | hi<<(64-shift)
}

func (p prefix) covers(a address) bool {
	if p.base.v != a.v {
		return false
	}
	width := 128
	if a.v == 4 {
		width = 32
	}
	ph, pl := top(p.base.hi, p.base.lo, width, p.bits)
	ah, al := top(a.hi, a.lo, width, p.bits)
	return ph == ah && pl == al
}

// ReadRangeList is the prefixes in a published list, parsed as by js.Parse,
// or false when it is not a list in the expected shape (not an object, no
// prefixes, an entry that is not a prefix, or too many). One bad entry
// rejects the whole list, so a half broken download never replaces a good copy.
func ReadRangeList(body any) ([]string, bool) {
	o, isObject := body.(*js.Object)
	if !isObject || o == nil {
		return nil, false
	}
	prefixes, isList := o.Value("prefixes").([]any)
	if !isList || len(prefixes) == 0 || len(prefixes) > maxPrefixes {
		return nil, false
	}
	out := make([]string, 0, len(prefixes))
	for _, entry := range prefixes {
		e, isEntry := entry.(*js.Object)
		if !isEntry || e == nil {
			return nil, false
		}
		v4, isV4 := e.Value("ipv4Prefix").(string)
		text := v4
		if !isV4 {
			v6, isV6 := e.Value("ipv6Prefix").(string)
			if !isV6 {
				return nil, false
			}
			text = v6
		}
		text = js.Trim(text)
		p, ok := parsePrefix(text)
		if !ok || isV4 != (p.base.v == 4) {
			return nil, false
		}
		out = append(out, text)
	}
	return out, true
}

// rangeListOf reads back a list kept as plain prefixes, as the database keeps them: an entry with a colon is
// IPv6, any other IPv4, and anything that is not a prefix of its family rejects the list.
func rangeListOf(list any) ([]string, bool) {
	items, isList := list.([]any)
	if !isList {
		return nil, false
	}
	entries := make([]any, len(items))
	for i, item := range items {
		key := "ipv4Prefix"
		if strings.Contains(js.String(item), ":") {
			key = "ipv6Prefix"
		}
		entries[i] = js.NewObject(key, item)
	}
	return ReadRangeList(js.NewObject("prefixes", entries))
}

// downloadRangeList downloads one published list. False when it cannot be fetched or read; the caller keeps
// what it had.
func downloadRangeList(ctx context.Context, fetcher Fetcher, url string, timeout time.Duration) ([]string, bool) {
	answer, err := fetcher.Fetch(ctx, url, FetchInit{Method: "GET", Headers: web.NewHeaders("accept", "application/json", "user-agent", "Runlight (+https://runlight.sh)"),
		Redirect: "follow", Timeout: timeout, MaxBytes: maxListBytes})
	if err != nil || answer == nil || !answer.OK() || answer.TooLong(maxListBytes) {
		return nil, false
	}
	if answer.Header != nil {
		if length, err := strconv.ParseFloat(answer.Header.Get("content-length"), 64); err == nil && length > maxListBytes {
			return nil, false
		}
	}
	body, err := answer.JSON()
	if err != nil {
		return nil, false
	}
	return ReadRangeList(body)
}

// rangeLists is the agents' address lists, each read into prefixes once.
type rangeLists map[string][]prefix

func compileRanges(lists map[string][]string) rangeLists {
	out := rangeLists{}
	for url, list := range lists {
		parsed := make([]prefix, 0, len(list))
		for _, text := range list {
			if p, ok := parsePrefix(text); ok {
				parsed = append(parsed, p)
			}
		}
		out[url] = parsed
	}
	return out
}

// bundledRanges is the lists that came with this version.
var bundledRanges = compileRanges(assets.AgentRanges.Lists)

func covered(ip string, list []prefix) bool {
	a, ok := parseAddress(ip)
	if !ok {
		return false
	}
	for _, p := range list {
		if p.covers(a) {
			return true
		}
	}
	return false
}

// InRanges is whether ip is inside any of the prefixes. False for an address that cannot be read.
func InRanges(ip string, list []string) bool {
	return covered(ip, compileRanges(map[string][]string{"": list})[""])
}

func checkCompiled(agent *AiAgent, ip string, lists rangeLists) string {
	if agent == nil || agent.Ranges == "" {
		return ""
	}
	list, ok := lists[agent.Ranges]
	if !ok {
		return ""
	}
	if _, ok := parseAddress(ip); !ok {
		return ""
	}
	if covered(ip, list) {
		return "verified"
	}
	return "mismatch"
}

// CheckAgent is the check for one request that names agent, made from ip:
// "verified", "mismatch", or "" when there is nothing to check against (see
// the top of this file). lists maps each list's address to its prefixes.
func CheckAgent(agent AiAgent, ip string, lists map[string][]string) string {
	if agent.Ranges == "" {
		return ""
	}
	list, ok := lists[agent.Ranges]
	if !ok {
		return ""
	}
	return checkCompiled(&agent, ip, compileRanges(map[string][]string{agent.Ranges: list}))
}

package whatwg

import (
	_ "embed"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"
)

// idna.json is written by scripts/go-idna.mjs from Node's own URL parser, so a host name here is mapped,
// normalized, and checked as new URL() does, whatever Unicode version Go was built with. Go's standard library
// has neither UTS 46's mapping nor Unicode normalization, and this module requires nothing.
//
//go:embed idna.json
var idnaJSON []byte

var (
	idnaOnce sync.Once
	// mapped is what each non-ASCII character becomes ("" for one that is dropped).
	mapped map[rune]string
	// forbidden are the ranges of characters that make a host invalid, sorted.
	forbidden [][2]rune
	// rightToLeft are the ranges of characters only a right-to-left label may hold, sorted.
	rightToLeft [][2]rune
	// viramas are the marks a zero-width joiner may follow.
	viramas map[rune]bool
	// decomposition is the full canonical decomposition of each character that has one.
	decomposition map[rune][]rune
	// combiningRanges rank the combining marks in canonical order, sorted.
	combiningRanges [][3]int
	// compositions are the pairs that compose into one character.
	compositions map[[2]rune]rune
)

func loadIDNA() {
	var raw struct {
		Map        map[string]string `json:"map"`
		Disallowed [][2]rune         `json:"disallowed"`
		RTL        [][2]rune         `json:"rtl"`
		Viramas    []rune            `json:"viramas"`
		NFD        map[string]string `json:"nfd"`
		CCC        [][3]int          `json:"ccc"`
		Pairs      [][3]rune         `json:"pairs"`
	}
	if err := json.Unmarshal(idnaJSON, &raw); err != nil {
		panic("whatwg: idna.json: " + err.Error())
	}
	cp := func(key string) rune {
		n, _ := strconv.ParseUint(key, 16, 32)
		return rune(n)
	}
	mapped = make(map[rune]string, len(raw.Map))
	for k, v := range raw.Map {
		mapped[cp(k)] = v
	}
	forbidden, rightToLeft = raw.Disallowed, raw.RTL
	viramas = make(map[rune]bool, len(raw.Viramas))
	for _, r := range raw.Viramas {
		viramas[r] = true
	}
	decomposition = make(map[rune][]rune, len(raw.NFD))
	for k, v := range raw.NFD {
		decomposition[cp(k)] = []rune(v)
	}
	combiningRanges = raw.CCC
	compositions = make(map[[2]rune]rune, len(raw.Pairs))
	for _, p := range raw.Pairs {
		compositions[[2]rune{p[0], p[1]}] = p[2]
	}
}

func inRanges(ranges [][2]rune, r rune) bool {
	i := sort.Search(len(ranges), func(i int) bool { return ranges[i][1] >= r })
	return i < len(ranges) && ranges[i][0] <= r
}

func disallowed(r rune) bool { return inRanges(forbidden, r) }

// combiningRank is the place of a combining mark in canonical order, or 0 for a character that is not one.
func combiningRank(r rune) int {
	i := sort.Search(len(combiningRanges), func(i int) bool { return rune(combiningRanges[i][1]) >= r })
	if i < len(combiningRanges) && rune(combiningRanges[i][0]) <= r {
		return combiningRanges[i][2]
	}
	return 0
}

// Hangul syllables are worked out, not tabled.
const (
	hangulBase   = 0xac00
	hangulL      = 0x1100
	hangulV      = 0x1161
	hangulT      = 0x11a7
	hangulCountL = 19
	hangulCountV = 21
	hangulCountT = 28
	hangulCountN = hangulCountV * hangulCountT
	hangulCount  = hangulCountL * hangulCountN
)

// decompose appends the full canonical decomposition of a character.
func decompose(out []rune, r rune) []rune {
	if r < 0x80 {
		return append(out, r)
	}
	if index := r - hangulBase; index >= 0 && index < hangulCount {
		out = append(out, hangulL+index/hangulCountN, hangulV+(index%hangulCountN)/hangulCountT)
		if t := index % hangulCountT; t != 0 {
			out = append(out, hangulT+t)
		}
		return out
	}
	if d, ok := decomposition[r]; ok {
		return append(out, d...)
	}
	return append(out, r)
}

// compose is the character two compose into, if they do.
func compose(first, second rune) (rune, bool) {
	if l := first - hangulL; l >= 0 && l < hangulCountL {
		if v := second - hangulV; v >= 0 && v < hangulCountV {
			return hangulBase + (l*hangulCountV+v)*hangulCountT, true
		}
	}
	if s := first - hangulBase; s >= 0 && s < hangulCount && s%hangulCountT == 0 {
		if t := second - hangulT; t > 0 && t < hangulCountT {
			return first + t, true
		}
	}
	c, ok := compositions[[2]rune{first, second}]
	return c, ok
}

// NFC is String.prototype.normalize("NFC").
func NFC(s string) string {
	if isASCII(s) {
		return s
	}
	idnaOnce.Do(loadIDNA)
	var runes []rune
	for _, r := range s {
		runes = decompose(runes, r)
	}
	// Canonical order: each run of combining marks sorted by rank, marks of one rank keeping their places.
	for i := 0; i < len(runes); {
		if combiningRank(runes[i]) == 0 {
			i++
			continue
		}
		j := i
		for j < len(runes) && combiningRank(runes[j]) != 0 {
			j++
		}
		run := runes[i:j]
		sort.SliceStable(run, func(a, b int) bool { return combiningRank(run[a]) < combiningRank(run[b]) })
		i = j
	}
	// Composition: each mark joins the last starter before it unless a mark of the same or a higher rank, or
	// a starter, stands between them.
	out := make([]rune, 0, len(runes))
	starter := -1
	last := 0
	for _, r := range runes {
		rank := combiningRank(r)
		if starter >= 0 && (last < rank || last == 0) {
			if c, ok := compose(out[starter], r); ok {
				out[starter] = c
				continue
			}
		}
		if rank == 0 {
			starter = len(out)
		}
		last = rank
		out = append(out, r)
	}
	return string(out)
}

// mapHost is UTS 46's mapping of a host name as the URL standard asks for it: upper case folded, width and
// compatibility forms replaced, characters that other dots stand for written as dots, ignorable ones dropped,
// and the result in normalization form C. False where a character is not allowed in a host.
func mapHost(host string) (string, bool) {
	if isASCII(host) {
		return strings.ToLower(host), true
	}
	idnaOnce.Do(loadIDNA)
	var b strings.Builder
	for _, r := range host {
		switch {
		case r < 0x80:
			if r >= 'A' && r <= 'Z' {
				r += 'a' - 'A'
			}
			b.WriteRune(r)
		case r == 0x200c || r == 0x200d:
			// Kept, where the standard allows it (after a virama); checked below.
			b.WriteRune(r)
		case disallowed(r):
			return "", false
		default:
			if m, ok := mapped[r]; ok {
				b.WriteString(m)
			} else {
				b.WriteRune(r)
			}
		}
	}
	return NFC(b.String()), true
}

// validLabel is whether a mapped label may be written: it does not start with a combining mark, a zero-width
// joiner follows a virama, a non-joiner a virama or right-to-left text, and a label with right-to-left
// characters has no other letters, as the bidi rule of UTS 46 forbids. Its other bidi rules (where digits and
// marks may stand) are not checked.
func validLabel(label string) bool {
	runes := []rune(label)
	if len(runes) == 0 {
		return true
	}
	if unicode.IsMark(runes[0]) {
		return false
	}
	right, other := false, false
	for i, r := range runes {
		if r == 0x200d && (i == 0 || !viramas[runes[i-1]]) {
			return false
		}
		// A non-joiner follows a virama too, or sits between right-to-left letters (the standard asks for ones
		// that join, which this does not tell apart).
		if r == 0x200c && !(i > 0 && viramas[runes[i-1]]) && !(i > 0 && i+1 < len(runes) && inRanges(rightToLeft, runes[i-1]) && inRanges(rightToLeft, runes[i+1])) {
			return false
		}
		switch {
		case inRanges(rightToLeft, r):
			right = true
		case unicode.IsLetter(r):
			other = true
		}
	}
	return !(right && other)
}

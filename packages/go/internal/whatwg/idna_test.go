package whatwg

import "testing"

// Hosts as new URL() in Node 24 reads them; "" where it throws.
func TestHostsAreMappedAndNormalizedAsNodeReadsThem(t *testing.T) {
	for input, want := range map[string]string{
		"https://ＥＸＡＭＰＬＥ.com/":           "example.com",
		"https://ｅxample.com/":           "example.com",
		"https://example。com/":           "example.com",
		"https://127。0。0。1/":             "127.0.0.1",
		"https://ex\u00adample.com/":     "example.com",
		"https://①②⑦.0.0.1/":             "127.0.0.1",
		"https://İstanbul.com/":          "xn--istanbul-o0e.com",
		"https://faß.de/":                "xn--fa-hia.de",
		"https://Bücher.example/":        "xn--bcher-kva.example",
		"https://e\u0301.example/":       "xn--9ca.example",
		"https://\u1100\u1161.example/":  "xn--o39a.example",
		"https://xn--bcher-kva.example/": "xn--bcher-kva.example",
		"https://XN--BCHER-KVA.example/": "xn--bcher-kva.example",
		"https://क\u094d\u200dष.com/":    "xn--11b2ezcw70k.com",
		"https://می\u200cخواهم.ir/":      "xn--mgbn2ecje63gr19l.ir",
		"https://a\u200db.example/":      "",
		"https://xn--a.com/":             "",
		"https://a\ufffdb.example/":      "",
		"https://\u0301a.example/":       "",
		"https://aאb.example/":           "",
		"https://\u00ad/":                "",
	} {
		u, err := Parse(input)
		got := ""
		if err == nil {
			got = u.Hostname
		}
		if got != want {
			t.Errorf("%+q: %q, want %q", input, got, want)
		}
	}
}

func TestNFCComposesAndOrders(t *testing.T) {
	for input, want := range map[string]string{
		"e\u0301":            "\u00e9",
		"a\u0323\u0307":      "\u1ea1\u0307",
		"a\u0307\u0323":      "\u1ea1\u0307",
		"\u1100\u1161\u11a8": "\uac01",
		"\u0f73":             "\u0f71\u0f72",
		"\u212b":             "\u00c5",
		"plain":              "plain",
	} {
		if got := NFC(input); got != want {
			t.Errorf("%+q: %+q, want %+q", input, got, want)
		}
	}
}

// A special URL with the base's own scheme but no two slashes is relative to the base, as in a browser.
func TestASpecialURLOfTheBasesSchemeIsRelative(t *testing.T) {
	const base = "https://base.example/dir/page"
	for input, want := range map[string]string{
		"https:foo":                "https://base.example/dir/foo",
		"https:/evil.example/x":    "https://base.example/evil.example/x",
		"HTTPS:/x":                 "https://base.example/x",
		"https://evil.example/x":   "https://evil.example/x",
		"https:\\\\evil.example/x": "https://evil.example/x",
		"http:evil.example/x":      "http://evil.example/x",
		"https:?q=1":               "https://base.example/dir/page?q=1",
	} {
		u, err := Parse(input, base)
		if err != nil {
			t.Errorf("%q: %v", input, err)
			continue
		}
		if got := u.Href(); got != want {
			t.Errorf("%q: %s, want %s", input, got, want)
		}
	}
}

func TestBackslashesAfterAQueryOrFragmentAreText(t *testing.T) {
	u, err := Parse("https://example.com/a\\b?q=\\x#f\\y")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := u.Href(), "https://example.com/a/b?q=\\x#f\\y"; got != want {
		t.Errorf("%s, want %s", got, want)
	}
}

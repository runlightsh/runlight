package runlight

import (
	"slices"
	"strings"
	"testing"

	"runlight.sh/go/internal/assets"
	"runlight.sh/go/internal/js"
)

func TestAddressesAreReadAsTheSDKReadsThem(t *testing.T) {
	cases := []struct {
		text string
		want address
	}{
		{"20.171.206.17", address{v: 4, lo: 0x14abce11}},
		{" ::ffff:20.171.206.17 ", address{v: 4, lo: 0x14abce11}},
		{"::ffff:14ab:ce11", address{v: 4, lo: 0x14abce11}},
		{"[2600:1f28:365:8000::1]", address{v: 6, hi: 0x26001f2803658000, lo: 1}},
		{"fe80::1%eth0", address{v: 6, hi: 0xfe80 << 48, lo: 1}},
		{"::", address{v: 6}},
	}
	for _, c := range cases {
		if got, ok := parseAddress(c.text); !ok || got != c.want {
			t.Errorf("%q: %+v %v, want %+v", c.text, got, ok, c.want)
		}
	}
	for _, junk := range []string{"", "unknown", "256.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4x", "1::2::3", "12345::", ":1::", "1:2:3:4:5:6:7:8:9", "::ffff:1.2.3.256", "-"} {
		if got, ok := parseAddress(junk); ok {
			t.Errorf("%q read as %+v", junk, got)
		}
	}
}

func TestRangesOfAnyLengthInBothFamiliesIgnoreHostBitsPastTheLength(t *testing.T) {
	list := []string{"20.171.206.0/24", "34.162.230.222/32", "10.1.2.3/8", "2600:1f28:365:8000::/56", "0.0.0.0/0"}
	checks := []struct {
		ip   string
		list []string
		want bool
	}{
		{"20.171.206.255", list[0:1], true},
		{"20.171.207.0", list[0:1], false},
		{"34.162.230.222", list[1:2], true},
		{"34.162.230.223", list[1:2], false},
		{"10.200.0.1", list[2:3], true}, // 10.1.2.3/8 covers all of 10/8
		{"2600:1f28:365:80ff:ffff::1", list[3:4], true},
		{"2600:1f28:365:8100::1", list[3:4], false},
		{"20.171.206.1", list[3:4], false}, // an IPv4 address is never in an IPv6 prefix
		{"203.0.113.9", list[4:], true},    // /0 covers every IPv4 address
		{"not an address", list, false},
		{"::1", []string{"::/0"}, true},
		{"2600::1", []string{"2600::/128"}, false},
		{"2600::", []string{"2600::/128"}, true},
	}
	for _, c := range checks {
		if got := InRanges(c.ip, c.list); got != c.want {
			t.Errorf("%s in %v: %v", c.ip, c.list, got)
		}
	}
}

func parsedJSON(t *testing.T, text string) any {
	t.Helper()
	v, err := js.Parse(text)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestPublishedListsInTheSharedShapeAreReadAndAnythingElseRefusedWhole(t *testing.T) {
	got, ok := ReadRangeList(parsedJSON(t, `{"creationTime":"x","prefixes":[{"ipv4Prefix":"20.171.206.0/24"},{"ipv6Prefix":" 2600:1f28::/56 "}]}`))
	if !ok || !slices.Equal(got, []string{"20.171.206.0/24", "2600:1f28::/56"}) {
		t.Errorf("good list: %v %v", got, ok)
	}
	for _, bad := range []string{`null`, `[]`, `"x"`, `{}`, `{"prefixes":[]}`, `{"prefixes":"1.2.3.0/24"}`, `{"prefixes":[{"ipv4Prefix":"1.2.3.0"}]}`,
		`{"prefixes":[{"ipv4Prefix":"1.2.3.0/33"}]}`, `{"prefixes":[{"ipv4Prefix":"2600::/56"}]}`, `{"prefixes":[{"ipv6Prefix":"1.2.3.0/24"}]}`,
		`{"prefixes":[{"ipv4Prefix":"1.2.3.0/24"},{"other":"x"}]}`, `{"prefixes":[null]}`, `{"prefixes":[{"ipv4Prefix":5}]}`} {
		if got, ok := ReadRangeList(parsedJSON(t, bad)); ok {
			t.Errorf("%s read as %v", bad, got)
		}
	}
	many := `{"prefixes":[` + strings.TrimSuffix(strings.Repeat(`{"ipv4Prefix":"1.2.3.0/24"},`, 20_001), ",") + `]}`
	if _, ok := ReadRangeList(parsedJSON(t, many)); ok {
		t.Error("a list of more than 20000 prefixes is read")
	}
}

func agentNamed(t *testing.T, name string) AiAgent {
	t.Helper()
	for _, a := range AiAgents {
		if a.Name == name {
			return a
		}
	}
	t.Fatalf("no agent %s", name)
	return AiAgent{}
}

func TestAnAgentChecksOutDoesNotOrHasNothingToCheckAgainst(t *testing.T) {
	gptbot, meta := agentNamed(t, "GPTBot"), agentNamed(t, "meta-externalagent")
	lists := assets.AgentRanges.Lists
	for _, c := range []struct {
		agent    AiAgent
		ip       string
		lists    map[string][]string
		want, is string
	}{
		{gptbot, "20.171.206.17", lists, "verified", "in the list"},
		{gptbot, "198.51.100.23", lists, "mismatch", "elsewhere"},
		{gptbot, "", lists, "", "no address"},
		{gptbot, "garbage", lists, "", "not an address"},
		{meta, "157.240.0.1", lists, "", "Meta publishes no list"},
		{gptbot, "20.171.206.17", map[string][]string{}, "", "a list that is missing is nothing to check against"},
		{agentNamed(t, "ClaudeBot"), "216.73.216.10", lists, "verified", "ClaudeBot"},
		{agentNamed(t, "CCBot"), "2600:1f28:365:8000::5", lists, "verified", "CCBot over IPv6"},
	} {
		if got := CheckAgent(c.agent, c.ip, c.lists); got != c.want {
			t.Errorf("%s (%s): %q, want %q", c.is, c.ip, got, c.want)
		}
	}
}

func TestEveryAgentWithAListHasItBundledAndEveryBundledListIsReadWhole(t *testing.T) {
	for _, agent := range AiAgents {
		if agent.Ranges != "" && len(assets.AgentRanges.Lists[agent.Ranges]) == 0 {
			t.Errorf("%s: %s is not bundled", agent.Name, agent.Ranges)
		}
	}
	if len(assets.AgentRangeOrder) != len(assets.AgentRanges.Lists) {
		t.Errorf("%d lists in order, %d in all", len(assets.AgentRangeOrder), len(assets.AgentRanges.Lists))
	}
	for url, list := range assets.AgentRanges.Lists {
		items := make([]any, len(list))
		for i, p := range list {
			items[i] = p
		}
		again, ok := rangeListOf(items)
		if !ok || !slices.Equal(again, list) {
			t.Errorf("%s does not read back whole", url)
		}
	}
}

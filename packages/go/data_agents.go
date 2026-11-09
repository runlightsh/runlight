package runlight

import (
	"regexp"
	"strings"

	"runlight.sh/go/internal/js"
)

// AiAgent is an AI agent, matched on the user agent, checked before the bot
// test so it is recorded as a fetch rather than dropped.
//
// Kind "live" means an assistant fetched the page because a person asked
// about it just now. "crawl" is training or search indexing.
type AiAgent struct {
	Name    string `json:"name"`
	Company string `json:"company"`
	Kind    string `json:"kind"`
	// Token is matched case-insensitively as a substring of the user agent.
	Token string `json:"token"`
	// Ranges is the list of addresses its company publishes for it, which a
	// request naming it is checked against (see agentcheck.go). "" when the
	// company publishes none, so its requests stay claimed.
	Ranges string `json:"ranges,omitempty"`
}

// JSValue writes the agent as the SDK does, without ranges when its company publishes no list.
func (a AiAgent) JSValue() any {
	o := js.NewObject("name", a.Name, "company", a.Company, "kind", a.Kind, "token", a.Token)
	if a.Ranges != "" {
		o.Set("ranges", a.Ranges)
	}
	return o
}

const (
	openAIRanges     = "https://openai.com/"
	anthropicRanges  = "https://claude.com/crawling/bots.json"
	perplexityRanges = "https://www.perplexity.ai/"
)

// AiAgents is every AI agent Runlight knows, in the order they are tried.
var AiAgents = []AiAgent{
	{"ChatGPT-User", "OpenAI", "live", "chatgpt-user", openAIRanges + "chatgpt-user.json"},
	{"OAI-SearchBot", "OpenAI", "crawl", "oai-searchbot", openAIRanges + "searchbot.json"},
	{"GPTBot", "OpenAI", "crawl", "gptbot", openAIRanges + "gptbot.json"},
	{"Claude-User", "Anthropic", "live", "claude-user", anthropicRanges},
	{"Claude-SearchBot", "Anthropic", "crawl", "claude-searchbot", anthropicRanges},
	{"ClaudeBot", "Anthropic", "crawl", "claudebot", anthropicRanges},
	{"Claude-Web", "Anthropic", "crawl", "claude-web", anthropicRanges},
	{"anthropic-ai", "Anthropic", "crawl", "anthropic-ai", anthropicRanges},
	{"Perplexity-User", "Perplexity", "live", "perplexity-user", perplexityRanges + "perplexity-user.json"},
	{"PerplexityBot", "Perplexity", "crawl", "perplexitybot", perplexityRanges + "perplexitybot.json"},
	{"MistralAI-User", "Mistral", "live", "mistralai-user", "https://mistral.ai/mistralai-user-ips.json"},
	{"meta-externalfetcher", "Meta", "live", "meta-externalfetcher", ""},
	{"meta-externalagent", "Meta", "crawl", "meta-externalagent", ""},
	{"DuckAssistBot", "DuckDuckGo", "crawl", "duckassistbot", "https://duckduckgo.com/duckassistbot.json"},
	{"Amazonbot", "Amazon", "crawl", "amazonbot", ""},
	{"Bytespider", "ByteDance", "crawl", "bytespider", ""},
	{"CCBot", "Common Crawl", "crawl", "ccbot", "https://index.commoncrawl.org/ccbot.json"},
	{"cohere-ai", "Cohere", "crawl", "cohere-ai", ""},
	{"YouBot", "You.com", "crawl", "youbot", ""},
	{"Diffbot", "Diffbot", "crawl", "diffbot", ""},
	{"Timpibot", "Timpi", "crawl", "timpibot", ""},
}

// botPattern is the SDK's BOT_PATTERN without its two lookaheads,
// yandex(?!browser) and qwant(?!ify), which Go's regexp lacks; isBot tests
// those two by hand.
var botPattern = regexp.MustCompile(`bot\b|bot/|crawl|spider|slurp|scrap|fetch|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|validator|python|curl/|wget|httpclient|okhttp|java/|go-http|axios|node-fetch|undici|libwww|phantomjs|selenium|puppeteer|playwright|facebookexternalhit|embedly|whatsapp|telegram|discord|slackbot|skypeuripreview|bitlybot|feed|rss|reader|archive\.org|ia_archiver|semrush|ahrefs|mj12|dotbot|petalbot|bingpreview|baiduspider|sogou|exabot|seznam|applebot`)

// foldASCII lowercases ASCII letters only, as a JavaScript regex's /i
// flag without u compares them.
func foldASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// lookahead reports whether word appears in text not followed by not.
func lookahead(text, word, not string) bool {
	for at := 0; ; {
		i := strings.Index(text[at:], word)
		if i < 0 {
			return false
		}
		end := at + i + len(word)
		if !strings.HasPrefix(text[end:], not) {
			return true
		}
		at = at + i + 1
	}
}

// matchesBotPattern is BOT_PATTERN.test(ua). The pattern is matched against
// the text with its ASCII letters lowercased, which is what the /i flag
// does for a pattern of ASCII letters.
func matchesBotPattern(ua string) bool {
	lower := foldASCII(ua)
	return botPattern.MatchString(lower) || lookahead(lower, "yandex", "browser") || lookahead(lower, "qwant", "ify")
}

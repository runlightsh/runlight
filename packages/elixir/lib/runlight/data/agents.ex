defmodule Runlight.Data.Agents do
  @moduledoc false
  # Internal. AI agents, matched on the user agent, checked before the bot
  # test so they are recorded as fetches rather than dropped (the SDK's
  # data/agents.ts).
  #
  # "live" means an assistant fetched the page because a person asked about it
  # just now. "crawl" is training or search indexing.
  #
  # `ranges` is the list of addresses its company publishes for it, which a
  # request naming it is checked against (see Runlight.AgentCheck). Absent when
  # the company publishes none, so its requests stay claimed.

  @openai "https://openai.com/"
  @anthropic "https://claude.com/crawling/bots.json"
  @perplexity "https://www.perplexity.ai/"

  @agents [
    %{
      name: "ChatGPT-User",
      company: "OpenAI",
      kind: "live",
      token: "chatgpt-user",
      ranges: @openai <> "chatgpt-user.json"
    },
    %{
      name: "OAI-SearchBot",
      company: "OpenAI",
      kind: "crawl",
      token: "oai-searchbot",
      ranges: @openai <> "searchbot.json"
    },
    %{name: "GPTBot", company: "OpenAI", kind: "crawl", token: "gptbot", ranges: @openai <> "gptbot.json"},
    %{name: "Claude-User", company: "Anthropic", kind: "live", token: "claude-user", ranges: @anthropic},
    %{name: "Claude-SearchBot", company: "Anthropic", kind: "crawl", token: "claude-searchbot", ranges: @anthropic},
    %{name: "ClaudeBot", company: "Anthropic", kind: "crawl", token: "claudebot", ranges: @anthropic},
    %{name: "Claude-Web", company: "Anthropic", kind: "crawl", token: "claude-web", ranges: @anthropic},
    %{name: "anthropic-ai", company: "Anthropic", kind: "crawl", token: "anthropic-ai", ranges: @anthropic},
    %{
      name: "Perplexity-User",
      company: "Perplexity",
      kind: "live",
      token: "perplexity-user",
      ranges: @perplexity <> "perplexity-user.json"
    },
    %{
      name: "PerplexityBot",
      company: "Perplexity",
      kind: "crawl",
      token: "perplexitybot",
      ranges: @perplexity <> "perplexitybot.json"
    },
    %{
      name: "MistralAI-User",
      company: "Mistral",
      kind: "live",
      token: "mistralai-user",
      ranges: "https://mistral.ai/mistralai-user-ips.json"
    },
    %{name: "meta-externalfetcher", company: "Meta", kind: "live", token: "meta-externalfetcher"},
    %{name: "meta-externalagent", company: "Meta", kind: "crawl", token: "meta-externalagent"},
    %{
      name: "DuckAssistBot",
      company: "DuckDuckGo",
      kind: "crawl",
      token: "duckassistbot",
      ranges: "https://duckduckgo.com/duckassistbot.json"
    },
    %{name: "Amazonbot", company: "Amazon", kind: "crawl", token: "amazonbot"},
    %{name: "Bytespider", company: "ByteDance", kind: "crawl", token: "bytespider"},
    %{
      name: "CCBot",
      company: "Common Crawl",
      kind: "crawl",
      token: "ccbot",
      ranges: "https://index.commoncrawl.org/ccbot.json"
    },
    %{name: "cohere-ai", company: "Cohere", kind: "crawl", token: "cohere-ai"},
    %{name: "YouBot", company: "You.com", kind: "crawl", token: "youbot"},
    %{name: "Diffbot", company: "Diffbot", kind: "crawl", token: "diffbot"},
    %{name: "Timpibot", company: "Timpi", kind: "crawl", token: "timpibot"}
  ]

  @doc "Every AI agent, as `%{name, company, kind, token}` and `ranges` when it has a list; the token is matched case-insensitively in the user agent."
  @spec all() :: [map()]
  def all, do: @agents

  @doc "Anything that is clearly not a person in a browser."
  @spec bot_pattern() :: Regex.t()
  def bot_pattern,
    do:
      ~r/bot\b|bot\/|crawl|spider|slurp|scrap|fetch|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|validator|python|curl\/|wget|httpclient|okhttp|java\/|go-http|axios|node-fetch|undici|libwww|phantomjs|selenium|puppeteer|playwright|facebookexternalhit|embedly|whatsapp|telegram|discord|slackbot|skypeuripreview|bitlybot|feed|rss|reader|archive\.org|ia_archiver|semrush|ahrefs|mj12|dotbot|petalbot|bingpreview|yandex(?!browser)|baiduspider|sogou|exabot|seznam|qwant(?!ify)|applebot/i
end

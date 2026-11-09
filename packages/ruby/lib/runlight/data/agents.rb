# frozen_string_literal: true

module Runlight
  module Data
    # AI agents, matched on the user agent, checked before the bot test so they
    # are recorded as fetches rather than dropped.
    #
    # "live" means an assistant fetched the page because a person asked about it
    # just now. "crawl" is training or search indexing.
    #
    # Each agent is a Hash {"name", "company", "kind" ("live" or "crawl"), "token", "ranges"}; the token is matched
    # case-insensitively as a substring of the user agent. "ranges" is the list of addresses its company
    # publishes for it, which a request naming it is checked against (see AgentCheck); it is absent when the
    # company publishes none, so its requests stay claimed.
    module Agents
      OPENAI = "https://openai.com/"
      ANTHROPIC = "https://claude.com/crawling/bots.json"
      PERPLEXITY = "https://www.perplexity.ai/"
      private_constant :OPENAI, :ANTHROPIC, :PERPLEXITY

      AI_AGENTS = [
        { "name" => "ChatGPT-User", "company" => "OpenAI", "kind" => "live", "token" => "chatgpt-user", "ranges" => "#{OPENAI}chatgpt-user.json" },
        { "name" => "OAI-SearchBot", "company" => "OpenAI", "kind" => "crawl", "token" => "oai-searchbot", "ranges" => "#{OPENAI}searchbot.json" },
        { "name" => "GPTBot", "company" => "OpenAI", "kind" => "crawl", "token" => "gptbot", "ranges" => "#{OPENAI}gptbot.json" },
        { "name" => "Claude-User", "company" => "Anthropic", "kind" => "live", "token" => "claude-user", "ranges" => ANTHROPIC },
        { "name" => "Claude-SearchBot", "company" => "Anthropic", "kind" => "crawl", "token" => "claude-searchbot", "ranges" => ANTHROPIC },
        { "name" => "ClaudeBot", "company" => "Anthropic", "kind" => "crawl", "token" => "claudebot", "ranges" => ANTHROPIC },
        { "name" => "Claude-Web", "company" => "Anthropic", "kind" => "crawl", "token" => "claude-web", "ranges" => ANTHROPIC },
        { "name" => "anthropic-ai", "company" => "Anthropic", "kind" => "crawl", "token" => "anthropic-ai", "ranges" => ANTHROPIC },
        { "name" => "Perplexity-User", "company" => "Perplexity", "kind" => "live", "token" => "perplexity-user", "ranges" => "#{PERPLEXITY}perplexity-user.json" },
        { "name" => "PerplexityBot", "company" => "Perplexity", "kind" => "crawl", "token" => "perplexitybot", "ranges" => "#{PERPLEXITY}perplexitybot.json" },
        { "name" => "MistralAI-User", "company" => "Mistral", "kind" => "live", "token" => "mistralai-user", "ranges" => "https://mistral.ai/mistralai-user-ips.json" },
        { "name" => "meta-externalfetcher", "company" => "Meta", "kind" => "live", "token" => "meta-externalfetcher" },
        { "name" => "meta-externalagent", "company" => "Meta", "kind" => "crawl", "token" => "meta-externalagent" },
        { "name" => "DuckAssistBot", "company" => "DuckDuckGo", "kind" => "crawl", "token" => "duckassistbot", "ranges" => "https://duckduckgo.com/duckassistbot.json" },
        { "name" => "Amazonbot", "company" => "Amazon", "kind" => "crawl", "token" => "amazonbot" },
        { "name" => "Bytespider", "company" => "ByteDance", "kind" => "crawl", "token" => "bytespider" },
        { "name" => "CCBot", "company" => "Common Crawl", "kind" => "crawl", "token" => "ccbot", "ranges" => "https://index.commoncrawl.org/ccbot.json" },
        { "name" => "cohere-ai", "company" => "Cohere", "kind" => "crawl", "token" => "cohere-ai" },
        { "name" => "YouBot", "company" => "You.com", "kind" => "crawl", "token" => "youbot" },
        { "name" => "Diffbot", "company" => "Diffbot", "kind" => "crawl", "token" => "diffbot" },
        { "name" => "Timpibot", "company" => "Timpi", "kind" => "crawl", "token" => "timpibot" },
      ].freeze

      # Anything that is clearly not a person in a browser. Matched on the user agent's bytes (Ua.bot? reads it
      # binary), so case folding stays ASCII as JavaScript's /i does, and the long s never matches "s" nor the
      # Kelvin sign "k".
      BOT_PATTERN = %r{bot\b|bot/|crawl|spider|slurp|scrap|fetch|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|validator|python|curl/|wget|httpclient|okhttp|java/|go-http|axios|node-fetch|undici|libwww|phantomjs|selenium|puppeteer|playwright|facebookexternalhit|embedly|whatsapp|telegram|discord|slackbot|skypeuripreview|bitlybot|feed|rss|reader|archive\.org|ia_archiver|semrush|ahrefs|mj12|dotbot|petalbot|bingpreview|yandex(?!browser)|baiduspider|sogou|exabot|seznam|qwant(?!ify)|applebot}in
    end
  end
end

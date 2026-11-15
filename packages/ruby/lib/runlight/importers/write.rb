# frozen_string_literal: true

module Runlight
  module Importers
    # Writing an imported link and its history, and the names other tools use, in Runlight's spelling.
    module Write
      # Domains run by the shorteners themselves. Links there stay on Runlight's own path.
      SHORTENER_DOMAINS = %w[bit.ly bitly.com j.mp dub.sh dub.co dub.link short.gy rebrand.ly rebrandly.com rb.gy].freeze
      # The most clicks a day one imported link gets from a daily count.
      MAX_DAILY = 10_000
      # The most clicks one imported link brings with it, each click or each one of a daily count. The rest of a
      # longer history is left behind, so no source, however much it sends, can fill memory or hold the database.
      MAX_LINK_CLICKS = 100_000
      # An IPv4 address, or what reads as an IPv6 one, anywhere in a text.
      ADDRESS = /(\A|[^\d.])\d{1,3}(\.\d{1,3}){3}(?![\d.])|[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,}/in
      # What a user agent has and a place name does not: a product with its version (Chrome/129), or its usual first words.
      AGENT = %r{[a-z]/\d|mozilla|applewebkit}in
      # A browser or system as a name: a word or a few, not starting with a digit, without the punctuation of a user agent.
      NAME = /\A[A-Za-z_][A-Za-z0-9 ._+-]{0,39}\z/
      private_constant :SHORTENER_DOMAINS, :MAX_DAILY, :ADDRESS, :AGENT, :NAME

      # Browser and system names as other tools write them, in Runlight's spelling.
      BROWSERS = {
        "chrome" => "Chrome", "crios" => "Chrome", "chromium-webview" => "Android WebView", "chrome webview" => "Android WebView", "safari" => "Safari",
        "ios" => "Safari", "ios-webview" => "Safari", "mobile safari" => "Safari", "firefox" => "Firefox", "fxios" => "Firefox", "edge" => "Edge",
        "edge-chromium" => "Edge", "edge-ios" => "Edge", "microsoft edge" => "Edge", "opera" => "Opera", "opera-mini" => "Opera",
        "samsung" => "Samsung Internet", "samsung internet" => "Samsung Internet", "yandexbrowser" => "Yandex Browser",
        "facebook" => "Facebook", "instagram" => "Instagram", "brave" => "Brave", "duckduckgo" => "DuckDuckGo",
      }.freeze
      SYSTEMS = {
        "mac os" => "macOS", "mac os x" => "macOS", "macos" => "macOS", "ios" => "iOS", "android os" => "Android", "android" => "Android",
        "windows 10" => "Windows", "windows 11" => "Windows", "windows 7" => "Windows", "windows" => "Windows", "linux" => "Linux",
        "chrome os" => "Chrome OS", "chromium os" => "Chrome OS",
      }.freeze
      DEVICES = { "desktop" => "desktop", "laptop" => "desktop", "mobile" => "mobile", "smartphone" => "mobile", "phone" => "mobile", "tablet" => "tablet" }.freeze

      module_function

      def hex_id(value, length = 24)
        Hashing.sha256(value)[0, length]
      end

      # The Runlight id an imported link gets, from its source and its id there.
      def imported_link_id(source, source_id)
        hex_id("#{source}:#{source_id}")
      end

      # Two destinations are the same link when they differ only by a trailing slash.
      def same_url(a, b)
        a.sub(%r{/\z}, "") == b.sub(%r{/\z}, "")
      end

      # The first letter in upper case, as TS's title() does.
      def title(v)
        v == "" ? "" : Js.upper(Js.slice(v, 0, 1)) + Js.slice(v, 1)
      end

      # Runlight never stores an IP address or a full user agent, and a file or another tool can hold either in
      # any column. A name that is not one Runlight knows is kept only when it reads as a name, and nothing else.
      def named(name)
        text = Js.trim(name)
        text.match?(NAME) && !text.b.match?(ADDRESS) ? text : ""
      end

      # A browser name in Runlight's spelling: a known one, or a name with a capital first letter, or none for anything else.
      def browser(name)
        BROWSERS[Js.lower(name)] || title(named(name))
      end

      # A system name in Runlight's spelling, or a name as given, or none for anything that is not a name.
      def system_name(name)
        SYSTEMS[Js.lower(name)] || named(name)
      end

      # Free text about a place as given, or none when it holds an address or reads as a user agent.
      def place_name(name)
        bytes = Js.scrub(name).b
        bytes.match?(ADDRESS) || bytes.match?(AGENT) ? "" : name
      end

      # A screen as 1440x900, or none.
      def screen_size(value)
        text = Js.trim(value)
        text.match?(/\A\d{1,5}x\d{1,5}\z/) ? text : ""
      end

      # A language tag such as en or pt-BR, or none.
      def language_tag(value)
        text = Js.trim(value)
        text.match?(/\A[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8}){0,3}\z/) ? text : ""
      end

      def device(name)
        DEVICES[Js.lower(name)] || ""
      end

      # A field of a foreign click as text, "" where it is missing, as `c.field || ""` reads it.
      def str(c, key)
        value = c[key]
        Js.truthy?(value) ? Js.string(value) : ""
      end

      # A field of a foreign click as String(c.field ?? "").
      def text(c, key)
        value = c[key]
        Js.string(value.nil? ? "" : value)
      end

      # Writes one link and its history in a single transaction: the link (and its
      # branded domain), then each click as a visit like a live one, or daily
      # counts as clicks without visitors. Ids come from the source's own ids, so
      # importing again skips what is already there.
      #
      # foreign: { "sourceId", "slug", "domain", "name", "url", "createdAt" }; history: { "clicks"?, "daily"? }.
      # link_domain: given a branded domain, the domain as the site keeps it once it passes a link domain's checks,
      # or nil to bring the link over without it.
      # Returns { "status", "clicks", "reason"?, "code"?, "params"? }.
      def write_link(runlight, site, source, foreign, history, link_domain = ->(_domain) {})
        source_id = Js.string(foreign["sourceId"])
        id = imported_link_id(source, source_id)
        # Here already, or imported once and deleted since. A deleted link keeps its row and its clicks, so it is
        # left as it is: writing it again would clear those clicks and the visits they opened, then fail on its id.
        return { "status" => "skipped", "clicks" => 0 } if runlight.store.link_exists(id)

        slug = foreign["slug"].to_s
        taken = runlight.store.link_by_slug(slug)
        # The same slug to the same place is this link, brought in earlier some other way.
        return { "status" => "skipped", "clicks" => 0 } if !taken.nil? && same_url(taken["url"], foreign["url"].to_s)

        unless taken.nil?
          return { "status" => "failed", "clicks" => 0, "reason" => "/#{slug} is already used by \"#{taken["name"]}\"", "code" => "import_slug_taken",
                   "params" => { "slug" => slug, "name" => taken["name"] } }
        end
        unless slug.match?(/\A[A-Za-z0-9][A-Za-z0-9_-]{0,99}\z/)
          return { "status" => "failed", "clicks" => 0, "reason" => "/#{slug} has characters Runlight slugs cannot use", "code" => "import_slug_bad",
                   "params" => { "slug" => slug } }
        end

        # The destination passes the checks a link made by hand does.
        begin
          destination = Links.clean_url(foreign["url"])
        rescue LinkError => e
          return { "status" => "failed", "clicks" => 0, "reason" => e.message, "code" => e.code, "params" => e.params }
        end

        domain = Sources.strip_www(Js.lower(Js.truthy?(foreign["domain"]) ? foreign["domain"].to_s : ""))
        # A branded domain must pass the checks one added in Settings does, so an import can never claim the
        # dashboard's own host or a name inside a private network. One that fails is left off: the link is
        # served from the app's own path instead.
        domain = domain.empty? || SHORTENER_DOMAINS.include?(domain) ? "" : (link_domain.call(domain) || "")
        now = runlight.now
        clicks = 0
        # Nothing in the transaction is one link's own problem (those are checked above),
        # so a failure in it is the database's, and it stops the import rather than marking the link.
        runlight.store.transaction do |store|
          # On a database without transactions (D1), a failed earlier try can have left
          # some of this link's clicks behind. Clear them, then write the link row last,
          # so a link only counts as imported once all of its history is in.
          store.db.run("DELETE FROM rl_sessions WHERE id IN (SELECT DISTINCT session FROM rl_events WHERE link = ? AND session <> '')", [id])
          store.db.run("DELETE FROM rl_events WHERE link = ?", [id])

          made = {}
          (history["clicks"] || []).each do |c|
            break if clicks >= MAX_LINK_CLICKS

            ts = c["ts"]
            next unless ts.is_a?(Integer) || (ts.is_a?(Float) && ts.finite?)

            ts = ts.to_i
            visit_key = !c["visit"].nil? ? Js.string(c["visit"]) : "#{ts}:#{clicks}"
            session = hex_id("#{source}:#{source_id}:#{visit_key}")
            # A visitor id lasts one day at most, as every other visitor id does.
            visitor = hex_id("#{source}:#{visit_key}:#{Client.iso_string(ts)[0, 10]}", 16)
            path = str(c, "path")
            unless made[session]
              made[session] = true
              store.db.run("DELETE FROM rl_sessions WHERE id = ?", [session])
              host = domain.empty? ? "link.invalid" : domain
              query = str(c, "query")
              url = Http::Url.parse("https://#{host}#{path.empty? ? "/#{slug}" : path}#{query.empty? ? "" : "?#{query.sub(/\A\?/, "")}"}") ||
                    Http::Url.new("https://#{host}/#{slug}")
              page = Sources.parse_page(url)
              country = Js.slice(Js.upper(str(c, "country")), 0, 2)
              raw_region = place_name(str(c, "region"))
              region = raw_region.empty? ? "" : Js.slice(Js.upper(raw_region.include?("-") ? raw_region : "#{country}-#{raw_region}"), 0, 10)
              store.insert_session(
                {
                  "id" => session,
                  "site" => site,
                  "visitor" => visitor,
                  "startedAt" => ts,
                  "hostname" => page["hostname"],
                }.merge(Sources.attribute(page, text(c, "referrer"), [])).merge(
                  "utmSource" => page["utm"]["source"],
                  "utmMedium" => page["utm"]["medium"],
                  "utmCampaign" => page["utm"]["campaign"],
                  "utmTerm" => page["utm"]["term"],
                  "utmContent" => page["utm"]["content"],
                  "country" => country.match?(/\A[A-Z]{2}\z/) ? country : "",
                  "region" => country.empty? ? "" : region,
                  "city" => Js.slice(place_name(str(c, "city")), 0, 100),
                  "browser" => browser(str(c, "browser")),
                  "browserVersion" => "",
                  "os" => system_name(str(c, "os")),
                  "osVersion" => "",
                  "device" => device(str(c, "device")),
                  "screen" => screen_size(text(c, "screen")),
                  "language" => language_tag(text(c, "language")),
                ),
              )
              store.db.run("UPDATE rl_sessions SET imported = 1 WHERE id = ?", [session])
            end
            click_path = path.empty? ? "/#{slug}" : path
            store.touch_session(session, ts, "click", click_path)
            store.insert_event({
              "site" => site, "ts" => ts, "kind" => "click", "visitor" => visitor, "session" => session, "pageview" => "",
              "path" => Js.slice(click_path, 0, 1000), "hostname" => domain, "title" => "", "name" => slug, "props" => nil, "engagedMs" => 0,
              "scroll" => nil, "link" => id,
            })
            clicks += 1
          end

          # Counts without detail: clicks spread through each day, with no visitor or visit.
          (history["daily"] || []).each do |d|
            start = Client.parse_date("#{d["day"]}T00:00:00Z")
            next if (start.is_a?(Float) && !start.finite?) || !(d["clicks"].is_a?(Numeric) && d["clicks"].positive?)

            # A day's count is capped, so one made-up figure from a source cannot write millions of rows.
            n = [d["clicks"].floor, MAX_DAILY, MAX_LINK_CLICKS - clicks].min
            i = 0
            while i < n
              store.insert_event({
                "site" => site, "ts" => start.to_i + ((i + 0.5) / n * 86_400_000).floor, "kind" => "click", "visitor" => "", "session" => "",
                "pageview" => "", "path" => "/#{slug}", "hostname" => domain, "title" => "", "name" => slug, "props" => { "imported" => "daily" },
                "engagedMs" => 0, "scroll" => nil, "link" => id,
              })
              clicks += 1
              i += 1
            end
          end
          store.add_link_domain(domain, site, now) unless domain.empty?
          name = Js.truthy?(foreign["name"]) ? foreign["name"].to_s : slug
          created = Js.truthy?(foreign["createdAt"]) ? foreign["createdAt"].to_i : now
          store.insert_link({
            "id" => id,
            "site" => site,
            "domain" => domain,
            "slug" => slug,
            "name" => Js.slice(name, 0, 100),
            "url" => destination,
            "createdAt" => created,
            "updatedAt" => created,
          })
        end
        runlight.forget_link_domains unless domain.empty?
        { "status" => "created", "clicks" => clicks }
      end

      private_class_method :str, :text, :named
    end
  end
end

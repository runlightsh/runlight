# frozen_string_literal: true

require "socket"

module Runlight
  # Fetches from addresses that other people's input names, such as the icon
  # links on a site's home page or a link domain, and only from the public
  # internet. Only https is fetched, never a private, loopback, link-local,
  # or metadata address, and redirects are followed by hand under the same
  # rules. The name is resolved and every address it gives is checked before
  # each hop, and the request is pinned to the checked addresses (the fetcher's
  # "resolve"), so a name that answers differently a moment later gets nowhere.
  module Safefetch
    class << self
      # What public_fetch resolves names with when its caller gives no "lookup": DNS, unless a test suite
      # stands in for it so the made-up hosts its fake fetchers answer resolve.
      attr_writer :resolver

      def resolver
        @resolver || method(:lookup)
      end
    end

    module_function

    def v4(text)
      parts = text.split(".", -1)
      return nil if parts.length != 4
      return nil unless parts.all? { |p| p.match?(/\A\d{1,3}\z/) && p.to_i <= 255 }

      parts.map(&:to_i)
    end

    def public_v4?(four)
      a, b, c = four
      return false if a.zero? || a == 10 || a == 127 || a >= 224
      return false if a == 100 && b >= 64 && b < 128
      return false if a == 169 && b == 254
      return false if a == 172 && b >= 16 && b < 32
      return false if a == 192 && b == 168
      return false if a == 192 && b.zero? && (c.zero? || c == 2)
      return false if a == 198 && [18, 19].include?(b)
      return false if a == 198 && b == 51 && c == 100
      return false if a == 203 && b.zero? && c == 113

      true
    end

    # An IPv6 address as eight 16-bit groups, or nil when it is not one.
    def v6(text)
      address = text.sub(/\A\[/, "").sub(/\]\z/, "").split("%", 2).first.to_s.downcase
      # A trailing IPv4 address becomes the last two groups.
      if (tail = address.match(/(\d{1,3}(?:\.\d{1,3}){3})\z/))
        four = v4(tail[1])
        return nil if four.nil?

        address = "#{address[0, address.length - tail[1].length]}#{((four[0] << 8) | four[1]).to_s(16)}:#{((four[2] << 8) | four[3]).to_s(16)}"
      end
      halves = address.split("::", -1)
      halves = [""] if halves.empty?
      return nil if halves.length > 2

      head = halves[0] == "" ? [] : halves[0].split(":", -1)
      rest = halves.length == 2 && halves[1] != "" ? halves[1].split(":", -1) : []
      missing = 8 - head.length - rest.length
      return nil if halves.length == 1 ? missing != 0 : missing < 1

      groups = [*head, *Array.new(halves.length == 2 ? missing : 0, "0"), *rest]
      return nil unless groups.all? { |g| g.match?(/\A[0-9a-f]{1,4}\z/) }

      groups.map { |g| g.to_i(16) }
    end

    # Whether an IP address, v4 or v6, is on the public internet. Anything that is not an address is not.
    def public_address?(ip)
      four = v4(ip)
      return public_v4?(four) unless four.nil?

      g = v6(ip)
      return false if g.nil?

      embedded = ->(hi, lo) { [hi >> 8, hi & 255, lo >> 8, lo & 255] }
      # IPv4 inside IPv6: mapped (::ffff:0:0/96), the old compatible form (::/96), translated (::ffff:0:0:0/96),
      # and NAT64 (64:ff9b::/96).
      inside = embedded_v4(g)
      return g[5].zero? && g[4].zero? && g[6].zero? && g[7] <= 1 ? false : public_v4?(inside) unless inside.nil?
      # 6to4 carries an IPv4 address in its second and third groups.
      return public_v4?(embedded.call(g[1], g[2])) if g[0] == 0x2002
      # Only global unicast (2000::/3) is public, which leaves out unique local, link-local, the old site-local,
      # multicast, discard, and local-use NAT64 (64:ff9b:1::/48), which may carry any address.
      return false if (g[0] & 0xe000) != 0x2000
      # The protocol assignments (2001::/23, with Teredo and ORCHID) and the documentation prefixes.
      return false if g[0] == 0x2001 && (g[1] < 0x200 || g[1] == 0xdb8)
      return false if (g[0] & 0xfff0) == 0x3ff0

      true
    end

    # The IPv4 address inside a mapped, compatible, translated, or NAT64 IPv6 address, or nil.
    def embedded_v4(g)
      inside = (g[0, 5].all?(&:zero?) && (g[5] == 0xffff || g[5].zero?)) ||
               (g[0, 4].all?(&:zero?) && g[4] == 0xffff && g[5].zero?) ||
               (g[0] == 0x64 && g[1] == 0xff9b && g[2, 4].all?(&:zero?))
      inside ? [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255] : nil
    end

    # Names clouds give their metadata services.
    METADATA_NAMES = %w[metadata metadata.google.internal metadata.goog instance-data instance-data.ec2.internal].freeze

    # Whether an address is link-local (169.254.0.0/16, fe80::/10) or a cloud's metadata service (fd00:ec2::254,
    # Alibaba's 100.100.100.200), in any of its IPv6 spellings. A model's API or a mail server is never there,
    # though it may well be on this computer or a private network, so those stay allowed where this is checked.
    def metadata_address?(ip)
      four = v4(ip)
      g = four.nil? ? v6(ip) : nil
      # IPv4 inside IPv6, mapped, compatible, translated, or NAT64, is read as IPv4.
      four = embedded_v4(g) if four.nil? && !g.nil?
      return (four[0] == 169 && four[1] == 254) || four == [100, 100, 100, 200] unless four.nil?
      return false if g.nil?
      return true if (g[0] & 0xffc0) == 0xfe80

      g[0] == 0xfd00 && g[1] == 0xec2 && g[2, 5].all?(&:zero?) && g[7] == 0x254
    end

    # Whether a host, by its name, its address, or any address its name resolves to now, is link-local or a
    # metadata service. A name that does not resolve here is let through, since the connection then goes
    # nowhere such a check could have stopped.
    def metadata_host?(host)
      name = Js.lower(Js.trim(host)).sub(/\A\[/, "").sub(/\]\z/, "").sub(/\.+\z/, "")
      return true if METADATA_NAMES.include?(name) || metadata_address?(name)
      return false if !v4(name).nil? || !v6(name).nil?

      begin
        Safefetch.resolver.call(name).any? { |address| metadata_address?(address.to_s) }
      rescue StandardError
        false
      end
    end

    # Every address a name resolves to, v4 and v6, as getaddrinfo() gives them (the hosts file included).
    # Empty when it does not resolve.
    def lookup(name)
      bare = name.sub(/\A\[/, "").sub(/\]\z/, "")
      return [bare] if !v4(bare).nil? || !v6(bare).nil?

      Addrinfo.getaddrinfo(bare, nil, nil, :STREAM).map(&:ip_address).uniq
    rescue SocketError, SystemCallError
      []
    end

    # The public addresses a name resolves to, for setting up DNS records. None where it does not resolve.
    # lookup: a callable standing in for DNS in tests.
    def public_addresses(name, lookup = nil)
      addresses = begin
        lookup.nil? ? lookup(name) : lookup.call(name)
      rescue StandardError
        return []
      end
      addresses.select { |address| public_address?(address) }.uniq
    end

    # Whether a name resolves to an address off the public internet. False when it does not resolve.
    # lookup: a callable standing in for DNS in tests.
    def resolves_privately?(name, lookup = nil)
      addresses = begin
        lookup.nil? ? lookup(name) : lookup.call(name)
      rescue StandardError
        return false
      end
      addresses.any? { |address| !public_address?(address) }
    end

    # GETs an https URL on the public internet, following up to "redirects"
    # redirects that stay on it, within "timeoutMs" in all. Raises a
    # PrivateAddressError for an address off it, and an Http::FetchError that
    # is timed_out? when time runs out. A redirect past the last one comes back
    # as it is. "method", "body", "maxBytes", and "truncate" go to the fetcher.
    # "lookup" stands in for DNS in tests.
    #
    # init: a Hash with "timeoutMs", and optionally "method", "body", "headers", "redirects", "maxBytes", "truncate",
    # and "lookup".
    def public_fetch(target, init, fetcher = nil)
      fetcher ||= Http::NetFetcher.new
      lookup = init["lookup"] || Safefetch.resolver
      until_ns = monotonic + (init["timeoutMs"] * 1_000_000)
      url = Http::Url.new(target)
      hop = 0
      loop do
        raise PrivateAddressError, url.href if url.protocol != "https:"

        host = url.hostname.sub(/\A\[/, "").sub(/\]\z/, "").downcase
        literal = !v4(host).nil? || !v6(host).nil?
        raise PrivateAddressError, host if literal && !public_address?(host)
        raise PrivateAddressError, host if host == "localhost" || host.end_with?(".localhost")

        pin = []
        unless literal
          # The address checked is the address used: every one the name gives must be public, and the
          # connection is pinned to them, so a second lookup cannot hand back another.
          addresses = lookup.call(host)
          raise Http::FetchError, "getaddrinfo ENOTFOUND #{host}" if addresses.empty?

          addresses.each { |address| raise PrivateAddressError, host unless public_address?(address) }
          port = url.port == "" ? "443" : url.port
          pin = ["#{host}:#{port}:#{addresses.map { |a| a.include?(":") ? "[#{a}]" : a }.join(",")}"]
        end
        left = (until_ns - monotonic).div(1_000_000)
        raise timed_out if left <= 0

        options = { "headers" => init["headers"] || {}, "redirect" => "manual", "timeoutMs" => left }
        %w[method body maxBytes truncate].each { |key| options[key] = init[key] unless init[key].nil? }
        options["resolve"] = pin unless pin.empty?
        begin
          answer = fetcher.fetch(url.href, options)
        rescue Http::FetchError => e
          # Whichever way the request gave up, the caller hears that time ran out.
          raise timed_out if e.timed_out? || monotonic >= until_ns

          raise
        end
        location = answer.headers.get("location")
        if answer.status < 300 || answer.status >= 400 || location.nil? || location == "" || hop >= (init["redirects"] || 0)
          return answer
        end

        url = Http::Url.new(location, url.href)
        hop += 1
      end
    end

    # Headers that describe a body, dropped with it when a redirect turns a request into a GET.
    BODY_HEADERS = %w[content-type content-length content-encoding content-language content-location].freeze

    # Fetches from a service someone set up, such as an AI model's API or a
    # mail webhook, which may well be on this computer or a private network,
    # but is never at a link-local or cloud metadata address. The address is
    # checked, and so is every redirect's, up to "redirects" of them (default
    # 5), each followed as fetch follows it: a 303, or a 301 or 302 answering a
    # POST, goes on as a GET with no body. Only a redirect on the same origin is
    # followed: the request carries a key, in whatever header the service names
    # it, and a 307 or 308 would carry its body too, an email or a conversation, so
    # a redirect to another origin, https to http among them, is refused before
    # anything is sent there. A redirect past the last one comes back as it is.
    # Raises a MetadataAddressError or a RedirectRefusedError for an address it refuses.
    #
    # init: a Hash with optionally "method", "headers" (a Hash), "body", "timeoutMs" (for every hop together),
    # "redirects", and "maxBytes" and "truncate" for the fetcher.
    def service_fetch(target, init, fetcher = nil)
      fetcher ||= Http::NetFetcher.new
      # A fetcher that reaches the network is held to the address checked. One a test or an app supplies is
      # not, since a made-up host may not resolve anywhere.
      strict = fetcher.is_a?(Http::NetFetcher)
      redirects = init["redirects"] || 5
      url = Http::Url.parse(target)
      raise Http::FetchError, "Invalid URL" if url.nil?

      method = (init["method"] || "GET").to_s.upcase
      headers = (init["headers"] || {}).to_h
      body = init["body"]
      until_ns = init["timeoutMs"] && monotonic + (init["timeoutMs"] * 1_000_000)
      hop = 0
      loop do
        host = url.hostname.sub(/\A\[/, "").sub(/\]\z/, "")
        pin = service_pin(url, host, strict)

        options = { "method" => method, "headers" => headers, "redirect" => "manual" }
        options["resolve"] = pin unless pin.nil?
        options["body"] = body unless body.nil?
        %w[maxBytes truncate].each { |key| options[key] = init[key] unless init[key].nil? }
        unless until_ns.nil?
          # The whole limit for the first hop, and what is left of it for each redirect.
          left = hop.zero? ? init["timeoutMs"] : (until_ns - monotonic).div(1_000_000)
          raise timed_out if left <= 0

          options["timeoutMs"] = left
        end
        answer = fetcher.fetch(url.href, options)
        location = answer.headers.get("location")
        return answer if answer.status < 300 || answer.status >= 400 || location.nil? || location == "" || hop >= redirects

        following = Http::Url.parse(location, url.href)
        raise Http::FetchError, "Invalid URL" if following.nil?

        if following.origin != url.origin
          there = following.hostname.sub(/\A\[/, "").sub(/\]\z/, "")
          raise MetadataAddressError, there if metadata_host?(there)

          raise RedirectRefusedError.new(url.host, %w[http: https:].include?(following.protocol) ? following.origin : following.protocol)
        end
        if answer.status == 303 || ([301, 302].include?(answer.status) && method == "POST")
          method = "GET" unless method == "HEAD"
          body = nil
          headers = headers.reject { |name, _| BODY_HEADERS.include?(name.to_s.downcase) }
        end
        url = following
        hop += 1
      end
    end

    # The pin for one hop of a service fetch: the name is resolved here, every address it gives is checked, and
    # the connection is pinned to them (the fetcher's "resolve", which also keeps it off any proxy from the
    # environment), so a second lookup cannot hand back another. A private or local address is fine, since a
    # model or a mail relay may be there; a link-local or metadata one is refused. A name that does not resolve
    # is refused when strict, and let through to the fetcher otherwise.
    def service_pin(url, host, strict)
      name = Js.lower(Js.trim(host)).sub(/\.+\z/, "")
      raise MetadataAddressError, host if METADATA_NAMES.include?(name) || metadata_address?(name)

      literal = !v4(name).nil? || !v6(name).nil?
      addresses = begin
        literal ? [name] : Safefetch.resolver.call(name).map(&:to_s)
      rescue StandardError
        []
      end
      if addresses.empty?
        raise Http::FetchError, "Could not look up #{host}" if strict

        return nil
      end
      raise MetadataAddressError, host if addresses.any? { |address| metadata_address?(address) }

      port = url.port == "" ? { "https:" => "443", "http:" => "80" }[url.protocol] : url.port
      return nil if port.nil?

      ["#{name}:#{port}:#{addresses.map { |a| a.include?(":") ? "[#{a}]" : a }.join(",")}"]
    end

    # An install on this machine: http://localhost or http://127.0.0.1, with any port.
    LOCAL_INSTALL = %r{\Ahttp://(localhost|127\.0\.0\.1)(:\d+)?(/|\z)}

    # Whether an address can be another Runlight install's: https, or, with `local`, an install on this
    # machine, which only code can allow (the Core's localInstalls).
    def install_address?(url, local)
      url.match?(%r{\Ahttps://[^/]+}) || (local && url.match?(LOCAL_INSTALL))
    end

    # A fetch of another Runlight install or an Umami, at an address its owner typed: through public_fetch,
    # with no redirect followed. With `local` (the Core's localInstalls), an install on this machine is
    # fetched as it is, still without following a redirect. init as public_fetch takes it.
    def owner_fetch(target, init, fetcher = nil, local = false)
      if local && target.match?(LOCAL_INSTALL)
        return (fetcher || Http::NetFetcher.new).fetch(target, init.merge("redirect" => "manual"))
      end

      public_fetch(target, init.merge("redirects" => 0), fetcher)
    end

    def timed_out
      Http::FetchError.new("The operation was aborted due to timeout", timed_out: true)
    end

    def monotonic
      Process.clock_gettime(Process::CLOCK_MONOTONIC, :nanosecond)
    end

    private_class_method :v4, :public_v4?, :v6, :timed_out, :monotonic, :service_pin
  end
end

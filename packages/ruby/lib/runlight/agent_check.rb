# frozen_string_literal: true

module Runlight
  # Checks a request that names an AI agent against the addresses that agent's company publishes. Every
  # list is in the same shape, {"prefixes": [{"ipv4Prefix": "a.b.c.d/n"} or {"ipv6Prefix": "x::/n"}]}.
  #
  # The answer is "verified" when the address is in the list, "mismatch" when the company publishes a list
  # and the address is not in it, and "" when there is nothing to check against: no list for that agent,
  # or no usable address. The address is only compared, never kept. The port of the SDK's agentcheck.ts.
  module AgentCheck
    # A list of more prefixes than this, or a reply bigger than MAX_LIST_BYTES, is not a list we read.
    MAX_PREFIXES = 20_000
    MAX_LIST_BYTES = 4_000_000
    USER_AGENT = "Runlight (+https://runlight.sh)"

    # Lists compiled to prefixes, by the list itself, as a WeakMap holds them in TypeScript. A list is
    # compiled once while it is in use; the cache is emptied when it grows past what any install holds.
    @compiled = {}.compare_by_identity
    @compiled_lock = Mutex.new

    module_function

    # The address lists that came with this version: { "fetchedAt" => "YYYY-MM-DD", "lists" => { url => [prefix] } },
    # read once from assets/agent-ranges.json.
    def bundled
      @bundled ||= begin
        data = Json.decode(File.read(File.join(Version::ASSETS, "agent-ranges.json")))
        lists = data["lists"].to_h { |url, list| [url.freeze, list.map { |p| p.dup.freeze }.freeze] }.freeze
        { "fetchedAt" => data["fetchedAt"], "lists" => lists }.freeze
      end
    end

    def ipv4(text)
      parts = text.split(".", -1)
      return nil unless parts.length == 4

      n = 0
      parts.each do |part|
        return nil unless part.match?(/\A[0-9]{1,3}\z/)

        byte = part.to_i
        return nil if byte > 255

        n = (n * 256) + byte
      end
      n
    end

    def ipv6(text)
      return nil if !text.match?(/\A[0-9a-f:.]+\z/i) || text.split("::", -1).length > 2

      # A dotted IPv4 tail ("::ffff:1.2.3.4") stands for the last two groups.
      groups = text
      if text.include?(".")
        dot = text.rindex(":")
        tail = ipv4(text[(dot + 1)..])
        return nil if tail.nil?

        groups = "#{text[0, dot + 1]}#{(tail >> 16).to_s(16)}:#{(tail & 0xffff).to_s(16)}"
      end
      halves = groups.split("::", -1)
      head = halves[0]
      rest = halves[1]
      left = head.empty? ? [] : head.split(":", -1)
      right = rest.nil? || rest.empty? ? [] : rest.split(":", -1)
      missing = 8 - left.length - right.length
      return nil if rest.nil? ? missing != 0 : missing < 1

      n = 0
      [*left, *Array.new(rest.nil? ? 0 : missing, "0"), *right].each do |group|
        return nil unless group.match?(/\A[0-9a-f]{1,4}\z/i)

        n = (n << 16) | group.to_i(16)
      end
      n
    end

    # An address as the check reads it, as [4 or 6, number]: surrounding space, [brackets], and an IPv6 zone
    # ("%eth0") are ignored, and an IPv4 address written as IPv6 (::ffff:1.2.3.4) is read as IPv4. Nil when
    # it is not one.
    def parse_address(text)
      s = Js.trim(text.to_s)
      s = s[1...-1] if s.start_with?("[") && s.end_with?("]") && s.length >= 2
      zone = s.index("%")
      s = s[0, zone] unless zone.nil?
      return nil if s.empty?

      unless s.include?(":")
        n = ipv4(s)
        return n.nil? ? nil : [4, n]
      end
      n = ipv6(s)
      return nil if n.nil?
      return [4, n & 0xffffffff] if n >> 32 == 0xffff

      [6, n]
    end

    # A prefix such as 20.171.206.0/24 or 2600:1f28::/56, as [4 or 6, base, bits], or nil. Bits past the length
    # are ignored.
    def parse_prefix(text)
      slash = text.index("/")
      return nil if slash.nil?

      bits_text = text[(slash + 1)..]
      return nil unless bits_text.match?(/\A[0-9]{1,3}\z/)

      bits = bits_text.to_i
      head = text[0, slash]
      if head.include?(":")
        n = ipv6(head)
        return nil if n.nil? || bits > 128

        return [6, n, bits]
      end
      n = ipv4(head)
      return nil if n.nil? || bits > 32

      [4, n, bits]
    end

    def covers?(prefix, address)
      return false if prefix[0] != address[0]

      shift = (prefix[0] == 4 ? 32 : 128) - prefix[2]
      address[1] >> shift == prefix[1] >> shift
    end

    # The prefixes in a published list (decoded JSON), or nil when it is not a list in the expected shape (not
    # an object, no prefixes, an entry that is not a prefix, or too many). One bad entry rejects the whole
    # list, so a half broken download never replaces a good copy.
    def read_range_list(body)
      return nil unless body.is_a?(Hash)

      prefixes = body["prefixes"]
      return nil if !prefixes.is_a?(Array) || prefixes.empty? || prefixes.length > MAX_PREFIXES

      prefixes.map do |entry|
        return nil unless entry.is_a?(Hash)

        v4 = entry["ipv4Prefix"]
        v6 = entry["ipv6Prefix"]
        text = if v4.is_a?(String) then v4
               elsif v6.is_a?(String) then v6
               end
        return nil if text.nil?

        text = Js.trim(text)
        prefix = parse_prefix(text)
        return nil if prefix.nil? || v4.is_a?(String) != (prefix[0] == 4)

        text
      end
    end

    # Downloads one published list through fetcher (anything with fetch(url, init)). Nil when it cannot be
    # fetched or read; the caller keeps what it had.
    def download_range_list(url, fetcher, timeout_ms = 15_000)
      response = fetcher.fetch(url, {
        "headers" => { "accept" => "application/json", "user-agent" => USER_AGENT },
        "redirect" => "follow", "timeoutMs" => timeout_ms, "maxBytes" => MAX_LIST_BYTES,
      })
      return nil unless response.ok?

      read_range_list(Body.read_json_capped(response, MAX_LIST_BYTES))
    rescue StandardError
      nil
    end

    def prefixes_of(list)
      @compiled_lock.synchronize do
        found = @compiled[list]
        return found unless found.nil?

        @compiled.clear if @compiled.length >= 256
        @compiled[list] = list.filter_map { |p| p.is_a?(String) ? parse_prefix(p) : nil }.freeze
      end
    end

    # Whether ip is inside any of the prefixes. False for an address that cannot be read.
    def in_ranges?(ip, list)
      address = parse_address(ip)
      !address.nil? && prefixes_of(list).any? { |p| covers?(p, address) }
    end

    # The check for one request that names agent (a Hash from Data::Agents), made from ip (see the top of
    # this file): "verified", "mismatch", or "".
    def check_agent(agent, ip, lists)
      list = agent["ranges"].nil? ? nil : lists[agent["ranges"]]
      return "" if list.nil? || parse_address(ip).nil?

      in_ranges?(ip, list) ? "verified" : "mismatch"
    end

    private_class_method :ipv4, :ipv6, :parse_prefix, :covers?, :prefixes_of
  end
end

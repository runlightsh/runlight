# frozen_string_literal: true

require "net/http"
require "openssl"
require "zlib"

module Runlight
  module Http
    # Outgoing requests, the Ruby stand-in for JavaScript's fetch(). Everything
    # that calls another server (mail services, importers, connected installs,
    # the assistant's providers, site icons) goes through a fetcher: any object
    # with `fetch(url, init = {})` returning a Response, so tests can pass a fake.
    #
    # `init` is a Hash with the keys fetch's init has, where they apply:
    # - "method": String, default GET
    # - "headers": a Hash of name to value, or Headers
    # - "body": String
    # - "redirect": "follow" (default) or "manual", which hands back the 3xx answer
    # - "timeoutMs": Integer, the whole request's limit, default 30000
    # - "maxBytes": Integer, stop reading past this and raise BodyTooLong
    # - "truncate": true, with maxBytes, hand back the first maxBytes instead of raising (the start of a page)
    # - "resolve": Array of "host:port:address" pins, so a checked address is the one connected to
    #
    # NetFetcher, the default, raises FetchError when no answer comes back (refused, timed out, bad TLS).
    class NetFetcher
      MAX_REDIRECTS = 20
      REDIRECTS = [301, 302, 303, 307, 308].freeze
      TIMED_OUT = "The operation was aborted due to timeout"
      # Sent only to the origin they were given to.
      CREDENTIALS = %w[authorization cookie proxy-authorization x-api-key].freeze

      def fetch(url, init = {})
        deadline = monotonic + ((init["timeoutMs"] || 30_000).to_i / 1000.0)
        method = (init["method"] || "GET").to_s.upcase
        headers = init["headers"].is_a?(Headers) ? init["headers"] : Headers.new(init["headers"] || {})
        body = init["body"]
        follow = init["redirect"] != "manual"
        redirects = 0
        loop do
          response = once(url, method, headers, body, init, deadline)
          location = response.headers.get("location")
          return response unless follow && REDIRECTS.include?(response.status) && location

          redirects += 1
          raise FetchError, "redirect count exceeded" if redirects > MAX_REDIRECTS

          target = Url.parse(location, url)
          raise FetchError, "fetch failed" if target.nil? || !%w[http: https:].include?(target.protocol)

          here = Url.parse(url)
          # Never from an encrypted address to a plain one, where anything still sent could be read on the way.
          raise FetchError, "fetch failed: a redirect from https to http" if here.protocol == "https:" && target.protocol == "http:"

          # Credentials are for the address they were given to, so they go no further than its origin, as
          # fetch() drops them.
          if target.origin != here.origin
            headers = headers.dup
            CREDENTIALS.each { |name| headers.delete(name) }
          end
          url = target.href
          next unless response.status == 303 || ([301, 302].include?(response.status) && method == "POST")

          method = "GET"
          body = nil
          headers = headers.dup
          headers.delete("content-type")
          headers.delete("content-length")
        end
      end

      private

      # Opens the connection. A name pinned to several addresses is tried address by address, as a connection
      # by name is, so a host that listens on one of them is reached; only the failure of the last is raised.
      def connect(http, addresses)
        tries = addresses.empty? ? [nil] : addresses
        tries.each_with_index do |address, at|
          http.ipaddr = address unless address.nil?
          begin
            return http.start
          rescue SystemCallError, SocketError, Net::OpenTimeout
            raise if at == tries.length - 1
          end
        end
      end

      def monotonic
        Process.clock_gettime(Process::CLOCK_MONOTONIC)
      end

      def once(url, method, headers, body, init, deadline)
        parsed = Url.parse(url)
        raise FetchError, "fetch failed" if parsed.nil? || !%w[http: https:].include?(parsed.protocol)

        https = parsed.protocol == "https:"
        port = parsed.port.empty? ? (https ? 443 : 80) : parsed.port.to_i
        host = parsed.hostname.delete_prefix("[").delete_suffix("]")
        left = deadline - monotonic
        raise FetchError.new(TIMED_OUT, timed_out: true) if left <= 0

        # A pinned request never goes through a proxy from the environment (http_proxy and the rest), which would
        # connect wherever the name leads now rather than to the address that was checked.
        pinned = !Array(init["resolve"]).empty?
        http = pinned ? Net::HTTP.new(host, port, nil) : Net::HTTP.new(host, port)
        http.use_ssl = https
        # A pin connects to the checked address, with the name kept for the Host header and the certificate.
        addresses = []
        Array(init["resolve"]).each do |pin|
          lead = "#{host}:#{port}:"
          next unless pin.to_s.length > lead.length && pin.to_s[0, lead.length].casecmp?(lead)

          addresses = pin.to_s[lead.length..].split(",").map { |address| address.delete_prefix("[").delete_suffix("]") }.reject(&:empty?)
          http.ipaddr = addresses.first
          break
        end
        # A pin that names another host or port would leave the name to be looked up again: refused, never
        # fetched unpinned.
        raise FetchError, "fetch failed" if pinned && http.ipaddr.nil?
        http.open_timeout = [left, 15].min
        http.read_timeout = left
        http.write_timeout = left
        http.ssl_timeout = left if https
        http.max_retries = 0
        has_body = !body.nil? && !%w[GET HEAD].include?(method)
        path = "#{parsed.pathname}#{parsed.search}"
        request = Net::HTTPGenericRequest.new(method, has_body, method != "HEAD", path.empty? ? "/" : path)
        headers.all.each do |name, values|
          request.delete(name)
          values.each { |value| request.add_field(name, value) }
        end
        request.body = body.to_s if has_body
        max_bytes = init["maxBytes"]&.to_i
        truncate = init["truncate"] ? true : false
        received = +"".b
        too_long = false
        status = 0
        answer_headers = {}
        begin
          # Past maxBytes the whole request is left by a throw, which closes the connection: a break would leave
          # only read_body, and Net::HTTP would then read the rest of the body after all.
          catch(:too_long) do
            connect(http, addresses)
            begin
              http.request(request) do |answer|
                status = answer.code.to_i
                answer.each_capitalized_name { |name| answer_headers[name.downcase] = answer.get_fields(name) }
                answer.read_body do |chunk|
                  raise FetchError.new(TIMED_OUT, timed_out: true) if monotonic > deadline

                  if max_bytes && received.bytesize + chunk.bytesize > max_bytes
                    too_long = true
                    received << chunk.byteslice(0, max_bytes - received.bytesize) if truncate
                    throw :too_long
                  end
                  received << chunk
                end
              end
            ensure
              http.finish if http.started?
            end
          end
        rescue Net::OpenTimeout, Net::ReadTimeout, Net::WriteTimeout, Timeout::Error
          raise FetchError.new(TIMED_OUT, timed_out: true) unless too_long
        rescue FetchError
          raise
        rescue IOError, SystemCallError, SocketError, OpenSSL::SSL::SSLError, Net::HTTPBadResponse, Zlib::Error => e
          raise FetchError, e.message unless too_long
        end
        raise BodyTooLong, "Body over #{max_bytes} bytes" if too_long && !truncate
        raise FetchError, "fetch failed" if status.zero?

        Response.new(received.force_encoding(Encoding::UTF_8), status: status, headers: answer_headers)
      end
    end
  end
end

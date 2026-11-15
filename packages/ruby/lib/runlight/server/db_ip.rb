# frozen_string_literal: true

require "fileutils"
require "net/http"
require "openssl"
require "uri"
require "zlib"

module Runlight
  module Server
    # Location for servers with no platform headers (Cloudflare, Vercel, and Netlify send their own, and those always
    # win), from DB-IP's free databases (CC BY 4.0, https://db-ip.com). This is the port of the Geo class in
    # packages/server/src/geo.ts: `runlight cron` and the server's own schedule download each month's release with
    # refresh(), and lookups read the newest file on disk. lookup() opens it at the first lookup, as each PHP
    # request does; a server that keeps running reads through current() instead, which load_newest() points at the
    # newest release whenever the schedule runs, as the Node server's Geo does.
    #
    # A download is used only once it is checked: its SHA-1 against the one DB-IP publishes on its download page,
    # and the file itself as a DB-IP database of the kind asked for, no older than the one in use. That catches a
    # damaged or swapped file, and a download server serving something else. It is not a signature: DB-IP
    # publishes none, so whoever can change DB-IP's own page can change both. A checksum that does not match
    # always refuses the download. Only when none can be read at all (the page is down, or no longer reads as it
    # did) is a download accepted on the other checks alone, with a warning, so a change to that page does not
    # stop location data everywhere.
    class DbIp
      # How long after a first failed try the next one waits, and the longest any waits.
      FIRST_WAIT = 5 * 60_000
      LONGEST_WAIT = 6 * 3_600_000
      # The most a database may unpack to, several times the city file's size, so a bad download cannot fill the disk.
      MOST_BYTES = 512 * 1024 * 1024
      # The most the download itself may weigh, and the least a database unpacks to (the country one is 8 MB).
      MOST_PACKED_BYTES = 256 * 1024 * 1024
      FEWEST_BYTES = 1024 * 1024
      # The most of DB-IP's download page that is read; it is about 25 KB.
      MOST_PAGE_BYTES = 1024 * 1024
      DAY = 86_400_000
      # A release is built at the start of its month and stands in until the next appears, so one is two months old at most.
      OLDEST_BUILD = 100 * DAY
      # Addresses any location database knows: Google's and Cloudflare's resolvers, over IPv4 and IPv6.
      KNOWN = ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"].freeze
      MARKER = "\xAB\xCD\xEFMaxMind.com".b.freeze
      private_constant :FIRST_WAIT, :LONGEST_WAIT, :MOST_BYTES, :MOST_PACKED_BYTES, :FEWEST_BYTES, :MOST_PAGE_BYTES, :DAY, :OLDEST_BUILD, :KNOWN, :MARKER

      # An answer that was not a plain 200, with its status, so a month not out yet (404) can be told apart.
      class Refused < StandardError
        attr_reader :status

        def initialize(status)
          super("it answered #{status}")
          @status = status
        end
      end

      # dir: the folder the releases live in. mode: "city" or "country". get: a callable taking a URL and a
      # timeout in seconds, that makes one GET without following any redirect and yields the status, the
      # headers (a Hash with lowercase names), and the body as something whose each gives its parts; it returns
      # what the block returns (Net::HTTP by default). log: a callable taking a line.
      def initialize(dir, mode, get = nil, log = nil)
        @dir = dir
        @mode = mode
        @get = get || method(:http_get)
        @log = log || ->(line) { warn(line) }
        @loaded = nil
        @lookup = nil
        @lock = Mutex.new
      end

      # "2026-10", the month DB-IP names each release after.
      def self.month(ms)
        Time.at(ms.div(1000)).utc.strftime("%Y-%m")
      end

      # The release and SHA-1 on DB-IP's download page for the MMDB file of one kind: the last SHA1SUM before
      # the link to that file, and after the link to any other. Nil when the page does not read that way.
      def self.published_checksum(page, mode)
        page = Js.scrub(page)
        link = page.match(/download\.db-ip\.com\/free\/dbip-#{Regexp.escape(mode)}-lite-(\d{4}-\d{2})\.mmdb\.gz/)
        return nil if link.nil?

        before = link.pre_match
        other = before.rindex("download.db-ip.com/free/dbip-")
        card = other.nil? ? before : before[other..]
        sha1 = card.scan(/SHA1SUM.{0,200}?\b([0-9a-f]{40})\b/im).last&.first
        sha1.nil? ? nil : { "release" => link[1], "sha1" => sha1.downcase }
      end

      # Raises unless `bytes` is a DB-IP database of the kind asked for that a lookup can be made in: of a
      # believable size, its search tree inside the file, built lately and not before the one in use (`in_use`,
      # a time in milliseconds, or 0 for none), and answering for addresses everyone knows.
      def self.check_database(bytes, mode, now, in_use = 0)
        bytes = bytes.b
        raise RuntimeError, "it unpacks to #{bytes.bytesize} bytes, too few for a location database" if bytes.bytesize < FEWEST_BYTES

        marker = bytes.rindex(MARKER)
        raise RuntimeError, "it is not an MMDB file" if marker.nil?

        reader = begin
          Mmdb.new(bytes)
        rescue StandardError => e
          raise RuntimeError, "it does not open as an MMDB file: #{e.message}"
        end
        meta = reader.metadata
        major = meta["binary_format_major_version"]
        raise RuntimeError, "its format is version #{major}, not 2" unless major == 2

        type = meta["database_type"].to_s
        raise RuntimeError, "it is a \"#{type}\" database, not DB-IP's #{mode} one" unless type.downcase == "dbip-#{mode}-lite"
        raise RuntimeError, "it covers IP version #{meta["ip_version"]}, not 6" unless meta["ip_version"] == 6

        size = meta["record_size"]
        raise RuntimeError, "its records are #{size} bits" unless [24, 28, 32].include?(size)

        nodes = meta["node_count"]
        raise RuntimeError, "its search tree does not fit in the file" unless nodes.is_a?(Integer) && nodes.positive? && (nodes * size / 4.0) + 16 <= marker

        epoch = meta["build_epoch"]
        built = epoch.is_a?(Integer) ? epoch * 1000 : nil
        if built.nil? || built > now + (2 * DAY) || built < now - OLDEST_BUILD
          raise RuntimeError, "it was built on #{built.nil? ? "no date" : Time.at(epoch).utc.strftime("%Y-%m-%d")}"
        end
        raise RuntimeError, "it is older than the database in use" if built < in_use

        KNOWN.each do |ip|
          found = begin
            reader.get(ip)
          rescue StandardError
            nil
          end
          country = found.is_a?(Hash) && found["country"].is_a?(Hash) ? found["country"]["iso_code"] : nil
          raise RuntimeError, "it has no country for #{ip}" unless country.is_a?(String) && country.match?(/\A[A-Z]{2}\z/)
        end
        nil
      end

      # The newest release on disk, or nil before the first download.
      def newest
        Dir.glob("#{@dir}/dbip-#{@mode}-lite-*.mmdb").max
      end

      # A lookup answering from the newest release on disk, opened at the first lookup, or nil when there is none
      # yet. Lookups that fail answer nothing, as they do before the first download in TypeScript.
      def lookup
        file = newest
        return nil if file.nil?

        found = nil
        lambda do |ip|
          begin
            found ||= Geo.lookup_from(Mmdb.open(file))
          rescue StandardError
            next nil
          end
          found.call(ip)
        end
      end

      # A lookup that always answers, from the release load_newest() last opened, and with nothing before there
      # is one.
      def current
        ->(ip) { @lookup&.call(ip) }
      end

      # Opens the newest release on disk when it is not the one open already. Safe to call often: it reads only
      # the folder when nothing changed.
      def load_newest
        file = newest
        return self if file.nil? || file == @loaded

        @lock.synchronize do
          next if file == @loaded

          begin
            @lookup = Geo.lookup_from(Mmdb.open(file))
            @loaded = file
          rescue StandardError => e
            @log.call("Runlight: could not open location data in #{file}: #{e.message}")
          end
        end
        self
      end

      # Fetches this month's release when it is missing. A new month's file appears a day or so after the month
      # starts, so until then last month's is fetched when that is missing too. Older releases go once a new
      # one is ready. Safe to call often: once this month's file is there it reads only the folder, and while
      # the month's file is not published yet, or a download keeps failing, each try waits twice as long as the
      # last, from five minutes up to six hours, so neither DB-IP nor the disk is asked for the whole file every
      # few minutes. The wait is kept in a small file beside the releases, since `runlight cron` is a new
      # process each time.
      def refresh(now)
        current = self.class.month(now)
        return if File.file?(file(current))

        wait, retry_at = waiting
        return if now < retry_at

        begin
          FileUtils.mkdir_p(@dir, mode: 0o755)
        rescue SystemCallError
          @log.call("Runlight: could not make the folder for location data, #{@dir}")
          return
        end
        begin
          fetch(current, now)
        ensure
          if File.file?(file(current))
            FileUtils.rm_f(wait_file)
          else
            wait = [wait.zero? ? FIRST_WAIT : wait * 2, LONGEST_WAIT].min
            begin
              File.write(wait_file, "#{wait} #{now + wait}\n")
            rescue SystemCallError
              nil
            end
          end
        end
      end

      private

      # Where the wait after a failed try is kept: how long it was, and when the next try may start.
      def wait_file
        "#{@dir}/dbip-#{@mode}-retry"
      end

      # The wait kept from the last failed try, as [how long, when the next may start]; zeros when there is none.
      def waiting
        wait, retry_at = File.read(wait_file).split.map { |n| Integer(n, 10) }
        wait.nil? || retry_at.nil? || wait.negative? ? [0, 0] : [wait, retry_at]
      rescue SystemCallError, ArgumentError
        [0, 0]
      end

      def file(release)
        "#{@dir}/dbip-#{@mode}-lite-#{release}.mmdb"
      end

      # One GET that goes nowhere but where it was sent, and yields the headers and the body of a plain 200.
      # Anything else is Refused, with its status.
      def request(url, timeout)
        @get.call(url, timeout) do |status, headers, body|
          raise Refused, status unless status == 200

          yield headers || {}, body || []
        end
      end

      # The release DB-IP's download page offers for this kind of database, and the SHA-1 it gives for the
      # unpacked file. Raises with why when there is none to read.
      def published
        url = "https://db-ip.com/db/download/ip-to-#{@mode}-lite"
        page = begin
          request(url, 30) do |_headers, body|
            text = +"".b
            body.each do |chunk|
              text << chunk.to_s.b
              raise RuntimeError, "it is more than #{MOST_PAGE_BYTES / 1024} KB" if text.bytesize > MOST_PAGE_BYTES
            end
            text
          end
        rescue StandardError => e
          raise RuntimeError, "could not read DB-IP's checksums at #{url}: #{e.message}"
        end
        found = self.class.published_checksum(page, @mode)
        raise RuntimeError, "found no checksum for the #{@mode} database at #{url}" if found.nil?

        found
      end

      def fetch(release, now)
        # A new month's file appears a day or so after the month starts; until then, last month's is current.
        at = Time.at(now.div(1000)).utc
        year = at.month == 1 ? at.year - 1 : at.year
        tries = [release, format("%<year>04d-%<month>02d", year: year, month: at.month == 1 ? 12 : at.month - 1)]
        # The page says which release there is and what it must hash to, so only that file is asked for. When the
        # page cannot be read, the newest release there is goes unchecked against it, and the log says so.
        found = nil
        unchecked = ""
        begin
          found = published
        rescue StandardError => e
          unchecked = e.message
        end
        if !found.nil? && !tries.include?(found["release"])
          @log.call("Runlight: location data was not updated: DB-IP offers the #{found["release"]} release, which is neither this month's nor last month's")
          return
        end
        (found.nil? ? tries : [found["release"]]).each do |name|
          return if File.file?(file(name))

          url = "https://download.db-ip.com/free/dbip-#{@mode}-lite-#{name}.mmdb.gz"
          partial = "#{file(name)}.partial.#{Process.pid}"
          begin
            save(url, partial, found.nil? ? nil : found["sha1"], now)
            File.rename(partial, file(name))
            # Older releases go once the new one is in place.
            Dir.glob("#{@dir}/dbip-#{@mode}-lite-*").each do |old|
              File.unlink(old) if old != file(name)
            rescue SystemCallError
              nil
            end
            if found.nil?
              @log.call("Runlight: warning: location data from DB-IP (#{name}) could not be checked against DB-IP's published checksum (#{unchecked}). " \
                        "It was accepted as a DB-IP database of the right kind, without that check.")
            end
            @log.call("Runlight: location data from DB-IP (#{name}) is ready.")
            return
          rescue StandardError => e
            FileUtils.rm_f(partial)
            # Without the page to say which release there is, this month's not being out yet is no failure.
            next if found.nil? && e.is_a?(Refused) && e.status == 404

            # Whatever went wrong, the database in use stays in use.
            @log.call("Runlight: location data was not updated from #{url}: #{e.message}")
          end
        end
        @log.call("Runlight: location data was not updated: #{unchecked}, and no release could be downloaded without them") if found.nil?
      end

      # Downloads one release to `partial`, unpacked, and raises unless it is fit to use: the published SHA-1's
      # (when there is one to hold it to), and a DB-IP database of this kind no older than the one in use.
      def save(url, partial, sha1, now)
        hash = OpenSSL::Digest.new("SHA1")
        request(url, 10 * 60) do |headers, body|
          raise RuntimeError, "the download is more than #{MOST_PACKED_BYTES / 1024 / 1024} MB" if Js.number(headers["content-length"] || 0) > MOST_PACKED_BYTES

          unpack(body, partial, hash)
        end
        got = hash.hexdigest
        raise RuntimeError, "its SHA-1 is #{got}, and DB-IP publishes #{sha1}" if !sha1.nil? && got != sha1

        self.class.check_database(File.binread(partial), @mode, now, in_use)
      end

      # Unpacks a gzipped body into a file as it arrives, hashing what is written. The stream must be whole and
      # nothing may follow it: Zlib stops reading at the end of the stream, so what it left unread is looked for.
      def unpack(body, partial, hash)
        inflate = Zlib::Inflate.new(Zlib::MAX_WBITS + 16)
        packed = 0
        unpacked = 0
        begin
          File.open(partial, File::WRONLY | File::CREAT | File::TRUNC, 0o644) do |out|
            body.each do |chunk|
              chunk = chunk.to_s.b
              next if chunk.empty?

              packed += chunk.bytesize
              raise RuntimeError, "the location data is more than #{MOST_PACKED_BYTES / 1024 / 1024} MB" if packed > MOST_PACKED_BYTES
              raise RuntimeError, "there is data after the end of its gzip stream" if inflate.finished?

              inflate.inflate(chunk) do |piece|
                unpacked += piece.bytesize
                raise RuntimeError, "the location data is more than #{MOST_BYTES / 1024 / 1024} MB" if unpacked > MOST_BYTES

                hash << piece
                out.write(piece)
              end
              raise RuntimeError, "there is data after the end of its gzip stream" if inflate.finished? && inflate.total_in < packed
            end
            raise RuntimeError, "unexpected end of the gzip stream" unless inflate.finished?
          end
        rescue Zlib::Error => e
          raise RuntimeError, "it is not gzip: #{e.message}"
        ensure
          inflate.close
        end
      end

      # When the newest release on disk was built, in milliseconds, or 0 with none (or one that does not open).
      def in_use
        file = newest
        return 0 if file.nil?

        File.open(file, "rb") do |handle|
          epoch = Mmdb.new("", handle).metadata["build_epoch"]
          epoch.is_a?(Integer) ? epoch * 1000 : 0
        end
      rescue StandardError
        0
      end

      # One GET over https with Net::HTTP, no redirect followed, the body given a part at a time (a city database
      # is too big to hold packed in memory as well as unpacked), and the whole of it within `timeout` seconds.
      def http_get(url, timeout)
        uri = URI(url)
        raise RuntimeError, "not https: #{url}" unless uri.scheme == "https"

        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
        Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: [timeout, 15].min, read_timeout: [timeout, 60].min) do |http|
          # Asked for as it is, so the length the server declares is the length of what arrives.
          get = Net::HTTP::Get.new(uri, { "accept-encoding" => "identity", "user-agent" => "Runlight (+https://runlight.sh)" })
          http.request(get) do |answer|
            headers = {}
            answer.each_header { |name, value| headers[name.downcase] = value }
            parts = Enumerator.new do |out|
              answer.read_body do |chunk|
                raise RuntimeError, "it took more than #{timeout} seconds" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

                out << chunk
              end
            end
            return yield(answer.code.to_i, headers, parts)
          end
        end
      end
    end
  end
end

# frozen_string_literal: true

require "test_helper"
require "tmpdir"
require "fileutils"
require "openssl"
require "zlib"

# DB-IP's location data: a download is used only once it is checked against the checksum DB-IP publishes and
# read as a DB-IP database of the kind asked for. The cases are those of packages/server/test/geo.test.ts, with
# every answer made up here, so nothing reaches the network.
class ServerDbIpTest < Minitest::Test
  DbIp = Runlight::Server::DbIp

  PAGE = "https://db-ip.com/db/download/ip-to-city-lite"
  MIB = 1024 * 1024
  DAY = 86_400_000

  def self.utc(*parts)
    Time.utc(*parts).to_i * 1000
  end
  OCTOBER = utc(2026, 10, 3, 3)

  def setup
    @dirs = []
  end

  def teardown
    @dirs.each { |dir| FileUtils.rm_rf(dir) }
  end

  def file_url(release)
    "https://download.db-ip.com/free/dbip-city-lite-#{release}.mmdb.gz"
  end

  # MMDB's data format, enough of it to write a database: maps, strings, arrays, and unsigned integers.
  def encode(value)
    control = lambda do |type, size|
      if type < 8
        next [(type << 5) | size].pack("C") if size < 29
        next [(type << 5) | 29, size - 29].pack("CC") if size < 285

        next [(type << 5) | 30, (size - 285) >> 8, (size - 285) & 255].pack("CCC")
      end
      raise "too long for this writer" if size >= 29

      [size, type - 7].pack("CC")
    end
    case value
    when String
      text = value.b
      control.call(2, text.bytesize) + text
    when Integer
      bytes = if value < 0x10000 then 2
              elsif value < 0x100000000 then 4
              else 8
              end
      control.call({ 2 => 5, 4 => 6, 8 => 9 }[bytes], bytes) + [value].pack("Q>").byteslice(8 - bytes, bytes)
    when Array
      control.call(11, value.length) + value.map { |item| encode(item) }.join.b
    else
      control.call(7, value.length) + value.map { |k, v| encode(k.to_s) + encode(v) }.join.b
    end
  end

  RECORD = { "country" => { "iso_code" => "US", "names" => { "en" => "United States" } }, "city" => { "names" => { "en" => "Mountain View" } } }.freeze

  # A whole MMDB file of one megabyte or so, in which every address has the same record. `meta` overrides the
  # metadata, and `record` the record (nil leaves every address without one).
  def mmdb(meta = {}, record = RECORD, pad = MIB)
    # One node whose two records both point at the first thing in the data section, or at "no data".
    pointer = record.nil? ? 1 : 1 + 16
    node = [0, 0, pointer, 0, 0, pointer].pack("C*")
    data = encode(record || {}) + ("\0".b * pad)
    metadata = encode({
      "binary_format_major_version" => 2,
      "binary_format_minor_version" => 0,
      "build_epoch" => self.class.utc(2026, 10, 1, 2) / 1000,
      "database_type" => "DBIP-City-Lite",
      "description" => { "en" => "A test database" },
      "ip_version" => 6,
      "languages" => ["en"],
      "node_count" => 1,
      "record_size" => 24,
    }.merge(meta))
    node + ("\0".b * 16) + data + "\xAB\xCD\xEFMaxMind.com".b + metadata
  end

  def sha1(bytes)
    OpenSSL::Digest.new("SHA1").hexdigest(bytes)
  end

  # DB-IP's download page as it reads, with the CSV file's card before the MMDB file's.
  def page(mode, release, sum)
    <<~HTML
      <div class="card"><dl class="card-body"><dt>Format</dt><dd>CSV</dd><dt>MD5SUM</dt>
      <dd class="small">93c945395f0bc2ceefea7dd55750417a</dd><dt>SHA1SUM</dt><dd class="small">e2061015c43ec91c94a12191a6a613279eb94c0c</dd></dl>
      <a href='https://download.db-ip.com/free/dbip-#{mode}-lite-#{release}.csv.gz' class='btn'>Download CSV</a></div>
      <div class="card"><dl class="card-body"><dt>Format</dt><dd>MMDB</dd><dt>MD5SUM</dt><dd class="small">5974b336a7409ec854f67eacd52c2061</dd>
      <dt>SHA1SUM</dt>
      \t\t\t\t\t<dd class="small">#{sum}</dd></dl>
      <a href='https://download.db-ip.com/free/dbip-#{mode}-lite-#{release}.mmdb.gz' class='btn'>Download MMDB</a></div>
    HTML
  end

  # An answer: [status, headers, body].
  def ok(body, headers = {})
    [200, headers, body]
  end

  # A DbIp whose requests are answered from `answers`, by URL, with every URL asked for and every line logged kept.
  # An answer is a callable giving [status, headers, body]; a URL with none answers 404.
  def geo_with(answers)
    dir = Dir.mktmpdir("rl-geo-")
    @dirs << dir
    asked = []
    lines = []
    get = lambda do |url, _timeout, &block|
      asked << url
      status, headers, body = answers[url]&.call || [404, {}, "nope"]
      # In parts, as a body arrives.
      block.call(status, headers, body.to_s.b.scan(/.{1,65536}/mn))
    end
    geo = DbIp.new(dir, "city", get, ->(line) { lines << line })
    Struct.new(:geo, :dir, :asked, :lines, :answers).new(geo, dir, asked, lines, answers)
  end

  # Answers for one release: the page with `sum` (the file's own by default), and the file, gzipped.
  def release(name, file, sum = sha1(file))
    { PAGE => -> { ok(page("city", name, sum)) }, file_url(name) => -> { ok(Zlib.gzip(file)) } }
  end

  def files(dir)
    Dir.children(dir).reject { |name| name.end_with?("-retry") }.sort
  end

  # The release in use: the newest on disk, as a lookup reads it.
  def in_use(t)
    t.geo.newest.nil? ? "" : File.basename(t.geo.newest)[-12, 7]
  end

  def test_a_download_whose_checksum_matches_db_ips_page_is_put_to_use
    file = mmdb
    t = geo_with(release("2026-10", file))
    t.geo.refresh(OCTOBER)
    assert_equal [PAGE, file_url("2026-10")], t.asked
    assert_equal "2026-10", in_use(t)
    assert_equal({ "country" => "US", "region" => "", "city" => "Mountain View" }, t.geo.lookup.call("8.8.8.8"))
    assert_equal({ "country" => "US", "region" => "", "city" => "Mountain View" }, t.geo.load_newest.current.call("8.8.8.8"))
    assert_equal ["dbip-city-lite-2026-10.mmdb"], Dir.children(t.dir)
    assert_equal sha1(file), sha1(File.binread("#{t.dir}/dbip-city-lite-2026-10.mmdb"))
    assert_equal ["Runlight: location data from DB-IP (2026-10) is ready."], t.lines, "ready, and no warning"
  end

  def test_early_in_a_month_the_page_still_offers_last_months_release_and_that_is_the_one_fetched
    t = geo_with(release("2026-09", mmdb({ "build_epoch" => self.class.utc(2026, 9, 1) / 1000 })))
    t.geo.refresh(self.class.utc(2026, 10, 1, 3))
    assert_equal [PAGE, file_url("2026-09")], t.asked
    assert_equal "2026-09", in_use(t)
    t.geo.refresh(self.class.utc(2026, 10, 1, 4))
    assert_equal [PAGE], t.asked[2..], "later the page is read again, and the file on disk is not fetched twice"
  end

  def test_a_download_that_does_not_match_the_published_checksum_is_never_used_and_the_database_in_use_stays
    good = mmdb({ "build_epoch" => self.class.utc(2026, 9, 1) / 1000 })
    t = geo_with(release("2026-09", good))
    t.geo.refresh(self.class.utc(2026, 9, 20))
    assert_equal "2026-09", in_use(t)

    # October's file is not the one DB-IP's page describes: one byte differs.
    swapped = mmdb({}, { "country" => { "iso_code" => "ZZ" } })
    t.answers.merge!(release("2026-10", swapped, sha1(mmdb)))
    t.geo.refresh(OCTOBER)
    assert_equal "2026-09", in_use(t), "last month's is still in use"
    assert_equal({ "country" => "US", "region" => "", "city" => "Mountain View" }, t.geo.lookup.call("8.8.8.8"))
    assert_equal ["dbip-city-lite-2026-09.mmdb"], files(t.dir), "nothing of the bad download is left"
    assert_equal "Runlight: location data was not updated from #{file_url("2026-10")}: its SHA-1 is #{sha1(swapped)}, and DB-IP publishes #{sha1(mmdb)}", t.lines.last

    # Bytes after the end of the gzip stream never reach the file: what is kept is what was hashed.
    october = mmdb
    t.answers.merge!(release("2026-10", october))
    t.answers[file_url("2026-10")] = -> { ok(Zlib.gzip(october) + "extra") }
    t.geo.refresh(OCTOBER + (6 * 3_600_000))
    assert_equal ["dbip-city-lite-2026-09.mmdb"], files(t.dir)
    assert_includes t.lines.last, "there is data after the end of its gzip stream"
    files(t.dir).each { |name| assert_includes [sha1(good), sha1(october)], sha1(File.binread("#{t.dir}/#{name}")), "only checked bytes are on disk" }
  end

  def test_when_no_checksum_can_be_read_at_all_the_newest_release_is_taken_on_its_structure_alone_with_a_warning
    file = mmdb
    [
      ["the page is down", -> { [503, {}, "no"] }, /could not read DB-IP's checksums.*answered 503/],
      ["the page redirects", -> { [302, { "location" => "https://elsewhere.example/" }, ""] }, /answered 302/],
      ["the page has no checksum", -> { ok(page("city", "2026-10", "")) }, /found no checksum/],
      ["the page is for another database", -> { ok(page("country", "2026-10", sha1(file))) }, /found no checksum/],
      ["the page never ends", -> { ok("x" * (2 * MIB)) }, /more than 1024 KB/],
    ].each do |what, answer, why|
      t = geo_with(release("2026-10", file).merge(PAGE => answer))
      t.geo.refresh(OCTOBER)
      assert_equal [PAGE, file_url("2026-10")], t.asked, what
      assert_equal "2026-10", in_use(t), what
      assert_equal ["dbip-city-lite-2026-10.mmdb"], Dir.children(t.dir), what
      warnings = t.lines.select { |line| line.include?("could not be checked against DB-IP's published checksum") }
      assert_equal 1, warnings.length, what
      assert_match(/\ARunlight: warning: location data from DB-IP \(2026-10\)/, warnings[0], what)
      assert_match why, warnings[0], what
      assert_equal "Runlight: location data from DB-IP (2026-10) is ready.", t.lines.last, what
    end

    # As before the page was read: this month's file, then last month's, and a month not out yet is no failure.
    early = geo_with({ file_url("2026-09") => -> { ok(Zlib.gzip(mmdb({ "build_epoch" => self.class.utc(2026, 9, 1) / 1000 }))) } })
    early.geo.refresh(self.class.utc(2026, 10, 1, 3))
    assert_equal [PAGE, file_url("2026-10"), file_url("2026-09")], early.asked
    assert_equal "2026-09", in_use(early)
    assert_equal ["Runlight: warning: location data from DB-IP (2026-", "Runlight: location data from DB-IP (2026-09) is re"], early.lines.map { |line| line[0, 50] }

    # The other checks still hold: what is not a DB-IP city database is not used, checksum or no checksum.
    wrong = geo_with({ file_url("2026-10") => -> { ok(Zlib.gzip(mmdb({ "database_type" => "GeoLite2-City" }))) } })
    wrong.geo.refresh(OCTOBER)
    assert_equal "", in_use(wrong)
    assert_equal [], files(wrong.dir)
    assert_match(/not updated from .*2026-10\.mmdb\.gz: it is a "GeoLite2-City" database/, wrong.lines.join("\n"))
    assert_match(/not updated: could not read DB-IP's checksums.*and no release could be downloaded without them/, wrong.lines.last)
    refute(wrong.lines.any? { |line| line.include?("warning") }, "the warning is for a download that was accepted")
  end

  def test_a_page_that_is_read_is_held_to_a_release_it_does_not_offer_is_not_fetched_and_a_mismatch_is_never_a_fallback
    file = mmdb
    old = geo_with(release("2026-10", file).merge(PAGE => -> { ok(page("city", "2026-05", sha1(file))) }))
    old.geo.refresh(OCTOBER)
    assert_equal [PAGE], old.asked
    assert_equal "", in_use(old)
    assert_equal ["Runlight: location data was not updated: DB-IP offers the 2026-05 release, which is neither this month's nor last month's"], old.lines

    # A good October file is on offer, but the page describes another: refused, with no try at last month's.
    mismatch = geo_with(release("2026-09", file).merge(release("2026-10", file, "0" * 40)))
    mismatch.geo.refresh(OCTOBER)
    assert_equal [PAGE, file_url("2026-10")], mismatch.asked
    assert_equal "", in_use(mismatch)
    assert_equal [], files(mismatch.dir)
    assert_match(/its SHA-1 is [0-9a-f]{40}, and DB-IP publishes 0{40}/, mismatch.lines.join("\n"))
    refute(mismatch.lines.any? { |line| line.include?("warning") })
  end

  def test_a_download_that_redirects_is_not_gzip_or_is_too_large_is_refused
    file = mmdb
    [
      ["a redirect", -> { [301, { "location" => "http://download.db-ip.com/x" }, ""] }, /answered 301/],
      ["not gzip", -> { ok(file) }, /header|gzip/i],
      ["cut short", -> { ok(Zlib.gzip(file)[0, 300]) }, /unexpected end/i],
      ["a length past the limit", -> { ok(Zlib.gzip(file), { "content-length" => (300 * MIB).to_s }) }, /more than 256 MB/],
    ].each do |what, answer, said|
      t = geo_with(release("2026-10", file).merge(file_url("2026-10") => answer))
      t.geo.refresh(OCTOBER)
      assert_equal "", in_use(t), what
      assert_match said, t.lines.join("\n"), what
      assert_equal [], files(t.dir), what
    end
  end

  def test_a_file_with_the_right_checksum_is_still_read_as_a_db_ip_database_before_it_is_used
    refused = lambda do |file, in_use = 0|
      DbIp.check_database(file, "city", OCTOBER, in_use)
      ""
    rescue StandardError => e
      e.message
    end
    assert_equal "", refused.call(mmdb)
    assert_match(/too few/, refused.call(mmdb({}, RECORD, 1000)))
    assert_match(/not an MMDB file/, refused.call("\0".b * (2 * MIB)))
    assert_match(/"GeoLite2-City" database/, refused.call(mmdb({ "database_type" => "GeoLite2-City" })))
    assert_match(/not DB-IP's city one/, refused.call(mmdb({ "database_type" => "DBIP-Country-Lite" })))
    assert_match(/version 3/, refused.call(mmdb({ "binary_format_major_version" => 3 })))
    assert_match(/IP version 4/, refused.call(mmdb({ "ip_version" => 4 })))
    assert_match(/20 bits|does not open/, refused.call(mmdb({ "record_size" => 20 })))
    assert_match(/search tree does not fit|does not open/, refused.call(mmdb({ "node_count" => 900_000 })))
    assert_match(/built on 2026-05-01/, refused.call(mmdb({ "build_epoch" => self.class.utc(2026, 5, 1) / 1000 })))
    assert_match(/built on 2026-12-01/, refused.call(mmdb({ "build_epoch" => self.class.utc(2026, 12, 1) / 1000 })))
    assert_match(/older than the database in use/, refused.call(mmdb, self.class.utc(2026, 10, 2)))
    assert_match(/no country for 8\.8\.8\.8/, refused.call(mmdb({}, nil)))
    assert_match(/no country for 8\.8\.8\.8/, refused.call(mmdb({}, { "city" => { "names" => { "en" => "Nowhere" } } })))
    assert_nil DbIp.check_database(mmdb({ "database_type" => "DBIP-Country-Lite" }), "country", OCTOBER), "the same file is the country database it says it is"

    # And through a download: the page vouches for a file that is not a city database, so it is not used.
    wrong = mmdb({ "database_type" => "DBIP-Country-Lite" })
    t = geo_with(release("2026-10", wrong))
    t.geo.refresh(OCTOBER)
    assert_equal "", in_use(t)
    assert_equal [], files(t.dir)

    # A release built before the one on disk is not put in its place.
    newer = geo_with(release("2026-09", mmdb({ "build_epoch" => self.class.utc(2026, 9, 20) / 1000 })))
    newer.geo.refresh(self.class.utc(2026, 9, 25))
    newer.answers.merge!(release("2026-10", mmdb({ "build_epoch" => self.class.utc(2026, 9, 10) / 1000 })))
    newer.geo.refresh(OCTOBER)
    assert_equal "2026-09", in_use(newer)
    assert_includes newer.lines.last, "it is older than the database in use"
  end

  def test_the_checksum_read_from_db_ips_page_is_the_mmdb_files_not_the_csv_files
    sum = "09eea8433fe3eed71984fd6aac9d8ab3d9ca51f0"
    assert_equal({ "release" => "2026-11", "sha1" => sum }, DbIp.published_checksum(page("country", "2026-11", sum.upcase), "country"))
    assert_nil DbIp.published_checksum(page("country", "2026-11", sum), "city")
    assert_nil DbIp.published_checksum(page("city", "2026-11", "abc"), "city"), "the CSV file's checksum never stands in"
    assert_nil DbIp.published_checksum("<html></html>", "city")
  end

  def test_a_failed_download_leaves_lookups_empty_and_the_folder_clean_and_is_tried_again_later
    t = geo_with({})
    t.geo.refresh(self.class.utc(2026, 10, 1, 3))
    assert_equal [PAGE, file_url("2026-10"), file_url("2026-09")], t.asked, "the checksum comes first; with none, this month's file and then last month's"
    assert_nil t.geo.lookup
    assert_nil t.geo.current.call("8.8.8.8")
    assert_equal [], files(t.dir)
    t.geo.refresh(self.class.utc(2026, 10, 1, 4))
    assert_equal 6, t.asked.length, "tried again on the next check"
    assert_match(/not updated: could not read DB-IP's checksums/, t.lines.last)

    # January's fallback is December of the year before.
    january = geo_with({})
    january.geo.refresh(self.class.utc(2027, 1, 2))
    assert_equal [PAGE, file_url("2027-01"), file_url("2026-12")], january.asked
  end

  def test_a_file_that_keeps_being_missing_or_bad_is_asked_for_less_and_less_often_up_to_every_six_hours
    t = geo_with({})
    start = self.class.utc(2026, 10, 1, 3)
    # The server checks every five minutes; each try asks for the checksum, this month's file, and last month's.
    tries = []
    (0..(24 * 60)).step(5) do |at|
      before = t.asked.length
      t.geo.refresh(start + (at * 60_000))
      tries << at if t.asked.length > before
    end
    assert_equal [0, 5, 15, 35, 75, 155, 315, 635], tries.first(8), "each wait is twice the last"
    assert_equal [995, 1355], tries[8..], "and none is longer than six hours"
    assert_equal tries.length * 3, t.asked.length
    # The wait is kept beside the releases, so a new process (`runlight cron`) keeps to it too.
    again = DbIp.new(t.dir, "city", ->(url, _timeout, &block) { t.asked << url; block.call(404, {}, []) }, ->(_line) {})
    again.refresh(start + (1356 * 60_000))
    assert_equal tries.length * 3, t.asked.length
  end

  def test_db_ip_records_become_a_country_code_a_readable_region_and_a_plain_city
    records = {
      "24.114.0.1" => { "country" => { "iso_code" => "CA" }, "subdivisions" => [{ "names" => { "en" => "Ontario" } }], "city" => { "names" => { "en" => "Toronto (Old Toronto)" } } },
      "8.8.8.8" => { "country" => { "iso_code" => "US" }, "subdivisions" => [{ "iso_code" => "CA", "names" => { "en" => "California" } }], "city" => { "names" => { "en" => "Mountain View" } } },
    }
    reader = Object.new
    reader.define_singleton_method(:get) { |ip| ip == "nonsense" ? raise(ArgumentError, "bad address") : records[ip] }
    lookup = Runlight::Geo.lookup_from(reader)
    assert_equal({ "country" => "CA", "region" => "Ontario", "city" => "Toronto" }, lookup.call("24.114.0.1"))
    assert_equal({ "country" => "US", "region" => "CA", "city" => "Mountain View" }, lookup.call("8.8.8.8"), "a code wins when the database has one")
    assert_nil lookup.call("10.0.0.1")
    assert_nil lookup.call("nonsense")
  end
end

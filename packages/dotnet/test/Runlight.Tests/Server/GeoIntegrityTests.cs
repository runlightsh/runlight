using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using Runlight.Server;
using Xunit;

namespace Runlight.Tests.Server;

/// <summary>
/// DB-IP downloads are used only once they are checked: against the checksum DB-IP publishes, and as a DB-IP
/// database of the right kind. The cases of packages/server/test/geo.test.ts, with every request answered here
/// and none sent anywhere.
/// </summary>
public sealed class GeoIntegrityTests : IDisposable
{
    private const string PageUrl = "https://db-ip.com/db/download/ip-to-city-lite";
    private const long Hour = 3_600_000;
    private const long Minute = 60_000;

    private static readonly long October = Time.Utc(2026, 9, 3, 3);

    private readonly List<string> _dirs = [];

    public void Dispose()
    {
        foreach (string dir in _dirs.Where(Directory.Exists))
        {
            Directory.Delete(dir, true);
        }
    }

    private static string FileUrl(string release) => "https://download.db-ip.com/free/dbip-city-lite-" + release + ".mmdb.gz";

    // ---- a database to download

    /// <summary>MMDB's data format, enough of it to write a database: maps, strings, arrays, and unsigned integers.</summary>
    private static byte[] Encode(object? value)
    {
        static byte[] Control(int type, int size)
        {
            if (type >= 8)
            {
                return size < 29 ? [(byte)size, (byte)(type - 7)] : throw new InvalidOperationException("too long for this writer");
            }
            int head = (type << 5) | (size < 29 ? size : size < 285 ? 29 : 30);
            if (size < 29)
            {
                return [(byte)head];
            }
            return size < 285 ? [(byte)head, (byte)(size - 29)] : [(byte)head, (byte)((size - 285) >> 8), (byte)((size - 285) & 255)];
        }
        switch (value)
        {
            case string text:
                {
                    byte[] bytes = Encoding.UTF8.GetBytes(text);
                    return [.. Control(2, bytes.Length), .. bytes];
                }
            case long number:
                {
                    int bytes = number < 0x10000 ? 2 : number < 0x100000000 ? 4 : 8;
                    byte[] all = new byte[8];
                    System.Buffers.Binary.BinaryPrimitives.WriteUInt64BigEndian(all, (ulong)number);
                    return [.. Control(bytes == 2 ? 5 : bytes == 4 ? 6 : 9, bytes), .. all[(8 - bytes)..]];
                }
            case List<object?> list:
                return [.. Control(11, list.Count), .. list.SelectMany(Encode)];
            case JsObject map:
                return [.. Control(7, map.Count), .. map.SelectMany(e => Encode(e.Key).Concat(Encode(e.Value)))];
            default:
                throw new InvalidOperationException("not something this writer writes");
        }
    }

    private static JsObject UnitedStates() => new()
    {
        ["country"] = new JsObject { ["iso_code"] = "US", ["names"] = new JsObject { ["en"] = "United States" } },
        ["city"] = new JsObject { ["names"] = new JsObject { ["en"] = "Mountain View" } },
    };

    /// <summary>
    /// A whole MMDB file of one megabyte or so, in which every address has the same record. <paramref name="meta"/>
    /// overrides the metadata; <paramref name="noRecord"/> leaves every address without one.
    /// </summary>
    private static byte[] Mmdb(JsObject? meta = null, JsObject? record = null, bool noRecord = false, int pad = 1024 * 1024)
    {
        // One node whose two records both point at the first thing in the data section, or at "no data".
        byte pointer = (byte)(noRecord ? 1 : 1 + 16);
        byte[] node = [0, 0, pointer, 0, 0, pointer];
        var metadata = new JsObject
        {
            ["binary_format_major_version"] = 2L,
            ["binary_format_minor_version"] = 0L,
            ["build_epoch"] = Time.Utc(2026, 9, 1, 2) / 1000,
            ["database_type"] = "DBIP-City-Lite",
            ["description"] = new JsObject { ["en"] = "A test database" },
            ["ip_version"] = 6L,
            ["languages"] = new List<object?> { "en" },
            ["node_count"] = 1L,
            ["record_size"] = 24L,
        };
        foreach (var (key, value) in meta ?? [])
        {
            metadata[key] = value;
        }
        return [.. node, .. new byte[16], .. Encode(noRecord ? new JsObject() : record ?? UnitedStates()), .. new byte[pad], 0xAB, 0xCD, 0xEF, .. "MaxMind.com"u8, .. Encode(metadata)];
    }

    private static JsObject Built(int year, int month, int day) => new() { ["build_epoch"] = Time.Utc(year, month, day) / 1000 };

#pragma warning disable CA5350 // The checksum DB-IP publishes is a SHA-1.
    private static string Sha1(byte[] bytes) => Convert.ToHexStringLower(SHA1.HashData(bytes));
#pragma warning restore CA5350

    private static byte[] Gzip(byte[] bytes)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionMode.Compress))
        {
            gzip.Write(bytes);
        }
        return output.ToArray();
    }

    /// <summary>DB-IP's download page as it reads, with the CSV file's card before the MMDB file's.</summary>
    private static string Page(string mode, string release, string sum) =>
        "<div class=\"card\"><dl class=\"card-body\"><dt>Format</dt><dd>CSV</dd><dt>MD5SUM</dt>\n"
        + "<dd class=\"small\">93c945395f0bc2ceefea7dd55750417a</dd><dt>SHA1SUM</dt><dd class=\"small\">e2061015c43ec91c94a12191a6a613279eb94c0c</dd></dl>\n"
        + "<a href='https://download.db-ip.com/free/dbip-" + mode + "-lite-" + release + ".csv.gz' class='btn'>Download CSV</a></div>\n"
        + "<div class=\"card\"><dl class=\"card-body\"><dt>Format</dt><dd>MMDB</dd><dt>MD5SUM</dt><dd class=\"small\">5974b336a7409ec854f67eacd52c2061</dd>\n"
        + "<dt>SHA1SUM</dt>\n\t\t\t\t\t<dd class=\"small\">" + sum + "</dd></dl>\n"
        + "<a href='https://download.db-ip.com/free/dbip-" + mode + "-lite-" + release + ".mmdb.gz' class='btn'>Download MMDB</a></div>";

    // ---- a downloader whose requests are answered here

    private sealed class Rig(string dir, Dictionary<string, Func<DbIpAnswer>> answers)
    {
        public string Dir { get; } = dir;

        public Dictionary<string, Func<DbIpAnswer>> Answers { get; } = answers;

        public List<string> Asked { get; } = [];

        public List<string> Lines { get; } = [];

        public DbIp Geo { get; private set; } = null!;

        public Rig Start()
        {
            Geo = new DbIp(Dir, "city", (url, _) =>
            {
                Asked.Add(url);
                return Task.FromResult(Answers.TryGetValue(url, out var answer) ? answer() : Text("nope", 404));
            }, Lines.Add);
            return this;
        }

        /// <summary>The release open for lookups once the schedule has loaded the newest, or "" when there is none.</summary>
        public string Release()
        {
            Geo.LoadNewest();
            string? newest = Geo.Newest();
            return newest == null ? "" : newest[^12..^5];
        }

        public string[] Files() => [.. Directory.GetFiles(Dir).Select(f => Path.GetFileName(f)!).Order(StringComparer.Ordinal)];
    }

    private static DbIpAnswer Bytes(byte[] bytes, int status = 200, long? contentLength = null) => new(status, new MemoryStream(bytes), contentLength);

    private static DbIpAnswer Text(string text, int status = 200) => Bytes(Encoding.UTF8.GetBytes(text), status);

    private Rig GeoWith(Dictionary<string, Func<DbIpAnswer>> answers)
    {
        string dir = Path.Combine(Path.GetTempPath(), "rl-geo-" + Guid.NewGuid().ToString("N"));
        _dirs.Add(dir);
        Directory.CreateDirectory(dir);
        return new Rig(dir, answers).Start();
    }

    /// <summary>Answers for one release: the page with a checksum (the file's own by default), and the file, gzipped.</summary>
    private static Dictionary<string, Func<DbIpAnswer>> Release(string name, byte[] file, string? sum = null) => new(StringComparer.Ordinal)
    {
        [PageUrl] = () => Text(Page("city", name, sum ?? Sha1(file))),
        [FileUrl(name)] = () => Bytes(Gzip(file)),
    };

    private static Dictionary<string, Func<DbIpAnswer>> With(Dictionary<string, Func<DbIpAnswer>> answers, params (string Url, Func<DbIpAnswer> Answer)[] more)
    {
        var all = new Dictionary<string, Func<DbIpAnswer>>(answers, StringComparer.Ordinal);
        foreach (var (url, answer) in more)
        {
            all[url] = answer;
        }
        return all;
    }

    private static string Found(JsObject? place) => place == null ? "null" : Json.Stringify(place);

    // ---- the cases

    [Fact]
    public async Task A_download_whose_checksum_matches_db_ips_page_is_put_to_use()
    {
        byte[] file = Mmdb();
        var t = GeoWith(Release("2026-10", file));
        Assert.Null(t.Geo.Lookup()); // nothing to look up before the first download
        await t.Geo.RefreshAsync(October);
        Assert.Equal([PageUrl, FileUrl("2026-10")], t.Asked);
        Assert.Null(t.Geo.Current()("8.8.8.8")); // a running server reads nothing until it loads the release
        Assert.Equal("2026-10", t.Release());
        Assert.Equal("{\"country\":\"US\",\"region\":\"\",\"city\":\"Mountain View\"}", Found(t.Geo.Current()("8.8.8.8")));
        Assert.Equal("{\"country\":\"US\",\"region\":\"\",\"city\":\"Mountain View\"}", Found(t.Geo.Lookup()!("8.8.8.8")));
        Assert.Equal(["dbip-city-lite-2026-10.mmdb"], t.Files());
        Assert.Equal(Sha1(file), Sha1(File.ReadAllBytes(t.Dir + "/dbip-city-lite-2026-10.mmdb")));
        Assert.Equal(["Runlight: location data from DB-IP (2026-10) is ready."], t.Lines);
        // Once this month's file is there, nothing is asked for.
        await t.Geo.RefreshAsync(October + Hour);
        Assert.Equal(2, t.Asked.Count);
    }

    [Fact]
    public async Task Early_in_a_month_the_page_still_offers_last_months_release_and_that_is_the_one_fetched()
    {
        var t = GeoWith(Release("2026-09", Mmdb(Built(2026, 8, 1))));
        await t.Geo.RefreshAsync(Time.Utc(2026, 9, 1, 3));
        Assert.Equal([PageUrl, FileUrl("2026-09")], t.Asked);
        Assert.Equal("2026-09", t.Release());
        // Later the page is read again, and the file on disk is not fetched twice.
        await t.Geo.RefreshAsync(Time.Utc(2026, 9, 1, 4));
        Assert.Equal([PageUrl], t.Asked.Skip(2));
    }

    [Fact]
    public async Task A_download_that_does_not_match_the_published_checksum_is_never_used_and_the_database_in_use_stays()
    {
        byte[] good = Mmdb(Built(2026, 8, 1));
        var t = GeoWith(Release("2026-09", good));
        await t.Geo.RefreshAsync(Time.Utc(2026, 8, 20));
        Assert.Equal("2026-09", t.Release());

        // October's file is not the one DB-IP's page describes.
        byte[] swapped = Mmdb(record: new JsObject { ["country"] = new JsObject { ["iso_code"] = "ZZ" } });
        foreach (var (url, answer) in Release("2026-10", swapped, Sha1(Mmdb())))
        {
            t.Answers[url] = answer;
        }
        await t.Geo.RefreshAsync(October);
        Assert.Equal("2026-09", t.Release()); // last month's is still in use
        Assert.Equal("{\"country\":\"US\",\"region\":\"\",\"city\":\"Mountain View\"}", Found(t.Geo.Current()("8.8.8.8")));
        Assert.Equal(["dbip-city-lite-2026-09.mmdb"], t.Files()); // nothing of the bad download is left
        Assert.Equal("Runlight: location data was not updated from " + FileUrl("2026-10") + ": its SHA-1 is " + Sha1(swapped) + ", and DB-IP publishes " + Sha1(Mmdb()), t.Lines[^1]);

        // Bytes after the end of the gzip stream never reach the file: what is kept is what was hashed.
        byte[] october = Mmdb();
        foreach (var (url, answer) in Release("2026-10", october))
        {
            t.Answers[url] = answer;
        }
        t.Answers[FileUrl("2026-10")] = () => Bytes([.. Gzip(october), .. "extra"u8]);
        await t.Geo.RefreshAsync(October + 6 * Hour);
        Assert.All(t.Files(), name => Assert.Contains(Sha1(File.ReadAllBytes(t.Dir + "/" + name)), new[] { Sha1(good), Sha1(october) }));
        Assert.Equal(["dbip-city-lite-2026-09.mmdb"], t.Files());
    }

    [Fact]
    public async Task When_no_checksum_can_be_read_at_all_the_newest_release_is_taken_on_its_structure_alone_with_a_warning()
    {
        byte[] file = Mmdb();
        foreach (var (what, answer, why) in new (string, Func<DbIpAnswer>, string)[]
        {
            ("the page is down", () => Text("no", 503), "could not read DB-IP's checksums at " + PageUrl + ": it answered 503"),
            ("the page redirects", () => Text("", 302), "it answered 302"),
            ("the page has no checksum", () => Text(Page("city", "2026-10", "")), "found no checksum for the city database at " + PageUrl),
            ("the page is for another database", () => Text(Page("country", "2026-10", Sha1(file))), "found no checksum"),
            ("the page never ends", () => Text(new string('x', 2 * 1024 * 1024)), "it is more than 1024 KB"),
        })
        {
            var t = GeoWith(With(Release("2026-10", file), (PageUrl, answer)));
            await t.Geo.RefreshAsync(October);
            Assert.True(t.Asked.SequenceEqual([PageUrl, FileUrl("2026-10")]), what);
            Assert.True(t.Release() == "2026-10", what);
            Assert.True(t.Files().SequenceEqual(["dbip-city-lite-2026-10.mmdb"]), what);
            string warning = Assert.Single(t.Lines, line => line.Contains("could not be checked against DB-IP's published checksum", StringComparison.Ordinal));
            Assert.StartsWith("Runlight: warning: location data from DB-IP (2026-10)", warning, StringComparison.Ordinal);
            Assert.Contains(why, warning, StringComparison.Ordinal);
            Assert.EndsWith("It was accepted as a DB-IP database of the right kind, without that check.", warning, StringComparison.Ordinal);
        }

        // As before the page was read: this month's file, then last month's, and a month not out yet is no failure.
        var early = GeoWith(new(StringComparer.Ordinal) { [FileUrl("2026-09")] = () => Bytes(Gzip(Mmdb(Built(2026, 8, 1)))) });
        await early.Geo.RefreshAsync(Time.Utc(2026, 9, 1, 3));
        Assert.Equal([PageUrl, FileUrl("2026-10"), FileUrl("2026-09")], early.Asked);
        Assert.Equal("2026-09", early.Release());
        Assert.Equal(["Runlight: warning: location data from DB-IP (2026-", "Runlight: location data from DB-IP (2026-09) is re"], early.Lines.Select(line => line[..50]));

        // January's last month is December of the year before.
        var january = GeoWith(new(StringComparer.Ordinal) { ["https://download.db-ip.com/free/dbip-city-lite-2026-12.mmdb.gz"] = () => Bytes(Gzip(Mmdb(Built(2026, 11, 1)))) });
        await january.Geo.RefreshAsync(Time.Utc(2027, 0, 2));
        Assert.Equal("2026-12", january.Release());

        // The other checks still hold: what is not a DB-IP city database is not used, checksum or no checksum.
        var wrong = GeoWith(new(StringComparer.Ordinal) { [FileUrl("2026-10")] = () => Bytes(Gzip(Mmdb(new JsObject { ["database_type"] = "GeoLite2-City" }))) });
        await wrong.Geo.RefreshAsync(October);
        Assert.Equal("", wrong.Release());
        Assert.Empty(wrong.Files());
        Assert.Contains(wrong.Lines, line => line.StartsWith("Runlight: location data was not updated from " + FileUrl("2026-10") + ": it is a \"GeoLite2-City\" database", StringComparison.Ordinal));
        Assert.Equal("Runlight: location data was not updated: could not read DB-IP's checksums at " + PageUrl + ": it answered 404, and no release could be downloaded without them", wrong.Lines[^1]);
        Assert.DoesNotContain(wrong.Lines, line => line.Contains("warning", StringComparison.Ordinal)); // the warning is for a download that was accepted
    }

    [Fact]
    public async Task A_page_that_is_read_is_held_to_a_release_it_does_not_offer_is_not_fetched_and_a_mismatch_is_never_a_fallback()
    {
        byte[] file = Mmdb();
        var old = GeoWith(With(Release("2026-10", file), (PageUrl, () => Text(Page("city", "2026-05", Sha1(file))))));
        await old.Geo.RefreshAsync(October);
        Assert.Equal([PageUrl], old.Asked);
        Assert.Equal("", old.Release());
        Assert.Equal(["Runlight: location data was not updated: DB-IP offers the 2026-05 release, which is neither this month's nor last month's"], old.Lines);

        // A good October file is on offer, but the page describes another: refused, with no try at last month's.
        var answers = Release("2026-09", file);
        foreach (var (url, answer) in Release("2026-10", file, new string('0', 40)))
        {
            answers[url] = answer;
        }
        var mismatch = GeoWith(answers);
        await mismatch.Geo.RefreshAsync(October);
        Assert.Equal([PageUrl, FileUrl("2026-10")], mismatch.Asked);
        Assert.Equal("", mismatch.Release());
        Assert.Empty(mismatch.Files());
        Assert.Equal(["Runlight: location data was not updated from " + FileUrl("2026-10") + ": its SHA-1 is " + Sha1(file) + ", and DB-IP publishes " + new string('0', 40)], mismatch.Lines);
    }

    [Fact]
    public async Task A_download_that_redirects_is_not_gzip_or_is_too_large_is_refused()
    {
        byte[] file = Mmdb();
        foreach (var (what, answer, said) in new (string, Func<DbIpAnswer>, string)[]
        {
            ("a redirect", () => Text("", 301), "it answered 301"),
            ("not gzip", () => Bytes(file), "gzip"),
            ("cut short", () => Bytes(Gzip(file)[..300]), "unexpected end"),
            ("a length past the limit", () => Bytes(Gzip(file), 200, 300L * 1024 * 1024), "the download is more than 256 MB"),
        })
        {
            var t = GeoWith(With(Release("2026-10", file), (FileUrl("2026-10"), answer)));
            await t.Geo.RefreshAsync(October);
            Assert.True(t.Release().Length == 0, what);
            Assert.True(string.Join('\n', t.Lines).Contains(said, StringComparison.Ordinal), what + ": " + string.Join('\n', t.Lines));
            Assert.True(t.Files().Length == 0, what);
        }
    }

    [Fact]
    public async Task A_file_with_the_right_checksum_is_still_read_as_a_db_ip_database_before_it_is_used()
    {
        string dir = Path.Combine(Path.GetTempPath(), "rl-geo-" + Guid.NewGuid().ToString("N"));
        _dirs.Add(dir);
        Directory.CreateDirectory(dir);
        int n = 0;
        string Refused(byte[] file, long inUse = 0)
        {
            string path = dir + "/check-" + (n++).ToString(System.Globalization.CultureInfo.InvariantCulture);
            File.WriteAllBytes(path, file);
            try
            {
                DbIp.CheckDatabase(path, "city", October, inUse);
                return "";
            }
            catch (InvalidDataException error)
            {
                return error.Message;
            }
        }
        static JsObject Meta(string key, object? value) => new() { [key] = value };
        Assert.Equal("", Refused(Mmdb()));
        Assert.Contains("too few", Refused(Mmdb(pad: 1000)), StringComparison.Ordinal);
        Assert.Equal("it is not an MMDB file", Refused(new byte[2 * 1024 * 1024]));
        Assert.Equal("it is a \"GeoLite2-City\" database, not DB-IP's city one", Refused(Mmdb(Meta("database_type", "GeoLite2-City"))));
        Assert.Equal("it is a \"DBIP-Country-Lite\" database, not DB-IP's city one", Refused(Mmdb(Meta("database_type", "DBIP-Country-Lite"))));
        Assert.Equal("its format is version 3, not 2", Refused(Mmdb(Meta("binary_format_major_version", 3L))));
        Assert.Equal("it covers IP version 4, not 6", Refused(Mmdb(Meta("ip_version", 4L))));
        Assert.Matches("20 bits|does not open", Refused(Mmdb(Meta("record_size", 20L))));
        Assert.Matches("search tree does not fit|does not open", Refused(Mmdb(Meta("node_count", 900_000L))));
        Assert.Equal("it was built on 2026-05-01", Refused(Mmdb(Built(2026, 4, 1))));
        Assert.Equal("it was built on 2026-12-01", Refused(Mmdb(Built(2026, 11, 1))));
        Assert.Equal("it is older than the database in use", Refused(Mmdb(), Time.Utc(2026, 9, 2)));
        Assert.Equal("it has no country for 8.8.8.8", Refused(Mmdb(noRecord: true)));
        Assert.Equal("it has no country for 8.8.8.8", Refused(Mmdb(record: new JsObject { ["city"] = new JsObject { ["names"] = new JsObject { ["en"] = "Nowhere" } } })));

        // And through a download: the page vouches for a file that is not a city database, so it is not used.
        var t = GeoWith(Release("2026-10", Mmdb(Meta("database_type", "DBIP-Country-Lite"))));
        await t.Geo.RefreshAsync(October);
        Assert.Equal("", t.Release());
        Assert.Empty(t.Files());
    }

    [Fact]
    public void The_checksum_read_from_db_ips_page_is_the_mmdb_files_not_the_csv_files()
    {
        const string Sum = "09eea8433fe3eed71984fd6aac9d8ab3d9ca51f0";
        Assert.Equal(("2026-11", Sum), DbIp.PublishedChecksum(Page("country", "2026-11", Sum.ToUpperInvariant()), "country"));
        Assert.Null(DbIp.PublishedChecksum(Page("country", "2026-11", Sum), "city"));
        Assert.Null(DbIp.PublishedChecksum(Page("city", "2026-11", "abc"), "city")); // the CSV file's checksum never stands in
        Assert.Null(DbIp.PublishedChecksum("<html></html>", "city"));
    }

    [Fact]
    public async Task A_failed_download_leaves_lookups_empty_and_the_folder_clean_and_is_tried_again_later()
    {
        var t = GeoWith([]);
        await t.Geo.RefreshAsync(Time.Utc(2026, 9, 1, 3));
        // The checksum comes first; with none, this month's file and then last month's.
        Assert.Equal([PageUrl, FileUrl("2026-10"), FileUrl("2026-09")], t.Asked);
        Assert.Equal("", t.Release());
        Assert.Null(t.Geo.Current()("8.8.8.8"));
        Assert.Empty(t.Files());
        await t.Geo.RefreshAsync(Time.Utc(2026, 9, 1, 4));
        Assert.Equal(6, t.Asked.Count); // tried again on the next check
        Assert.StartsWith("Runlight: location data was not updated: could not read DB-IP's checksums", t.Lines[^1], StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_file_that_keeps_being_missing_or_bad_is_asked_for_less_and_less_often_up_to_every_six_hours()
    {
        var t = GeoWith([]);
        long start = Time.Utc(2026, 9, 1, 3);
        // The server checks every five minutes; each try asks for the checksum, this month's file, and last month's.
        var tries = new List<int>();
        for (int at = 0; at <= 24 * 60; at += 5)
        {
            int before = t.Asked.Count;
            await t.Geo.RefreshAsync(start + at * Minute);
            if (t.Asked.Count > before)
            {
                tries.Add(at);
            }
        }
        Assert.Equal([0, 5, 15, 35, 75, 155, 315, 635], tries.Take(8)); // each wait is twice the last
        Assert.Equal([995, 1355], tries.Skip(8)); // and none is longer than six hours
        Assert.Equal(tries.Count * 3, t.Asked.Count);
    }
}

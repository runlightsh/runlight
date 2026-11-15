using System;
using System.Buffers.Binary;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Runlight.Server;

/// <summary>
/// Location for servers with no platform headers (Cloudflare, Vercel, and Netlify send their own, and those always
/// win), from DB-IP's free databases (CC BY 4.0, https://db-ip.com). This is the port of the Geo class in
/// packages/server/src/geo.ts: <c>runlight cron</c> and the server's own schedule download each month's release
/// with <see cref="RefreshAsync"/>, and lookups read the newest file on disk. <see cref="Lookup"/> opens it at the
/// first lookup, as each PHP request does; a server that keeps running reads through <see cref="Current"/>
/// instead, which <see cref="LoadNewest"/> points at the newest release whenever the schedule runs, as the Node
/// server's Geo does.
/// </summary>
/// <remarks>
/// A download is used only once it is checked: its SHA-1 against the one DB-IP publishes on its download page, and
/// the file itself as a DB-IP database of the kind asked for, no older than the one in use. That catches a damaged
/// or swapped file, and a download server serving something else. It is a checksum, and no signature: DB-IP
/// publishes none, so whoever can change DB-IP's own page can change both. A checksum that does not match always
/// refuses the download. Only when none can be read at all (the page is down, or no longer reads as it did) is a
/// download accepted on the other checks alone, with a warning, so a change to that page does not stop location
/// data everywhere.
/// </remarks>
public sealed partial class DbIp
{
    private readonly string _dir;
    private readonly string _mode;
    private readonly Func<string, CancellationToken, Task<DbIpAnswer>> _download;
    private readonly Action<string> _log;
    private readonly Lock _lock = new();
    private string? _loaded;
    private Func<string, JsObject?>? _lookup;
    private Mmdb? _reader;

    /// <param name="dir">The folder the releases live in.</param>
    /// <param name="mode">"city" or "country".</param>
    /// <param name="download">
    /// One GET of the URL given, answered with its status and its body as it arrives, following no redirect; a
    /// plain HTTPS request by default. Both DB-IP's checksum page and the database itself are asked for through it.
    /// </param>
    /// <param name="log">Where it says what it did; standard error by default.</param>
    public DbIp(string dir, string mode, Func<string, CancellationToken, Task<DbIpAnswer>>? download = null, Action<string>? log = null)
    {
        _dir = dir;
        _mode = mode;
        _download = download ?? DownloadAsync;
        _log = log ?? (line => Console.Error.WriteLine(line));
    }

    /// <summary>"2026-10", the month DB-IP names each release after.</summary>
    public static string Month(long ms) => DateTimeOffset.FromUnixTimeMilliseconds(ms).UtcDateTime.ToString("yyyy-MM", CultureInfo.InvariantCulture);

    private string File(string release) => _dir + "/dbip-" + _mode + "-lite-" + release + ".mmdb";

    /// <summary>The newest release on disk, or null before the first download.</summary>
    public string? Newest()
    {
        if (!Directory.Exists(_dir))
        {
            return null;
        }
        string prefix = "dbip-" + _mode + "-lite-";
        return Directory.GetFiles(_dir)
            .Where(f => Path.GetFileName(f).StartsWith(prefix, StringComparison.Ordinal) && f.EndsWith(".mmdb", StringComparison.Ordinal))
            .Select(f => _dir + "/" + Path.GetFileName(f))
            .Order(StringComparer.Ordinal)
            .LastOrDefault();
    }

    /// <summary>
    /// A lookup answering from the newest release on disk, opened at the first lookup, or null when there is none
    /// yet. Lookups that fail answer nothing, as they do before the first download in TypeScript.
    /// </summary>
    public Func<string, JsObject?>? Lookup()
    {
        string? file = Newest();
        if (file == null)
        {
            return null;
        }
        Func<string, JsObject?>? found = null;
        return ip =>
        {
            try
            {
                found ??= Geo.LookupFrom(Mmdb.Open(file));
            }
            catch (Exception)
            {
                return null;
            }
            return found(ip);
        };
    }

    /// <summary>A lookup that always answers, from the release <see cref="LoadNewest"/> last opened, and with nothing before there is one.</summary>
    public Func<string, JsObject?> Current() => ip => _lookup?.Invoke(ip);

    /// <summary>
    /// Opens the newest release on disk when it is not the one open already. Safe to call often: it reads only the
    /// folder when nothing changed.
    /// </summary>
    public DbIp LoadNewest()
    {
        string? file = Newest();
        if (file == null || file == _loaded)
        {
            return this;
        }
        lock (_lock)
        {
            if (file != _loaded)
            {
                try
                {
                    var reader = Mmdb.Open(file);
                    var old = _reader;
                    _lookup = Geo.LookupFrom(reader);
                    _reader = reader;
                    _loaded = file;
                    if (old != null)
                    {
                        // Closed once lookups already under way on it have had time to finish.
                        _ = Task.Delay(TimeSpan.FromSeconds(30)).ContinueWith(_ => old.Dispose(), TaskScheduler.Default);
                    }
                }
                catch (Exception error)
                {
                    _log("Runlight: could not open location data in " + file + ": " + error.Message);
                }
            }
        }
        return this;
    }

    /// <summary>
    /// Fetches this month's release when it is missing. A new month's file appears a day or so after the month
    /// starts, so until then last month's is fetched when that is missing too. Older releases go once a new one is
    /// ready. Safe to call often: once this month's file is there it reads only the folder.
    /// </summary>
    public async Task RefreshAsync(long now, CancellationToken cancellationToken = default)
    {
        string current = Month(now);
        if (System.IO.File.Exists(File(current)))
        {
            return;
        }
        // While the month's file is not published yet, or a download keeps failing, each try waits twice as long as
        // the last, from five minutes up to six hours, so neither DB-IP nor the disk is asked for the whole file
        // every few minutes.
        if (now < _retryAt)
        {
            return;
        }
        try
        {
            await FetchAsync(current, now, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            if (System.IO.File.Exists(File(current)))
            {
                _wait = 0;
            }
            else
            {
                _wait = Math.Min(_wait == 0 ? FirstWaitMs : _wait * 2, LongestWaitMs);
                _retryAt = now + _wait;
            }
        }
    }

    /// <summary>How long after a first failed try the next one waits, and the longest any waits.</summary>
    public const long FirstWaitMs = 5 * 60_000;

    public const long LongestWaitMs = 6 * 3_600_000;

    /// <summary>After a try that left this month's file missing: how long the next waits, and when it may start.</summary>
    private long _wait;

    private long _retryAt;

    /// <summary>The most a database may unpack to, several times the city file's size, so a bad download cannot fill the disk.</summary>
    public const long MostBytes = 512L * 1024 * 1024;

    /// <summary>The most the download itself may weigh, and the least a database unpacks to (the country one is 8 MB).</summary>
    public const long MostPackedBytes = 256L * 1024 * 1024;

    public const long FewestBytes = 1024 * 1024;

    /// <summary>The most of DB-IP's download page that is read; it is about 25 KB.</summary>
    public const int MostPageBytes = 1024 * 1024;

    private const long Day = 86_400_000;

    /// <summary>A release is built at the start of its month and stands in until the next appears, so one is two months old at most.</summary>
    private const long OldestBuild = 100 * Day;

    /// <summary>Addresses any location database knows: Google's and Cloudflare's resolvers, over IPv4 and IPv6.</summary>
    private static readonly string[] Known = ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"];

    private static readonly byte[] Marker = [0xAB, 0xCD, 0xEF, .. "MaxMind.com"u8];

    /// <summary>A download that was refused, with the status it answered when that is why.</summary>
    private sealed class Refused(string message, int status = 0) : Exception(message)
    {
        public int Status { get; } = status;
    }

    /// <summary>One GET that goes nowhere but where it was sent: https, and no redirect followed. Anything but a 200 is refused.</summary>
    private async Task<DbIpAnswer> GetAsync(string url, CancellationToken cancellationToken)
    {
        var answer = await _download(url, cancellationToken).ConfigureAwait(false);
        if (answer.Status != 200)
        {
            answer.Dispose();
            throw new Refused("it answered " + Js.Str(answer.Status), answer.Status);
        }
        return answer;
    }

    /// <summary>What went wrong, in the words the log gives: time running out has none of its own.</summary>
    private static string Reason(Exception error) => error is OperationCanceledException ? "it took too long to answer" : error.Message;

    /// <summary>The release DB-IP's download page offers for this kind of database, and the SHA-1 it gives for the unpacked file.</summary>
    private async Task<(string Release, string Sha1)> PublishedAsync(CancellationToken cancellationToken)
    {
        string url = "https://db-ip.com/db/download/ip-to-" + _mode + "-lite";
        string page;
        try
        {
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            limit.CancelAfter(TimeSpan.FromSeconds(30));
            using var answer = await GetAsync(url, limit.Token).ConfigureAwait(false);
            using var bytes = new MemoryStream();
            byte[] buffer = new byte[16384];
            int n;
            while ((n = await answer.Body.ReadAsync(buffer, limit.Token).ConfigureAwait(false)) > 0)
            {
                if (bytes.Length + n > MostPageBytes)
                {
                    throw new Refused("it is more than " + Js.Str(MostPageBytes / 1024) + " KB");
                }
                bytes.Write(buffer, 0, n);
            }
            page = Js.Decode(bytes.ToArray());
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            throw new Refused("could not read DB-IP's checksums at " + url + ": " + Reason(error));
        }
        return PublishedChecksum(page, _mode) ?? throw new Refused("found no checksum for the " + _mode + " database at " + url);
    }

    [GeneratedRegex("download\\.db-ip\\.com/free/dbip-", RegexOptions.CultureInvariant | RegexOptions.NonBacktracking)]
    private static partial Regex AnyLink();

    [GeneratedRegex("SHA1SUM[\\s\\S]{0,200}?\\b([0-9a-fA-F]{40})\\b", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase, matchTimeoutMilliseconds: 2000)]
    private static partial Regex Sha1Sum();

    /// <summary>
    /// The release and SHA-1 on DB-IP's download page for the MMDB file of one kind: the last SHA1SUM before the
    /// link to that file, and after the link to any other. Null when the page does not read that way.
    /// </summary>
    public static (string Release, string Sha1)? PublishedChecksum(string page, string mode)
    {
        ArgumentNullException.ThrowIfNull(page);
        ArgumentNullException.ThrowIfNull(mode);
        string start = "download.db-ip.com/free/dbip-" + mode + "-lite-";
        const string end = ".mmdb.gz";
        // The first link to this kind's MMDB file: the name, a release as YYYY-MM, and the file's ending.
        int link = -1;
        string release = "";
        for (int at = page.IndexOf(start, StringComparison.Ordinal); at >= 0; at = page.IndexOf(start, at + 1, StringComparison.Ordinal))
        {
            int name = at + start.Length;
            if (name + 7 + end.Length <= page.Length
                && char.IsAsciiDigit(page[name]) && char.IsAsciiDigit(page[name + 1]) && char.IsAsciiDigit(page[name + 2]) && char.IsAsciiDigit(page[name + 3])
                && page[name + 4] == '-' && char.IsAsciiDigit(page[name + 5]) && char.IsAsciiDigit(page[name + 6])
                && string.CompareOrdinal(page, name + 7, end, 0, end.Length) == 0)
            {
                link = at;
                release = page.Substring(name, 7);
                break;
            }
        }
        if (link < 0)
        {
            return null;
        }
        string before = page[..link];
        var others = AnyLink().Matches(before);
        string card = others.Count > 0 ? before[others[^1].Index..] : before;
        MatchCollection sums;
        try
        {
            sums = Sha1Sum().Matches(card);
            return sums.Count > 0 ? (release, sums[^1].Groups[1].Value.ToLowerInvariant()) : null;
        }
        catch (RegexMatchTimeoutException)
        {
            return null;
        }
    }

    /// <summary>When the database in use was built, in milliseconds, or 0 when there is none: the one open, else the newest on disk.</summary>
    private long InUseBuilt()
    {
        try
        {
            var reader = _reader;
            if (reader != null)
            {
                return BuiltAt(reader);
            }
            string? newest = Newest();
            if (newest == null)
            {
                return 0;
            }
            using var onDisk = Mmdb.Open(newest);
            return BuiltAt(onDisk);
        }
        catch (Exception)
        {
            return 0;
        }
    }

    private static long BuiltAt(Mmdb reader)
    {
        double built = Js.Number(reader.Metadata.Get("build_epoch")) * 1000;
        return double.IsFinite(built) ? (long)built : 0;
    }

    private async Task FetchAsync(string current, long now, CancellationToken cancellationToken)
    {
        try
        {
            Directory.CreateDirectory(_dir);
        }
        catch (Exception)
        {
            _log("Runlight: could not make the folder for location data, " + _dir);
            return;
        }
        // A new month's file appears a day or so after the month starts; until then, last month's is current.
        DateTime at = DateTimeOffset.FromUnixTimeMilliseconds(now).UtcDateTime;
        string previous = Month(new DateTimeOffset(at.Year, at.Month, 15, 0, 0, 0, TimeSpan.Zero).AddMonths(-1).ToUnixTimeMilliseconds());
        string[] tries = [current, previous];
        // The page says which release there is and what it must hash to, so only that file is asked for. When the
        // page cannot be read, the newest release there is goes unchecked against it, and the log says so.
        (string Release, string Sha1)? published = null;
        string failure = "";
        try
        {
            published = await PublishedAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Refused error)
        {
            failure = error.Message;
        }
        if (published != null && !tries.Contains(published.Value.Release, StringComparer.Ordinal))
        {
            _log("Runlight: location data was not updated: DB-IP offers the " + published.Value.Release + " release, which is neither this month's nor last month's");
            return;
        }
        long inUse = InUseBuilt();
        foreach (string release in published != null ? [published.Value.Release] : tries)
        {
            if (System.IO.File.Exists(File(release)))
            {
                return;
            }
            string url = "https://download.db-ip.com/free/dbip-" + _mode + "-lite-" + release + ".mmdb.gz";
            string partial = File(release) + ".partial." + Js.Str(Environment.ProcessId);
            try
            {
                await SaveAsync(url, partial, published?.Sha1, now, inUse, cancellationToken).ConfigureAwait(false);
                System.IO.File.Move(partial, File(release), true);
                // Older releases go once the new one is in place.
                string prefix = "dbip-" + _mode + "-lite-";
                foreach (string old in Directory.GetFiles(_dir).Where(f => Path.GetFileName(f).StartsWith(prefix, StringComparison.Ordinal)))
                {
                    if (Path.GetFileName(old) != Path.GetFileName(File(release)))
                    {
                        Remove(old);
                    }
                }
                if (published == null)
                {
                    _log("Runlight: warning: location data from DB-IP (" + release + ") could not be checked against DB-IP's published checksum (" + failure + "). It was accepted as a DB-IP database of the right kind, without that check.");
                }
                _log("Runlight: location data from DB-IP (" + release + ") is ready.");
                return;
            }
            catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                Remove(partial);
                // Without the page to say which release there is, this month's not being out yet is no failure.
                if (published == null && error is Refused { Status: 404 })
                {
                    continue;
                }
                // Whatever went wrong, the database in use stays in use.
                _log("Runlight: location data was not updated from " + url + ": " + Reason(error));
            }
            finally
            {
                Remove(partial);
            }
        }
        if (published == null)
        {
            _log("Runlight: location data was not updated: " + failure + ", and no release could be downloaded without them");
        }
    }

    /// <summary>
    /// Downloads one release to <paramref name="partial"/>, unpacked, and throws unless it is fit to use: the
    /// published SHA-1's (when there is one to hold it to), and a DB-IP database of this kind no older than the one in use.
    /// </summary>
    private async Task SaveAsync(string url, string partial, string? sha1, long now, long inUse, CancellationToken cancellationToken)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        limit.CancelAfter(TimeSpan.FromMinutes(10));
        string got;
        using (var answer = await GetAsync(url, limit.Token).ConfigureAwait(false))
        {
            if (answer.ContentLength > MostPackedBytes)
            {
                throw new Refused("the download is more than " + Js.Str(MostPackedBytes / 1024 / 1024) + " MB");
            }
            // SHA-1 is what DB-IP publishes for its files; it is compared with theirs, and used for nothing else.
#pragma warning disable CA5350
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA1);
#pragma warning restore CA5350
            var packed = new Packed(answer.Body, MostPackedBytes);
            uint crc = 0xFFFFFFFF;
            long size = 0;
            var output = System.IO.File.Create(partial);
            await using (output.ConfigureAwait(false))
            {
                var gzip = new GZipStream(packed, CompressionMode.Decompress, leaveOpen: true);
                await using (gzip.ConfigureAwait(false))
                {
                    byte[] buffer = new byte[81920];
                    int n;
                    try
                    {
                        while ((n = await gzip.ReadAsync(buffer, limit.Token).ConfigureAwait(false)) > 0)
                        {
                            size += n;
                            if (size > MostBytes)
                            {
                                throw new Refused("the location data is more than " + Js.Str(MostBytes / 1024 / 1024) + " MB");
                            }
                            hash.AppendData(buffer, 0, n);
                            crc = Crc32(crc, buffer.AsSpan(0, n));
                            await output.WriteAsync(buffer.AsMemory(0, n), limit.Token).ConfigureAwait(false);
                        }
                    }
                    catch (InvalidDataException error)
                    {
                        throw new Refused("it is not a gzip file: " + error.Message);
                    }
                }
            }
            // The unpacker stops at the end of the gzip stream, or of its input, without a word about either. The
            // stream's own last eight bytes give the checksum and length of what it held, so a stream cut short,
            // or one with anything after it, is seen here.
            byte[] rest = new byte[4096];
            while (await packed.ReadAsync(rest, limit.Token).ConfigureAwait(false) > 0)
            {
            }
            byte[] trailer = packed.Last();
            if (trailer.Length < 8
                || BinaryPrimitives.ReadUInt32LittleEndian(trailer) != ~crc
                || BinaryPrimitives.ReadUInt32LittleEndian(trailer.AsSpan(4)) != unchecked((uint)size))
            {
                throw new Refused("the gzip file is cut short or has more after its end (unexpected end of file)");
            }
            got = Convert.ToHexStringLower(hash.GetHashAndReset());
        }
        if (sha1 != null && got != sha1)
        {
            throw new Refused("its SHA-1 is " + got + ", and DB-IP publishes " + sha1);
        }
        CheckDatabase(partial, _mode, now, inUse);
    }

    /// <summary>The packed bytes as they are read: counted against a limit, with the last eight kept.</summary>
    private sealed class Packed(Stream inner, long most) : Stream
    {
        private readonly byte[] _last = new byte[8];
        private long _seen;

        public byte[] Last()
        {
            int kept = (int)Math.Min(_seen, 8);
            byte[] output = new byte[kept];
            for (int i = 0; i < kept; i++)
            {
                output[i] = _last[(_seen - kept + i) % 8];
            }
            return output;
        }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            int n = await inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            Count(buffer.Span[..n]);
            return n;
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            int n = inner.Read(buffer, offset, count);
            Count(buffer.AsSpan(offset, n));
            return n;
        }

        private void Count(ReadOnlySpan<byte> bytes)
        {
            foreach (byte b in bytes)
            {
                _last[_seen % 8] = b;
                _seen++;
            }
            if (_seen > most)
            {
                throw new Refused("the location data is more than " + Js.Str(most / 1024 / 1024) + " MB");
            }
        }

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private static readonly uint[] CrcTable = MakeCrcTable();

    private static uint[] MakeCrcTable()
    {
        var table = new uint[256];
        for (uint i = 0; i < 256; i++)
        {
            uint c = i;
            for (int k = 0; k < 8; k++)
            {
                c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1;
            }
            table[i] = c;
        }
        return table;
    }

    /// <summary>CRC-32 as gzip keeps it, carried from one piece to the next; the value is its complement at the end.</summary>
    private static uint Crc32(uint crc, ReadOnlySpan<byte> bytes)
    {
        foreach (byte b in bytes)
        {
            crc = CrcTable[(crc ^ b) & 0xFF] ^ (crc >> 8);
        }
        return crc;
    }

    /// <summary>
    /// Throws unless the file is a DB-IP database of the kind asked for that a lookup can be made in: of a
    /// believable size, its search tree inside the file, built lately and not before the one in use
    /// (<paramref name="inUse"/>, a time in milliseconds, or 0 for none), and answering for addresses everyone knows.
    /// </summary>
    /// <exception cref="InvalidDataException">Saying what is wrong with it.</exception>
    public static void CheckDatabase(string file, string mode, long now, long inUse = 0)
    {
        try
        {
            Check(file, mode, now, inUse);
        }
        catch (Refused error)
        {
            throw new InvalidDataException(error.Message);
        }
    }

    private static void Check(string file, string mode, long now, long inUse)
    {
        long length = new FileInfo(file).Length;
        if (length < FewestBytes)
        {
            throw new Refused("it unpacks to " + Js.Str(length) + " bytes, too few for a location database");
        }
        // The metadata sits in the file's last 128 KiB, after the last marker.
        long marker = -1;
        using (var stream = System.IO.File.OpenRead(file))
        {
            int tail = (int)Math.Min(length, 131072);
            byte[] bytes = new byte[tail];
            stream.Seek(length - tail, SeekOrigin.Begin);
            stream.ReadExactly(bytes);
            int at = bytes.AsSpan().LastIndexOf(Marker);
            if (at >= 0)
            {
                marker = length - tail + at;
            }
        }
        if (marker < 0)
        {
            throw new Refused("it is not an MMDB file");
        }
        Mmdb reader;
        try
        {
            reader = Mmdb.Open(file);
        }
        catch (Exception error)
        {
            throw new Refused("it does not open as an MMDB file: " + error.Message);
        }
        using (reader)
        {
            var meta = reader.Metadata;
            double N(string key) => Js.Number(meta.Get(key));
            if (N("binary_format_major_version") != 2)
            {
                throw new Refused("its format is version " + Js.String(meta.Get("binary_format_major_version")) + ", not 2");
            }
            string type = meta.Get("database_type") as string ?? "";
            if (type.ToLowerInvariant() != "dbip-" + mode + "-lite")
            {
                throw new Refused("it is a \"" + type + "\" database, not DB-IP's " + mode + " one");
            }
            if (N("ip_version") != 6)
            {
                throw new Refused("it covers IP version " + Js.String(meta.Get("ip_version")) + ", not 6");
            }
            double recordSize = N("record_size");
            if (recordSize is not (24 or 28 or 32))
            {
                throw new Refused("its records are " + Js.String(meta.Get("record_size")) + " bits");
            }
            double nodeCount = N("node_count");
            if (!(nodeCount > 0) || (nodeCount * recordSize / 4) + 16 > marker)
            {
                throw new Refused("its search tree does not fit in the file");
            }
            double built = N("build_epoch") * 1000;
            if (!(built <= now + (2 * Day)) || built < now - OldestBuild)
            {
                throw new Refused("it was built on " + (double.IsFinite(built) && Math.Abs(built) < 8.64e15 ? Js.IsoString((long)built)[..10] : "no date"));
            }
            if (built < inUse)
            {
                throw new Refused("it is older than the database in use");
            }
            foreach (string ip in Known)
            {
                object? found = null;
                try
                {
                    found = reader.Get(ip);
                }
                catch (Exception)
                {
                }
                string code = ((found as JsObject)?.Get("country") as JsObject)?.Get("iso_code") as string ?? "";
                if (!(code.Length == 2 && char.IsAsciiLetterUpper(code[0]) && char.IsAsciiLetterUpper(code[1])))
                {
                    throw new Refused("it has no country for " + ip);
                }
            }
        }
    }

    private static void Remove(string file)
    {
        try
        {
            System.IO.File.Delete(file);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static readonly HttpClient Client = new(new SocketsHttpHandler { AllowAutoRedirect = false, ConnectTimeout = TimeSpan.FromSeconds(15) }) { Timeout = Timeout.InfiniteTimeSpan };

    /// <summary>
    /// One GET over https, straight to disk as it is read, since a city database is too big to hold in memory. This
    /// is the one download that does not go through a fetcher, which keeps whole answers in memory. No redirect is
    /// followed: a 3xx comes back as it is, and is refused like any answer but a 200.
    /// </summary>
    private static async Task<DbIpAnswer> DownloadAsync(string url, CancellationToken cancellationToken)
    {
        var uri = new Uri(url);
        if (uri.Scheme != "https")
        {
            throw new HttpRequestException("not https: " + uri);
        }
        var answer = await Client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken).ConfigureAwait(false);
        try
        {
            return new DbIpAnswer((int)answer.StatusCode, await answer.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false), answer.Content.Headers.ContentLength, answer);
        }
        catch
        {
            answer.Dispose();
            throw;
        }
    }
}

/// <summary>What one GET for location data answered: its status, its body as it arrives, and the length it declared, when it declared one.</summary>
public sealed class DbIpAnswer : IDisposable
{
    private readonly IDisposable? _owner;

    /// <param name="status">The HTTP status.</param>
    /// <param name="body">The body, read as it arrives.</param>
    /// <param name="contentLength">The Content-Length the answer declared, or null.</param>
    /// <param name="owner">What to dispose with the answer, such as the response the body belongs to.</param>
    public DbIpAnswer(int status, Stream body, long? contentLength = null, IDisposable? owner = null)
    {
        Status = status;
        Body = body;
        ContentLength = contentLength;
        _owner = owner;
    }

    public int Status { get; }

    public Stream Body { get; }

    public long? ContentLength { get; }

    public void Dispose()
    {
        Body.Dispose();
        _owner?.Dispose();
    }
}

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Runlight.Http;

namespace Runlight;

/// <summary>What <see cref="Safefetch.PublicFetchAsync"/> takes besides the URL.</summary>
public sealed class PublicFetchInit
{
    /// <summary>The time every hop together may take.</summary>
    public int TimeoutMs { get; set; }

    public string Method { get; set; } = "GET";

    public Headers Headers { get; set; } = new();

    public byte[]? Body { get; set; }

    /// <summary>The body as text, written as UTF-8.</summary>
    public string? BodyText
    {
        get => Body == null ? null : Js.Decode(Body);
        set => Body = value == null ? null : Js.Utf8(value);
    }

    /// <summary>How many redirects to follow, for a GET; a redirect past the last comes back as it is.</summary>
    public int Redirects { get; set; }

    /// <summary>Passed to the fetcher, for a capped read.</summary>
    public long? MaxBytes { get; set; }

    /// <summary>Passed to the fetcher, with MaxBytes, to hand back the start of a long body.</summary>
    public bool Truncate { get; set; }

    /// <summary>Stands in for DNS: every address a name resolves to. The fetcher's own when null.</summary>
    public Func<string, Task<IReadOnlyList<string>>>? Lookup { get; set; }
}

/// <summary>
/// Fetches from addresses that other people's input names, such as the icon links on a site's
/// home page or a link domain, and only from the public internet. Only https is fetched, never a
/// private, loopback, link-local, or metadata address, and redirects are followed by hand under
/// the same rules. The name is resolved and every address it gives is checked before each hop,
/// and the request is pinned to the checked addresses (the fetcher's Resolve), so a name that
/// answers differently a moment later gets nowhere.
/// </summary>
public static partial class Safefetch
{
    private static readonly Regex Brackets = new("^\\[|\\]\\z", RegexOptions.CultureInvariant);
    private static readonly Regex TrailingV4 = new("([0-9]{1,3}(?:\\.[0-9]{1,3}){3})\\z", RegexOptions.CultureInvariant);
    private static readonly Regex Octet = new("^[0-9]{1,3}\\z", RegexOptions.CultureInvariant);
    private static readonly Regex Group = new("^[0-9a-f]{1,4}\\z", RegexOptions.CultureInvariant);

    private static int[]? V4(string text)
    {
        string[] parts = text.Split('.');
        if (parts.Length != 4)
        {
            return null;
        }
        foreach (string p in parts)
        {
            if (!Octet.IsMatch(p) || int.Parse(p, CultureInfo.InvariantCulture) > 255)
            {
                return null;
            }
        }
        return parts.Select(p => int.Parse(p, CultureInfo.InvariantCulture)).ToArray();
    }

    private static bool PublicV4(int[] four)
    {
        int a = four[0], b = four[1], c = four[2];
        if (a == 0 || a == 10 || a == 127 || a >= 224)
        {
            return false;
        }
        if (a == 100 && b >= 64 && b < 128)
        {
            return false;
        }
        if (a == 169 && b == 254)
        {
            return false;
        }
        if (a == 172 && b >= 16 && b < 32)
        {
            return false;
        }
        if (a == 192 && b == 168)
        {
            return false;
        }
        if (a == 192 && b == 0 && (c == 0 || c == 2))
        {
            return false;
        }
        if (a == 198 && (b == 18 || b == 19))
        {
            return false;
        }
        if (a == 198 && b == 51 && c == 100)
        {
            return false;
        }
        if (a == 203 && b == 0 && c == 113)
        {
            return false;
        }
        return true;
    }

    /// <summary>An IPv6 address as eight 16-bit groups, or null when it is not one.</summary>
    private static int[]? V6(string text)
    {
        string address = Brackets.Replace(text, "").Split('%')[0].ToLowerInvariant();
        // A trailing IPv4 address becomes the last two groups.
        var tail = TrailingV4.Match(address);
        if (tail.Success)
        {
            int[]? four = V4(tail.Groups[1].Value);
            if (four == null)
            {
                return null;
            }
            address = address[..^tail.Groups[1].Value.Length]
                + ((four[0] << 8) | four[1]).ToString("x", CultureInfo.InvariantCulture) + ":"
                + ((four[2] << 8) | four[3]).ToString("x", CultureInfo.InvariantCulture);
        }
        string[] halves = address.Split("::");
        if (halves.Length > 2)
        {
            return null;
        }
        string[] head = halves[0].Length > 0 ? halves[0].Split(':') : [];
        string[] rest = halves.Length == 2 && halves[1].Length > 0 ? halves[1].Split(':') : [];
        int missing = 8 - head.Length - rest.Length;
        if (halves.Length == 1 ? missing != 0 : missing < 1)
        {
            return null;
        }
        var groups = new List<string>(head);
        groups.AddRange(Enumerable.Repeat("0", halves.Length == 2 ? missing : 0));
        groups.AddRange(rest);
        foreach (string g in groups)
        {
            if (!Group.IsMatch(g))
            {
                return null;
            }
        }
        return groups.Select(g => int.Parse(g, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture)).ToArray();
    }

    /// <summary>Whether an IP address, v4 or v6, is on the public internet. Anything that is not an address is not.</summary>
    public static bool PublicAddress(string ip)
    {
        ArgumentNullException.ThrowIfNull(ip);
        int[]? four = V4(ip);
        if (four != null)
        {
            return PublicV4(four);
        }
        int[]? g = V6(ip);
        if (g == null)
        {
            return false;
        }
        static int[] Embedded(int hi, int lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
        // IPv4 inside IPv6: mapped (::ffff:0:0/96), the old compatible form (::/96), translated (::ffff:0:0:0/96),
        // and NAT64 (64:ff9b::/96).
        int[]? inside = EmbeddedV4(g);
        if (inside != null)
        {
            return g[5] == 0 && g[4] == 0 && g[6] == 0 && g[7] <= 1 ? false : PublicV4(inside);
        }
        // 6to4 carries an IPv4 address in its second and third groups.
        if (g[0] == 0x2002)
        {
            return PublicV4(Embedded(g[1], g[2]));
        }
        // Only global unicast (2000::/3) is public, which leaves out unique local, link-local, the old site-local,
        // multicast, discard, and local-use NAT64 (64:ff9b:1::/48), which may carry any address.
        if ((g[0] & 0xe000) != 0x2000)
        {
            return false;
        }
        // The protocol assignments (2001::/23, with Teredo and ORCHID) and the documentation prefixes.
        if (g[0] == 0x2001 && (g[1] < 0x200 || g[1] == 0xdb8))
        {
            return false;
        }
        if ((g[0] & 0xfff0) == 0x3ff0)
        {
            return false;
        }
        return true;
    }

    /// <summary>The IPv4 address inside a mapped, compatible, translated, or NAT64 IPv6 address, or null.</summary>
    private static int[]? EmbeddedV4(int[] g)
    {
        static bool Zero(IEnumerable<int> groups) => groups.All(x => x == 0);
        bool inside =
            (Zero(g.Take(5)) && (g[5] == 0xffff || g[5] == 0))
            || (Zero(g.Take(4)) && g[4] == 0xffff && g[5] == 0)
            || (g[0] == 0x64 && g[1] == 0xff9b && Zero(g.Skip(2).Take(4)));
        return inside ? [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255] : null;
    }

    /// <summary>Names clouds give their metadata services.</summary>
    private static readonly HashSet<string> MetadataNames = new(StringComparer.Ordinal) { "metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal" };

    private static readonly Regex TrailingDots = new("\\.+\\z", RegexOptions.CultureInvariant);

    /// <summary>
    /// Whether an address is link-local (169.254.0.0/16, fe80::/10) or a cloud's metadata service (fd00:ec2::254,
    /// Alibaba's 100.100.100.200), in any of its IPv6 spellings. A model's API or a mail server is never there,
    /// though it may well be on this computer or a private network, so those stay allowed where this is checked.
    /// </summary>
    public static bool MetadataAddress(string ip)
    {
        ArgumentNullException.ThrowIfNull(ip);
        int[]? four = V4(ip);
        int[]? g = four == null ? V6(ip) : null;
        static bool Zero(IEnumerable<int> groups) => groups.All(x => x == 0);
        // IPv4 inside IPv6, mapped, compatible, translated, or NAT64, is read as IPv4.
        int[]? inner = four ?? (g != null ? EmbeddedV4(g) : null);
        if (inner != null)
        {
            return (inner[0] == 169 && inner[1] == 254) || (inner[0] == 100 && inner[1] == 100 && inner[2] == 100 && inner[3] == 200);
        }
        if (g == null)
        {
            return false;
        }
        if ((g[0] & 0xffc0) == 0xfe80)
        {
            return true;
        }
        return g[0] == 0xfd00 && g[1] == 0xec2 && Zero(g.Skip(2).Take(5)) && g[7] == 0x254;
    }

    /// <summary>
    /// Whether a host, by its name, its address, or any address its name resolves to now, is link-local or a
    /// metadata service. A name that does not resolve here is let through, since the connection then goes
    /// nowhere such a check could have stopped.
    /// </summary>
    /// <param name="host">The host, a name or an address (an IPv6 one in brackets or not).</param>
    /// <param name="lookup">Stands in for DNS in tests.</param>
    public static async Task<bool> MetadataHostAsync(string host, Func<string, Task<IReadOnlyList<string>>>? lookup = null)
    {
        ArgumentNullException.ThrowIfNull(host);
        string name = TrailingDots.Replace(Brackets.Replace(Js.Lower(Js.Trim(host)), ""), "");
        if (MetadataNames.Contains(name) || MetadataAddress(name))
        {
            return true;
        }
        if (V4(name) != null || V6(name) != null)
        {
            return false;
        }
        try
        {
            return (await (lookup ?? LookupAsync)(name).ConfigureAwait(false)).Any(MetadataAddress);
        }
#pragma warning disable CA1031 // A name that does not resolve is let through, as the TypeScript's catch.
        catch (Exception)
#pragma warning restore CA1031
        {
            return false;
        }
    }

    /// <summary>
    /// Every address a name resolves to, v4 and v6, as getaddrinfo() would give them (the hosts
    /// file included). Empty when it does not resolve.
    /// </summary>
    public static async Task<IReadOnlyList<string>> LookupAsync(string name)
    {
        ArgumentNullException.ThrowIfNull(name);
        string bare = Brackets.Replace(name, "");
        if (V4(bare) != null || V6(bare) != null)
        {
            return [bare];
        }
        try
        {
            var found = await Dns.GetHostAddressesAsync(bare).ConfigureAwait(false);
            return found.Select(a => a.IsIPv4MappedToIPv6 ? a.MapToIPv4().ToString() : a.ToString()).Distinct(StringComparer.Ordinal).ToList();
        }
        catch (Exception e) when (e is SocketException or ArgumentException)
        {
            return [];
        }
    }

    /// <summary>The public addresses a name resolves to, for setting up DNS records. None where it does not resolve.</summary>
    /// <param name="name">The name.</param>
    /// <param name="lookup">Stands in for DNS in tests.</param>
    public static async Task<IReadOnlyList<string>> PublicAddressesAsync(string name, Func<string, Task<IReadOnlyList<string>>>? lookup = null)
    {
        IReadOnlyList<string> addresses;
        try
        {
            addresses = await (lookup ?? LookupAsync)(name).ConfigureAwait(false);
        }
#pragma warning disable CA1031 // Any failure to resolve means no addresses, as the TypeScript's catch.
        catch (Exception)
#pragma warning restore CA1031
        {
            return [];
        }
        return addresses.Where(PublicAddress).Distinct(StringComparer.Ordinal).ToList();
    }

    /// <summary>Whether a name resolves to an address off the public internet. False when it does not resolve.</summary>
    /// <param name="name">The name.</param>
    /// <param name="lookup">Stands in for DNS in tests.</param>
    public static async Task<bool> ResolvesPrivatelyAsync(string name, Func<string, Task<IReadOnlyList<string>>>? lookup = null)
    {
        IReadOnlyList<string> addresses;
        try
        {
            addresses = await (lookup ?? LookupAsync)(name).ConfigureAwait(false);
        }
#pragma warning disable CA1031 // Any failure to resolve means it does not resolve privately, as the TypeScript's catch.
        catch (Exception)
#pragma warning restore CA1031
        {
            return false;
        }
        return addresses.Any(a => !PublicAddress(a));
    }

    /// <summary>
    /// Fetches an https URL on the public internet, following up to Redirects redirects that stay on
    /// it, within TimeoutMs in all. Only a GET follows redirects; anything else comes back with the
    /// redirect as it is. Throws a <see cref="PrivateAddressError"/> for an address off
    /// it, and a <see cref="FetchException"/> with TimedOut when time runs out. A redirect past the
    /// last one comes back as it is. MaxBytes and Truncate go to the fetcher, for a capped read.
    /// </summary>
    public static async Task<Response> PublicFetchAsync(string target, PublicFetchInit init, IFetcher fetcher, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(init);
        ArgumentNullException.ThrowIfNull(fetcher);
        var lookup = init.Lookup ?? fetcher.LookupAsync;
        string method = init.Method.ToUpperInvariant();
        // Only a GET follows redirects; anything else comes back with the redirect as it is.
        int redirects = method == "GET" ? init.Redirects : 0;
        var clock = Stopwatch.StartNew();
        var url = new Url(target);
        for (int hop = 0; ; hop++)
        {
            if (url.Protocol != "https:")
            {
                throw new PrivateAddressError(url.Href);
            }
            string host = Brackets.Replace(url.Hostname, "").ToLowerInvariant();
            bool literal = V4(host) != null || V6(host) != null;
            if (literal && !PublicAddress(host))
            {
                throw new PrivateAddressError(host);
            }
            if (host == "localhost" || host.EndsWith(".localhost", StringComparison.Ordinal))
            {
                throw new PrivateAddressError(host);
            }
            var pin = new List<string>();
            if (!literal)
            {
                // The address checked is the address used: every one the name gives must be public, and the
                // connection is pinned to them, so a second lookup cannot hand back another.
                var addresses = await lookup(host).ConfigureAwait(false);
                if (addresses.Count == 0)
                {
                    throw new FetchException("getaddrinfo ENOTFOUND " + host);
                }
                foreach (string address in addresses)
                {
                    if (!PublicAddress(address))
                    {
                        throw new PrivateAddressError(host);
                    }
                }
                string port = url.Port.Length > 0 ? url.Port : "443";
                pin.Add(host + ":" + port + ":" + string.Join(',', addresses.Select(a => a.Contains(':', StringComparison.Ordinal) ? "[" + a + "]" : a)));
            }
            long left = init.TimeoutMs - clock.ElapsedMilliseconds;
            if (left <= 0)
            {
                throw TimedOut();
            }
            var options = new FetchInit
            {
                Method = method,
                Headers = new Headers(init.Headers),
                Body = init.Body,
                Redirect = "manual",
                TimeoutMs = (int)left,
                MaxBytes = init.MaxBytes,
                Truncate = init.Truncate,
                Resolve = pin,
                Public = true,
            };
            Response answer;
            try
            {
                answer = await fetcher.FetchAsync(url.Href, options, cancellationToken).ConfigureAwait(false);
            }
            catch (FetchException error)
            {
                // Whichever way the request gave up, the caller hears that time ran out.
                if (error.TimedOut || clock.ElapsedMilliseconds >= init.TimeoutMs)
                {
                    throw TimedOut();
                }
                throw;
            }
            string? location = answer.Headers.Get("location");
            if (answer.Status < 300 || answer.Status >= 400 || string.IsNullOrEmpty(location) || hop >= redirects)
            {
                return answer;
            }
            url = new Url(location, url.Href);
        }
    }

    /// <summary>Headers that describe a body, dropped with it when a redirect turns a request into a GET.</summary>
    private static readonly string[] BodyHeaders = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];

    /// <summary>
    /// Fetches from a service someone set up, such as an AI model's API or a mail webhook, which may well be on
    /// this computer or a private network, but is never at a link-local or cloud metadata address. Each hop looks
    /// the name up, refuses it if any address it gives is link-local or a metadata service, and connects to those
    /// addresses (the fetcher's Resolve), so the address checked is the address used and no proxy is in between.
    /// A name that does not resolve is refused. Redirects are followed, up to <paramref name="redirects"/> of them,
    /// each as fetch follows it: a 303, or a 301 or 302 answering a POST, goes on as a GET with no body. Only a
    /// redirect on the same origin is followed: the request carries a key, in whatever header the service names
    /// it, and a 307 or 308 would carry its body too, an email or a conversation, so a redirect to another origin,
    /// https to http among them, is refused before anything is sent there. A redirect past the last one comes back
    /// as it is. TimeoutMs is the limit for every hop together.
    /// </summary>
    /// <param name="target">The address.</param>
    /// <param name="init">The request; its Redirect is ignored, since redirects are followed here.</param>
    /// <param name="fetcher">What sends each request, and looks up each name.</param>
    /// <param name="redirects">How many redirects are followed.</param>
    /// <param name="cancellationToken">Stops the request.</param>
    /// <exception cref="MetadataAddressError">For an address it refuses.</exception>
    /// <exception cref="RedirectRefusedError">For a redirect to another origin.</exception>
    public static async Task<Response> ServiceFetchAsync(string target, FetchInit init, IFetcher fetcher, int redirects = 5, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(init);
        ArgumentNullException.ThrowIfNull(fetcher);
        var clock = Stopwatch.StartNew();
        var url = new Url(target);
        string method = init.Method.ToUpperInvariant();
        var headers = new Headers(init.Headers);
        byte[]? body = init.Body;
        for (int hop = 0; ; hop++)
        {
            string host = Brackets.Replace(url.Hostname, "");
            var pin = new List<string>();
            string name = TrailingDots.Replace(Js.Lower(host), "");
            if (MetadataNames.Contains(name) || MetadataAddress(name))
            {
                throw new MetadataAddressError(host);
            }
            if (V4(name) == null && V6(name) == null)
            {
                IReadOnlyList<string> addresses;
                try
                {
                    addresses = await fetcher.LookupAsync(name).ConfigureAwait(false);
                }
#pragma warning disable CA1031 // A lookup that fails is a name that does not resolve.
                catch (Exception)
#pragma warning restore CA1031
                {
                    addresses = [];
                }
                if (addresses.Count == 0)
                {
                    throw new FetchException("Could not look up " + host);
                }
                if (addresses.Any(MetadataAddress))
                {
                    throw new MetadataAddressError(host);
                }
                string port = url.Port.Length > 0 ? url.Port : url.Protocol == "http:" ? "80" : "443";
                pin.Add(Js.Lower(host) + ":" + port + ":" + string.Join(',', addresses.Select(a => a.Contains(':', StringComparison.Ordinal) ? "[" + a + "]" : a)));
            }
            long left = init.TimeoutMs - clock.ElapsedMilliseconds;
            if (left <= 0)
            {
                throw TimedOut();
            }
            var answer = await fetcher.FetchAsync(url.Href, new FetchInit
            {
                Method = method,
                Headers = new Headers(headers),
                Body = body,
                Redirect = "manual",
                TimeoutMs = (int)left,
                MaxBytes = init.MaxBytes,
                Truncate = init.Truncate,
                Resolve = pin,
            }, cancellationToken).ConfigureAwait(false);
            string? location = answer.Headers.Get("location");
            if (answer.Status < 300 || answer.Status >= 400 || string.IsNullOrEmpty(location) || hop >= redirects)
            {
                return answer;
            }
            var next = new Url(location, url.Href);
            if (next.Origin != url.Origin)
            {
                string there = TrailingDots.Replace(Js.Lower(Brackets.Replace(next.Hostname, "")), "");
                if (await MetadataHostAsync(there, fetcher.LookupAsync).ConfigureAwait(false))
                {
                    throw new MetadataAddressError(there);
                }
                throw new RedirectRefusedError(url.Host, next.Protocol is "https:" or "http:" ? next.Origin : next.Protocol);
            }
            if (answer.Status == 303 || ((answer.Status == 301 || answer.Status == 302) && method == "POST"))
            {
                method = method == "HEAD" ? "HEAD" : "GET";
                body = null;
                foreach (string header in BodyHeaders)
                {
                    headers.Delete(header);
                }
            }
            url = next;
        }
    }

    /// <summary>
    /// Whether an address can be another Runlight install's: https, or, with
    /// <paramref name="local"/>, an install on this machine, which only code can allow.
    /// </summary>
    /// <param name="url">The address.</param>
    /// <param name="local">Whether an install may be at http://localhost or http://127.0.0.1.</param>
    public static bool InstallAddress(string url, bool local) =>
        HttpsAddress().IsMatch(url ?? "") || (local && LocalInstall().IsMatch(url ?? ""));

    /// <summary>
    /// Fetches from another Runlight install, which someone signed in named: a public address as
    /// <see cref="PublicFetchAsync"/> fetches it, with no redirect followed, so a token sent there
    /// goes nowhere else. With <paramref name="local"/>, an install on this machine is fetched as it
    /// is, still without following a redirect.
    /// </summary>
    /// <param name="target">The address.</param>
    /// <param name="init">As <see cref="PublicFetchAsync"/> takes it; its Redirects are set to none.</param>
    /// <param name="local">Whether an install may be at http://localhost or http://127.0.0.1.</param>
    /// <param name="fetcher">What sends the request.</param>
    /// <param name="cancellationToken">Stops the request.</param>
    /// <exception cref="PrivateAddressError">For an address off the public internet.</exception>
    public static Task<Response> InstallFetchAsync(string target, PublicFetchInit init, bool local, IFetcher fetcher, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(target);
        ArgumentNullException.ThrowIfNull(init);
        ArgumentNullException.ThrowIfNull(fetcher);
        if (local && LocalInstall().IsMatch(target))
        {
            return fetcher.FetchAsync(target, new FetchInit
            {
                Method = init.Method.ToUpperInvariant(),
                Headers = new Headers(init.Headers),
                Body = init.Body,
                Redirect = "manual",
                TimeoutMs = init.TimeoutMs,
                MaxBytes = init.MaxBytes,
            }, cancellationToken);
        }
        init.Redirects = 0;
        return PublicFetchAsync(target, init, fetcher, cancellationToken);
    }

    /// <summary>An install on this machine: http://localhost or http://127.0.0.1, with any port.</summary>
    [GeneratedRegex("^http://(localhost|127\\.0\\.0\\.1)(:[0-9]+)?(/|\\z)", RegexOptions.CultureInvariant)]
    private static partial Regex LocalInstall();

    [GeneratedRegex("^https://[^/]+", RegexOptions.CultureInvariant)]
    private static partial Regex HttpsAddress();

    private static FetchException TimedOut() => new("The operation was aborted due to timeout", true);
}

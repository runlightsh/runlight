using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Runlight.Http;

namespace Runlight;

/// <summary>
/// Checks a request that names an AI agent against the addresses that agent's company publishes. Every
/// list is in the same shape, {"prefixes": [{"ipv4Prefix": "a.b.c.d/n"} or {"ipv6Prefix": "x::/n"}]}.
///
/// The answer is "verified" when the address is in the list, "mismatch" when the company publishes a list
/// and the address is not in it, and "" when there is nothing to check against: no list for that agent,
/// or no usable address. The address is only compared, never kept. The port of agentcheck.ts.
/// </summary>
public static class AgentCheck
{
    /// <summary>A list of more prefixes than this, or a reply bigger than MaxListBytes, is not a list we read.</summary>
    public const int MaxPrefixes = 20_000;

    public const int MaxListBytes = 4_000_000;

    private static readonly ConditionalWeakTable<IReadOnlyList<string>, Prefix[]> Compiled = [];

    /// <summary>
    /// The lists that came with this version, from Assets/agent-ranges.json, which scripts/dotnet-assets.mts
    /// writes from the SDK's snapshot: list URL to prefixes, in the snapshot's order.
    /// </summary>
    public static IReadOnlyDictionary<string, IReadOnlyList<string>> Bundled => Snapshot.Lists;

    /// <summary>The day the bundled lists were downloaded, YYYY-MM-DD.</summary>
    public static string BundledFetchedAt => Snapshot.FetchedAt;

    /// <summary>The bundled lists' URLs, in the snapshot's order, which is the order they are downloaded in.</summary>
    public static IReadOnlyList<string> BundledUrls => Snapshot.Urls;

    private static (IReadOnlyDictionary<string, IReadOnlyList<string>> Lists, IReadOnlyList<string> Urls, string FetchedAt)? _snapshot;

    private static (IReadOnlyDictionary<string, IReadOnlyList<string>> Lists, IReadOnlyList<string> Urls, string FetchedAt) Snapshot => _snapshot ??= ReadBundled();

    private static (IReadOnlyDictionary<string, IReadOnlyList<string>> Lists, IReadOnlyList<string> Urls, string FetchedAt) ReadBundled()
    {
        var data = (JsObject)Json.Parse(Assets.Text("agent-ranges.json"))!;
        var lists = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        var urls = new List<string>();
        foreach (var (url, list) in data.Obj("lists")!)
        {
            lists[url] = ((List<object?>)list!).Select(p => (string)p!).ToList();
            urls.Add(url);
        }
        return (lists, urls, data.Str("fetchedAt") ?? "");
    }

    private static bool Digits(string text, int max)
    {
        if (text.Length == 0 || text.Length > max)
        {
            return false;
        }
        foreach (char c in text)
        {
            if (c is < '0' or > '9')
            {
                return false;
            }
        }
        return true;
    }

    private static uint? Ipv4(string text)
    {
        string[] parts = text.Split('.');
        if (parts.Length != 4)
        {
            return null;
        }
        uint n = 0;
        foreach (string part in parts)
        {
            if (!Digits(part, 3))
            {
                return null;
            }
            uint b = uint.Parse(part, System.Globalization.CultureInfo.InvariantCulture);
            if (b > 255)
            {
                return null;
            }
            n = (n * 256) + b;
        }
        return n;
    }

    private static bool Hex(char c) => c is (>= '0' and <= '9') or (>= 'a' and <= 'f') or (>= 'A' and <= 'F');

    private static UInt128? Ipv6(string text)
    {
        if (text.Length == 0 || !text.All(c => Hex(c) || c is ':' or '.') || text.Split("::").Length > 2)
        {
            return null;
        }
        // A dotted IPv4 tail ("::ffff:1.2.3.4") stands for the last two groups.
        string groups = text;
        int dot = text.LastIndexOf(':');
        if (text.Contains('.', StringComparison.Ordinal))
        {
            uint? tail = Ipv4(text[(dot + 1)..]);
            if (tail == null)
            {
                return null;
            }
            groups = text[..(dot + 1)] + (tail.Value >> 16).ToString("x", System.Globalization.CultureInfo.InvariantCulture) + ":" + (tail.Value & 0xffff).ToString("x", System.Globalization.CultureInfo.InvariantCulture);
        }
        string[] halves = groups.Split("::");
        string head = halves[0];
        string? rest = halves.Length > 1 ? halves[1] : null;
        string[] left = head.Length > 0 ? head.Split(':') : [];
        string[] right = rest == null ? [] : rest.Length > 0 ? rest.Split(':') : [];
        int missing = 8 - left.Length - right.Length;
        if (rest == null ? missing != 0 : missing < 1)
        {
            return null;
        }
        var all = left.Concat(Enumerable.Repeat("0", rest == null ? 0 : missing)).Concat(right);
        UInt128 n = UInt128.Zero;
        foreach (string group in all)
        {
            if (group.Length is < 1 or > 4 || !group.All(Hex))
            {
                return null;
            }
            n = (n << 16) | ushort.Parse(group, System.Globalization.NumberStyles.HexNumber, System.Globalization.CultureInfo.InvariantCulture);
        }
        return n;
    }

    /// <summary>An address as the check reads it: its family (4 or 6) and its value.</summary>
    public readonly record struct Address(int Version, UInt128 Value);

    /// <summary>
    /// An address as the check reads it: surrounding space, [brackets], and an IPv6 zone ("%eth0") are
    /// ignored, and an IPv4 address written as IPv6 (::ffff:1.2.3.4) is read as IPv4. Null when it is not one.
    /// </summary>
    public static Address? ParseAddress(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        string s = Js.Trim(text);
        if (s.StartsWith('[') && s.EndsWith(']'))
        {
            s = s[1..^1];
        }
        int zone = s.IndexOf('%', StringComparison.Ordinal);
        if (zone != -1)
        {
            s = s[..zone];
        }
        if (s.Length == 0)
        {
            return null;
        }
        if (!s.Contains(':', StringComparison.Ordinal))
        {
            uint? v4 = Ipv4(s);
            return v4 == null ? null : new Address(4, v4.Value);
        }
        UInt128? n = Ipv6(s);
        if (n == null)
        {
            return null;
        }
        if (n.Value >> 32 == (UInt128)0xffffu)
        {
            return new Address(4, n.Value & (UInt128)0xffffffffu);
        }
        return new Address(6, n.Value);
    }

    private sealed record Prefix(int Version, UInt128 Base, int Bits);

    /// <summary>A prefix such as 20.171.206.0/24 or 2600:1f28::/56, or null. Bits past the length are ignored.</summary>
    private static Prefix? ParsePrefix(string text)
    {
        int slash = text.IndexOf('/', StringComparison.Ordinal);
        if (slash == -1)
        {
            return null;
        }
        string bitsText = text[(slash + 1)..];
        if (!Digits(bitsText, 3))
        {
            return null;
        }
        int bits = int.Parse(bitsText, System.Globalization.CultureInfo.InvariantCulture);
        string head = text[..slash];
        if (head.Contains(':', StringComparison.Ordinal))
        {
            UInt128? v6 = Ipv6(head);
            return v6 == null || bits > 128 ? null : new Prefix(6, v6.Value, bits);
        }
        uint? v4 = Ipv4(head);
        return v4 == null || bits > 32 ? null : new Prefix(4, v4.Value, bits);
    }

    private static bool Covers(Prefix prefix, Address address)
    {
        if (prefix.Version != address.Version)
        {
            return false;
        }
        int shift = (prefix.Version == 4 ? 32 : 128) - prefix.Bits;
        // UInt128 shifts count modulo 128, so a /0 is written out: it covers every address of its family.
        return shift >= 128 || address.Value >> shift == prefix.Base >> shift;
    }

    /// <summary>
    /// The prefixes in a published list, or null when the reply is not a list in the expected shape (not an
    /// object, no prefixes, an entry that is not a prefix, or too many). One bad entry rejects the whole list,
    /// so a half broken download never replaces a good copy.
    /// </summary>
    /// <param name="body">The list as <see cref="Json.Parse"/> reads it.</param>
    public static List<string>? ReadRangeList(object? body)
    {
        if (body is not JsObject o || o.Get("prefixes") is not List<object?> prefixes || prefixes.Count == 0 || prefixes.Count > MaxPrefixes)
        {
            return null;
        }
        var output = new List<string>(prefixes.Count);
        foreach (object? entry in prefixes)
        {
            if (entry is not JsObject e)
            {
                return null;
            }
            object? ipv4Prefix = e.Get("ipv4Prefix");
            object? ipv6Prefix = e.Get("ipv6Prefix");
            string? text = ipv4Prefix as string ?? ipv6Prefix as string;
            if (text == null)
            {
                return null;
            }
            string trimmed = Js.Trim(text);
            var prefix = ParsePrefix(trimmed);
            if (prefix == null || (ipv4Prefix is string) != (prefix.Version == 4))
            {
                return null;
            }
            output.Add(trimmed);
        }
        return output;
    }

    /// <summary>A list of prefix strings, as the database keeps them, in the published shape for <see cref="ReadRangeList"/>.</summary>
    internal static JsObject AsPublished(IEnumerable<object?>? list) => new()
    {
        ["prefixes"] = list?.Select(p =>
        {
            string text = Js.String(p);
            return (object?)(text.Contains(':', StringComparison.Ordinal) ? new JsObject { ["ipv6Prefix"] = p } : new JsObject { ["ipv4Prefix"] = p });
        }).ToList(),
    };

    /// <summary>Downloads one published list. Null when it cannot be fetched or read; the caller keeps what it had.</summary>
    /// <param name="url">The list's address.</param>
    /// <param name="fetcher">What sends the request.</param>
    /// <param name="timeoutMs">The limit for the whole request.</param>
    /// <param name="cancellationToken">Stops the request.</param>
    public static async Task<List<string>?> DownloadRangeListAsync(string url, IFetcher fetcher, int timeoutMs = 15_000, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(fetcher);
        try
        {
            var response = await fetcher.FetchAsync(url, new FetchInit
            {
                Headers = new Headers { ["accept"] = "application/json", ["user-agent"] = "Runlight (+https://runlight.sh)" },
                Redirect = "follow",
                TimeoutMs = timeoutMs,
                MaxBytes = MaxListBytes,
            }, cancellationToken).ConfigureAwait(false);
            if (!response.Ok)
            {
                return null;
            }
            double length = Js.Number(response.Headers.Get("content-length") ?? "0");
            if (length > MaxListBytes)
            {
                return null;
            }
            string text = await response.TextAsync(cancellationToken).ConfigureAwait(false);
            if (text.Length > MaxListBytes)
            {
                return null;
            }
            return ReadRangeList(Json.Parse(text));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
#pragma warning disable CA1031 // Any failure means no fresh list, as the TypeScript's catch.
        catch (Exception)
#pragma warning restore CA1031
        {
            return null;
        }
    }

    private static Prefix[] PrefixesOf(IReadOnlyList<string> list) =>
        Compiled.GetValue(list, static l => [.. l.Select(ParsePrefix).Where(p => p != null).Cast<Prefix>()]);

    /// <summary>Whether <paramref name="ip"/> is inside any of the prefixes. False for an address that cannot be read.</summary>
    public static bool InRanges(string ip, IReadOnlyList<string> list)
    {
        ArgumentNullException.ThrowIfNull(list);
        var address = ParseAddress(ip);
        return address != null && PrefixesOf(list).Any(p => Covers(p, address.Value));
    }

    /// <summary>The check for one request that names <paramref name="agent"/>, made from <paramref name="ip"/>: "verified", "mismatch", or "".</summary>
    /// <param name="agent">An entry of <see cref="Data.Lists.AiAgents"/>.</param>
    /// <param name="ip">The address the request came from.</param>
    /// <param name="lists">List URL to prefixes.</param>
    public static string Check(JsObject agent, string ip, IReadOnlyDictionary<string, IReadOnlyList<string>> lists)
    {
        ArgumentNullException.ThrowIfNull(agent);
        ArgumentNullException.ThrowIfNull(lists);
        IReadOnlyList<string>? list = agent.Str("ranges") is { Length: > 0 } ranges && lists.TryGetValue(ranges, out var found) ? found : null;
        if (list == null || ParseAddress(ip ?? "") == null)
        {
            return "";
        }
        return InRanges(ip!, list) ? "verified" : "mismatch";
    }
}

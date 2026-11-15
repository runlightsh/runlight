using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Runlight.Store;

namespace Runlight.Accounts;

/// <summary>
/// Counts wrong second-factor codes under a key and locks it for longer each time the tries run out: five
/// tries, then fifteen minutes, then thirty, then an hour, doubling up to a day. A right code clears the
/// key, and so does a week with no lock and no try. A lock always ends, at most a day later, so nobody is
/// shut out for good.
/// </summary>
/// <remarks>
/// TypeScript keeps the counts in its process. Here, as <see cref="Throttle"/> does, they live in the database's
/// settings, as "lockout:&lt;name&gt;:&lt;id&gt;" holding {count, until, locks, forget}, so every process of an
/// install shares them and a restart does not lift a lock. A key is an account's id, never an address, and is
/// kept as a hash of itself. Reading a count and writing it back take turns, in this process and, through the
/// database's lock, across processes.
/// </remarks>
public sealed class Lockout
{
    private const string Counts = "lockout:";

    /// <summary>Locks for keys, shared out by a hash of the key so there are only ever this many.</summary>
    private static readonly SemaphoreSlim[] Turns = [.. Enumerable.Range(0, 16).Select(_ => new SemaphoreSlim(1, 1))];

    private readonly SqlStore _store;
    private readonly string _name;
    private readonly int _limit;
    private readonly long _windowMs;
    private readonly long _longestMs;
    private readonly long _forgetMs;

    public Lockout(SqlStore store, string name, int limit = 5, long windowMs = 15 * 60_000, long longestMs = 86_400_000, long forgetMs = 7 * 86_400_000L)
    {
        _store = store;
        _name = name;
        _limit = limit;
        _windowMs = windowMs;
        _longestMs = longestMs;
        _forgetMs = forgetMs;
    }

    private string Setting(string key) => Counts + _name + ":" + Crypto.Hex(Crypto.Sha256(key))[..32];

    private sealed record Entry(long Count, long Until, long Locks, long Forget);

    private static Entry? Read(string? saved)
    {
        if (saved == null || Json.TryParse(saved) is not JsObject o)
        {
            return null;
        }
        static long N(object? v) => Js.ToLong(Js.Number(v ?? 0L));
        return new Entry(N(o.Get("count")), N(o.Get("until")), N(o.Get("locks")), N(o.Get("forget")));
    }

    private async Task<T> TurnAsync<T>(string key, Func<Task<T>> fn, CancellationToken cancellationToken)
    {
        // The tables first, since a code can be the first thing a new process is asked about.
        await _store.MigrateAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        var turn = Turns[(int)((uint)StringComparer.Ordinal.GetHashCode(Setting(key)) % (uint)Turns.Length)];
        await turn.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await _store.Db.ExclusiveAsync(_ => fn(), cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            turn.Release();
        }
    }

    /// <summary>How long the lock after <paramref name="locks"/> earlier ones lasts: the window doubled each time, up to the longest.</summary>
    private long LockMs(long locks)
    {
        long length = _windowMs;
        for (long i = 0; i < locks && length < _longestMs; i++)
        {
            length *= 2;
        }
        return Math.Min(length, _longestMs);
    }

    /// <summary>
    /// Counts a try before the code is checked, so a burst cannot get past the limit. False, counting
    /// nothing, while the key is locked. The try that uses up the last one starts the lock.
    /// </summary>
    public Task<bool> TakeAsync(string key, long now, CancellationToken cancellationToken = default) => TurnAsync(
        key,
        async () =>
        {
            string setting = Setting(key);
            var entry = Read(await _store.SettingAsync(setting, cancellationToken).ConfigureAwait(false));
            if (entry != null && entry.Forget <= now)
            {
                entry = null;
            }
            if (entry != null && entry.Count >= _limit && entry.Until > now)
            {
                return false;
            }
            long count = entry == null || entry.Until <= now ? 0 : entry.Count;
            long until = entry == null || entry.Until <= now ? now + _windowMs : entry.Until;
            long locks = entry?.Locks ?? 0;
            count++;
            if (count >= _limit)
            {
                until = now + LockMs(locks);
                locks++;
            }
            await _store.SetSettingAsync(
                setting,
                Json.Stringify(new JsObject { ["count"] = count, ["until"] = until, ["locks"] = locks, ["forget"] = until + _forgetMs }),
                cancellationToken).ConfigureAwait(false);
            return true;
        },
        cancellationToken);

    /// <summary>Forgets a key, for a code that turned out right.</summary>
    public Task ClearAsync(string key, CancellationToken cancellationToken = default) => TurnAsync(
        key,
        async () =>
        {
            await _store.SetSettingAsync(Setting(key), null, cancellationToken).ConfigureAwait(false);
            return true;
        },
        cancellationToken);

    /// <summary>For the scheduled check, and a Runlight's start: deletes every key long forgotten.</summary>
    public static async Task SweepAsync(SqlStore store, long now, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(store);
        foreach (var row in await store.SettingsStartingWithAsync(Counts, cancellationToken).ConfigureAwait(false))
        {
            string value = row.Str("value") ?? "";
            var entry = Read(value);
            if (entry == null || entry.Forget <= now)
            {
                // Only as it was read, so a try counted since is kept.
                await store.Db.RunAsync("DELETE FROM rl_settings WHERE \"key\" = ? AND value = ?", [row.Str("key"), value], cancellationToken).ConfigureAwait(false);
            }
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Runlight.Store;

namespace Runlight.Accounts;

/// <summary>
/// Counts failed sign-ins under a key and refuses more than a few in a while. Keys are hashed with a key
/// made each UTC day, so the counts never hold an address or an email as it was given, and once a day's
/// hashing key is gone nothing can tell which address a count was for.
/// </summary>
/// <remarks>
/// TypeScript keeps the counts in its process. Here, as in PHP, they live in the database's settings, as
/// "throttle:&lt;name&gt;:&lt;id&gt;" holding {count, until}, and the hashing key as
/// "throttle-key:&lt;UTC day&gt;", so every process of an install shares the same counts and both
/// implementations can serve one database. Python keeps the counts for keys holding an address in its
/// process instead, but that would give each instance of an install its own limit, so here the hashing
/// key turns over daily: keys older than yesterday are deleted, and expired counts go when they are read
/// and in the scheduled check, so nothing worked out from an address lasts past a day. A count started
/// under yesterday's key is still found until its window ends, so midnight does not lift a block.
/// Reading a count and writing it back take turns: in this process through a lock for the key, and
/// across processes through the database's lock, so a burst of tries cannot all read the same count.
/// </remarks>
public sealed class Throttle
{
    private const string Key = "throttle-key";

    private const string Counts = "throttle:";

    private const long DayMs = 86_400_000;

    /// <summary>Locks for keys, shared out by a hash of the key so there are only ever this many.</summary>
    private static readonly SemaphoreSlim[] Turns = [.. Enumerable.Range(0, 64).Select(_ => new SemaphoreSlim(1, 1))];

    private readonly SqlStore _store;
    private readonly string _name;
    private readonly int _limit;
    private readonly long _windowMs;

    /// <summary>
    /// How many counts this throttle holds, as far as this process knows: unknown (-1) until the first sweep reads
    /// them, then that number plus each count made since, so a sweep runs only when the ceiling can have been passed.
    /// </summary>
    private long _rows = -1;

    public Throttle(SqlStore store, string name, int limit = 10, long windowMs = 15 * 60_000)
    {
        _store = store;
        _name = name;
        _limit = limit;
        _windowMs = windowMs;
    }

    /// <summary>The setting holding the hashing key for the UTC day <paramref name="now"/> falls in.</summary>
    private static string KeyFor(long now) =>
        Key + ":" + DateTimeOffset.FromUnixTimeMilliseconds(now).UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>Today's hashing key, made in turn by the first try of the day, which also deletes the old ones.</summary>
    private async Task<string> SaltAsync(long now, CancellationToken cancellationToken)
    {
        string name = KeyFor(now);
        string? saved = await _store.SettingAsync(name, cancellationToken).ConfigureAwait(false);
        if (!string.IsNullOrEmpty(saved))
        {
            return saved;
        }
        // Made in turn, so tries arriving together on a new day all hash with the same key.
        await Turns[0].WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await _store.Db.ExclusiveAsync(
                async _ =>
                {
                    string? again = await _store.SettingAsync(name, cancellationToken).ConfigureAwait(false);
                    if (!string.IsNullOrEmpty(again))
                    {
                        return again;
                    }
                    string made = Hash.RandomId(16);
                    await _store.SetSettingAsync(name, made, cancellationToken).ConfigureAwait(false);
                    await DropOldKeysAsync(_store, now, cancellationToken).ConfigureAwait(false);
                    return made;
                },
                cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            Turns[0].Release();
        }
    }

    /// <summary>Deletes the hashing keys older than yesterday, and the single key kept before they turned over daily.</summary>
    private static async Task DropOldKeysAsync(SqlStore store, long now, CancellationToken cancellationToken)
    {
        string yesterday = KeyFor(now - DayMs);
        foreach (var row in await store.SettingsStartingWithAsync(Key, cancellationToken).ConfigureAwait(false))
        {
            string key = row.Str("key")!;
            if (!key.StartsWith(Key + ":", StringComparison.Ordinal) || string.CompareOrdinal(key, yesterday) < 0)
            {
                await store.SetSettingAsync(key, null, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    /// <summary>The ids a key's count can be under: with today's hashing key, and with yesterday's while it is kept.</summary>
    private async Task<(string Today, string? Before)> IdsAsync(string key, long now, CancellationToken cancellationToken)
    {
        // The counts live in settings, so the tables come first: a password re-check can be the first thing a new install does.
        await _store.MigrateAsync(cancellationToken: cancellationToken).ConfigureAwait(false);
        string today = IdWith(await SaltAsync(now, cancellationToken).ConfigureAwait(false), key);
        string? before = await _store.SettingAsync(KeyFor(now - DayMs), cancellationToken).ConfigureAwait(false);
        return (today, string.IsNullOrEmpty(before) ? null : IdWith(before, key));
    }

    private static string IdWith(string salt, string key) => Crypto.Base64url(Crypto.Hmac("SHA-256", Js.Utf8(salt), Js.Utf8(key)))[..22];

    /// <summary>
    /// The id to count under: today's, unless a count made under yesterday's key is still running, which then
    /// carries on under its own id until its window ends. Read in turn, since reading drops an expired count.
    /// </summary>
    private async Task<(string Id, (long Count, long Until)? Entry)> FindAsync((string Today, string? Before) ids, long now, CancellationToken cancellationToken)
    {
        var entry = await EntryAsync(ids.Today, now, cancellationToken).ConfigureAwait(false);
        if (entry == null && ids.Before != null)
        {
            var before = await EntryAsync(ids.Before, now, cancellationToken).ConfigureAwait(false);
            if (before != null)
            {
                return (ids.Before, before);
            }
        }
        return (ids.Today, entry);
    }

    private string Prefix => Counts + _name + ":";

    private static (long Count, long Until) Read(object? entry) =>
        entry is JsObject o
            ? (Js.ToLong(Js.Number(o.Get("count") ?? 0L)), Js.ToLong(Js.Number(o.Get("until") ?? 0L)))
            : (0, 0);

    /// <summary>The count under an id while its window runs. One whose window has ended is deleted on the way.</summary>
    private async Task<(long Count, long Until)?> EntryAsync(string id, long now, CancellationToken cancellationToken)
    {
        string? saved = await _store.SettingAsync(Prefix + id, cancellationToken).ConfigureAwait(false);
        if (saved == null)
        {
            return null;
        }
        object? entry = Json.TryParse(saved);
        var read = Read(entry);
        if (entry is not JsObject || read.Until <= now)
        {
            await _store.SetSettingAsync(Prefix + id, null, cancellationToken).ConfigureAwait(false);
            return null;
        }
        return read;
    }

    private Task SaveAsync(string id, (long Count, long Until) entry, CancellationToken cancellationToken) =>
        _store.SetSettingAsync(Prefix + id, Json.Stringify(new JsObject { ["count"] = entry.Count, ["until"] = entry.Until }), cancellationToken);

    /// <summary>
    /// Runs <paramref name="fn"/> while no other try under the same key reads or writes its count. The lock is
    /// chosen by the key as given, which stays in this process, so the id under either day's key takes the same one.
    /// </summary>
    private async Task<T> TurnAsync<T>(string key, Func<Task<T>> fn, CancellationToken cancellationToken)
    {
        var turn = Turns[(int)((uint)StringComparer.Ordinal.GetHashCode(Prefix + key) % (uint)Turns.Length)];
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

    public async Task<bool> BlockedAsync(string key, long now, CancellationToken cancellationToken = default)
    {
        var ids = await IdsAsync(key, now, cancellationToken).ConfigureAwait(false);
        return await TurnAsync(
            key,
            async () => IsBlocked((await FindAsync(ids, now, cancellationToken).ConfigureAwait(false)).Entry),
            cancellationToken).ConfigureAwait(false);
    }

    private bool IsBlocked((long Count, long Until)? entry) => entry != null && entry.Value.Count >= _limit;

    /// <summary>
    /// Counts a try before the slow check it guards, so a burst that arrives while earlier tries are still
    /// being checked cannot get past the limit. False, counting nothing, when the key is already at its
    /// limit. A try that turns out right is taken back with <see cref="ForgiveAsync"/>.
    /// </summary>
    public async Task<bool> TakeAsync(string key, long now, CancellationToken cancellationToken = default)
    {
        var ids = await IdsAsync(key, now, cancellationToken).ConfigureAwait(false);
        return await TurnAsync(
            key,
            async () =>
            {
                var (id, entry) = await FindAsync(ids, now, cancellationToken).ConfigureAwait(false);
                if (IsBlocked(entry))
                {
                    return false;
                }
                await CountAsync(id, entry, now, cancellationToken).ConfigureAwait(false);
                return true;
            },
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Takes back one counted try, for one that turned out right.</summary>
    public async Task ForgiveAsync(string key, long now, CancellationToken cancellationToken = default)
    {
        var ids = await IdsAsync(key, now, cancellationToken).ConfigureAwait(false);
        await TurnAsync(
            key,
            async () =>
            {
                var (id, entry) = await FindAsync(ids, now, cancellationToken).ConfigureAwait(false);
                if (entry != null && entry.Value.Count > 0)
                {
                    await SaveAsync(id, (entry.Value.Count - 1, entry.Value.Until), cancellationToken).ConfigureAwait(false);
                }
                return true;
            },
            cancellationToken).ConfigureAwait(false);
    }

    public async Task FailAsync(string key, long now, CancellationToken cancellationToken = default)
    {
        var ids = await IdsAsync(key, now, cancellationToken).ConfigureAwait(false);
        await TurnAsync(
            key,
            async () =>
            {
                var (id, entry) = await FindAsync(ids, now, cancellationToken).ConfigureAwait(false);
                await CountAsync(id, entry, now, cancellationToken).ConfigureAwait(false);
                return true;
            },
            cancellationToken).ConfigureAwait(false);
    }

    private async Task CountAsync(string id, (long Count, long Until)? entry, long now, CancellationToken cancellationToken)
    {
        if (entry == null)
        {
            await SaveAsync(id, (1, now + _windowMs), cancellationToken).ConfigureAwait(false);
            long rows = Volatile.Read(ref _rows);
            if (rows < 0 || Interlocked.Increment(ref _rows) > Accounts.MaxThrottled)
            {
                await PruneAsync(now, cancellationToken).ConfigureAwait(false);
            }
            return;
        }
        await SaveAsync(id, (entry.Value.Count + 1, entry.Value.Until), cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Expired entries go first, then the oldest that are not blocked, and blocked ones last, so the counts
    /// have a hard ceiling and a flood of made-up names cannot wipe out a real block. Run when a new entry is
    /// made and the count may have passed the ceiling, since reading every count back is the costly part.
    /// </summary>
    private async Task PruneAsync(long now, CancellationToken cancellationToken)
    {
        var entries = new List<(string Key, long Until, bool Blocked)>();
        foreach (var row in await _store.SettingsStartingWithAsync(Prefix, cancellationToken).ConfigureAwait(false))
        {
            string key = row.Str("key")!;
            object? entry = Json.TryParse(row.Str("value") ?? "");
            var (count, until) = Read(entry);
            if (until <= now)
            {
                await _store.SetSettingAsync(key, null, cancellationToken).ConfigureAwait(false);
                continue;
            }
            entries.Add((key, until, entry is JsObject && count >= _limit));
        }
        int size = entries.Count;
        if (size <= Accounts.MaxThrottled)
        {
            Interlocked.Exchange(ref _rows, size);
            return;
        }
        // Oldest first: each entry's window started windowMs before its end.
        var oldest = entries.OrderBy(e => e.Until).ToList();
        foreach (bool blocked in new[] { false, true })
        {
            foreach (var entry in oldest)
            {
                if (size <= Accounts.MaxThrottled)
                {
                    Interlocked.Exchange(ref _rows, size);
                    return;
                }
                if (entry.Blocked == blocked)
                {
                    await _store.SetSettingAsync(entry.Key, null, cancellationToken).ConfigureAwait(false);
                    size--;
                }
            }
        }
        Interlocked.Exchange(ref _rows, size);
    }

    /// <summary>Forgets every try counted under a key, under either day's hashing key.</summary>
    public async Task ClearAsync(string key, long now, CancellationToken cancellationToken = default)
    {
        var ids = await IdsAsync(key, now, cancellationToken).ConfigureAwait(false);
        await TurnAsync(
            key,
            async () =>
            {
                await _store.SetSettingAsync(Prefix + ids.Today, null, cancellationToken).ConfigureAwait(false);
                if (ids.Before != null)
                {
                    await _store.SetSettingAsync(Prefix + ids.Before, null, cancellationToken).ConfigureAwait(false);
                }
                return true;
            },
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// For the scheduled check: deletes every throttle's counts whose window has ended, and the hashing keys
    /// older than yesterday, so nothing worked out from an address outlasts a day even when no one signs in.
    /// </summary>
    public static async Task SweepAsync(SqlStore store, long now, CancellationToken cancellationToken = default)
    {
        foreach (var row in await store.SettingsStartingWithAsync(Counts, cancellationToken).ConfigureAwait(false))
        {
            string value = row.Str("value") ?? "";
            object? entry = Json.TryParse(value);
            if (entry is not JsObject || Read(entry).Until <= now)
            {
                // Only as it was read, so a try counted since, which starts a new window, is kept.
                await store.Db.RunAsync("DELETE FROM rl_settings WHERE \"key\" = ? AND value = ?", [row.Str("key"), value], cancellationToken).ConfigureAwait(false);
            }
        }
        await DropOldKeysAsync(store, now, cancellationToken).ConfigureAwait(false);
    }
}

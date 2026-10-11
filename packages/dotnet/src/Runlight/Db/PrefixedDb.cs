using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Runlight.Db;

/// <summary>
/// An <see cref="IDb"/> whose tables and indexes start with a prefix of the app's choosing in place of
/// <c>rl_</c>, such as <c>wp_rl_</c> inside WordPress, so two apps sharing one database each keep a set of
/// their own. Runlight's SQL names every table and index <c>rl_</c> and something, and those names alone are
/// rewritten on the way through, in each statement and in the names a schema check compares as text. A
/// store given a prefix puts one in front of its Db, so the accounts and importers that reach the Db through
/// the store follow it too. Values bound as parameters are never rewritten.
/// </summary>
public sealed partial class PrefixedDb : IDb
{
    /// <param name="inner">The database.</param>
    /// <param name="prefix">Up to 32 letters, digits, and underscores, not starting with a digit.</param>
    /// <exception cref="ArgumentException">For a prefix that is not one.</exception>
    public PrefixedDb(IDb inner, string prefix)
    {
        ArgumentNullException.ThrowIfNull(inner);
        // A name in a statement, and short enough that the longest index name stays inside MySQL's 64.
        if (prefix == null || !Valid().IsMatch(prefix))
        {
            throw new ArgumentException("Runlight: a table prefix is up to 32 letters, digits, and underscores, and does not start with a digit", nameof(prefix));
        }
        Inner = inner;
        Prefix = prefix;
    }

    /// <summary>The database underneath, with Runlight's own names.</summary>
    public IDb Inner { get; }

    /// <summary>What every table and index name starts with in place of <c>rl_</c>.</summary>
    public string Prefix { get; }

    public string Dialect => Inner.Dialect;

    /// <summary>A statement with each of Runlight's names under the prefix.</summary>
    public string Sql(string sql) => Names().Replace(sql, Prefix);

    public Task<List<JsObject>> AllAsync(string sql, IReadOnlyList<object?>? args = null, CancellationToken cancellationToken = default) =>
        Inner.AllAsync(Sql(sql), args, cancellationToken);

    public Task RunAsync(string sql, IReadOnlyList<object?>? args = null, CancellationToken cancellationToken = default) =>
        Inner.RunAsync(Sql(sql), args, cancellationToken);

    public Task<long> AffectedAsync(string sql, IReadOnlyList<object?>? args = null, CancellationToken cancellationToken = default) =>
        Inner.AffectedAsync(Sql(sql), args, cancellationToken);

    public Task<T> TransactionAsync<T>(Func<IDb, Task<T>> fn, CancellationToken cancellationToken = default) =>
        Inner.TransactionAsync(db => fn(Wrap(db)), cancellationToken);

    public Task<T> ExclusiveAsync<T>(Func<IDb, Task<T>> fn, CancellationToken cancellationToken = default) =>
        Inner.ExclusiveAsync(db => fn(Wrap(db)), cancellationToken);

    public ValueTask DisposeAsync() => Inner.DisposeAsync();

    /// <summary>The Db a transaction or a lock hands over, under the same prefix.</summary>
    private IDb Wrap(IDb db) => ReferenceEquals(db, Inner) ? this : new PrefixedDb(db, Prefix);

    [GeneratedRegex("^[A-Za-z_][A-Za-z0-9_]{0,31}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex Valid();

    /// <summary>An <c>rl_</c> name: not inside a longer word, and followed by a lowercase letter.</summary>
    [GeneratedRegex("(?<![A-Za-z0-9_])rl_(?=[a-z])", RegexOptions.CultureInvariant)]
    private static partial Regex Names();
}

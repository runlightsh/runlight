using System;
using System.Globalization;

namespace Runlight;

/// <summary>
/// Another process held the lock for creating tables past <see cref="Store.SqlStore.LockWaitMs"/>, such as one
/// building an index on a big table after an upgrade. The request that waited fails with this, rather than
/// waiting for good.
/// </summary>
public sealed class TablesBusyError : Exception
{
    public TablesBusyError()
        : this(Store.SqlStore.LockWaitMs)
    {
    }

    /// <param name="waited">How long it waited, in milliseconds, which the message names in whole seconds.</param>
    public TablesBusyError(long waited)
        : base("Runlight: another process is creating or upgrading the tables, and had not finished after " + Math.Round(waited / 1000.0, MidpointRounding.AwayFromZero).ToString(CultureInfo.InvariantCulture) + " seconds. Try again in a minute.")
    {
    }

    public TablesBusyError(string message)
        : base(message)
    {
    }

    public TablesBusyError(string message, Exception inner)
        : base(message, inner)
    {
    }
}

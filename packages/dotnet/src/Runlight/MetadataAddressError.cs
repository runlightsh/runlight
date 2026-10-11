using System;

namespace Runlight;

/// <summary>Refused before anything was fetched, because the address is link-local or a cloud's metadata service.</summary>
public sealed class MetadataAddressError : Exception
{
    public MetadataAddressError()
    {
    }

    /// <param name="host">The host refused, without IPv6 brackets, which the message names.</param>
    public MetadataAddressError(string host)
        : base(host + " is a link-local or cloud metadata address, which Runlight never connects to")
    {
        Host = host;
    }

    public MetadataAddressError(string message, Exception inner)
        : base(message, inner)
    {
    }

    /// <summary>The host refused, without IPv6 brackets.</summary>
    public string Host { get; } = "";
}

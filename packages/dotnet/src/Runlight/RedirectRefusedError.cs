using System;

namespace Runlight;

/// <summary>Refused before anything was sent there, because a service's redirect led to another origin.</summary>
public sealed class RedirectRefusedError : Exception
{
    public RedirectRefusedError()
    {
    }

    /// <param name="host">The host that redirected, with its port as a URL shows it.</param>
    /// <param name="to">Where it pointed: the origin, or the scheme of one that is not http or https.</param>
    public RedirectRefusedError(string host, string to)
        : base(host + " redirected to " + to + ". Runlight sends a service's key and request only to the address it was set up with, so set it up with that address instead")
    {
        Host = host;
        To = to;
    }

    public RedirectRefusedError(string message, Exception inner)
        : base(message, inner)
    {
    }

    /// <summary>The host that redirected.</summary>
    public string Host { get; } = "";

    /// <summary>Where it pointed.</summary>
    public string To { get; } = "";
}

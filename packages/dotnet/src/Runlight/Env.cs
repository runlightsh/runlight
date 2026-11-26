using System;

namespace Runlight;

/// <summary>Environment variables, trimmed, with an empty one read as unset.</summary>
public static class Env
{
    public static string? Get(string name)
    {
        string? value = Environment.GetEnvironmentVariable(name);
        if (value == null)
        {
            return null;
        }
        value = value.Trim();
        return value.Length == 0 ? null : value;
    }
}

/// <summary>
/// The SDK's version and the HTTP API's, read from Assets/build.json, which
/// scripts/dotnet-assets.mts writes from the TypeScript SDK, so the two always report the same.
/// </summary>
public static class Version
{
    public static string Current => Assets.Build.Str("version")!;

    /// <summary>Bumped when the HTTP API changes shape, so the dashboard and the hub can tell.</summary>
    public static int Api => (int)Assets.Build.Num("apiVersion");
}

public static class Brand
{
    /// <summary>The Runlight mark for the dashboard's tab: an R in a rounded lamp housing, one corner lit. A data: URL.</summary>
    public static string RunlightIcon => Assets.Build.Str("icon")!;

    /// <summary>
    /// The mark as a 96 pixel PNG, base64, the same drawing as the website's header and the Mac app's icon. Each
    /// install serves it at &lt;base&gt;/logo.png, without signing in, for its emails.
    /// </summary>
    public static string LogoPng => Assets.Build.Str("logoPng")!;

    /// <summary>
    /// The mark for emails: the PNG at the sending install's own /logo.png, shown at 48 pixels. Opening an email
    /// fetches it from that install and from nowhere else; a client that blocks images shows the word Runlight.
    /// <paramref name="home"/> is the install's address with its base path, such as https://example.com/runlight.
    /// </summary>
    public static string EmailLogo(string home)
    {
        ArgumentNullException.ThrowIfNull(home);
        string src = (home.TrimEnd('/') + "/logo.png").Replace("&", "&amp;", StringComparison.Ordinal).Replace("\"", "&quot;", StringComparison.Ordinal).Replace("<", "&lt;", StringComparison.Ordinal).Replace(">", "&gt;", StringComparison.Ordinal);
        return "<img src=\"" + src + "\" width=\"48\" height=\"48\" alt=\"Runlight\" style=\"display:block;width:48px;height:48px;margin:0 0 24px;border:0;outline:none;text-decoration:none;font:700 16px/48px -apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;color:#6b7280\">";
    }
}

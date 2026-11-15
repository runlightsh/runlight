using System;
using System.Globalization;

namespace Runlight;

/// <summary>
/// English word order, as JavaScript's localeCompare gives it. An app built or run with globalization
/// turned off (InvariantGlobalization, or DOTNET_SYSTEM_GLOBALIZATION_INVARIANT, as the Alpine and
/// chiseled images set it) has no cultures but the invariant one, and asking for English there throws;
/// it then sorts by the invariant culture, which is all that runtime has.
/// </summary>
internal static class EnglishOrder
{
    private static readonly Lazy<CompareInfo> English = new(Make);

    private static CompareInfo Make()
    {
        try
        {
            return CultureInfo.GetCultureInfo("en").CompareInfo;
        }
        catch (CultureNotFoundException)
        {
            return CultureInfo.InvariantCulture.CompareInfo;
        }
    }

    public static int Compare(string a, string b) => English.Value.Compare(a, b, CompareOptions.None);
}

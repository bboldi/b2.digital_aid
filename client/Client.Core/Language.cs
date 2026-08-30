using System.Globalization;

namespace DigitalAid.Client.Core;

/// <summary>
/// Which language this PC speaks. Two, stored as a bare code, chosen on the machine (ADR-0012).
///
/// There is deliberately no "follow the system" value. The system language is consulted exactly once,
/// by <see cref="Detect"/> on a Client that has never been asked, and the answer is written down as a
/// concrete choice. A Client that kept deferring to Windows could change language under a kid's feet
/// when someone touched a display setting, and the tick beside a menu item would be unable to say
/// what was actually in force.
/// </summary>
public static class Language
{
    public const string English = "en";
    public const string Hungarian = "hu";

    public static readonly string[] All = [English, Hungarian];

    public static bool IsSupported(string? code) => code is English or Hungarian;

    /// <summary>The stored choice, or — the first time only — whatever Windows is set to. Anything
    /// unrecognised resolves to English rather than being carried around as a third state.</summary>
    public static string Resolve(string? stored) => IsSupported(stored) ? stored! : Detect();

    /// <summary>What the machine looks like it wants, used once and then written down. Matches on the
    /// two-letter part, so hu-HU and a bare hu both count.</summary>
    public static string Detect() =>
        CultureInfo.CurrentUICulture.TwoLetterISOLanguageName.Equals(Hungarian, StringComparison.OrdinalIgnoreCase)
            ? Hungarian
            : English;

    /// <summary>Point the resource lookups at a language, for this thread and every thread started
    /// after it. Called once at startup and again when someone picks from the tray.</summary>
    public static void Apply(string code)
    {
        var culture = CultureInfo.GetCultureInfo(IsSupported(code) ? code : English);
        CultureInfo.DefaultThreadCurrentUICulture = culture;
        CultureInfo.CurrentUICulture = culture;
    }

    /// <summary>The name of a language in its own language, so it is recognisable from the other one.
    /// A Hungarian speaker looking at an English menu should not have to know that "Hungarian" means
    /// magyar to find their way home.</summary>
    public static string NameOf(string code) => code == Hungarian ? Strings.LanguageHungarian : Strings.LanguageEnglish;
}

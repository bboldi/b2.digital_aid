using System.Globalization;
using System.Resources;
using System.Text.RegularExpressions;
using DigitalAid.Client.Core;

namespace Client.Core.Tests;

/// <summary>
/// The catalogue itself, checked as data. A missing Hungarian entry does not fail a build and does not
/// throw at runtime — the lookup quietly falls back to English — so without this the first person to
/// find it is a kid reading half a screen in the wrong language.
///
/// This is the reason the .resx files live in Client.Core rather than in the Windows-only shell:
/// these assertions run on the dev box.
/// </summary>
public sealed class StringsTests
{
    private static readonly ResourceManager Manager =
        new("DigitalAid.Client.Core.Strings", typeof(Strings).Assembly);

    /// <summary>English is the *neutral* catalogue, embedded in the assembly itself rather than in an
    /// en satellite — so it is reached through the invariant culture. Asking for "en" finds nothing,
    /// which is correct and is not the same as English being missing.</summary>
    private static ResourceSet Set(string culture) =>
        Manager.GetResourceSet(
            culture == Language.English ? CultureInfo.InvariantCulture : CultureInfo.GetCultureInfo(culture),
            createIfNotExists: true, tryParents: false)
        ?? throw new InvalidOperationException($"no resources for '{culture}'");

    private static Dictionary<string, string> Entries(string culture) =>
        Set(culture).Cast<System.Collections.DictionaryEntry>()
            .ToDictionary(e => (string)e.Key, e => (string)e.Value!);

    [Fact]
    public void Every_english_string_has_a_hungarian_one()
    {
        var missing = Entries("en").Keys.Except(Entries("hu").Keys).OrderBy(k => k).ToList();

        Assert.True(missing.Count == 0, $"no Hungarian for: {string.Join(", ", missing)}");
    }

    [Fact]
    public void No_hungarian_string_is_left_over()
    {
        // A key renamed in English and not in Hungarian would otherwise sit there looking translated.
        var orphans = Entries("hu").Keys.Except(Entries("en").Keys).OrderBy(k => k).ToList();

        Assert.True(orphans.Count == 0, $"Hungarian with no English: {string.Join(", ", orphans)}");
    }

    /// <summary>Both languages must use the same placeholders. Hungarian word order differs from
    /// English, so a translator moves {0} and {1} around freely — and swapping them is fine, dropping
    /// one is a FormatException on a kid's screen, or worse, a sentence missing its number.</summary>
    [Fact]
    public void Placeholders_match_between_the_two_languages()
    {
        var english = Entries("en");
        var hungarian = Entries("hu");
        var problems = new List<string>();

        foreach (var (key, en) in english)
        {
            if (!hungarian.TryGetValue(key, out var hu)) continue;
            var a = Placeholders(en);
            var b = Placeholders(hu);
            if (!a.SetEquals(b))
                problems.Add($"{key}: en has {{{string.Join(",", a.Order())}}}, hu has {{{string.Join(",", b.Order())}}}");
        }

        Assert.True(problems.Count == 0, string.Join("\n", problems));
    }

    private static HashSet<string> Placeholders(string value) =>
        Regex.Matches(value, @"\{(\d+)\}").Select(m => m.Groups[1].Value).ToHashSet();

    [Fact]
    public void Nothing_is_blank()
    {
        foreach (var culture in Language.All)
        {
            var blank = Entries(culture).Where(e => string.IsNullOrWhiteSpace(e.Value)).Select(e => e.Key).ToList();
            Assert.True(blank.Count == 0, $"{culture} has empty values: {string.Join(", ", blank)}");
        }
    }

    /// <summary>The glossary fixes one Hungarian word per concept (CONTEXT.md: Hungarian terms).
    /// "Downtime" is the one that drifted in English before it was written down — the Flyout said
    /// "Quiet time" while everything else said Downtime — so it is the one worth a test.</summary>
    [Fact]
    public void Hungarian_uses_the_glossary_word_for_downtime()
    {
        var offenders = Entries("hu")
            .Where(e => Regex.IsMatch(e.Value, "csendes|nyugalmi", RegexOptions.IgnoreCase))
            .Select(e => e.Key)
            .ToList();

        Assert.True(offenders.Count == 0, $"use 'pihenőidő' (CONTEXT.md), not a synonym: {string.Join(", ", offenders)}");
    }

    [Fact]
    public void Both_languages_are_actually_reachable_at_runtime()
    {
        Language.Apply(Language.Hungarian);
        Assert.Equal("Pihenőidő", Strings.FlyoutDowntime);

        Language.Apply(Language.English);
        Assert.Equal("Downtime", Strings.FlyoutDowntime);
    }

    [Fact]
    public void An_unknown_language_falls_back_to_english_rather_than_blank()
    {
        Language.Apply("kl");

        Assert.Equal("Downtime", Strings.FlyoutDowntime);
        Assert.Equal(Language.English, Language.Resolve("kl"));
    }
}

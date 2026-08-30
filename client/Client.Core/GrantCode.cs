using System.Security.Cryptography;
using System.Text;

namespace DigitalAid.Client.Core;

/// <summary>
/// Extra Time Codes: <c>[6 digits][3-digit minutes]</c> — always nine, e.g. <c>482102015</c> is 15
/// minutes, written down as <c>482-102-015</c>.
///
/// The six digits are derived from the Grant Seed, the minutes, and the current minute — not from
/// the Admin Code (ADR-0006). Nothing about the Admin Code is present, so collecting the codes a
/// parent reads out never yields the key that exits the app. The minutes travel in the clear *and*
/// inside the derivation, so editing the trailing number invalidates the code instead of minting
/// time. This is a real binding, not the obscurity the previous scheme relied on.
///
/// The derivation is ours rather than RFC 6238's, which is what frees the step from TOTP's 30
/// seconds. It is defined identically here, in <c>server/src/grant-code.js</c> and in
/// <c>server/public/family-code.js</c>; <c>GrantCodeVectors</c> pins all three to the same numbers.
/// </summary>
public static class GrantCode
{
    /// <summary>60 seconds, against TOTP's 30. Long enough to read eight digits down a phone to
    /// someone who will mistype them once; short enough that a fresh distinct code is never more
    /// than a minute away — which matters because the code is a pure function of (seed, minutes,
    /// step), so granting the same minutes twice inside one step produces the same digits.</summary>
    public const int StepSeconds = 60;

    private const int Modulus = 1_000_000;

    /// <summary>Splits the input into its six digits and its minutes. Format only — it proves
    /// nothing about validity, which is what <see cref="Verify"/> is for.</summary>
    public static bool TryParse(string? input, out string digits, out int minutes)
    {
        digits = string.Empty;
        minutes = 0;
        // Separators are stripped rather than rejected: a code is *written* in threes so it survives
        // being read down a phone (ADR-0014), and whatever a parent types or pastes will carry
        // whichever of those the sender's keyboard produced. The dash a phone autocorrects into an
        // en dash is the same dash to a kid at a block screen.
        var s = Strip(input);
        // Seven and eight are still accepted so codes minted by a server predating the padding, and
        // any still in someone's message history, keep working.
        if (s.Length is < 7 or > 9 || !s.All(char.IsAsciiDigit)) return false;

        var m = int.Parse(s[6..]);
        if (m < 1) return false;

        digits = s[..6];
        minutes = m;
        return true;
    }

    /// <summary>Checks an Extra Time Code against the seed, accepting the neighbouring steps as well.
    /// ±1 rather than backward-only because a PC running a few minutes fast is a first-class event
    /// in this system (clock jumps are logged), and should not silently refuse valid codes.</summary>
    public static bool Verify(string? input, string hexSeed, DateTimeOffset utcNow, int window = 1)
    {
        if (string.IsNullOrEmpty(hexSeed)) return false;
        if (!TryParse(input, out var digits, out var minutes)) return false;

        var step = utcNow.ToUnixTimeSeconds() / StepSeconds;
        for (long w = -window; w <= window; w++)
            if (CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(Digits(hexSeed, minutes, step + w)),
                    Encoding.ASCII.GetBytes(digits)))
                return true;
        return false;
    }

    /// <summary>The Extra Time Code to read out. The admin UI and a Trusted Device build the same string
    /// from the same inputs; this exists so the client and the tests share one definition of it.</summary>
    public static string Build(string hexSeed, int minutes, DateTimeOffset utcNow) =>
        Digits(hexSeed, minutes, utcNow.ToUnixTimeSeconds() / StepSeconds) + Pad(minutes);

    /// <summary>The minutes as they are written: three digits, zero-padded, so every code is nine
    /// and has one shape. Written only — <see cref="Digits"/> signs the bare integer, so a padded
    /// code and an unpadded one for the same minutes carry the same six digits and both verify.
    /// That is what let the padding ship without every Client being updated first (ADR-0014).</summary>
    private static string Pad(int minutes) => minutes.ToString("D3");

    /// <summary>How a code is shown to a human: <c>482-102-015</c>. Presentation only — never stored,
    /// never compared, never put on a clipboard, because an older Client's parser rejects anything
    /// that is not a digit.</summary>
    public static string Format(string? code)
    {
        var s = Strip(code);
        return s.Length == 9 ? $"{s[..3]}-{s[3..6]}-{s[6..]}" : s;
    }

    /// <summary>Separators removed — and only separators. Covers the ASCII hyphen, the en and em
    /// dashes a phone keyboard substitutes for it, ordinary and non-breaking spaces, dots and
    /// underscores: everything a code picks up between being displayed in threes and being typed
    /// back in.
    ///
    /// Deliberately not "strip anything that is not a digit". That would quietly rescue a typo —
    /// <c>12345a15</c> would become a well-formed seven-digit code for different minutes than
    /// anyone intended, and be refused by the seed with no hint as to why. A stray letter is a
    /// mistake and must stay one; the caller still requires every surviving character to be a
    /// digit.</summary>
    private static readonly char[] Separators = [' ', '-', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u00a0', '\u202f', '.', '_'];

    internal static string Strip(string? input) =>
        input is null ? string.Empty : new string(input.Where(c => !Separators.Contains(c)).ToArray());

    /// <summary>Six digits of HMAC-SHA256 over <c>"{minutes}:{step}"</c>, folded with RFC 4226's
    /// dynamic truncation — the same reduction <see cref="Totp"/> uses, so there is one way of
    /// turning a MAC into digits in this codebase rather than two.</summary>
    private static string Digits(string hexSeed, int minutes, long step)
    {
        var mac = HMACSHA256.HashData(Convert.FromHexString(hexSeed), Encoding.ASCII.GetBytes($"{minutes}:{step}"));
        var offset = mac[^1] & 0x0f;
        var binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
        return (binary % Modulus).ToString("D6");
    }
}

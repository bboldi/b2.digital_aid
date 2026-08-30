namespace DigitalAid.Client.Core;

/// <summary>
/// Time Coupons: <c>[6 letters][3-digit minutes]</c> — <c>KRTVXM030</c>, shown as
/// <c>KRT-VXM-030</c>. The letters are the dispatcher (ADR-0017): an all-digit code goes down the
/// offline Grant Seed path exactly as before, and anything with a letter in it is a coupon, which
/// only the server can judge. Nothing here verifies — there is no seed to verify against, and that
/// is the point: the coupon inventory lives on the server and nowhere else.
/// </summary>
public static class CouponCode
{
    /// <summary>19 consonants: no vowels, so six random letters can never spell a word on a slip
    /// handed to a child, and no I, L or O, so every printed glyph has one reading. Defined
    /// identically in <c>server/src/coupons.js</c>.</summary>
    public const string Alphabet = "BCDFGHJKMNPQRSTVWXZ";

    /// <summary>Whether this input belongs to the coupon path at all: any ASCII letter after the
    /// separators are gone. A malformed coupon still routes here — "KRTVXA030" must fail as a bad
    /// coupon, not fall through and fail as a bad Extra Time Code.</summary>
    public static bool LooksLikeCoupon(string? input) =>
        GrantCode.Strip(input).Any(char.IsAsciiLetter);

    /// <summary>Canonical form out: uppercase, separator-free, exactly six alphabet letters and the
    /// minutes. Format only — validity is the server's answer, not this method's.</summary>
    public static bool TryParse(string? input, out string code, out int minutes)
    {
        code = string.Empty;
        minutes = 0;

        var s = GrantCode.Strip(input).ToUpperInvariant();
        if (s.Length != 9) return false;
        if (!s[..6].All(c => Alphabet.Contains(c))) return false;
        if (!s[6..].All(char.IsAsciiDigit)) return false;

        var m = int.Parse(s[6..]);
        if (m < 1) return false;

        code = s;
        minutes = m;
        return true;
    }

    /// <summary>How a coupon is shown: <c>KRT-VXM-030</c>. Presentation only — never stored, never
    /// sent, never put on a clipboard (ADR-0014).</summary>
    public static string Format(string? code)
    {
        var s = GrantCode.Strip(code).ToUpperInvariant();
        return s.Length == 9 ? $"{s[..3]}-{s[3..6]}-{s[6..]}" : s;
    }
}

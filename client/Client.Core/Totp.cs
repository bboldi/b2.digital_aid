using System.Security.Cryptography;

namespace DigitalAid.Client.Core;

/// <summary>
/// RFC 6238 TOTP, fixed to the Admin Code profile: SHA-1, 30-second step, 6 digits,
/// verification window ±1 step — matching the server (otplib defaults) and authenticator apps.
/// </summary>
public static class Totp
{
    private const int StepSeconds = 30;
    private const int Digits = 6;

    public static bool Verify(string code, string base32Secret, DateTimeOffset utcNow, int window = 1)
    {
        if (code.Length != Digits || !code.All(char.IsAsciiDigit)) return false;
        var step = utcNow.ToUnixTimeSeconds() / StepSeconds;
        for (long w = -window; w <= window; w++)
            if (Compute(base32Secret, step + w) == code)
                return true;
        return false;
    }

    public static string Compute(string base32Secret, long timeStep)
    {
        var counter = new byte[8];
        for (var i = 7; i >= 0; i--) { counter[i] = (byte)(timeStep & 0xff); timeStep >>= 8; }
        var hash = HMACSHA1.HashData(DecodeBase32(base32Secret), counter);
        var offset = hash[^1] & 0x0f;
        var binary = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
        return (binary % 1_000_000).ToString("D6");
    }

    public static string CodeAt(string base32Secret, DateTimeOffset utc) =>
        Compute(base32Secret, utc.ToUnixTimeSeconds() / StepSeconds);

    internal static byte[] DecodeBase32(string s)
    {
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        var clean = s.TrimEnd('=').Replace(" ", "").ToUpperInvariant();
        var bits = 0;
        var value = 0;
        var output = new List<byte>(clean.Length * 5 / 8);
        foreach (var c in clean)
        {
            var idx = alphabet.IndexOf(c);
            if (idx < 0) throw new FormatException($"Invalid base32 character '{c}'.");
            value = (value << 5) | idx;
            bits += 5;
            if (bits >= 8)
            {
                output.Add((byte)(value >> (bits - 8)));
                bits -= 8;
            }
        }
        return [.. output];
    }
}

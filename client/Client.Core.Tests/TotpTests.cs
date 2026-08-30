using DigitalAid.Client.Core;

namespace Client.Core.Tests;

public class TotpTests
{
    // RFC 6238 test secret ("12345678901234567890" in base32); the server's otplib
    // produces identical codes for these epochs (verified against otplib 12.x).
    private const string Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    [Theory]
    [InlineData(59, "287082")]           // RFC 6238 vector (last 6 of 94287082)
    [InlineData(1111111109, "081804")]   // RFC 6238 vector (last 6 of 07081804)
    [InlineData(1111111111, "050471")]   // RFC 6238 vector (last 6 of 14050471)
    [InlineData(1787080000, "001636")]   // otplib cross-implementation fixture
    public void Computes_rfc6238_and_otplib_compatible_codes(long epochSeconds, string expected)
    {
        var t = DateTimeOffset.FromUnixTimeSeconds(epochSeconds);
        Assert.Equal(expected, Totp.CodeAt(Secret, t));
    }

    [Fact]
    public void Verify_accepts_adjacent_steps_but_not_two_steps_away()
    {
        var now = DateTimeOffset.FromUnixTimeSeconds(1787080000);
        var current = Totp.CodeAt(Secret, now);
        var previous = Totp.CodeAt(Secret, now.AddSeconds(-30));
        var next = Totp.CodeAt(Secret, now.AddSeconds(30));
        var stale = Totp.CodeAt(Secret, now.AddSeconds(-60));

        Assert.True(Totp.Verify(current, Secret, now));
        Assert.True(Totp.Verify(previous, Secret, now));
        Assert.True(Totp.Verify(next, Secret, now));
        Assert.False(Totp.Verify(stale, Secret, now));
    }

    [Theory]
    [InlineData("28708")]     // too short
    [InlineData("2870822")]   // too long
    [InlineData("28708a")]    // non-digit
    [InlineData("")]
    public void Verify_rejects_malformed_codes(string code)
    {
        Assert.False(Totp.Verify(code, Secret, DateTimeOffset.FromUnixTimeSeconds(59)));
    }

    [Fact]
    public void Base32_decoding_handles_padding_case_and_spaces()
    {
        var reference = Totp.DecodeBase32(Secret);
        Assert.Equal("12345678901234567890"u8.ToArray(), reference);
        Assert.Equal(reference, Totp.DecodeBase32(Secret.ToLowerInvariant()));
        Assert.Equal(reference, Totp.DecodeBase32(Secret + "======"));
        Assert.Equal(reference, Totp.DecodeBase32(Secret.Insert(8, " ")));
    }
}

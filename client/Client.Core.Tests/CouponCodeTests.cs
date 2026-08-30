using DigitalAid.Client.Core;

namespace Client.Core.Tests;

// A Time Coupon is told apart from an Extra Time Code by its letters (ADR-0017): the parser is the
// dispatcher, so its edges are the feature's edges.
public class CouponCodeTests
{
    [Fact]
    public void Alphabet_is_the_19_unambiguous_consonants()
    {
        Assert.Equal("BCDFGHJKMNPQRSTVWXZ", CouponCode.Alphabet);
    }

    [Theory]
    [InlineData("KRTVXM030", "KRTVXM030", 30)]
    [InlineData("krtvxm030", "KRTVXM030", 30)]     // case-insensitive entry
    [InlineData("KRT-VXM-030", "KRTVXM030", 30)]   // shown in threes, typed back with dashes
    [InlineData("krt vxm 005", "KRTVXM005", 5)]
    public void Parses_to_the_canonical_uppercase_form(string input, string code, int minutes)
    {
        Assert.True(CouponCode.TryParse(input, out var c, out var m));
        Assert.Equal(code, c);
        Assert.Equal(minutes, m);
    }

    [Theory]
    [InlineData("482102015")]    // all digits: an Extra Time Code, not a coupon
    [InlineData("KRTVXM03")]     // short
    [InlineData("KRTVXM0300")]   // long
    [InlineData("KRTVXA030")]    // A is a vowel, not in the alphabet
    [InlineData("KRTVXM000")]    // zero minutes
    [InlineData("KRTVX7030")]    // digit where a letter belongs
    [InlineData("")]
    [InlineData(null)]
    public void Rejects_everything_that_is_not_coupon_shaped(string? input)
    {
        Assert.False(CouponCode.TryParse(input, out _, out _));
    }

    [Theory]
    [InlineData("KRTVXM030", true)]
    [InlineData("krt-vxm-030", true)]
    [InlineData("482102015", false)]   // digits go down the offline seed path, untouched
    [InlineData("482-102-015", false)]
    public void Letters_route_to_the_coupon_path(string input, bool expected)
    {
        Assert.Equal(expected, CouponCode.LooksLikeCoupon(input));
    }

    [Fact]
    public void Formats_in_threes_for_display_only()
    {
        Assert.Equal("KRT-VXM-030", CouponCode.Format("krtvxm030"));
    }
}

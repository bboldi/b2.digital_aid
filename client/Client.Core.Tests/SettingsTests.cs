using DigitalAid.Client.Core;

namespace Client.Core.Tests;

public class SettingsTests
{
    private static Settings Wrapping => new(new TimeOnly(21, 0), new TimeOnly(7, 0), 120, 180);
    private static Settings SameDay => new(new TimeOnly(13, 0), new TimeOnly(15, 0), 120, 180);

    [Theory]
    [InlineData(21, 0, true)]   // start is inclusive
    [InlineData(23, 30, true)]
    [InlineData(3, 0, true)]    // past midnight
    [InlineData(6, 59, true)]
    [InlineData(7, 0, false)]   // end is exclusive
    [InlineData(12, 0, false)]
    public void Downtime_wraps_past_midnight(int h, int m, bool expected)
    {
        Assert.Equal(expected, Wrapping.IsDowntime(new TimeOnly(h, m)));
    }

    [Theory]
    [InlineData(12, 59, false)]
    [InlineData(13, 0, true)]
    [InlineData(14, 59, true)]
    [InlineData(15, 0, false)]
    public void Downtime_within_one_day(int h, int m, bool expected)
    {
        Assert.Equal(expected, SameDay.IsDowntime(new TimeOnly(h, m)));
    }

    [Fact]
    public void Equal_start_and_end_means_no_downtime()
    {
        var s = new Settings(new TimeOnly(9, 0), new TimeOnly(9, 0), 120, 180);
        Assert.False(s.IsDowntime(new TimeOnly(9, 0)));
        Assert.False(s.IsDowntime(new TimeOnly(21, 0)));
        Assert.Equal(int.MaxValue, s.SecondsUntilDowntime(new TimeOnly(12, 0)));
    }

    [Theory]
    [InlineData(20, 0, 3600)]  // one hour before start
    [InlineData(22, 0, 0)]     // already inside
    [InlineData(8, 0, 46800)]  // morning: 13 hours until 21:00, across the day
    public void Seconds_until_downtime(int h, int m, int expected)
    {
        Assert.Equal(expected, Wrapping.SecondsUntilDowntime(new TimeOnly(h, m)));
    }

    [Fact]
    public void Allowance_picks_weekend_rate_on_sat_sun()
    {
        Assert.Equal(120, Wrapping.AllowanceMinutesFor(new DateOnly(2026, 8, 21)));  // Friday
        Assert.Equal(180, Wrapping.AllowanceMinutesFor(new DateOnly(2026, 8, 22)));  // Saturday
        Assert.Equal(180, Wrapping.AllowanceMinutesFor(new DateOnly(2026, 8, 23)));  // Sunday
        Assert.Equal(120, Wrapping.AllowanceMinutesFor(new DateOnly(2026, 8, 24)));  // Monday
    }
}

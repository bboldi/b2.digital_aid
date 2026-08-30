namespace DigitalAid.Client.Core;

/// <summary>Enforcement settings for this Client, cached locally for offline operation (PRD §6.4).</summary>
public sealed record Settings(
    TimeOnly DowntimeStart,
    TimeOnly DowntimeEnd,
    int WeekdayMinutes,
    int WeekendMinutes)
{
    public static Settings Default { get; } = new(new TimeOnly(21, 0), new TimeOnly(7, 0), 120, 180);

    /// <summary>Downtime window; wraps past midnight when end &lt; start (the common case).
    /// Start == end means no downtime at all.</summary>
    public bool IsDowntime(TimeOnly t) =>
        DowntimeStart == DowntimeEnd ? false :
        DowntimeStart < DowntimeEnd ? t >= DowntimeStart && t < DowntimeEnd :
        t >= DowntimeStart || t < DowntimeEnd;

    public int AllowanceMinutesFor(DateOnly date) =>
        date.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday ? WeekendMinutes : WeekdayMinutes;

    /// <summary>Seconds from <paramref name="t"/> until downtime starts; 0 if already inside it.</summary>
    public int SecondsUntilDowntime(TimeOnly t)
    {
        if (DowntimeStart == DowntimeEnd) return int.MaxValue;
        if (IsDowntime(t)) return 0;
        var diff = (DowntimeStart - t).TotalSeconds;   // TimeOnly subtraction wraps over midnight
        return (int)diff;
    }
}

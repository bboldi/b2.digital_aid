using DigitalAid.Client.Core;

namespace Client.Core.Tests;

/// <summary>Time Left as usable-right-now (PRD §3.1) and the Lock / End Today overrides (§3.2).</summary>
public class TimeLeftAndOverrideTests
{
    private const string Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    private const string GrantSeed = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
    private static Settings Default => new(new TimeOnly(21, 0), new TimeOnly(7, 0), 120, 180);
    private static DateTimeOffset MondayMorning => new(2026, 8, 24, 10, 0, 0, TimeSpan.FromHours(2));
    private static DateTimeOffset DuringDowntime => new(2026, 8, 24, 21, 30, 0, TimeSpan.FromHours(2));

    private static EnforcementEngine Start(DateTimeOffset at, Settings? settings = null, bool unlocked = true)
    {
        var e = new EnforcementEngine(settings ?? Default, Secret, grantSeed: GrantSeed);
        e.Tick(at, TimeSpan.Zero, unlocked);
        return e;
    }

    private static string Code(DateTimeOffset at) => Totp.CodeAt(Secret, at);
    private static string Grant(int minutes, DateTimeOffset at) => GrantCode.Build(GrantSeed, minutes, at);

    // --- Time Left = usable right now ------------------------------------------------

    [Fact]
    public void On_a_plain_weekday_time_left_is_the_allowance()
    {
        var e = Start(MondayMorning);
        Assert.Equal(TimeLeftKind.Allowance, e.TimeLeft.Kind);
        Assert.Equal(120, e.TimeLeft.Minutes);
    }

    [Fact]
    public void During_downtime_time_left_is_not_the_dormant_allowance()
    {
        // The bug from the first field test: 120 unused minutes must NOT read as "120 left" here.
        var e = Start(DuringDowntime);
        Assert.Equal(TimeLeftKind.Downtime, e.TimeLeft.Kind);
        Assert.Equal(0, e.TimeLeft.Minutes);
        Assert.Equal(new TimeOnly(7, 0), e.TimeLeft.Until);
        Assert.True(e.AllowanceRemainingSeconds > 0);   // the budget is still there, just unreachable
    }

    [Fact]
    public void A_grant_makes_time_left_the_grant_not_the_allowance_sum()
    {
        var e = Start(DuringDowntime);
        Assert.Equal(RedeemResult.Granted, e.TryRedeemGrant(Grant(20, DuringDowntime), DuringDowntime));

        Assert.Equal(TimeLeftKind.Grant, e.TimeLeft.Kind);
        Assert.Equal(20, e.TimeLeft.Minutes);   // 20, not 20 + the 120 dormant allowance
    }

    [Fact]
    public void Exhausted_allowance_reads_as_exhausted_not_a_stale_number()
    {
        var e = Start(MondayMorning);
        e.EndToday();
        Assert.Equal(TimeLeftKind.Exhausted, e.TimeLeft.Kind);
        Assert.Equal(0, e.TimeLeft.Minutes);
    }

    // --- Lock now / Unlock -----------------------------------------------------------

    [Fact]
    public void Lock_blocks_immediately_and_beats_an_active_grant()
    {
        var e = Start(MondayMorning);
        Assert.Equal(RedeemResult.Granted, e.TryRedeemGrant(Grant(30, MondayMorning), MondayMorning));
        Assert.Equal(EnforcementState.GrantActive, e.Tick(MondayMorning, TimeSpan.Zero, true).State);

        e.LockNow();
        var r = e.Tick(MondayMorning.AddSeconds(1), TimeSpan.FromSeconds(1), true);

        Assert.Equal(EnforcementState.Blocked, r.State);
        Assert.Equal(TimeLeftKind.Locked, r.TimeLeft.Kind);
        Assert.True(e.GrantRemainingSeconds > 0);   // the grant is preserved, just overridden
    }

    [Fact]
    public void Unlock_restores_whatever_was_underneath()
    {
        var e = Start(MondayMorning);
        e.LockNow();
        Assert.Equal(EnforcementState.Blocked, e.Tick(MondayMorning.AddSeconds(1), TimeSpan.FromSeconds(1), true).State);

        e.Unlock();
        var r = e.Tick(MondayMorning.AddSeconds(2), TimeSpan.FromSeconds(1), true);
        Assert.Equal(EnforcementState.Active, r.State);
    }

    [Fact]
    public void Lock_auto_releases_at_midnight()
    {
        var beforeMidnight = new DateTimeOffset(2026, 8, 24, 23, 59, 0, TimeSpan.FromHours(2));
        var e = Start(beforeMidnight, new Settings(new TimeOnly(0, 0), new TimeOnly(0, 0), 120, 180));
        e.LockNow();
        Assert.Equal(EnforcementState.Blocked, e.Tick(beforeMidnight.AddSeconds(1), TimeSpan.FromSeconds(1), true).State);

        var afterMidnight = new DateTimeOffset(2026, 8, 25, 0, 1, 0, TimeSpan.FromHours(2));
        var r = e.Tick(afterMidnight, TimeSpan.FromMinutes(2), true);

        Assert.False(e.AdminLocked);
        Assert.Equal(EnforcementState.Active, r.State);
    }

    [Fact]
    public void Lock_survives_a_restart_via_the_snapshot()
    {
        var e = Start(MondayMorning);
        e.LockNow();

        var resumed = new EnforcementEngine(Default, Secret, e.Snapshot());
        Assert.True(resumed.AdminLocked);
        Assert.Equal(EnforcementState.Blocked, resumed.Tick(MondayMorning, TimeSpan.Zero, true).State);
    }

    // --- End Today -------------------------------------------------------------------

    [Fact]
    public void End_today_blocks_now_but_a_grant_still_gives_time_back()
    {
        var e = Start(MondayMorning);
        e.EndToday();
        Assert.Equal(EnforcementState.Blocked, e.Tick(MondayMorning, TimeSpan.Zero, true).State);

        Assert.Equal(RedeemResult.Granted, e.TryRedeemGrant(Grant(10, MondayMorning), MondayMorning));
        var r = e.Tick(MondayMorning, TimeSpan.Zero, true);
        Assert.Equal(EnforcementState.GrantActive, r.State);   // recoverable, unlike a Lock
    }

    [Fact]
    public void End_today_leaves_tomorrows_allowance_untouched()
    {
        var friday = new DateTimeOffset(2026, 8, 21, 10, 0, 0, TimeSpan.FromHours(2));
        var noDowntime = new Settings(new TimeOnly(0, 0), new TimeOnly(0, 0), 120, 180);
        var e = Start(friday, noDowntime);
        e.EndToday();

        // PC off overnight → next run resumes from the snapshot (the realistic model; a single tick
        // is never hours long, the host caps sleep gaps).
        var saturday = new DateTimeOffset(2026, 8, 22, 8, 0, 0, TimeSpan.FromHours(2));
        var resumed = new EnforcementEngine(noDowntime, Secret, e.Snapshot());
        var r = resumed.Tick(saturday, TimeSpan.Zero, true);

        Assert.Equal(EnforcementState.Active, r.State);
        Assert.Equal(180, r.TimeLeft.Minutes);   // fresh weekend allowance
    }
}

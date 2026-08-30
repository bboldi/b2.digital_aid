using DigitalAid.Client.Core;

namespace Client.Core.Tests;

public class EnforcementEngineTests
{
    private const string Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    private const string GrantSeed = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

    private static Settings Default => new(new TimeOnly(21, 0), new TimeOnly(7, 0), 120, 180);
    private static Settings NoDowntime => new(new TimeOnly(0, 0), new TimeOnly(0, 0), 120, 180);

    // Monday 2026-08-24, 10:00, UTC+2 — a plain weekday morning.
    private static DateTimeOffset MondayMorning => new(2026, 8, 24, 10, 0, 0, TimeSpan.FromHours(2));

    /// <summary>First tick establishes state without accruing (zero elapsed).</summary>
    private static EnforcementEngine Start(Settings settings, DateTimeOffset at, bool unlocked = true)
    {
        var e = new EnforcementEngine(settings, Secret, grantSeed: GrantSeed);
        e.Tick(at, TimeSpan.Zero, unlocked);
        return e;
    }

    private static TickResult TickMinutes(EnforcementEngine e, ref DateTimeOffset now, int minutes, bool unlocked = true)
    {
        TickResult result = null!;
        for (var i = 0; i < minutes; i++)
        {
            now = now.AddMinutes(1);
            result = e.Tick(now, TimeSpan.FromMinutes(1), unlocked);
        }
        return result;
    }

    private static string CurrentCode(DateTimeOffset utc) => Totp.CodeAt(Secret, utc);

    /// <summary>A valid Extra Time Code for these minutes at this instant. Off the Grant Seed, not the
    /// Admin Code — the two have nothing to do with each other since ADR-0006.</summary>
    private static string Grant(int minutes, DateTimeOffset at) => GrantCode.Build(GrantSeed, minutes, at);

    /// <summary>Monday 2026-08-24 at the given local hour, on <see cref="Default"/> settings, already
    /// ticked once to establish state — the coupon tests' equivalent of <see cref="Start"/>.</summary>
    private static EnforcementEngine EngineAt(int hour) =>
        Start(Default, new DateTimeOffset(2026, 8, 24, hour, 0, 0, TimeSpan.FromHours(2)));

    /// <summary>Move the engine's local clock to the given hour — same day, or the next day when
    /// <paramref name="nextDay"/> — and tick once. These coupon tests care about which state a tick
    /// lands in, not about accrued elapsed time, so it ticks with zero monotonic elapsed.</summary>
    private static void Tick(EnforcementEngine e, int hour, bool nextDay = false)
    {
        var day = nextDay ? e.Date.AddDays(1) : e.Date;
        var now = new DateTimeOffset(day.Year, day.Month, day.Day, hour, 0, 0, TimeSpan.FromHours(2));
        e.Tick(now, TimeSpan.Zero, true);
    }

    // --- Allowance ------------------------------------------------------------

    [Fact]
    public void Exhausting_weekday_allowance_blocks()
    {
        var now = MondayMorning;
        var e = Start(Default, now);

        var r = TickMinutes(e, ref now, 119);
        Assert.Equal(EnforcementState.Active, r.State);
        Assert.Equal(1, r.RemainingMinutes);

        r = TickMinutes(e, ref now, 1);
        Assert.Equal(EnforcementState.Blocked, r.State);
        Assert.Equal(0, r.RemainingMinutes);
        Assert.Contains(r.Notifications, n => n.Kind == NotificationKind.BlockStarted);
    }

    [Fact]
    public void Locking_pauses_the_counter()
    {
        var now = MondayMorning;
        var e = Start(Default, now);

        TickMinutes(e, ref now, 30);
        var r = TickMinutes(e, ref now, 60, unlocked: false);
        Assert.Equal(EnforcementState.ScreenLocked, r.State);
        Assert.Equal(90, r.RemainingMinutes);  // the locked hour cost nothing

        r = TickMinutes(e, ref now, 1);
        Assert.Equal(EnforcementState.Active, r.State);
    }

    [Fact]
    public void Blocked_time_does_not_burn_allowance()
    {
        var now = new DateTimeOffset(2026, 8, 24, 21, 30, 0, TimeSpan.FromHours(2)); // inside downtime
        var e = Start(Default, now);
        Assert.Equal(EnforcementState.Blocked, e.State);

        var r = TickMinutes(e, ref now, 60);  // an hour of staring at the Block Screen
        Assert.Equal(EnforcementState.Blocked, r.State);
        Assert.Equal(0, e.UsedSeconds);
    }

    // --- Downtime and Grants (precedence: Grant > Downtime > Allowance) --------

    [Fact]
    public void Downtime_blocks_even_with_allowance_left()
    {
        var now = new DateTimeOffset(2026, 8, 24, 20, 58, 0, TimeSpan.FromHours(2));
        var e = Start(Default, now);
        Assert.Equal(EnforcementState.Active, e.State);

        var r = TickMinutes(e, ref now, 2);   // 21:00 — downtime begins
        Assert.Equal(EnforcementState.Blocked, r.State);
        Assert.True(e.AllowanceRemainingSeconds > 0);
    }

    [Fact]
    public void Grant_overrides_downtime_and_ends_back_in_block()
    {
        var now = new DateTimeOffset(2026, 8, 24, 21, 30, 0, TimeSpan.FromHours(2));
        var e = Start(Default, now);
        Assert.Equal(EnforcementState.Blocked, e.State);

        Assert.Equal(RedeemResult.Granted, e.TryRedeemGrant(Grant(30, now), now));
        var r = TickMinutes(e, ref now, 1);
        Assert.Equal(EnforcementState.GrantActive, r.State);
        Assert.Contains(r.Notifications, n => n.Kind == NotificationKind.BlockEnded);

        r = TickMinutes(e, ref now, 29);      // grant window spent
        Assert.Equal(EnforcementState.Blocked, r.State);
        Assert.Contains(r.Notifications, n => n.Kind == NotificationKind.BlockStarted);
    }

    [Fact]
    public void Grant_redeemed_before_downtime_carries_past_its_start()
    {
        var now = new DateTimeOffset(2026, 8, 24, 20, 50, 0, TimeSpan.FromHours(2));
        var e = Start(Default, now);

        Assert.Equal(RedeemResult.Granted, e.TryRedeemGrant(Grant(30, now), now));
        var r = TickMinutes(e, ref now, 20);  // 21:10 — inside downtime, grant still running
        Assert.Equal(EnforcementState.GrantActive, r.State);

        r = TickMinutes(e, ref now, 10);      // 21:20 — window over
        Assert.Equal(EnforcementState.Blocked, r.State);
    }

    [Fact]
    public void Grant_window_elapses_in_real_time_even_while_locked()
    {
        var now = MondayMorning;
        var e = Start(Default, now);
        Assert.Equal(RedeemResult.Granted, e.TryRedeemGrant(Grant(10, now), now));

        TickMinutes(e, ref now, 10, unlocked: false);  // locked through the whole window
        Assert.Equal(0, e.GrantRemainingSeconds);
        Assert.Equal(0, e.UsedSeconds);                // and none of it was Usage Time

        var r = TickMinutes(e, ref now, 1);
        Assert.Equal(EnforcementState.Active, r.State); // back on plain allowance
    }

    // --- Codes: no-reuse, format, validity --------------------------------------

    [Fact]
    public void A_code_cannot_be_reused_for_the_same_purpose()
    {
        var now = MondayMorning;
        var e = Start(Default, now);
        var code = CurrentCode(now);

        Assert.Equal(RedeemResult.Granted, e.TryRedeemGrant(Grant(15, now), now));
        Assert.Equal(RedeemResult.CodeAlreadyUsed, e.TryRedeemGrant(Grant(15, now), now));

        Assert.Equal(RedeemResult.Granted, e.TryAuthorizeExit(code, now));
        Assert.Equal(RedeemResult.CodeAlreadyUsed, e.TryAuthorizeExit(code, now));
    }

    /// <summary>Refusing is not enough — the reason has to be right. The no-reuse slot holds only the
    /// six digits, so a code whose minutes were edited collides with a spent one; reported as
    /// "already used" it reads as a near-miss, when it is a code that was never valid.</summary>
    [Fact]
    public void An_edited_grant_code_is_invalid_not_already_used()
    {
        var now = MondayMorning;
        var e = Start(Default, now);
        var code = Grant(15, now);
        Assert.Equal(RedeemResult.Granted, e.TryRedeemGrant(code, now));

        Assert.Equal(RedeemResult.CodeAlreadyUsed, e.TryRedeemGrant(code, now));
        Assert.Equal(RedeemResult.InvalidCode, e.TryRedeemGrant(code[..6] + "90", now));
    }

    /// <summary>Grant and exit keep separate no-reuse slots. Spending one must not spend the other:
    /// they are different alphabets, and sharing a slot let a Grant silently refuse a legitimate
    /// exit made in the same minute.</summary>
    [Fact]
    public void Redeeming_a_grant_does_not_spend_the_exit_code()
    {
        var now = MondayMorning;
        var e = Start(Default, now);
        var code = CurrentCode(now);

        Assert.Equal(RedeemResult.Granted, e.TryRedeemGrant(Grant(15, now), now));
        Assert.Equal(RedeemResult.Granted, e.TryAuthorizeExit(code, now));
    }

    [Fact]
    public void Both_no_reuse_slots_survive_a_snapshot_round_trip()
    {
        var now = MondayMorning;
        var e = Start(Default, now);
        var code = CurrentCode(now);
        e.TryRedeemGrant(Grant(15, now), now);
        e.TryAuthorizeExit(code, now);

        var restored = new EnforcementEngine(Default, Secret, e.Snapshot(), GrantSeed);
        Assert.Equal(RedeemResult.CodeAlreadyUsed, restored.TryRedeemGrant(Grant(15, now), now));
        Assert.Equal(RedeemResult.CodeAlreadyUsed, restored.TryAuthorizeExit(code, now));
    }

    /// <summary>Re-Pairing checks an Admin Code but must not spend it — burning a no-reuse slot here
    /// would refuse a Grant or an exit made in the same minute for no reason.</summary>
    [Fact]
    public void Verifying_a_family_code_does_not_spend_it()
    {
        var now = MondayMorning;
        var e = Start(Default, now);
        var code = CurrentCode(now);

        Assert.Equal(RedeemResult.Granted, e.VerifyFamilyCode(code, now));
        Assert.Equal(RedeemResult.Granted, e.VerifyFamilyCode(code, now));
        Assert.Equal(RedeemResult.Granted, e.TryAuthorizeExit(code, now));
        Assert.Equal(RedeemResult.Granted, e.TryRedeemGrant(Grant(15, now), now));
    }

    [Fact]
    public void Verifying_rejects_a_wrong_or_malformed_family_code()
    {
        var now = MondayMorning;
        var e = Start(Default, now);
        var wrong = (int.Parse(CurrentCode(now)) + 1) % 1_000_000;

        Assert.Equal(RedeemResult.InvalidFormat, e.VerifyFamilyCode("1234", now));
        Assert.Equal(RedeemResult.InvalidFormat, e.VerifyFamilyCode(null, now));
        Assert.Equal(RedeemResult.InvalidCode, e.VerifyFamilyCode($"{wrong:D6}", now));
    }

    // --- Unconfigured: no secret, no authority (ADR-0007) ------------------------

    /// <summary>The trap this replaces: a Client that lost its state file could not be stopped by
    /// anyone, because verifying the exit code needed the secret that went missing with it.</summary>
    [Fact]
    public void Without_a_secret_anything_exits()
    {
        var now = MondayMorning;
        var e = new EnforcementEngine(Default, "");
        e.Tick(now, TimeSpan.Zero, true);

        Assert.Equal(RedeemResult.Granted, e.TryAuthorizeExit(null, now));
        Assert.Equal(RedeemResult.Granted, e.TryAuthorizeExit("", now));
        Assert.Equal(RedeemResult.Granted, e.TryAuthorizeExit("000000", now));
    }

    /// <summary>Grants go the other way: there is no key to check the code against and no enforced
    /// time to extend, so refusing beats pretending it worked.</summary>
    [Fact]
    public void Without_a_secret_grants_are_refused()
    {
        var now = MondayMorning;
        var e = new EnforcementEngine(Default, "");
        e.Tick(now, TimeSpan.Zero, true);

        Assert.Equal(RedeemResult.InvalidCode, e.TryRedeemGrant(Grant(15, now), now));
        Assert.Equal(RedeemResult.InvalidCode, e.VerifyFamilyCode(CurrentCode(now), now));
    }

    /// <summary>The seed arrives in hello, the Admin Code secret alongside it — but a Client that
    /// has one and not the other must not treat an Extra Time Code as valid on the strength of the wrong
    /// key. Grants gate on the seed, exit on the secret, and neither substitutes for the other.</summary>
    [Fact]
    public void A_secret_without_a_seed_still_refuses_grants()
    {
        var now = MondayMorning;
        var e = new EnforcementEngine(Default, Secret);
        e.Tick(now, TimeSpan.Zero, true);

        Assert.Equal(RedeemResult.InvalidCode, e.TryRedeemGrant(Grant(15, now), now));
        Assert.Equal(RedeemResult.Granted, e.TryAuthorizeExit(CurrentCode(now), now));
    }

    [Fact]
    public void Wrong_or_malformed_codes_are_rejected()
    {
        var now = MondayMorning;
        var e = Start(Default, now);
        var wrong = (int.Parse(CurrentCode(now)) + 1) % 1_000_000;

        Assert.Equal(RedeemResult.InvalidCode, e.TryRedeemGrant("00000015", now));  // right shape, wrong digits
        Assert.Equal(RedeemResult.InvalidFormat, e.TryRedeemGrant(CurrentCode(now), now)); // bare code is not a grant
        Assert.Equal(RedeemResult.InvalidFormat, e.TryAuthorizeExit("12345", now));
        Assert.Equal(RedeemResult.InvalidCode, e.TryAuthorizeExit($"{wrong:D6}", now));
    }

    // --- Adjustments -------------------------------------------------------------

    [Fact]
    public void Positive_adjustment_behaves_like_a_grant_during_downtime()
    {
        var now = new DateTimeOffset(2026, 8, 24, 21, 30, 0, TimeSpan.FromHours(2));
        var e = Start(Default, now);
        Assert.Equal(EnforcementState.Blocked, e.State);

        e.ApplyAdjustment(20);
        var r = TickMinutes(e, ref now, 1);
        Assert.Equal(EnforcementState.GrantActive, r.State);
    }

    [Fact]
    public void Negative_adjustment_that_empties_time_blocks_after_one_minute_grace()
    {
        var now = MondayMorning;
        var e = Start(Default, now);

        e.ApplyAdjustment(-999);
        Assert.Equal(0, e.AllowanceRemainingSeconds);
        Assert.Equal(60, e.GrantRemainingSeconds);     // the grace minute (PRD §6.2)

        now = now.AddSeconds(1);
        var r = e.Tick(now, TimeSpan.FromSeconds(1), true);
        Assert.Equal(EnforcementState.GrantActive, r.State);
        Assert.Contains(r.Notifications, n => n.Kind == NotificationKind.Warning5);

        r = TickMinutes(e, ref now, 1);
        Assert.Equal(EnforcementState.Blocked, r.State);
    }

    [Fact]
    public void Negative_adjustment_drains_grant_before_allowance()
    {
        var now = MondayMorning;
        var e = Start(Default, now);
        e.ApplyAdjustment(10);                          // grant: 10 min
        e.ApplyAdjustment(-4);
        Assert.Equal(6 * 60, e.GrantRemainingSeconds);  // grant absorbed it
        Assert.Equal(0, e.UsedSeconds);                 // allowance untouched

        e.ApplyAdjustment(-16);                         // 6 from grant, 10 from allowance
        Assert.Equal(0, e.GrantRemainingSeconds);
        Assert.Equal(110, e.RemainingMinutes);
    }

    // --- Day boundary --------------------------------------------------------------

    [Fact]
    public void Midnight_resets_the_counter_and_switches_to_the_weekend_rate()
    {
        var now = new DateTimeOffset(2026, 8, 21, 23, 30, 0, TimeSpan.FromHours(2)); // Friday night
        var e = Start(NoDowntime, now);

        var r = TickMinutes(e, ref now, 30);            // lands exactly on Saturday 00:00
        Assert.Contains(r.Notifications, n => n.Kind == NotificationKind.DateRolled);
        Assert.Equal(new DateOnly(2026, 8, 22), e.Date);
        Assert.Equal(179, r.RemainingMinutes);          // fresh weekend allowance minus the straddling minute
    }

    // --- Clock tampering -------------------------------------------------------------

    [Fact]
    public void Wall_clock_jump_is_detected_but_erases_no_minutes()
    {
        var now = MondayMorning;
        var e = Start(Default, now);
        TickMinutes(e, ref now, 30);

        // Wall clock leaps two hours while only one minute really passed.
        now = now.AddHours(2);
        var r = e.Tick(now, TimeSpan.FromMinutes(1), true);
        var jump = Assert.Single(r.Notifications, n => n.Kind == NotificationKind.ClockJump);
        Assert.InRange(jump.DeltaSeconds, 7130, 7150);
        Assert.Equal(31 * 60, e.UsedSeconds);           // monotonic accrual unaffected
    }

    // --- Warnings ------------------------------------------------------------------

    [Fact]
    public void Warnings_fire_once_at_15_and_5_minutes_remaining()
    {
        var now = MondayMorning;
        var e = Start(Default, now);

        var r = TickMinutes(e, ref now, 105);           // 15 minutes left
        Assert.Contains(r.Notifications, n => n.Kind == NotificationKind.Warning15);
        r = TickMinutes(e, ref now, 1);
        Assert.DoesNotContain(r.Notifications, n => n.Kind == NotificationKind.Warning15);

        r = TickMinutes(e, ref now, 9);                 // 5 minutes left
        Assert.Contains(r.Notifications, n => n.Kind == NotificationKind.Warning5);
        r = TickMinutes(e, ref now, 1);
        Assert.DoesNotContain(r.Notifications, n => n.Kind == NotificationKind.Warning5);
    }

    [Fact]
    public void Approaching_downtime_warns_even_with_plenty_of_allowance()
    {
        var now = new DateTimeOffset(2026, 8, 24, 20, 44, 0, TimeSpan.FromHours(2));
        var e = Start(Default, now);

        var r = TickMinutes(e, ref now, 1);             // 20:45 — 15 minutes to downtime
        Assert.Contains(r.Notifications, n => n.Kind == NotificationKind.Warning15);
        Assert.True(e.AllowanceRemainingSeconds > 100 * 60);
    }

    [Fact]
    public void A_warning_says_which_limit_is_coming()
    {
        // Running out of the day's Allowance, with Downtime hours away.
        var now = MondayMorning;
        var e = Start(Default, now);
        var r = TickMinutes(e, ref now, 105);
        var spent = Assert.Single(r.Notifications, n => n.Kind == NotificationKind.Warning15);
        Assert.Equal(BlockCause.TimeRunningOut, spent.Cause);

        // Reaching Downtime with most of the Allowance untouched.
        now = new DateTimeOffset(2026, 8, 24, 20, 44, 0, TimeSpan.FromHours(2));
        e = Start(Default, now);
        r = TickMinutes(e, ref now, 1);
        var bedtime = Assert.Single(r.Notifications, n => n.Kind == NotificationKind.Warning15);
        Assert.Equal(BlockCause.Downtime, bedtime.Cause);
    }

    /// <summary>A Grant is reported as time running out, not as whatever would have blocked the
    /// machine underneath it. The window is what is emptying, and a Grant beats Downtime anyway.</summary>
    [Fact]
    public void A_grant_running_out_next_to_downtime_still_says_time_is_running_out()
    {
        var now = new DateTimeOffset(2026, 8, 24, 20, 30, 0, TimeSpan.FromHours(2));
        var e = Start(Default, now);
        e.ApplyAdjustment(40);                          // carries past Downtime at 21:00

        var r = TickMinutes(e, ref now, 25);            // 20:55 — 15 minutes of Grant left
        var warning = Assert.Single(r.Notifications, n => n.Kind == NotificationKind.Warning15);
        Assert.Equal(EnforcementState.GrantActive, e.State);
        Assert.Equal(BlockCause.TimeRunningOut, warning.Cause);
    }

    /// <summary>The cause is read at each firing, never latched at the first. A locked screen is what
    /// makes the two disagree without anything re-arming them: the Allowance stops draining while
    /// Downtime keeps coming, so the kid who walked away with the Allowance as their nearer limit
    /// comes back to Downtime being it. The five-minute warning has to say what is true when it
    /// fires, not repeat what was true fifteen minutes earlier.</summary>
    [Fact]
    public void The_cause_is_recomputed_at_each_warning()
    {
        // 20:30 with Downtime at 21:00, cut down to 14 minutes of Allowance: the nearer limit.
        var now = new DateTimeOffset(2026, 8, 24, 20, 30, 0, TimeSpan.FromHours(2));
        var e = Start(Default, now);
        e.ApplyAdjustment(-(120 - 14));

        var r = TickMinutes(e, ref now, 1);              // 20:31 — 13 min of Allowance, 29 to Downtime
        var first = Assert.Single(r.Notifications, n => n.Kind == NotificationKind.Warning15);
        Assert.Equal(BlockCause.TimeRunningOut, first.Cause);

        // Screen locked: the kid steps away. The Allowance is frozen, Downtime is not.
        TickMinutes(e, ref now, 24, unlocked: false);    // 20:55

        r = TickMinutes(e, ref now, 1);                  // 20:56 — 13 min of Allowance, 4 to Downtime
        var second = Assert.Single(r.Notifications, n => n.Kind == NotificationKind.Warning5);
        Assert.Equal(BlockCause.Downtime, second.Cause);
        Assert.True(e.AllowanceRemainingSeconds > 5 * 60, "the Allowance was never the thing running out");

        // Nothing re-armed on the way: the fifteen-minute warning fired once, under the other cause.
        Assert.DoesNotContain(r.Notifications, n => n.Kind == NotificationKind.Warning15);
    }

    [Fact]
    public void A_grant_rearms_the_warnings()
    {
        var now = MondayMorning;
        var e = Start(Default, now);
        TickMinutes(e, ref now, 105);                   // Warning15 fired

        Assert.Equal(RedeemResult.Granted, e.TryRedeemGrant(Grant(60, now), now));
        TickMinutes(e, ref now, 59);                    // grant nearly spent again
        var r = TickMinutes(e, ref now, 1);             // hits the 15-min-left edge... of allowance now
        // after the grant: allowance had 15 left when granted, unchanged accrual continued during grant
        Assert.Equal(EnforcementState.Blocked, r.State); // 15 allowance - 60 grant-minutes of use → exhausted
    }

    // --- Persistence -----------------------------------------------------------------

    [Fact]
    public void Snapshot_roundtrip_resumes_exactly()
    {
        var now = MondayMorning;
        var e = Start(Default, now);
        TickMinutes(e, ref now, 45);
        Assert.Equal(RedeemResult.Granted, e.TryRedeemGrant(Grant(10, now), now));

        var resumed = new EnforcementEngine(Default, Secret, e.Snapshot());
        var r = resumed.Tick(now, TimeSpan.Zero, true);

        Assert.Equal(e.UsedSeconds, resumed.UsedSeconds);
        Assert.Equal(e.GrantRemainingSeconds, resumed.GrantRemainingSeconds);
        Assert.Equal(e.LastRedeemedCode, resumed.LastRedeemedCode);
        Assert.Equal(EnforcementState.GrantActive, r.State);
        Assert.DoesNotContain(r.Notifications, n => n.Kind == NotificationKind.DateRolled); // same day
    }

    // --- Running low ---------------------------------------------------------------
    // The tray goes amber off the same number the 15-minute warning uses. Two separate notions of
    // "fifteen minutes" would agree right up until Downtime got involved, and then quietly stop.

    [Fact]
    public void Nothing_is_running_low_with_the_whole_allowance_ahead()
    {
        var now = MondayMorning;
        var engine = Start(NoDowntime, now);

        Assert.True(engine.SecondsUntilBlock(now) > 15 * 60);
    }

    [Fact]
    public void The_last_quarter_hour_of_the_allowance_is_running_low()
    {
        var now = MondayMorning;
        var engine = Start(NoDowntime, now);           // 120 weekday minutes
        TickMinutes(engine, ref now, 104);

        Assert.True(engine.SecondsUntilBlock(now) > 15 * 60, "16 minutes left is not yet low");

        TickMinutes(engine, ref now, 2);
        Assert.True(engine.SecondsUntilBlock(now) <= 15 * 60);
    }

    /// <summary>The case that makes this worth exposing rather than deriving from remaining minutes:
    /// an hour of Allowance in the bank is no use at 20:50 when Downtime starts at 21:00.</summary>
    [Fact]
    public void Downtime_closing_in_counts_as_running_low_however_much_allowance_is_left()
    {
        // Monday 20:50, ten minutes before the 21:00 Downtime, with the day barely touched.
        var now = new DateTimeOffset(2026, 8, 24, 20, 50, 0, TimeSpan.FromHours(2));
        var engine = Start(Default, now);

        Assert.True(engine.AllowanceRemainingSeconds > 60 * 60, "plenty of allowance");
        Assert.True(engine.SecondsUntilBlock(now) <= 15 * 60, "but not plenty of evening");
    }

    [Fact]
    public void A_machine_that_is_not_counting_has_no_countdown()
    {
        var now = MondayMorning;

        var locked = Start(NoDowntime, now, unlocked: false);
        Assert.Equal(EnforcementState.ScreenLocked, locked.State);
        Assert.Equal(-1, locked.SecondsUntilBlock(now));

        // 21:30, inside Downtime: already blocked, so there is nothing to count down to.
        var night = new DateTimeOffset(2026, 8, 24, 21, 30, 0, TimeSpan.FromHours(2));
        var blocked = Start(Default, night);
        Assert.Equal(EnforcementState.Blocked, blocked.State);
        Assert.Equal(-1, blocked.SecondsUntilBlock(night));
    }

    // --- Time Coupons: an Allowance top-up, never a Grant (ADR-0017) --------------------

    [Fact]
    public void Coupon_bonus_extends_todays_allowance()
    {
        var engine = EngineAt(hour: 10);
        var before = engine.AllowanceRemainingSeconds;
        engine.AddAllowanceBonus(30);
        Assert.Equal(before + 30 * 60, engine.AllowanceRemainingSeconds);
        Assert.Equal(TimeLeftKind.Allowance, engine.TimeLeft.Kind);
    }

    [Fact]
    public void Coupon_bonus_unblocks_an_exhausted_allowance_but_not_downtime()
    {
        var engine = EngineAt(hour: 10);
        engine.EndToday();
        Tick(engine, hour: 10);
        Assert.Equal(EnforcementState.Blocked, engine.State);

        engine.AddAllowanceBonus(30);
        Tick(engine, hour: 10);
        Assert.Equal(EnforcementState.Active, engine.State);   // beats an empty Allowance…

        Tick(engine, hour: 22);                                // …but Downtime still wins
        Assert.Equal(EnforcementState.Blocked, engine.State);
    }

    [Fact]
    public void Coupon_bonus_dies_at_local_midnight()
    {
        var engine = EngineAt(hour: 10);
        engine.AddAllowanceBonus(30);
        Tick(engine, hour: 10, nextDay: true);                 // date rolls
        Assert.Equal(0, engine.BonusSeconds);
    }

    [Fact]
    public void EndToday_drains_the_bonus_too()
    {
        // "Drain the rest of today's Time Left" (CONTEXT.md: End Today) — all of it, coupons included.
        var engine = EngineAt(hour: 10);
        engine.AddAllowanceBonus(30);
        engine.EndToday();
        Assert.Equal(0, engine.AllowanceRemainingSeconds);
    }

    [Fact]
    public void Bonus_survives_a_snapshot_round_trip()
    {
        var engine = EngineAt(hour: 10);
        engine.AddAllowanceBonus(30);
        var restored = new EnforcementEngine(Default, Secret, engine.Snapshot());
        Assert.Equal(engine.BonusSeconds, restored.BonusSeconds);
    }
}

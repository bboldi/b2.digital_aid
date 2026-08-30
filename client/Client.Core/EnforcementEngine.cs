namespace DigitalAid.Client.Core;

/// <summary>What the machine is doing right now. <see cref="ScreenLocked"/> is the *Windows* session
/// being locked — the kid stepped away, and the clock stops. It is emphatically not an Admin Lock,
/// which beats everything and lands in <see cref="Blocked"/>: the two used to share the name
/// "Locked" across two enums with opposite meanings, which is a bad thing to discover at 2am.
/// The wire value stays "locked" (PROTOCOL §7.1) — 30 days of stored pings say so.</summary>
public enum EnforcementState { Active, ScreenLocked, Blocked, GrantActive }

public enum NotificationKind { Warning15, Warning5, BlockStarted, BlockEnded, DateRolled, ClockJump }

/// <summary>Which of the two futures is about to take the machine away. The Block Screen is reached
/// either by spending the day's time or by arriving at Downtime, and those are different things to
/// tell a kid — the same distinction the two Block Screen Background variants already draw without
/// words. Only the warnings carry it; once the cover is up, why it went up is yesterday's news.
///
/// A running Grant reads as <see cref="TimeRunningOut"/>: the grant window is the thing emptying, and
/// which bucket it came out of is not something the kid needs to hear about.</summary>
public enum BlockCause { TimeRunningOut, Downtime }

public readonly record struct Notification(
    NotificationKind Kind, double DeltaSeconds = 0, BlockCause Cause = BlockCause.TimeRunningOut);

/// <summary>Why the machine is (or isn't) usable right now, and for how long — the basis of
/// "Time Left" (PRD §3.1). Never reports dormant Allowance that Downtime makes unreachable.</summary>
public enum TimeLeftKind
{
    Grant,       // usable on an active Grant; Minutes = grant minutes left
    Allowance,   // usable on the normal Allowance; Minutes = allowance minutes left
    Downtime,    // blocked by Downtime; Until = when it ends
    Exhausted,   // blocked, today's Allowance is spent
    Locked,      // blocked by an Admin Lock — *not* the same as EnforcementState.ScreenLocked
}

public readonly record struct TimeLeft(TimeLeftKind Kind, int Minutes, TimeOnly? Until)
{
    public bool Usable => Kind is TimeLeftKind.Grant or TimeLeftKind.Allowance;
}

public sealed record TickResult(EnforcementState State, TimeLeft TimeLeft, IReadOnlyList<Notification> Notifications)
{
    /// <summary>Minutes usable right now — 0 when blocked. This is what a Ping reports and what the
    /// server/Flyout show; it is never the raw budget (PRD §3.1).</summary>
    public int RemainingMinutes => TimeLeft.Minutes;
}

public enum RedeemResult { Granted, InvalidFormat, InvalidCode, CodeAlreadyUsed }

/// <summary>Persistable counter state — everything the engine must not lose across restarts (PRD §6.2).</summary>
public sealed record EngineSnapshot(
    DateOnly Date, int UsedSeconds, double GrantRemainingSeconds, string? LastRedeemedCode,
    bool AdminLocked = false, string? LastExitCode = null, int BonusSeconds = 0);

/// <summary>
/// The enforcement state machine. Pure logic: the host calls <see cref="Tick"/> with the local
/// wall clock, the monotonic elapsed time since the previous tick, and the session state; the
/// engine answers with the state to enforce. Precedence: Grant &gt; Downtime &gt; Allowance (PRD §3).
///
/// Usage accrues on the monotonic clock — wall-clock changes shift dates and windows but can
/// never erase minutes (PRD §6.5). A Grant is a real-time window from redemption: it counts
/// down monotonically whether or not the session is unlocked, and survives midnight.
/// </summary>
public sealed class EnforcementEngine
{
    private const double ClockJumpThresholdSeconds = 90;
    /// <summary>The one place "running low" is defined. The tray reads it too, so the icon and the
    /// toast agree about when that starts.</summary>
    public const int Warn15Seconds = 15 * 60;
    private const int Warn5Seconds = 5 * 60;

    private DateTimeOffset? _lastWallTime;
    private TimeOnly _lastLocalTime;
    private bool _warned15;
    private bool _warned5;

    public Settings Settings { get; private set; }
    public string FamilyCodeSecret { get; private set; }
    /// <summary>The household's Grant Seed (hex), the key behind every Extra Time Code (ADR-0006). Held
    /// apart from the Admin Code secret because they answer different questions: this one grants
    /// time and is never typed, that one exits the app and comes off a phone.</summary>
    public string GrantSeed { get; private set; }
    public DateOnly Date { get; private set; }
    public int UsedSeconds { get; private set; }
    public double GrantRemainingSeconds { get; private set; }
    public string? LastRedeemedCode { get; private set; }
    /// <summary>Kept apart from <see cref="LastRedeemedCode"/> on purpose. The two are different
    /// alphabets — an Extra Time Code's digits come off the Grant Seed, an exit code off the Admin Code
    /// secret — so sharing one no-reuse slot would let a coincidental collision refuse a valid exit,
    /// and would let redeeming a Grant silently spend the exit code for that minute.</summary>
    public string? LastExitCode { get; private set; }
    /// <summary>An Admin "Lock now" is in force (PRD §3.2). Auto-released at local midnight.</summary>
    public bool AdminLocked { get; private set; }
    public EnforcementState State { get; private set; } = EnforcementState.ScreenLocked;

    /// <summary>Today's Time Coupon top-up, in seconds (ADR-0017). Part of the Allowance rather
    /// than a Grant on purpose: it pauses on lock, Downtime beats it, and it dies at local
    /// midnight — a standing promise carries no live parental intent, and only live intent beats
    /// Downtime. Redeemed coupons land here via <see cref="AddAllowanceBonus"/>.</summary>
    public int BonusSeconds { get; private set; }

    public EnforcementEngine(Settings settings, string familyCodeSecret, EngineSnapshot? snapshot = null,
        string grantSeed = "")
    {
        Settings = settings;
        FamilyCodeSecret = familyCodeSecret;
        GrantSeed = grantSeed;
        Date = snapshot?.Date ?? DateOnly.MinValue;
        UsedSeconds = snapshot?.UsedSeconds ?? 0;
        GrantRemainingSeconds = snapshot?.GrantRemainingSeconds ?? 0;
        LastRedeemedCode = snapshot?.LastRedeemedCode;
        LastExitCode = snapshot?.LastExitCode;
        AdminLocked = snapshot?.AdminLocked ?? false;
        BonusSeconds = snapshot?.BonusSeconds ?? 0;
    }

    public EngineSnapshot Snapshot() =>
        new(Date, UsedSeconds, GrantRemainingSeconds, LastRedeemedCode, AdminLocked, LastExitCode, BonusSeconds);

    public int AllowanceRemainingSeconds =>
        Math.Max(0, Settings.AllowanceMinutesFor(Date) * 60 + BonusSeconds - UsedSeconds);

    /// <summary>What the kid can use right now, and for how long — never dormant Allowance that
    /// Downtime makes unreachable (PRD §3.1). The single source for the Ping, the Flyout, the server.</summary>
    public TimeLeft TimeLeft
    {
        get
        {
            if (AdminLocked) return new TimeLeft(TimeLeftKind.Locked, 0, null);
            
            var grantMinutes = (int)GrantRemainingSeconds / 60;
            var allowanceMinutes = AllowanceRemainingSeconds / 60;
            
            if (Settings.IsDowntime(_lastLocalTime))
            {
                if (grantMinutes > 0) return new TimeLeft(TimeLeftKind.Grant, grantMinutes, null);
                return new TimeLeft(TimeLeftKind.Downtime, 0, Settings.DowntimeEnd);
            }
            
            if (allowanceMinutes > 0 && allowanceMinutes >= grantMinutes)
                return new TimeLeft(TimeLeftKind.Allowance, allowanceMinutes, null);
                
            if (grantMinutes > 0)
                return new TimeLeft(TimeLeftKind.Grant, grantMinutes, null);
                
            return new TimeLeft(TimeLeftKind.Exhausted, 0, null);
        }
    }

    public int RemainingMinutes => TimeLeft.Minutes;

    public void UpdateSettings(Settings settings)
    {
        Settings = settings;
        ResetWarnings();
    }

    public void UpdateFamilyCodeSecret(string base32Secret) => FamilyCodeSecret = base32Secret;

    public void UpdateGrantSeed(string hexSeed) => GrantSeed = hexSeed;

    public TickResult Tick(DateTimeOffset localNow, TimeSpan monotonicElapsed, bool sessionUnlocked)
    {
        var notifications = new List<Notification>();

        if (_lastWallTime is { } lastWall)
        {
            var drift = (localNow - lastWall - monotonicElapsed).TotalSeconds;
            if (Math.Abs(drift) > ClockJumpThresholdSeconds)
                notifications.Add(new Notification(NotificationKind.ClockJump, drift));
        }
        _lastWallTime = localNow;
        _lastLocalTime = TimeOnly.FromDateTime(localNow.DateTime);

        var today = DateOnly.FromDateTime(localNow.DateTime);
        if (today != Date)
        {
            Date = today;
            UsedSeconds = 0;
            BonusSeconds = 0;
            AdminLocked = false;   // a forgotten Lock never eats the next day (PRD §3.2)
            ResetWarnings();
            notifications.Add(new Notification(NotificationKind.DateRolled));
        }

        // Usage accrues for time the machine was actually usable — i.e. the state the
        // *previous* tick established. Blocked-but-unlocked time is not Usage Time.
        if (sessionUnlocked && State is EnforcementState.Active or EnforcementState.GrantActive)
            UsedSeconds += (int)Math.Round(monotonicElapsed.TotalSeconds);

        // The Grant window elapses in real time, locked or not (CONTEXT.md: Grant).
        GrantRemainingSeconds = Math.Max(0, GrantRemainingSeconds - monotonicElapsed.TotalSeconds);

        var previous = State;
        State = ComputeState(localNow, sessionUnlocked);

        if (State == EnforcementState.Blocked && previous != EnforcementState.Blocked)
            notifications.Add(new Notification(NotificationKind.BlockStarted));
        if (previous == EnforcementState.Blocked && State != EnforcementState.Blocked)
        {
            notifications.Add(new Notification(NotificationKind.BlockEnded));
            ResetWarnings();
        }

        EmitWarnings(localNow, notifications);
        return new TickResult(State, TimeLeft, notifications);
    }

    /// <summary>Admin "Lock now": an immediate held block that beats everything, including a Grant
    /// (PRD §3.2). Released by <see cref="Unlock"/> or automatically at local midnight.</summary>
    public void LockNow() => AdminLocked = true;

    public void Unlock()
    {
        AdminLocked = false;
        ResetWarnings();
    }

    /// <summary>Admin "End Today": drain the rest of today's Time Left — exhaust the Allowance and
    /// clear any Grant, so the Client blocks now. A fresh Grant can still give time back (PRD §3.2).</summary>
    public void EndToday()
    {
        UsedSeconds = Settings.AllowanceMinutesFor(Date) * 60 + BonusSeconds;
        GrantRemainingSeconds = 0;
    }

    /// <summary>Redeem Grant input (<c>[6-digit code][1–3 digit minutes]</c>) typed on this Client.</summary>
    public RedeemResult TryRedeemGrant(string? input, DateTimeOffset utcNow)
    {
        if (!GrantCode.TryParse(input, out var code, out var minutes)) return RedeemResult.InvalidFormat;
        // Unconfigured (ADR-0007), or paired but not yet told the seed: nothing to grant time
        // against. Refusing beats pretending, and it clears as soon as the next hello lands.
        if (string.IsNullOrEmpty(GrantSeed)) return RedeemResult.InvalidCode;
        // Signature before no-reuse, because the no-reuse slot holds only the six digits: a code
        // whose *minutes* were edited collides with it and would be reported as "already used",
        // telling a kid that tampering with a spent code is the near-miss it is not.
        if (!GrantCode.Verify(input, GrantSeed, utcNow)) return RedeemResult.InvalidCode;
        if (code == LastRedeemedCode) return RedeemResult.CodeAlreadyUsed;

        LastRedeemedCode = code;
        GrantRemainingSeconds += minutes * 60;
        ResetWarnings();
        return RedeemResult.Granted;
    }

    /// <summary>Exit protection: a bare 6-digit Admin Code, subject to its own no-reuse rule (PRD §6.2).
    ///
    /// Unconfigured (ADR-0007): with no secret there is nobody to ask for permission to stop, and
    /// nothing being enforced that stopping would release. Any input, including none, is accepted —
    /// the alternative is an app that cannot be turned off by anyone, which is what this replaces.</summary>
    public RedeemResult TryAuthorizeExit(string? input, DateTimeOffset utcNow)
    {
        if (string.IsNullOrEmpty(FamilyCodeSecret)) return RedeemResult.Granted;

        var code = input?.Trim() ?? string.Empty;
        if (code.Length != 6 || !code.All(char.IsAsciiDigit)) return RedeemResult.InvalidFormat;
        // Same order as grants: prove the code first, then ask whether it has been spent.
        if (!Totp.Verify(code, FamilyCodeSecret, utcNow)) return RedeemResult.InvalidCode;
        if (code == LastExitCode) return RedeemResult.CodeAlreadyUsed;

        LastExitCode = code;
        return RedeemResult.Granted;
    }

    /// <summary>Check an Admin Code without spending it — used to authorise re-Pairing, which is not
    /// a Grant and not an exit. Deliberately does not touch the no-reuse slots: burning one here
    /// would silently refuse a legitimate Grant or exit made in the same minute.</summary>
    public RedeemResult VerifyFamilyCode(string? input, DateTimeOffset utcNow)
    {
        var code = input?.Trim() ?? string.Empty;
        if (code.Length != 6 || !code.All(char.IsAsciiDigit)) return RedeemResult.InvalidFormat;
        return Totp.Verify(code, FamilyCodeSecret, utcNow) ? RedeemResult.Granted : RedeemResult.InvalidCode;
    }

    /// <summary>A Time Coupon the server accepted. Top-up only — the server has already spent the
    /// coupon, so this must not fail; clamping happened at minting.</summary>
    public void AddAllowanceBonus(int minutes)
    {
        BonusSeconds += minutes * 60;
        ResetWarnings();
    }

    /// <summary>Server-side Adjustment, ± minutes (PROTOCOL §6.4). Positive behaves exactly like a Grant;
    /// negative drains the Grant first, then the Allowance.</summary>
    public void ApplyAdjustment(int minutes)
    {
        if (minutes > 0)
        {
            GrantRemainingSeconds += minutes * 60;
            ResetWarnings();
            return;
        }
        var toRemove = (double)(-minutes * 60);
        var fromGrant = Math.Min(GrantRemainingSeconds, toRemove);
        GrantRemainingSeconds -= fromGrant;
        UsedSeconds += (int)(toRemove - fromGrant);

        // Emptying remaining time blocks "after a brief warning", not instantly (PRD §6.2):
        // leave one minute of grace, which also triggers the 5-minute warning path.
        if (GrantRemainingSeconds <= 0 && AllowanceRemainingSeconds <= 0)
            GrantRemainingSeconds = 60;
    }

    private EnforcementState ComputeState(DateTimeOffset localNow, bool sessionUnlocked)
    {
        if (!sessionUnlocked) return EnforcementState.ScreenLocked;
        if (AdminLocked) return EnforcementState.Blocked;   // Lock beats everything, including a Grant
        if (GrantRemainingSeconds > 0) return EnforcementState.GrantActive;
        if (Settings.IsDowntime(TimeOnly.FromDateTime(localNow.DateTime))) return EnforcementState.Blocked;
        if (AllowanceRemainingSeconds <= 0) return EnforcementState.Blocked;
        return EnforcementState.Active;
    }

    /// <summary>Seconds until the Block Screen would appear on the current trajectory, or -1 when it
    /// is already up or the machine is not counting. Not the same as remaining minutes: an Allowance
    /// with an hour left still runs out in ten minutes if Downtime starts then, and the warnings have
    /// always understood that. Exposed so the tray can go amber at the same instant the 15-minute
    /// warning fires, rather than at a second, subtly different fifteen minutes.</summary>
    public int SecondsUntilBlock(DateTimeOffset localNow) =>
        State is EnforcementState.Active or EnforcementState.GrantActive
            ? SecondsUntilBlockCore(localNow)
            : -1;

    private int SecondsUntilBlockCore(DateTimeOffset localNow) => HorizonCore(localNow).Seconds;

    /// <summary>How long the machine stays usable, and which of the two limits ends it. The seconds
    /// were always a <c>Math.Min</c> of the two; this keeps hold of which side won, so the shell can
    /// say so instead of working it out a second time and getting a subtly different answer.</summary>
    private BlockHorizon HorizonCore(DateTimeOffset localNow)
    {
        var untilDowntime = Settings.SecondsUntilDowntime(TimeOnly.FromDateTime(localNow.DateTime));
        var effectiveAllowance = Math.Min(untilDowntime, AllowanceRemainingSeconds);
        
        if (State == EnforcementState.GrantActive && GrantRemainingSeconds > effectiveAllowance)
            return new BlockHorizon((int)GrantRemainingSeconds, BlockCause.TimeRunningOut);

        // A tie goes to the Allowance: both are true at that instant, and "time left" is the message
        // that stays true a second later, whichever one the next tick lands on.
        return untilDowntime < AllowanceRemainingSeconds
            ? new BlockHorizon(untilDowntime, BlockCause.Downtime)
            : new BlockHorizon(AllowanceRemainingSeconds, BlockCause.TimeRunningOut);
    }

    private readonly record struct BlockHorizon(int Seconds, BlockCause Cause);

    private void EmitWarnings(DateTimeOffset localNow, List<Notification> notifications)
    {
        if (State is not (EnforcementState.Active or EnforcementState.GrantActive)) return;

        var (untilBlock, cause) = HorizonCore(localNow);

        if (untilBlock > Warn15Seconds) { ResetWarnings(); return; }  // headroom again (grant/adjust) re-arms warnings

        // The cause is read at each firing rather than latched at the first. Give a kid 30 minutes at
        // 20:50 with Downtime at 21:00 and the 15-minute warning honestly said "time"; the 5-minute
        // one honestly says "downtime". Latching would have made one of the two a lie.
        if (!_warned15 && untilBlock > Warn5Seconds)
        {
            _warned15 = true;
            notifications.Add(new Notification(NotificationKind.Warning15, Cause: cause));
        }
        if (!_warned5 && untilBlock <= Warn5Seconds)
        {
            _warned15 = true;   // don't fire a stale 15-minute warning after the 5-minute one
            _warned5 = true;
            notifications.Add(new Notification(NotificationKind.Warning5, Cause: cause));
        }
    }

    private void ResetWarnings()
    {
        _warned15 = false;
        _warned5 = false;
    }
}

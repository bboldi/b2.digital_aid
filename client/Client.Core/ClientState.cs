using System.Text.Json.Serialization;

namespace DigitalAid.Client.Core;

/// <summary>
/// Everything the Client must remember across restarts, in one file.
///
/// The Client Token and <see cref="NextSeq"/> deliberately live together (ADR-0001): losing this
/// file un-pairs the Client, and re-pairing allocates a fresh <c>client_id</c> server-side, so a
/// reset sequence counter can never collide with Events the server already holds. Do not split them.
/// </summary>
public sealed record ClientState
{
    /// <summary>Server base URL this Client paired with, e.g. <c>https://aid.example.com</c>.</summary>
    public string? ServerUrl { get; init; }

    /// <summary>The permanent Client Token from pairing. Null means not paired yet.</summary>
    public string? ClientToken { get; init; }

    /// <summary>Server-side Client id, for diagnostics only — the token is the credential.</summary>
    public int ClientId { get; init; }

    /// <summary>Next Event sequence number to allocate. Per-Client monotonic, starts at 1.</summary>
    public long NextSeq { get; init; } = 1;

    /// <summary>Admin Code TOTP secret (base32), cached so Grants and exit work offline.</summary>
    public string? FamilyCodeSecret { get; init; }

    /// <summary>Grant Seed (hex), the key behind every Extra Time Code — cached so extra time can be
    /// granted with the server unreachable, which is when it is most often needed (ADR-0006).</summary>
    public string? GrantSeed { get; init; }

    /// <summary>Last enforcement settings received; the offline enforcement truth.</summary>
    public PersistedSettings Settings { get; init; } = PersistedSettings.From(Core.Settings.Default);

    /// <summary>Counter state: date, seconds used, active Grant, last redeemed code.</summary>
    public PersistedSnapshot Counters { get; init; } = PersistedSnapshot.From(
        new EngineSnapshot(DateOnly.MinValue, 0, 0, null));

    /// <summary>Set by a <c>kill</c> command; a relaunch that sees it exits immediately (PRD §5.3).</summary>
    public bool Disabled { get; init; }

    /// <summary>Version this build recorded last run, for <c>update-installed</c> reporting.</summary>
    public string? LastVersion { get; init; }

    /// <summary>When this Client last reached the server, as a local timestamp with offset. Null means
    /// never. An offline Client enforces its last-known settings indefinitely and deliberately — the
    /// alternative rewards keeping the PC off the network — so how stale those settings are is
    /// something the Flyout and <c>--status</c> have to be able to say out loud.</summary>
    public string? LastServerContact { get; init; }

    /// <summary>The language this PC shows, <c>en</c> or <c>hu</c>. Null until someone or something
    /// has chosen: the first run reads the Windows display language once and writes a concrete value
    /// here, and from then on this wins whatever Windows is set to.
    ///
    /// It is stored here, and not sent by the server, because language is a property of whoever is at
    /// the keyboard rather than policy the kid must not control (ADR-0012) — and because the pairing
    /// dialog has to be readable on a Client that has never met a server.</summary>
    public string? Language { get; init; }

    [JsonIgnore]
    public bool IsPaired => !string.IsNullOrEmpty(ClientToken) && !string.IsNullOrEmpty(ServerUrl);

    /// <summary>No Admin Code secret: never paired, or the state file was lost. Enforcement
    /// authority in this system derives from the shared secret, so a Client without one enforces
    /// nothing and exits without a code (ADR-0007).</summary>
    [JsonIgnore]
    public bool IsUnconfigured => string.IsNullOrEmpty(FamilyCodeSecret);
}

/// <summary>Settings as stored on disk — plain strings/ints so the file stays readable and stable.</summary>
public sealed record PersistedSettings(string DowntimeStart, string DowntimeEnd, int WeekdayMinutes, int WeekendMinutes)
{
    public static PersistedSettings From(Settings s) => new(
        s.DowntimeStart.ToString("HH:mm"), s.DowntimeEnd.ToString("HH:mm"), s.WeekdayMinutes, s.WeekendMinutes);

    public Settings ToSettings() => new(
        TimeOnly.ParseExact(DowntimeStart, "HH:mm"),
        TimeOnly.ParseExact(DowntimeEnd, "HH:mm"),
        WeekdayMinutes, WeekendMinutes);
}

public sealed record PersistedSnapshot(
    string Date, int UsedSeconds, double GrantRemainingSeconds, string? LastRedeemedCode,
    bool AdminLocked = false, string? LastExitCode = null, int BonusSeconds = 0)
{
    public static PersistedSnapshot From(EngineSnapshot s) => new(
        s.Date.ToString("yyyy-MM-dd"), s.UsedSeconds, s.GrantRemainingSeconds, s.LastRedeemedCode,
        s.AdminLocked, s.LastExitCode, s.BonusSeconds);

    public EngineSnapshot ToSnapshot() => new(
        DateOnly.ParseExact(Date, "yyyy-MM-dd"), UsedSeconds, GrantRemainingSeconds, LastRedeemedCode,
        AdminLocked, LastExitCode, BonusSeconds);
}

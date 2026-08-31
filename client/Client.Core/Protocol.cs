using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace DigitalAid.Client.Core;

/// <summary>Wire protocol generation. PROTOCOL.md is the authority — bump both together.</summary>
public static class Protocol
{
    public const int Version = 5;

    /// <summary>Ping status vocabulary (PROTOCOL §7.1).</summary>
    public static string StatusOf(EnforcementState state) => state switch
    {
        EnforcementState.Active => "active",
        EnforcementState.ScreenLocked => "locked",
        EnforcementState.Blocked => "blocked",
        EnforcementState.GrantActive => "grant-active",
        _ => "unknown",
    };

    /// <summary>Time Left kind on the wire — lets the server say *why* (downtime / used up / admin lock).</summary>
    public static string ReasonOf(TimeLeftKind kind) => kind switch
    {
        TimeLeftKind.Grant => "grant",
        TimeLeftKind.Allowance => "allowance",
        TimeLeftKind.Downtime => "downtime",
        TimeLeftKind.Exhausted => "exhausted",
        TimeLeftKind.Locked => "locked",
        _ => "unknown",
    };
}

/// <summary>The settings object as the server sends it — DB column names, snake_case (PROTOCOL §7.3).</summary>
public sealed record WireSettings(
    [property: JsonPropertyName("downtime_start")] string DowntimeStart,
    [property: JsonPropertyName("downtime_end")] string DowntimeEnd,
    [property: JsonPropertyName("weekday_minutes")] int WeekdayMinutes,
    [property: JsonPropertyName("weekend_minutes")] int WeekendMinutes)
{
    public Settings ToSettings() => new(
        TimeOnly.ParseExact(DowntimeStart, "HH:mm"),
        TimeOnly.ParseExact(DowntimeEnd, "HH:mm"),
        WeekdayMinutes, WeekendMinutes);
}

// --- Server → client ---------------------------------------------------------------------------

public abstract record ServerMessage
{
    public sealed record Hello(int Protocol, long LastSeq, Settings? Settings, string? FamilyCodeSecret,
        UpdateInfo? Update, bool Disabled, string? GrantSeed = null,
        BackgroundSet? Backgrounds = null) : ServerMessage;

    /// <summary>A Block Screen Background changed on the server. Same payload as the one in
    /// <see cref="Hello"/>, so reconnecting and being told live take the same path.</summary>
    public sealed record BackgroundsChanged(BackgroundSet Backgrounds) : ServerMessage;
    public sealed record SettingsChanged(Settings Settings) : ServerMessage;
    public sealed record Popup(string Text) : ServerMessage;
    public sealed record Adjust(int Minutes) : ServerMessage;
    public sealed record LockNow : ServerMessage;
    public sealed record Unlock : ServerMessage;
    public sealed record EndToday : ServerMessage;
    public sealed record Disable : ServerMessage;
    public sealed record Enable : ServerMessage;
    public sealed record FamilyCodeSecretChanged(string Secret) : ServerMessage;
    /// <summary>The household's two secrets rotate together, but they travel as two messages so each
    /// one's absence is meaningful — an older Client simply ignores this one.</summary>
    public sealed record GrantSeedChanged(string Seed) : ServerMessage;
    public sealed record UpdateAvailable(UpdateInfo Update) : ServerMessage;

    /// <summary>Where a Request stands (PROTOCOL §6.8). One message covers the whole lifecycle: the
    /// immediate answer to an ask (<c>pending</c>, <c>duplicate</c>, <c>cooldown</c>) and the
    /// parent's verdict when it comes (<c>approved</c>, <c>declined</c>) — which may arrive minutes
    /// later, or on the next connect if this PC was off when it was given.</summary>
    public sealed record RequestStatus(RequestState State, int Minutes, int RetryAfterSeconds) : ServerMessage;

    /// <summary>The answer to a <c>coupon</c> message (PROTOCOL §6.10). <c>Minutes</c> is only
    /// meaningful with <see cref="CouponState.Granted"/>.</summary>
    public sealed record CouponStatus(CouponState State, int Minutes) : ServerMessage;

    /// <summary>The correlated answer to a Usage Report request. A null path means the server no
    /// longer accepts this Client credential or refused the requested period.</summary>
    public sealed record ReportLink(string RequestId, string? Path) : ServerMessage;

    /// <summary>An unrecognised or malformed message. Logged and ignored, never fatal (PROTOCOL §1) —
    /// this is what lets an older Client keep talking to a newer server.</summary>
    public sealed record Unsupported(string Type, string? Reason = null) : ServerMessage;
}

/// <summary>What the server said about a Request. Unknown states parse as <see cref="Unknown"/> and
/// are ignored, so a newer server may add one without breaking an older Client (PROTOCOL §1).</summary>
public enum RequestState
{
    Unknown,
    Pending,
    Duplicate,
    Cooldown,
    Approved,
    Declined,
}

/// <summary>The server's verdict on a Time Coupon (PROTOCOL §6.10). Unknown states parse as
/// <see cref="Unknown"/> and are shown as "not valid", so a newer server may add one.</summary>
public enum CouponState
{
    Unknown,
    Granted,
    Used,
    Expired,
    WrongClient,
    Invalid,
}

/// <summary>The latest build the server offers (PRD §6.7). The decision key is <paramref name="Sha256"/>
/// (the client compares it to the hash of its own exe); <paramref name="Version"/> is a human label
/// and <paramref name="Path"/> is server-relative.</summary>
public sealed record UpdateInfo(string Version, string Sha256, string Path);

/// <summary>One Block Screen Background the server is offering: what it is and where to get it.
/// Never the bytes — those come over HTTP and are kept on disk, because the cover appears exactly
/// when the server tends to be unreachable (CONTEXT.md: Block Screen Background).</summary>
public sealed record BackgroundRef(string Hash, string Path);

/// <summary>Both slots, already resolved for this Client — its own override or the household's, the
/// server having worked out which. Null in a slot means "show nothing there".</summary>
public sealed record BackgroundSet(BackgroundRef? Blocked, BackgroundRef? Downtime);

public static class ServerMessageParser
{
    public static ServerMessage Parse(string json)
    {
        JsonNode? root;
        try
        {
            root = JsonNode.Parse(json);
        }
        catch (JsonException)
        {
            return new ServerMessage.Unsupported("", "unparseable json");
        }

        if (root is not JsonObject obj) return new ServerMessage.Unsupported("", "not an object");
        var type = obj["type"]?.GetValue<string>() ?? "";

        try
        {
            return type switch
            {
                "hello" => new ServerMessage.Hello(
                    obj["protocol"]?.GetValue<int>() ?? 0,
                    obj["lastSeq"]?.GetValue<long>() ?? 0,
                    ReadSettings(obj["settings"]),
                    obj["familyCodeSecret"]?.GetValue<string>(),
                    ReadUpdate(obj["update"]),
                    obj["disabled"]?.GetValue<bool>() ?? false,
                    obj["grantSeed"]?.GetValue<string>(),
                    ReadBackgrounds(obj["backgrounds"])),

                "background" => ReadBackgrounds(obj["backgrounds"]) is { } bg
                    ? new ServerMessage.BackgroundsChanged(bg)
                    : new ServerMessage.Unsupported(type, "missing backgrounds"),

                "settings" => ReadSettings(obj["settings"]) is { } s
                    ? new ServerMessage.SettingsChanged(s)
                    : new ServerMessage.Unsupported(type, "missing settings"),

                "message" => new ServerMessage.Popup(obj["text"]?.GetValue<string>() ?? ""),

                "adjust" => obj["minutes"]?.GetValue<int>() is { } m && m != 0
                    ? new ServerMessage.Adjust(m)
                    : new ServerMessage.Unsupported(type, "missing or zero minutes"),

                "lock" => new ServerMessage.LockNow(),
                "unlock" => new ServerMessage.Unlock(),
                "end-today" => new ServerMessage.EndToday(),

                "disable" => new ServerMessage.Disable(),
                "enable" => new ServerMessage.Enable(),

                "family-code-secret" => obj["secret"]?.GetValue<string>() is { Length: > 0 } secret
                    ? new ServerMessage.FamilyCodeSecretChanged(secret)
                    : new ServerMessage.Unsupported(type, "missing secret"),

                "grant-seed" => obj["seed"]?.GetValue<string>() is { Length: > 0 } seed
                    ? new ServerMessage.GrantSeedChanged(seed)
                    : new ServerMessage.Unsupported(type, "missing seed"),

                "request-status" => new ServerMessage.RequestStatus(
                    obj["state"]?.GetValue<string>() switch
                    {
                        "pending" => RequestState.Pending,
                        "duplicate" => RequestState.Duplicate,
                        "cooldown" => RequestState.Cooldown,
                        "approved" => RequestState.Approved,
                        "declined" => RequestState.Declined,
                        _ => RequestState.Unknown,
                    },
                    obj["minutes"]?.GetValue<int>() ?? 0,
                    obj["retryAfter"]?.GetValue<int>() ?? 0),

                "coupon-status" => new ServerMessage.CouponStatus(
                    obj["state"]?.GetValue<string>() switch
                    {
                        "granted" => CouponState.Granted,
                        "used" => CouponState.Used,
                        "expired" => CouponState.Expired,
                        "wrong-client" => CouponState.WrongClient,
                        "invalid" => CouponState.Invalid,
                        _ => CouponState.Unknown,
                    },
                    obj["minutes"]?.GetValue<int>() ?? 0),

                "report-link" => obj["requestId"]?.GetValue<string>() is { Length: > 0 } requestId
                    ? new ServerMessage.ReportLink(requestId, obj["path"]?.GetValue<string>())
                    : new ServerMessage.Unsupported(type, "missing request id"),

                "update" => ReadUpdate(obj) is { } u
                    ? new ServerMessage.UpdateAvailable(u)
                    : new ServerMessage.Unsupported(type, "missing update fields"),

                _ => new ServerMessage.Unsupported(type, "unknown type"),
            };
        }
        catch (Exception ex) when (ex is FormatException or InvalidOperationException or JsonException)
        {
            // A field of the wrong shape must not kill the connection — the Client that cannot
            // report is the Client the parent cannot see (PROTOCOL §1).
            return new ServerMessage.Unsupported(type, ex.Message);
        }
    }

    private static Settings? ReadSettings(JsonNode? node)
    {
        if (node is not JsonObject o) return null;
        var s = o.Deserialize<WireSettings>();
        return s is null ? null : s.ToSettings();
    }

    /// <summary>Reads an update descriptor from either a nested "update" node (in hello) or the
    /// top-level object (an "update" message). Absent or hashless → null (no update on offer).</summary>
    private static BackgroundSet? ReadBackgrounds(JsonNode? node) =>
        node is JsonObject o ? new BackgroundSet(ReadBackground(o["blocked"]), ReadBackground(o["downtime"])) : null;

    private static BackgroundRef? ReadBackground(JsonNode? node)
    {
        if (node is not JsonObject o) return null;
        var hash = o["hash"]?.GetValue<string>();
        var path = o["path"]?.GetValue<string>();
        return string.IsNullOrEmpty(hash) || string.IsNullOrEmpty(path) ? null : new BackgroundRef(hash, path);
    }

    private static UpdateInfo? ReadUpdate(JsonNode? node)
    {
        if (node is not JsonObject o) return null;
        var sha = o["sha256"]?.GetValue<string>();
        if (string.IsNullOrEmpty(sha)) return null;
        return new UpdateInfo(o["version"]?.GetValue<string>() ?? "", sha, o["path"]?.GetValue<string>() ?? "");
    }
}

// --- Client → server ---------------------------------------------------------------------------

public static class ClientMessages
{
    private static readonly JsonSerializerOptions Options = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>The minutely status snapshot (PROTOCOL §5.1). <paramref name="app"/> is a Foreground App
    /// product name only — never a window title or URL. <paramref name="reason"/> is the Time Left kind,
    /// so the server can show why the machine is blocked (downtime vs exhausted vs admin Lock).</summary>
    public static string Ping(EnforcementState state, int? remainingMinutes, string? app, string? version, string reason) =>
        JsonSerializer.Serialize(new PingDto(
            Protocol.StatusOf(state), remainingMinutes, app, version, Protocol.Version, reason), Options);

    /// <summary>Ping sent while the Client is disabled (paused by the Admin): no enforcement, no
    /// counting — just presence, so the server shows it as disabled rather than offline.</summary>
    public static string DisabledPing(string? version) =>
        JsonSerializer.Serialize(new PingDto("disabled", null, null, version, Protocol.Version, "disabled"), Options);

    /// <summary>Ask a parent for more time (PROTOCOL §5.3). Carries one number and nothing else —
    /// no reason, no message. That is what keeps "never content" intact, and keeps "ask for more
    /// time" from becoming "justify yourself" (CONTEXT.md: Request).</summary>
    /// <summary>Tells the server an open Request no longer needs answering, because an Extra Time
    /// Code was redeemed on this PC in the meantime. Fire-and-forget: there is no answer to wait for,
    /// and if it never arrives the Request simply lapses on its own hour later.</summary>
    public static string WithdrawRequest() =>
        JsonSerializer.Serialize(new { type = "request-withdraw" }, Options);

    public static string TimeRequest(int minutes) =>
        JsonSerializer.Serialize(new RequestDto(minutes), Options);

    /// <summary>Redeem a Time Coupon (PROTOCOL §5.4). Canonical form only: uppercase, no
    /// separators. Live-only like a request — a coupon typed while offline is refused on the spot
    /// and stays good, never queued (ADR-0017).</summary>
    public static string Coupon(string code) =>
        JsonSerializer.Serialize(new CouponDto(code), Options);

    public static string ReportLink(string requestId, int days) =>
        JsonSerializer.Serialize(new ReportLinkDto(requestId, days), Options);

    public static string Events(IReadOnlyList<ClientEvent> events) =>
        JsonSerializer.Serialize(new EventsDto(events), Options);

    /// <param name="machineId">A stable id for this PC, so a server that already knows it can offer
    /// its Client back rather than starting a second one (ADR-0008). Null is honoured — an old server
    /// ignores it, and a Client that cannot read one simply pairs as a stranger, which is what every
    /// Client used to do.</param>
    /// <param name="adopt">Absent on the first call. Then the Client id a person agreed to reconnect
    /// to, or <c>false</c> for "set this up as a new PC".</param>
    public static string PairRequest(string code, string pcName, string? machineId = null, object? adopt = null) =>
        JsonSerializer.Serialize(new PairRequestDto(code, pcName, Protocol.Version, machineId, adopt), Options);

    public static PairResponse? ParsePairResponse(string json) =>
        JsonSerializer.Deserialize<PairResponse>(json);

    private sealed record PingDto(
        [property: JsonPropertyName("status")] string Status,
        [property: JsonPropertyName("remaining")] int? Remaining,
        [property: JsonPropertyName("app")] string? App,
        [property: JsonPropertyName("version")] string? Version,
        [property: JsonPropertyName("protocol")] int ProtocolVersion,
        [property: JsonPropertyName("reason")] string Reason)
    {
        [JsonPropertyName("type")] public string Type => "ping";
    }

    private sealed record EventsDto([property: JsonPropertyName("events")] IReadOnlyList<ClientEvent> Events)
    {
        [JsonPropertyName("type")] public string Type => "events";
    }

    private sealed record RequestDto([property: JsonPropertyName("minutes")] int Minutes)
    {
        [JsonPropertyName("type")] public string Type => "request";
    }

    private sealed record CouponDto([property: JsonPropertyName("code")] string Code)
    {
        [JsonPropertyName("type")] public string Type => "coupon";
    }

    private sealed record ReportLinkDto(
        [property: JsonPropertyName("requestId")] string RequestId,
        [property: JsonPropertyName("days")] int Days)
    {
        [JsonPropertyName("type")] public string Type => "report-link-request";
    }

    private sealed record PairRequestDto(
        [property: JsonPropertyName("code")] string Code,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("protocol")] int ProtocolVersion,
        [property: JsonPropertyName("machineId")] string? MachineId,
        [property: JsonPropertyName("adopt")] object? Adopt);
}

/// <summary>The server's answer to a pairing attempt. Exactly one of <see cref="Token"/> and
/// <see cref="Match"/> is filled: a token means we are paired, a match means the server recognised
/// this machine and is asking which Client we meant before it hands anything over.</summary>
public sealed record PairResponse(
    [property: JsonPropertyName("clientId")] int ClientId,
    [property: JsonPropertyName("token")] string? Token,
    [property: JsonPropertyName("protocol")] int? Protocol,
    [property: JsonPropertyName("adopted")] bool? Adopted = null,
    [property: JsonPropertyName("match")] PairMatch? Match = null);

/// <summary>A Client the server believes this machine already is.</summary>
public sealed record PairMatch(
    [property: JsonPropertyName("clientId")] int ClientId,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("lastSeen")] string? LastSeen);

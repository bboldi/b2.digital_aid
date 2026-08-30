using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace DigitalAid.Client.Core;

/// <summary>
/// One Event as it will appear on the wire (PROTOCOL §5.2): a per-Client monotonic
/// <paramref name="Seq"/>, a client-local timestamp with offset, a type, and an optional payload.
/// </summary>
public sealed record ClientEvent(
    [property: JsonPropertyName("seq")] long Seq,
    [property: JsonPropertyName("ts")] string Ts,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("payload")] JsonObject? Payload = null)
{
    /// <summary>Client timestamps always carry the UTC offset — Allowance and Downtime are
    /// local-time concepts, and a bare timestamp makes a clock-jump Event unreadable after the fact.</summary>
    public static string Stamp(DateTimeOffset localNow) => localNow.ToString("yyyy-MM-ddTHH:mm:sszzz");

    public static ClientEvent Create(long seq, DateTimeOffset localNow, string type, JsonObject? payload = null) =>
        new(seq, Stamp(localNow), type, payload);
}

/// <summary>The Event type vocabulary from PROTOCOL §7.2. Unknown types are legal on the wire —
/// the server stores them verbatim — but these are the ones this Client emits.</summary>
public static class EventTypes
{
    public const string GrantRedeemed = "grant-redeemed";
    public const string AdjustmentApplied = "adjustment-applied";
    public const string UpdateInstalled = "update-installed";
    public const string UpdateRejected = "update-rejected";
    public const string ClockJump = "clock-jump";
    public const string MessageShown = "message-shown";
    public const string ExitViaCode = "exit-via-code";
    public const string Disabled = "disabled";
    public const string Enabled = "enabled";
    public const string OsShutdown = "os-shutdown";
    public const string UncleanExit = "unclean-exit";
    public const string ServerUnreachable = "server-unreachable";
    public const string TimeRequested = "time-requested";
    public const string RequestApproved = "request-approved";
    public const string RequestDeclined = "request-declined";
    public const string CouponRedeemed = "coupon-redeemed";
}

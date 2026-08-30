using System.Text.Json;
using System.Text.Json.Nodes;
using DigitalAid.Client.Core;

namespace Client.Core.Tests;

public class ProtocolTests
{
    // --- Server → client parsing -----------------------------------------------

    [Fact]
    public void Parses_hello_with_settings_and_secret()
    {
        // Verbatim shape the server sends, including the client_id field the Client must ignore.
        const string json = """
        { "type": "hello", "protocol": 2, "lastSeq": 42,
          "settings": { "client_id": 3, "downtime_start": "21:00", "downtime_end": "07:00",
                        "weekday_minutes": 120, "weekend_minutes": 180 },
          "familyCodeSecret": "JBSWY3DPEHPK3PXP",
          "grantSeed": "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0" }
        """;

        var hello = Assert.IsType<ServerMessage.Hello>(ServerMessageParser.Parse(json));

        Assert.Equal(2, hello.Protocol);
        Assert.Equal(42, hello.LastSeq);
        Assert.Equal("JBSWY3DPEHPK3PXP", hello.FamilyCodeSecret);
        Assert.Equal("0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0", hello.GrantSeed);
        Assert.Equal(new Settings(new TimeOnly(21, 0), new TimeOnly(7, 0), 120, 180), hello.Settings);
    }

    [Fact]
    public void Parses_every_live_command()
    {
        Assert.Equal(new Settings(new TimeOnly(22, 0), new TimeOnly(6, 30), 60, 90),
            Assert.IsType<ServerMessage.SettingsChanged>(ServerMessageParser.Parse(
                """{"type":"settings","settings":{"downtime_start":"22:00","downtime_end":"06:30","weekday_minutes":60,"weekend_minutes":90}}""")).Settings);

        Assert.Equal("0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
            Assert.IsType<ServerMessage.GrantSeedChanged>(ServerMessageParser.Parse(
                """{"type":"grant-seed","seed":"0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"}""")).Seed);

        // A rotation message with nothing in it must not blank the stored seed.
        Assert.IsType<ServerMessage.Unsupported>(ServerMessageParser.Parse("""{"type":"grant-seed"}"""));
        Assert.IsType<ServerMessage.Unsupported>(ServerMessageParser.Parse("""{"type":"grant-seed","seed":""}"""));

        Assert.Equal("Dinner in 10 minutes",
            Assert.IsType<ServerMessage.Popup>(ServerMessageParser.Parse(
                """{"type":"message","text":"Dinner in 10 minutes"}""")).Text);

        Assert.Equal(30, Assert.IsType<ServerMessage.Adjust>(
            ServerMessageParser.Parse("""{"type":"adjust","minutes":30}""")).Minutes);
        Assert.Equal(-15, Assert.IsType<ServerMessage.Adjust>(
            ServerMessageParser.Parse("""{"type":"adjust","minutes":-15}""")).Minutes);

        Assert.IsType<ServerMessage.Disable>(ServerMessageParser.Parse("""{"type":"disable"}"""));
        Assert.IsType<ServerMessage.Enable>(ServerMessageParser.Parse("""{"type":"enable"}"""));

        Assert.Equal("NB2W45DFOIZA", Assert.IsType<ServerMessage.FamilyCodeSecretChanged>(
            ServerMessageParser.Parse("""{"type":"family-code-secret","secret":"NB2W45DFOIZA"}""")).Secret);

        var update = Assert.IsType<ServerMessage.UpdateAvailable>(ServerMessageParser.Parse(
            """{"type":"update","version":"0.2.0","sha256":"9f86d081","path":"/api/update/0.2.0"}"""));
        Assert.Equal(("0.2.0", "9f86d081", "/api/update/0.2.0"),
            (update.Update.Version, update.Update.Sha256, update.Update.Path));
    }

    [Theory]
    [InlineData("""{"type":"teleport-kid","when":"now"}""")]        // a newer server's message
    [InlineData("""{"type":"adjust","minutes":0}""")]               // zero is meaningless
    [InlineData("""{"type":"adjust","minutes":"lots"}""")]          // wrong type
    [InlineData("""{"type":"settings"}""")]                         // missing payload
    [InlineData("""{"type":"family-code-secret","secret":""}""")]
    [InlineData("""{"no_type":true}""")]
    [InlineData("not json at all")]
    [InlineData("[1,2,3]")]
    public void Unsupported_messages_degrade_instead_of_throwing(string json)
    {
        // A Client that cannot report is a Client the parent cannot see: never fatal (PROTOCOL §1).
        Assert.IsType<ServerMessage.Unsupported>(ServerMessageParser.Parse(json));
    }

    [Fact]
    public void Hello_tolerates_a_missing_settings_block()
    {
        var hello = Assert.IsType<ServerMessage.Hello>(
            ServerMessageParser.Parse("""{"type":"hello","protocol":1,"lastSeq":0}"""));

        Assert.Null(hello.Settings);          // keep the cached settings rather than inventing defaults
        Assert.Null(hello.FamilyCodeSecret);
    }

    // --- Client → server serialization -------------------------------------------

    [Fact]
    public void Ping_matches_the_documented_shape()
    {
        var json = JsonNode.Parse(ClientMessages.Ping(EnforcementState.GrantActive, 47, "Minecraft", "0.1.0", "grant"))!.AsObject();

        Assert.Equal("ping", json["type"]!.GetValue<string>());
        Assert.Equal("grant-active", json["status"]!.GetValue<string>());
        Assert.Equal(47, json["remaining"]!.GetValue<int>());
        Assert.Equal("Minecraft", json["app"]!.GetValue<string>());
        Assert.Equal("0.1.0", json["version"]!.GetValue<string>());
        Assert.Equal(Protocol.Version, json["protocol"]!.GetValue<int>());
    }

    [Fact]
    public void Ping_omits_null_fields_rather_than_sending_null()
    {
        // PROTOCOL §1: absent and null are equivalent; omit. Absent version *keeps* the recorded one.
        var json = JsonNode.Parse(ClientMessages.Ping(EnforcementState.ScreenLocked, null, null, null, "allowance"))!.AsObject();

        Assert.Equal("locked", json["status"]!.GetValue<string>());
        Assert.False(json.ContainsKey("remaining"));
        Assert.False(json.ContainsKey("app"));
        Assert.False(json.ContainsKey("version"));
    }

    [Theory]
    [InlineData(EnforcementState.Active, "active")]
    [InlineData(EnforcementState.ScreenLocked, "locked")]
    [InlineData(EnforcementState.Blocked, "blocked")]
    [InlineData(EnforcementState.GrantActive, "grant-active")]
    public void Status_vocabulary_matches_the_server(EnforcementState state, string wire)
    {
        Assert.Equal(wire, Protocol.StatusOf(state));
    }

    [Fact]
    public void Events_batch_matches_the_documented_shape()
    {
        var at = new DateTimeOffset(2026, 8, 24, 20, 40, 11, TimeSpan.FromHours(2));
        var batch = new List<ClientEvent>
        {
            ClientEvent.Create(41, at, EventTypes.GrantRedeemed, new JsonObject { ["minutes"] = 25 }),
            ClientEvent.Create(42, at.AddMinutes(25), EventTypes.UncleanExit),
        };

        var json = JsonNode.Parse(ClientMessages.Events(batch))!.AsObject();
        var events = json["events"]!.AsArray();

        Assert.Equal("events", json["type"]!.GetValue<string>());
        Assert.Equal(2, events.Count);
        Assert.Equal(41, events[0]!["seq"]!.GetValue<long>());
        Assert.Equal("2026-08-24T20:40:11+02:00", events[0]!["ts"]!.GetValue<string>());
        Assert.Equal("grant-redeemed", events[0]!["type"]!.GetValue<string>());
        Assert.Equal(25, events[0]!["payload"]!["minutes"]!.GetValue<int>());
        Assert.False(events[1]!.AsObject().ContainsKey("payload"));   // omitted, not null
    }

    [Fact]
    public void Pair_request_carries_code_name_and_protocol()
    {
        var json = JsonNode.Parse(ClientMessages.PairRequest("482913", "KIDS-PC"))!.AsObject();

        Assert.Equal("482913", json["code"]!.GetValue<string>());
        Assert.Equal("KIDS-PC", json["name"]!.GetValue<string>());
        Assert.Equal(Protocol.Version, json["protocol"]!.GetValue<int>());
    }

    [Fact]
    public void Parses_the_pair_response()
    {
        var token = new string('a', 64);
        var res = ClientMessages.ParsePairResponse($$"""{"clientId":3,"token":"{{token}}","protocol":1}""");

        Assert.NotNull(res);
        Assert.Equal(3, res!.ClientId);
        Assert.Equal(token, res.Token);
        Assert.Equal(1, res.Protocol);
    }

    [Fact]
    public void Wire_settings_roundtrip_through_persistence_is_lossless()
    {
        var wire = JsonSerializer.Deserialize<WireSettings>(
            """{"downtime_start":"21:15","downtime_end":"07:45","weekday_minutes":95,"weekend_minutes":205}""")!;

        var settings = wire.ToSettings();
        var reloaded = PersistedSettings.From(settings).ToSettings();

        Assert.Equal(settings, reloaded);
        Assert.Equal(new TimeOnly(21, 15), reloaded.DowntimeStart);
        Assert.Equal(205, reloaded.WeekendMinutes);
    }

    // --- Block Screen Backgrounds ----------------------------------------------
    // The server resolves which picture applies (this Client's override or the household's) and
    // sends the answer, so the Client never has to know the difference. What it does have to get
    // right is that a slot can be empty, and that an older server sends none of this at all.

    [Fact]
    public void Parses_backgrounds_out_of_hello()
    {
        const string json = """
        { "type": "hello", "protocol": 3, "lastSeq": 0,
          "backgrounds": { "blocked": { "hash": "abc123", "path": "/api/background/blocked" },
                           "downtime": null } }
        """;

        var hello = Assert.IsType<ServerMessage.Hello>(ServerMessageParser.Parse(json));

        Assert.Equal("abc123", hello.Backgrounds!.Blocked!.Hash);
        Assert.Equal("/api/background/blocked", hello.Backgrounds.Blocked.Path);
        Assert.Null(hello.Backgrounds.Downtime);
    }

    /// <summary>An older server says nothing about backgrounds, and that has to mean "no pictures"
    /// rather than a parse failure that takes the whole hello down with it.</summary>
    [Fact]
    public void A_hello_without_backgrounds_still_parses()
    {
        const string json = """{ "type": "hello", "protocol": 2, "lastSeq": 0 }""";

        var hello = Assert.IsType<ServerMessage.Hello>(ServerMessageParser.Parse(json));
        Assert.Null(hello.Backgrounds);
    }

    [Fact]
    public void Parses_a_live_background_change()
    {
        const string json = """
        { "type": "background",
          "backgrounds": { "blocked": null,
                           "downtime": { "hash": "def456", "path": "/api/background/downtime" } } }
        """;

        var changed = Assert.IsType<ServerMessage.BackgroundsChanged>(ServerMessageParser.Parse(json));

        Assert.Null(changed.Backgrounds.Blocked);
        Assert.Equal("def456", changed.Backgrounds.Downtime!.Hash);
    }

    /// <summary>A reference missing either half is not a picture. Half a reference would send the
    /// Client after a URL it cannot verify, or make it keep a file it can never match a hash to.</summary>
    [Fact]
    public void A_half_written_background_reference_is_no_background()
    {
        const string json = """
        { "type": "background",
          "backgrounds": { "blocked": { "hash": "abc123" }, "downtime": { "path": "/x" } } }
        """;

        var changed = Assert.IsType<ServerMessage.BackgroundsChanged>(ServerMessageParser.Parse(json));
        Assert.Null(changed.Backgrounds.Blocked);
        Assert.Null(changed.Backgrounds.Downtime);
    }

    // --- Time Coupons ------------------------------------------------

    [Fact]
    public void Coupon_message_carries_the_canonical_code()
    {
        var json = ClientMessages.Coupon("KRTVXM030");
        Assert.Contains("\"type\":\"coupon\"", json);
        Assert.Contains("\"code\":\"KRTVXM030\"", json);
    }

    [Theory]
    [InlineData("granted", CouponState.Granted)]
    [InlineData("used", CouponState.Used)]
    [InlineData("expired", CouponState.Expired)]
    [InlineData("wrong-client", CouponState.WrongClient)]
    [InlineData("invalid", CouponState.Invalid)]
    [InlineData("something-newer", CouponState.Unknown)]   // a newer server may add one (PROTOCOL §1)
    public void Coupon_status_parses_each_state(string wire, CouponState expected)
    {
        var json = $"{{\"type\":\"coupon-status\",\"state\":\"{wire}\",\"minutes\":30}}";
        var msg = ServerMessageParser.Parse(json);
        var status = Assert.IsType<ServerMessage.CouponStatus>(msg);
        Assert.Equal(expected, status.State);
        Assert.Equal(30, status.Minutes);
    }

    [Fact]
    public void Coupon_status_without_minutes_parses_as_zero()
    {
        var msg = ServerMessageParser.Parse("""{"type":"coupon-status","state":"used"}""");
        Assert.Equal(0, Assert.IsType<ServerMessage.CouponStatus>(msg).Minutes);
    }
}

using System.Text.Json.Nodes;
using DigitalAid.Client.Core;

namespace Client.Core.Tests;

public sealed class ClientAgentTests : IDisposable
{
    private const string Secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    private const string GrantSeed = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
    private readonly string _dir = Directory.CreateTempSubdirectory("digitalaid-agent").FullName;

    private static DateTimeOffset MondayMorning => new(2026, 8, 24, 10, 0, 0, TimeSpan.FromHours(2));

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private ClientAgent NewAgent(string version = "0.1.0") => new(
        new StateStore(Path.Combine(_dir, "state.json")),
        new EventQueue(Path.Combine(_dir, "events.jsonl")),
        new RunMarker(Path.Combine(_dir, "running")),
        version);

    /// <summary>A paired, configured agent that has completed startup — the normal running condition.</summary>
    private ClientAgent RunningAgent(DateTimeOffset at, string version = "0.1.0")
    {
        var agent = NewAgent(version);
        agent.SavePairing("https://aid.example.com/", new PairResponse(3, new string('a', 64), 1));
        agent.Handle(new ServerMessage.Hello(1, 0, Settings.Default, Secret, null, false, GrantSeed), at);
        agent.Startup(at);
        agent.Tick(at, TimeSpan.Zero, true, null);
        return agent;
    }

    private static string Grant(int minutes, DateTimeOffset at) => GrantCode.Build(GrantSeed, minutes, at);

    private static IReadOnlyList<ClientEvent> DrainEvents(ClientAgent agent)
    {
        var batch = agent.TakeEventBatch();
        if (batch is null) return [];
        agent.CommitEventBatch();
        return JsonNode.Parse(batch.Json)!["events"]!.AsArray()
            .Select(n => new ClientEvent(
                n!["seq"]!.GetValue<long>(), n["ts"]!.GetValue<string>(), n["type"]!.GetValue<string>(),
                n["payload"]?.AsObject()))
            .ToList();
    }

    // --- Pairing -------------------------------------------------------------------

    /// <summary>Pairing allocates a fresh client_id server-side and resets the sequence counter, so
    /// Events queued under the previous identity must not survive it: they would be filed against
    /// the new Client and would occupy the seq numbers it is about to reissue (ADR-0001).</summary>
    [Fact]
    public void Pairing_discards_events_queued_under_the_previous_pairing()
    {
        var now = MondayMorning;
        var agent = RunningAgent(now);
        agent.LogUpdateRejected("9.9.9", "bad hash", now);
        Assert.True(agent.PendingEventCount > 0);

        agent.SavePairing("https://other.example.com", new PairResponse(7, new string('b', 64), 1));

        Assert.Equal(0, agent.PendingEventCount);
        Assert.Equal(1, agent.State.NextSeq);
    }

    /// <summary>Adopting is the opposite case (ADR-0008): the server handed back the Client this
    /// machine already was, so the queue is still owed to it and the sequence must carry on. Restart
    /// the numbering and the server — which dedupes on (client, seq) and ignores collisions silently
    /// — would swallow every event until the counter caught up.</summary>
    [Fact]
    public void Adopting_an_existing_client_keeps_the_queue_and_the_sequence()
    {
        var now = MondayMorning;
        var agent = RunningAgent(now);
        agent.LogUpdateRejected("9.9.9", "bad hash", now);
        var queued = agent.PendingEventCount;
        var seq = agent.State.NextSeq;
        Assert.True(queued > 0);
        Assert.True(seq > 1);

        agent.SavePairing("https://aid.example.com",
            new PairResponse(3, new string('c', 64), 1, Adopted: true));

        Assert.Equal(queued, agent.PendingEventCount);
        Assert.Equal(seq, agent.State.NextSeq);
        Assert.Equal(3, agent.State.ClientId);
    }

    // --- Unconfigured (ADR-0007) -----------------------------------------------------

    /// <summary>The trap this replaces: a Client whose state file was lost kept enforcing invented
    /// defaults and could not be stopped, because checking the exit code needed the secret that went
    /// missing with everything else.</summary>
    [Fact]
    public void A_client_with_no_secret_is_unconfigured_and_exits_without_a_code()
    {
        var now = MondayMorning;
        var agent = NewAgent();
        agent.Startup(now);

        Assert.True(agent.IsUnconfigured);
        Assert.Equal(RedeemResult.Granted, agent.AuthorizeExit(null, now));
    }

    /// <summary>Pairing does not deliver the secret — hello does. A Client is therefore briefly
    /// Unconfigured after pairing, and must start enforcing on its own once the secret lands.</summary>
    [Fact]
    public void Pairing_alone_leaves_it_unconfigured_until_hello_brings_the_secret()
    {
        var now = MondayMorning;
        var agent = NewAgent();
        agent.SavePairing("https://aid.example.com", new PairResponse(3, new string('a', 64), 1));
        Assert.True(agent.IsPaired);
        Assert.True(agent.IsUnconfigured);

        agent.Handle(new ServerMessage.Hello(1, 0, Settings.Default, Secret, null, false), now);
        Assert.False(agent.IsUnconfigured);
    }

    // --- Startup -------------------------------------------------------------------

    [Fact]
    public void Fresh_install_starts_unpaired_and_enabled()
    {
        var result = NewAgent().Startup(MondayMorning);

        Assert.False(result.Disabled);
        Assert.False(result.RecoveredFromUncleanExit);
        Assert.False(result.Paired);
    }

    [Fact]
    public void A_surviving_run_marker_becomes_an_unclean_exit_event()
    {
        var first = RunningAgent(MondayMorning);
        DrainEvents(first);
        first.Tick(MondayMorning.AddMinutes(5), TimeSpan.FromMinutes(5), true, "Chrome");  // marker armed, then killed

        var restarted = NewAgent();
        var result = restarted.Startup(MondayMorning.AddMinutes(6));

        Assert.True(result.RecoveredFromUncleanExit);
        var e = Assert.Single(DrainEvents(restarted));
        Assert.Equal(EventTypes.UncleanExit, e.Type);
        Assert.Equal("2026-08-24T10:05:00+02:00", e.Payload!["lastTick"]!.GetValue<string>());
    }

    [Fact]
    public void A_clean_shutdown_produces_no_unclean_exit_on_restart()
    {
        var agent = RunningAgent(MondayMorning);
        agent.Tick(MondayMorning.AddMinutes(5), TimeSpan.FromMinutes(5), true, "Chrome");
        agent.ShutdownCleanly(MondayMorning.AddMinutes(5));
        DrainEvents(agent);

        var restarted = NewAgent();
        Assert.False(restarted.Startup(MondayMorning.AddMinutes(6)).RecoveredFromUncleanExit);
        Assert.Empty(DrainEvents(restarted));
    }

    [Fact]
    public void A_version_change_across_restarts_logs_update_installed()
    {
        var agent = RunningAgent(MondayMorning, version: "0.1.0");
        agent.ShutdownCleanly(MondayMorning);
        DrainEvents(agent);

        var upgraded = NewAgent(version: "0.2.0");
        upgraded.Startup(MondayMorning.AddMinutes(1));

        var e = Assert.Single(DrainEvents(upgraded), x => x.Type == EventTypes.UpdateInstalled);
        Assert.Equal("0.1.0", e.Payload!["from"]!.GetValue<string>());
        Assert.Equal("0.2.0", e.Payload["to"]!.GetValue<string>());
    }

    [Fact]
    public void Same_version_restart_logs_nothing()
    {
        var agent = RunningAgent(MondayMorning);
        agent.ShutdownCleanly(MondayMorning);
        DrainEvents(agent);

        var restarted = NewAgent();
        restarted.Startup(MondayMorning.AddMinutes(1));

        Assert.Empty(DrainEvents(restarted));
    }

    // --- Ticking and host instructions ----------------------------------------------

    [Fact]
    public void Ping_json_reports_state_remaining_app_and_version()
    {
        var agent = RunningAgent(MondayMorning);
        var tick = agent.Tick(MondayMorning.AddMinutes(1), TimeSpan.FromMinutes(1), true, "Minecraft");

        var ping = JsonNode.Parse(tick.PingJson)!.AsObject();
        Assert.Equal("active", ping["status"]!.GetValue<string>());
        Assert.Equal(119, ping["remaining"]!.GetValue<int>());
        Assert.Equal("Minecraft", ping["app"]!.GetValue<string>());
        Assert.Equal("0.1.0", ping["version"]!.GetValue<string>());
    }

    [Fact]
    public void Foreground_app_is_not_reported_while_locked_or_blocked()
    {
        var agent = RunningAgent(MondayMorning);

        var locked = agent.Tick(MondayMorning.AddMinutes(1), TimeSpan.FromMinutes(1), false, "Minecraft");
        Assert.False(JsonNode.Parse(locked.PingJson)!.AsObject().ContainsKey("app"));

        var atDowntime = new DateTimeOffset(2026, 8, 24, 22, 0, 0, TimeSpan.FromHours(2));
        var blocked = agent.Tick(atDowntime, TimeSpan.FromMinutes(1), true, "Minecraft");
        Assert.Equal("blocked", JsonNode.Parse(blocked.PingJson)!["status"]!.GetValue<string>());
        Assert.False(JsonNode.Parse(blocked.PingJson)!.AsObject().ContainsKey("app"));
    }

    [Fact]
    public void Blocking_minimizes_the_foreground_before_covering_the_screen()
    {
        var agent = RunningAgent(new DateTimeOffset(2026, 8, 24, 20, 59, 0, TimeSpan.FromHours(2)));
        var tick = agent.Tick(new DateTimeOffset(2026, 8, 24, 21, 0, 0, TimeSpan.FromHours(2)),
            TimeSpan.FromMinutes(1), true, "Minecraft");

        var actions = tick.Instructions.Select(i => i.Action).ToList();
        Assert.Equal(HostAction.MinimizeForeground, actions[0]);   // order matters for fullscreen games
        Assert.Equal(HostAction.ShowBlockScreen, actions[1]);
    }

    [Fact]
    public void Unlocking_into_an_ongoing_block_re_asserts_the_cover()
    {
        var duringDowntime = new DateTimeOffset(2026, 8, 24, 22, 0, 0, TimeSpan.FromHours(2));
        var agent = RunningAgent(duringDowntime);

        agent.Tick(duringDowntime.AddMinutes(1), TimeSpan.FromMinutes(1), false, null);   // locked
        var tick = agent.Tick(duringDowntime.AddMinutes(2), TimeSpan.FromMinutes(1), true, null);

        Assert.Equal(EnforcementState.Blocked, tick.State);
        Assert.Contains(HostAction.ShowBlockScreen, tick.Instructions.Select(i => i.Action));
    }

    [Fact]
    public void A_clock_jump_is_logged_as_an_event()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        agent.Tick(MondayMorning.AddHours(2), TimeSpan.FromMinutes(1), true, "Chrome");

        var e = Assert.Single(DrainEvents(agent));
        Assert.Equal(EventTypes.ClockJump, e.Type);
        Assert.InRange(e.Payload!["deltaSeconds"]!.GetValue<double>(), 7130, 7150);
    }

    // --- Grants, exit, adjustments ----------------------------------------------------

    [Fact]
    public void Redeeming_a_grant_logs_the_minutes_actually_claimed()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);
        Assert.Equal(RedeemResult.Granted, agent.RedeemGrant(Grant(99, MondayMorning), MondayMorning));

        var e = Assert.Single(DrainEvents(agent));
        Assert.Equal(EventTypes.GrantRedeemed, e.Type);
        Assert.Equal(99, e.Payload!["minutes"]!.GetValue<int>());   // the log is the countermeasure (PRD §4)
    }

    [Fact]
    public void A_rejected_grant_logs_nothing()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        Assert.Equal(RedeemResult.InvalidCode, agent.RedeemGrant("00000015", MondayMorning));
        Assert.Equal(RedeemResult.InvalidFormat, agent.RedeemGrant("123", MondayMorning));

        Assert.Empty(DrainEvents(agent));
    }

    [Fact]
    public void Exit_via_code_logs_and_clears_the_marker_so_it_is_not_an_unclean_exit()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        Assert.Equal(RedeemResult.Granted, agent.AuthorizeExit(Totp.CodeAt(Secret, MondayMorning), MondayMorning));
        Assert.Equal(EventTypes.ExitViaCode, Assert.Single(DrainEvents(agent)).Type);

        var restarted = NewAgent();
        Assert.False(restarted.Startup(MondayMorning.AddMinutes(1)).RecoveredFromUncleanExit);
    }

    [Fact]
    public void Adjustments_are_applied_and_logged()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        agent.Handle(new ServerMessage.Adjust(-30), MondayMorning);

        Assert.Equal(90, agent.RemainingMinutes);
        var e = Assert.Single(DrainEvents(agent));
        Assert.Equal(EventTypes.AdjustmentApplied, e.Type);
        Assert.Equal(-30, e.Payload!["minutes"]!.GetValue<int>());
    }

    // --- Server messages ----------------------------------------------------------------

    [Fact]
    public void Settings_push_takes_effect_immediately_and_is_cached_for_offline_use()
    {
        var agent = RunningAgent(MondayMorning);
        var tighter = new Settings(new TimeOnly(20, 0), new TimeOnly(8, 0), 30, 60);

        agent.Handle(new ServerMessage.SettingsChanged(tighter), MondayMorning);

        Assert.Equal(30, agent.RemainingMinutes);
        Assert.Equal(tighter, NewAgent().State.Settings.ToSettings());   // survived the restart
    }

    [Fact]
    public void A_rotated_family_code_secret_replaces_the_old_one_for_exit()
    {
        var agent = RunningAgent(MondayMorning);
        const string rotated = "NB2W45DFOIZANB2W45DFOIZANB2W45DF";

        agent.Handle(new ServerMessage.FamilyCodeSecretChanged(rotated), MondayMorning);

        Assert.Equal(RedeemResult.InvalidCode, agent.AuthorizeExit(Totp.CodeAt(Secret, MondayMorning), MondayMorning));
        Assert.Equal(RedeemResult.Granted, agent.AuthorizeExit(Totp.CodeAt(rotated, MondayMorning), MondayMorning));
        Assert.Equal(rotated, NewAgent().State.FamilyCodeSecret);
    }

    /// <summary>The household's two secrets rotate together but travel as two messages, so each has
    /// to take effect on its own — and only the seed governs Grants (ADR-0006).</summary>
    [Fact]
    public void A_rotated_grant_seed_replaces_the_old_one_for_grants()
    {
        var agent = RunningAgent(MondayMorning);
        const string rotated = "1122334455667788990011223344556677889900112233445566778899001122";

        agent.Handle(new ServerMessage.GrantSeedChanged(rotated), MondayMorning);

        Assert.Equal(RedeemResult.InvalidCode, agent.RedeemGrant(Grant(10, MondayMorning), MondayMorning));
        Assert.Equal(RedeemResult.Granted,
            agent.RedeemGrant(GrantCode.Build(rotated, 10, MondayMorning), MondayMorning));
        Assert.Equal(rotated, NewAgent().State.GrantSeed);
    }

    /// <summary>hello carries both. A Client that reconnects after a rotation it slept through must
    /// pick up the seed the same way it picks up the secret, or Grants quietly stop working.</summary>
    [Fact]
    public void Hello_delivers_the_grant_seed_and_it_survives_a_restart()
    {
        var agent = RunningAgent(MondayMorning);
        Assert.Equal(GrantSeed, agent.State.GrantSeed);
        Assert.Equal(GrantSeed, NewAgent().State.GrantSeed);
    }

    [Fact]
    public void A_message_is_logged_with_its_text_and_handed_to_the_host()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        var instructions = agent.Handle(new ServerMessage.Popup("Dinner in 10 minutes"), MondayMorning);

        var instruction = Assert.Single(instructions);
        Assert.Equal(HostAction.ShowMessage, instruction.Action);
        Assert.Equal("Dinner in 10 minutes", instruction.Text);
        Assert.Equal("Dinner in 10 minutes", Assert.Single(DrainEvents(agent)).Payload!["text"]!.GetValue<string>());
    }

    [Fact]
    public void Kill_logs_disables_and_survives_the_relaunch()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        agent.Handle(new ServerMessage.Disable(), MondayMorning);

        Assert.True(agent.IsDisabled);
        Assert.Equal(EventTypes.Disabled, Assert.Single(DrainEvents(agent)).Type);
        Assert.True(NewAgent().State.Disabled);   // persisted across a restart (resumes paused)

        // Enable turns it back on — no local action needed.
        agent.Handle(new ServerMessage.Enable(), MondayMorning);
        Assert.False(agent.IsDisabled);
        Assert.Equal(EventTypes.Enabled, Assert.Single(DrainEvents(agent)).Type);
    }

    [Fact]
    public void Hello_reconciles_the_disabled_flag_to_the_server()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        // Server says disabled (e.g. toggled while this Client was briefly offline).
        agent.Handle(new ServerMessage.Hello(1, 0, Settings.Default, Secret, null, true), MondayMorning);
        Assert.True(agent.IsDisabled);
        Assert.Equal(EventTypes.Disabled, Assert.Single(DrainEvents(agent), e => e.Type == EventTypes.Disabled).Type);

        // Server says enabled again → reconciles back and logs the transition.
        agent.Handle(new ServerMessage.Hello(1, 0, Settings.Default, Secret, null, false), MondayMorning);
        Assert.False(agent.IsDisabled);
        Assert.Equal(EventTypes.Enabled, Assert.Single(DrainEvents(agent), e => e.Type == EventTypes.Enabled).Type);

        // A hello that matches the current state logs nothing (no churn).
        agent.Handle(new ServerMessage.Hello(1, 0, Settings.Default, Secret, null, false), MondayMorning);
        Assert.Empty(DrainEvents(agent));
    }

    [Fact]
    public void Unsupported_messages_are_inert()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        Assert.Empty(agent.Handle(new ServerMessage.Unsupported("teleport-kid"), MondayMorning));
        Assert.Empty(DrainEvents(agent));
    }

    [Fact]
    public void An_update_offer_asks_the_host_to_check_but_logs_nothing_itself()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        var update = new UpdateInfo("0.2.0", "abc123", "/api/update/latest");
        var instructions = agent.Handle(new ServerMessage.UpdateAvailable(update), MondayMorning);

        var instruction = Assert.Single(instructions);
        Assert.Equal(HostAction.CheckForUpdate, instruction.Action);
        Assert.Equal(update, instruction.Update);
        Assert.Empty(DrainEvents(agent));   // the decision + logging happen in the host's update path
    }

    [Fact]
    public void Hello_carrying_an_update_asks_the_host_to_check()
    {
        var agent = RunningAgent(MondayMorning);
        var update = new UpdateInfo("0.2.0", "abc123", "/api/update/latest");

        var instructions = agent.Handle(
            new ServerMessage.Hello(1, 0, Settings.Default, Secret, update, false), MondayMorning);

        Assert.Contains(instructions, i => i.Action == HostAction.CheckForUpdate && i.Update == update);
    }

    // --- Re-enable after a remote kill ----------------------------------------------------



    // --- Sequence numbers and flushing ----------------------------------------------------

    [Fact]
    public void Sequence_numbers_are_monotonic_across_restarts()
    {
        var agent = RunningAgent(MondayMorning);
        agent.RedeemGrant(Grant(10, MondayMorning), MondayMorning);
        agent.ShutdownCleanly(MondayMorning);

        var restarted = NewAgent();
        restarted.Startup(MondayMorning.AddMinutes(1));
        restarted.Handle(new ServerMessage.Popup("hi"), MondayMorning.AddMinutes(1));

        var seqs = DrainEvents(restarted).Select(e => e.Seq).ToList();
        Assert.Equal(seqs.OrderBy(s => s), seqs);
        Assert.Equal(seqs.Distinct(), seqs);
        Assert.Equal([1L, 2L, 3L], seqs);   // grant, os-shutdown, message-after-restart — none lost, none reused
    }

    [Fact]
    public void Hello_lastSeq_lifts_a_counter_that_fell_behind_the_server()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        // The server holds Events up to 40 that this Client no longer knows about.
        agent.Handle(new ServerMessage.Hello(1, 40, Settings.Default, Secret, null, false), MondayMorning);
        agent.Handle(new ServerMessage.Popup("after resync"), MondayMorning);

        Assert.Equal(41, Assert.Single(DrainEvents(agent)).Seq);   // no silent swallowing by INSERT OR IGNORE
    }

    [Fact]
    public void Hello_never_lowers_the_counter()
    {
        var agent = RunningAgent(MondayMorning);
        agent.Handle(new ServerMessage.Popup("first"), MondayMorning);
        agent.Handle(new ServerMessage.Popup("second"), MondayMorning);
        var before = agent.State.NextSeq;

        agent.Handle(new ServerMessage.Hello(1, 0, Settings.Default, Secret, null, false), MondayMorning);

        Assert.Equal(before, agent.State.NextSeq);
    }

    [Fact]
    public void An_uncommitted_batch_is_re_sent_after_a_crash()
    {
        var agent = RunningAgent(MondayMorning);
        agent.Handle(new ServerMessage.Popup("hello"), MondayMorning);
        var first = agent.TakeEventBatch();
        Assert.NotNull(first);
        // socket died before CommitEventBatch()

        var restarted = NewAgent();
        var again = restarted.TakeEventBatch();

        Assert.NotNull(again);
        Assert.Equal(first!.Count, again!.Count);
    }

    [Fact]
    public void Nothing_pending_means_no_batch_to_send()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        Assert.Null(agent.TakeEventBatch());
        Assert.Equal(0, agent.PendingEventCount);
    }

    // --- Persistence across restarts ----------------------------------------------------

    [Fact]
    public void Usage_and_an_active_grant_survive_a_restart()
    {
        var now = MondayMorning;
        var agent = RunningAgent(now);
        agent.Tick(now, TimeSpan.FromMinutes(120), true, "Chrome"); // drain all allowance
        agent.RedeemGrant(Grant(20, now), now);
        var remaining = agent.RemainingMinutes;

        var restarted = NewAgent();
        restarted.Startup(now.AddMinutes(1));
        var tick = restarted.Tick(now.AddMinutes(1), TimeSpan.FromMinutes(1), true, "Chrome");

        Assert.Equal(remaining - 1, tick.RemainingMinutes);
        Assert.Equal(EnforcementState.GrantActive, tick.State);
    }

    [Fact]
    public void Pairing_details_persist()
    {
        RunningAgent(MondayMorning);

        var state = NewAgent().State;

        Assert.True(state.IsPaired);
        Assert.Equal("https://aid.example.com", state.ServerUrl);   // trailing slash normalized away
        Assert.Equal(3, state.ClientId);
    }

    // --- Stood Down ------------------------------------------------------------------

    [Fact]
    public void Exit_via_code_without_a_boot_id_does_not_stand_the_app_down()
    {
        var now = MondayMorning;
        var agent = RunningAgent(now);

        Assert.Equal(RedeemResult.Granted, agent.AuthorizeExit(Totp.CodeAt(Secret, now), now));

        // The watchdog restarts it within the minute, exactly as before Stood Down existed.
        var relaunched = NewAgent().Startup(now.AddMinutes(1), "boot-1", LaunchKind.Scheduled);
        Assert.False(relaunched.StoodDown);
    }

    [Fact]
    public void Exit_via_code_with_a_boot_id_turns_the_watchdog_away()
    {
        var now = MondayMorning;
        var agent = RunningAgent(now);
        agent.AuthorizeExit(Totp.CodeAt(Secret, now), now, "boot-1");

        var relaunched = NewAgent().Startup(now.AddMinutes(1), "boot-1", LaunchKind.Scheduled);

        Assert.True(relaunched.StoodDown);
    }

    [Fact]
    public void Starting_the_app_by_hand_brings_protection_back()
    {
        var now = MondayMorning;
        RunningAgent(now).AuthorizeExit(Totp.CodeAt(Secret, now), now, "boot-1");

        var byHand = NewAgent().Startup(now.AddMinutes(5), "boot-1", LaunchKind.Manual);

        Assert.False(byHand.StoodDown);
        // ...and the stand-down is spent, so the watchdog is not turned away afterwards either.
        Assert.False(NewAgent().Startup(now.AddMinutes(6), "boot-1", LaunchKind.Scheduled).StoodDown);
    }

    [Fact]
    public void A_stood_down_startup_logs_nothing_and_touches_nothing()
    {
        var now = MondayMorning;
        var agent = RunningAgent(now);
        agent.AuthorizeExit(Totp.CodeAt(Secret, now), now, "boot-1");
        DrainEvents(agent);

        // The watchdog retries every minute. If a refused startup logged an unclean exit — or armed
        // the run marker, so the *next* one did — an evening stood down would fill the parent's
        // timeline with 600 phantom crashes.
        var relaunched = NewAgent();
        for (var minute = 1; minute <= 5; minute++)
            relaunched.Startup(now.AddMinutes(minute), "boot-1", LaunchKind.Scheduled);

        Assert.Empty(DrainEvents(relaunched));
    }

    [Fact]
    public void The_exit_event_records_that_it_stood_the_app_down()
    {
        var now = MondayMorning;
        var agent = RunningAgent(now);
        DrainEvents(agent);

        agent.AuthorizeExit(Totp.CodeAt(Secret, now), now, "boot-1");

        var logged = Assert.Single(DrainEvents(agent));
        Assert.Equal(EventTypes.ExitViaCode, logged.Type);
        Assert.True(logged.Payload!["stoodDown"]!.GetValue<bool>());
    }

    // --- Server reachability ---------------------------------------------------------

    [Fact]
    public void A_client_that_has_never_been_online_reports_no_contact()
    {
        var agent = NewAgent();

        Assert.Null(agent.LastServerContact);
        Assert.Null(agent.TimeSinceServerContact(MondayMorning));
    }

    [Fact]
    public void Server_contact_survives_a_restart()
    {
        var now = MondayMorning;
        var agent = RunningAgent(now);
        agent.NoteServerContact(now);

        // The whole point is to be able to say how stale the settings are after an offline stretch,
        // which spans restarts — an in-memory timestamp would reset to "fine" on every relaunch.
        var restarted = NewAgent();

        Assert.Equal(now, restarted.LastServerContact);
        Assert.Equal(TimeSpan.FromHours(6), restarted.TimeSinceServerContact(now.AddHours(6)));
    }

    [Fact]
    public void A_blind_stretch_is_logged_with_its_duration()
    {
        var now = MondayMorning;
        var agent = RunningAgent(now);
        DrainEvents(agent);

        agent.LogServerUnreachable(TimeSpan.FromHours(3), now);

        var logged = Assert.Single(DrainEvents(agent));
        Assert.Equal(EventTypes.ServerUnreachable, logged.Type);
        Assert.Equal(10800, logged.Payload!["blindSeconds"]!.GetValue<long>());
    }

    [Fact]
    public void A_blind_stretch_logged_while_offline_is_delivered_on_reconnect()
    {
        var now = MondayMorning;
        var agent = RunningAgent(now);
        DrainEvents(agent);

        // Nothing can be sent while offline, so the report is queued like any other Event and the
        // parent learns about the blind stretch only once the server is back.
        agent.LogServerUnreachable(TimeSpan.FromHours(2), now);
        var restarted = NewAgent();

        var delivered = Assert.Single(DrainEvents(restarted));
        Assert.Equal(EventTypes.ServerUnreachable, delivered.Type);
    }

    // --- Requests (CONTEXT.md: Request) --------------------------------------------

    [Fact]
    public void Asking_for_time_produces_a_message_and_an_event()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        var json = agent.RequestMoreTime(30, MondayMorning);

        Assert.Contains("\"type\":\"request\"", json);
        Assert.Contains("\"minutes\":30", json);
        var logged = Assert.Single(DrainEvents(agent), e => e.Type == EventTypes.TimeRequested);
        Assert.Equal(30, logged.Payload!["minutes"]!.GetValue<int>());
    }

    [Fact]
    public void An_approval_adds_the_minutes_the_parent_chose_not_the_ones_asked_for()
    {
        var agent = RunningAgent(MondayMorning);
        agent.Tick(MondayMorning, TimeSpan.FromMinutes(120), true, "Chrome");
        agent.RequestMoreTime(60, MondayMorning);

        // The asked minutes are advisory; only what came back off the wire may reach the counters.
        agent.Handle(new ServerMessage.RequestStatus(RequestState.Approved, 20, 0), MondayMorning);

        // An approval becomes a Grant, so Time Left is the grant window — the same thing a positive
        // Adjustment does, because it is literally the same path (CONTEXT.md: Grant).
        Assert.Equal(20, agent.RemainingMinutes);
        Assert.Equal(EnforcementState.GrantActive,
            agent.Tick(MondayMorning, TimeSpan.Zero, true, null).State);
        var logged = Assert.Single(DrainEvents(agent), e => e.Type == EventTypes.RequestApproved);
        Assert.Equal(20, logged.Payload!["minutes"]!.GetValue<int>());
    }

    [Fact]
    public void Approved_minutes_survive_a_restart()
    {
        var agent = RunningAgent(MondayMorning);
        agent.Handle(new ServerMessage.RequestStatus(RequestState.Approved, 20, 0), MondayMorning);
        var granted = agent.RemainingMinutes;

        // A kill one instruction after the verdict must not lose time the parent actually gave.
        var restarted = NewAgent();
        restarted.Startup(MondayMorning);
        Assert.Equal(granted, restarted.Tick(MondayMorning, TimeSpan.Zero, true, null).RemainingMinutes);
    }

    [Fact]
    public void A_decline_is_a_message_the_kid_has_to_dismiss()
    {
        var agent = RunningAgent(MondayMorning);
        var before = agent.RemainingMinutes;

        var instructions = agent.Handle(new ServerMessage.RequestStatus(RequestState.Declined, 0, 0), MondayMorning);

        // A verdict, not ShowNotice: an answer the kid asked for should not scroll past unseen.
        Assert.Equal(HostAction.ShowDeclined, Assert.Single(instructions).Action);
        Assert.Equal(before, agent.RemainingMinutes);
        Assert.Contains(DrainEvents(agent), e => e.Type == EventTypes.RequestDeclined);
    }

    [Fact]
    public void The_mechanical_answers_are_toasts_and_leave_no_trace()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        foreach (var state in new[] { RequestState.Pending, RequestState.Duplicate, RequestState.Cooldown })
        {
            var instruction = Assert.Single(
                agent.Handle(new ServerMessage.RequestStatus(state, 0, 600), MondayMorning));
            Assert.Equal(HostAction.ShowNotice, instruction.Action);
        }

        // "You already asked" is not history worth keeping — only the ask and the verdict are.
        Assert.Empty(DrainEvents(agent));
    }

    [Fact]
    public void A_cooldown_notice_says_how_long_in_whole_minutes()
    {
        var agent = RunningAgent(MondayMorning);

        var instruction = Assert.Single(
            agent.Handle(new ServerMessage.RequestStatus(RequestState.Cooldown, 0, 61), MondayMorning));

        // Rounded up: telling a kid "1 min" when 61 seconds remain earns a second failed attempt.
        // The agent carries the number and the situation, not the sentence — the shell owns the
        // words, because it is the half that knows which language this PC is in (ADR-0012).
        Assert.Equal(NoticeKind.RequestCooldown, instruction.Notice);
        Assert.Equal(2, instruction.Minutes);
        Assert.Null(instruction.Text);
    }

    [Fact]
    public void An_unknown_request_state_is_inert()
    {
        var agent = RunningAgent(MondayMorning);
        var before = agent.RemainingMinutes;

        // A newer server may add a state; an older Client must keep working (PROTOCOL §1).
        Assert.Empty(agent.Handle(new ServerMessage.RequestStatus(RequestState.Unknown, 30, 0), MondayMorning));
        Assert.Equal(before, agent.RemainingMinutes);
    }

    [Fact]
    public void Asking_for_nothing_sends_nothing()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);

        Assert.Null(agent.RequestMoreTime(0, MondayMorning));
        Assert.Empty(DrainEvents(agent));
    }

    // --- Time Coupons (ADR-0017) --------------------------------------------------------

    private static DateTimeOffset DuringDowntime => new(2026, 8, 24, 22, 0, 0, TimeSpan.FromHours(2));

    [Fact]
    public void A_coupon_is_prepared_for_the_server_in_canonical_form()
    {
        var agent = RunningAgent(MondayMorning);
        var gate = agent.PrepareCouponRedeem("krt-vxm 030", MondayMorning, out var json);
        Assert.Equal(CouponGate.Send, gate);
        Assert.Contains("\"code\":\"KRTVXM030\"", json);
    }

    [Fact]
    public void A_code_that_is_not_coupon_shaped_is_refused_before_any_send()
    {
        var agent = RunningAgent(MondayMorning);
        Assert.Equal(CouponGate.InvalidFormat, agent.PrepareCouponRedeem("KRTVXA030", MondayMorning, out var json));
        Assert.Null(json);
    }

    [Fact]
    public void During_downtime_the_coupon_is_refused_locally_and_stays_unspent()
    {
        // Client-side, before the server is asked: an accepted coupon during Downtime would buy
        // minutes the kid cannot reach before midnight kills them (ADR-0017).
        var agent = RunningAgent(MondayMorning);
        Assert.Equal(CouponGate.Downtime, agent.PrepareCouponRedeem("KRTVXM030", DuringDowntime, out var json));
        Assert.Null(json);
    }

    [Fact]
    public void Granted_adds_the_bonus_logs_the_event_and_says_so()
    {
        var agent = RunningAgent(MondayMorning);
        DrainEvents(agent);
        agent.PrepareCouponRedeem("KRTVXM030", MondayMorning, out _);
        var instructions = agent.Handle(new ServerMessage.CouponStatus(CouponState.Granted, 30), MondayMorning);

        var notice = Assert.Single(instructions);
        Assert.Equal(HostAction.ShowNotice, notice.Action);
        Assert.Equal(NoticeKind.CouponGranted, notice.Notice);
        Assert.Equal(30, notice.Minutes);

        var batch = agent.TakeEventBatch();
        Assert.NotNull(batch);
        Assert.Contains("coupon-redeemed", batch!.Json);
        Assert.Contains("KRTVXM030", batch.Json);
    }

    [Theory]
    [InlineData(CouponState.Used, NoticeKind.CouponAlreadyUsed)]
    [InlineData(CouponState.Expired, NoticeKind.CouponExpired)]
    [InlineData(CouponState.WrongClient, NoticeKind.CouponWrongClient)]
    [InlineData(CouponState.Invalid, NoticeKind.CouponInvalid)]
    [InlineData(CouponState.Unknown, NoticeKind.CouponInvalid)]
    public void Refusals_are_honest_and_change_nothing(CouponState state, NoticeKind expected)
    {
        var agent = RunningAgent(MondayMorning);
        // Drain whatever construction/startup may have queued (pairing, update-installed) so the
        // batch assertion below isolates the refusal's own behaviour, not startup noise.
        DrainEvents(agent);
        agent.PrepareCouponRedeem("KRTVXM030", MondayMorning, out _);
        var instructions = agent.Handle(new ServerMessage.CouponStatus(state, 0), MondayMorning);

        Assert.Equal(expected, Assert.Single(instructions).Notice);
        Assert.Null(agent.TakeEventBatch());   // no event for a refusal; a typo is not news
    }
}

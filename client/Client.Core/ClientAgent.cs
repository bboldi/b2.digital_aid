using System.Text.Json.Nodes;

namespace DigitalAid.Client.Core;

/// <summary>What the host (Client.App) must do as a result of a tick or a server message.
/// The agent decides; the platform layer only performs.</summary>
public enum HostAction
{
    ShowBlockScreen,
    HideBlockScreen,
    MinimizeForeground,
    Warn15Minutes,
    Warn5Minutes,
    ShowMessage,
    /// <summary>A parent approved a Request. Separate from <see cref="ShowMessage"/> only so the
    /// shell can dress a verdict differently from a typed message — the kid asked a question and
    /// this is the answer, which is worth being able to recognise before reading it.</summary>
    ShowApproved,
    /// <summary>A parent declined a Request.</summary>
    ShowDeclined,
    /// <summary>A short-lived toast that dismisses itself. Used for the mechanical answers to a
    /// Request ("sent", "you already asked") — a note that has to be clicked away is for things the
    /// kid needs to have *seen*, and a parent's actual verdict is the only one of those.</summary>
    ShowNotice,
    CheckForUpdate,
}

/// <summary>Which fixed sentence the shell should put on screen. The agent names the situation; the
/// shell owns the words, in whatever language that PC is set to.</summary>
public enum NoticeKind
{
    /// <summary>A parent approved a Request. Carries the minutes granted.</summary>
    RequestApproved,
    /// <summary>A parent declined a Request.</summary>
    RequestDeclined,
    /// <summary>The ask reached the server and is waiting for an answer.</summary>
    RequestSent,
    /// <summary>There is already an open Request from this Client.</summary>
    RequestAlreadyOpen,
    /// <summary>Declined recently. Carries the whole minutes still to wait.</summary>
    RequestCooldown,
    /// <summary>The server accepted a Time Coupon. Carries the minutes added to today.</summary>
    CouponGranted,
    /// <summary>The coupon was already spent — single-use, first come first served.</summary>
    CouponAlreadyUsed,
    /// <summary>The coupon's date has passed.</summary>
    CouponExpired,
    /// <summary>The coupon is tied to a different Client.</summary>
    CouponWrongClient,
    /// <summary>Unknown or revoked — indistinguishable by design (revoke is delete, ADR-0017).</summary>
    CouponInvalid,
}

/// <summary>Whether a typed coupon may be sent to the server, and if not, why not. Offline is not
/// here on purpose — the agent does not hold the socket; the shell answers that one.</summary>
public enum CouponGate { Send, InvalidFormat, Downtime }

/// <summary>
/// What the shell must do, and — where the shell could not work it out for itself — the facts it
/// needs to say why.
///
/// **The agent decides; the shell speaks.** Nothing here is a finished English sentence, because the
/// Client renders in English or Hungarian and the enforcement engine is the wrong place to know
/// which (ADR-0012). <paramref name="Notice"/> names the situation and <paramref name="Minutes"/>
/// carries any number in it, so the shell can build a sentence that reads properly in either language
/// — Hungarian does not pluralise after a numeral, so "5 minutes" and "5 perc" cannot be assembled
/// from the same parts.
///
/// <paramref name="Text"/> survives for exactly one case: a parent's typed message, which is a human
/// writing to another human and is passed through untouched and untranslated.
///
/// <paramref name="Cause"/> is set on the two warnings and nowhere else: it says which limit is about
/// to be reached, so the shell picks a sentence rather than recomputing "is Downtime near?" from the
/// settings and landing on a second, subtly different fifteen minutes.
/// </summary>
public sealed record HostInstruction(HostAction Action, string? Text = null, UpdateInfo? Update = null,
    BlockCause? Cause = null, NoticeKind? Notice = null, int Minutes = 0);

public sealed record AgentTick(
    EnforcementState State,
    TimeLeft TimeLeft,
    string PingJson,
    IReadOnlyList<HostInstruction> Instructions,
    int SecondsUntilBlock = -1)
{
    public int RemainingMinutes => TimeLeft.Minutes;

    /// <summary>Close enough to the Block Screen that the kid has been warned about it. The tray
    /// reads this so the icon turns amber on the same tick the toast appears — two independent
    /// fifteen-minute thresholds would drift apart the first time Downtime got involved.</summary>
    public bool RunningLow => SecondsUntilBlock >= 0 && SecondsUntilBlock <= EnforcementEngine.Warn15Seconds;
}

public sealed record PendingBatch(string Json, int Count);

public sealed record StartupResult(
    bool Disabled, bool RecoveredFromUncleanExit, bool Paired, bool StoodDown = false);

/// <summary>How this process was launched. The Scheduled Task passes <c>--scheduled</c>; anything
/// else is a person starting the app, which is one of the two ways out of <see cref="StoodDownMarker"/>
/// (the other being a reboot). Without the distinction, double-clicking the exe to bring protection
/// back would just exit again.</summary>
public enum LaunchKind
{
    Manual,
    Scheduled,
}

/// <summary>
/// Wires the <see cref="EnforcementEngine"/> to persistence, the Event queue and the protocol, so the
/// platform layer stays a thin shell (PRD §6): it feeds in OS facts (clock, session state, foreground
/// app), ships JSON, and performs <see cref="HostInstruction"/>s. Nothing here touches Windows.
///
/// Every state-changing path persists before returning — a kill -9 one instruction later must not
/// lose minutes, a redeemed Grant, or an Event.
/// </summary>
public sealed class ClientAgent
{
    private readonly StateStore _store;
    private readonly EventQueue _queue;
    private readonly RunMarker _marker;
    private readonly StoodDownMarker _stoodDown;
    private readonly string _version;

    private ClientState _state;
    private EnforcementEngine _engine;

    /// <summary>The coupon most recently sent, canonical form — kept so the granted verdict can log
    /// which coupon it was. One in flight at a time is the shell's contract.</summary>
    private string? _pendingCouponCode;

    public ClientAgent(StateStore store, EventQueue queue, RunMarker marker, string version,
        StoodDownMarker? stoodDown = null)
    {
        _store = store;
        _queue = queue;
        _marker = marker;
        _stoodDown = stoodDown ?? new StoodDownMarker(Path.Combine(
            Path.GetDirectoryName(store.Path) ?? ".", "stood-down"));
        _version = version;
        _state = store.Load();
        _engine = BuildEngine(_state);
    }

    public ClientState State => _state;
    public EnforcementState EnforcementState => _engine.State;
    public TimeLeft TimeLeft => _engine.TimeLeft;
    public int RemainingMinutes => _engine.RemainingMinutes;
    public bool IsPaired => _state.IsPaired;
    /// <summary>No Admin Code secret, so nothing is enforced and exit needs no code (ADR-0007).
    /// Self-correcting: a Client that has just paired is briefly unconfigured until the first hello
    /// delivers the secret, and starts enforcing on the tick after it arrives.</summary>
    public bool IsUnconfigured => _state.IsUnconfigured;
    /// <summary>Paused by the Admin (PRD §5.3): the app stays resident and connected but enforces
    /// nothing. Remotely reversible; the server is the source of truth, synced via hello.</summary>
    public bool IsDisabled => _state.Disabled;
    public int PendingEventCount => _queue.PendingCount();

    /// <summary>Call once before the first tick. Infers an unclean exit from a surviving run marker
    /// (PRD §6.6) and reports whether a <c>kill</c> disabled this install.</summary>
    public StartupResult Startup(DateTimeOffset localNow, string? bootId = null, LaunchKind launch = LaunchKind.Manual)
    {
        // A person starting the app is one of the two ways to end a stand-down (the other is a
        // reboot); only the watchdog is turned away. Checked before anything else is touched — a
        // stood-down process must leave no trace, or it would log an unclean exit every minute.
        if (bootId is not null)
        {
            if (launch == LaunchKind.Scheduled && _stoodDown.IsStoodDown(bootId, localNow))
                return new StartupResult(_state.Disabled, false, _state.IsPaired, StoodDown: true);

            _stoodDown.Clear();
        }

        var lastTick = _marker.DetectUncleanExit();
        if (lastTick is { } tick)
            Enqueue(localNow, EventTypes.UncleanExit, new JsonObject { ["lastTick"] = ClientEvent.Stamp(tick) });

        if (_state.LastVersion is { } previous && previous != _version)
        {
            Enqueue(localNow, EventTypes.UpdateInstalled, new JsonObject { ["from"] = previous, ["to"] = _version });
            Mutate(s => s with { LastVersion = _version });
        }
        else if (_state.LastVersion is null)
        {
            Mutate(s => s with { LastVersion = _version });
        }

        if (!_state.Disabled) _marker.Arm(localNow);
        return new StartupResult(_state.Disabled, lastTick is not null, _state.IsPaired);
    }

    /// <summary>One enforcement tick. <paramref name="monotonicElapsed"/> must come from a monotonic
    /// source (Stopwatch), never from clock differences — that is what makes usage immune to clock changes.</summary>
    public AgentTick Tick(DateTimeOffset localNow, TimeSpan monotonicElapsed, bool sessionUnlocked, string? foregroundApp)
    {
        var previousState = _engine.State;
        var result = _engine.Tick(localNow, monotonicElapsed, sessionUnlocked);
        var instructions = new List<HostInstruction>();

        foreach (var n in result.Notifications)
        {
            switch (n.Kind)
            {
                case NotificationKind.ClockJump:
                    Enqueue(localNow, EventTypes.ClockJump,
                        new JsonObject { ["deltaSeconds"] = Math.Round(n.DeltaSeconds) });
                    break;
                case NotificationKind.Warning15:
                    instructions.Add(new HostInstruction(HostAction.Warn15Minutes, Cause: n.Cause));
                    break;
                case NotificationKind.Warning5:
                    instructions.Add(new HostInstruction(HostAction.Warn5Minutes, Cause: n.Cause));
                    break;
                case NotificationKind.BlockStarted:
                    // Minimize first: a fullscreen game must lose the foreground before the cover appears,
                    // which is also the closest thing to a pause we can offer (PRD §6.2).
                    instructions.Add(new HostInstruction(HostAction.MinimizeForeground));
                    instructions.Add(new HostInstruction(HostAction.ShowBlockScreen));
                    break;
                case NotificationKind.BlockEnded:
                    instructions.Add(new HostInstruction(HostAction.HideBlockScreen));
                    break;
            }
        }

        // A blocked session that locks and unlocks produces no BlockStarted notification (it never
        // left the blocked state), so re-assert the cover whenever the host may have lost it.
        if (result.State == Core.EnforcementState.Blocked && previousState == Core.EnforcementState.ScreenLocked)
        {
            instructions.Add(new HostInstruction(HostAction.ShowBlockScreen));
        }

        // Foreground app is only meaningful while the machine is usable — never while locked or
        // blocked, where reporting it would leak what is behind the cover for no benefit.
        var app = result.State is Core.EnforcementState.Active or Core.EnforcementState.GrantActive
            ? foregroundApp
            : null;

        PersistCounters();
        _marker.Arm(localNow);

        return new AgentTick(result.State, result.TimeLeft,
            ClientMessages.Ping(result.State, result.RemainingMinutes, app, _version,
                Protocol.ReasonOf(result.TimeLeft.Kind)), instructions,
            _engine.SecondsUntilBlock(localNow));
    }

    /// <summary>Grant input typed on the Block Screen: <c>[6-digit code][1–3 digit minutes]</c>.</summary>
    public RedeemResult RedeemGrant(string? input, DateTimeOffset localNow)
    {
        var result = _engine.TryRedeemGrant(input, localNow);
        if (result != RedeemResult.Granted) return result;

        GrantCode.TryParse(input, out _, out var minutes);
        Enqueue(localNow, EventTypes.GrantRedeemed, new JsonObject { ["minutes"] = minutes });
        PersistCounters();
        return result;
    }

    /// <summary>Exit protection: a bare Admin Code, from the tray menu or the Block Screen. On
    /// success the caller should flush, then exit — the marker is already cleared, so this is not an
    /// unclean exit.
    ///
    /// Passing <paramref name="bootId"/> also stands the app down, so the Scheduled Task does not
    /// simply restart it within the minute. Without that, "exit protection" bought a kid 60 seconds.
    /// </summary>
    public RedeemResult AuthorizeExit(string? input, DateTimeOffset localNow, string? bootId = null)
    {
        var result = _engine.TryAuthorizeExit(input, localNow);
        if (result != RedeemResult.Granted) return result;

        Enqueue(localNow, EventTypes.ExitViaCode,
            bootId is null ? null : new JsonObject { ["stoodDown"] = true });
        PersistCounters();
        if (bootId is not null) _stoodDown.StandDown(bootId, localNow);
        _marker.Clear();
        return result;
    }

    /// <summary>Check an Admin Code without spending it, to authorise re-Pairing. Nothing is logged:
    /// the Pairing that follows is the Event worth having, and a mistyped code is not news.</summary>
    public RedeemResult VerifyFamilyCode(string? input, DateTimeOffset localNow) =>
        _engine.VerifyFamilyCode(input, localNow);

    /// <summary>Enter or leave the disabled (paused) state, logging the transition. Called from the
    /// live disable/enable commands and from hello reconciliation.</summary>
    private void SetDisabled(bool disabled, DateTimeOffset localNow)
    {
        if (_state.Disabled == disabled) return;
        Enqueue(localNow, disabled ? EventTypes.Disabled : EventTypes.Enabled);
        Mutate(s => s with { Disabled = disabled });
    }

    /// <summary>The host is about to swap the exe and restart for a self-update. Clear the marker so
    /// the relaunch is not mistaken for an unclean exit (PRD §6.7); update-installed is logged on the
    /// next start from the version change.</summary>
    public void PrepareUpdateRestart() => _marker.Clear();

    /// <summary>Windows is shutting down or the user is logging off. Clean: clears the marker.</summary>
    public void ShutdownCleanly(DateTimeOffset localNow)
    {
        Enqueue(localNow, EventTypes.OsShutdown);
        PersistCounters();
        _marker.Clear();
    }

    public IReadOnlyList<HostInstruction> Handle(ServerMessage message, DateTimeOffset localNow)
    {
        var instructions = new List<HostInstruction>();
        switch (message)
        {
            case ServerMessage.Hello hello:
                // lastSeq repairs a counter that fell behind what the server already holds (ADR-0001).
                var resynced = Math.Max(_state.NextSeq, hello.LastSeq + 1);
                Mutate(s => s with { NextSeq = resynced });
                if (hello.Settings is { } settings) ApplySettings(settings);
                if (hello.FamilyCodeSecret is { } secret) ApplySecret(secret);
                if (hello.GrantSeed is { } seed) ApplyGrantSeed(seed);
                if (hello.Update is { } offered)
                    instructions.Add(new HostInstruction(HostAction.CheckForUpdate, Update: offered));
                // The server owns the disabled flag; reconcile our cache to it (may re-enable after
                // an offline stretch, or disable a Client that missed the live command).
                if (hello.Disabled != _state.Disabled) SetDisabled(hello.Disabled, localNow);
                break;

            case ServerMessage.LockNow:
                _engine.LockNow();
                PersistCounters();
                break;

            case ServerMessage.Unlock:
                _engine.Unlock();
                PersistCounters();
                break;

            case ServerMessage.EndToday:
                _engine.EndToday();
                PersistCounters();
                break;

            case ServerMessage.SettingsChanged changed:
                ApplySettings(changed.Settings);
                break;

            case ServerMessage.GrantSeedChanged reseeded:
                ApplyGrantSeed(reseeded.Seed);
                return [];

            case ServerMessage.FamilyCodeSecretChanged rotated:
                ApplySecret(rotated.Secret);
                break;

            case ServerMessage.Adjust adjust:
                _engine.ApplyAdjustment(adjust.Minutes);
                Enqueue(localNow, EventTypes.AdjustmentApplied, new JsonObject { ["minutes"] = adjust.Minutes });
                PersistCounters();
                break;

            case ServerMessage.Popup popup:
                Enqueue(localNow, EventTypes.MessageShown, new JsonObject { ["text"] = popup.Text });
                instructions.Add(new HostInstruction(HostAction.ShowMessage, popup.Text));
                break;

            case ServerMessage.Disable:
                SetDisabled(true, localNow);
                break;

            case ServerMessage.Enable:
                SetDisabled(false, localNow);
                break;

            case ServerMessage.UpdateAvailable update:
                // The download/verify/swap is the host's job (it touches the exe on disk); the agent
                // just relays the offer. The host no-ops if the hash already matches its own exe.
                instructions.Add(new HostInstruction(HostAction.CheckForUpdate, Update: update.Update));
                break;

            case ServerMessage.RequestStatus status:
                instructions.AddRange(HandleRequestStatus(status, localNow));
                break;

            case ServerMessage.CouponStatus coupon:
                instructions.AddRange(HandleCouponStatus(coupon, localNow));
                break;

            case ServerMessage.Unsupported:
                // Deliberately inert — an older Client must keep working against a newer server.
                break;
        }
        return instructions;
    }

    // --- Requests (CONTEXT.md: Request) ---------------------------------------------

    /// <summary>Ask a parent for more time. Returns the JSON for the host to send, or null if there
    /// is nothing to send. Deliberately *not* queued like an Event: a Request is a live ask, so one
    /// made while the server is unreachable is better refused than delivered an hour late, when the
    /// question has changed.</summary>
    public string? RequestMoreTime(int minutes, DateTimeOffset localNow)
    {
        if (minutes <= 0) return null;
        Enqueue(localNow, EventTypes.TimeRequested, new JsonObject { ["minutes"] = minutes });
        return ClientMessages.TimeRequest(minutes);
    }

    /// <summary>Gate a typed Time Coupon and build the message for the shell to send. Downtime is
    /// refused here, before any send, so a coupon typed at the night cover stays unspent
    /// (ADR-0017). Format is checked here too: a malformed coupon must not reach the wire.</summary>
    public CouponGate PrepareCouponRedeem(string? input, DateTimeOffset localNow, out string? json)
    {
        json = null;
        if (!CouponCode.TryParse(input, out var code, out _)) return CouponGate.InvalidFormat;
        if (_state.Settings.ToSettings().IsDowntime(TimeOnly.FromDateTime(localNow.DateTime)))
            return CouponGate.Downtime;

        _pendingCouponCode = code;
        json = ClientMessages.Coupon(code);
        return CouponGate.Send;
    }

    private IReadOnlyList<HostInstruction> HandleCouponStatus(
        ServerMessage.CouponStatus status, DateTimeOffset localNow)
    {
        if (status.State == CouponState.Granted)
        {
            // The server has already spent the coupon; all that is left is to honour it. The code
            // goes in the payload because the parent's list may no longer hold this coupon —
            // revoke is delete, and the timeline is the audit (ADR-0017).
            _engine.AddAllowanceBonus(status.Minutes);
            Enqueue(localNow, EventTypes.CouponRedeemed, new JsonObject
            {
                ["code"] = _pendingCouponCode ?? "",
                ["minutes"] = status.Minutes,
            });
            _pendingCouponCode = null;
            PersistCounters();
            return [new HostInstruction(HostAction.ShowNotice,
                Notice: NoticeKind.CouponGranted, Minutes: status.Minutes)];
        }

        // A refusal changes nothing and logs nothing — a typo is not news. But it is answered
        // honestly (ADR-0017): spent, expired and wrong-machine are different sentences.
        _pendingCouponCode = null;
        var notice = status.State switch
        {
            CouponState.Used => NoticeKind.CouponAlreadyUsed,
            CouponState.Expired => NoticeKind.CouponExpired,
            CouponState.WrongClient => NoticeKind.CouponWrongClient,
            _ => NoticeKind.CouponInvalid,
        };
        return [new HostInstruction(HostAction.ShowNotice, Notice: notice)];
    }

    private IReadOnlyList<HostInstruction> HandleRequestStatus(
        ServerMessage.RequestStatus status, DateTimeOffset localNow)
    {
        switch (status.State)
        {
            case RequestState.Approved:
                // An approval *is* a positive Adjustment — the same path a parent's manual adjust
                // takes, so there is one way extra minutes ever reach the counters (CONTEXT.md: Grant).
                _engine.ApplyAdjustment(status.Minutes);
                Enqueue(localNow, EventTypes.RequestApproved, new JsonObject { ["minutes"] = status.Minutes });
                PersistCounters();
                return [new HostInstruction(HostAction.ShowApproved,
                    Notice: NoticeKind.RequestApproved, Minutes: status.Minutes)];

            case RequestState.Declined:
                // Persistent, not a toast: "no" is an answer the kid asked for, and one they should
                // have to acknowledge rather than miss while the screen was covered.
                Enqueue(localNow, EventTypes.RequestDeclined);
                return [new HostInstruction(HostAction.ShowDeclined, Notice: NoticeKind.RequestDeclined)];

            case RequestState.Pending:
                return [new HostInstruction(HostAction.ShowNotice, Notice: NoticeKind.RequestSent)];

            case RequestState.Duplicate:
                return [new HostInstruction(HostAction.ShowNotice, Notice: NoticeKind.RequestAlreadyOpen)];

            case RequestState.Cooldown:
                // Rounded up and floored at one: "ask again in 0 min" is not an instruction, and a
                // kid told to wait 40 seconds will simply try again at 39.
                var minutes = Math.Max(1, (int)Math.Ceiling(status.RetryAfterSeconds / 60.0));
                return [new HostInstruction(HostAction.ShowNotice,
                    Notice: NoticeKind.RequestCooldown, Minutes: minutes)];

            default:
                return [];
        }
    }

    // --- Server reachability -------------------------------------------------------

    /// <summary>When this Client last reached the server, or null if it never has.</summary>
    public DateTimeOffset? LastServerContact =>
        DateTimeOffset.TryParse(_state.LastServerContact, out var parsed) ? parsed : null;

    /// <summary>How stale the enforcement settings are, or null if the Client has never been online.
    /// Not acted on — an offline Client keeps enforcing regardless — but shown to the kid and the
    /// parent, because indefinite enforcement of stale policy should at least be legible.</summary>
    public TimeSpan? TimeSinceServerContact(DateTimeOffset localNow) =>
        LastServerContact is { } last ? localNow - last : null;

    /// <summary>The link connected, or a Ping got through.</summary>
    public void NoteServerContact(DateTimeOffset localNow) =>
        Mutate(s => s with { LastServerContact = ClientEvent.Stamp(localNow) });

    /// <summary>This Client has been *running* without reaching the server for long enough to be worth
    /// recording. Queued like any Event, so it lands when the server comes back and the parent can see
    /// how long the machine was enforcing blind. Deliberately keyed on time spent running rather than
    /// on <see cref="LastServerContact"/>: a PC that was simply switched off overnight has a large gap
    /// and nothing to report.</summary>
    public void LogServerUnreachable(TimeSpan blindFor, DateTimeOffset localNow) =>
        Enqueue(localNow, EventTypes.ServerUnreachable,
            new JsonObject { ["blindSeconds"] = (long)blindFor.TotalSeconds });

    /// <summary>Host reports a self-update it could not apply (bad download hash, IO error). Logged so
    /// a failing rollout is visible; the client keeps running the build it already has (PRD §6.7).</summary>
    public void LogUpdateRejected(string version, string reason, DateTimeOffset localNow)
    {
        Enqueue(localNow, EventTypes.UpdateRejected,
            new JsonObject { ["version"] = version, ["reason"] = reason });
    }

    // --- Pairing ------------------------------------------------------------------

    public void SavePairing(string serverUrl, PairResponse response)
    {
        // Adopting is *not* a new identity (ADR-0008): the server handed back the Client this machine
        // already was, holding events that ran 1..N. Resetting the counter would reissue those
        // numbers, and the server dedupes on (client, seq) with INSERT OR IGNORE — so every event
        // until the counter caught up would be dropped without a word. The queue is kept for the same
        // reason: those events belong to this Client and are still owed to it.
        var adopted = response.Adopted == true;
        if (!adopted)
        {
            // Drop anything still queued under the previous identity *before* the counter resets.
            // A fresh pairing allocates a fresh client_id, so those Events would be filed against the
            // new Client and would occupy seq numbers 1..N that it is about to reissue (ADR-0001).
            _queue.Clear();
        }

        Mutate(s => s with
        {
            ServerUrl = serverUrl.TrimEnd('/'),
            ClientToken = response.Token,
            ClientId = response.ClientId,
            NextSeq = adopted ? s.NextSeq : 1,
            Disabled = false,
        });
    }

    // --- Event flushing -----------------------------------------------------------

    /// <summary>Take everything pending as one message. Call <see cref="CommitEventBatch"/> only after
    /// the send succeeded; an uncommitted batch is re-sent later, which the server dedupes.</summary>
    public PendingBatch? TakeEventBatch()
    {
        var batch = _queue.TakeBatch();
        return batch.Count == 0 ? null : new PendingBatch(ClientMessages.Events(batch), batch.Count);
    }

    public void CommitEventBatch() => _queue.Commit();

    // --- internals ----------------------------------------------------------------

    private EnforcementEngine BuildEngine(ClientState state) =>
        new(state.Settings.ToSettings(), state.FamilyCodeSecret ?? "", state.Counters.ToSnapshot(),
            state.GrantSeed ?? "");

    private void ApplySettings(Settings settings)
    {
        _engine.UpdateSettings(settings);
        Mutate(s => s with { Settings = PersistedSettings.From(settings) });
    }

    private void ApplySecret(string secret)
    {
        _engine.UpdateFamilyCodeSecret(secret);
        Mutate(s => s with { FamilyCodeSecret = secret });
    }

    private void ApplyGrantSeed(string seed)
    {
        _engine.UpdateGrantSeed(seed);
        Mutate(s => s with { GrantSeed = seed });
    }

    private void Enqueue(DateTimeOffset localNow, string type, JsonObject? payload = null)
    {
        var seq = _state.NextSeq;
        // Persist the allocated seq *before* the Event exists on disk: a crash between the two
        // burns a sequence number, which is harmless, whereas reusing one would hide an Event.
        Mutate(s => s with { NextSeq = seq + 1 });
        _queue.Append(ClientEvent.Create(seq, localNow, type, payload));
    }

    private void PersistCounters() => Mutate(s => s with { Counters = PersistedSnapshot.From(_engine.Snapshot()) });

    /// <summary>Remember which language this PC shows. Local and permanent: the server neither sets
    /// it nor is told about it (ADR-0012). Nothing is enqueued — the parent's audit trail is about
    /// what happened to the kid's time, and this did not happen to it.</summary>
    public void SetLanguage(string code)
    {
        if (!Language.IsSupported(code)) return;
        Mutate(s => s with { Language = code });
    }

    private void Mutate(Func<ClientState, ClientState> change)
    {
        _state = change(_state);
        _store.Save(_state);
    }
}

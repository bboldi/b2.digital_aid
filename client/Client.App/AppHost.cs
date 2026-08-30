using System.Diagnostics;
using System.Reflection;
using System.Windows;
using System.Windows.Threading;
using DigitalAid.Client.App.Interop;
using DigitalAid.Client.App.Ui;
using DigitalAid.Client.Core;
using Microsoft.Win32;

namespace DigitalAid.Client.App;

/// <summary>
/// The platform shell. It contributes only what the OS knows — the clock, whether the session is
/// unlocked, which app is in front — and performs what <see cref="ClientAgent"/> decides. All the
/// rules live in Client.Core, which is why they are testable on a machine that cannot run this file.
/// </summary>
public sealed class AppHost : IDisposable
{
    private static readonly TimeSpan TickInterval = TimeSpan.FromSeconds(1);
    private const int PingEverySeconds = 60;

    /// <summary>Wall-clock gaps larger than this (sleep, hibernate) are not credited as Usage Time:
    /// the machine was not usable, so charging the kid for it would be wrong.</summary>
    private static readonly TimeSpan MaxCreditedTick = TimeSpan.FromSeconds(5);

    /// <summary>How long this Client may run without reaching the server before it says so in the log.
    /// Once per run: the point is "this machine spent the evening enforcing blind", not a heartbeat.</summary>
    private static readonly TimeSpan BlindBeforeLogging = TimeSpan.FromHours(1);

    private readonly Application _application;
    private readonly ClientAgent _agent;
    private readonly BackgroundStore _backgrounds;
    private readonly TrayIcons _trayIcons = new();
    private readonly System.Windows.Forms.NotifyIcon _tray;
    private readonly DispatcherTimer _timer;
    private readonly Stopwatch _monotonic = Stopwatch.StartNew();
    private readonly List<BlockWindow> _blockWindows = [];
    // At most one of each: both are opened from the tray, where a double-click and a menu item lead
    // to the same place and a kid clicks twice.
    private FlyoutWindow? _flyout;
    private AboutWindow? _about;
    private readonly string _version;

    private ServerLink? _link;
    private TaskCompletionSource<Core.ServerMessage.CouponStatus>? _couponWait;
    private TimeSpan _lastElapsed;
    private int _secondsSincePing = PingEverySeconds;   // ping immediately on the first tick
    private bool _sessionUnlocked = true;
    private bool _online;
    private bool _exiting;
    private bool _updating;
    private DateTimeOffset _blindSince = DateTimeOffset.Now;
    private bool _blindLogged;

    private readonly LaunchKind _launch;
    private readonly string _bootId;

    public AppHost(Application application, LaunchKind launch = LaunchKind.Manual)
    {
        _application = application;
        _launch = launch;
        // TickCount64 is milliseconds since boot, so "now minus uptime" identifies this boot without
        // asking Windows anything — which keeps the rule testable in Client.Core.
        _bootId = StoodDownMarker.BootIdFrom(DateTimeOffset.Now, TimeSpan.FromMilliseconds(Environment.TickCount64));
        // InformationalVersion, not GetName().Version: AssemblyVersion is strictly numeric, so it
        // silently drops the '+dev.<sha>' suffix and a scratch build would report itself as the
        // release it was built from.
        _version = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? "0.0.0";

        _backgrounds = new BackgroundStore(Paths.BackgroundDir, Log);
        // A picture arriving while the cover is already up swaps live rather than waiting for the
        // next block — it is a few lines, and it is what makes the Settings page feel connected to
        // anything.
        _backgrounds.Changed += () => _application.Dispatcher.Invoke(RefreshBlockBackgrounds);

        _agent = new ClientAgent(
            new StateStore(Paths.StateFile),
            new EventQueue(Paths.EventQueueFile),
            new RunMarker(Paths.RunMarkerFile),
            _version,
            new StoodDownMarker(Paths.StoodDownFile));

        _tray = new System.Windows.Forms.NotifyIcon
        {
            Icon = _trayIcons.Get(TrayState.NotSetUp, TrayLink.Offline),
            Text = Strings.AppName,
            Visible = true,
        };
        BuildTrayMenu();
        // Subscribed once, here, and deliberately *not* inside BuildTrayMenu: that method runs again
        // on every language switch to rebuild the captions, and a `+=` in a method that runs twice
        // leaves two handlers behind — which is exactly one Flyout per language change the kid ever
        // made. The menu is rebuilt; the subscription is not.
        _tray.DoubleClick += (_, _) => ShowFlyout();

        _timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = TickInterval };
        _timer.Tick += (_, _) => OnTick();
    }

    /// <summary>Starts the client. The app always runs once paired; "disabled" is a resident pause
    /// (PRD §5.3), not an exit, so it can be re-enabled from the server at any time.</summary>
    public bool Start()
    {
        var startup = _agent.Startup(DateTimeOffset.Now, _bootId, _launch);
        if (startup.StoodDown)
        {
            // The watchdog trying again a minute after a deliberate exit. Say nothing to the kid and
            // leave no Event: this fires ~600 times over an evening, and each one logging would bury
            // the single exit-via-code that actually matters.
            Log("stood down — not starting (released at midnight, on reboot, or by starting it by hand)");
            return false;
        }

        if (startup.Disabled) Log("starting disabled (paused) — awaiting enable from the server");

        SystemEvents.SessionSwitch += OnSessionSwitch;
        SystemEvents.SessionEnding += OnSessionEnding;

        if (_agent.IsUnconfigured)
        {
            // Nothing to enforce until a parent pairs this PC; enforcement without settings would
            // be guesswork, and the installer runs this dialog once. Declining leaves the Client
            // Unconfigured — resident, enforcing nothing, exitable without a code (ADR-0007).
            if (!ShowPairDialog()) Log("unconfigured — no Admin Code secret, enforcing nothing");
        }

        ConnectIfPaired();
        _lastElapsed = _monotonic.Elapsed;
        _timer.Start();
        OnTick();

        // Brief startup warning if there is time left and not blocked/downtime
        var tick = _agent.Tick(DateTimeOffset.Now, TimeSpan.Zero, _sessionUnlocked, null);
        if (tick.State != Core.EnforcementState.Blocked && tick.RemainingMinutes > 0)
        {
            ShowToast(Strings.AppName, string.Format(Strings.StatusMinutesLeft, tick.RemainingMinutes), TimeSpan.FromSeconds(10));
        }

        return true;
    }

    // --- The tick ----------------------------------------------------------------------

    private void OnTick()
    {
        if (_exiting) return;

        var now = DateTimeOffset.Now;
        var elapsed = _monotonic.Elapsed - _lastElapsed;
        _lastElapsed = _monotonic.Elapsed;
        if (elapsed > MaxCreditedTick) elapsed = TimeSpan.Zero;   // came back from sleep

        CheckBlindStretch(now);

        // Unconfigured: no Admin Code secret, so no authority to enforce and nobody to authorise a
        // stop (ADR-0007). Stay resident — the tray is how a parent pairs this PC, and pairing is
        // what ends the state — but count nothing and cover nothing. Self-correcting: a Client that
        // has just paired sits here until the first hello brings the secret, then enforces normally.
        if (_agent.IsUnconfigured)
        {
            HideBlockScreen();
            ShowTray(TrayState.NotSetUp, Strings.StatusNotSetUp);
            _ = FlushEventsAsync();
            return;
        }

        // Disabled = paused: no enforcement, no counting. Just keep the connection alive and report
        // presence so the server shows "disabled", not "offline" (PRD §5.3).
        if (_agent.IsDisabled)
        {
            HideBlockScreen();
            ShowTray(TrayState.Disabled, Strings.StatusDisabled);
            _secondsSincePing += (int)Math.Max(1, Math.Round(elapsed.TotalSeconds));
            if (_secondsSincePing >= PingEverySeconds)
            {
                _secondsSincePing = 0;
                _ = SendPingAsync(ClientMessages.DisabledPing(_version));
            }
            _ = FlushEventsAsync();
            return;
        }

        var tick = _agent.Tick(now, elapsed, _sessionUnlocked, Win32.ForegroundAppName());
        foreach (var instruction in tick.Instructions) Perform(instruction, tick);

        UpdateTrayText(tick);

        _secondsSincePing += (int)Math.Max(1, Math.Round(elapsed.TotalSeconds));
        if (_secondsSincePing >= PingEverySeconds)
        {
            _secondsSincePing = 0;
            _ = SendPingAsync(tick.PingJson);
        }
        _ = FlushEventsAsync();
    }

    private void Perform(HostInstruction instruction, AgentTick tick)
    {
        switch (instruction.Action)
        {
            case HostAction.MinimizeForeground:
                Win32.MinimizeForeground();
                break;
            case HostAction.ShowBlockScreen:
                ShowBlockScreen(tick);
                break;
            case HostAction.HideBlockScreen:
                HideBlockScreen();
                break;
            // "Less than", because the warning fires on the tick that crosses the threshold — by the
            // time anyone reads it there is genuinely less than that left, never exactly that much.
            case HostAction.Warn15Minutes:
                Warn(instruction.Cause == Core.BlockCause.Downtime ? Strings.Warn15Downtime : Strings.Warn15Left,
                     Strings.WarnWrapUp);
                break;
            case HostAction.Warn5Minutes:
                Warn(instruction.Cause == Core.BlockCause.Downtime ? Strings.Warn5Downtime : Strings.Warn5Left,
                     Strings.WarnSaveNow);
                break;
            case HostAction.ShowMessage:
                // A parent message persists until the kid closes it — the point is that it was seen.
                ShowToast(Strings.MessageFromParent, instruction.Text ?? "", kind: ToastKind.Message);
                break;
            // The agent named the situation and handed over any numbers; the words are chosen here,
            // in this PC's language (ADR-0012).
            case HostAction.ShowApproved:
                ShowToast(string.Format(Strings.AskApprovedTitle, instruction.Minutes),
                    Strings.AskApprovedBody, kind: ToastKind.Approved);
                break;
            case HostAction.ShowDeclined:
                ShowToast(Strings.AskDeclinedTitle, Strings.AskDeclinedBody, kind: ToastKind.Declined);
                break;
            case HostAction.ShowNotice:
                ShowToast(Strings.AppName, NoticeText(instruction), TimeSpan.FromSeconds(8));
                break;
            case HostAction.CheckForUpdate when instruction.Update is { } update:
                _ = CheckForUpdateAsync(update);
                break;
        }
    }

    // --- Block Screen ------------------------------------------------------------------

    private void ShowBlockScreen(AgentTick tick)
    {
        // A Lock can't be lifted by a code (it beats Grants), so don't offer the input during one.
        var locked = tick.TimeLeft.Kind == TimeLeftKind.Locked;
        var reason = BlockReason(locked);

        // Which of the two pictures applies is the *reason*, not the state: an admin Lock and an
        // ended day both read as "out of time" to a kid, and only Downtime says "it is night"
        // (CONTEXT.md: Block Screen Background).
        var slot = tick.TimeLeft.Kind == TimeLeftKind.Downtime ? "downtime" : "blocked";

        if (_blockWindows.Count > 0)
        {
            foreach (var window in _blockWindows)
            {
                window.SetContext(reason, grantAllowed: !locked);
                window.SetBackground(_backgrounds.Get(slot, window.ScreenWidthPixels));
            }
            return;
        }

        var primary = System.Windows.Forms.Screen.PrimaryScreen;
        foreach (var screen in System.Windows.Forms.Screen.AllScreens)
        {
            var isPrimary = primary is null || screen.DeviceName == primary.DeviceName;
            var window = new BlockWindow(screen, isPrimary, TryRedeemFromBlockScreen,
                shutDown: PromptShutDown, exitApp: PromptExit, askForTime: PromptAskForTime,
                reassertAll: ReassertBlockWindows,
                redeemCoupon: RedeemCouponAsync);
            window.SetContext(reason, grantAllowed: !locked);
            // Every cover gets the picture, cropped to its own screen. A photo on one monitor and
            // bare navy on the next looks like a bug.
            window.SetBackground(_backgrounds.Get(slot, window.ScreenWidthPixels));
            window.Show();
            if (isPrimary && !locked) window.FocusInput();
            _blockWindows.Add(window);
        }
        Log($"block screen up on {_blockWindows.Count} screen(s): {reason}");
    }

    private void ReassertBlockWindows()
    {
        foreach (var window in _blockWindows) window.ReassertTopmost();
    }

    private void HideBlockScreen()
    {
        // Called unconditionally by the disabled and unconfigured paths on every tick, so the
        // no-op case has to be silent — otherwise the log fills with "block screen down" once a
        // second and buries everything that matters.
        if (_blockWindows.Count == 0) return;

        foreach (var window in _blockWindows)
        {
            // Release anything still riding on this cover before it closes, or a message the kid has
            // not read yet is destroyed along with its owner. Snapshotted: clearing Owner mutates
            // OwnedWindows underneath the enumerator.
            foreach (var owned in window.OwnedWindows.Cast<Window>().ToArray())
            {
                // Detaching a window that is mid-ShowDialog is the awkward case (a tick can lift the
                // cover while the kid is in the ask dialog). Worth attempting — the alternative is
                // the dialog vanishing under them — but never worth failing the tick over.
                try { owned.Owner = null; }
                catch (InvalidOperationException ex) { Log($"could not detach dialog: {ex.Message}"); }
            }
            window.AllowCloseAndClose();
        }
        _blockWindows.Clear();
        Log("block screen down");
    }

    /// <summary>The cover carrying the controls, if one is up. Everything this app puts on screen
    /// while blocked is owned by it — see the note on <see cref="BlockWindow"/>.</summary>
    private BlockWindow? PrimaryBlock => _blockWindows.FirstOrDefault(w => w.IsPrimary);

    /// <summary>Shows a dialog that may have been opened from the Block Screen. Owning it to the
    /// cover is what keeps it visible; suspending the cover's focus grab is what keeps it typable.</summary>
    private bool ShowOverBlockScreen(Window dialog)
    {
        if (PrimaryBlock is { } owner)
        {
            dialog.Owner = owner;
            dialog.Topmost = true;
            dialog.WindowStartupLocation = WindowStartupLocation.CenterOwner;
        }

        var covers = _blockWindows.ToArray();
        foreach (var window in covers) window.YieldFocus = true;
        try
        {
            return dialog.ShowDialog() == true;
        }
        finally
        {
            foreach (var window in covers) window.YieldFocus = false;
        }
    }

    /// <summary>Toasts go through here for the same reason dialogs do: an unowned notification shown
    /// while the Block Screen is up is buried within two seconds, which is exactly when a kid is most
    /// likely to be sent one.</summary>
    private void ShowToast(string title, string body, TimeSpan? autoDismiss = null,
        ToastKind kind = ToastKind.Info)
    {
        var toast = new ToastWindow(title, body, autoDismiss, kind);
        if (PrimaryBlock is { } owner) toast.Owner = owner;
        toast.Show();
    }

    /// <summary>The words for a mechanical answer to a Request. The agent decides *which* of these
    /// applies; this decides how it reads.</summary>
    private static string NoticeText(HostInstruction instruction) => instruction.Notice switch
    {
        NoticeKind.RequestSent => Strings.AskSent,
        NoticeKind.RequestAlreadyOpen => Strings.AskAlreadyOpen,
        NoticeKind.RequestCooldown => string.Format(Strings.AskCooldown, instruction.Minutes),
        NoticeKind.CouponGranted => string.Format(Strings.CouponGranted, instruction.Minutes),
        // Reached only via Handle on a reconnect race — the entry box has normally already shown
        // the sentence directly — but mapped for safety so a toast is never blank.
        NoticeKind.CouponAlreadyUsed => Strings.CouponAlreadyUsed,
        NoticeKind.CouponExpired => Strings.CouponExpired,
        NoticeKind.CouponWrongClient => Strings.CouponWrongClient,
        NoticeKind.CouponInvalid => Strings.CouponInvalid,
        _ => instruction.Text ?? "",
    };

    private string BlockReason(bool locked)
    {
        if (locked) return Strings.BlockReasonLocked;
        var settings = _agent.State.Settings.ToSettings();
        return settings.IsDowntime(TimeOnly.FromDateTime(DateTime.Now))
            ? string.Format(Strings.BlockReasonDowntime, settings.DowntimeEnd.ToString(@"HH\:mm"))
            : Strings.BlockReasonUsedUp;
    }

    private RedeemResult TryRedeemFromBlockScreen(string input) => TryRedeem(input, "the block screen");

    /// <summary>Redeeming an Extra Time Code, from wherever it was typed. Also closes an open Request:
    /// the kid has just settled the question themselves, and a parent answering it ten minutes later
    /// would be answering something that no longer exists — and handing out a second helping of
    /// minutes for it (CONTEXT.md: Request).</summary>
    private RedeemResult TryRedeem(string input, string where)
    {
        var result = _agent.RedeemGrant(input, DateTimeOffset.Now);
        if (result != RedeemResult.Granted) return result;

        _ = WithdrawRequestAsync();
        Log($"grant redeemed on {where}");
        // Reflect it immediately rather than waiting up to a second for the next tick.
        var tick = _agent.Tick(DateTimeOffset.Now, TimeSpan.Zero, _sessionUnlocked, null);
        foreach (var instruction in tick.Instructions) Perform(instruction, tick);
        if (tick.State != Core.EnforcementState.Blocked) HideBlockScreen();
        _ = SendPingAsync(tick.PingJson);
        return result;
    }

    /// <summary>Redeeming a Time Coupon, from wherever it was typed. Async because only the server
    /// can judge one (ADR-0017): gate locally (format, downtime), refuse honestly when the server
    /// is not there, then send and wait briefly for the coupon-status the agent will have already
    /// applied by the time it lands. Returns null on success, else the sentence to show.</summary>
    private async Task<string?> RedeemCouponAsync(string input)
    {
        var gate = _agent.PrepareCouponRedeem(input, DateTimeOffset.Now, out var json);
        if (gate == Core.CouponGate.InvalidFormat) return Strings.CouponInvalid;
        if (gate == Core.CouponGate.Downtime) return Strings.CouponDowntime;
        if (_link is null || !_link.IsConnected) return Strings.CouponOffline;

        _couponWait = new TaskCompletionSource<Core.ServerMessage.CouponStatus>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        if (!await _link.TrySendAsync(json!)) { _couponWait = null; return Strings.CouponOffline; }

        var answered = await Task.WhenAny(_couponWait.Task, Task.Delay(TimeSpan.FromSeconds(6)));
        var wait = _couponWait;
        _couponWait = null;
        // No answer is indistinguishable from no server — and the coupon is still good, which is
        // the one refusal that invites trying again (ADR-0017).
        if (answered != wait.Task) return Strings.CouponOffline;

        var status = wait.Task.Result;
        if (status.State != Core.CouponState.Granted)
            return status.State switch
            {
                Core.CouponState.Used => Strings.CouponAlreadyUsed,
                Core.CouponState.Expired => Strings.CouponExpired,
                Core.CouponState.WrongClient => Strings.CouponWrongClient,
                _ => Strings.CouponInvalid,
            };

        // Same aftermath as a redeemed Extra Time Code: the question answered itself, so close any
        // open Request, reflect the new state now rather than on the next tick, and tell the server.
        _ = WithdrawRequestAsync();
        Log("time coupon redeemed");
        var tick = _agent.Tick(DateTimeOffset.Now, TimeSpan.Zero, _sessionUnlocked, null);
        foreach (var instruction in tick.Instructions) Perform(instruction, tick);
        if (tick.State != Core.EnforcementState.Blocked) HideBlockScreen();
        _ = SendPingAsync(tick.PingJson);
        return null;
    }

    // --- Server link -------------------------------------------------------------------

    private void ConnectIfPaired()
    {
        var state = _agent.State;
        if (!state.IsPaired) return;

        _link?.Dispose();
        _link = new ServerLink(state.ServerUrl!, state.ClientToken!,
            onMessage: message => _application.Dispatcher.Invoke(() => OnServerMessage(message)),
            onConnectionChanged: online => _application.Dispatcher.Invoke(() => OnConnectionChanged(online)),
            log: Log);
        _link.Start();
    }

    private void OnConnectionChanged(bool online)
    {
        _online = online;
        var now = DateTimeOffset.Now;
        if (online)
        {
            _agent.NoteServerContact(now);
            _blindLogged = false;
        }
        _blindSince = now;
    }

    /// <summary>Notes a long blind stretch once per run. The Event queues while offline and lands on
    /// reconnect, so the parent learns about it even though the report could not be sent at the time.</summary>
    private async Task SyncBackgroundsAsync(BackgroundSet wanted)
    {
        var state = _agent.State;
        if (state.ServerUrl is null || state.ClientToken is null) return;
        await _backgrounds.SyncAsync(wanted, state.ServerUrl, state.ClientToken);
    }

    /// <summary>Re-read the pictures onto covers that are already up.</summary>
    private void RefreshBlockBackgrounds()
    {
        if (_blockWindows.Count == 0) return;
        var slot = _agent.TimeLeft.Kind == TimeLeftKind.Downtime ? "downtime" : "blocked";
        foreach (var window in _blockWindows)
            window.SetBackground(_backgrounds.Get(slot, window.ScreenWidthPixels));
    }

    private void CheckBlindStretch(DateTimeOffset now)
    {
        if (_online || _blindLogged || !_agent.IsPaired) return;
        if (now - _blindSince < BlindBeforeLogging) return;

        _blindLogged = true;
        _agent.LogServerUnreachable(now - _blindSince, now);
        Log($"server unreachable for {(now - _blindSince).TotalMinutes:F0} min — still enforcing last-known settings");
    }

    private void OnServerMessage(ServerMessage message)
    {
        var now = DateTimeOffset.Now;
        foreach (var instruction in _agent.Handle(message, now))
        {
            var tick = _agent.Tick(now, TimeSpan.Zero, _sessionUnlocked, null);
            Perform(instruction, tick);
        }

        // The agent has already applied any coupon bonus and produced the toast above, by the time
        // the waiter wakes — so the entry box and the enforcement state agree the moment it resumes.
        if (message is Core.ServerMessage.CouponStatus couponStatus)
            _couponWait?.TrySetResult(couponStatus);

        // Backgrounds arrive in hello and again whenever the admin changes one. Both carry the set
        // already resolved for this Client, so there is one path.
        var backgrounds = message switch
        {
            ServerMessage.Hello hello => hello.Backgrounds,
            ServerMessage.BackgroundsChanged changed => changed.Backgrounds,
            _ => null,
        };
        if (backgrounds is not null) _ = SyncBackgroundsAsync(backgrounds);

        // Disable/Enable flips the whole enforcement path; just re-tick, which honours IsDisabled.
        if (message is ServerMessage.Disable or ServerMessage.Enable)
        {
            Log(_agent.IsDisabled ? "disabled by the server" : "enabled by the server");
            OnTick();
            return;
        }

        // Anything that changes availability re-evaluates what should be on screen right now. An
        // approved Request belongs here too: the minutes it grants have to lift the cover the kid is
        // staring at, not wait for the next tick.
        if (message is ServerMessage.SettingsChanged or ServerMessage.Adjust
            or ServerMessage.LockNow or ServerMessage.Unlock or ServerMessage.EndToday
            or ServerMessage.RequestStatus { State: RequestState.Approved })
        {
            var tick = _agent.Tick(now, TimeSpan.Zero, _sessionUnlocked, Win32.ForegroundAppName());
            foreach (var instruction in tick.Instructions) Perform(instruction, tick);
            if (tick.State == Core.EnforcementState.Blocked) ShowBlockScreen(tick); else HideBlockScreen();
            _ = SendPingAsync(tick.PingJson);   // reflect the new state on the server immediately
        }
    }

    // --- Self-update (PRD §6.7) ---------------------------------------------------------

    /// <summary>Decide and apply a self-update. The key is the exe's own SHA-256: if it already matches
    /// the offer, this is a no-op. Otherwise download, verify, swap, and restart (via the Scheduled Task).</summary>
    private async Task CheckForUpdateAsync(UpdateInfo update)
    {
        if (_updating) return;
        _updating = true;
        try
        {
            var exePath = Environment.ProcessPath;
            if (exePath is null) return;

            if (string.Equals(await Sha256Async(exePath), update.Sha256, StringComparison.OrdinalIgnoreCase))
                return;   // already running this build

            var state = _agent.State;
            if (!state.IsPaired) return;

            Log($"update offered: {update.Version} ({update.Sha256[..12]}…) — downloading");
            var downloaded = Path.Combine(Path.GetDirectoryName(exePath)!, "DigitalAid.new.exe");

            using (var http = new HttpClient { BaseAddress = new Uri(state.ServerUrl!), Timeout = TimeSpan.FromMinutes(5) })
            {
                http.DefaultRequestHeaders.Add("x-client-token", state.ClientToken!);
                await using var src = await http.GetStreamAsync(update.Path);
                await using var dst = File.Create(downloaded);
                await src.CopyToAsync(dst);
            }

            var got = await Sha256Async(downloaded);
            if (!string.Equals(got, update.Sha256, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(downloaded);
                _agent.LogUpdateRejected(update.Version, "sha256-mismatch", DateTimeOffset.Now);
                Log("update discarded: hash mismatch");
                return;
            }

            // Swap: rename running exe aside (allowed while running), move new one into place.
            var old = exePath + ".old";
            if (File.Exists(old)) File.Delete(old);
            File.Move(exePath, old);
            File.Move(downloaded, exePath);

            _agent.PrepareUpdateRestart();   // clean restart, not an unclean exit
            Log($"update staged: {update.Version} — restarting");
            _exiting = true;
            _timer.Stop();
            await FlushEventsAsync();
            _application.Shutdown();   // Scheduled Task relaunches the new exe within a minute
        }
        catch (Exception ex)
        {
            _agent.LogUpdateRejected(update.Version, ex.GetType().Name, DateTimeOffset.Now);
            Log($"update failed: {ex.Message}");
        }
        finally
        {
            _updating = false;
        }
    }

    private static async Task<string> Sha256Async(string path)
    {
        await using var stream = File.OpenRead(path);
        var hash = await System.Security.Cryptography.SHA256.HashDataAsync(stream);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private async Task SendPingAsync(string pingJson)
    {
        if (_link is null) return;
        // A dropped Ping is a gap in the timeline, and a gap is data (PRD §6.5) — never queued.
        if (await _link.TrySendAsync(pingJson)) _agent.NoteServerContact(DateTimeOffset.Now);
    }

    private async Task FlushEventsAsync()
    {
        if (_link is null || !_link.IsConnected) return;

        var batch = _agent.TakeEventBatch();
        if (batch is null) return;

        if (await _link.TrySendAsync(batch.Json)) _agent.CommitEventBatch();
        // Otherwise it stays in flight and is re-sent later; the server dedupes on seq (ADR-0001).
    }

    // --- Session and shutdown -----------------------------------------------------------

    private void OnSessionSwitch(object sender, SessionSwitchEventArgs e)
    {
        _sessionUnlocked = e.Reason switch
        {
            SessionSwitchReason.SessionLock or SessionSwitchReason.SessionLogoff
                or SessionSwitchReason.ConsoleDisconnect or SessionSwitchReason.RemoteDisconnect => false,
            SessionSwitchReason.SessionUnlock or SessionSwitchReason.SessionLogon
                or SessionSwitchReason.ConsoleConnect or SessionSwitchReason.RemoteConnect => true,
            _ => _sessionUnlocked,
        };
        Log($"session {e.Reason} → {(_sessionUnlocked ? "unlocked" : "locked")}");
        OnTick();
    }

    private void OnSessionEnding(object sender, SessionEndingEventArgs e)
    {
        Log($"session ending: {e.Reason}");
        _agent.ShutdownCleanly(DateTimeOffset.Now);
        _ = FlushEventsAsync();
    }

    // --- Tray --------------------------------------------------------------------------

    private void BuildTrayMenu()
    {
        var menu = new System.Windows.Forms.ContextMenuStrip();
        menu.Items.Add(Strings.TrayTimeLeft, null, (_, _) => ShowFlyout());
        menu.Items.Add(Strings.TrayAskForTime, null, (_, _) => PromptAskForTime());
        menu.Items.Add(Strings.TrayEnterCode, null, (_, _) => PromptExtraTimeCode());
        // Stepping away without spending Usage Time. The clock only runs while the session is
        // unlocked, so locking it *is* the feature — this is here because a keyboard shortcut
        // nobody mentions is not one.
        menu.Items.Add(Strings.TrayLockScreen, null, (_, _) => Win32.LockScreen());
        menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
        var reconnect = new System.Windows.Forms.ToolStripMenuItem(Strings.TrayReconnect, null,
            (_, _) => { if (_link is null) ConnectIfPaired(); else _link.RetryNow(); });
        menu.Items.Add(reconnect);
        // Built on open rather than on a timer: the countdown only has to be right at the moment
        // someone is looking at it, and it also answers the question that asks for this item at all
        // — "is it even trying?"
        menu.Opening += (_, _) =>
        {
            reconnect.Enabled = !_online;
            reconnect.Text = ReconnectLabel();
        };
        menu.Items.Add(Strings.TrayPair, null, (_, _) => { if (PromptPair()) ConnectIfPaired(); });
        menu.Items.Add(Strings.TrayExit, null, (_, _) => PromptExit());
        menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
        menu.Items.Add(BuildLanguageMenu());
        menu.Items.Add(Strings.TrayAbout, null, (_, _) => ShowAbout());
        _tray.ContextMenuStrip = menu;
    }

    /// <summary>The language submenu: two radio items, no "system default" third. The choice is
    /// this PC's and is written to the state file, so it survives a restart and an update, and beats
    /// whatever Windows is set to from then on (ADR-0012).
    ///
    /// Rebuilt rather than re-labelled after a switch: every caption in the tray, including this
    /// menu's own, has just changed language.</summary>
    private System.Windows.Forms.ToolStripMenuItem BuildLanguageMenu()
    {
        var current = Language.Resolve(_agent.State.Language);
        var parent = new System.Windows.Forms.ToolStripMenuItem(Strings.TrayLanguage);

        foreach (var code in Language.All)
        {
            var item = new System.Windows.Forms.ToolStripMenuItem(Language.NameOf(code))
            {
                Checked = code == current,
                CheckOnClick = false,
            };
            var chosen = code;
            item.Click += (_, _) => ChooseLanguage(chosen);
            parent.DropDownItems.Add(item);
        }
        return parent;
    }

    private void ChooseLanguage(string code)
    {
        if (code == Language.Resolve(_agent.State.Language)) return;

        _agent.SetLanguage(code);
        Language.Apply(code);
        Log($"language set to {code}");

        // Everything already on screen is in the old language. The tray menu is rebuilt outright;
        // an open Block Screen is re-captioned in place, because it cannot simply be closed and it
        // is the one window a kid may be staring at while a parent changes this.
        BuildTrayMenu();
        RefreshBlockText();
    }

    /// <summary>Re-caption a cover that is already up, after a language change.</summary>
    private void RefreshBlockText()
    {
        if (_blockWindows.Count == 0) return;
        var locked = _agent.TimeLeft.Kind == TimeLeftKind.Locked;
        var reason = BlockReason(locked);
        foreach (var window in _blockWindows) window.SetContext(reason, grantAllowed: !locked);
    }

    private string ReconnectLabel()
    {
        if (_online) return Strings.TrayConnected;
        if (_link?.NextAttemptAt is not { } due) return Strings.TrayReconnectTrying;

        var left = due - DateTimeOffset.Now;
        if (left <= TimeSpan.FromSeconds(1)) return Strings.TrayReconnectTrying;
        return left < TimeSpan.FromMinutes(1)
            ? string.Format(Strings.TrayReconnectInSec, (int)left.TotalSeconds)
            : string.Format(Strings.TrayReconnectInMin, (int)Math.Ceiling(left.TotalMinutes));
    }

    private void UpdateTrayText(AgentTick tick)
    {
        var status = tick.State switch
        {
            Core.EnforcementState.Blocked => Strings.StatusBlocked,
            Core.EnforcementState.GrantActive => string.Format(Strings.StatusExtraTime, tick.RemainingMinutes),
            Core.EnforcementState.ScreenLocked => Strings.StatusScreenLocked,
            _ => string.Format(Strings.StatusMinutesLeft, tick.RemainingMinutes),
        };

        // RunningLow before the plain cases, and taken from the tick rather than recomputed: it is
        // the same number the 15-minute warning uses, so the icon turns amber on the tick the toast
        // appears instead of at a second, subtly different fifteen minutes.
        var state = tick.State switch
        {
            Core.EnforcementState.Blocked => TrayState.Blocked,
            Core.EnforcementState.ScreenLocked => TrayState.ScreenLocked,
            _ when tick.RunningLow => TrayState.RunningLow,
            Core.EnforcementState.GrantActive => TrayState.OnExtraTime,
            _ => TrayState.Fine,
        };
        ShowTray(state, status);
    }

    /// <summary>The tray in one place: colour and badge from the state, words from the tooltip.</summary>
    private void ShowTray(TrayState state, string status)
    {
        var link = _online ? TrayLink.Connected
            : _link?.Rejected == true ? TrayLink.Rejected
            : TrayLink.Offline;

        var icon = _trayIcons.Get(state, link);
        if (!ReferenceEquals(_tray.Icon, icon)) _tray.Icon = icon;

        var suffix = link switch
        {
            TrayLink.Rejected => Strings.StatusDisconnected,
            TrayLink.Offline => Strings.StatusOffline,
            _ => "",
        };
        // NotifyIcon tooltips are capped at 63 characters.
        var text = string.Format(Strings.TrayTooltip, status, suffix);
        _tray.Text = text.Length > 63 ? text[..63] : text;
    }

    /// <summary>The Flyout, at most one at a time. An impatient double-click, or the tray menu item
    /// while one is already up, used to stack identical copies of a glance on top of each other.
    ///
    /// Closed and rebuilt rather than raised: the window takes a *snapshot* of Time Left in its
    /// constructor, so re-activating an old one would show whatever was left when it was first
    /// opened. The Flyout answers "how long have I got, right now" — a stale answer is worse than
    /// no window at all, and rebuilding it costs nothing.</summary>
    private void ShowFlyout()
    {
        _flyout?.Close();
        var window = new FlyoutWindow(_agent.TimeLeft, _agent.State.Settings.ToSettings(), _online,
            _agent.TimeSinceServerContact(DateTimeOffset.Now), _link?.Rejected == true,
            stepAway: Win32.LockScreen, requestTime: PromptAskForTime, enterCode: PromptExtraTimeCode);
        // Identity-checked so a late Closed from the window we just replaced cannot null out its
        // successor.
        window.Closed += (_, _) => { if (ReferenceEquals(_flyout, window)) _flyout = null; };
        _flyout = window;
        window.Show();
    }

    /// <summary>About, at most one at a time. Raised rather than rebuilt — unlike the Flyout it
    /// shows nothing that goes stale, so there is nothing to refresh and a window already on screen
    /// is the right window.</summary>
    private void ShowAbout()
    {
        if (_about is not null) { _about.Activate(); return; }
        var window = new AboutWindow();
        window.Closed += (_, _) => { if (ReferenceEquals(_about, window)) _about = null; };
        _about = window;
        window.Show();
    }

    /// <summary>Pairing from the tray. Re-Pairing an already-set-up Client costs an Admin Code first:
    /// it is the one action that hands the whole policy over at once, since a Client pointed at a
    /// server the kid runs has whatever Allowance and Downtime that server says, while the real
    /// server sees only a machine that went quiet. An Unconfigured Client is ungated — there is no
    /// secret to check and nobody to ask (ADR-0007).</summary>
    private bool PromptPair()
    {
        if (!_agent.IsUnconfigured)
        {
            var gate = CodePromptWindow.ForRepair(
                code => _agent.VerifyFamilyCode(code, DateTimeOffset.Now));
            if (!ShowOverBlockScreen(gate)) return false;
        }
        return ShowPairDialog();
    }

    private bool ShowPairDialog()
    {
        var dialog = new PairWindow();
        if (dialog.ShowDialog() != true || dialog.Result is null || dialog.ServerUrl is null) return false;

        _agent.SavePairing(dialog.ServerUrl, dialog.Result);
        Log($"paired as client {dialog.Result.ClientId}");
        
        ConnectIfPaired();
        _secondsSincePing = PingEverySeconds; // force a ping on next tick
        
        return true;
    }

    /// <summary>Exit protection, from the tray or the Block Screen. Passing the boot id stands the app
    /// down, so the Scheduled Task does not restart it a minute later (ADR-0004).</summary>
    private void PromptExit()
    {
        if (_agent.IsUnconfigured)
        {
            // No secret to check a code against, and nothing being enforced that stopping would
            // release (ADR-0007). Confirm rather than interrogate — the alternative was an app
            // nobody could turn off, including the parent.
            var answer = MessageBox.Show(
                Strings.UnconfiguredStop, Strings.AppName, MessageBoxButton.YesNo, MessageBoxImage.Question);
            if (answer != MessageBoxResult.Yes) return;

            _agent.AuthorizeExit(null, DateTimeOffset.Now, _bootId);
            Log("stood down while unconfigured — no Admin Code secret to check a code against");
            _ = ExitAsync();
            return;
        }

        var dialog = CodePromptWindow.ForExit(code => _agent.AuthorizeExit(code, DateTimeOffset.Now, _bootId));
        if (ShowOverBlockScreen(dialog))
        {
            Log("stood down by Admin Code — the scheduled task will not restart it today");
            _ = ExitAsync();
        }
    }

    /// <summary>"Ask for more time", from the tray or the Block Screen — the one kid→parent action in
    /// this app (CONTEXT.md: Request). Sent live and never queued: a Request is a live ask, and one
    /// delivered an hour late answers a question nobody is asking any more.</summary>
    private void PromptAskForTime()
    {
        // No code box when the cover is up: it already carries an identical input a few pixels away.
        var dialog = new RequestTimeWindow(
            PrimaryBlock is null ? input => TryRedeem(input, "the ask dialog") : null,
            PrimaryBlock is null ? RedeemCouponAsync : null);
        if (!ShowOverBlockScreen(dialog)) return;
        if (dialog.CodeRedeemed) return;

        var json = _agent.RequestMoreTime(dialog.Minutes, DateTimeOffset.Now);
        if (json is null) return;

        Log($"asked for {dialog.Minutes} more minutes");
        _ = AskAsync(json);
    }

    /// <summary>Best-effort: if it never leaves, the Request lapses on its own an hour later.</summary>
    private async Task WithdrawRequestAsync()
    {
        if (_link is null) return;
        await _link.TrySendAsync(ClientMessages.WithdrawRequest());
    }

    /// <summary>Redeeming a code from the tray, for the case the Block Screen cannot serve: a parent
    /// giving time *before* it runs out.</summary>
    private void PromptExtraTimeCode()
    {
        var dialog = new ExtraTimeCodeWindow(input => TryRedeem(input, "the tray"), RedeemCouponAsync);
        ShowOverBlockScreen(dialog);
    }

    private async Task AskAsync(string json)
    {
        // The server answers with a request-status message, which arrives through OnServerMessage
        // like anything else. Only the "we never got it out" case is reported here.
        if (_link is not null && await _link.TrySendAsync(json)) return;

        Log("could not send the request — server unreachable");
        ShowToast(Strings.AppName, Strings.AskUnreachable, TimeSpan.FromSeconds(10));
    }

    /// <summary>Shut Windows down from the Block Screen. No code: a kid can hold the power button
    /// anyway, so gating this would be theatre — and a clean shutdown produces a proper os-shutdown
    /// Event where a held power button produces an unclean-exit stripe.</summary>
    private void PromptShutDown()
    {
        var covers = _blockWindows.ToArray();
        foreach (var window in covers) window.YieldFocus = true;
        MessageBoxResult confirm;
        try
        {
            // Owned to the cover for the same reason the dialogs are; MessageBox has no Topmost of
            // its own, so ownership is the only thing keeping it in front.
            confirm = PrimaryBlock is { } owner
                ? MessageBox.Show(owner, Strings.ShutDownConfirm, Strings.AppName, MessageBoxButton.YesNo, MessageBoxImage.Question)
                : MessageBox.Show(Strings.ShutDownConfirm, Strings.AppName, MessageBoxButton.YesNo, MessageBoxImage.Question);
        }
        finally
        {
            foreach (var window in covers) window.YieldFocus = false;
        }
        if (confirm != MessageBoxResult.Yes) return;

        Log("shutdown requested from the block screen");
        try
        {
            // shutdown.exe rather than ExitWindowsEx: it needs no privilege juggling from an
            // unelevated process, and Windows still raises SessionEnding so the exit is logged.
            using var process = Process.Start(new ProcessStartInfo("shutdown.exe", "/s /t 0")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
            });
        }
        catch (Exception ex)
        {
            Log($"shutdown failed: {ex.Message}");
        }
    }

    // Warnings auto-dismiss; parent messages don't (see ShowMessage). PRD §6.2.
    private void Warn(string title, string body) =>
        ShowToast(title, body, TimeSpan.FromSeconds(15), ToastKind.Warning);

    private async Task ExitAsync()
    {
        _exiting = true;
        _timer.Stop();
        // Give the queue one last chance to reach the server so the exit itself is in the log.
        await FlushEventsAsync();
        await Task.Delay(300);
        _application.Shutdown();
    }

    public static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(Paths.Root);
            File.AppendAllText(Paths.LogFile, $"{DateTimeOffset.Now:yyyy-MM-dd HH:mm:sszzz} {message}{Environment.NewLine}");
        }
        catch (IOException) { /* logging must never break enforcement */ }
    }

    public void Dispose()
    {
        SystemEvents.SessionSwitch -= OnSessionSwitch;
        SystemEvents.SessionEnding -= OnSessionEnding;
        _timer.Stop();
        _link?.Dispose();
        _tray.Visible = false;
        _tray.Dispose();
        // After the NotifyIcon, which is still holding one of these.
        _trayIcons.Dispose();
    }
}

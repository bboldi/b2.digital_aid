using System.Reflection;
using System.Windows;
using System.Windows.Controls;
using DigitalAid.Client.Core;

namespace DigitalAid.Client.App.Ui;

/// <summary>
/// About and diagnostics in one window, reachable from the tray and from <c>--status</c>.
///
/// One surface rather than two: nothing here is a secret — the Admin Code secret is never
/// displayed, and everything else is the kid's own data, which the Flyout already shows them. The
/// parent's instinct at the machine is to right-click the tray, not to find a command-line flag,
/// so the flag renders this same window rather than a second one that drifts out of step.
/// </summary>
public sealed class AboutWindow : Window
{
    public AboutWindow()
    {
        var state = new StateStore(Paths.StateFile).Load();
        var queued = new EventQueue(Paths.EventQueueFile).PendingCount();
        var settings = state.Settings.ToSettings();
        var counters = state.Counters.ToSnapshot();

        Title = Strings.AboutTitle;
        Width = 460;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;

        var panel = new StackPanel { Margin = new Thickness(18) };
        panel.Children.Add(new TextBlock
        {
            Text = Strings.AppName,
            FontSize = 20,
            FontWeight = FontWeights.SemiBold,
        });
        panel.Children.Add(new TextBlock
        {
            Text = DescribeVersion(state.LastVersion),
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 2, 0, 0),
        });
        // Text, not hyperlinks. This window opens from the Block Screen's tray on a machine that is
        // blocked, and a clickable URL there is a browser launched out of the one surface built to
        // stop exactly that.
        panel.Children.Add(new TextBlock
        {
            Text = string.Join(Environment.NewLine,
                string.Format(Strings.AboutMadeBy, Branding.Author, Branding.Website),
                Branding.Email,
                string.Format(Strings.AboutOpenSource, Branding.License, Branding.Repository)),
            TextWrapping = TextWrapping.Wrap,
            Opacity = 0.75,
            Margin = new Thickness(0, 6, 0, 14),
        });
        panel.Children.Add(new TextBox
        {
            Text = Details(state, settings, counters, queued),
            IsReadOnly = true,
            BorderThickness = new Thickness(0),
            Background = System.Windows.Media.Brushes.Transparent,
            FontFamily = new System.Windows.Media.FontFamily("Consolas, Courier New, monospace"),
            TextWrapping = TextWrapping.NoWrap,
        });

        var close = new Button
        {
            Content = Strings.Close,
            MinWidth = 90,
            Margin = new Thickness(0, 14, 0, 0),
            HorizontalAlignment = HorizontalAlignment.Right,
            IsDefault = true,
            IsCancel = true,
        };
        close.Click += (_, _) => Close();
        panel.Children.Add(close);
        Content = panel;
    }

    /// <summary>The *running* build, which is not always what the state file says. `LastVersion` is
    /// recorded at startup, so on the first launch after a self-update the two disagree until the
    /// update-installed Event is queued — and "did the update actually land" is precisely the
    /// question someone opens this window to answer.</summary>
    private static string DescribeVersion(string? recorded)
    {
        var running = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";
        return recorded is null || recorded == running
            ? string.Format(Strings.AboutVersion, running)
            : string.Format(Strings.AboutVersionUpdated, running, recorded);
    }

    /// <summary>The diagnostic block, as aligned label/value pairs. The column is computed rather
    /// than typed: "Stood down:" and "Leállítva:" are different widths, and a layout hand-spaced for
    /// one language comes out ragged in the other.</summary>
    private static string Details(ClientState state, Settings settings, EngineSnapshot counters, int queued)
    {
        var rows = new (string Label, string Value)[]
        {
            (Strings.AboutLabelServer, state.ServerUrl ?? Strings.AboutNotPaired),
            (Strings.AboutLabelClientId, state.IsPaired ? state.ClientId.ToString() : "—"),
            (Strings.AboutLabelSetup, DescribeSetup(state)),
            (Strings.AboutLabelDisabled, state.Disabled ? Strings.AboutDisabledYes : Strings.AboutNo),
            (Strings.AboutLabelStoodDown, DescribeStoodDown()),
            (Strings.AboutLabelLastSeen, DescribeContact(state.LastServerContact)),
            ("", ""),
            (Strings.AboutLabelAllowance,
                string.Format(Strings.AboutAllowanceValue, settings.WeekdayMinutes, settings.WeekendMinutes)),
            (Strings.AboutLabelDowntime,
                $"{settings.DowntimeStart.ToString(@"HH\:mm")}–{settings.DowntimeEnd.ToString(@"HH\:mm")}"),
            (Strings.AboutLabelToday, string.Format(Strings.AboutTodayValue,
                counters.Date, counters.UsedSeconds / 60, (int)counters.GrantRemainingSeconds / 60)),
            ("", ""),
            (Strings.AboutLabelQueued, queued.ToString()),
            (Strings.AboutLabelStateFile, Paths.StateFile),
            (Strings.AboutLabelLogFile, Paths.LogFile),
        };

        var width = rows.Max(r => r.Label.Length) + 2;
        return string.Join(Environment.NewLine, rows.Select(r =>
            r.Label.Length == 0 ? "" : (r.Label + ":").PadRight(width) + r.Value));
    }

    /// <summary>An Unconfigured Client looks alive but enforces nothing, so the diagnostic has to say
    /// so out loud — otherwise "it's running and it isn't blocking anything" reads as a bug (ADR-0007).</summary>
    private static string DescribeSetup(ClientState state) =>
        state.IsUnconfigured ? Strings.AboutSetupUnconfigured : Strings.AboutSetupReady;

    /// <summary>Answers the question a parent actually has when they run this: "why is it not
    /// running?". A stand-down cannot be undone from the server, so the diagnostic has to say so
    /// and say how to end it.</summary>
    private static string DescribeStoodDown()
    {
        var bootId = StoodDownMarker.BootIdFrom(
            DateTimeOffset.Now, TimeSpan.FromMilliseconds(Environment.TickCount64));

        // IsHeld, not IsStoodDown: a diagnostic must not consume the marker it is reporting on.
        return new StoodDownMarker(Paths.StoodDownFile).IsHeld(bootId, DateTimeOffset.Now)
            ? Strings.AboutStoodDownYes
            : Strings.AboutNo;
    }

    /// <summary>How long this PC has been enforcing without the server confirming anything. The
    /// diagnostic a parent runs when a Client looks wrong, so it spells out the staleness rather than
    /// printing a bare timestamp to be subtracted by hand.</summary>
    private static string DescribeContact(string? stamp)
    {
        if (!DateTimeOffset.TryParse(stamp, out var last)) return Strings.AboutNeverReached;

        var ago = DateTimeOffset.Now - last;
        var how = ago < TimeSpan.FromMinutes(2) ? Strings.AboutJustNow
            : ago < TimeSpan.FromHours(1) ? string.Format(Strings.AboutMinutesAgo, (int)ago.TotalMinutes)
            : ago < TimeSpan.FromDays(1) ? string.Format(Strings.AboutHoursAgo, (int)ago.TotalHours)
            : string.Format(Strings.AboutDaysAgo, (int)ago.TotalDays);
        return $"{last:yyyy-MM-dd HH:mm} ({how})";
    }
}

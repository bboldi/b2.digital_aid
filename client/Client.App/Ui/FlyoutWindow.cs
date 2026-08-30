using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using DigitalAid.Client.Core;

namespace DigitalAid.Client.App.Ui;

/// <summary>
/// The kid-facing view (CONTEXT.md: Flyout). Shows their own Time Left — usable right now, not the raw
/// budget (PRD §3.1) — so a kid who can see it draining learns to manage it. Same data the parent sees.
/// </summary>
public sealed class FlyoutWindow : Window
{
    /// <param name="rejected">The server refused this PC's token. Worth its own sentence rather than
    /// another flavour of "offline": it never resolves on its own, and the fix — pairing again — is
    /// something only a parent standing here can do. Saying so is the difference between a mystery
    /// and an action.</param>
    /// <param name="stepAway">Locks the Windows session. Offered here because this is where a kid
    /// looks at their remaining minutes, which is the exact moment "I don't want to waste this"
    /// occurs to them. Null while nothing is usable — the clock is already stopped, so a button that
    /// stops it would be nonsense.</param>
    public FlyoutWindow(TimeLeft timeLeft, Settings settings, bool online, TimeSpan? sinceServerContact,
        bool rejected = false, Action? stepAway = null, Action? requestTime = null, Action? enterCode = null)
    {
        Title = Strings.AppName;
        Width = 340;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = Theme.Panel;

        var panel = new StackPanel { Margin = new Thickness(20) };

        var (headline, sub) = Describe(timeLeft, settings);
        panel.Children.Add(new TextBlock
        {
            Text = headline,
            FontSize = Theme.FontTitle,
            FontWeight = FontWeights.SemiBold,
            Foreground = Theme.TextPrimary,
            TextWrapping = TextWrapping.Wrap,
        });
        if (sub is not null)
        {
            panel.Children.Add(new TextBlock
            {
                Text = sub,
                FontSize = 14,
                Foreground = Theme.TextSecondary,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 8, 0, 0),
            });
        }

        var actionPanel = new WrapPanel { Margin = new Thickness(0, 16, 0, 0) };
        if (requestTime is not null)
        {
            var req = new Button { Content = Strings.TrayAskForTime.TrimEnd('…'), FontSize = Theme.FontBody, Padding = new Thickness(10, 8, 10, 8), Margin = new Thickness(0, 0, 8, 8), Cursor = System.Windows.Input.Cursors.Hand };
            req.Click += (_, _) => { requestTime(); Close(); };
            actionPanel.Children.Add(req);
        }
        if (enterCode is not null)
        {
            var ent = new Button { Content = Strings.TrayEnterCode.TrimEnd('…'), FontSize = Theme.FontBody, Padding = new Thickness(10, 8, 10, 8), Margin = new Thickness(0, 0, 8, 8), Cursor = System.Windows.Input.Cursors.Hand };
            ent.Click += (_, _) => { enterCode(); Close(); };
            actionPanel.Children.Add(ent);
        }
        if (actionPanel.Children.Count > 0)
        {
            panel.Children.Add(actionPanel);
        }

        if (stepAway is not null && timeLeft.Usable)
        {
            var away = new Button
            {
                Content = Strings.FlyoutStepAway,
                FontSize = Theme.FontBody,
                Padding = new Thickness(10, 8, 10, 8),
                Margin = new Thickness(0, actionPanel.Children.Count > 0 ? 8 : 16, 0, 0),
                Cursor = System.Windows.Input.Cursors.Hand,
            };
            away.Click += (_, _) => { stepAway(); Close(); };
            panel.Children.Add(away);

            panel.Children.Add(new TextBlock
            {
                // On a Grant this is a trap unless it says so: grant minutes elapse in real time
                // whether the screen is locked or not, deliberately — otherwise extra time could be
                // banked across the start of Downtime, which a Grant overrides (CONTEXT.md: Grant).
                Text = timeLeft.Kind == TimeLeftKind.Grant
                    ? Strings.FlyoutStepAwayGrant
                    : Strings.FlyoutStepAwayHint,
                FontSize = 12,
                Foreground = Theme.TextDim,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 4, 0, 0),
            });
        }

        panel.Children.Add(new TextBlock
        {
            Text = string.Format(Strings.FlyoutDowntimeIs,
                settings.DowntimeStart.ToString(@"HH\:mm"), settings.DowntimeEnd.ToString(@"HH\:mm")),
            FontSize = 12,
            Foreground = Theme.TextDim,
            Margin = new Thickness(0, 12, 0, 0),
        });
        panel.Children.Add(new TextBlock
        {
            Text = ConnectionLine(online, sinceServerContact, rejected),
            FontSize = 12,
            Foreground = rejected ? Theme.Warn : Theme.TextDim,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 2, 0, 0),
        });

        var close = new Button { Content = Strings.Close, Width = 90, Margin = new Thickness(0, 16, 0, 0), HorizontalAlignment = HorizontalAlignment.Right };
        close.Click += (_, _) => Close();
        panel.Children.Add(close);

        Content = panel;
    }

    /// <summary>Says how stale the rules are while offline. The kid is told, not just the parent —
    /// transparency cuts both ways, and "these limits are from a week ago" is exactly the kind of
    /// thing they would otherwise have to guess at.</summary>
    private static string ConnectionLine(bool online, TimeSpan? since, bool rejected)
    {
        if (online) return Strings.FlyoutOnline;
        if (rejected) return Strings.FlyoutRejected;
        if (since is null) return Strings.FlyoutNeverReached;
        return since.Value < TimeSpan.FromHours(1)
            ? Strings.FlyoutOfflineShort
            : string.Format(Strings.FlyoutOfflineFor, Ago(since.Value));
    }

    private static string Ago(TimeSpan span) => span.TotalDays >= 2
        ? string.Format(Strings.AgoDays, (int)span.TotalDays)
        : span.TotalHours >= 2 ? string.Format(Strings.AgoHours, (int)span.TotalHours) : Strings.AgoOverAnHour;

    private static (string headline, string? sub) Describe(TimeLeft t, Settings settings) => t.Kind switch
    {
        TimeLeftKind.Grant => (string.Format(Strings.FlyoutGrantHeadline, t.Minutes), Strings.FlyoutGrantSub),
        TimeLeftKind.Allowance => (string.Format(Strings.FlyoutLeftToday, t.Minutes), null),
        TimeLeftKind.Downtime => (Strings.FlyoutDowntime,
            string.Format(Strings.FlyoutDowntimeSub, t.Until?.ToString(@"HH\:mm") ?? "")),
        TimeLeftKind.Exhausted => (Strings.FlyoutExhausted, Strings.FlyoutExhaustedSub),
        TimeLeftKind.Locked => (Strings.FlyoutPaused, Strings.FlyoutPausedSub),
        _ => ("—", null),
    };
}

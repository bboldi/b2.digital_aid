using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using DigitalAid.Client.Core;

namespace DigitalAid.Client.App.Ui;

/// <summary>
/// "Ask for more time" — the only screen in this app that runs kid→parent (CONTEXT.md: Request).
///
/// Three buttons and no text box *for the minutes*: the number is advisory (the Admin picks the real
/// minutes), so letting a kid type 240 would only produce a bigger number to be disappointed by. And
/// there is deliberately no message field — a Request carries minutes and nothing else, which is what
/// keeps "ask for more time" from turning into "justify yourself".
///
/// It can also carry an Extra Time Code box, because this is where both halves of the real
/// conversation happen at once: the kid opens it to ask, a parent is already on the phone, and the
/// code gets read out. Opened *from the Block Screen* it does not, since the cover already has an
/// identical input a few pixels away and two of them on one screen is worse than one.
/// </summary>
public sealed class RequestTimeWindow : Window
{
    private static readonly int[] Choices = [15, 30, 60];

    /// <summary>Minutes the kid asked for, once <see cref="Window.DialogResult"/> is true. Zero when
    /// the dialog closed because a code was redeemed instead — see <see cref="CodeRedeemed"/>.</summary>
    public int Minutes { get; private set; }

    /// <summary>Set when the dialog closed because an Extra Time Code granted time. Nothing was
    /// asked of anyone, so there is no Request to send.</summary>
    public bool CodeRedeemed { get; private set; }

    /// <param name="redeem">Supplied everywhere except the Block Screen, which has its own input.</param>
    /// <param name="redeemCoupon">Supplied alongside <paramref name="redeem"/>; null on the Block Screen
    /// path for the same reason.</param>
    public RequestTimeWindow(Func<string, RedeemResult>? redeem = null, Func<string, Task<string?>>? redeemCoupon = null)
    {
        Title = Strings.AskTitle;
        Width = 340;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        // Ownership and topmost are the caller's business: opened from the Block Screen this becomes
        // an owned, topmost child of the cover; opened from the tray it is an ordinary dialog.

        var panel = new StackPanel { Margin = new Thickness(18) };
        panel.Children.Add(new TextBlock
        {
            Text = Strings.AskQuestion,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 12),
        });

        foreach (var minutes in Choices)
        {
            var button = new Button
            {
                Content = string.Format(Strings.AskMinutes, minutes),
                Padding = new Thickness(8),
                Margin = new Thickness(0, 0, 0, 8),
                FontSize = 15,
            };
            button.Click += (_, _) =>
            {
                Minutes = minutes;
                DialogResult = true;
                Close();
            };
            panel.Children.Add(button);
        }

        panel.Children.Add(new TextBlock
        {
            Text = Strings.AskFootnote,
            TextWrapping = TextWrapping.Wrap,
            FontSize = 11,
            Foreground = Brushes.Gray,
            Margin = new Thickness(0, 4, 0, 10),
        });

        if (redeem is not null)
        {
            panel.Children.Add(new Separator { Margin = new Thickness(0, 4, 0, 12) });
            var entry = new ExtraTimeCodeEntry(redeem, redeemCoupon);
            entry.Redeemed += () =>
            {
                CodeRedeemed = true;
                DialogResult = true;
                Close();
            };
            panel.Children.Add(entry);
        }

        var cancel = new Button { Content = Strings.NeverMind, Width = 110, HorizontalAlignment = HorizontalAlignment.Right };
        cancel.Click += (_, _) => Close();
        panel.Children.Add(cancel);

        Content = panel;
    }
}

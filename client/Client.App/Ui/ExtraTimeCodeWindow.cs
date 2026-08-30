using System.Windows;
using System.Windows.Controls;
using DigitalAid.Client.Core;

namespace DigitalAid.Client.App.Ui;

/// <summary>
/// Redeeming an Extra Time Code from the tray, on a machine that is not blocked. This is the case the
/// Block Screen's input cannot serve: a parent handing over time *before* it runs out — "here's
/// thirty minutes so you can finish" — which previously meant waiting for the cover to appear first.
/// </summary>
public sealed class ExtraTimeCodeWindow : Window
{
    public ExtraTimeCodeWindow(Func<string, RedeemResult> redeem, Func<string, Task<string?>>? redeemCoupon = null)
    {
        Title = Strings.ExtraCodeWindow;
        Width = 380;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;

        var entry = new ExtraTimeCodeEntry(redeem, redeemCoupon, Strings.ExtraCodePrompt);
        entry.Redeemed += () => { DialogResult = true; Close(); };

        var panel = new StackPanel { Margin = new Thickness(18) };
        panel.Children.Add(entry);
        Content = panel;

        Loaded += (_, _) => entry.FocusInput();
    }
}

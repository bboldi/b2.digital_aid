using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using DigitalAid.Client.Core;

namespace DigitalAid.Client.App.Ui;

/// <summary>
/// Asks for a 6-digit Admin Code and hands it to a verifier. Used for the two actions that need
/// proof of parental intent at the machine: exiting the app, and re-Pairing it to another server.
///
/// Deliberately not the Block Screen's Grant input (PRD §6.2). Keeping them apart is what stops a
/// code handed over for extra time being spent on something else — and since ADR-0006 the two are
/// not even the same alphabet.
/// </summary>
public sealed class CodePromptWindow : Window
{
    private readonly TextBox _code = new() { MaxLength = 6, FontSize = 20, Margin = new Thickness(0, 6, 0, 10) };
    private readonly TextBlock _status = new() { MinHeight = 20, TextWrapping = TextWrapping.Wrap };
    private readonly Func<string, RedeemResult> _verify;

    public CodePromptWindow(string title, string prompt, string confirmText, Func<string, RedeemResult> verify)
    {
        _verify = verify;

        Title = title;
        Width = 380;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;

        var panel = new StackPanel { Margin = new Thickness(18) };
        panel.Children.Add(new TextBlock { Text = prompt, TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(_code);

        var ok = new Button { Content = confirmText, MinWidth = 140, HorizontalAlignment = HorizontalAlignment.Right };
        ok.Click += (_, _) => Try();
        panel.Children.Add(ok);
        panel.Children.Add(_status);
        Content = panel;

        _code.KeyDown += (_, e) => { if (e.Key == Key.Enter) Try(); };
    }

    /// <summary>Exit protection, from the tray or the Block Screen.</summary>
    public static CodePromptWindow ForExit(Func<string, RedeemResult> verify) => new(
        Strings.ExitWindowTitle, Strings.ExitPrompt, Strings.ExitButton, verify);

    /// <summary>Re-Pairing an already-paired Client. Gated because it is the one action that hands
    /// the whole policy over at once: a Client pointed at another server has whatever Allowance and
    /// Downtime that server says, while the real one sees a machine that simply went quiet.</summary>
    public static CodePromptWindow ForRepair(Func<string, RedeemResult> verify) => new(
        Strings.RepairWindowTitle, Strings.RepairPrompt, Strings.Continue, verify);

    private void Try()
    {
        var result = _verify(_code.Text);
        if (result == RedeemResult.Granted)
        {
            DialogResult = true;
            Close();
            return;
        }
        _status.Text = result switch
        {
            RedeemResult.CodeAlreadyUsed => Strings.AdminCodeUsed,
            RedeemResult.InvalidFormat => Strings.AdminCodeHint,
            _ => Strings.AdminCodeInvalid,
        };
    }
}

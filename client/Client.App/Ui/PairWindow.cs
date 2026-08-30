using System.Windows;
using System.Windows.Controls;
using DigitalAid.Client.Core;

namespace DigitalAid.Client.App.Ui;

/// <summary>Pairing (PROTOCOL §3): server URL plus a current Admin Code. Run once, by the parent,
/// at install time — the PC name is prefilled and becomes the Client's display name.
///
/// If the server recognises this machine it answers with the Client it thinks this is, and the choice
/// is put to whoever is standing here (ADR-0008). Never taken automatically: a cloned VM or a
/// reimaged PC can carry a machine id that is already in use, and adopting on a silent match would
/// fuse two real machines into one Allowance with nothing on screen to explain it.</summary>
public sealed class PairWindow : Window
{
    private readonly TextBox _url = new() { Text = "https://", Margin = new Thickness(0, 2, 0, 10) };
    private readonly TextBox _code = new() { MaxLength = 6, Margin = new Thickness(0, 2, 0, 10) };
    private readonly TextBox _name = new() { Text = Environment.MachineName, Margin = new Thickness(0, 2, 0, 10) };
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap, MinHeight = 20 };
    private readonly Button _pair = new() { Content = Strings.PairButton, Width = 100, HorizontalAlignment = HorizontalAlignment.Right };

    public string? ServerUrl { get; private set; }
    public PairResponse? Result { get; private set; }

    public PairWindow()
    {
        Title = Strings.PairWindowTitle;
        Width = 420;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;

        var panel = new StackPanel { Margin = new Thickness(18) };
        panel.Children.Add(new TextBlock { Text = Strings.PairServerAddress, FontWeight = FontWeights.SemiBold });
        panel.Children.Add(_url);
        panel.Children.Add(new TextBlock { Text = Strings.PairAdminCode, FontWeight = FontWeights.SemiBold });
        panel.Children.Add(_code);
        panel.Children.Add(new TextBlock { Text = Strings.PairPcName, FontWeight = FontWeights.SemiBold });
        panel.Children.Add(_name);
        panel.Children.Add(_pair);
        panel.Children.Add(_status);
        Content = panel;

        _pair.Click += async (_, _) => await TryPairAsync();
    }

    private async Task TryPairAsync()
    {
        var url = _url.Text.Trim();
        var code = _code.Text.Trim();
        if (!Uri.TryCreate(url, UriKind.Absolute, out _) || code.Length != 6)
        {
            _status.Text = Strings.PairPrompt;
            return;
        }

        _pair.IsEnabled = false;
        _status.Text = Strings.PairInProgress;
        try
        {
            var response = await ServerLink.PairAsync(url, code, _name.Text.Trim());
            if (response is null)
            {
                // Almost always an expired code — they roll every 30 seconds.
                _status.Text = Strings.PairRejected;
                return;
            }

            if (response.Match is { } match)
            {
                // The prompt names the Client and when it was last seen, rather than asking a bare
                // yes/no: on a cloned machine those two facts are the only thing that gives the
                // mistake away before it is made.
                var seen = string.IsNullOrWhiteSpace(match.LastSeen)
                    ? Strings.PairAdoptNeverSeen
                    : string.Format(Strings.PairAdoptLastSeen, match.LastSeen);
                var answer = MessageBox.Show(
                    string.Format(Strings.PairAdoptQuestion, match.Name, seen),
                    Strings.AppName, MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
                if (answer == MessageBoxResult.Cancel) { _status.Text = ""; return; }

                object adopt = answer == MessageBoxResult.Yes ? match.ClientId : false;
                // A second code, not the first one replayed: the exchange keeps no state between
                // calls, and the code is still the thing that authorises whichever way this goes.
                response = await ServerLink.PairAsync(url, _code.Text.Trim(), _name.Text.Trim(), adopt);
                if (response?.Token is null)
                {
                    _status.Text = Strings.PairFailed;
                    return;
                }
            }

            ServerUrl = url;
            Result = response;
            DialogResult = true;
            Close();
        }
        catch (Exception ex)
        {
            _status.Text = string.Format(Strings.PairUnreachable, ex.Message);
        }
        finally
        {
            _pair.IsEnabled = true;
        }
    }
}

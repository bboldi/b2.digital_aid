using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using DigitalAid.Client.App.Interop;
using DigitalAid.Client.Core;

namespace DigitalAid.Client.App.Ui;

/// <summary>
/// The Block Screen (PRD §6.2): one instance per monitor, topmost, re-asserted on a timer. Only the
/// primary instance carries the Grant input — the others just cover their screen, which is where the
/// classic escape hatch lives.
///
/// The input accepts Grants only (<c>[code][minutes]</c>). A bare Admin Code does nothing here: it
/// would let a kid told "code plus 30" exit the app instead.
///
/// Nothing on this screen explains the format. The parent's page does — a kid who knows the minutes
/// are just typed on the end knows they can claim 999 of them, and this is the one place we can
/// avoid teaching that. Codes are read out complete ("482913 30"), so no instruction is needed.
///
/// It also carries the two ways out of a blocked machine, because it covers the taskbar and is
/// therefore the only surface anyone can reach while blocked: Shut down (no code — a kid can hold
/// the power button anyway, and a clean shutdown logs better than a hard one) and Exit application
/// (a bare Admin Code, which stands the app down until midnight or the next reboot).
///
/// And "Ask for more time", which sits with the Grant input rather than in the quiet row below it:
/// it is the one control here meant for the kid, and the cover is exactly where they are when they
/// want it (CONTEXT.md: Request).
///
/// Everything those controls open — dialogs, toasts — must be an *owned* window of the primary
/// cover. The primary cover re-asserts every cover topmost every two seconds, which puts them back
/// above anything else in the topmost band; ownership is the one relationship that survives that,
/// because Windows keeps an owned window above its owner unconditionally.
/// </summary>
public sealed class BlockWindow : Window
{
    private readonly System.Windows.Forms.Screen _screen;
    private readonly Func<string, RedeemResult> _redeem;
    private readonly Func<string, Task<string?>>? _redeemCoupon;
    private readonly Action _shutDown;
    private readonly Action _exitApp;
    private readonly Action _askForTime;
    private readonly Action _reassertAll;
    private readonly DispatcherTimer _reassert;
    private readonly TextBox? _input;
    private readonly StackPanel? _grantPanel;
    private readonly TextBlock? _feedback;
    private readonly TextBlock _reason;
    private readonly System.Windows.Controls.Image _background;
    private readonly Border _scrim;

    private bool _allowClose;

    /// <summary>This cover's screen width in device pixels — what a background image only needs to
    /// be decoded to. Decoding a phone photo at full size costs tens of megabytes per monitor and
    /// buys nothing that can be seen.</summary>
    public int ScreenWidthPixels => _screen.Bounds.Width;

    /// <summary>The screen carrying the controls. The other covers are blank, so anything that needs
    /// to sit above the cover is owned by this one.</summary>
    public bool IsPrimary { get; }

    /// <summary>Set while one of our own windows is in front (a dialog, a toast). The cover keeps
    /// re-asserting itself over foreign windows, but it must stop grabbing the keyboard back — a
    /// dialog you cannot type into is worse than no dialog.</summary>
    public bool YieldFocus { get; set; }

    public BlockWindow(System.Windows.Forms.Screen screen, bool showInput, Func<string, RedeemResult> redeem,
        Action shutDown, Action exitApp, Action askForTime, Action reassertAll,
        Func<string, Task<string?>>? redeemCoupon = null)
    {
        _screen = screen;
        _redeem = redeem;
        _redeemCoupon = redeemCoupon;
        _shutDown = shutDown;
        _exitApp = exitApp;
        _askForTime = askForTime;
        _reassertAll = reassertAll;
        IsPrimary = showInput;

        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        Topmost = true;
        Background = Theme.Surface;
        Foreground = Theme.TextPrimary;
        Cursor = Cursors.Arrow;

        // UniformToFill crops rather than distorts: one image is shown on monitors of different
        // shapes, and a stretched photo looks broken in a way a cropped one does not.
        _background = new System.Windows.Controls.Image
        {
            Stretch = Stretch.UniformToFill,
            Visibility = Visibility.Collapsed,
        };
        _scrim = new Border { Background = Theme.ImageScrim, Visibility = Visibility.Collapsed };

        var panel = new StackPanel
        {
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            MaxWidth = 620,
        };

        panel.Children.Add(new TextBlock
        {
            Text = Strings.BlockHeadline,
            FontSize = Theme.FontDisplay,
            FontWeight = FontWeights.SemiBold,
            Foreground = Theme.TextPrimary,
            TextAlignment = TextAlignment.Center,
            Margin = new Thickness(0, 0, 0, 12),
        });

        _reason = new TextBlock
        {
            FontSize = Theme.FontHeading,
            Foreground = Theme.TextSecondary,
            TextAlignment = TextAlignment.Center,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 28),
        };
        panel.Children.Add(_reason);

        if (showInput)
        {
            _grantPanel = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center };
            _grantPanel.Children.Add(new TextBlock
            {
                Text = Strings.BlockGotCode,
                FontSize = 14,
                Foreground = Theme.TextMuted,
                TextAlignment = TextAlignment.Center,
                Margin = new Thickness(0, 0, 0, 8),
            });

            _input = new TextBox
            {
                FontSize = 24,
                Width = 260,
                MaxLength = 9,
                HorizontalContentAlignment = HorizontalAlignment.Center,
                HorizontalAlignment = HorizontalAlignment.Center,
                Padding = new Thickness(6),
            };
            _input.KeyDown += (_, e) => { if (e.Key == Key.Enter) TryRedeem(); };
            _grantPanel.Children.Add(_input);

            var button = new Button
            {
                Content = Strings.BlockUnlock,
                Width = 140,
                Margin = new Thickness(0, 12, 0, 0),
                Padding = new Thickness(6),
                HorizontalAlignment = HorizontalAlignment.Center,
            };
            button.Click += (_, _) => TryRedeem();
            _grantPanel.Children.Add(button);

            _feedback = new TextBlock
            {
                FontSize = 14,
                Foreground = Theme.Blocked,
                TextAlignment = TextAlignment.Center,
                Margin = new Thickness(0, 12, 0, 0),
                MinHeight = 20,
            };
            _grantPanel.Children.Add(_feedback);

            var ask = new Button
            {
                Content = Strings.AskForMoreTime,
                Width = 200,
                Margin = new Thickness(0, 18, 0, 0),
                Padding = new Thickness(6),
                HorizontalAlignment = HorizontalAlignment.Center,
                Background = Brushes.Transparent,
                Foreground = Theme.TextSecondary,
                BorderBrush = Theme.PanelBorder,
                BorderThickness = new Thickness(1),
                Cursor = Cursors.Hand,
            };
            ask.Click += (_, _) => _askForTime();
            _grantPanel.Children.Add(ask);

            panel.Children.Add(_grantPanel);
        }

        // Only on the primary screen: the duplicate covers exist to leave no uncovered strip, and
        // repeating the controls on each would just be four Shut down buttons.
        if (showInput) panel.Children.Add(BuildWayOut());

        // Everything sits inside one card. The headline used to float directly on the ground, which
        // was fine on a colour we chose and is not fine on a photograph someone else chose: it is
        // the largest text on the screen and the least protected. With no image the card is the same
        // colour as the ground and vanishes, so this changes nothing until a picture arrives.
        var card = new Border
        {
            Background = Theme.PanelOverImage,
            CornerRadius = Theme.Radius,
            Padding = new Thickness(56, 44, 56, 44),
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            Child = panel,
        };

        var root = new Grid();
        root.Children.Add(_background);
        root.Children.Add(_scrim);
        // Only the primary cover carries the card; the others exist to leave no uncovered strip, and
        // an empty card on a second monitor would read as a bug.
        if (showInput) root.Children.Add(card);

        Content = root;

        // Positioning happens in device pixels via SetWindowPos rather than WPF units, so a
        // mixed-DPI multi-monitor setup cannot leave a strip of a screen uncovered.
        SourceInitialized += (_, _) => CoverScreen();
        Closing += (_, e) => e.Cancel = !_allowClose;

        _reassert = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        _reassert.Tick += (_, _) => GuardForeground();
        if (IsPrimary) _reassert.Start();
    }

    /// <summary>The row of last resorts, kept visually quiet and well below the Grant input: these
    /// are for the adult standing at the machine, not the first thing the kid should reach for.</summary>
    private UIElement BuildWayOut()
    {
        var row = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Center,
            Margin = new Thickness(0, 44, 0, 0),
        };

        row.Children.Add(Quiet(Strings.BlockShutDown, () => _shutDown()));
        row.Children.Add(Quiet(Strings.BlockExitApp, () => _exitApp()));
        return row;
    }

    private static Button Quiet(string caption, Action click)
    {
        var button = new Button
        {
            Content = caption,
            Margin = new Thickness(6, 0, 6, 0),
            Padding = new Thickness(12, 5, 12, 5),
            FontSize = 12,
            Background = Brushes.Transparent,
            Foreground = Theme.TextMuted,
            BorderBrush = Theme.PanelBorder,
            BorderThickness = new Thickness(1),
            Cursor = Cursors.Hand,
        };
        button.Click += (_, _) => click();
        return button;
    }

    /// <summary>Sets (or clears) the Block Screen Background. Null means the plain ground, which is
    /// also what a missing, unreadable or not-yet-downloaded image resolves to: a kid looking at a
    /// cover is not the audience for an Admin's misconfiguration, so this never reports a problem.
    /// Every cover gets the image, cropped to its own screen — a photo on one monitor and bare navy
    /// on the next looks broken.</summary>
    public void SetBackground(ImageSource? image)
    {
        _background.Source = image;
        var show = image is null ? Visibility.Collapsed : Visibility.Visible;
        _background.Visibility = show;
        _scrim.Visibility = show;
    }

    public void SetReason(string text) => _reason.Text = text;

    /// <summary>Sets the reason and whether the Grant input applies. During an admin Lock a code can't
    /// unlock (Lock beats Grants), so the input is hidden to avoid the "I typed a code and nothing
    /// happened" confusion — the screen just says a parent will turn it back on. "Ask for more time"
    /// goes with it: extra minutes do not lift a Lock either, and offering the ask would promise a
    /// way out that approving it would not deliver.</summary>
    public void SetContext(string reason, bool grantAllowed)
    {
        _reason.Text = reason;
        if (_grantPanel is not null)
            _grantPanel.Visibility = grantAllowed ? Visibility.Visible : Visibility.Collapsed;
    }

    public void FocusInput() => _input?.Focus();

    /// <summary>Close for real. Everything else is refused so Alt+F4 cannot dismiss the cover.</summary>
    public void AllowCloseAndClose()
    {
        _allowClose = true;
        _reassert.Stop();
        Close();
    }

    private void CoverScreen()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        var b = _screen.Bounds;
        Win32.SetWindowPos(hwnd, Win32.HWND_TOPMOST, b.Left, b.Top, b.Width, b.Height, 0);
    }

    public void ReassertTopmost()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;

        Win32.SetWindowPos(hwnd, Win32.HWND_TOPMOST, 0, 0, 0, 0,
            Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
    }

    private void GuardForeground()
    {
        var foreground = Win32.GetForegroundWindow();
        // Zero normally means the user desktop is not active (for example, the session is locked).
        // Accessibility input is deliberately allowed above the cover so a code can still be typed.
        if (foreground == IntPtr.Zero || Win32.IsAccessibilitySurface(foreground)) return;

        if (Win32.IsCurrentProcessWindow(foreground))
        {
            // Keep every cover in the topmost band, then put the current Digital Aid window back
            // above them. Owned dialogs already have this ordering; this also protects future windows.
            _reassertAll();
            Win32.SetWindowPos(foreground, Win32.HWND_TOPMOST, 0, 0, 0, 0,
                Win32.SWP_NOMOVE | Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
            return;
        }

        // Start/Alt+Tab/taskbar surfaces are covered again but not minimized. An ordinary foreign
        // application is minimized first — the best-effort pause for a game that stole foreground.
        if (!Win32.IsShellSurface(foreground)) Win32.ShowWindow(foreground, Win32.SW_MINIMIZE);
        _reassertAll();

        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;
        var target = YieldFocus ? Win32.GetLastActivePopup(hwnd) : hwnd;
        Win32.SetForegroundWindow(target == IntPtr.Zero ? hwnd : target);

        if (!YieldFocus && _input is not null && !_input.IsKeyboardFocusWithin) _input.Focus();
    }

    private async void TryRedeem()
    {
        if (_input is null || _feedback is null) return;

        if (_redeemCoupon is not null && CouponCode.LooksLikeCoupon(_input.Text))
        {
            // A coupon is the server's to judge (ADR-0017): disable the button, say "checking", and
            // show whichever honest sentence comes back. Null means it was granted.
            _input.IsEnabled = false;
            _feedback.Text = Strings.CouponChecking;
            var refusal = await _redeemCoupon(_input.Text);
            _input.IsEnabled = true;
            _feedback.Text = refusal ?? "";
            if (refusal is null) _input.Clear();
            return;
        }

        var result = _redeem(_input.Text);
        // Deliberately uninformative about *why* a code was malformed — see the note on this class.
        _feedback.Text = result switch
        {
            RedeemResult.Granted => "",
            RedeemResult.CodeAlreadyUsed => Strings.CodeAlreadyUsed,
            _ => Strings.CodeBad,
        };
        if (result == RedeemResult.Granted) _input.Clear();
    }
}

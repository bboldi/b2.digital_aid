using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using DigitalAid.Client.App.Interop;

namespace DigitalAid.Client.App.Ui;

/// <summary>What a toast is telling the kid, which decides its icon and accent.</summary>
public enum ToastKind
{
    /// <summary>Plain news with no verdict attached — warnings, errors, anything neutral.</summary>
    Info,

    /// <summary>A Request was approved. Says the minutes, because the number is the actual news.</summary>
    Approved,

    /// <summary>A Request was declined. Amber and "not right now", never red and never a cross: the
    /// kid asked politely and got an answer, and a cross is the symbol for having done something
    /// wrong. Red also already means <em>blocked</em> on this client.</summary>
    Declined,

    /// <summary>A message typed by a parent.</summary>
    Message,

    /// <summary>Time is about to run out.</summary>
    Warning,
}

/// <summary>
/// A topmost, **non-activating** notification at top-center of the primary screen (PRD §6.2): warnings
/// and parent messages appear above a fullscreen game without stealing its keyboard focus. Big, centered
/// text; always a close button. Warnings auto-dismiss; parent messages persist until closed.
///
/// Every kind shares one navy card and differs only by an icon and a faint tint. A saturated green or
/// red panel behind 26pt white text is both loud and harder to read, and the icon is what actually
/// carries the meaning — which is also what keeps these legible for someone who cannot separate the
/// colours at all.
/// </summary>
public sealed class ToastWindow : Window
{
    public ToastWindow(string title, string body, TimeSpan? autoDismiss = null, ToastKind kind = ToastKind.Info)
    {
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        ShowActivated = false;              // never take focus
        Topmost = true;
        SizeToContent = SizeToContent.WidthAndHeight;

        var accent = AccentOf(kind);
        Background = Theme.Panel;
        BorderBrush = accent;
        // Heavier on top: a coloured edge reads as a category marker, a coloured box reads as alarm.
        BorderThickness = new Thickness(1, 3, 1, 1);

        var grid = new Grid { Width = 440, Margin = new Thickness(28, 22, 28, 22) };

        var stack = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center };

        if (IconOf(kind) is { } iconData)
        {
            stack.Children.Add(new System.Windows.Shapes.Path
            {
                Data = Theme.Icons.Geometry(iconData),
                Stroke = accent,
                StrokeThickness = 1.8,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
                StrokeLineJoin = PenLineJoin.Round,
                Stretch = Stretch.Uniform,
                Width = 34,
                Height = 34,
                HorizontalAlignment = HorizontalAlignment.Center,
                Margin = new Thickness(0, 0, 0, 12),
            });
        }

        stack.Children.Add(new TextBlock
        {
            Text = title,
            FontSize = Theme.FontTitle,
            FontWeight = FontWeights.Bold,
            Foreground = Theme.TextPrimary,
            TextAlignment = TextAlignment.Center,
            TextWrapping = TextWrapping.Wrap,
        });
        if (!string.IsNullOrWhiteSpace(body))
        {
            stack.Children.Add(new TextBlock
            {
                Text = body,
                FontSize = 18,
                Foreground = Theme.TextSecondary,
                TextAlignment = TextAlignment.Center,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 10, 0, 0),
            });
        }
        var ok = new Button
        {
            Content = "OK",
            MinWidth = 110,
            FontSize = Theme.FontBody,
            Padding = new Thickness(10, 6, 10, 6),
            Margin = new Thickness(0, 18, 0, 0),
            HorizontalAlignment = HorizontalAlignment.Center,
        };
        ok.Click += (_, _) => Close();
        stack.Children.Add(ok);

        // The tint goes in first so it sits behind the content; it is a mood, not a surface.
        grid.Children.Add(new Border
        {
            Background = Theme.Tint(accent),
            Margin = new Thickness(-28, -22, -28, -22),
        });
        grid.Children.Add(stack);

        // A small ✕ in the corner as well, so it's obviously dismissable at a glance.
        var close = new Button
        {
            Content = "✕",
            Width = 26, Height = 26,
            FontSize = Theme.FontSmall,
            Background = Brushes.Transparent,
            Foreground = Theme.TextMuted,
            BorderThickness = new Thickness(0),
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Cursor = System.Windows.Input.Cursors.Hand,
        };
        close.Click += (_, _) => Close();
        grid.Children.Add(close);

        Content = grid;

        SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            var ex = Win32.GetWindowLong(hwnd, Win32.GWL_EXSTYLE);
            // NOACTIVATE keeps the game foreground; TOOLWINDOW keeps this out of Alt+Tab.
            Win32.SetWindowLong(hwnd, Win32.GWL_EXSTYLE, ex | Win32.WS_EX_NOACTIVATE | Win32.WS_EX_TOOLWINDOW);
        };
        // Position after layout, when ActualWidth is known, in device pixels (DPI-correct) so it can't
        // run off the edge — the bug from the first field test.
        ContentRendered += (_, _) => PositionTopCenter();

        if (autoDismiss is { } delay)
        {
            var timer = new DispatcherTimer { Interval = delay };
            timer.Tick += (_, _) => { timer.Stop(); Close(); };
            timer.Start();
        }
    }

    private static SolidColorBrush AccentOf(ToastKind kind) => kind switch
    {
        ToastKind.Approved => Theme.Active,
        ToastKind.Declined => Theme.Warn,
        ToastKind.Message => Theme.Grant,
        ToastKind.Warning => Theme.Warn,
        _ => Theme.PanelBorder,
    };

    private static string? IconOf(ToastKind kind) => kind switch
    {
        ToastKind.Approved => Theme.Icons.Check,
        ToastKind.Declined => Theme.Icons.NotNow,
        ToastKind.Message => Theme.Icons.Message,
        ToastKind.Warning => Theme.Icons.Clock,
        _ => null,
    };

    private void PositionTopCenter()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;

        var area = System.Windows.Forms.Screen.PrimaryScreen?.WorkingArea
                   ?? new System.Drawing.Rectangle(0, 0, 1280, 1024);

        // WPF sizes are DIPs; SetWindowPos wants device pixels. Convert via the window's DPI.
        var dpi = VisualTreeHelper.GetDpi(this);
        var widthPx = (int)Math.Ceiling(ActualWidth * dpi.DpiScaleX);

        var x = area.Left + (area.Width - widthPx) / 2;
        var y = area.Top + (int)(28 * dpi.DpiScaleY);
        Win32.SetWindowPos(hwnd, Win32.HWND_TOPMOST, x, y, 0, 0,
            Win32.SWP_NOSIZE | Win32.SWP_NOACTIVATE);
    }
}

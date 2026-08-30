using System.Drawing;
using System.Drawing.Drawing2D;

namespace DigitalAid.Client.App.Ui;

/// <summary>How the machine is doing, as the tray shows it. Ordered loosest to tightest so a glance
/// at the colour is a glance at how much rope is left.</summary>
public enum TrayState
{
    /// <summary>Never paired, or the state file is gone (ADR-0007): enforcing nothing.</summary>
    NotSetUp,
    /// <summary>Paused by the Admin — running, connected, enforcing nothing.</summary>
    Disabled,
    /// <summary>The kid locked the screen and stepped away. The clock is stopped.</summary>
    ScreenLocked,
    Fine,
    /// <summary>Inside the 15-minute warning, however that arises — allowance or Downtime.</summary>
    RunningLow,
    OnExtraTime,
    Blocked,
}

/// <summary>How the socket is doing. Secondary: it is drawn as a corner dot, not as the colour.</summary>
public enum TrayLink { Connected, Offline, Rejected }

/// <summary>
/// The tray icon, drawn rather than shipped.
///
/// Two independent things have to fit in sixteen pixels — how much time is left, and whether the
/// server is reachable — so they are split by channel rather than crammed into one glyph: **colour
/// is the time, a corner dot is the link.** That also matches who reads which. The tray lives on the
/// kid's PC, so the colour is for them and it changes all day; the dot is for a parent standing at
/// the desk, and it says no more than "something is off, go and look" — the tooltip carries the
/// detail, and at five pixels nothing more would survive anyway.
///
/// Drawn at <see cref="System.Windows.Forms.SystemInformation.SmallIconSize"/> rather than shipped as
/// a 16px .ico, so 125% and 150% displays get a crisp icon instead of an upscaled one. Cached per
/// (state, link) and disposed with the app: an icon created per tick would leak an HICON a second,
/// which is the kind of leak nobody notices until the shell runs out of handles.
/// </summary>
public sealed class TrayIcons : IDisposable
{
    // The client's own palette (Ui/Theme.cs), except that these are drawn against the Windows
    // taskbar rather than against navy, so the light-background variants from style.css read better.
    private static readonly Color Green = Color.FromArgb(0x2E, 0x8B, 0x57);
    private static readonly Color Amber = Color.FromArgb(0xC8, 0x7A, 0x00);
    private static readonly Color Red = Color.FromArgb(0xC0, 0x39, 0x2B);
    private static readonly Color Blue = Color.FromArgb(0x2B, 0x5C, 0xD9);
    private static readonly Color Grey = Color.FromArgb(0x9A, 0xA4, 0xB6);

    private readonly Dictionary<(TrayState, TrayLink), Icon> _cache = new();

    public Icon Get(TrayState state, TrayLink link)
    {
        if (_cache.TryGetValue((state, link), out var cached)) return cached;
        var icon = Draw(state, link);
        _cache[(state, link)] = icon;
        return icon;
    }

    private static Color ColorOf(TrayState state) => state switch
    {
        TrayState.Blocked => Red,
        TrayState.RunningLow => Amber,
        TrayState.OnExtraTime => Blue,
        TrayState.Fine => Green,
        _ => Grey,                      // not set up, disabled, screen locked: nothing is counting
    };

    private static Icon Draw(TrayState state, TrayLink link)
    {
        var size = System.Windows.Forms.SystemInformation.SmallIconSize;
        var side = Math.Max(16, Math.Min(size.Width, size.Height));

        using var bitmap = new Bitmap(side, side);
        using (var g = Graphics.FromImage(bitmap))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);

            // A filled roundel with a dark rim. The rim is what keeps it visible on a light taskbar,
            // where a pale fill would otherwise disappear.
            var inset = side * 0.12f;
            var face = new RectangleF(inset, inset, side - inset * 2, side - inset * 2);
            using (var fill = new SolidBrush(ColorOf(state)))
                g.FillEllipse(fill, face);
            using (var rim = new Pen(Color.FromArgb(0x50, 0, 0, 0), Math.Max(1f, side / 16f)))
                g.DrawEllipse(rim, face);

            // A ScreenLocked machine is grey like Disabled and NotSetUp, but it is the only one of
            // the three the kid caused — a bar through it says "you left this", not "this is broken".
            if (state == TrayState.ScreenLocked)
            {
                using var bar = new Pen(Color.FromArgb(0xF0, 0xFF, 0xFF, 0xFF), Math.Max(1.5f, side / 8f));
                g.DrawLine(bar, side * 0.32f, side * 0.5f, side * 0.68f, side * 0.5f);
            }

            if (link != TrayLink.Connected)
            {
                // Bottom-right, over the roundel's edge so it reads as a badge on it rather than as
                // a second object beside it.
                var d = side * 0.42f;
                var badge = new RectangleF(side - d, side - d, d, d);
                using var fill = new SolidBrush(link == TrayLink.Rejected ? Red : Color.White);
                using var edge = new Pen(link == TrayLink.Rejected ? Color.White : Grey, Math.Max(1f, side / 16f));
                g.FillEllipse(fill, badge);
                g.DrawEllipse(edge, badge);
            }
        }

        // Clone through the HICON: Icon.FromHandle does not own its handle, and the bitmap is about
        // to go away underneath it.
        var handle = bitmap.GetHicon();
        try
        {
            using var borrowed = Icon.FromHandle(handle);
            return (Icon)borrowed.Clone();
        }
        finally
        {
            Interop.Win32.DestroyIcon(handle);
        }
    }

    public void Dispose()
    {
        foreach (var icon in _cache.Values) icon.Dispose();
        _cache.Clear();
    }
}

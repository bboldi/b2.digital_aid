using System.Windows;
using System.Windows.Media;

namespace DigitalAid.Client.App.Ui;

/// <summary>
/// The client's colours and sizes in one place, mirroring the tokens in <c>server/public/style.css</c>
/// so the two halves of the product look like one product. Accents use that stylesheet's *dark-mode*
/// values, because every surface here is dark — the light values are tuned for a white page and go
/// muddy on navy.
///
/// This is a token file, not a widget library: it holds what the windows share and nothing else.
/// Windows that have never needed a colour beyond the system default (About, the code prompt) are
/// deliberately left alone.
/// </summary>
public static class Theme
{
    // --- Surfaces -----------------------------------------------------------------------------

    /// <summary>The Block Screen's own ground — what shows when there is no background image.</summary>
    public static readonly SolidColorBrush Surface = Frozen(0x12, 0x16, 0x24);

    /// <summary>Cards, toasts, and the Block Screen's control panel.</summary>
    public static readonly SolidColorBrush Panel = Frozen(0x1C, 0x23, 0x33);

    public static readonly SolidColorBrush PanelBorder = Frozen(0x3A, 0x46, 0x60);

    /// <summary>The Block Screen's control panel. The same colour as <see cref="Surface"/>, so with
    /// no background image it disappears into the ground and the screen looks exactly as it always
    /// did; over an image it becomes a near-solid card, which is what keeps the text legible no
    /// matter which picture is behind it.</summary>
    public static readonly SolidColorBrush PanelOverImage = Frozen(0x12, 0x16, 0x24, 0xEB);

    /// <summary>Laid over the background image to settle its contrast. Deliberately light: the panel
    /// does the work of keeping text readable, so this only has to set the mood.</summary>
    public static readonly SolidColorBrush ImageScrim = Frozen(0x12, 0x16, 0x24, 0x40);

    // --- Text ---------------------------------------------------------------------------------

    public static readonly SolidColorBrush TextPrimary = Brushes.White;
    public static readonly SolidColorBrush TextSecondary = Frozen(0xB8, 0xC2, 0xD9);
    public static readonly SolidColorBrush TextMuted = Frozen(0x8A, 0x95, 0xAD);
    public static readonly SolidColorBrush TextDim = Frozen(0x7C, 0x87, 0x9E);

    // --- Accents ------------------------------------------------------------------------------
    // Named for what they mean in this system, not for the colour: see style.css and CONTEXT.md.

    /// <summary>Usable, allowed, approved.</summary>
    public static readonly SolidColorBrush Active = Frozen(0x4C, 0xAE, 0x7A);

    /// <summary>Extra time — the same blue the server's timeline uses for a Grant, so "extra time"
    /// is one colour across both halves.</summary>
    public static readonly SolidColorBrush Grant = Frozen(0x6D, 0x92, 0xEA);

    /// <summary>Blocked. Not used for a declined Request: a parent saying "not now" is an answer,
    /// not an error, and this red already means something else here.</summary>
    public static readonly SolidColorBrush Blocked = Frozen(0xE0, 0x5C, 0x4C);

    /// <summary>"Not right now" and other soft negatives.</summary>
    public static readonly SolidColorBrush Warn = Frozen(0xF0, 0xC0, 0x78);

    // --- Metrics ------------------------------------------------------------------------------

    public const double FontDisplay = 42;
    public const double FontTitle = 26;
    public const double FontHeading = 20;
    public const double FontBody = 15;
    public const double FontSmall = 13;
    public const double FontTiny = 11;

    /// <summary>Matches Pico's <c>--pico-border-radius: 0.75rem</c> on the server.</summary>
    public static readonly CornerRadius Radius = new(12);

    // --- Helpers ------------------------------------------------------------------------------

    /// <summary>An accent at low opacity, for tinting a panel without turning it into a coloured
    /// slab. Saturated backgrounds behind white text look loud and read worse; the icon carries the
    /// meaning and this only nudges the mood.</summary>
    public static SolidColorBrush Tint(SolidColorBrush accent, byte alpha = 0x1F)
    {
        var c = accent.Color;
        var brush = new SolidColorBrush(Color.FromArgb(alpha, c.R, c.G, c.B));
        brush.Freeze();
        return brush;
    }

    private static SolidColorBrush Frozen(byte r, byte g, byte b, byte a = 0xFF)
    {
        var brush = new SolidColorBrush(Color.FromArgb(a, r, g, b));
        brush.Freeze();
        return brush;
    }

    /// <summary>
    /// Stroke outlines on a 24×24 grid, drawn the same way as the server's inline SVGs so the two
    /// sets of icons are recognisably siblings. Stroked rather than filled: a filled glyph at toast
    /// size turns into a blob, and these have to read at a glance from across a room.
    /// </summary>
    public static class Icons
    {
        public const string Check = "M20 6 L9 17 L4 12";

        /// <summary>A circle with a bar through it — "not this", where a cross would say "wrong".</summary>
        public const string NotNow = "M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3 M8 12 H16";

        /// <summary>The same speech bubble the server uses for Requests in its tab bar.</summary>
        public const string Message = "M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z";

        public const string Warning = "M12 3 L22 20 H2 Z M12 10 V14 M12 17 V17.01";

        public const string Clock = "M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3 M12 7 V12 L15.5 14";

        public const string Unplugged = "M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3 M8 8 L16 16";

        public static Geometry Geometry(string data) => System.Windows.Media.Geometry.Parse(data);
    }
}

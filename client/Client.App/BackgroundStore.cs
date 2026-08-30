using System.Windows.Media.Imaging;
using DigitalAid.Client.Core;

namespace DigitalAid.Client.App;

/// <summary>
/// Decodes the Block Screen Backgrounds that <see cref="BackgroundFiles"/> holds on disk.
///
/// The split is deliberate: everything that decides *which* bytes are current — the files, the
/// hashes, the reconcile against the server — lives in Client.Core where it can be tested on the dev
/// box. What is left here is the one thing that cannot be: turning bytes into something WPF can draw.
/// That division is not tidiness. The cold-start bug this class used to have (a picture on disk that
/// the cover would not show, because the in-memory note of what the server last said was still empty)
/// was invisible for exactly as long as this logic sat in the Windows-only half that no test reaches.
/// </summary>
public sealed class BackgroundStore
{
    private readonly BackgroundFiles _files;
    private readonly Action<string> _log;
    private readonly Dictionary<string, BitmapSource> _decoded = new();

    public BackgroundStore(string dir, Action<string> log)
    {
        _log = log;
        _files = new BackgroundFiles(dir, log);
        _files.Changed += () =>
        {
            // Any decode still cached describes bytes that are no longer on disk.
            _decoded.Clear();
            Changed?.Invoke();
        };
    }

    /// <summary>Raised once the set on disk has changed, so a cover already up can swap its picture
    /// rather than waiting for the next block.</summary>
    public event Action? Changed;

    /// <inheritdoc cref="BackgroundFiles.SyncAsync"/>
    public Task SyncAsync(BackgroundSet? wanted, string baseUrl, string token) =>
        _files.SyncAsync(wanted, baseUrl, token);

    /// <summary>The picture for a slot, or null. Decoded at <paramref name="pixelWidth"/> rather than
    /// full size: an 8 MB phone photo is perhaps 4000×3000, which is ~48 MB of bitmap *per monitor*
    /// on a machine that is probably a kid's older PC. Nothing is gained by decoding beyond the width
    /// it will be drawn at.
    ///
    /// Answers from the disk, so a cover that goes up before the socket connects — or on a Client that
    /// has not reached the server in a week — still gets its picture.</summary>
    public BitmapSource? Get(string slot, int pixelWidth)
    {
        if (_files.Resolve(slot) is not { } background) return null;

        // Keyed by hash: when the admin replaces a picture the file keeps its name, and a key built
        // from the name alone would hand back the old decode forever.
        var key = $"{slot}:{background.Hash}:{pixelWidth}";
        if (_decoded.TryGetValue(key, out var cached)) return cached;

        try
        {
            var image = new BitmapImage();
            image.BeginInit();
            image.UriSource = new Uri(background.Path);
            // Read it all up front: the file is replaced in place when the picture changes, and a
            // lazily-loaded bitmap holding the handle would keep the old one locked.
            image.CacheOption = BitmapCacheOption.OnLoad;
            image.DecodePixelWidth = Math.Max(320, pixelWidth);
            image.EndInit();
            image.Freeze();

            _decoded[key] = image;
            return image;
        }
        catch (Exception ex)
        {
            // Corrupt, truncated, or something Windows has no decoder for. Plain cover, quietly.
            _log($"background {slot} could not be decoded: {ex.Message}");
            return null;
        }
    }
}

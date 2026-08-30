namespace DigitalAid.Client.Core;

/// <summary>
/// The running marker behind unclean-exit inference (PRD §6.6).
///
/// A hard-killed process gets no notification, so it cannot log its own end. Instead the marker
/// file exists for as long as the app is running and carries the last tick time; a clean exit
/// clears it. Finding one at startup means the previous run ended without saying goodbye — kill,
/// crash, and power loss are deliberately indistinguishable.
/// </summary>
public sealed class RunMarker
{
    private readonly string _path;

    public RunMarker(string path)
    {
        _path = path;
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
    }

    /// <summary>Call once at startup, before <see cref="Arm"/>. Returns the previous run's last tick
    /// time if it ended uncleanly, otherwise null. Consumes the stale marker.</summary>
    public DateTimeOffset? DetectUncleanExit()
    {
        if (!File.Exists(_path)) return null;
        DateTimeOffset? lastTick = null;
        try
        {
            var text = File.ReadAllText(_path).Trim();
            if (DateTimeOffset.TryParse(text, out var parsed)) lastTick = parsed;
        }
        catch (IOException) { /* unreadable marker still means unclean exit */ }

        // Unparseable or empty: still an unclean exit, we just don't know when. Report the file's
        // own timestamp rather than nothing, so the Event carries a usable approximation.
        lastTick ??= SafeLastWriteTime();
        File.Delete(_path);
        return lastTick;
    }

    /// <summary>Create/refresh the marker with the current tick time. Cheap enough to call every tick.</summary>
    public void Arm(DateTimeOffset localNow) =>
        File.WriteAllText(_path, localNow.ToString("o"));

    /// <summary>Clear the marker — the app is exiting cleanly.</summary>
    public void Clear()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }

    private DateTimeOffset? SafeLastWriteTime()
    {
        try { return new DateTimeOffset(File.GetLastWriteTime(_path)); }
        catch (IOException) { return null; }
    }
}

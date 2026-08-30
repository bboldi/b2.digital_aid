namespace DigitalAid.Client.Core;

/// <summary>
/// Records that someone deliberately exited the app with an Admin Code, so the Windows Scheduled Task
/// that normally restarts it within the minute leaves it alone (CONTEXT.md: Stood Down).
///
/// It has to be a marker rather than disabling the task itself: the task is created by an admin
/// precisely so the kid's standard account cannot touch it, and the app runs unelevated (ADR-0004).
///
/// Two independent releases, whichever comes first:
///   * a reboot — the recorded boot identity no longer matches;
///   * local midnight — no unattended override in this system outlives the day it was made, the same
///     rule <see cref="EnforcementEngine"/> applies to an admin Lock.
/// The second is what stops a parent standing the app down to install something on a Tuesday and
/// leaving the PC unprotected for three weeks because nobody rebooted.
/// </summary>
public sealed class StoodDownMarker
{
    private readonly string _path;

    public StoodDownMarker(string path)
    {
        _path = path;
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
    }

    /// <summary>Stand the app down until the next reboot or local midnight.</summary>
    public void StandDown(string bootId, DateTimeOffset localNow)
    {
        try
        {
            File.WriteAllText(_path, $"{bootId}\n{DateOnly.FromDateTime(localNow.DateTime):yyyy-MM-dd}\n");
        }
        catch (IOException)
        {
            // Worst case the watchdog restarts the app a minute later — the same behaviour as before
            // this existed. Never worth failing the exit the parent asked for.
        }
    }

    /// <summary>Is the app currently stood down? Consumes a marker that has been released, so a
    /// released stand-down leaves no trace to puzzle over later.</summary>
    public bool IsStoodDown(string bootId, DateTimeOffset localNow)
    {
        if (IsHeld(bootId, localNow)) return true;
        Clear();
        return false;
    }

    /// <summary>The same question without the side effect, for diagnostics — <c>--status</c> must be
    /// able to explain why the app is not running without changing whether it will start.</summary>
    public bool IsHeld(string bootId, DateTimeOffset localNow)
    {
        if (!File.Exists(_path)) return false;

        string[] lines;
        try
        {
            lines = File.ReadAllLines(_path);
        }
        catch (IOException)
        {
            // Unreadable: treat as released and run. Enforcement is the safe default — the failure
            // mode of guessing "stood down" is a PC that silently never protects itself again.
            return false;
        }

        return lines.Length > 1
            && lines[0].Trim() == bootId
            && lines[1].Trim() == $"{DateOnly.FromDateTime(localNow.DateTime):yyyy-MM-dd}";
    }

    public void Clear()
    {
        try
        {
            if (File.Exists(_path)) File.Delete(_path);
        }
        catch (IOException) { /* a stale marker releases on the next reboot regardless */ }
    }

    /// <summary>
    /// Identifies the current boot, so a marker cannot survive a restart. Derived from the monotonic
    /// uptime rather than read from Windows, which keeps it testable and platform-free; rounded to
    /// the minute because "now minus uptime" drifts by a second or two between calls.
    /// </summary>
    public static string BootIdFrom(DateTimeOffset localNow, TimeSpan uptime)
    {
        var booted = localNow - uptime;
        return booted.UtcDateTime.ToString("yyyy-MM-ddTHH:mm");
    }
}

namespace DigitalAid.Client.App;

/// <summary>
/// Where the Client keeps its state. Machine-wide and app-writable, because self-update has to
/// replace the exe in place (PRD §6.1) — file-level tamper resistance was traded away deliberately;
/// killing the process was always the easier route and is equally visible in the log.
/// </summary>
public static class Paths
{
    public static string Root { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "DigitalAid");

    public static string StateDir { get; } = Path.Combine(Root, "state");
    public static string StateFile => Path.Combine(StateDir, "state.json");
    public static string EventQueueFile => Path.Combine(StateDir, "events.jsonl");
    public static string RunMarkerFile => Path.Combine(StateDir, "running");
    /// <summary>Present while the app is Stood Down — exited on purpose and not to be restarted by
    /// the Scheduled Task until the next reboot or local midnight (ADR-0004).</summary>
    public static string StoodDownFile => Path.Combine(StateDir, "stood-down");
    public static string LogFile => Path.Combine(Root, "client.log");
    /// <summary>Block Screen Backgrounds, kept on disk rather than fetched when needed: the cover
    /// goes up at exactly the moments the server is unreachable.</summary>
    public static string BackgroundDir { get; } = Path.Combine(Root, "backgrounds");
}

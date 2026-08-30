using System.Threading;
using System.Windows;
using DigitalAid.Client.App.Ui;
using DigitalAid.Client.Core;

namespace DigitalAid.Client.App;

/// <summary>
/// Entry point. Single-instance by mutex, because the Scheduled Task relaunches this every minute if
/// it is not running (PRD §6.1) and a race there must not produce two enforcers.
///
/// The UI is built in code rather than XAML: this shell is a handful of plain windows, and code-only
/// keeps the Windows-targeted build simple to cross-compile from the Linux dev box.
/// </summary>
public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        // Before any window exists, so nothing is ever built in the wrong language and re-captioned.
        // The stored choice wins; only a Client that has never been asked falls back to what Windows
        // is set to, and that answer is written down the first time it is used (ADR-0012).
        ApplyStoredLanguage();

        // A parent-run diagnostic; shows the same window the tray's About entry does.
        if (args.Any(a => a is "--status")) return ShowStatus();

        // The Scheduled Task passes --scheduled. A launch without it is a person starting the app,
        // which is one of the two ways to end a Stood Down state (ADR-0004) — without the
        // distinction, double-clicking the exe to bring protection back would just exit again.
        var launch = args.Any(a => a is "--scheduled") ? LaunchKind.Scheduled : LaunchKind.Manual;

        using var single = new Mutex(initiallyOwned: true, "Global\\DigitalAid.Client.SingleInstance", out var isOnly);
        if (!isOnly)
        {
            AppHost.Log("another instance is already running — exiting");
            return 0;
        }

        var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        using var host = new AppHost(application, launch);
        if (!host.Start()) return 0;   // stood down: exit quietly, leave the marker for the next try

        try
        {
            return application.Run();
        }
        catch (Exception ex)
        {
            AppHost.Log($"fatal: {ex}");
            throw;
        }
    }

    /// <summary>
    /// Point the UI at this PC's language, and — the first time only — write down what the machine
    /// looked like it wanted so the answer stops depending on a Windows setting someone may change.
    ///
    /// Reads the state file directly rather than going through the agent: this runs before AppHost
    /// exists, and it has to work for <c>--status</c> too, which never builds one. A failure here
    /// costs the wrong language, never a start-up, so nothing is allowed to throw out of it.
    /// </summary>
    private static void ApplyStoredLanguage()
    {
        try
        {
            var store = new StateStore(Paths.StateFile);
            var state = store.Load();
            var language = Language.Resolve(state.Language);
            Language.Apply(language);

            if (state.Language != language) store.Save(state with { Language = language });
        }
        catch (Exception ex)
        {
            Language.Apply(Language.English);
            AppHost.Log($"could not read the stored language, using English: {ex.Message}");
        }
    }

    /// <summary>The tray's About window, reachable from the command line too. Kept as an alias
    /// rather than a second implementation: this is the flag you reach for when the app is broken
    /// enough that there is no tray icon to right-click, and it should say the same things.</summary>
    private static int ShowStatus()
    {
        // Its own Application: this path never reaches AppHost, and a WPF window with no
        // Application behind it has no resources to resolve against.
        _ = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        new AboutWindow().ShowDialog();
        return 0;
    }
}

using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace DigitalAid.Client.App.Interop;

/// <summary>The handful of Win32 calls the shell needs. Everything here is best-effort by design:
/// a failed minimize or a process we may not query must never take the app down.</summary>
internal static partial class Win32
{
    internal const int GWL_EXSTYLE = -20;
    internal const int WS_EX_NOACTIVATE = 0x08000000;
    internal const int WS_EX_TOOLWINDOW = 0x00000080;
    internal const int SW_MINIMIZE = 6;

    internal static readonly IntPtr HWND_TOPMOST = new(-1);
    internal const uint SWP_NOMOVE = 0x0002;
    internal const uint SWP_NOSIZE = 0x0001;
    internal const uint SWP_NOACTIVATE = 0x0010;

    [LibraryImport("user32.dll")]
    internal static partial IntPtr GetForegroundWindow();

    [LibraryImport("user32.dll")]
    internal static partial uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int x, int y, int cx, int cy, uint flags);

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool SetForegroundWindow(IntPtr hWnd);

    [LibraryImport("user32.dll")]
    internal static partial IntPtr GetLastActivePopup(IntPtr hWnd);

    [LibraryImport("user32.dll", EntryPoint = "GetWindowLongW")]
    internal static partial int GetWindowLong(IntPtr hWnd, int nIndex);

    [LibraryImport("user32.dll", EntryPoint = "SetWindowLongW")]
    internal static partial int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    // DllImport, not LibraryImport: the source generator cannot marshal StringBuilder.
    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
    internal static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    /// <summary>Product name of the foreground application, or null when nothing useful is in front.
    /// Deliberately the app *name* only — never the window title, which leaks content (PRD §6.3).</summary>
    internal static string? ForegroundAppName()
    {
        try
        {
            var hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return null;
            if (GetWindowThreadProcessId(hwnd, out var pid) == 0 || pid == 0) return null;

            using var process = Process.GetProcessById((int)pid);
            // Ignore the desktop/shell so an idle desktop does not masquerade as usage of "Explorer".
            if (string.Equals(process.ProcessName, "explorer", StringComparison.OrdinalIgnoreCase)
                && IsDesktopWindow(hwnd)) return null;

            var product = SafeProductName(process);
            return string.IsNullOrWhiteSpace(product) ? process.ProcessName : product;
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException or Win32Exception)
        {
            return null;   // process died, or it is elevated and we cannot query it
        }
    }

    private static string? SafeProductName(Process process)
    {
        try
        {
            return process.MainModule?.FileVersionInfo.ProductName;
        }
        catch (Exception ex) when (ex is InvalidOperationException or Win32Exception or NotSupportedException)
        {
            return null;
        }
    }

    private static bool IsDesktopWindow(IntPtr hwnd)
    {
        var sb = new StringBuilder(64);
        if (GetClassName(hwnd, sb, sb.Capacity) == 0) return false;
        var cls = sb.ToString();
        return cls is "Progman" or "WorkerW" or "Shell_TrayWnd";
    }

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool LockWorkStation();

    /// <summary>Releases an HICON from <c>Bitmap.GetHicon</c>. Not optional: those handles are not
    /// owned by anything managed, and the tray redraws its icon whenever the state changes.</summary>
    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static partial bool DestroyIcon(IntPtr handle);

    /// <summary>Lock the Windows session — the kid stepping away without spending their Usage Time.
    /// The clock only advances while the session is unlocked (EnforcementEngine), so this is the
    /// whole mechanism; there is no state of ours involved and nothing to get out of sync.
    ///
    /// It is deliberately the OS lock rather than a cover of our own: coming back needs their
    /// Windows password, which means "stepped away" cannot be faked by a sibling walking past.</summary>
    internal static void LockScreen()
    {
        try { LockWorkStation(); }
        catch (Win32Exception) { /* best effort, like everything else here */ }
    }

    /// <summary>Best-effort "pause" for a fullscreen game: push it out of the foreground before the
    /// Block Screen appears. Windows offers no real pause; minimizing is the honest 90% solution.</summary>
    internal static void MinimizeForeground()
    {
        try
        {
            var hwnd = GetForegroundWindow();
            if (hwnd != IntPtr.Zero && !IsCurrentProcessWindow(hwnd)
                && !IsAccessibilitySurface(hwnd) && !IsShellSurface(hwnd))
                ShowWindow(hwnd, SW_MINIMIZE);
        }
        catch (Win32Exception) { /* best effort */ }
    }

    internal static bool IsCurrentProcessWindow(IntPtr hwnd) =>
        GetWindowThreadProcessId(hwnd, out var pid) != 0 && pid == Environment.ProcessId;

    /// <summary>Windows input/accessibility surfaces that must remain usable over the Block Screen.
    /// This is deliberately a short, practical list, not a security boundary.</summary>
    internal static bool IsAccessibilitySurface(IntPtr hwnd)
    {
        var process = WindowProcessName(hwnd)?.ToLowerInvariant();
        return process is "osk" or "tabtip" or "textinputhost" or "ctfmon"
            or "narrator" or "magnify" or "voiceaccess" or "voiceaccesshost";
    }

    /// <summary>Shell UI should be covered again, but never minimized: minimizing an Explorer-owned
    /// surface can disturb the desktop itself. Explorer folder windows use different classes and are
    /// therefore treated like any other application.</summary>
    internal static bool IsShellSurface(IntPtr hwnd)
    {
        var cls = WindowClassName(hwnd);
        if (cls is "Progman" or "WorkerW" or "Shell_TrayWnd" or "Shell_SecondaryTrayWnd"
            or "MultitaskingViewFrame") return true;

        var process = WindowProcessName(hwnd)?.ToLowerInvariant();
        return process is "shellexperiencehost" or "startmenuexperiencehost"
            or "searchhost" or "searchapp" or "shellhost";
    }

    private static string? WindowProcessName(IntPtr hwnd)
    {
        try
        {
            if (GetWindowThreadProcessId(hwnd, out var pid) == 0 || pid == 0) return null;
            using var process = Process.GetProcessById((int)pid);
            return process.ProcessName;
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException or Win32Exception)
        {
            return null;
        }
    }

    private static string? WindowClassName(IntPtr hwnd)
    {
        var sb = new StringBuilder(64);
        return GetClassName(hwnd, sb, sb.Capacity) == 0 ? null : sb.ToString();
    }
}

using System.Text.Json;

namespace DigitalAid.Client.Core;

/// <summary>
/// Reads and writes <see cref="ClientState"/> as one JSON file, atomically.
///
/// Writes go to a temp file and are then moved over the target, so a power cut leaves either the
/// old state or the new one — never a truncated file. A state file that *is* unreadable (disk
/// corruption) is moved aside rather than deleted: it un-pairs the Client, which is recoverable,
/// and the evidence stays on disk.
/// </summary>
public sealed class StateStore
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };
    private readonly object _gate = new();

    public string Path { get; }

    public StateStore(string path)
    {
        Path = path;
        var dir = System.IO.Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
    }

    public ClientState Load()
    {
        lock (_gate)
        {
            if (!File.Exists(Path)) return new ClientState();
            try
            {
                return JsonSerializer.Deserialize<ClientState>(File.ReadAllText(Path), Json) ?? new ClientState();
            }
            catch (Exception ex) when (ex is JsonException or FormatException)
            {
                var quarantine = Path + ".corrupt";
                try { File.Move(Path, quarantine, overwrite: true); } catch (IOException) { /* best effort */ }
                return new ClientState();
            }
        }
    }

    public void Save(ClientState state)
    {
        lock (_gate)
        {
            var temp = Path + ".tmp";
            // Flush to the platter before the rename, not just to the OS cache. NTFS journals the
            // rename, so the directory entry survives a power cut — but the temp file's *contents*
            // do not, and the result is a state file that comes back empty or torn. That un-pairs
            // the Client, which is how a force-off used to cost a pairing (ADR-0007).
            using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                JsonSerializer.Serialize(stream, state, Json);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temp, Path, overwrite: true);
        }
    }
}

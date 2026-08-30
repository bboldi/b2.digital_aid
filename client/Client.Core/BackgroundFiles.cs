namespace DigitalAid.Client.Core;

/// <summary>A Block Screen Background present on disk: where the bytes are, and what they hash to.</summary>
public sealed record BackgroundFile(string Path, string Hash);

/// <summary>
/// The Block Screen Backgrounds this PC holds on disk (CONTEXT.md: Block Screen Background) — the
/// files, the hashes, and the reconcile against what the server says it has. Decoding them into a
/// picture is the shell's job; this half is deliberately free of Windows so it can be tested.
///
/// The server names them in <c>hello</c> and whenever one changes — a hash and a path — and the bytes
/// come over HTTP, exactly as an update does. They are then *kept*, because the Block Screen appears
/// at precisely the moments the server is unreachable: an image fetched on demand is an image the
/// cover would not have when it needs one.
///
/// **The disk is the record.** Nothing here consults an in-memory note of what the server last said,
/// because the Block Screen goes up before the socket connects — on a cold start with the day already
/// spent, and on a Client that has been offline for a week. Both of those are the normal case, not the
/// edge one. A slot the server clears is deleted from disk by <see cref="SyncAsync"/>, so "the file is
/// there" and "the server still has one" cannot drift apart for long.
///
/// Every failure resolves to "no picture": not configured, not downloaded yet, half-written, or gone.
/// A kid looking at a cover is not the audience for an Admin's misconfiguration.
/// </summary>
public sealed class BackgroundFiles
{
    /// <summary>Fetches one background. Returns null on any failure — offline is the expected case,
    /// not an exceptional one. Injectable so the reconcile logic can be tested without a server.</summary>
    public delegate Task<byte[]?> Fetch(string url, string token, CancellationToken cancellation);

    public static readonly string[] Slots = ["blocked", "downtime"];

    private readonly string _dir;
    private readonly Action<string> _log;
    private readonly Fetch _fetch;

    public BackgroundFiles(string dir, Action<string> log, Fetch? fetch = null)
    {
        _dir = dir;
        _log = log;
        _fetch = fetch ?? HttpFetch;
        Directory.CreateDirectory(_dir);
    }

    /// <summary>Raised once the set on disk has changed, so a cover already up can swap its picture
    /// rather than waiting for the next block.</summary>
    public event Action? Changed;

    /// <summary>What is on disk for a slot, or null. Asks the filesystem every time: this is called
    /// when a cover goes up, which is rare, and being right offline matters more than being quick.</summary>
    public BackgroundFile? Resolve(string slot)
    {
        var hash = HashOnDisk(slot);
        return hash is null ? null : new BackgroundFile(FileFor(slot), hash);
    }

    /// <summary>Reconcile with what the server says it has. Downloads only what differs, and leaves
    /// what it already holds alone if the download fails — a stale picture beats a blank one.</summary>
    public async Task SyncAsync(BackgroundSet? wanted, string baseUrl, string token,
                                CancellationToken cancellation = default)
    {
        var changed = false;

        foreach (var slot in Slots)
        {
            var reference = slot == "blocked" ? wanted?.Blocked : wanted?.Downtime;
            if (reference is null)
            {
                // Cleared on the server. Drop the file too, or the next block shows a picture the
                // admin thinks they removed — and leaving it would also break the rule that makes
                // the disk trustworthy on its own.
                changed |= Forget(slot);
                continue;
            }

            if (HashOnDisk(slot) == reference.Hash) continue;
            if (await DownloadAsync(slot, reference, baseUrl, token, cancellation)) changed = true;
        }

        if (changed) Changed?.Invoke();
    }

    private string FileFor(string slot) => Path.Combine(_dir, $"{slot}.img");
    private string HashFileFor(string slot) => Path.Combine(_dir, $"{slot}.hash");

    /// <summary>Both files, or nothing. The hash file is what makes an image count as present, so a
    /// download interrupted between the two reads as absent and is fetched again.</summary>
    private string? HashOnDisk(string slot)
    {
        try
        {
            if (!File.Exists(HashFileFor(slot)) || !File.Exists(FileFor(slot))) return null;
            var hash = File.ReadAllText(HashFileFor(slot)).Trim();
            return hash.Length == 0 ? null : hash;
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    private bool Forget(string slot)
    {
        if (HashOnDisk(slot) is null) return false;
        try
        {
            // The hash first: it is what makes the pair count as present, so deleting it first means
            // a failure halfway leaves the slot absent rather than leaving a picture that outlives
            // the admin clearing it.
            File.Delete(HashFileFor(slot));
            File.Delete(FileFor(slot));
        }
        catch (IOException) { /* it will be overwritten or retried next time */ }
        catch (UnauthorizedAccessException) { }
        return true;
    }

    private async Task<bool> DownloadAsync(string slot, BackgroundRef reference, string baseUrl,
                                           string token, CancellationToken cancellation)
    {
        var bytes = await _fetch(baseUrl.TrimEnd('/') + reference.Path, token, cancellation);
        if (bytes is null)
        {
            _log($"background {slot} download failed");
            return false;
        }

        try
        {
            // Write the image first and the hash second, for the same reason Forget deletes them the
            // other way round: a crash between the two must leave the pair looking absent.
            var temp = FileFor(slot) + ".part";
            await File.WriteAllBytesAsync(temp, bytes, cancellation);
            File.Move(temp, FileFor(slot), overwrite: true);
            await File.WriteAllTextAsync(HashFileFor(slot), reference.Hash, cancellation);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _log($"background {slot} could not be written: {ex.Message}");
            return false;
        }

        _log($"background {slot} updated ({bytes.Length / 1024} KB)");
        return true;
    }

    private static async Task<byte[]?> HttpFetch(string url, string token, CancellationToken cancellation)
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(2) };
            http.DefaultRequestHeaders.Add("x-client-token", token);
            using var response = await http.GetAsync(url, cancellation);
            return response.IsSuccessStatusCode
                ? await response.Content.ReadAsByteArrayAsync(cancellation)
                : null;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or TaskCanceledException)
        {
            // Offline, or the server is mid-restart. Whatever is already on disk stays.
            return null;
        }
    }
}

using DigitalAid.Client.Core;

namespace Client.Core.Tests;

public sealed class BackgroundFilesTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("digitalaid-backgrounds").FullName;
    private readonly List<string> _log = [];

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private BackgroundFiles Store(BackgroundFiles.Fetch? fetch = null) =>
        new(_dir, _log.Add, fetch ?? Serving([]));

    /// <summary>A server that hands back the bytes it was told to, and 404s for anything else.</summary>
    private static BackgroundFiles.Fetch Serving(Dictionary<string, byte[]> byPath) =>
        (url, _, _) =>
        {
            var path = new Uri(url).AbsolutePath;
            return Task.FromResult(byPath.TryGetValue(path, out var bytes) ? bytes : null);
        };

    private static BackgroundSet Set(BackgroundRef? blocked = null, BackgroundRef? downtime = null) =>
        new(blocked, downtime);

    private const string Base = "http://server:3000";

    [Fact]
    public void Nothing_on_disk_resolves_to_no_picture()
    {
        Assert.Null(Store().Resolve("blocked"));
        Assert.Null(Store().Resolve("downtime"));
    }

    [Fact]
    public async Task Downloads_what_the_server_names()
    {
        var files = Store(Serving(new() { ["/bg/a.jpg"] = [1, 2, 3] }));

        await files.SyncAsync(Set(blocked: new BackgroundRef("abc123", "/bg/a.jpg")), Base, "token");

        var resolved = files.Resolve("blocked");
        Assert.NotNull(resolved);
        Assert.Equal("abc123", resolved.Hash);
        Assert.Equal(new byte[] { 1, 2, 3 }, File.ReadAllBytes(resolved.Path));
        Assert.Null(files.Resolve("downtime"));
    }

    /// <summary>The bug this class was split out to prevent. The Block Screen goes up before the
    /// socket connects — on a cold start with the day already spent, the scheduler restarts the app
    /// straight into a block, and no `hello` has arrived. The picture is already on disk and must be
    /// found there, with nothing held in memory from a previous run.</summary>
    [Fact]
    public async Task Resolves_from_disk_on_a_cold_start_with_no_server_contact()
    {
        var downloaded = Store(Serving(new() { ["/bg/a.jpg"] = [1, 2, 3] }));
        await downloaded.SyncAsync(Set(blocked: new BackgroundRef("abc123", "/bg/a.jpg")), Base, "token");

        // A brand-new instance over the same directory: a fresh process that has spoken to nobody.
        var restarted = Store();

        var resolved = restarted.Resolve("blocked");
        Assert.NotNull(resolved);
        Assert.Equal("abc123", resolved.Hash);
    }

    [Fact]
    public async Task An_offline_client_keeps_the_picture_it_already_has()
    {
        var files = Store(Serving(new() { ["/bg/a.jpg"] = [1, 2, 3] }));
        await files.SyncAsync(Set(blocked: new BackgroundRef("abc123", "/bg/a.jpg")), Base, "token");

        // Same store, but every fetch now fails, as it does with no network.
        var offline = Store((_, _, _) => Task.FromResult<byte[]?>(null));
        await offline.SyncAsync(Set(blocked: new BackgroundRef("newhash", "/bg/b.jpg")), Base, "token");

        // The stale picture stays: better than a blank cover, which is what a failed download used
        // to be allowed to produce.
        var resolved = offline.Resolve("blocked");
        Assert.NotNull(resolved);
        Assert.Equal("abc123", resolved.Hash);
    }

    [Fact]
    public async Task Clearing_a_slot_on_the_server_deletes_it_from_disk()
    {
        var files = Store(Serving(new() { ["/bg/a.jpg"] = [1, 2, 3] }));
        await files.SyncAsync(Set(blocked: new BackgroundRef("abc123", "/bg/a.jpg")), Base, "token");
        Assert.NotNull(files.Resolve("blocked"));

        await files.SyncAsync(Set(), Base, "token");

        // Not merely forgotten — gone, or the next block shows a picture the admin removed. This is
        // what lets Resolve() trust the disk without asking the server.
        Assert.Null(files.Resolve("blocked"));
        Assert.Empty(Directory.GetFiles(_dir));
    }

    [Fact]
    public async Task Unchanged_hash_is_not_downloaded_again()
    {
        var fetches = 0;
        BackgroundFiles.Fetch counting = (_, _, _) => { fetches++; return Task.FromResult<byte[]?>([1, 2, 3]); };
        var files = Store(counting);
        var wanted = Set(blocked: new BackgroundRef("abc123", "/bg/a.jpg"));

        await files.SyncAsync(wanted, Base, "token");
        await files.SyncAsync(wanted, Base, "token");
        await files.SyncAsync(wanted, Base, "token");

        Assert.Equal(1, fetches);
    }

    [Fact]
    public async Task A_replaced_picture_is_picked_up()
    {
        var files = Store(Serving(new() { ["/bg/a.jpg"] = [1], ["/bg/b.jpg"] = [2, 2] }));
        await files.SyncAsync(Set(blocked: new BackgroundRef("first", "/bg/a.jpg")), Base, "token");
        await files.SyncAsync(Set(blocked: new BackgroundRef("second", "/bg/b.jpg")), Base, "token");

        var resolved = files.Resolve("blocked");
        Assert.NotNull(resolved);
        Assert.Equal("second", resolved.Hash);
        Assert.Equal(new byte[] { 2, 2 }, File.ReadAllBytes(resolved.Path));
    }

    [Fact]
    public async Task Changed_fires_only_when_the_disk_actually_changed()
    {
        var files = Store(Serving(new() { ["/bg/a.jpg"] = [1, 2, 3] }));
        var fired = 0;
        files.Changed += () => fired++;
        var wanted = Set(blocked: new BackgroundRef("abc123", "/bg/a.jpg"));

        await files.SyncAsync(wanted, Base, "token");
        Assert.Equal(1, fired);

        await files.SyncAsync(wanted, Base, "token");   // nothing to do
        Assert.Equal(1, fired);

        await files.SyncAsync(Set(), Base, "token");    // cleared
        Assert.Equal(2, fired);
    }

    /// <summary>An image with no hash file beside it is a download that was interrupted. It reads as
    /// absent rather than as a picture, so it is fetched again instead of half a file being drawn.</summary>
    [Fact]
    public async Task A_half_written_pair_reads_as_absent()
    {
        var files = Store(Serving(new() { ["/bg/a.jpg"] = [1, 2, 3] }));
        await files.SyncAsync(Set(blocked: new BackgroundRef("abc123", "/bg/a.jpg")), Base, "token");

        File.Delete(Path.Combine(_dir, "blocked.hash"));

        Assert.Null(Store().Resolve("blocked"));
    }

    [Fact]
    public async Task Both_slots_are_independent()
    {
        var files = Store(Serving(new() { ["/bg/a.jpg"] = [1], ["/bg/n.jpg"] = [9] }));

        await files.SyncAsync(
            Set(blocked: new BackgroundRef("day", "/bg/a.jpg"), downtime: new BackgroundRef("night", "/bg/n.jpg")),
            Base, "token");

        Assert.Equal("day", files.Resolve("blocked")?.Hash);
        Assert.Equal("night", files.Resolve("downtime")?.Hash);

        // Clearing one leaves the other alone.
        await files.SyncAsync(Set(downtime: new BackgroundRef("night", "/bg/n.jpg")), Base, "token");
        Assert.Null(files.Resolve("blocked"));
        Assert.Equal("night", files.Resolve("downtime")?.Hash);
    }

    [Fact]
    public async Task A_failed_download_never_leaves_a_partial_file_behind()
    {
        var files = Store((_, _, _) => Task.FromResult<byte[]?>(null));

        await files.SyncAsync(Set(blocked: new BackgroundRef("abc123", "/bg/a.jpg")), Base, "token");

        Assert.Null(files.Resolve("blocked"));
        Assert.Empty(Directory.GetFiles(_dir));
        Assert.Contains(_log, line => line.Contains("blocked"));
    }
}

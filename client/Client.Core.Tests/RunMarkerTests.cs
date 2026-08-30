using DigitalAid.Client.Core;

namespace Client.Core.Tests;

public sealed class RunMarkerTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("digitalaid-marker").FullName;
    private string MarkerPath => Path.Combine(_dir, "running");

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void No_marker_means_the_previous_run_ended_cleanly()
    {
        Assert.Null(new RunMarker(MarkerPath).DetectUncleanExit());
    }

    [Fact]
    public void Clean_exit_clears_the_marker()
    {
        var marker = new RunMarker(MarkerPath);
        marker.Arm(DateTimeOffset.Now);
        Assert.True(File.Exists(MarkerPath));

        marker.Clear();

        Assert.False(File.Exists(MarkerPath));
        Assert.Null(new RunMarker(MarkerPath).DetectUncleanExit());
    }

    [Fact]
    public void Surviving_marker_reports_the_last_tick_time()
    {
        var lastTick = new DateTimeOffset(2026, 8, 24, 21, 4, 0, TimeSpan.FromHours(2));
        new RunMarker(MarkerPath).Arm(lastTick);   // process "dies" here — no Clear()

        var detected = new RunMarker(MarkerPath).DetectUncleanExit();

        Assert.NotNull(detected);
        Assert.Equal(lastTick, detected!.Value);
        Assert.Equal(TimeSpan.FromHours(2), detected.Value.Offset);  // offset preserved
    }

    [Fact]
    public void Detection_consumes_the_marker_so_it_reports_once()
    {
        new RunMarker(MarkerPath).Arm(DateTimeOffset.Now);

        Assert.NotNull(new RunMarker(MarkerPath).DetectUncleanExit());
        Assert.Null(new RunMarker(MarkerPath).DetectUncleanExit());
    }

    [Fact]
    public void Unreadable_marker_still_counts_as_an_unclean_exit()
    {
        File.WriteAllText(MarkerPath, "garbage, not a timestamp");

        var detected = new RunMarker(MarkerPath).DetectUncleanExit();

        Assert.NotNull(detected);   // approximated from the file's own mtime rather than dropped
        Assert.False(File.Exists(MarkerPath));
    }

    [Fact]
    public void Arming_repeatedly_refreshes_the_recorded_tick()
    {
        var marker = new RunMarker(MarkerPath);
        var first = new DateTimeOffset(2026, 8, 24, 10, 0, 0, TimeSpan.Zero);
        marker.Arm(first);
        marker.Arm(first.AddMinutes(5));

        Assert.Equal(first.AddMinutes(5), new RunMarker(MarkerPath).DetectUncleanExit());
    }
}

using DigitalAid.Client.Core;

namespace Client.Core.Tests;

/// <summary>
/// Stood Down is the one override in this system that cannot be reversed from the server — no
/// process survives to receive the command (ADR-0004) — so the rules that release it are the only
/// thing standing between a deliberate exit and a PC that never protects itself again.
/// </summary>
public sealed class StoodDownMarkerTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("digitalaid-stooddown").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private StoodDownMarker NewMarker() => new(Path.Combine(_dir, "stood-down"));

    private static DateTimeOffset Evening => new(2026, 8, 24, 21, 5, 0, TimeSpan.FromHours(2));

    [Fact]
    public void A_fresh_install_is_not_stood_down()
    {
        Assert.False(NewMarker().IsStoodDown("boot-1", Evening));
    }

    [Fact]
    public void Standing_down_holds_within_the_same_boot_and_day()
    {
        var marker = NewMarker();
        marker.StandDown("boot-1", Evening);

        Assert.True(marker.IsStoodDown("boot-1", Evening));
        Assert.True(marker.IsStoodDown("boot-1", Evening.AddMinutes(90)));
    }

    [Fact]
    public void A_reboot_releases_it()
    {
        var marker = NewMarker();
        marker.StandDown("boot-1", Evening);

        Assert.False(marker.IsStoodDown("boot-2", Evening.AddMinutes(5)));
    }

    [Fact]
    public void Local_midnight_releases_it()
    {
        var marker = NewMarker();
        marker.StandDown("boot-1", Evening);

        // Same boot, next day: a machine left on overnight still gets its protection back, so a
        // stand-down nobody remembers cannot eat tomorrow.
        Assert.False(marker.IsStoodDown("boot-1", Evening.AddHours(4)));
    }

    [Fact]
    public void A_released_marker_leaves_no_file_behind()
    {
        var marker = NewMarker();
        marker.StandDown("boot-1", Evening);
        marker.IsStoodDown("boot-2", Evening);

        Assert.False(File.Exists(Path.Combine(_dir, "stood-down")));
    }

    [Fact]
    public void An_unreadable_marker_means_enforce()
    {
        var path = Path.Combine(_dir, "stood-down");
        File.WriteAllText(path, "garbage that is not a marker");

        // Guessing "stood down" here would leave a PC that silently never protects itself again;
        // guessing "enforce" costs at most an unwanted restart.
        Assert.False(new StoodDownMarker(path).IsStoodDown("boot-1", Evening));
    }

    [Fact]
    public void Peeking_does_not_consume_the_marker()
    {
        var marker = NewMarker();
        marker.StandDown("boot-1", Evening);

        // --status reads this. A diagnostic that decided whether the app starts would be a trap:
        // run it twice and you get two different answers.
        Assert.True(marker.IsHeld("boot-1", Evening));
        Assert.True(marker.IsHeld("boot-1", Evening));
        Assert.True(marker.IsStoodDown("boot-1", Evening));
    }

    [Fact]
    public void Peeking_a_released_marker_reports_released_without_deleting_it()
    {
        var marker = NewMarker();
        marker.StandDown("boot-1", Evening);

        Assert.False(marker.IsHeld("boot-2", Evening));
        Assert.True(File.Exists(Path.Combine(_dir, "stood-down")));
    }

    [Fact]
    public void Boot_id_is_stable_across_calls_a_few_seconds_apart()
    {
        // "now minus uptime" drifts by a second or two between calls; if that changed the id, every
        // stand-down would release itself immediately.
        var first = StoodDownMarker.BootIdFrom(Evening, TimeSpan.FromHours(5));
        var second = StoodDownMarker.BootIdFrom(Evening.AddSeconds(3), TimeSpan.FromHours(5).Add(TimeSpan.FromSeconds(3)));

        Assert.Equal(first, second);
    }

    [Fact]
    public void Boot_id_changes_across_a_reboot()
    {
        var before = StoodDownMarker.BootIdFrom(Evening, TimeSpan.FromHours(5));
        var afterReboot = StoodDownMarker.BootIdFrom(Evening.AddHours(1), TimeSpan.FromMinutes(2));

        Assert.NotEqual(before, afterReboot);
    }
}

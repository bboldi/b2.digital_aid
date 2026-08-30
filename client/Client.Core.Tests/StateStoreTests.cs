using DigitalAid.Client.Core;

namespace Client.Core.Tests;

public sealed class StateStoreTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("digitalaid-state").FullName;

    private string Path(string name) => System.IO.Path.Combine(_dir, name);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void Missing_file_loads_unpaired_defaults()
    {
        var state = new StateStore(Path("state.json")).Load();

        Assert.False(state.IsPaired);
        Assert.Equal(1, state.NextSeq);
        Assert.Equal(Settings.Default, state.Settings.ToSettings());
        Assert.False(state.Disabled);
    }

    [Fact]
    public void Roundtrips_every_field()
    {
        var store = new StateStore(Path("state.json"));
        var engine = new EnforcementEngine(Settings.Default, "GEZDGNBVGY3TQOJQ");
        engine.Tick(new DateTimeOffset(2026, 8, 24, 10, 0, 0, TimeSpan.FromHours(2)), TimeSpan.Zero, true);
        engine.ApplyAdjustment(15);

        var saved = new ClientState
        {
            ServerUrl = "https://aid.example.com",
            ClientToken = new string('a', 64),
            ClientId = 7,
            NextSeq = 42,
            FamilyCodeSecret = "GEZDGNBVGY3TQOJQ",
            Settings = PersistedSettings.From(new Settings(new TimeOnly(22, 30), new TimeOnly(6, 45), 90, 150)),
            Counters = PersistedSnapshot.From(engine.Snapshot()),
            Disabled = true,
            LastVersion = "0.1.0",
        };
        store.Save(saved);

        var loaded = new StateStore(Path("state.json")).Load();
        Assert.Equal(saved, loaded);
        Assert.True(loaded.IsPaired);
        Assert.Equal(new TimeOnly(22, 30), loaded.Settings.ToSettings().DowntimeStart);
        Assert.Equal(15 * 60, loaded.Counters.ToSnapshot().GrantRemainingSeconds);
    }

    [Fact]
    public void Save_leaves_no_temp_file_behind()
    {
        var store = new StateStore(Path("state.json"));
        store.Save(new ClientState { ClientToken = "t", ServerUrl = "u" });

        Assert.True(File.Exists(Path("state.json")));
        Assert.False(File.Exists(Path("state.json.tmp")));
    }

    [Fact]
    public void Overwriting_existing_state_keeps_the_newer_values()
    {
        var store = new StateStore(Path("state.json"));
        store.Save(new ClientState { NextSeq = 5 });
        store.Save(new ClientState { NextSeq = 6 });

        Assert.Equal(6, store.Load().NextSeq);
    }

    [Fact]
    public void Corrupt_state_is_quarantined_not_deleted()
    {
        File.WriteAllText(Path("state.json"), "{ this is not json");
        var store = new StateStore(Path("state.json"));

        var state = store.Load();

        Assert.False(state.IsPaired);                          // un-paired: recoverable by re-pairing
        Assert.True(File.Exists(Path("state.json.corrupt")));  // evidence kept
        Assert.Contains("not json", File.ReadAllText(Path("state.json.corrupt")));
    }

    [Fact]
    public void Creates_missing_directories()
    {
        var nested = System.IO.Path.Combine(_dir, "a", "b", "state.json");
        new StateStore(nested).Save(new ClientState());

        Assert.True(File.Exists(nested));
    }
}

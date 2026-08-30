using System.Text.Json.Nodes;
using DigitalAid.Client.Core;

namespace Client.Core.Tests;

public sealed class EventQueueTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("digitalaid-queue").FullName;
    private string QueuePath => Path.Combine(_dir, "events.jsonl");

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static ClientEvent Event(long seq, string type = EventTypes.OsShutdown, JsonObject? payload = null) =>
        ClientEvent.Create(seq, new DateTimeOffset(2026, 8, 24, 20, 0, (int)(seq % 60), TimeSpan.FromHours(2)), type, payload);

    [Fact]
    public void Empty_queue_takes_nothing()
    {
        var q = new EventQueue(QueuePath);
        Assert.Empty(q.TakeBatch());
        Assert.Equal(0, q.PendingCount());
    }

    [Fact]
    public void Clear_drops_both_the_queue_and_a_batch_left_in_flight()
    {
        var q = new EventQueue(QueuePath);
        q.Append(Event(1));
        q.TakeBatch();      // moves it in flight, never committed
        q.Append(Event(2));
        Assert.Equal(2, q.PendingCount());

        q.Clear();
        Assert.Equal(0, q.PendingCount());
        Assert.Empty(q.TakeBatch());
    }

    [Fact]
    public void Appends_and_takes_in_order_with_payload_intact()
    {
        var q = new EventQueue(QueuePath);
        q.Append(Event(1, EventTypes.GrantRedeemed, new JsonObject { ["minutes"] = 25 }));
        q.Append(Event(2, EventTypes.ClockJump, new JsonObject { ["deltaSeconds"] = 7200 }));
        q.Append(Event(3));

        var batch = q.TakeBatch();

        Assert.Equal([1L, 2L, 3L], batch.Select(e => e.Seq));
        Assert.Equal(EventTypes.GrantRedeemed, batch[0].Type);
        Assert.Equal(25, batch[0].Payload!["minutes"]!.GetValue<int>());
        Assert.Equal(7200, batch[1].Payload!["deltaSeconds"]!.GetValue<int>());
        Assert.Null(batch[2].Payload);
        Assert.Equal("2026-08-24T20:00:01+02:00", batch[0].Ts);   // offset on the wire, per PROTOCOL §1
    }

    [Fact]
    public void Commit_after_a_successful_send_empties_the_queue()
    {
        var q = new EventQueue(QueuePath);
        q.Append(Event(1));
        q.TakeBatch();
        q.Commit();

        Assert.Empty(q.TakeBatch());
        Assert.Equal(0, q.PendingCount());
    }

    [Fact]
    public void A_crash_before_commit_re_delivers_rather_than_losing()
    {
        var q = new EventQueue(QueuePath);
        q.Append(Event(1));
        q.Append(Event(2));
        q.TakeBatch();                       // sent, then the socket died before Commit

        var afterRestart = new EventQueue(QueuePath).TakeBatch();

        Assert.Equal([1L, 2L], afterRestart.Select(e => e.Seq));   // safe: server dedupes on seq
    }

    [Fact]
    public void Events_queued_during_a_flush_merge_behind_the_in_flight_ones()
    {
        var q = new EventQueue(QueuePath);
        q.Append(Event(1));
        q.TakeBatch();          // in flight, not yet committed
        q.Append(Event(2));     // happens while the flush is outstanding
        q.Append(Event(3));

        var merged = q.TakeBatch();

        Assert.Equal([1L, 2L, 3L], merged.Select(e => e.Seq));     // order preserved across the boundary
        Assert.Equal(3, q.PendingCount());
    }

    [Fact]
    public void Commit_only_clears_what_was_taken()
    {
        var q = new EventQueue(QueuePath);
        q.Append(Event(1));
        q.TakeBatch();
        q.Append(Event(2));     // arrived after the batch was taken
        q.Commit();             // acknowledges only Event 1

        var remaining = q.TakeBatch();

        Assert.Equal([2L], remaining.Select(e => e.Seq));
    }

    [Fact]
    public void A_torn_final_line_costs_one_event_not_the_whole_queue()
    {
        var q = new EventQueue(QueuePath);
        q.Append(Event(1));
        q.Append(Event(2));
        File.AppendAllText(QueuePath, "{\"seq\":3,\"ts\":\"2026-08-2");   // power cut mid-write

        var batch = q.TakeBatch();

        Assert.Equal([1L, 2L], batch.Select(e => e.Seq));
    }

    [Fact]
    public void Pending_count_sees_both_files()
    {
        var q = new EventQueue(QueuePath);
        q.Append(Event(1));
        q.TakeBatch();
        q.Append(Event(2));

        Assert.Equal(2, q.PendingCount());
    }

    [Fact]
    public void Survives_a_reopen_of_the_same_directory()
    {
        new EventQueue(QueuePath).Append(Event(1));
        var reopened = new EventQueue(QueuePath);

        Assert.Equal(1, reopened.PendingCount());
        Assert.Single(reopened.TakeBatch());
    }
}

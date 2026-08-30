using System.Text;
using System.Text.Json;

namespace DigitalAid.Client.Core;

/// <summary>
/// The offline Event queue: append-only JSON Lines on disk, so an Event survives the instant it is
/// created and a partially written last line costs at most that one Event.
///
/// Flushing is deliberately two-phase. <see cref="TakeBatch"/> moves the queue aside to an in-flight
/// file and returns its contents; <see cref="Commit"/> deletes that file once the socket write
/// succeeded. A crash between the two leaves the in-flight file, which the next
/// <see cref="TakeBatch"/> merges back in — so Events are never lost, only possibly re-sent, and
/// re-sending is free because the server dedupes on <c>(client_id, seq)</c> (ADR-0001).
/// </summary>
public sealed class EventQueue
{
    private readonly string _queuePath;
    private readonly string _inflightPath;
    private readonly object _gate = new();

    public EventQueue(string queuePath)
    {
        _queuePath = queuePath;
        _inflightPath = queuePath + ".inflight";
        var dir = Path.GetDirectoryName(queuePath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
    }

    public void Append(ClientEvent e)
    {
        lock (_gate)
            File.AppendAllText(_queuePath, JsonSerializer.Serialize(e) + "\n", Encoding.UTF8);
    }

    /// <summary>Pending Events waiting to be sent, in order, including any left in flight by a crash.</summary>
    public IReadOnlyList<ClientEvent> TakeBatch()
    {
        lock (_gate)
        {
            // Merge a crashed batch back in front of the newer queue, preserving order.
            if (File.Exists(_inflightPath) && File.Exists(_queuePath))
            {
                File.AppendAllText(_inflightPath, File.ReadAllText(_queuePath), Encoding.UTF8);
                File.Delete(_queuePath);
            }
            else if (File.Exists(_queuePath))
            {
                File.Move(_queuePath, _inflightPath, overwrite: true);
            }

            return File.Exists(_inflightPath) ? ReadLines(_inflightPath) : [];
        }
    }

    /// <summary>Acknowledge a taken batch after the socket write succeeded.</summary>
    public void Commit()
    {
        lock (_gate)
            if (File.Exists(_inflightPath)) File.Delete(_inflightPath);
    }

    /// <summary>Drop everything pending, unsent. Only Pairing does this: a new Pairing means a new
    /// <c>client_id</c> and a sequence counter reset to 1, so Events queued under the old identity
    /// would land on the new Client's timeline and eat the numbers it is about to reissue. Losing
    /// them is correct — they belong to a Client that no longer exists (ADR-0001).</summary>
    public void Clear()
    {
        lock (_gate)
        {
            if (File.Exists(_queuePath)) File.Delete(_queuePath);
            if (File.Exists(_inflightPath)) File.Delete(_inflightPath);
        }
    }

    /// <summary>Everything pending, without taking it — for diagnostics and the Flyout.</summary>
    public int PendingCount()
    {
        lock (_gate)
        {
            var count = 0;
            if (File.Exists(_inflightPath)) count += ReadLines(_inflightPath).Count;
            if (File.Exists(_queuePath)) count += ReadLines(_queuePath).Count;
            return count;
        }
    }

    private static List<ClientEvent> ReadLines(string path)
    {
        var events = new List<ClientEvent>();
        foreach (var line in File.ReadLines(path))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                if (JsonSerializer.Deserialize<ClientEvent>(line) is { } e) events.Add(e);
            }
            catch (JsonException)
            {
                // A torn final line from a power cut. Skipping it loses one Event; failing here
                // would strand every Event behind it, which is the worse outcome for the log.
            }
        }
        return events;
    }
}

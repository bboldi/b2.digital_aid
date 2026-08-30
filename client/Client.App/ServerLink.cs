using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using DigitalAid.Client.Core;

namespace DigitalAid.Client.App;

/// <summary>
/// The one WebSocket to the server (PROTOCOL §4): reconnects forever with jittered backoff, presents
/// the Client Token as a header, and hands received messages to the caller on the UI thread.
///
/// Being connected *is* being online. A rejected token (4001) is not a stop signal — the shell keeps
/// enforcing offline and keeps retrying, because revoke is not remote uninstall (PRD §5.3).
///
/// There are two ladders, not one (ADR-0009). "No response" means the server is absent and the
/// situation is expected to change, so it climbs quickly and caps at a minute. `4001` means the
/// server is up and has said no — and will keep saying no, since nothing clears `revoked_at` — so it
/// waits half an hour, retrying only in case the rejection was itself a mistake. Either ladder is
/// abandoned outright when the network returns or the machine wakes: those are instant, and no
/// ladder length can beat them.
/// </summary>
public sealed class ServerLink : IDisposable
{
    /// <summary>The server did not answer. Capped at a minute: a Client knocking once a minute is
    /// knocking at exactly the Ping rate every healthy Client already sustains, so even a Client that
    /// will never connect again costs the server no more than a live one.</summary>
    private static readonly TimeSpan[] Unreachable =
    [
        TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(20),
        TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(60),
    ];

    /// <summary>The server answered and refused (4001). Flat, and long.</summary>
    private static readonly TimeSpan RejectedWait = TimeSpan.FromMinutes(30);

    /// <summary>Close code for a token the server no longer accepts.</summary>
    private const int TokenRejected = 4001;

    /// <summary>How long a connection must survive before it counts as healthy and clears the backoff.
    /// A rejected token (4001) is closed by the server *after* the handshake succeeds, so connecting
    /// is not evidence of anything — without this, a revoked Client resets its backoff every time and
    /// hammers the server every 5 seconds forever. Revoke is one-way, so that is permanent.</summary>
    private static readonly TimeSpan HealthyConnection = TimeSpan.FromSeconds(30);

    private readonly string _baseUrl;
    private readonly string _token;
    private readonly Action<ServerMessage> _onMessage;
    private readonly Action<bool> _onConnectionChanged;
    private readonly Action<string> _log;
    private readonly CancellationTokenSource _cts = new();
    private readonly Random _jitter = new();

    private ClientWebSocket? _socket;
    /// <summary>Cancelled to cut a backoff short — by <see cref="RetryNow"/>, or by Windows telling
    /// us the network is back.</summary>
    private CancellationTokenSource? _wake;

    public ServerLink(string baseUrl, string token,
        Action<ServerMessage> onMessage, Action<bool> onConnectionChanged, Action<string> log)
    {
        _baseUrl = baseUrl.TrimEnd('/');
        _token = token;
        _onMessage = onMessage;
        _onConnectionChanged = onConnectionChanged;
        _log = log;
    }

    public bool IsConnected => _socket?.State == WebSocketState.Open;

    /// <summary>True once the server has refused this Client's token. Distinct from simply being
    /// offline, and the shell says so: sharing one presentation with "the wifi is down" left a
    /// revoked machine looking like a network fault indefinitely, with the explanation buried in a
    /// local text file.</summary>
    public bool Rejected { get; private set; }

    /// <summary>When the next attempt is due, or null while one is in flight. Shown in the tray so
    /// "is it even trying?" is answerable without opening a log.</summary>
    public DateTimeOffset? NextAttemptAt { get; private set; }

    /// <summary>Stop waiting and try now. Safe at any time; does nothing if an attempt is already
    /// under way.</summary>
    public void RetryNow() => _wake?.Cancel();

    public void Start()
    {
        // The ladders cannot see either of these: a laptop waking or wifi returning changes nothing
        // the loop can observe until it next tries, which could be a minute of being needlessly
        // offline after the network came back instantly.
        System.Net.NetworkInformation.NetworkChange.NetworkAvailabilityChanged += OnNetworkChanged;
        Microsoft.Win32.SystemEvents.PowerModeChanged += OnPowerModeChanged;
        _ = Task.Run(RunAsync);
    }

    private void OnNetworkChanged(object? sender, System.Net.NetworkInformation.NetworkAvailabilityEventArgs e)
    {
        if (!e.IsAvailable) return;
        _log("network came back — retrying now");
        RetryNow();
    }

    private void OnPowerModeChanged(object? sender, Microsoft.Win32.PowerModeChangedEventArgs e)
    {
        if (e.Mode != Microsoft.Win32.PowerModes.Resume) return;
        _log("resumed from sleep — retrying now");
        RetryNow();
    }

    /// <summary>Send a message. False means "not delivered" — the caller decides what that costs:
    /// a Ping is dropped (a gap is data), an Event batch stays queued for the next connection.</summary>
    public async Task<bool> TrySendAsync(string json)
    {
        var socket = _socket;
        if (socket?.State != WebSocketState.Open) return false;
        try
        {
            await socket.SendAsync(Encoding.UTF8.GetBytes(json), WebSocketMessageType.Text, true, _cts.Token);
            return true;
        }
        catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException or OperationCanceledException)
        {
            return false;
        }
    }

    private async Task RunAsync()
    {
        var attempt = 0;
        while (!_cts.IsCancellationRequested)
        {
            var lived = TimeSpan.Zero;
            int? closeCode = null;
            NextAttemptAt = null;
            try
            {
                using var socket = new ClientWebSocket();
                socket.Options.SetRequestHeader("x-client-token", _token);
                await socket.ConnectAsync(WebSocketUri(), _cts.Token);

                var since = System.Diagnostics.Stopwatch.StartNew();
                _socket = socket;
                _onConnectionChanged(true);
                _log("connected");

                try { closeCode = await ReceiveLoopAsync(socket); }
                finally { lived = since.Elapsed; }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                _log($"connection failed: {ex.Message}");
            }
            finally
            {
                _socket = null;
                _onConnectionChanged(false);
            }

            if (_cts.IsCancellationRequested) return;

            // Only a connection that *lasted* clears the backoff. Connecting alone does not count —
            // see HealthyConnection.
            if (lived >= HealthyConnection) attempt = 0;

            var rejected = closeCode == TokenRejected;
            // Logged once per transition, not once per attempt: half-hourly noise about a machine
            // that is not coming back teaches nobody anything.
            if (rejected && !Rejected) _log("server rejected this client's token — it must be paired again");
            Rejected = rejected;

            var wait = rejected
                ? RejectedWait
                : Unreachable[Math.Min(attempt++, Unreachable.Length - 1)]
                  + TimeSpan.FromMilliseconds(_jitter.Next(0, 3000));

            NextAttemptAt = DateTimeOffset.Now + wait;
            using var wake = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token);
            _wake = wake;
            try { await Task.Delay(wait, wake.Token); }
            catch (OperationCanceledException) when (!_cts.IsCancellationRequested) { /* woken early */ }
            catch (OperationCanceledException) { return; }
            finally { _wake = null; }
        }
    }

    /// <summary>Returns the close code the server sent, if it closed cleanly — which is how a
    /// rejected token is told apart from a link that simply died.</summary>
    private async Task<int?> ReceiveLoopAsync(ClientWebSocket socket)
    {
        var buffer = new byte[32 * 1024];
        while (socket.State == WebSocketState.Open && !_cts.IsCancellationRequested)
        {
            var message = new StringBuilder();
            WebSocketReceiveResult result;
            do
            {
                result = await socket.ReceiveAsync(buffer, _cts.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    var code = (int?)socket.CloseStatus;
                    _log($"server closed: {code} {socket.CloseStatusDescription}");
                    return code;
                }
                message.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
            }
            while (!result.EndOfMessage);

            _onMessage(ServerMessageParser.Parse(message.ToString()));
        }
        return null;
    }

    private Uri WebSocketUri()
    {
        var scheme = _baseUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws";
        var authority = _baseUrl[(_baseUrl.IndexOf("://", StringComparison.Ordinal) + 3)..];
        return new Uri($"{scheme}://{authority}/ws");
    }

    public void Dispose()
    {
        System.Net.NetworkInformation.NetworkChange.NetworkAvailabilityChanged -= OnNetworkChanged;
        Microsoft.Win32.SystemEvents.PowerModeChanged -= OnPowerModeChanged;
        _cts.Cancel();
        _socket?.Dispose();
        _cts.Dispose();
    }

    // --- Pairing (the one REST call) ------------------------------------------------

    /// <param name="adopt">Null on the first attempt. Then the Client id a person agreed to reconnect
    /// to, or <c>false</c> to set this PC up as a new one (ADR-0008).</param>
    public static async Task<PairResponse?> PairAsync(string baseUrl, string code, string pcName,
        object? adopt = null)
    {
        using var http = new HttpClient { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(20) };
        using var content = new StringContent(
            ClientMessages.PairRequest(code, pcName, MachineId.Read(), adopt), Encoding.UTF8, "application/json");

        var response = await http.PostAsync("api/pair", content);
        if (response.StatusCode is System.Net.HttpStatusCode.Unauthorized or System.Net.HttpStatusCode.Forbidden) 
            return null;
            
        response.EnsureSuccessStatusCode();
        return ClientMessages.ParsePairResponse(await response.Content.ReadAsStringAsync());
    }
}

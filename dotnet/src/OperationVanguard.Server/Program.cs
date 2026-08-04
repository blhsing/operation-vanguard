using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using OperationVanguard.Core;

namespace OperationVanguard.Server;

public static class Program
{
    public static async Task<int> Main(string[] args)
    {
        var mapId = Argument(args, "map", Maps.DefaultId);
        var modeId = Argument(args, "mode", ModeData.DefaultMode);
        var portText = Argument(
            args,
            "port",
            GameConstants.Network.DefaultPort.ToString(CultureInfo.InvariantCulture));
        var botsText = Argument(args, "bots", "6");

        if (!Maps.Ids.Contains(mapId, StringComparer.Ordinal))
        {
            Console.Error.WriteLine($"unknown map \"{mapId}\"; one of: {string.Join(", ", Maps.Ids)}");
            return 1;
        }

        if (!ModeData.ModeIds.Contains(modeId, StringComparer.Ordinal))
        {
            Console.Error.WriteLine(
                $"unknown mode \"{modeId}\"; one of: {string.Join(", ", ModeData.ModeIds)}");
            return 1;
        }

        if (!int.TryParse(portText, NumberStyles.Integer, CultureInfo.InvariantCulture, out var port) ||
            port is < IPEndPoint.MinPort or > IPEndPoint.MaxPort)
        {
            Console.Error.WriteLine($"invalid port \"{portText}\"");
            return 1;
        }

        if (!double.TryParse(
                botsText,
                NumberStyles.Float,
                CultureInfo.InvariantCulture,
                out var requestedBots) ||
            !double.IsFinite(requestedBots) ||
            requestedBots > int.MaxValue)
        {
            Console.Error.WriteLine($"invalid bot count \"{botsText}\"");
            return 1;
        }

        // JavaScript's `for (let i = 0; i < count; i++)` admits the ceiling of a
        // positive fractional count and none for a negative count.
        var botCount = requestedBots > 0d ? (int)Math.Ceiling(requestedBots) : 0;

        var game = new GameServer(new GameServerOptions
        {
            MapId = mapId,
            ModeId = modeId,
            BotCount = botCount,
        });

        var builder = WebApplication.CreateBuilder(args);
        builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
        builder.Services.Configure<HostOptions>(options =>
            options.ShutdownTimeout = TimeSpan.FromSeconds(2d));
        builder.Services.AddSingleton(game);
        builder.Services.AddSingleton<WebSocketRoomHost>();
        builder.Services.AddHostedService<FixedTickService>();

        var app = builder.Build();
        app.UseWebSockets();
        app.Run(async context =>
        {
            var host = context.RequestServices.GetRequiredService<WebSocketRoomHost>();
            await host.HandleAsync(context);
        });

        Console.WriteLine(
            $"Operation Vanguard server on :{port}  —  {mapId} / {modeId}, " +
            $"{botCount} bots, protocol {GameConstants.Network.ProtocolVersion}");

        await app.RunAsync();
        return 0;
    }

    private static string Argument(IReadOnlyList<string> args, string name, string fallback)
    {
        var option = $"--{name}";
        for (var index = 0; index < args.Count; index++)
        {
            if (!string.Equals(args[index], option, StringComparison.Ordinal))
            {
                continue;
            }

            return index + 1 < args.Count && !string.IsNullOrEmpty(args[index + 1])
                ? args[index + 1]
                : fallback;
        }

        return fallback;
    }
}

/// <summary>Owns live WebSocket sessions and the transport side of handshakes.</summary>
public sealed class WebSocketRoomHost
{
    private readonly GameServer _game;
    private readonly ConcurrentDictionary<Guid, WebSocketClientLink> _links = [];
    private int _stopping;

    public WebSocketRoomHost(GameServer game)
    {
        _game = game;
    }

    public async Task HandleAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status426UpgradeRequired;
            await context.Response.WriteAsync("WebSocket upgrade required", context.RequestAborted);
            return;
        }

        if (Volatile.Read(ref _stopping) != 0)
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        var link = new WebSocketClientLink(socket);
        var connectionId = Guid.NewGuid();
        _links[connectionId] = link;
        int? playerId = null;

        try
        {
            while (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                var bytes = await ReceiveFrameAsync(socket, context.RequestAborted);
                if (bytes is null)
                {
                    break;
                }

                if (playerId is int known)
                {
                    _game.Receive(known, bytes);
                    continue;
                }

                NetMessage type;
                try
                {
                    type = NetProtocol.PeekType(bytes);
                }
                catch
                {
                    await link.CloseWithStatusAsync(
                        WebSocketCloseStatus.ProtocolError,
                        "malformed hello",
                        context.RequestAborted);
                    break;
                }

                if (type != NetMessage.Hello)
                {
                    await link.CloseWithStatusAsync(
                        WebSocketCloseStatus.ProtocolError,
                        "expected hello",
                        context.RequestAborted);
                    break;
                }

                try
                {
                    var payload = NetProtocol.DecodeControl<JsonElement>(bytes).Payload;
                    var hello = ParseHello(payload);
                    var joined = _game.Join(link, hello);
                    if (joined is int id)
                    {
                        playerId = id;
                        Console.WriteLine(
                            $"+ {hello.Name} joined as {id} ({_game.PlayerCount} playing)");
                    }
                }
                catch
                {
                    await link.CloseWithStatusAsync(
                        WebSocketCloseStatus.ProtocolError,
                        "malformed hello",
                        context.RequestAborted);
                    break;
                }
            }
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            // The request or process ended; membership is removed below.
        }
        catch (WebSocketException)
        {
            // Transport failures are scoped to this connection.
        }
        finally
        {
            _links.TryRemove(connectionId, out _);
            if (playerId is int id)
            {
                _game.Leave(id);
                Console.WriteLine($"- {id} left ({_game.PlayerCount} playing)");
            }
        }
    }

    public async Task ShutdownAsync(CancellationToken cancellationToken = default)
    {
        if (Interlocked.Exchange(ref _stopping, 1) != 0)
        {
            return;
        }

        try
        {
            var links = _links.Values.ToArray();
            await Task.WhenAll(links.Select(link => link.CloseWithStatusAsync(
                WebSocketCloseStatus.EndpointUnavailable,
                "server shutting down",
                cancellationToken)));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // HostOptions provides the same two-second escape hatch as main.ts.
        }
        finally
        {
            _game.Dispose();
        }
    }

    private static HelloPayload ParseHello(JsonElement payload)
    {
        var hello = new HelloPayload();
        if (payload.ValueKind != JsonValueKind.Object)
        {
            return hello;
        }

        if (payload.TryGetProperty("protocolVersion", out var protocol) &&
            protocol.ValueKind == JsonValueKind.Number &&
            protocol.TryGetDouble(out var numericProtocol) &&
            numericProtocol >= int.MinValue &&
            numericProtocol <= int.MaxValue &&
            numericProtocol == Math.Truncate(numericProtocol))
        {
            hello.ProtocolVersion = (int)numericProtocol;
        }

        if (payload.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String)
        {
            hello.Name = name.GetString() ?? string.Empty;
        }

        if (payload.TryGetProperty("loadout", out var loadout))
        {
            hello.Loadout = loadout.Clone();
        }

        return hello;
    }

    private static async Task<byte[]?> ReceiveFrameAsync(
        WebSocket socket,
        CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        using var frame = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer.AsMemory(), cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                if (socket.State == WebSocketState.CloseReceived)
                {
                    await socket.CloseOutputAsync(
                        socket.CloseStatus ?? WebSocketCloseStatus.NormalClosure,
                        socket.CloseStatusDescription,
                        CancellationToken.None);
                }

                return null;
            }

            frame.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                return frame.ToArray();
            }
        }
    }
}

/// <summary>Serializes sends and adapts the synchronous room link to WebSockets.</summary>
public sealed class WebSocketClientLink : IClientLink
{
    private readonly WebSocket _socket;
    private readonly SemaphoreSlim _sendGate = new(1, 1);

    public WebSocketClientLink(WebSocket socket)
    {
        _socket = socket;
    }

    public void Send(byte[] bytes)
    {
        _sendGate.Wait();
        try
        {
            if (_socket.State != WebSocketState.Open)
            {
                return;
            }

            _socket.SendAsync(
                    bytes.AsMemory(),
                    WebSocketMessageType.Binary,
                    true,
                    CancellationToken.None)
                .AsTask()
                .GetAwaiter()
                .GetResult();
        }
        catch (WebSocketException)
        {
            // The owning receive loop observes the failed socket and removes it.
        }
        finally
        {
            _sendGate.Release();
        }
    }

    public void Close(string reason)
    {
        CloseWithStatusAsync(
                WebSocketCloseStatus.NormalClosure,
                reason,
                CancellationToken.None)
            .GetAwaiter()
            .GetResult();
    }

    public async Task CloseWithStatusAsync(
        WebSocketCloseStatus status,
        string reason,
        CancellationToken cancellationToken)
    {
        await _sendGate.WaitAsync(cancellationToken);
        try
        {
            if (_socket.State is not (WebSocketState.Open or WebSocketState.CloseReceived))
            {
                return;
            }

            // ws truncates room-generated reasons to 120 UTF-16 code units.
            if (reason.Length > 120)
            {
                reason = reason[..120];
            }

            await _socket.CloseOutputAsync(status, FitCloseReason(reason), cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Shutdown cancellation is best-effort.
        }
        catch (WebSocketException)
        {
            // The peer may disappear while the close frame is being written.
        }
        finally
        {
            _sendGate.Release();
        }
    }

    private static string FitCloseReason(string reason)
    {
        const int maximumUtf8Bytes = 123;
        if (Encoding.UTF8.GetByteCount(reason) <= maximumUtf8Bytes)
        {
            return reason;
        }

        var length = reason.Length;
        while (length > 0 && Encoding.UTF8.GetByteCount(reason.AsSpan(0, length)) > maximumUtf8Bytes)
        {
            length--;
        }

        if (length > 0 && char.IsHighSurrogate(reason[length - 1]))
        {
            length--;
        }

        return reason[..length];
    }
}

/// <summary>Real-clock accumulator that advances the room at exactly 64 Hz.</summary>
public sealed class FixedTickService : BackgroundService
{
    private const int MaximumCatchUpSteps = 5;
    private readonly GameServer _game;
    private readonly WebSocketRoomHost _host;

    public FixedTickService(GameServer game, WebSocketRoomHost host)
    {
        _game = game;
        _host = host;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var intervalMilliseconds = Math.Max(
            1d,
            Math.Floor(GameConstants.TickDt * 1000d / 2d));
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(intervalMilliseconds));
        var last = Stopwatch.GetTimestamp();
        var accumulator = 0d;

        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                var now = Stopwatch.GetTimestamp();
                accumulator += (now - last) / (double)Stopwatch.Frequency;
                last = now;

                var steps = 0;
                while (accumulator >= GameConstants.TickDt && steps < MaximumCatchUpSteps)
                {
                    _game.Tick(GameConstants.TickDt);
                    accumulator -= GameConstants.TickDt;
                    steps++;
                }

                if (steps == MaximumCatchUpSteps)
                {
                    accumulator = 0d;
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Normal host shutdown.
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        // Stop simulation advancement before closing transports and disposing the
        // room, mirroring clearInterval -> close sockets -> dispose.
        try
        {
            await base.StopAsync(cancellationToken);
        }
        finally
        {
            await _host.ShutdownAsync(cancellationToken);
        }
    }
}

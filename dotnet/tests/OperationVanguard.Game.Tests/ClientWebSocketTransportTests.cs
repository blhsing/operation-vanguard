using System.Diagnostics;
using System.Net;
using System.Net.WebSockets;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using OperationVanguard.Game;

namespace OperationVanguard.Game.Tests;

public sealed class ClientWebSocketTransportTests
{
    [Fact]
    public async Task LoopbackSocketSerializesSendAndReassemblesFragmentedBinaryReceive()
    {
        var serverReceived = new TaskCompletionSource<byte[]>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var app = await StartServerAsync(serverReceived);
        try
        {
            var addressFeature = app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>();
            var httpAddress = Assert.Single(addressFeature!.Addresses);
            var socketUrl = $"ws://{new Uri(httpAddress).Authority}/socket";

            await using var transport = new ClientWebSocketTransport();
            var opened = false;
            var errored = false;
            var closed = false;
            byte[]? response = null;
            transport.Opened += () =>
            {
                opened = true;
                transport.Send([1, 2, 3, 4]);
            };
            transport.MessageReceived += bytes => response = bytes;
            transport.Error += () => errored = true;
            transport.Closed += () => closed = true;

            transport.Open(socketUrl);
            await PumpUntilAsync(transport, () => response is not null && closed);

            Assert.True(opened);
            Assert.False(errored);
            Assert.Equal([9, 8, 7], response);
            Assert.Equal([1, 2, 3, 4], await serverReceived.Task.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.False(transport.IsOpen);
        }
        finally
        {
            await app.StopAsync();
            await app.DisposeAsync();
        }
    }

    [Fact]
    public void PreCancelledTransportClosesOnceAndCannotBeReopened()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        using var transport = new ClientWebSocketTransport(cancellation.Token);
        var closes = 0;
        transport.Closed += () => closes++;

        Assert.Equal(1, transport.Pump());
        Assert.Equal(1, closes);
        Assert.False(transport.IsOpen);
        Assert.Throws<InvalidOperationException>(() => transport.Open("ws://127.0.0.1:1"));

        transport.Close();
        transport.Pump();
        Assert.Equal(1, closes);
    }

    [Theory]
    [InlineData("")]
    [InlineData("https://example.test/socket")]
    [InlineData("not a uri")]
    public void OpenRejectsNonWebSocketUrls(string url)
    {
        using var transport = new ClientWebSocketTransport();
        Assert.Throws<ArgumentException>(() => transport.Open(url));
    }

    private static async Task<WebApplication> StartServerAsync(
        TaskCompletionSource<byte[]> serverReceived)
    {
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        var app = builder.Build();
        app.UseWebSockets();
        app.Run(async context =>
        {
            if (!context.WebSockets.IsWebSocketRequest)
            {
                context.Response.StatusCode = StatusCodes.Status400BadRequest;
                return;
            }

            using var socket = await context.WebSockets.AcceptWebSocketAsync();
            try
            {
                serverReceived.TrySetResult(await ReceiveOneAsync(socket, context.RequestAborted));
                await socket.SendAsync(
                    new byte[] { 9 },
                    WebSocketMessageType.Binary,
                    endOfMessage: false,
                    context.RequestAborted);
                await socket.SendAsync(
                    new byte[] { 8, 7 },
                    WebSocketMessageType.Binary,
                    endOfMessage: true,
                    context.RequestAborted);
                await socket.CloseOutputAsync(
                    WebSocketCloseStatus.NormalClosure,
                    "test complete",
                    context.RequestAborted);
            }
            catch (OperationCanceledException)
            {
            }
            catch (WebSocketException)
            {
            }
        });
        await app.StartAsync();
        return app;
    }

    private static async Task<byte[]> ReceiveOneAsync(
        WebSocket socket,
        CancellationToken cancellationToken)
    {
        var buffer = new byte[64];
        using var output = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(buffer, cancellationToken);
            Assert.Equal(WebSocketMessageType.Binary, result.MessageType);
            output.Write(buffer, 0, result.Count);
        }
        while (!result.EndOfMessage);

        return output.ToArray();
    }

    private static async Task PumpUntilAsync(
        ClientWebSocketTransport transport,
        Func<bool> condition)
    {
        var timer = Stopwatch.StartNew();
        while (!condition() && timer.Elapsed < TimeSpan.FromSeconds(5))
        {
            transport.Pump();
            await Task.Delay(5);
        }

        transport.Pump();
        Assert.True(condition(), "Timed out waiting for the loopback WebSocket exchange.");
    }
}

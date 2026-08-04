using System.Buffers;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Threading.Channels;
using OperationVanguard.Core;

namespace OperationVanguard.Game;

/// <summary>
/// Optional extension used by native transports whose I/O completes on worker
/// threads. Pumping dispatches ordered notifications on the game thread, retaining
/// the browser client's single-threaded network contract.
/// </summary>
public interface IPumpableNetClientTransport
{
    int Pump(int maximumNotifications = 256);
}

/// <summary>
/// Production binary WebSocket transport for <see cref="NetClient"/>. Sends are
/// serialized through one writer task, fragmented frames are reassembled, inbound
/// callbacks are marshalled through <see cref="Pump"/>, and cancellation always
/// tears down an outstanding connect, send, or receive.
/// </summary>
public sealed class ClientWebSocketTransport :
    INetClientTransport,
    IPumpableNetClientTransport,
    IDisposable,
    IAsyncDisposable
{
    private enum TransportState
    {
        Created = 0,
        Connecting = 1,
        Open = 2,
        Closing = 3,
        Closed = 4,
    }

    private enum NotificationKind
    {
        Opened,
        Message,
        Error,
        Closed,
    }

    private readonly record struct Notification(NotificationKind Kind, byte[]? Payload = null);

    public const int DefaultMaximumFrameBytes = 1024 * 1024;
    public const int MaximumQueuedSends = 512;

    private readonly Action<ClientWebSocketOptions>? _configure;
    private readonly int _maximumFrameBytes;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly CancellationTokenRegistration _externalCancellation;
    private readonly Channel<byte[]> _outbound = Channel.CreateBounded<byte[]>(
        new BoundedChannelOptions(MaximumQueuedSends)
        {
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false,
            // Input packets are deliberately redundant. If a socket cannot drain
            // eight seconds of backlog, retaining the newest authoritative intent
            // is both safer and more useful than allowing unbounded memory growth.
            FullMode = BoundedChannelFullMode.DropOldest,
        });
    private readonly ConcurrentQueue<Notification> _notifications = new();

    private ClientWebSocket? _socket;
    private Task? _runTask;
    private int _state = (int)TransportState.Created;
    private int _errorQueued;
    private int _closedQueued;
    private int _disposed;

    public ClientWebSocketTransport(
        CancellationToken cancellationToken = default,
        Action<ClientWebSocketOptions>? configure = null,
        int maximumFrameBytes = DefaultMaximumFrameBytes)
    {
        if (maximumFrameBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumFrameBytes));
        }

        _configure = configure;
        _maximumFrameBytes = maximumFrameBytes;
        _externalCancellation = cancellationToken.CanBeCanceled
            ? cancellationToken.UnsafeRegister(static state =>
                ((ClientWebSocketTransport)state!).Close(), this)
            : default;
    }

    public bool IsOpen =>
        (TransportState)Volatile.Read(ref _state) == TransportState.Open &&
        Volatile.Read(ref _socket)?.State == WebSocketState.Open;

    public event Action? Opened;
    public event Action<byte[]>? MessageReceived;
    public event Action? Closed;
    public event Action? Error;

    /// <summary>Begin connecting without blocking the caller.</summary>
    public void Open(string url)
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeWs && uri.Scheme != Uri.UriSchemeWss))
        {
            throw new ArgumentException("A valid absolute ws:// or wss:// URL is required.", nameof(url));
        }

        if (Interlocked.CompareExchange(
                ref _state,
                (int)TransportState.Connecting,
                (int)TransportState.Created) != (int)TransportState.Created)
        {
            throw new InvalidOperationException("This WebSocket transport has already been opened or closed.");
        }

        _runTask = RunAsync(uri);
    }

    /// <summary>
    /// Queue one immutable binary message. NetClient checks <see cref="IsOpen"/>
    /// first; a close racing this call simply drops the frame.
    /// </summary>
    public void Send(byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);
        if (!IsOpen)
        {
            return;
        }

        _outbound.Writer.TryWrite(bytes.ToArray());
    }

    /// <summary>
    /// Cancel outstanding I/O and begin teardown. This method is idempotent and
    /// non-blocking; Dispose/DisposeAsync wait for the worker when desired.
    /// </summary>
    public void Close()
    {
        while (true)
        {
            var state = (TransportState)Volatile.Read(ref _state);
            if (state is TransportState.Closing or TransportState.Closed)
            {
                return;
            }

            if (Interlocked.CompareExchange(
                    ref _state,
                    (int)TransportState.Closing,
                    (int)state) != (int)state)
            {
                continue;
            }

            _outbound.Writer.TryComplete();
            _lifetime.Cancel();
            try
            {
                Volatile.Read(ref _socket)?.Abort();
            }
            catch (ObjectDisposedException)
            {
                // The worker won the teardown race.
            }

            if (state == TransportState.Created)
            {
                Volatile.Write(ref _state, (int)TransportState.Closed);
                QueueClosed();
            }

            return;
        }
    }

    /// <summary>
    /// Dispatch queued Opened/Message/Error/Closed notifications on the calling
    /// thread. OnlineSession calls this before touching NetClient each fixed tick.
    /// </summary>
    public int Pump(int maximumNotifications = 256)
    {
        if (maximumNotifications <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumNotifications));
        }

        var dispatched = 0;
        while (dispatched < maximumNotifications && _notifications.TryDequeue(out var notification))
        {
            switch (notification.Kind)
            {
                case NotificationKind.Opened:
                    InvokeSafely(Opened);
                    break;
                case NotificationKind.Message:
                    InvokeSafely(MessageReceived, notification.Payload!);
                    break;
                case NotificationKind.Error:
                    InvokeSafely(Error);
                    break;
                case NotificationKind.Closed:
                    InvokeSafely(Closed);
                    break;
                default:
                    break;
            }

            dispatched++;
        }

        return dispatched;
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        Close();
        var runTask = Volatile.Read(ref _runTask);
        if (runTask is not null)
        {
            try
            {
                _ = runTask.Wait(TimeSpan.FromSeconds(5));
            }
            catch (AggregateException exception) when (OnlyCancellation(exception))
            {
                // Expected when Close cancels an in-flight operation.
            }
        }

        _externalCancellation.Dispose();
        Volatile.Read(ref _socket)?.Dispose();
        DisposeLifetimeAfter(runTask);

        GC.SuppressFinalize(this);
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        Close();
        var runTask = Volatile.Read(ref _runTask);
        if (runTask is not null)
        {
            try
            {
                await runTask.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Expected during transport cancellation.
            }
            catch (TimeoutException)
            {
                Volatile.Read(ref _socket)?.Abort();
            }
        }

        _externalCancellation.Dispose();
        Volatile.Read(ref _socket)?.Dispose();
        DisposeLifetimeAfter(runTask);

        GC.SuppressFinalize(this);
    }

    private async Task RunAsync(Uri uri)
    {
        var socket = new ClientWebSocket();
        Volatile.Write(ref _socket, socket);

        try
        {
            _configure?.Invoke(socket.Options);
            await socket.ConnectAsync(uri, _lifetime.Token).ConfigureAwait(false);
            _lifetime.Token.ThrowIfCancellationRequested();
            Volatile.Write(ref _state, (int)TransportState.Open);
            _notifications.Enqueue(new Notification(NotificationKind.Opened));

            var receiveTask = ReceiveLoopAsync(socket, _lifetime.Token);
            var sendTask = SendLoopAsync(socket, _lifetime.Token);
            var completed = await Task.WhenAny(receiveTask, sendTask).ConfigureAwait(false);
            await completed.ConfigureAwait(false);

            _lifetime.Cancel();
            await IgnoreCancellationAsync(receiveTask).ConfigureAwait(false);
            await IgnoreCancellationAsync(sendTask).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
            // Normal local close/cancellation path.
        }
        catch (Exception) when ((TransportState)Volatile.Read(ref _state) == TransportState.Closing)
        {
            // Abort/Dispose can surface WebSocketException or ObjectDisposedException.
        }
        catch (Exception)
        {
            QueueError();
        }
        finally
        {
            _outbound.Writer.TryComplete();
            try
            {
                _lifetime.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // A timed-out synchronous Dispose can finish before this worker.
            }

            socket.Dispose();
            Volatile.Write(ref _state, (int)TransportState.Closed);
            QueueClosed();
        }
    }

    private async Task SendLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        await foreach (var bytes in _outbound.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
        {
            if (socket.State != WebSocketState.Open)
            {
                return;
            }

            await socket.SendAsync(
                bytes,
                WebSocketMessageType.Binary,
                endOfMessage: true,
                cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(16 * 1024);
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(
                        new ArraySegment<byte>(buffer),
                        cancellationToken).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        return;
                    }

                    if (result.MessageType != WebSocketMessageType.Binary)
                    {
                        throw new InvalidDataException("Operation Vanguard accepts binary WebSocket messages only.");
                    }

                    message.Write(buffer, 0, result.Count);
                    if (message.Length > _maximumFrameBytes)
                    {
                        throw new InvalidDataException(
                            $"WebSocket frame exceeded the {_maximumFrameBytes}-byte safety limit.");
                    }
                }
                while (!result.EndOfMessage);

                _notifications.Enqueue(new Notification(NotificationKind.Message, message.ToArray()));
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private void QueueError()
    {
        if (Interlocked.Exchange(ref _errorQueued, 1) == 0)
        {
            _notifications.Enqueue(new Notification(NotificationKind.Error));
        }
    }

    private void QueueClosed()
    {
        if (Interlocked.Exchange(ref _closedQueued, 1) == 0)
        {
            _notifications.Enqueue(new Notification(NotificationKind.Closed));
        }
    }

    private static async Task IgnoreCancellationAsync(Task task)
    {
        try
        {
            await task.ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }
        catch (WebSocketException)
        {
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private static bool OnlyCancellation(AggregateException exception) =>
        exception.Flatten().InnerExceptions.All(inner => inner is OperationCanceledException);

    private void DisposeLifetimeAfter(Task? runTask)
    {
        if (runTask is null || runTask.IsCompleted)
        {
            _lifetime.Dispose();
            return;
        }

        _ = runTask.ContinueWith(
            static (_, state) => ((CancellationTokenSource)state!).Dispose(),
            _lifetime,
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    private static void InvokeSafely(Action? handlers)
    {
        if (handlers is null)
        {
            return;
        }

        foreach (Action handler in handlers.GetInvocationList())
        {
            try
            {
                handler();
            }
            catch
            {
                // A consumer callback cannot terminate the socket worker or block
                // later subscribers from observing the same notification.
            }
        }
    }

    private static void InvokeSafely(Action<byte[]>? handlers, byte[] payload)
    {
        if (handlers is null)
        {
            return;
        }

        foreach (Action<byte[]> handler in handlers.GetInvocationList())
        {
            try
            {
                handler(payload);
            }
            catch
            {
                // See the parameterless overload.
            }
        }
    }
}

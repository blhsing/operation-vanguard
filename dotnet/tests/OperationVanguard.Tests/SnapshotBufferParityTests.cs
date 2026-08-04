using OperationVanguard.Core;

namespace OperationVanguard.Tests;

[Collection("Networking runtime serial")]
public sealed class SnapshotBufferParityTests
{
    [Fact]
    public void EmptyBufferHasNoLatestFrameAndSamplesNothing()
    {
        var buffer = new SnapshotBuffer();

        Assert.Null(buffer.Latest);
        Assert.Equal(0, buffer.Size);
        Assert.Empty(buffer.Sample());
    }

    [Fact]
    public void SamplesEveryContinuousFieldBetweenBracketingFrames()
    {
        var buffer = new SnapshotBuffer();
        var before = Player(1, x: 0d, yaw: 3.1d);
        before.Y = 2d;
        before.Z = 4d;
        before.Vx = 1d;
        before.Vy = 2d;
        before.Vz = 3d;
        before.Pitch = -0.4d;
        before.Lean = -1d;
        before.Health = 20;
        var after = Player(1, x: 20d, yaw: -3.1d);
        after.Y = 6d;
        after.Z = 12d;
        after.Vx = 5d;
        after.Vy = 6d;
        after.Vz = 7d;
        after.Pitch = 0.4d;
        after.Lean = 1d;
        after.Health = 90;
        after.Team = (int)Team.Allies;
        after.MoveState = (int)MoveState.Sprint;
        buffer.Push(At(0d, before));
        buffer.Push(At(0.2d, after));

        var sampled = Assert.Single(buffer.Sample());
        Assert.Equal(10d, sampled.X, 9);
        Assert.Equal(4d, sampled.Y, 9);
        Assert.Equal(8d, sampled.Z, 9);
        Assert.Equal(3d, sampled.Vx, 9);
        Assert.Equal(4d, sampled.Vy, 9);
        Assert.Equal(5d, sampled.Vz, 9);
        Assert.Equal(0d, sampled.Pitch, 9);
        Assert.Equal(0d, sampled.Lean, 9);
        Assert.Equal(Math.PI, sampled.Yaw, 2);
        // Discrete state is always taken from the newer frame, like {...b}.
        Assert.Equal(90, sampled.Health);
        Assert.Equal((int)Team.Allies, sampled.Team);
        Assert.Equal((int)MoveState.Sprint, sampled.MoveState);
    }

    [Fact]
    public void AdvanceKeepsMotionFlowingBetweenPacketArrivals()
    {
        var buffer = new SnapshotBuffer();
        buffer.Push(At(0d, Player(1, 0d)));
        buffer.Push(At(0.1d, Player(1, 10d)));
        buffer.Push(At(0.2d, Player(1, 20d)));

        var still = buffer.Sample()[0].X;
        var later = buffer.Sample(0.025d)[0].X;

        Assert.True(later > still);
        Assert.Equal(10d, still, 9);
        Assert.Equal(12.5d, later, 9);
    }

    [Fact]
    public void SamplingBeforeOrAfterHistoryUsesNearestFrameWithoutExtrapolation()
    {
        var buffer = new SnapshotBuffer();
        var first = At(0d, Player(1, 0d));
        var last = At(0.1d, Player(1, 10d));
        buffer.Push(first);
        buffer.Push(last);

        Assert.Same(first.Players, buffer.Sample(-10d));
        Assert.Same(last.Players, buffer.Sample(10d));
        Assert.Equal(10d, buffer.Sample(10d)[0].X);
    }

    [Fact]
    public void AcceptsOutOfOrderDeliveryAndKeepsNewestByServerTime()
    {
        var buffer = new SnapshotBuffer();
        buffer.Push(At(0.2d, Player(1, 20d)));
        buffer.Push(At(0d, Player(1, 0d)));
        buffer.Push(At(0.1d, Player(1, 10d)));

        Assert.Equal(0.2d, buffer.Latest!.ServerTime, 9);
        Assert.Equal(10d, buffer.Sample()[0].X, 9);
    }

    [Fact]
    public void RemovedPlayersDisappearAndNewerOnlyPlayersAppearImmediately()
    {
        var buffer = new SnapshotBuffer();
        buffer.Push(At(0d, Player(1, 0d)));
        var newcomer = Player(2, 25d);
        buffer.Push(At(0.2d, newcomer));

        var sampled = Assert.Single(buffer.Sample());
        Assert.Same(newcomer, sampled);
        Assert.Equal(2, sampled.Id);
    }

    [Fact]
    public void HistoryIsPrunedToTheUsefulTwoSecondWindow()
    {
        var buffer = new SnapshotBuffer();
        for (var index = 0; index < 500; index++)
        {
            buffer.Push(At(index / (double)GameConstants.Network.SnapshotRate, Player(1, index)));
        }

        Assert.True(buffer.Size < GameConstants.Network.SnapshotRate * 4);
        Assert.True(buffer.Size >= 2);
    }

    [Fact]
    public void ClearResetsHistoryAndTheRenderClockOrigin()
    {
        var buffer = new SnapshotBuffer();
        buffer.Push(At(50d, Player(1, 50d)));

        buffer.Clear();
        buffer.Push(At(0d, Player(1, 3d)));

        Assert.Equal(1, buffer.Size);
        Assert.Equal(3d, buffer.Sample()[0].X);
    }

    [Theory]
    [InlineData(3.1d, -3.1d, 3.141592653589793d)]
    [InlineData(-3.1d, 3.1d, -3.141592653589793d)]
    [InlineData(0d, 1d, 0.5d)]
    public void LerpAngleTurnsThroughTheShortestArc(double from, double to, double expected)
    {
        Assert.Equal(expected, SnapshotBuffer.LerpAngle(from, to, 0.5d), 2);
    }

    private static Snapshot At(double time, params PlayerSnapshot[] players) => new()
    {
        Tick = (uint)Math.Round(time * GameConstants.TickRate),
        ServerTime = time,
        Players = [.. players],
    };

    private static PlayerSnapshot Player(int id, double x, double yaw = 0d) => new()
    {
        Id = id,
        Team = (int)Team.Axis,
        Alive = true,
        OnGround = true,
        X = x,
        Yaw = yaw,
        Health = 100,
    };
}

using OperationVanguard.Core;

namespace OperationVanguard.Tests;

[Collection("Networking runtime serial")]
public sealed class PredictionParityTests
{
    [Fact]
    public void PredictMovesImmediatelyAndRetainsTheInput()
    {
        var (collision, player) = NetworkingTestData.Player();
        var predictor = new Predictor(collision);
        var before = new Vec3(player.Position.X, player.Position.Y, player.Position.Z);

        predictor.Predict(player, NetworkingTestData.Forward(1));

        Assert.NotEqual((before.X, before.Y, before.Z),
            (player.Position.X, player.Position.Y, player.Position.Z));
        Assert.Single(predictor.Unacknowledged());
        Assert.Equal(1, predictor.Stats().Pending);
    }

    [Fact]
    public void AcknowledgementDropsOnlyInputsTheServerHasProcessed()
    {
        var (collision, player) = NetworkingTestData.Player();
        var predictor = new Predictor(collision);
        for (var sequence = 1; sequence <= 20; sequence++)
        {
            predictor.Predict(player, NetworkingTestData.Forward(sequence));
        }

        predictor.Reconcile(player, NetworkingTestData.SnapshotOf(player), 12);

        Assert.Equal(8, predictor.Unacknowledged().Count);
        Assert.Equal(13, predictor.Unacknowledged()[0].Seq);
        Assert.Equal(20, predictor.Unacknowledged()[^1].Seq);
    }

    [Fact]
    public void PendingInputsAreCopiesOfAReusedCallerObject()
    {
        var (collision, player) = NetworkingTestData.Player();
        var predictor = new Predictor(collision);
        var reused = NetworkingTestData.Forward(1);

        predictor.Predict(player, reused);
        reused.Seq = 2;
        reused.Tick = 2;
        reused.MoveForward = -1d;
        reused.Buttons = (int)InputFlag.Sprint;
        predictor.Predict(player, reused);

        var pending = predictor.Unacknowledged();
        Assert.Equal(1, pending[0].Seq);
        Assert.Equal(1d, pending[0].MoveForward);
        Assert.Equal(0, pending[0].Buttons);
        Assert.Equal(2, pending[1].Seq);
        Assert.Equal(-1d, pending[1].MoveForward);
    }

    [Fact]
    public void AgreeingAuthorityReplaysToTheAlreadyPredictedPosition()
    {
        var (collision, player) = NetworkingTestData.Player();
        var predictor = new Predictor(collision);
        for (var sequence = 1; sequence <= 10; sequence++)
        {
            predictor.Predict(player, NetworkingTestData.Forward(sequence));
        }

        var (truthCollision, truthPlayer) = NetworkingTestData.Player();
        var truthPredictor = new Predictor(truthCollision);
        for (var sequence = 1; sequence <= 4; sequence++)
        {
            truthPredictor.Predict(truthPlayer, NetworkingTestData.Forward(sequence));
        }

        var predictedX = player.Position.X;
        var predictedZ = player.Position.Z;
        predictor.Reconcile(player, NetworkingTestData.SnapshotOf(truthPlayer), 4);

        Assert.Equal(predictedX, player.Position.X, 3);
        Assert.Equal(predictedZ, player.Position.Z, 3);
        Assert.Equal(0, predictor.Stats().Mispredictions);
        Assert.Equal(6, predictor.Stats().Pending);
    }

    [Fact]
    public void DisagreeingAuthorityCorrectsExactlyOnce()
    {
        var (collision, player) = NetworkingTestData.Player();
        var predictor = new Predictor(collision);
        for (var sequence = 1; sequence <= 6; sequence++)
        {
            predictor.Predict(player, NetworkingTestData.Forward(sequence));
        }

        var truth = NetworkingTestData.SnapshotOf(player);
        truth.X += 5d;
        predictor.Reconcile(player, truth, 6);

        Assert.Equal(1, predictor.Stats().Mispredictions);
        Assert.True(predictor.Stats().LastCorrection > 4d);
        Assert.Equal(truth.X, player.Position.X, 4);

        predictor.Reconcile(player, NetworkingTestData.SnapshotOf(player), 6);

        Assert.Equal(1, predictor.Stats().Mispredictions);
        Assert.Equal(0d, predictor.Stats().LastCorrection, 9);
    }

    [Fact]
    public void ReconcileAdoptsPhysicalStateButLeavesLocalAimAlone()
    {
        var (collision, player) = NetworkingTestData.Player();
        var predictor = new Predictor(collision);
        player.Yaw = 1.5d;
        player.Pitch = -0.3d;
        var authoritative = NetworkingTestData.SnapshotOf(player);
        authoritative.X = 4d;
        authoritative.Y = 5d;
        authoritative.Z = 6d;
        authoritative.Vx = 7d;
        authoritative.Vy = 8d;
        authoritative.Vz = 9d;
        authoritative.OnGround = false;
        authoritative.Yaw = -2.8d;
        authoritative.Pitch = 0.9d;

        predictor.Reconcile(player, authoritative, 0);

        Assert.Equal((4d, 5d, 6d), (player.Position.X, player.Position.Y, player.Position.Z));
        Assert.Equal((7d, 8d, 9d), (player.Velocity.X, player.Velocity.Y, player.Velocity.Z));
        Assert.False(player.OnGround);
        Assert.Equal(1.5d, player.Yaw);
        Assert.Equal(-0.3d, player.Pitch);
    }

    [Fact]
    public void InputHistoryUsesTheSharedTwoSecondSafetyCap()
    {
        var (collision, player) = NetworkingTestData.Player();
        var predictor = new Predictor(collision);
        for (var sequence = 1; sequence <= GameConstants.InputBufferSize + 7; sequence++)
        {
            predictor.Predict(player, NetworkingTestData.Forward(sequence));
        }

        Assert.Equal(GameConstants.InputBufferSize, predictor.Unacknowledged().Count);
        Assert.Equal(8, predictor.Unacknowledged()[0].Seq);
    }

    [Fact]
    public void ResetClearsInputsAndAllCorrectionStatistics()
    {
        var (collision, player) = NetworkingTestData.Player();
        var predictor = new Predictor(collision);
        predictor.Predict(player, NetworkingTestData.Forward(1));
        var displaced = NetworkingTestData.SnapshotOf(player);
        displaced.X += 2d;
        predictor.Reconcile(player, displaced, 1);

        predictor.Reset();

        Assert.Equal(new PredictionStats(0, 0, 0d), predictor.Stats());
        Assert.Empty(predictor.Unacknowledged());
    }
}

namespace OperationVanguard.Core;

public readonly record struct PredictionStats(
    int Pending,
    int Mispredictions,
    double LastCorrection);

/// <summary>
/// Predicts local movement immediately, retains unacknowledged input copies, and
/// replays those inputs over each authoritative server correction.
/// </summary>
public sealed class Predictor
{
    private const double MispredictEpsilon = 0.05d;

    private readonly ICollisionWorld _collision;
    private readonly List<InputCommand> _pending = [];
    private readonly IReadOnlyList<InputCommand> _pendingView;
    private int _mispredictions;
    private double _lastCorrection;

    public Predictor(ICollisionWorld collision)
    {
        _collision = collision ?? throw new ArgumentNullException(nameof(collision));
        _pendingView = _pending.AsReadOnly();
    }

    /// <summary>Apply one input now and retain an immutable-by-convention copy for replay.</summary>
    public void Predict(PlayerState player, InputCommand input)
    {
        ArgumentNullException.ThrowIfNull(player);
        ArgumentNullException.ThrowIfNull(input);

        Movement.StepMovement(player, input, _collision, input.Dt);
        _pending.Add(CloneInput(input));
        if (_pending.Count > GameConstants.InputBufferSize)
        {
            _pending.RemoveAt(0);
        }
    }

    /// <summary>
    /// Adopt the server's physical state and replay every input newer than its
    /// acknowledgement. View angles intentionally remain under the local mouse.
    /// </summary>
    public void Reconcile(PlayerState player, PlayerSnapshot authoritative, long ackedInput)
    {
        ArgumentNullException.ThrowIfNull(player);
        ArgumentNullException.ThrowIfNull(authoritative);

        var beforeX = player.Position.X;
        var beforeY = player.Position.Y;
        var beforeZ = player.Position.Z;

        player.Position.X = authoritative.X;
        player.Position.Y = authoritative.Y;
        player.Position.Z = authoritative.Z;
        player.Velocity.X = authoritative.Vx;
        player.Velocity.Y = authoritative.Vy;
        player.Velocity.Z = authoritative.Vz;
        player.OnGround = authoritative.OnGround;

        while (_pending.Count > 0 && _pending[0].Seq <= ackedInput)
        {
            _pending.RemoveAt(0);
        }

        foreach (var input in _pending)
        {
            Movement.StepMovement(player, input, _collision, input.Dt);
        }

        var dx = beforeX - player.Position.X;
        var dy = beforeY - player.Position.Y;
        var dz = beforeZ - player.Position.Z;
        _lastCorrection = Math.Sqrt(dx * dx + dy * dy + dz * dz);
        if (_lastCorrection > MispredictEpsilon)
        {
            _mispredictions++;
        }
    }

    public IReadOnlyList<InputCommand> Unacknowledged() => _pendingView;

    public void Reset()
    {
        _pending.Clear();
        _mispredictions = 0;
        _lastCorrection = 0d;
    }

    public PredictionStats Stats() => new(_pending.Count, _mispredictions, _lastCorrection);

    private static InputCommand CloneInput(InputCommand input) => new()
    {
        Seq = input.Seq,
        Tick = input.Tick,
        Dt = input.Dt,
        MoveForward = input.MoveForward,
        MoveRight = input.MoveRight,
        Yaw = input.Yaw,
        Pitch = input.Pitch,
        Buttons = input.Buttons,
        KillstreakSlot = input.KillstreakSlot,
    };
}

namespace OperationVanguard.Core;

/// <summary>
/// Holds a short, time-ordered snapshot history and samples remote players at the
/// deliberately delayed render time used by the web client.
/// </summary>
public sealed class SnapshotBuffer
{
    private const double HistorySeconds = 2d;

    private readonly List<Snapshot> _history = [];
    private double _latestServerTime;

    /// <summary>The newest snapshot by server time, or <see langword="null"/> when empty.</summary>
    public Snapshot? Latest => _history.Count == 0 ? null : _history[^1];

    public int Size => _history.Count;

    /// <summary>
    /// Insert a snapshot by server time. Out-of-order delivery is expected and
    /// equal-time snapshots retain their arrival order, matching Array.splice.
    /// </summary>
    public void Push(Snapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);

        var index = _history.Count;
        while (index > 0 && _history[index - 1].ServerTime > snapshot.ServerTime)
        {
            index--;
        }

        _history.Insert(index, snapshot);
        if (snapshot.ServerTime > _latestServerTime)
        {
            _latestServerTime = snapshot.ServerTime;
        }

        var cutoff = _latestServerTime - HistorySeconds;
        while (_history.Count > 2 && _history[0].ServerTime < cutoff)
        {
            _history.RemoveAt(0);
        }
    }

    /// <summary>
    /// Sample every player's transform at newest-server-time + advance minus the
    /// two-packet interpolation delay. Motion is never extrapolated.
    /// </summary>
    public IReadOnlyList<PlayerSnapshot> Sample(double advance = 0d)
    {
        if (_history.Count == 0)
        {
            return Array.Empty<PlayerSnapshot>();
        }

        var target = _latestServerTime + advance - GameConstants.Network.InterpolationDelay;
        Snapshot? older = null;
        Snapshot? newer = null;

        foreach (var snapshot in _history)
        {
            if (snapshot.ServerTime <= target)
            {
                older = snapshot;
            }
            else
            {
                newer = snapshot;
                break;
            }
        }

        // Before or after the retained history, use the nearest authoritative
        // frame instead of inventing motion.
        if (older is null)
        {
            return _history[0].Players;
        }

        if (newer is null)
        {
            return older.Players;
        }

        var span = newer.ServerTime - older.ServerTime;
        var amount = span > 1e-6d ? (target - older.ServerTime) / span : 0d;
        var newerById = new Dictionary<int, PlayerSnapshot>();
        foreach (var player in newer.Players)
        {
            // Map construction in the TypeScript source keeps the last value if
            // malformed input repeats an id; retain that behavior here too.
            newerById[player.Id] = player;
        }
        var output = new List<PlayerSnapshot>(Math.Max(older.Players.Count, newer.Players.Count));

        foreach (var before in older.Players)
        {
            if (!newerById.TryGetValue(before.Id, out var after))
            {
                // A player absent from the newer frame has left. Do not blend
                // them back into existence.
                continue;
            }

            output.Add(new PlayerSnapshot
            {
                Id = after.Id,
                Team = after.Team,
                Alive = after.Alive,
                OnGround = after.OnGround,
                IsBot = after.IsBot,
                Stance = after.Stance,
                MoveState = after.MoveState,
                X = Lerp(before.X, after.X, amount),
                Y = Lerp(before.Y, after.Y, amount),
                Z = Lerp(before.Z, after.Z, amount),
                Vx = Lerp(before.Vx, after.Vx, amount),
                Vy = Lerp(before.Vy, after.Vy, amount),
                Vz = Lerp(before.Vz, after.Vz, amount),
                Yaw = LerpAngle(before.Yaw, after.Yaw, amount),
                Pitch = Lerp(before.Pitch, after.Pitch, amount),
                Health = after.Health,
                WeaponSlot = after.WeaponSlot,
                Lean = Lerp(before.Lean, after.Lean, amount),
            });
        }

        // New joins and respawns that only exist in the newer frame are shown
        // immediately at that authoritative transform.
        var seen = output.Select(player => player.Id).ToHashSet();
        foreach (var player in newer.Players)
        {
            if (seen.Add(player.Id))
            {
                output.Add(player);
            }
        }

        return output;
    }

    public void Clear()
    {
        _history.Clear();
        _latestServerTime = 0d;
    }

    /// <summary>Interpolate angular values through the shortest arc.</summary>
    public static double LerpAngle(double a, double b, double amount)
    {
        var delta = b - a;
        while (delta > Math.PI)
        {
            delta -= Math.PI * 2d;
        }

        while (delta < -Math.PI)
        {
            delta += Math.PI * 2d;
        }

        return a + delta * amount;
    }

    private static double Lerp(double a, double b, double amount) => a + (b - a) * amount;
}

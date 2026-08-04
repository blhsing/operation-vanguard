namespace OperationVanguard.Core;

/// <summary>
/// Deterministic Mulberry32 pseudo-random number generator.
/// All arithmetic is explicitly unchecked uint arithmetic to match JavaScript
/// Math.imul and unsigned-right-shift behavior exactly.
/// </summary>
public sealed class Rng
{
    private const uint NonZeroFallback = 0x9e3779b9u;
    private const double UintRange = 4294967296d;

    private uint _state;

    public Rng(uint seed)
    {
        _state = seed == 0u ? NonZeroFallback : seed;
    }

    public Rng(int seed)
        : this(unchecked((uint)seed))
    {
    }

    public uint GetState() => _state;

    public void SetState(uint state)
    {
        _state = state == 0u ? NonZeroFallback : state;
    }

    public Rng Clone() => new(_state);

    /// <summary>Return a uniform value in [0, 1).</summary>
    public double Next()
    {
        unchecked
        {
            _state += 0x6d2b79f5u;
            var value = _state;
            value = (value ^ (value >> 15)) * (value | 1u);
            value ^= value + (value ^ (value >> 7)) * (value | 61u);
            return (value ^ (value >> 14)) / UintRange;
        }
    }

    public double Range(double minimum, double maximum) => minimum + Next() * (maximum - minimum);

    /// <summary>Return a uniform integer in the inclusive range [minimum, maximum].</summary>
    public int Int(int minimum, int maximum) =>
        (int)Math.Floor(Range(minimum, (double)maximum + 1d));

    public bool Chance(double probability) => Next() < probability;

    public double Signed(double magnitude = 1d) => (Next() * 2d - 1d) * magnitude;

    public T Pick<T>(IReadOnlyList<T> items)
    {
        if (items.Count == 0)
        {
            throw new InvalidOperationException("Rng.Pick: empty collection");
        }

        return items[Int(0, items.Count - 1)];
    }

    public T PickWeighted<T>(IReadOnlyList<T> items, IReadOnlyList<double> weights)
    {
        if (items.Count == 0)
        {
            throw new InvalidOperationException("Rng.PickWeighted: empty collection");
        }

        var total = 0d;
        for (var index = 0; index < weights.Count; index++)
        {
            total += Math.Max(0d, weights[index]);
        }

        if (total <= 0d)
        {
            return Pick(items);
        }

        var roll = Next() * total;
        for (var index = 0; index < items.Count; index++)
        {
            var weight = index < weights.Count ? weights[index] : 0d;
            roll -= Math.Max(0d, weight);
            if (roll <= 0d)
            {
                return items[index];
            }
        }

        return items[^1];
    }

    /// <summary>Shuffle a collection in place using Fisher-Yates.</summary>
    public IList<T> Shuffle<T>(IList<T> items)
    {
        for (var index = items.Count - 1; index > 0; index--)
        {
            var other = Int(0, index);
            (items[index], items[other]) = (items[other], items[index]);
        }

        return items;
    }

    /// <summary>Standard normal sample generated with the Box-Muller transform.</summary>
    public double Gaussian(double mean = 0d, double standardDeviation = 1d)
    {
        var first = Math.Max(Next(), 1e-12);
        var second = Next();
        var magnitude = Math.Sqrt(-2d * Math.Log(first));
        return mean + standardDeviation * magnitude * Math.Cos(2d * Math.PI * second);
    }

    /// <summary>Write a uniformly distributed point inside the unit disc.</summary>
    public Vec2 UnitDisc(Vec2 result)
    {
        var radius = Math.Sqrt(Next());
        var angle = Next() * Math.PI * 2d;
        result.X = radius * Math.Cos(angle);
        result.Y = radius * Math.Sin(angle);
        return result;
    }

    /// <summary>FNV-1a over UTF-16 code units, matching JavaScript charCodeAt.</summary>
    public static uint HashString(string value)
    {
        unchecked
        {
            var hash = 0x811c9dc5u;
            foreach (var codeUnit in value)
            {
                hash ^= codeUnit;
                hash *= 0x01000193u;
            }

            return hash;
        }
    }

    public static uint MixSeeds(params uint[] values)
    {
        unchecked
        {
            var hash = NonZeroFallback;
            foreach (var value in values)
            {
                hash ^= value;
                hash *= 0x85ebca6bu;
                hash ^= hash >> 13;
            }

            return hash;
        }
    }

    /// <summary>Presentation-only randomness. Never use this instance in simulation code.</summary>
    public static Rng Visual { get; } =
        new(unchecked((uint)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
}

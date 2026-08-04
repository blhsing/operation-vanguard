using OperationVanguard.Core;

namespace OperationVanguard.Tests;

public sealed class RngParityTests
{
    [Fact]
    public void Mulberry32SequencesMatchTheWebImplementationExactly()
    {
        foreach (var sequence in ParityFixture.Rng.GetProperty("sequences").EnumerateArray())
        {
            var random = new Rng(sequence.GetProperty("seed").GetUInt32());
            foreach (var sample in sequence.GetProperty("values").EnumerateArray())
            {
                Assert.Equal(sample.GetProperty("value").GetDouble(), random.Next());
                Assert.Equal(sample.GetProperty("state").GetUInt32(), random.GetState());
            }
        }
    }

    [Fact]
    public void GaussianAndUnitDiscSamplesStayNumericallyAligned()
    {
        foreach (var sequence in ParityFixture.Rng.GetProperty("sequences").EnumerateArray())
        {
            var seed = sequence.GetProperty("seed").GetUInt32();
            var gaussian = new Rng(seed);
            foreach (var expected in sequence.GetProperty("gaussian").EnumerateArray())
                Assert.Equal(expected.GetDouble(), gaussian.Gaussian(), 12);

            var disc = new Rng(seed);
            foreach (var expected in sequence.GetProperty("unitDisc").EnumerateArray())
            {
                var actual = disc.UnitDisc(new Vec2());
                Assert.Equal(expected.GetProperty("x").GetDouble(), actual.X, 12);
                Assert.Equal(expected.GetProperty("y").GetDouble(), actual.Y, 12);
            }
        }
    }

    [Fact]
    public void HashesAndMixedSeedsMatchJavaScriptUnsignedArithmetic()
    {
        foreach (var property in ParityFixture.Rng.GetProperty("hashes").EnumerateObject())
            Assert.Equal(property.Value.GetUInt32(), Rng.HashString(property.Name));

        foreach (var sample in ParityFixture.Rng.GetProperty("mixedSeeds").EnumerateArray())
        {
            var values = sample.GetProperty("values").EnumerateArray()
                .Select(value => value.GetUInt32()).ToArray();
            Assert.Equal(sample.GetProperty("result").GetUInt32(), Rng.MixSeeds(values));
        }
    }
}

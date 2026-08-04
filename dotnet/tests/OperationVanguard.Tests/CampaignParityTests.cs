using System.Text.Json;
using OperationVanguard.Core;

namespace OperationVanguard.Tests;

public sealed class CampaignParityTests
{
    [Fact]
    public void AllSixMissionGraphsMatchTheWebReferenceFieldForField()
    {
        var reference = ParityFixture.Content.GetProperty("campaign").EnumerateArray().ToArray();
        Assert.Equal(reference.Length, CampaignCatalog.CampaignMissions.Count);

        for (var index = 0; index < reference.Length; index++)
            AssertMission(reference[index], CampaignCatalog.CampaignMissions[index]);
    }

    [Fact]
    public void MissionsHaveACompleteOrderedRunAndARealEnd()
    {
        var seen = new List<string>();
        MissionDef? mission = CampaignCatalog.CampaignMissions[0];
        while (mission is not null)
        {
            seen.Add(mission.Id);
            mission = CampaignCatalog.NextMission(mission.Id);
            Assert.True(seen.Count <= CampaignCatalog.CampaignMissions.Count);
        }

        Assert.Equal(CampaignCatalog.MissionIds, seen);
        Assert.Null(CampaignCatalog.NextMission(CampaignCatalog.MissionIds[^1]));
    }

    private static void AssertMission(JsonElement expected, MissionDef actual)
    {
        Assert.Equal(expected.GetProperty("id").GetString(), actual.Id);
        Assert.Equal(expected.GetProperty("name").GetString(), actual.Name);
        Assert.Equal(expected.GetProperty("mapId").GetString(), actual.MapId);
        Assert.Equal(expected.GetProperty("brief").GetString(), actual.Brief);
        Assert.Equal(expected.GetProperty("outro").GetString(), actual.Outro);
        Assert.Equal(expected.GetProperty("difficulty").GetString(), CampaignContentIds.GetDifficultyId(actual.Difficulty));
        AssertVector(expected.GetProperty("insertion").GetProperty("position"), actual.Insertion.Position);
        Assert.Equal(expected.GetProperty("insertion").GetProperty("yaw").GetDouble(), actual.Insertion.Yaw);

        var expectedAllies = expected.GetProperty("allies").EnumerateArray().ToArray();
        Assert.Equal(expectedAllies.Length, actual.Allies.Count);
        for (var index = 0; index < expectedAllies.Length; index++)
        {
            var ally = expectedAllies[index];
            var port = actual.Allies[index];
            Assert.Equal(ally.GetProperty("id").GetString(), port.Id);
            Assert.Equal(ally.GetProperty("name").GetString(), port.Name);
            AssertVector(ally.GetProperty("spawn"), port.Spawn);
            Assert.Equal(ally.GetProperty("archetype").GetString(), CampaignContentIds.GetBotArchetypeId(port.Archetype));
            Assert.Equal(GetBooleanOrDefault(ally, "essential"), port.Essential);
        }

        AssertWaves(expected, "garrison", actual.Garrison);
        var expectedObjectives = expected.GetProperty("objectives").EnumerateArray().ToArray();
        Assert.Equal(expectedObjectives.Length, actual.Objectives.Count);
        for (var index = 0; index < expectedObjectives.Length; index++)
            AssertObjective(expectedObjectives[index], actual.Objectives[index]);
    }

    private static void AssertObjective(JsonElement expected, Objective actual)
    {
        Assert.Equal(expected.GetProperty("id").GetString(), actual.Id);
        Assert.Equal(expected.GetProperty("label").GetString(), actual.Label);
        AssertNullableString(expected, "line", actual.Line);
        Assert.Equal(GetBooleanOrDefault(expected, "checkpoint"), actual.Checkpoint);
        Assert.Equal(GetBooleanOrDefault(expected, "reapOnComplete"), actual.ReapOnComplete);
        AssertNullableDouble(expected, "timeLimit", actual.TimeLimit);

        var expectedAfter = expected.TryGetProperty("after", out var after)
            ? after.EnumerateArray().Select(item => item.GetString()).ToArray()
            : null;
        Assert.Equal(expectedAfter, actual.After?.Cast<string?>().ToArray());
        AssertWaves(expected, "waves", actual.Waves);
        AssertTrigger(expected.GetProperty("trigger"), actual.Trigger);
    }

    private static void AssertTrigger(JsonElement expected, Trigger actual)
    {
        var kind = expected.GetProperty("kind").GetString();
        Assert.Equal(kind, actual.Kind);
        switch (actual)
        {
            case ReachTrigger reach:
                AssertZone(expected.GetProperty("zone"), reach.Zone);
                break;
            case EliminateTrigger eliminate:
                Assert.Equal(expected.GetProperty("count").GetInt32(), eliminate.Count);
                break;
            case ClearTrigger:
                break;
            case SurviveTrigger survive:
                Assert.Equal(expected.GetProperty("seconds").GetDouble(), survive.Seconds);
                break;
            case HoldTrigger hold:
                AssertZone(expected.GetProperty("zone"), hold.Zone);
                Assert.Equal(expected.GetProperty("seconds").GetDouble(), hold.Seconds);
                break;
            case InteractTrigger interact:
                AssertZone(expected.GetProperty("zone"), interact.Zone);
                Assert.Equal(expected.GetProperty("seconds").GetDouble(), interact.Seconds);
                Assert.Equal(expected.GetProperty("verb").GetString(), interact.Verb);
                break;
            case EscortTrigger escort:
                Assert.Equal(expected.GetProperty("ally").GetString(), escort.Ally);
                AssertZone(expected.GetProperty("zone"), escort.Zone);
                break;
            default:
                Assert.Fail($"Unhandled trigger type {actual.GetType().Name}");
                break;
        }
    }

    private static void AssertWaves(JsonElement owner, string propertyName, IReadOnlyList<Wave>? actual)
    {
        if (!owner.TryGetProperty(propertyName, out var property))
        {
            Assert.Null(actual);
            return;
        }

        var expected = property.EnumerateArray().ToArray();
        Assert.NotNull(actual);
        Assert.Equal(expected.Length, actual.Count);
        for (var index = 0; index < expected.Length; index++)
        {
            var wave = expected[index];
            var port = actual[index];
            AssertVector(wave.GetProperty("spawn"), port.Spawn);
            Assert.Equal(wave.GetProperty("count").GetInt32(), port.Count);
            Assert.Equal(wave.GetProperty("interval").GetDouble(), port.Interval);
            AssertNullableDouble(wave, "delay", port.Delay);
            Assert.Equal(GetBooleanOrDefault(wave, "endless"), port.Endless);
            if (wave.TryGetProperty("post", out var post)) AssertVector(post, Assert.IsType<Vec3>(port.Post));
            else Assert.Null(port.Post);

            var archetypes = wave.TryGetProperty("archetypes", out var list)
                ? list.EnumerateArray().Select(item => item.GetString()).ToArray()
                : null;
            var portArchetypes = port.Archetypes?.Select(CampaignContentIds.GetBotArchetypeId).Cast<string?>().ToArray();
            Assert.Equal(archetypes, portArchetypes);
        }
    }

    private static void AssertZone(JsonElement expected, Zone actual)
    {
        AssertVector(expected.GetProperty("center"), actual.Center);
        AssertVector(expected.GetProperty("size"), actual.Size);
    }

    private static void AssertVector(JsonElement expected, Vec3 actual)
    {
        Assert.Equal(expected.GetProperty("x").GetDouble(), actual.X);
        Assert.Equal(expected.GetProperty("y").GetDouble(), actual.Y);
        Assert.Equal(expected.GetProperty("z").GetDouble(), actual.Z);
    }

    private static void AssertNullableString(JsonElement owner, string propertyName, string? actual)
    {
        if (owner.TryGetProperty(propertyName, out var property)) Assert.Equal(property.GetString(), actual);
        else Assert.Null(actual);
    }

    private static void AssertNullableDouble(JsonElement owner, string propertyName, double? actual)
    {
        if (owner.TryGetProperty(propertyName, out var property)) Assert.Equal(property.GetDouble(), actual);
        else Assert.Null(actual);
    }

    private static bool GetBooleanOrDefault(JsonElement owner, string propertyName) =>
        owner.TryGetProperty(propertyName, out var property) && property.GetBoolean();
}

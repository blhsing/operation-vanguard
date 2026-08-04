using OperationVanguard.Core;
using System.Text.Json;

namespace OperationVanguard.Tests;

public sealed class ZombieDataTests
{
    [Fact]
    public void CrossfireLayoutContainsEveryAuthoredEconomyElement()
    {
        var map = ZombieMaps.Get("crossfire");

        Assert.Equal(4, map.PlayerSpawns.Count);
        Assert.Equal(5, map.Zones.Count);
        Assert.Equal(18, map.Interactables.Count);
        Assert.Single(map.Interactables, value => value.Kind == InteractKind.MysteryBox);
        Assert.Single(map.Interactables, value => value.Kind == InteractKind.PackAPunch);
        Assert.Single(map.Interactables, value => value.Kind == InteractKind.Power);
        Assert.Equal(5, map.Interactables.Count(value => value.Kind == InteractKind.PerkMachine));
        Assert.Equal("p226", map.StartingWeapon);
        Assert.Equal(500, map.StartingPoints);
    }

    [Fact]
    public void RoundCurveEscalatesHealthAndCapsSpeed()
    {
        var previous = 0;
        foreach (var round in new[] { 1, 5, 10, 15, 20, 30 })
        {
            var health = ZombieData.HealthForRound(round);
            Assert.True(health > previous, $"round {round} health should increase");
            previous = health;
        }

        Assert.Equal(ZombieData.RoundCurve.MaximumSpeed, ZombieData.SpeedForRound(50));
        Assert.True(ZombieData.CountForRound(5, 4) > ZombieData.CountForRound(5, 1));
        Assert.True(ZombieData.CountForRound(10, 1) > ZombieData.CountForRound(1, 1));
    }

    [Fact]
    public void EconomyAndPerkTablesMatchTheAuthoredContract()
    {
        Assert.Equal(5, ZombieData.Perks.Count);
        Assert.Equal(4, ZombieData.MaximumPerks);
        Assert.Equal(950, ZombieData.MysteryBoxCost);
        Assert.Equal(5000, ZombieData.PackAPunchCost);
        Assert.True(ZombieData.Points.Kill > ZombieData.Points.Hit);
        Assert.True(ZombieData.Points.HeadshotKill > ZombieData.Points.Kill);
        Assert.True(ZombieData.Points.MeleeKill > ZombieData.Points.HeadshotKill);
        Assert.Equal(2.5, ZombieData.Perks["juggernog"].HealthMultiplier);
    }

    [Fact]
    public void NativeZombieContentMatchesTheWebFixtureFieldForField()
    {
        var fixture = ParityFixture.Content.GetProperty("zombies");
        var expectedMap = fixture.GetProperty("maps").GetProperty("crossfire");
        var actualMap = ZombieMaps.Crossfire;
        Assert.Equal(expectedMap.GetProperty("mapId").GetString(), actualMap.MapId);
        Assert.Equal(expectedMap.GetProperty("startingWeapon").GetString(), actualMap.StartingWeapon);
        Assert.Equal(expectedMap.GetProperty("startingPistol").GetString(), actualMap.StartingPistol);
        Assert.Equal(expectedMap.GetProperty("startingPoints").GetInt32(), actualMap.StartingPoints);
        AssertVectors(expectedMap.GetProperty("playerSpawns"), actualMap.PlayerSpawns);

        var expectedZones = expectedMap.GetProperty("zones").EnumerateArray().ToArray();
        Assert.Equal(expectedZones.Length, actualMap.Zones.Count);
        for (var index = 0; index < expectedZones.Length; index++)
        {
            var expected = expectedZones[index];
            var actual = actualMap.Zones[index];
            Assert.Equal(expected.GetProperty("id").GetString(), actual.Id);
            Assert.Equal(expected.GetProperty("name").GetString(), actual.Name);
            Assert.Equal(expected.TryGetProperty("startingZone", out var starting) && starting.GetBoolean(),
                actual.StartingZone);
            AssertVectors(expected.GetProperty("spawnPoints"), actual.SpawnPoints);
        }

        var expectedInteractables = expectedMap.GetProperty("interactables").EnumerateArray().ToArray();
        Assert.Equal(expectedInteractables.Length, actualMap.Interactables.Count);
        for (var index = 0; index < expectedInteractables.Length; index++)
        {
            var expected = expectedInteractables[index];
            var actual = actualMap.Interactables[index];
            Assert.Equal(expected.GetProperty("id").GetString(), actual.Id);
            Assert.Equal(expected.GetProperty("kind").GetString(), InteractKindId(actual.Kind));
            AssertVector(expected.GetProperty("position"), actual.Position);
            Assert.Equal(expected.GetProperty("yaw").GetDouble(), actual.Yaw);
            Assert.Equal(expected.GetProperty("cost").GetInt32(), actual.Cost);
            Assert.Equal(expected.GetProperty("zone").GetString(), actual.Zone);
            Assert.Equal(OptionalString(expected, "opensZone"), actual.OpensZone);
            Assert.Equal(OptionalString(expected, "weaponId"), actual.WeaponId);
            Assert.Equal(OptionalInt(expected, "ammoCost"), actual.AmmoCost);
            Assert.Equal(OptionalString(expected, "perkId"), actual.PerkId);
            Assert.Equal(expected.TryGetProperty("requiresPower", out var power) && power.GetBoolean(),
                actual.RequiresPower);
            Assert.Equal(expected.GetProperty("label").GetString(), actual.Label);
        }

        Assert.Equal(ZombieData.MaximumPerks, fixture.GetProperty("maxPerks").GetInt32());
        Assert.Equal(ZombieData.MysteryBoxCost, fixture.GetProperty("mysteryBoxCost").GetInt32());
        Assert.Equal(ZombieData.PackAPunchCost, fixture.GetProperty("packAPunchCost").GetInt32());
        Assert.Equal(ZombieData.WallAmmoMagazines, fixture.GetProperty("wallAmmoMags").GetInt32());

        var expectedPerks = fixture.GetProperty("perks");
        Assert.Equal(expectedPerks.EnumerateObject().Count(), ZombieData.Perks.Count);
        foreach (var pair in ZombieData.Perks)
        {
            var expected = expectedPerks.GetProperty(pair.Key);
            var actual = pair.Value;
            Assert.Equal(expected.GetProperty("id").GetString(), actual.Id);
            Assert.Equal(expected.GetProperty("name").GetString(), actual.Name);
            Assert.Equal(expected.GetProperty("cost").GetInt32(), actual.Cost);
            Assert.Equal(expected.GetProperty("description").GetString(), actual.Description);
            Assert.Equal(OptionalDouble(expected, "healthMult"), actual.HealthMultiplier);
            Assert.Equal(OptionalDouble(expected, "reloadMult"), actual.ReloadMultiplier);
            Assert.Equal(OptionalDouble(expected, "fireRateMult"), actual.FireRateMultiplier);
            Assert.Equal(OptionalDouble(expected, "speedMult"), actual.SpeedMultiplier);
            Assert.Equal(OptionalDouble(expected, "reviveMult"), actual.ReviveMultiplier);
            Assert.Equal(expected.TryGetProperty("selfRevive", out var self) && self.GetBoolean(),
                actual.SelfRevive);
            Assert.Equal(expected.GetProperty("colour").GetInt32(), actual.Color);
        }
    }

    private static void AssertVectors(JsonElement expected, IReadOnlyList<Vec3> actual)
    {
        var values = expected.EnumerateArray().ToArray();
        Assert.Equal(values.Length, actual.Count);
        for (var index = 0; index < values.Length; index++) AssertVector(values[index], actual[index]);
    }

    private static void AssertVector(JsonElement expected, Vec3 actual)
    {
        Assert.Equal(expected.GetProperty("x").GetDouble(), actual.X);
        Assert.Equal(expected.GetProperty("y").GetDouble(), actual.Y);
        Assert.Equal(expected.GetProperty("z").GetDouble(), actual.Z);
    }

    private static string? OptionalString(JsonElement value, string name) =>
        value.TryGetProperty(name, out var property) ? property.GetString() : null;

    private static int? OptionalInt(JsonElement value, string name) =>
        value.TryGetProperty(name, out var property) ? property.GetInt32() : null;

    private static double? OptionalDouble(JsonElement value, string name) =>
        value.TryGetProperty(name, out var property) ? property.GetDouble() : null;

    private static string InteractKindId(InteractKind kind) => kind switch
    {
        InteractKind.Door => "door",
        InteractKind.WallBuy => "wall_buy",
        InteractKind.MysteryBox => "mystery_box",
        InteractKind.PackAPunch => "pack_a_punch",
        InteractKind.PerkMachine => "perk_machine",
        InteractKind.Power => "power",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, null),
    };
}

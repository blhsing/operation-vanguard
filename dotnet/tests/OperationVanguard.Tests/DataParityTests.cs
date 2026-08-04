using OperationVanguard.Core;

namespace OperationVanguard.Tests;

/// <summary>
/// Ports every contract in web/tests/data.test.ts. Keep these tests grouped by
/// the source suite so future data changes must remain valid in both runtimes.
/// </summary>
public sealed class DataParityTests
{
    private const double Health = 100d;

    private static readonly double[] DamageSampleDistances =
        [0d, 5d, 10d, 20d, 30d, 50d, 80d, 150d];

    private static readonly IReadOnlyDictionary<WeaponClass, string> FixtureClassNames =
        new Dictionary<WeaponClass, string>
        {
            [WeaponClass.AssaultRifle] = "assault_rifle",
            [WeaponClass.SubmachineGun] = "smg",
            [WeaponClass.LightMachineGun] = "lmg",
            [WeaponClass.SniperRifle] = "sniper",
            [WeaponClass.MarksmanRifle] = "marksman",
            [WeaponClass.Shotgun] = "shotgun",
            [WeaponClass.Pistol] = "pistol",
            [WeaponClass.Launcher] = "launcher",
            [WeaponClass.Melee] = "melee",
            [WeaponClass.Special] = "special",
        };

    [Fact]
    public void ArsenalPassesItsOwnBalanceValidationWithZeroViolations()
    {
        var errors = WeaponData.ValidateArsenal();

        Assert.True(errors.Count == 0, string.Join(Environment.NewLine, errors));
    }

    [Fact]
    public void ArsenalHasFullCoverageAndExactClassRegistryMembership()
    {
        string[] canonicalWebOrder =
        [
            "vk47", "m5a1", "gr63", "ks12", "aug77", "fr55", "sa58",
            "mp9k", "vector9", "pk10", "skorp", "thompson", "p90x",
            "m60e", "rpd74", "mg42x", "lw90",
            "r700t", "dsr50", "svk12", "sp96",
            "dmr14", "mk18", "ebr7",
            "m870", "sx12", "aa9",
            "p226", "gs17", "mp5c", "r45",
            "rpg9", "stinger", "gl40",
            "combat_knife", "riot_shield",
        ];

        Assert.True(WeaponData.WeaponIds.Count >= 32);
        Assert.True(WeaponData.WeaponsByClass[WeaponClass.AssaultRifle].Count >= 6);
        Assert.True(WeaponData.WeaponsByClass[WeaponClass.SubmachineGun].Count >= 5);
        Assert.True(WeaponData.WeaponsByClass[WeaponClass.LightMachineGun].Count >= 3);
        Assert.True(WeaponData.WeaponsByClass[WeaponClass.SniperRifle].Count >= 3);
        Assert.True(WeaponData.WeaponsByClass[WeaponClass.Shotgun].Count >= 3);
        Assert.True(WeaponData.WeaponsByClass[WeaponClass.Pistol].Count >= 3);
        Assert.True(WeaponData.WeaponsByClass[WeaponClass.Launcher].Count >= 2);
        Assert.True(WeaponData.WeaponsByClass[WeaponClass.Melee].Count >= 2);
        Assert.Equal(canonicalWebOrder, WeaponData.WeaponIds);
        Assert.Equal(canonicalWebOrder, WeaponData.All.Select(weapon => weapon.Id));
        Assert.Equal(canonicalWebOrder, WeaponData.Weapons.Keys);

        var fixtureWeapons = ParityFixture.Content.GetProperty("weapons");
        foreach (var weaponClass in Enum.GetValues<WeaponClass>())
        {
            var expected = fixtureWeapons.EnumerateObject()
                .Where(property =>
                    property.Value.GetProperty("class").GetString() == FixtureClassNames[weaponClass])
                .Select(property => property.Name)
                .Order(StringComparer.Ordinal)
                .ToArray();
            var actual = WeaponData.WeaponsByClass[weaponClass]
                .Select(weapon => weapon.Id)
                .Order(StringComparer.Ordinal)
                .ToArray();

            Assert.Equal(expected, actual);
        }

        Assert.Equal(
            WeaponData.All.Select(weapon => weapon.Id).Order(StringComparer.Ordinal),
            WeaponData.WeaponsByClass.Values.SelectMany(weapons => weapons)
                .Select(weapon => weapon.Id)
                .Order(StringComparer.Ordinal));
        foreach (var weapon in WeaponData.All)
        {
            Assert.Same(weapon, WeaponData.Weapons[weapon.Id]);
            Assert.Same(weapon, WeaponData.GetWeapon(weapon.Id));
        }
    }

    [Fact]
    public void DefaultWeaponsExistAndAreUnlockedAtRankZero()
    {
        Assert.Equal(0, WeaponData.GetWeapon(WeaponData.DefaultPrimary).UnlockLevel);
        Assert.Equal(0, WeaponData.GetWeapon(WeaponData.DefaultSecondary).UnlockLevel);
    }

    [Fact]
    public void HeadshotsNeverNeedMoreHitsThanBodyShots()
    {
        foreach (var weapon in WeaponData.Weapons.Values)
        {
            if (weapon.Class is WeaponClass.Melee or WeaponClass.Launcher)
                continue;

            var bodyShots = WeaponMath.ShotsToKill(weapon.Damage, 10d, Health);
            var headShots = WeaponMath.ShotsToKill(
                weapon.Damage,
                10d,
                Health,
                GameConstants.HitMultiplier.Head);

            Assert.True(
                headShots <= bodyShots,
                $"{weapon.Id} headshots require {headShots} hits versus {bodyShots} body hits.");
        }
    }

    [Fact]
    public void SmgsDominateUpCloseAndAssaultRiflesDominateAtRange()
    {
        var bestSmgClose = BestTimeToKill(WeaponClass.SubmachineGun, 8d);
        var bestArClose = BestTimeToKill(WeaponClass.AssaultRifle, 8d);
        var bestSmgFar = BestTimeToKill(WeaponClass.SubmachineGun, 35d);
        var bestArFar = BestTimeToKill(WeaponClass.AssaultRifle, 35d);

        Assert.True(
            bestSmgClose < bestArClose,
            $"Best SMG close TTK {bestSmgClose} must beat AR {bestArClose}.");
        Assert.True(
            bestArFar < bestSmgFar,
            $"Best AR far TTK {bestArFar} must beat SMG {bestSmgFar}.");
    }

    [Fact]
    public void WeaponDamageNeverIncreasesAtLongerRange()
    {
        foreach (var weapon in WeaponData.Weapons.Values)
        {
            var previous = double.PositiveInfinity;
            foreach (var distance in DamageSampleDistances)
            {
                var damage = WeaponMath.DamageAtRange(weapon.Damage, distance);
                Assert.True(
                    damage <= previous + 1e-6,
                    $"{weapon.Id} damage rose from {previous} to {damage} at {distance}m.");
                previous = damage;
            }
        }
    }

    [Fact]
    public void EveryWeaponHasASaneDerivedFireInterval()
    {
        foreach (var weapon in WeaponData.Weapons.Values)
        {
            var interval = WeaponMath.FireInterval(weapon);
            Assert.True(interval > 0d, $"{weapon.Id} interval must be positive, got {interval}.");
            Assert.True(interval >= 0.03d, $"{weapon.Id} exceeds 2,000 RPM: {interval}s.");
            Assert.True(interval <= 3d, $"{weapon.Id} cycles slower than three seconds: {interval}s.");
        }
    }

    [Fact]
    public void EveryWeaponHasAUsableMagazineAndReserve()
    {
        foreach (var weapon in WeaponData.Weapons.Values)
        {
            Assert.True(weapon.MagSize > 0, $"{weapon.Id} has no usable magazine.");
            Assert.True(weapon.StartingReserve >= 0, $"{weapon.Id} has a negative starting reserve.");
            Assert.True(
                weapon.MaxReserve >= weapon.StartingReserve,
                $"{weapon.Id} max reserve {weapon.MaxReserve} is below starting reserve {weapon.StartingReserve}.");
        }
    }

    [Fact]
    public void WeaponUnlocksAreSpreadAcrossRankProgression()
    {
        var levels = WeaponData.Weapons.Values.Select(weapon => weapon.UnlockLevel).ToArray();
        var lockedAtStart = levels.Count(level => level > 0);

        Assert.Equal(0, levels.Min());
        Assert.True(levels.Max() > 40);
        Assert.True(
            (double)lockedAtStart / levels.Length > 0.33d,
            $"Only {lockedAtStart} of {levels.Length} weapons are locked at rank zero.");
    }

    [Fact]
    public void EveryWeaponHasProceduralAudioAndModelParameters()
    {
        foreach (var weapon in WeaponData.Weapons.Values)
        {
            Assert.True(weapon.Audio.BodyFreq > 20d, $"{weapon.Id} body frequency is invalid.");
            Assert.True(weapon.Audio.CrackDuration > 0d, $"{weapon.Id} crack duration is invalid.");
            Assert.True(weapon.Model.Length > 0.1d, $"{weapon.Id} model length is invalid.");
            Assert.True(weapon.Model.BarrelLength > 0d, $"{weapon.Id} barrel length is invalid.");
        }
    }

    [Fact]
    public void MapsRegisterCanonicalWebOrderAndExactFixtureMembership()
    {
        string[] canonicalWebOrder =
            ["crossfire", "refinery", "shipment_yard", "highrise", "dust_market", "subway"];
        var fixtureIds = ParityFixture.Content.GetProperty("maps").EnumerateObject()
            .Select(property => property.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.NotEmpty(Maps.Ids);
        Assert.Equal(canonicalWebOrder, Maps.Ids);
        Assert.Equal(canonicalWebOrder, Maps.All.Select(map => map.Id));
        Assert.Equal(fixtureIds, Maps.Ids.Order(StringComparer.Ordinal));

        foreach (var map in Maps.All)
        {
            Assert.Same(map, Maps.Get(map.Id));
            Assert.True(Maps.TryGet(map.Id, out var found));
            Assert.Same(map, found);
        }
    }

    [Fact]
    public void EveryRegisteredMapPassesStructuralValidation()
    {
        var failures = Maps.All
            .Select(map =>
            {
                var errors = Maps.ValidateStructure(map).Concat(ValidateSpawnCollision(map)).ToArray();
                return (map.Id, Errors: (IReadOnlyList<string>)errors);
            })
            .Where(result => result.Errors.Count > 0)
            .ToArray();

        Assert.True(
            failures.Length == 0,
            string.Join(
                Environment.NewLine,
                failures.Select(failure => $"{failure.Id}: {string.Join("; ", failure.Errors)}")));
    }

    [Fact]
    public void EveryMapHasDenseGeometryAndEnoughSpawnAndCoverPoints()
    {
        foreach (var id in Maps.Ids)
        {
            var map = Maps.Get(id);
            var area = (map.Bounds.Max.X - map.Bounds.Min.X) *
                       (map.Bounds.Max.Z - map.Bounds.Min.Z);
            var squareMetresPerBrush = area / Math.Max(1, map.Brushes.Count);

            Assert.True(
                squareMetresPerBrush < 60d,
                $"{id} is too sparse ({squareMetresPerBrush:F0} square metres per brush).");
            Assert.True(map.Spawns.Count >= 30, $"{id} has only {map.Spawns.Count} spawns.");
            Assert.True(
                map.CoverPoints.Count >= 20,
                $"{id} has only {map.CoverPoints.Count} cover points.");
        }
    }

    [Fact]
    public void EveryMapHasBalancedSpawnPoolsForBothTeamsAndFreeForAll()
    {
        foreach (var id in Maps.Ids)
        {
            var map = Maps.Get(id);
            var allies = map.Spawns.Count(spawn => spawn.Team == Team.Allies);
            var axis = map.Spawns.Count(spawn => spawn.Team == Team.Axis);
            var freeForAll = map.Spawns.Count(spawn => spawn.Team == Team.None);

            Assert.True(allies >= 12, $"{id} has only {allies} Allied spawns.");
            Assert.True(axis >= 12, $"{id} has only {axis} Axis spawns.");
            Assert.True(freeForAll >= 8, $"{id} has only {freeForAll} free-for-all spawns.");
            Assert.True(
                Math.Abs(allies - axis) <= 4,
                $"{id} spawn pools are lopsided: {allies} Allied versus {axis} Axis.");
        }
    }

    [Fact]
    public void EveryMapDescribesUsableLanes()
    {
        foreach (var id in Maps.Ids)
        {
            var map = Maps.Get(id);
            Assert.True(map.Lanes.Count >= 2, $"{id} has only {map.Lanes.Count} lanes.");

            foreach (var lane in map.Lanes)
            {
                Assert.True(
                    lane.Path.Count >= 2,
                    $"{id}/{lane.Name} has only {lane.Path.Count} waypoints.");
                Assert.True(lane.Width > 0d, $"{id}/{lane.Name} has non-positive width {lane.Width}.");
            }
        }
    }

    [Fact]
    public void EveryMapSupportsDominationSearchAndDestroyAndHardpoint()
    {
        foreach (var id in Maps.Ids)
        {
            var kinds = Maps.Get(id).Objectives.Select(objective => objective.Kind).ToHashSet();
            Assert.True(kinds.Contains(ObjectiveKind.DominationFlag), $"{id} needs Domination flags.");
            Assert.True(kinds.Contains(ObjectiveKind.BombSite), $"{id} needs bomb sites.");
            Assert.True(kinds.Contains(ObjectiveKind.Hardpoint), $"{id} needs Hardpoint zones.");
        }
    }

    [Fact]
    public void BrokenMapReturnsExactProblemsInsteadOfThrowing()
    {
        var broken = BrokenCopyOf(Maps.Get(Maps.Ids[0]));

        var exception = Record.Exception(() => Maps.ValidateStructure(broken));
        Assert.Null(exception);

        var errors = Maps.ValidateStructure(broken);
        Assert.Equal(
            [
                "broken: only 0 Allied spawns, want at least 8",
                "broken: only 0 Axis spawns, want at least 8",
                "broken: only 0 neutral spawns for free-for-all, want 4+",
                "broken: needs at least 2 lanes to describe its layout",
                "broken: only 0 cover points — bots will look lost with fewer than 20",
            ],
            errors);
        Assert.All(errors, error => Assert.IsType<string>(error));
    }

    [Fact]
    public void EveryRegisteredMapBuildsACollisionWorldAndResolvesThroughRegistry()
    {
        foreach (var id in Maps.Ids)
        {
            var map = Maps.Get(id);
            var exception = Record.Exception(() => new BrushCollisionWorld(map.Brushes, map.Bounds));

            Assert.Null(exception);
            Assert.Contains(id, Maps.Ids);
            Assert.Same(map, Maps.Get(id));
        }
    }

    private static double BestTimeToKill(WeaponClass weaponClass, double distance) =>
        WeaponData.WeaponsByClass[weaponClass]
            .Min(weapon => WeaponMath.TimeToKill(weapon, distance, Health));

    private static IReadOnlyList<string> ValidateSpawnCollision(MapDef map)
    {
        if (map.Brushes.Count == 0 ||
            map.Bounds.Min.X >= map.Bounds.Max.X ||
            map.Bounds.Min.Z >= map.Bounds.Max.Z)
        {
            return [];
        }

        var errors = new List<string>();
        var collision = new BrushCollisionWorld(map.Brushes, map.Bounds);
        var movement = new QueryFilter(CollisionLayer.Movement);
        var sight = new QueryFilter(CollisionLayer.Sight);

        foreach (var spawn in map.Spawns)
        {
            var groundY = collision.GroundHeightAt(
                spawn.Position.X,
                spawn.Position.Z,
                spawn.Position.Y + 3d,
                12d);
            if (!double.IsFinite(groundY))
            {
                errors.Add($"{map.Id}: spawn '{spawn.Group}' has no ground beneath it");
                continue;
            }

            var feet = new Vec3(spawn.Position.X, groundY + 0.05d, spawn.Position.Z);
            if (!collision.IsCapsuleFree(
                    feet,
                    GameConstants.StanceHeight.Stand,
                    GameConstants.PlayerRadius,
                    movement))
            {
                errors.Add($"{map.Id}: spawn '{spawn.Group}' is inside geometry");
            }

            var eye = new Vec3(spawn.Position.X, groundY + 1.6d, spawn.Position.Z);
            var forward = MathEx.AnglesToForward(new Vec3(), spawn.Yaw, 0d);
            var hit = collision.Raycast(eye, forward, 2d, sight, new RaycastHit());
            if (hit.Hit)
            {
                errors.Add(
                    $"{map.Id}: spawn '{spawn.Group}' faces a wall {hit.Distance:F1}m away");
            }
        }

        return errors;
    }

    private static MapDef BrokenCopyOf(MapDef source) => new()
    {
        Id = "broken",
        Name = source.Name,
        Tagline = source.Tagline,
        Description = source.Description,
        PlayerCount = [.. source.PlayerCount],
        Bounds = source.Bounds,
        OutOfBoundsGrace = source.OutOfBoundsGrace,
        Brushes = source.Brushes,
        Lighting = source.Lighting,
        Spawns = [],
        Objectives = [],
        NavLinks = source.NavLinks,
        CoverPoints = [],
        Lanes = [],
        Ambience = source.Ambience,
        SupportedModes = source.SupportedModes is null ? null : [.. source.SupportedModes],
    };
}

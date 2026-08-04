namespace OperationVanguard.Core;

public sealed class HitboxHit
{
    public bool Hit { get; set; }
    public HitLocation Location { get; set; } = HitLocation.Chest;
    public double Distance { get; set; }
    public Vec3 Point { get; set; } = new();
}

public sealed class PlayerHitbox
{
    public HitLocation Location { get; set; }
    public Aabb Box { get; set; } = new();
}

public sealed class RecoilImpulse
{
    public double Pitch { get; set; }
    public double Yaw { get; set; }
}

public sealed class TraceResult
{
    public bool HitPlayer { get; set; }
    public int Victim { get; set; }
    public HitLocation Location { get; set; } = HitLocation.Chest;
    public double Damage { get; set; }
    public Vec3 Point { get; set; } = new();
    public Vec3 Normal { get; set; } = new(0d, 1d, 0d);
    public SurfaceType Surface { get; set; } = SurfaceType.Concrete;
    public double Distance { get; set; }
    public int Penetrations { get; set; }
    public bool HitAnything { get; set; }
    public int HitEntity { get; set; }
}

public sealed class DamageResult
{
    public double Applied { get; set; }
    public bool Killed { get; set; }
    public double Health { get; set; }
    public double Absorbed { get; set; }
}

public sealed class ExplosionTarget
{
    public PlayerState Player { get; set; } = null!;
    public double Damage { get; set; }
    public Vec3 Direction { get; set; } = new();
    public double Distance { get; set; }
}

/// <summary>Ballistics, hit registration, direct damage, explosions, and melee targeting.</summary>
public static class Combat
{
    public const double MeleeRange = 2.4d;
    public static readonly double MeleeHalfAngle = Math.Cos(0.62d);

    private const int MaximumPenetrations = 3;

    private sealed class HitboxDefinition
    {
        public HitLocation Location { get; init; }
        public double Right { get; init; }
        public double UpFraction { get; init; }
        public double Forward { get; init; }
        public double SizeX { get; init; }
        public double SizeYFraction { get; init; }
        public double SizeZ { get; init; }
    }

    private static readonly HitboxDefinition[] Hitboxes =
    [
        Hitbox(HitLocation.Head, 0d, 0.935d, 0.02d, 0.22d, 0.13d, 0.24d),
        Hitbox(HitLocation.Neck, 0d, 0.845d, 0d, 0.16d, 0.055d, 0.16d),
        Hitbox(HitLocation.Chest, 0d, 0.71d, 0d, 0.46d, 0.2d, 0.28d),
        Hitbox(HitLocation.Stomach, 0d, 0.545d, 0d, 0.4d, 0.14d, 0.26d),
        Hitbox(HitLocation.UpperArm, 0.3d, 0.72d, 0d, 0.16d, 0.18d, 0.18d),
        Hitbox(HitLocation.UpperArm, -0.3d, 0.72d, 0d, 0.16d, 0.18d, 0.18d),
        Hitbox(HitLocation.LowerArm, 0.32d, 0.55d, 0.06d, 0.14d, 0.15d, 0.16d),
        Hitbox(HitLocation.LowerArm, -0.32d, 0.55d, 0.06d, 0.14d, 0.15d, 0.16d),
        Hitbox(HitLocation.UpperLeg, 0.13d, 0.36d, 0d, 0.2d, 0.22d, 0.22d),
        Hitbox(HitLocation.UpperLeg, -0.13d, 0.36d, 0d, 0.2d, 0.22d, 0.22d),
        Hitbox(HitLocation.LowerLeg, 0.13d, 0.14d, 0d, 0.17d, 0.2d, 0.2d),
        Hitbox(HitLocation.LowerLeg, -0.13d, 0.14d, 0d, 0.17d, 0.2d, 0.2d),
    ];

    private static readonly Vec3 HitboxRight = new();
    private static readonly Vec3 HitboxForward = new();
    private static readonly Vec3 HitboxCenterScratch = new();
    private static readonly Aabb HitboxBox = new();
    private static readonly HitboxHit SharedHitboxResult = new();

    private static readonly Vec3 SpreadRight = new();
    private static readonly Vec3 SpreadUp = new();
    private static readonly Vec2 DiscPoint = new();
    private static readonly Vec3 WorldUp = new(0d, 1d, 0d);
    private static readonly Vec3 WorldRight = new(1d, 0d, 0d);

    private static readonly RaycastHit[] TraceHits =
        Enumerable.Range(0, 8).Select(_ => CollisionTypes.CreateRaycastHit()).ToArray();
    private static readonly Vec3 TraceDirection = new();
    private static readonly Vec3 TraceOrigin = new();
    private static readonly HitboxHit PlayerHit = new();

    private static readonly Vec3 ExplosionDirection = new();
    private static readonly Vec3 ExplosionOrigin = new();
    private static readonly Vec3 ExplosionTargetPoint = new();

    private static readonly Vec3 MeleeDirection = new();
    private static readonly Vec3 MeleeOrigin = new();

    /// <summary>Trace a ray against a player's stance-aware per-location hitboxes.</summary>
    public static HitboxHit RaycastPlayer(
        Vec3 origin,
        Vec3 direction,
        double maxDistance,
        PlayerState player,
        HitboxHit? output = null,
        double hitboxScale = 1d)
    {
        var result = output ?? SharedHitboxResult;
        hitboxScale = Math.Clamp(hitboxScale, 1d, 1.5d);
        result.Hit = false;
        result.Distance = maxDistance;

        if (!player.Alive)
        {
            return result;
        }

        var height = Movement.CurrentHeight(player);
        var centerX = player.Position.X;
        var centerY = player.Position.Y + height * 0.5d;
        var centerZ = player.Position.Z;
        var bounding = (height * 0.5d + GameConstants.PlayerRadius + 0.2d) * hitboxScale;
        var offsetX = centerX - origin.X;
        var offsetY = centerY - origin.Y;
        var offsetZ = centerZ - origin.Z;
        var along = offsetX * direction.X + offsetY * direction.Y + offsetZ * direction.Z;
        if (along < -bounding || along > maxDistance + bounding)
        {
            return result;
        }

        var perpendicularSquared = offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ - along * along;
        if (perpendicularSquared > bounding * bounding)
        {
            return result;
        }

        foreach (var definition in Hitboxes)
        {
            BuildHitbox(player, definition, HitboxBox, hitboxScale);
            var distance = MathEx.RayAabb(origin, direction, HitboxBox, result.Distance);
            if (distance >= 0d && distance < result.Distance)
            {
                result.Hit = true;
                result.Distance = distance;
                result.Location = definition.Location;
            }
        }

        if (result.Hit)
        {
            MathEx.AddScaled(result.Point, origin, direction, result.Distance);
        }

        return result;
    }

    /// <summary>Return independent hitbox objects for debug rendering or AI aiming.</summary>
    public static List<PlayerHitbox> PlayerHitboxes(PlayerState player)
    {
        var output = new List<PlayerHitbox>(Hitboxes.Length);
        foreach (var definition in Hitboxes)
        {
            var box = MathEx.AabbFromCenterSize(new Vec3(), new Vec3(1d, 1d, 1d));
            BuildHitbox(player, definition, box);
            output.Add(new PlayerHitbox { Location = definition.Location, Box = box });
        }

        return output;
    }

    /// <summary>Write the centre of the first hitbox with a requested location.</summary>
    public static Vec3 HitboxCenter(Vec3 output, PlayerState player, HitLocation location)
    {
        var definition = Hitboxes.FirstOrDefault(hitbox => hitbox.Location == location) ?? Hitboxes[2];
        BuildHitbox(player, definition, HitboxBox);
        output.X = (HitboxBox.Min.X + HitboxBox.Max.X) * 0.5d;
        output.Y = (HitboxBox.Min.Y + HitboxBox.Max.Y) * 0.5d;
        output.Z = (HitboxBox.Min.Z + HitboxBox.Max.Z) * 0.5d;
        return output;
    }

    /// <summary>Perturb a normalized direction uniformly over a spread cone.</summary>
    public static Vec3 ApplySpread(Vec3 output, Vec3 direction, double coneHalfAngle, Rng rng)
    {
        if (coneHalfAngle <= 0d)
        {
            return MathEx.Copy(output, direction);
        }

        var up = Math.Abs(direction.Y) > 0.99d ? WorldRight : WorldUp;
        MathEx.Cross(SpreadRight, direction, up);
        MathEx.Normalize(SpreadRight, SpreadRight);
        MathEx.Cross(SpreadUp, SpreadRight, direction);

        rng.UnitDisc(DiscPoint);
        var tangent = Math.Tan(coneHalfAngle);

        output.X = direction.X + (SpreadRight.X * DiscPoint.X + SpreadUp.X * DiscPoint.Y) * tangent;
        output.Y = direction.Y + (SpreadRight.Y * DiscPoint.X + SpreadUp.Y * DiscPoint.Y) * tangent;
        output.Z = direction.Z + (SpreadRight.Z * DiscPoint.X + SpreadUp.Z * DiscPoint.Y) * tangent;
        return MathEx.Normalize(output, output);
    }

    /// <summary>Compute the current stance-, movement-, ADS-, and burst-adjusted cone.</summary>
    public static double ComputeSpread(
        WeaponDef weapon,
        PlayerState player,
        int shotsFired,
        double horizontalSpeed)
    {
        var spread = weapon.Spread;
        var adsAmount = MathEx.Clamp01(player.AdsProgress);

        var minimum = spread.HipMin + (spread.AdsMin - spread.HipMin) * adsAmount;
        var maximum = spread.HipMax + (spread.AdsMax - spread.HipMax) * adsAmount;
        var cone = Math.Min(maximum, minimum + spread.PerShot * shotsFired);

        if (!player.OnGround)
        {
            cone *= spread.JumpingMultiplier;
        }
        else if (horizontalSpeed > 0.5d)
        {
            var amount = MathEx.Clamp01(horizontalSpeed / 6d);
            cone *= 1d + (spread.MovingMultiplier - 1d) * amount;
        }

        if (player.Stance == Stance.Crouch)
        {
            cone *= spread.CrouchMultiplier;
        }
        else if (player.Stance == Stance.Prone)
        {
            cone *= spread.ProneMultiplier;
        }

        return Math.Max(0d, cone);
    }

    /// <summary>Write the deterministic-pattern plus random recoil impulse for one shot.</summary>
    public static RecoilImpulse ComputeRecoil(
        WeaponDef weapon,
        int shotIndex,
        Rng rng,
        RecoilImpulse output)
    {
        var pattern = weapon.Recoil.Pattern;
        var step = pattern.Count > 0
            ? pattern[Math.Min(shotIndex, pattern.Count - 1)]
            : null;

        output.Pitch = (step?.Pitch ?? 0d) + rng.Signed(weapon.Recoil.RandomPitch);
        output.Yaw = (step?.Yaw ?? 0d) + rng.Signed(weapon.Recoil.RandomYaw);
        return output;
    }

    public static TraceResult CreateTraceResult() => new();

    /// <summary>Resolve a hitscan shot, including friendly-body blocking and wall penetration.</summary>
    public static TraceResult TraceShot(
        WorldState world,
        ICollisionWorld collision,
        PlayerState shooter,
        WeaponDef weapon,
        Vec3 origin,
        Vec3 direction,
        TraceResult? output = null)
    {
        var result = output ?? CreateTraceResult();
        result.HitPlayer = false;
        result.Victim = 0;
        result.Damage = 0d;
        result.Penetrations = 0;
        result.HitAnything = false;
        result.HitEntity = 0;
        result.Distance = 0d;

        MathEx.Copy(TraceOrigin, origin);
        MathEx.Normalize(TraceDirection, direction);

        var remaining = GameConstants.MaxTraceDistance;
        var damageScale = 1d;
        var travelled = 0d;

        for (var pass = 0; pass <= MaximumPenetrations; pass++)
        {
            var geometryFilter = new QueryFilter(CollisionLayer.Sight | CollisionLayer.BulletClip)
            {
                IgnoreEntities = [shooter.EntityId],
            };
            var geometry = collision.Raycast(
                TraceOrigin,
                TraceDirection,
                remaining,
                geometryFilter,
                TraceHits[0]);
            var geometryDistance = geometry.Hit ? geometry.Distance : remaining;

            var nearestPlayerDistance = geometryDistance;
            PlayerState? nearestPlayer = null;
            var nearestLocation = HitLocation.Chest;

            foreach (var target in world.Players.Values)
            {
                if (target.Id == shooter.Id || !target.Alive)
                {
                    continue;
                }

                RaycastPlayer(TraceOrigin, TraceDirection, nearestPlayerDistance, target, PlayerHit,
                    shooter.IsBot ? 1d : 1.5d);
                if (PlayerHit.Hit && PlayerHit.Distance < nearestPlayerDistance)
                {
                    nearestPlayerDistance = PlayerHit.Distance;
                    nearestPlayer = target;
                    nearestLocation = PlayerHit.Location;
                }
            }

            if (nearestPlayer is not null)
            {
                travelled += nearestPlayerDistance;
                if (SimulationTypes.IsEnemyTeam(shooter.Team, nearestPlayer.Team))
                {
                    var baseDamage = WeaponMath.DamageAtRange(weapon.Damage, travelled);
                    result.HitPlayer = true;
                    result.Victim = nearestPlayer.Id;
                    result.Location = nearestLocation;
                    result.Damage = baseDamage * GameConstants.HitMultiplier.For(nearestLocation) * damageScale;
                    MathEx.AddScaled(result.Point, TraceOrigin, TraceDirection, nearestPlayerDistance);
                    MathEx.Scale(result.Normal, TraceDirection, -1d);
                    result.Surface = SurfaceType.Flesh;
                    result.Distance = travelled;
                    result.HitAnything = true;
                    return result;
                }

                travelled += 0d;
                MathEx.AddScaled(result.Point, TraceOrigin, TraceDirection, nearestPlayerDistance);
                MathEx.Scale(result.Normal, TraceDirection, -1d);
                result.Surface = SurfaceType.Flesh;
                result.Distance = travelled;
                result.HitAnything = true;
                return result;
            }

            if (!geometry.Hit)
            {
                travelled += remaining;
                MathEx.AddScaled(result.Point, TraceOrigin, TraceDirection, remaining);
                result.Distance = travelled;
                return result;
            }

            travelled += geometry.Distance;
            result.HitAnything = true;
            MathEx.Copy(result.Point, geometry.Point);
            MathEx.Copy(result.Normal, geometry.Normal);
            result.Surface = geometry.Surface;
            result.Distance = travelled;
            result.HitEntity = geometry.Entity;

            var properties = CollisionTypes.SurfaceProperties[geometry.Surface];
            var thickness = Math.Max(0.02d, geometry.Thickness);
            var power = weapon.Penetration * properties.Penetration;
            if (pass >= MaximumPenetrations || power <= 0.02d || thickness > power * 2.5d)
            {
                return result;
            }

            var retained = Math.Pow(properties.DamageRetention, thickness / 0.15d);
            damageScale *= MathEx.Clamp(retained, 0d, 1d);
            if (damageScale < 0.05d)
            {
                return result;
            }

            result.Penetrations++;
            MathEx.AddScaled(TraceOrigin, geometry.Point, TraceDirection, thickness + 0.01d);
            remaining = GameConstants.MaxTraceDistance - travelled;
            if (remaining <= 0.1d)
            {
                return result;
            }
        }

        return result;
    }

    /// <summary>Apply health and armour damage without awarding score or emitting events.</summary>
    public static DamageResult ApplyDamage(PlayerState victim, DamageInfo info)
    {
        var result = new DamageResult { Health = victim.Health };
        if (!victim.Alive || info.Amount <= 0d)
        {
            return result;
        }

        var remaining = info.Amount;
        if (victim.Armor > 0d && !info.IgnoreArmor)
        {
            var absorbed = Math.Min(victim.Armor, remaining);
            victim.Armor -= absorbed;
            remaining -= absorbed;
            result.Absorbed = absorbed;
        }

        var before = victim.Health;
        victim.Health = Math.Max(0d, victim.Health - remaining);
        result.Applied = before - victim.Health + result.Absorbed;
        result.Health = victim.Health;

        victim.TimeSinceDamage = 0d;
        if (info.Attacker != victim.Id && info.Attacker != 0)
        {
            victim.LastAttacker = info.Attacker;
            victim.Damagers.TryGetValue(info.Attacker, out var previousDamage);
            victim.Damagers[info.Attacker] = previousDamage + result.Applied;
        }

        if (victim.Health <= 0d)
        {
            result.Killed = true;
        }

        return result;
    }

    /// <summary>Return every positive-damage contributor other than killer and victim.</summary>
    public static List<int> ComputeAssists(PlayerState victim, int killer)
    {
        var output = new List<int>();
        foreach (var pair in victim.Damagers)
        {
            if (pair.Key == killer || pair.Key == victim.Id)
            {
                continue;
            }

            if (pair.Value > 0d)
            {
                output.Add(pair.Key);
            }
        }

        output.Sort();
        return output;
    }

    /// <summary>Resolve explosion exposure and falloff for every live player.</summary>
    public static IList<ExplosionTarget> ResolveExplosion(
        WorldState world,
        ICollisionWorld collision,
        Vec3 center,
        double radius,
        double maxDamage,
        int owner,
        bool friendlyFire,
        IList<ExplosionTarget> output)
    {
        output.Clear();
        MathEx.Copy(ExplosionOrigin, center);
        world.Players.TryGetValue(owner, out var ownerPlayer);

        foreach (var target in world.Players.Values)
        {
            if (!target.Alive)
            {
                continue;
            }

            if (!friendlyFire && ownerPlayer is not null && target.Id != owner &&
                !SimulationTypes.IsEnemyTeam(ownerPlayer.Team, target.Team))
            {
                continue;
            }

            MathEx.Set(
                ExplosionTargetPoint,
                target.Position.X,
                target.Position.Y + Movement.CurrentEyeHeight(target) * 0.6d,
                target.Position.Z);

            var distance = MathEx.Distance(ExplosionOrigin, ExplosionTargetPoint);
            if (distance > radius)
            {
                continue;
            }

            var sightFilter = new QueryFilter(CollisionLayer.Sight);
            if (distance > 0.5d && !collision.IsVisible(ExplosionOrigin, ExplosionTargetPoint, sightFilter))
            {
                continue;
            }

            var amount = MathEx.Clamp01(distance / radius);
            const double plateau = 0.35d;
            var falloff = amount <= plateau
                ? 1d
                : 1d - (amount - plateau) / (1d - plateau);
            var damage = maxDamage * falloff;
            if (damage < 1d)
            {
                continue;
            }

            MathEx.Subtract(ExplosionDirection, ExplosionTargetPoint, ExplosionOrigin);
            MathEx.Normalize(ExplosionDirection, ExplosionDirection);
            output.Add(new ExplosionTarget
            {
                Player = target,
                Damage = damage,
                Direction = MathEx.Clone(ExplosionDirection),
                Distance = distance,
            });
        }

        return output;
    }

    /// <summary>Compute LOS-, distance-, and view-angle-adjusted flash intensity.</summary>
    public static double ComputeFlashIntensity(
        PlayerState player,
        Vec3 flashPosition,
        double radius,
        ICollisionWorld collision)
    {
        MathEx.Set(
            ExplosionTargetPoint,
            player.Position.X,
            player.Position.Y + Movement.CurrentEyeHeight(player),
            player.Position.Z);
        var distance = MathEx.Distance(flashPosition, ExplosionTargetPoint);
        if (distance > radius)
        {
            return 0d;
        }

        var sightFilter = new QueryFilter(CollisionLayer.Sight);
        if (!collision.IsVisible(flashPosition, ExplosionTargetPoint, sightFilter))
        {
            return 0d;
        }

        MathEx.Subtract(ExplosionDirection, flashPosition, ExplosionTargetPoint);
        MathEx.Normalize(ExplosionDirection, ExplosionDirection);
        MathEx.AnglesToForward(ExplosionOrigin, player.Yaw, player.Pitch);

        var facing = MathEx.Dot(ExplosionDirection, ExplosionOrigin);
        var angleFactor = Math.Pow(MathEx.Clamp01(facing * 0.5d + 0.5d), 1.6d) * 0.9d + 0.1d;
        var distanceFactor = 1d - MathEx.Clamp01(distance / radius);
        return MathEx.Clamp01(angleFactor * distanceFactor);
    }

    /// <summary>Find the nearest visible enemy within the melee lunge cone.</summary>
    public static PlayerState? FindMeleeTarget(
        WorldState world,
        ICollisionWorld collision,
        PlayerState attacker)
    {
        MathEx.Set(
            MeleeOrigin,
            attacker.Position.X,
            attacker.Position.Y + Movement.CurrentEyeHeight(attacker),
            attacker.Position.Z);
        MathEx.AnglesToForward(MeleeDirection, attacker.Yaw, attacker.Pitch);

        PlayerState? best = null;
        var bestDistance = MeleeRange;

        foreach (var target in world.Players.Values)
        {
            if (target.Id == attacker.Id || !target.Alive ||
                !SimulationTypes.IsEnemyTeam(attacker.Team, target.Team))
            {
                continue;
            }

            MathEx.Set(
                ExplosionTargetPoint,
                target.Position.X,
                target.Position.Y + Movement.CurrentHeight(target) * 0.55d,
                target.Position.Z);
            MathEx.Subtract(ExplosionDirection, ExplosionTargetPoint, MeleeOrigin);
            var distance = Math.Sqrt(MathEx.Dot(ExplosionDirection, ExplosionDirection));
            if (distance > bestDistance || distance < 1e-4d)
            {
                continue;
            }

            MathEx.Scale(ExplosionDirection, ExplosionDirection, 1d / distance);
            if (MathEx.Dot(ExplosionDirection, MeleeDirection) < MeleeHalfAngle)
            {
                continue;
            }

            var sightFilter = new QueryFilter(CollisionLayer.Sight);
            if (!collision.IsVisible(MeleeOrigin, ExplosionTargetPoint, sightFilter))
            {
                continue;
            }

            best = target;
            bestDistance = distance;
        }

        return best;
    }

    /// <summary>Whether the attacker is inside the victim's tight backstab sector.</summary>
    public static bool IsBehind(PlayerState attacker, PlayerState victim)
    {
        MathEx.AnglesToForwardFlat(MeleeDirection, victim.Yaw);
        MathEx.Subtract(ExplosionDirection, attacker.Position, victim.Position);
        ExplosionDirection.Y = 0d;
        MathEx.Normalize(ExplosionDirection, ExplosionDirection);
        return MathEx.Dot(ExplosionDirection, MeleeDirection) < -0.55d;
    }

    private static HitboxDefinition Hitbox(
        HitLocation location,
        double right,
        double upFraction,
        double forward,
        double sizeX,
        double sizeYFraction,
        double sizeZ) =>
        new()
        {
            Location = location,
            Right = right,
            UpFraction = upFraction,
            Forward = forward,
            SizeX = sizeX,
            SizeYFraction = sizeYFraction,
            SizeZ = sizeZ,
        };

    private static Aabb BuildHitbox(
        PlayerState player,
        HitboxDefinition definition,
        Aabb output,
        double scale = 1d)
    {
        var height = Movement.CurrentHeight(player);
        MathEx.AnglesToRight(HitboxRight, player.Yaw);
        MathEx.AnglesToForwardFlat(HitboxForward, player.Yaw);

        if (player.Stance == Stance.Prone)
        {
            var along = (definition.UpFraction - 0.5d) * 1.75d;
            HitboxCenterScratch.X = player.Position.X + HitboxForward.X * along + HitboxRight.X * definition.Right;
            HitboxCenterScratch.Z = player.Position.Z + HitboxForward.Z * along + HitboxRight.Z * definition.Right;
            HitboxCenterScratch.Y = player.Position.Y + height * 0.55d;

            var length = definition.SizeYFraction * 1.75d;
            output.Min.X = HitboxCenterScratch.X - Math.Max(definition.SizeX, length) * 0.5d * scale;
            output.Max.X = HitboxCenterScratch.X + Math.Max(definition.SizeX, length) * 0.5d * scale;
            output.Min.Z = HitboxCenterScratch.Z - Math.Max(definition.SizeZ, length) * 0.5d * scale;
            output.Max.Z = HitboxCenterScratch.Z + Math.Max(definition.SizeZ, length) * 0.5d * scale;
            output.Min.Y = HitboxCenterScratch.Y - height * 0.45d * scale;
            output.Max.Y = HitboxCenterScratch.Y + height * 0.45d * scale;
            return output;
        }

        HitboxCenterScratch.X =
            player.Position.X + HitboxRight.X * definition.Right + HitboxForward.X * definition.Forward;
        HitboxCenterScratch.Z =
            player.Position.Z + HitboxRight.Z * definition.Right + HitboxForward.Z * definition.Forward;
        HitboxCenterScratch.Y = player.Position.Y + height * definition.UpFraction;

        var sizeY = definition.SizeYFraction * height * scale;
        var halfXz = Math.Max(definition.SizeX, definition.SizeZ) * 0.5d * scale;
        output.Min.X = HitboxCenterScratch.X - halfXz;
        output.Max.X = HitboxCenterScratch.X + halfXz;
        output.Min.Z = HitboxCenterScratch.Z - halfXz;
        output.Max.Z = HitboxCenterScratch.Z + halfXz;
        output.Min.Y = HitboxCenterScratch.Y - sizeY * 0.5d;
        output.Max.Y = HitboxCenterScratch.Y + sizeY * 0.5d;
        return output;
    }
}

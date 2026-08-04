using System.Numerics;
using OperationVanguard.Core;
using Raylib_cs;

namespace OperationVanguard.Game.Rendering;

/// <summary>
/// Fixed-capacity, presentation-only transient effects driven by canonical
/// simulation events. All geometry is emitted with Raylib primitives.
/// </summary>
public sealed class TransientEffectsRenderer
{
    private const int MuzzleCapacity = 40;
    private const int TracerCapacity = 112;
    private const int DecalCapacity = 192;
    private const int BurstCapacity = 48;
    private const int ParticleCapacity = 448;
    private const int SmokeCapacity = 20;
    private const int FireCapacity = 16;

    private enum ParticleVisual
    {
        Dust,
        Spark,
        Blood,
        Ember,
    }

    private struct MuzzleEffect
    {
        public Vector3 Position;
        public Vector3 Direction;
        public float Life;
        public float MaxLife;
        public bool Suppressed;
        public bool Local;
    }

    private struct TracerEffect
    {
        public Vector3 Start;
        public Vector3 End;
        public float Life;
        public float MaxLife;
        public bool Suppressed;
        public bool Local;
    }

    private struct DecalEffect
    {
        public Vector3 Position;
        public Vector3 Normal;
        public Color Color;
        public float Size;
        public float Life;
        public float MaxLife;
    }

    private struct BurstEffect
    {
        public Vector3 Position;
        public Color Color;
        public float StartRadius;
        public float EndRadius;
        public float Life;
        public float MaxLife;
    }

    private struct ParticleEffect
    {
        public Vector3 Position;
        public Vector3 Velocity;
        public Color Color;
        public float StartSize;
        public float EndSize;
        public float Life;
        public float MaxLife;
        public ParticleVisual Visual;
    }

    private struct SmokeEffect
    {
        public Vector3 Position;
        public float Radius;
        public float Age;
        public float Life;
        public float MaxLife;
        public int Density;
        public uint Seed;
    }

    private struct FireEffect
    {
        public Vector3 Position;
        public float Radius;
        public float Age;
        public float Life;
        public float MaxLife;
        public uint Seed;
    }

    private readonly record struct ShotTrace(Vector3 Origin, Vector3 Direction, bool Suppressed);

    private readonly record struct TrackedProjectile(ProjectileKind Kind, Vector3 Position);

    private readonly MuzzleEffect[] _muzzles = new MuzzleEffect[MuzzleCapacity];
    private readonly TracerEffect[] _tracers = new TracerEffect[TracerCapacity];
    private readonly DecalEffect[] _decals = new DecalEffect[DecalCapacity];
    private readonly BurstEffect[] _bursts = new BurstEffect[BurstCapacity];
    private readonly ParticleEffect[] _particles = new ParticleEffect[ParticleCapacity];
    private readonly SmokeEffect[] _smoke = new SmokeEffect[SmokeCapacity];
    private readonly FireEffect[] _fire = new FireEffect[FireCapacity];
    private readonly Dictionary<int, ShotTrace> _shotsThisTick = [];
    private readonly Dictionary<int, TrackedProjectile> _trackedProjectiles = [];
    private readonly List<int> _removedProjectileIds = [];

    private int _muzzleCursor;
    private int _tracerCursor;
    private int _decalCursor;
    private int _burstCursor;
    private int _particleCursor;
    private int _smokeCursor;
    private int _fireCursor;
    private uint _visualRandom = 0x9e3779b9u;
    private WorldState? _observedWorld;
    private int _lastObservedTick = -1;

    /// <summary>
    /// Translate one tick's events into presentation effects. Re-observing the
    /// same world tick is idempotent. The world is read only and is also used to
    /// resolve shooter origins and smoke-projectile detonation.
    /// </summary>
    public void Observe(IReadOnlyList<SimEvent> events, WorldState world, int localPlayerId)
    {
        if (!ReferenceEquals(_observedWorld, world) || world.Tick < _lastObservedTick)
        {
            Clear();
            _observedWorld = world;
        }

        if (_lastObservedTick == world.Tick)
        {
            return;
        }
        _lastObservedTick = world.Tick;
        _shotsThisTick.Clear();

        foreach (var simEvent in events)
        {
            switch (simEvent)
            {
                case ShotEvent shot:
                {
                    var direction = NormalizeOr(ToNumerics(shot.Direction), -Vector3.UnitZ);
                    var origin = ToNumerics(shot.Origin);
                    _shotsThisTick[shot.Player] = new ShotTrace(origin, direction, shot.Suppressed);
                    SpawnMuzzle(origin, direction, shot.Suppressed, shot.Player == localPlayerId);
                    break;
                }

                case ImpactEvent impact:
                {
                    var trace = TraceFor(impact.Shooter, impact.Position, world);
                    SpawnTracer(trace.Origin, ToNumerics(impact.Position), trace.Suppressed,
                        impact.Shooter == localPlayerId);
                    SpawnImpact(impact);
                    break;
                }

                case HitEvent hit:
                {
                    var trace = TraceFor(hit.Attacker, hit.Position, world);
                    SpawnTracer(trace.Origin, ToNumerics(hit.Position), trace.Suppressed,
                        hit.Attacker == localPlayerId);
                    var spray = NormalizeOr(-trace.Direction + Vector3.UnitY * .45f, Vector3.UnitY);
                    SpawnBlood(ToNumerics(hit.Position), spray, hit.Lethal ? 15 : 10);
                    break;
                }

                case DamageEvent damage when damage.Cause is DamageCause.Melee or
                                                     DamageCause.Zombie or
                                                     DamageCause.Fire:
                    if (world.Players.TryGetValue(damage.Victim, out var victim))
                    {
                        var position = ToNumerics(victim.Position) +
                                       Vector3.UnitY * (float)(Movement.CurrentHeight(victim) * .62d);
                        var direction = NormalizeOr(ToNumerics(damage.Direction), Vector3.UnitY);
                        SpawnBlood(position, direction + Vector3.UnitY * .35f, 6);
                        if (damage.Cause == DamageCause.Fire)
                        {
                            SpawnEmbers(position, 5, .45f);
                        }
                    }
                    break;

                case ExplosionEvent explosion:
                    SpawnExplosion(explosion);
                    break;

                case GenericSimEvent generic when generic.Type == SimEventType.Flash &&
                                                  generic.Position is not null:
                    SpawnBurst(
                        ToNumerics(generic.Position),
                        new Color(240, 248, 255, 230),
                        .08f,
                        2.2f,
                        .18f);
                    break;

                case GenericSimEvent generic when generic.Type == SimEventType.DeployableDestroyed &&
                                                  generic.Position is not null:
                    SpawnEmbers(ToNumerics(generic.Position), 9, .7f);
                    SpawnBurst(
                        ToNumerics(generic.Position),
                        new Color(229, 151, 72, 210),
                        .06f,
                        .75f,
                        .2f);
                    break;
            }
        }

        ObserveProjectiles(world);
    }

    /// <summary>Advance lifetimes, particles, smoke, and fire in frame time.</summary>
    public void Update(double deltaTime)
    {
        if (!double.IsFinite(deltaTime) || deltaTime <= 0d)
        {
            return;
        }

        var elapsed = (float)Math.Min(deltaTime, 1d);
        var motionStep = Math.Min(elapsed, .1f);

        UpdateSimpleLives(_muzzles, elapsed);
        UpdateSimpleLives(_tracers, elapsed);
        UpdateSimpleLives(_decals, elapsed);
        UpdateSimpleLives(_bursts, elapsed);

        for (var index = 0; index < _particles.Length; index++)
        {
            ref var particle = ref _particles[index];
            if (particle.Life <= 0f)
            {
                continue;
            }

            particle.Life -= elapsed;
            if (particle.Life <= 0f)
            {
                continue;
            }

            var gravity = particle.Visual switch
            {
                ParticleVisual.Blood => 11.5f,
                ParticleVisual.Spark => 13f,
                ParticleVisual.Dust => 2.4f,
                ParticleVisual.Ember => 3.2f,
                _ => 9.8f,
            };
            var drag = MathF.Exp(-(particle.Visual == ParticleVisual.Dust ? 3.8f : 2.2f) * motionStep);
            particle.Velocity.Y -= gravity * motionStep;
            particle.Velocity *= drag;
            particle.Position += particle.Velocity * motionStep;
        }

        for (var index = 0; index < _smoke.Length; index++)
        {
            ref var smoke = ref _smoke[index];
            if (smoke.Life <= 0f)
            {
                continue;
            }
            smoke.Life -= elapsed;
            smoke.Age += elapsed;
        }

        for (var index = 0; index < _fire.Length; index++)
        {
            ref var fire = ref _fire[index];
            if (fire.Life <= 0f)
            {
                continue;
            }
            fire.Life -= elapsed;
            fire.Age += elapsed;
        }
    }

    /// <summary>
    /// Draw active effects. Call only between <c>Raylib.BeginMode3D(camera)</c>
    /// and <c>Raylib.EndMode3D()</c>.
    /// </summary>
    public void Draw()
    {
        DrawDecals();
        DrawSmoke();
        DrawFire();
        DrawParticles();
        DrawBursts();
        DrawTracers();
        DrawMuzzles();
    }

    /// <summary>Discard all presentation state, such as when replacing a session.</summary>
    public void Clear()
    {
        Array.Clear(_muzzles);
        Array.Clear(_tracers);
        Array.Clear(_decals);
        Array.Clear(_bursts);
        Array.Clear(_particles);
        Array.Clear(_smoke);
        Array.Clear(_fire);
        _shotsThisTick.Clear();
        _trackedProjectiles.Clear();
        _removedProjectileIds.Clear();
        _muzzleCursor = 0;
        _tracerCursor = 0;
        _decalCursor = 0;
        _burstCursor = 0;
        _particleCursor = 0;
        _smokeCursor = 0;
        _fireCursor = 0;
        _observedWorld = null;
        _lastObservedTick = -1;
    }

    private ShotTrace TraceFor(int shooterId, Vec3 target, WorldState world)
    {
        if (_shotsThisTick.TryGetValue(shooterId, out var trace))
        {
            return trace;
        }

        var end = ToNumerics(target);
        if (world.Players.TryGetValue(shooterId, out var shooter))
        {
            var origin = ToNumerics(shooter.Position) +
                         Vector3.UnitY * (float)Movement.CurrentHeight(shooter);
            return new ShotTrace(origin, NormalizeOr(end - origin, -Vector3.UnitZ), false);
        }

        return new ShotTrace(end, -Vector3.UnitZ, false);
    }

    private void SpawnMuzzle(Vector3 origin, Vector3 direction, bool suppressed, bool local)
    {
        ref var effect = ref _muzzles[_muzzleCursor];
        _muzzleCursor = (_muzzleCursor + 1) % _muzzles.Length;
        var distance = local ? .58f : .36f;
        effect = new MuzzleEffect
        {
            Position = origin + direction * distance + (local ? -Vector3.UnitY * .12f : Vector3.Zero),
            Direction = direction,
            Life = suppressed ? .035f : .05f,
            MaxLife = suppressed ? .035f : .05f,
            Suppressed = suppressed,
            Local = local,
        };
    }

    private void SpawnTracer(Vector3 start, Vector3 end, bool suppressed, bool local)
    {
        if (Vector3.DistanceSquared(start, end) < .0001f)
        {
            return;
        }

        ref var effect = ref _tracers[_tracerCursor];
        _tracerCursor = (_tracerCursor + 1) % _tracers.Length;
        effect = new TracerEffect
        {
            Start = start,
            End = end,
            Life = suppressed ? .05f : .09f,
            MaxLife = suppressed ? .05f : .09f,
            Suppressed = suppressed,
            Local = local,
        };
    }

    private void SpawnImpact(ImpactEvent impact)
    {
        var position = ToNumerics(impact.Position);
        var normal = NormalizeOr(ToNumerics(impact.Normal), Vector3.UnitY);
        var color = SurfaceColor(impact.Surface);

        if (impact.Surface is not SurfaceType.Flesh and not SurfaceType.Water)
        {
            ref var decal = ref _decals[_decalCursor];
            _decalCursor = (_decalCursor + 1) % _decals.Length;
            decal = new DecalEffect
            {
                Position = position + normal * .012f,
                Normal = normal,
                Color = impact.Surface == SurfaceType.Glass
                    ? new Color(198, 226, 240, 155)
                    : new Color(24, 25, 25, impact.Penetrated ? 125 : 195),
                Size = Range(.045f, .072f),
                Life = 22f,
                MaxLife = 22f,
            };
        }

        SpawnBurst(position + normal * .02f, color, .025f,
            impact.Surface == SurfaceType.Metal ? .3f : .21f, .12f);
        var visual = impact.Surface == SurfaceType.Metal ? ParticleVisual.Spark : ParticleVisual.Dust;
        for (var index = 0; index < 6; index++)
        {
            var spread = new Vector3(Range(-1.1f, 1.1f), Range(0f, 1.6f), Range(-1.1f, 1.1f));
            SpawnParticle(
                position + normal * .025f,
                normal * Range(1.25f, 2.5f) + spread,
                color,
                Range(.025f, .045f),
                .008f,
                Range(.35f, .65f),
                visual);
        }
    }

    private void SpawnBlood(Vector3 position, Vector3 direction, int count)
    {
        direction = NormalizeOr(direction, Vector3.UnitY);
        for (var index = 0; index < count; index++)
        {
            var spread = new Vector3(Range(-1.15f, 1.15f), Range(0f, 1.5f), Range(-1.15f, 1.15f));
            SpawnParticle(
                position,
                direction * Range(1.8f, 3.6f) + spread,
                new Color(157, 23, 26, 235),
                Range(.032f, .055f),
                .014f,
                Range(.4f, .72f),
                ParticleVisual.Blood);
        }
    }

    private void SpawnExplosion(ExplosionEvent explosion)
    {
        var position = ToNumerics(explosion.Position);
        var radius = (float)Math.Clamp(explosion.Radius, .35d, 12d);
        var kind = ProjectileKindOf(explosion.Kind);
        var flashColor = kind is ProjectileKind.Molotov or ProjectileKind.ThermiteStick
            ? new Color(255, 108, 30, 235)
            : new Color(255, 169, 58, 240);

        SpawnBurst(position, flashColor, .08f, Math.Min(radius * 1.35f, 9f), .35f);
        var count = Math.Clamp((int)MathF.Round(radius * 9f), 14, 60);
        for (var index = 0; index < count; index++)
        {
            var direction = RandomUpperUnitVector();
            var ember = index % 4 == 0;
            SpawnParticle(
                position,
                direction * Range(4f, 13f),
                ember ? new Color(255, 213, 82, 240) : new Color(255, 101, 26, 245),
                Range(.065f, .15f),
                .012f,
                Range(.5f, 1.12f),
                ember ? ParticleVisual.Ember : ParticleVisual.Spark);
        }

        SpawnSmoke(position, Math.Clamp(radius * .48f, .65f, 3.1f), 2.4f,
            Math.Clamp((int)(radius * 2.4f), 7, 16));
        if (kind is ProjectileKind.Molotov or ProjectileKind.ThermiteStick)
        {
            SpawnFire(position, Math.Clamp(radius * .62f, .8f, 2.8f),
                kind == ProjectileKind.ThermiteStick ? 6.5f : 5.25f);
        }
    }

    private void SpawnEmbers(Vector3 position, int count, float scale)
    {
        for (var index = 0; index < count; index++)
        {
            SpawnParticle(
                position,
                RandomUpperUnitVector() * Range(1.5f, 5f) * scale,
                new Color(255, 137, 43, 235),
                Range(.035f, .075f) * scale,
                .008f,
                Range(.45f, .9f),
                ParticleVisual.Ember);
        }
    }

    private void SpawnParticle(
        Vector3 position,
        Vector3 velocity,
        Color color,
        float startSize,
        float endSize,
        float life,
        ParticleVisual visual)
    {
        ref var particle = ref _particles[_particleCursor];
        _particleCursor = (_particleCursor + 1) % _particles.Length;
        particle = new ParticleEffect
        {
            Position = position,
            Velocity = velocity,
            Color = color,
            StartSize = startSize,
            EndSize = endSize,
            Life = life,
            MaxLife = life,
            Visual = visual,
        };
    }

    private void SpawnBurst(Vector3 position, Color color, float startRadius, float endRadius, float life)
    {
        ref var burst = ref _bursts[_burstCursor];
        _burstCursor = (_burstCursor + 1) % _bursts.Length;
        burst = new BurstEffect
        {
            Position = position,
            Color = color,
            StartRadius = startRadius,
            EndRadius = endRadius,
            Life = life,
            MaxLife = life,
        };
    }

    private void SpawnSmoke(Vector3 position, float radius, float life, int density)
    {
        ref var smoke = ref _smoke[_smokeCursor];
        _smokeCursor = (_smokeCursor + 1) % _smoke.Length;
        smoke = new SmokeEffect
        {
            Position = position,
            Radius = radius,
            Age = 0f,
            Life = life,
            MaxLife = life,
            Density = Math.Clamp(density, 4, 22),
            Seed = NextRandom(),
        };
    }

    private void SpawnFire(Vector3 position, float radius, float life)
    {
        ref var fire = ref _fire[_fireCursor];
        _fireCursor = (_fireCursor + 1) % _fire.Length;
        fire = new FireEffect
        {
            Position = position,
            Radius = radius,
            Age = 0f,
            Life = life,
            MaxLife = life,
            Seed = NextRandom(),
        };
    }

    private void ObserveProjectiles(WorldState world)
    {
        _removedProjectileIds.Clear();
        foreach (var tracked in _trackedProjectiles)
        {
            if (!world.Projectiles.ContainsKey(tracked.Key))
            {
                _removedProjectileIds.Add(tracked.Key);
            }
        }

        foreach (var id in _removedProjectileIds)
        {
            var tracked = _trackedProjectiles[id];
            if (tracked.Kind == ProjectileKind.SmokeGrenade)
            {
                SpawnSmoke(tracked.Position, 4.2f, 8f, 22);
            }
            _trackedProjectiles.Remove(id);
        }

        foreach (var projectile in world.Projectiles.Values)
        {
            _trackedProjectiles[projectile.Id] = new TrackedProjectile(
                projectile.Kind,
                ToNumerics(projectile.Position));
        }
    }

    private void DrawMuzzles()
    {
        foreach (var effect in _muzzles)
        {
            if (effect.Life <= 0f)
            {
                continue;
            }

            var progress = Math.Clamp(effect.Life / effect.MaxLife, 0f, 1f);
            var baseColor = effect.Suppressed
                ? new Color(205, 164, 105, 155)
                : new Color(255, 216, 145, 245);
            var color = Fade(baseColor, progress);
            var radius = (effect.Local ? .14f : .19f) * (.55f + progress * .45f);
            Raylib.DrawSphere(effect.Position, radius, color);

            var direction = NormalizeOr(effect.Direction, -Vector3.UnitZ);
            var right = Perpendicular(direction);
            var up = NormalizeOr(Vector3.Cross(direction, right), Vector3.UnitY);
            Raylib.DrawLine3D(
                effect.Position - direction * radius * .35f,
                effect.Position + direction * radius * 1.75f,
                color);
            Raylib.DrawLine3D(effect.Position - right * radius, effect.Position + right * radius, color);
            Raylib.DrawLine3D(effect.Position - up * radius, effect.Position + up * radius, color);
        }
    }

    private void DrawTracers()
    {
        foreach (var effect in _tracers)
        {
            if (effect.Life <= 0f)
            {
                continue;
            }

            var alpha = Math.Clamp(effect.Life / effect.MaxLife, 0f, 1f);
            var color = effect.Suppressed
                ? new Color(202, 184, 145, (int)(90 * alpha))
                : effect.Local
                    ? new Color(255, 225, 161, (int)(225 * alpha))
                    : new Color(255, 198, 106, (int)(205 * alpha));
            var radius = effect.Suppressed ? .006f : .011f;
            Raylib.DrawCylinderEx(effect.Start, effect.End, radius, radius, 5, color);
        }
    }

    private void DrawBursts()
    {
        foreach (var effect in _bursts)
        {
            if (effect.Life <= 0f)
            {
                continue;
            }

            var remaining = Math.Clamp(effect.Life / effect.MaxLife, 0f, 1f);
            var age = 1f - remaining;
            var radius = Lerp(effect.StartRadius, effect.EndRadius, EaseOut(age));
            var color = Fade(effect.Color, remaining * remaining);
            Raylib.DrawSphere(effect.Position, radius, color);
            var wire = Fade(effect.Color, remaining);
            Raylib.DrawLine3D(effect.Position - Vector3.UnitX * radius,
                effect.Position + Vector3.UnitX * radius, wire);
            Raylib.DrawLine3D(effect.Position - Vector3.UnitY * radius,
                effect.Position + Vector3.UnitY * radius, wire);
            Raylib.DrawLine3D(effect.Position - Vector3.UnitZ * radius,
                effect.Position + Vector3.UnitZ * radius, wire);
        }
    }

    private void DrawParticles()
    {
        foreach (var particle in _particles)
        {
            if (particle.Life <= 0f)
            {
                continue;
            }

            var remaining = Math.Clamp(particle.Life / particle.MaxLife, 0f, 1f);
            var age = 1f - remaining;
            var size = Lerp(particle.StartSize, particle.EndSize, age);
            var alpha = particle.Visual == ParticleVisual.Dust
                ? Math.Min(1f, age * 4f) * remaining
                : remaining;
            Raylib.DrawSphere(particle.Position, Math.Max(.004f, size), Fade(particle.Color, alpha));
        }
    }

    private void DrawDecals()
    {
        foreach (var decal in _decals)
        {
            if (decal.Life <= 0f)
            {
                continue;
            }

            var normal = NormalizeOr(decal.Normal, Vector3.UnitY);
            var tangent = Perpendicular(normal);
            var bitangent = NormalizeOr(Vector3.Cross(normal, tangent), Vector3.UnitZ);
            var fade = decal.Life < 2f ? decal.Life / 2f : 1f;
            var size = decal.Size * (decal.Life < 2f ? .75f + fade * .25f : 1f);
            var a = decal.Position - tangent * size - bitangent * size;
            var b = decal.Position + tangent * size - bitangent * size;
            var c = decal.Position + tangent * size + bitangent * size;
            var d = decal.Position - tangent * size + bitangent * size;
            var color = Fade(decal.Color, fade);
            Raylib.DrawTriangle3D(a, b, c, color);
            Raylib.DrawTriangle3D(a, c, d, color);
            Raylib.DrawTriangle3D(c, b, a, color);
            Raylib.DrawTriangle3D(d, c, a, color);
        }
    }

    private void DrawSmoke()
    {
        foreach (var smoke in _smoke)
        {
            if (smoke.Life <= 0f)
            {
                continue;
            }

            var remaining = Math.Clamp(smoke.Life / smoke.MaxLife, 0f, 1f);
            var age = 1f - remaining;
            var fadeIn = Math.Min(1f, smoke.Age * 2.5f);
            var fadeOut = Math.Min(1f, smoke.Life / 1.4f);
            for (var index = 0; index < smoke.Density; index++)
            {
                var h0 = Hash01(smoke.Seed, (uint)(index * 5 + 1));
                var h1 = Hash01(smoke.Seed, (uint)(index * 5 + 2));
                var h2 = Hash01(smoke.Seed, (uint)(index * 5 + 3));
                var h3 = Hash01(smoke.Seed, (uint)(index * 5 + 4));
                var angle = h0 * MathF.Tau + smoke.Age * (.08f + h3 * .12f);
                var radial = smoke.Radius * (.15f + h1 * .72f) * (.35f + age * .65f);
                var height = h2 * smoke.Radius * .75f + smoke.Age * (.12f + h3 * .16f);
                var position = smoke.Position + new Vector3(
                    MathF.Cos(angle) * radial,
                    .18f + height,
                    MathF.Sin(angle) * radial);
                var size = smoke.Radius * (.15f + h3 * .2f) * (.55f + age * .75f);
                var shade = (byte)(60 + h2 * 32);
                var alpha = (byte)Math.Clamp((int)(55f * fadeIn * fadeOut * (.6f + remaining * .4f)), 0, 90);
                Raylib.DrawSphere(position, Math.Max(.08f, size), new Color(shade, shade + 3, shade + 5, alpha));
            }
        }
    }

    private void DrawFire()
    {
        foreach (var fire in _fire)
        {
            if (fire.Life <= 0f)
            {
                continue;
            }

            var fade = Math.Min(1f, fire.Life / .65f) * Math.Min(1f, fire.Age * 5f);
            const int tongues = 9;
            for (var index = 0; index < tongues; index++)
            {
                var h0 = Hash01(fire.Seed, (uint)(index * 3 + 1));
                var h1 = Hash01(fire.Seed, (uint)(index * 3 + 2));
                var angle = h0 * MathF.Tau;
                var radial = fire.Radius * (.08f + h1 * .72f);
                var flicker = .72f + MathF.Sin(fire.Age * (7f + h1 * 5f) + h0 * 12f) * .22f;
                var height = fire.Radius * (.3f + h1 * .35f) * flicker;
                var basePosition = fire.Position + new Vector3(
                    MathF.Cos(angle) * radial,
                    .035f,
                    MathF.Sin(angle) * radial);
                var tip = basePosition + Vector3.UnitY * Math.Max(.12f, height);
                var outer = new Color(255, 91, 20, (int)(150 * fade));
                var inner = new Color(255, 211, 72, (int)(205 * fade));
                Raylib.DrawCylinderEx(basePosition, tip, .08f + h1 * .06f, .018f, 6, outer);
                Raylib.DrawSphere(tip, .055f + h1 * .04f, inner);
            }

            var smokePosition = fire.Position + Vector3.UnitY * (fire.Radius * .65f + .25f);
            Raylib.DrawSphere(smokePosition, fire.Radius * .24f,
                new Color(52, 55, 56, (int)(40 * fade)));
        }
    }

    private static void UpdateSimpleLives(MuzzleEffect[] effects, float elapsed)
    {
        for (var index = 0; index < effects.Length; index++)
        {
            if (effects[index].Life > 0f) effects[index].Life -= elapsed;
        }
    }

    private static void UpdateSimpleLives(TracerEffect[] effects, float elapsed)
    {
        for (var index = 0; index < effects.Length; index++)
        {
            if (effects[index].Life > 0f) effects[index].Life -= elapsed;
        }
    }

    private static void UpdateSimpleLives(DecalEffect[] effects, float elapsed)
    {
        for (var index = 0; index < effects.Length; index++)
        {
            if (effects[index].Life > 0f) effects[index].Life -= elapsed;
        }
    }

    private static void UpdateSimpleLives(BurstEffect[] effects, float elapsed)
    {
        for (var index = 0; index < effects.Length; index++)
        {
            if (effects[index].Life > 0f) effects[index].Life -= elapsed;
        }
    }

    private uint NextRandom()
    {
        var value = _visualRandom;
        value ^= value << 13;
        value ^= value >> 17;
        value ^= value << 5;
        _visualRandom = value == 0 ? 0x6d2b79f5u : value;
        return _visualRandom;
    }

    private float Random01() => (NextRandom() & 0x00ffffffu) / 16777216f;

    private float Range(float minimum, float maximum) => minimum + (maximum - minimum) * Random01();

    private Vector3 RandomUpperUnitVector()
    {
        var angle = Random01() * MathF.Tau;
        var vertical = Random01();
        var planar = MathF.Sqrt(Math.Max(0f, 1f - vertical * vertical));
        return new Vector3(MathF.Cos(angle) * planar, vertical, MathF.Sin(angle) * planar);
    }

    private static float Hash01(uint seed, uint index)
    {
        var value = seed ^ (index * 0x9e3779b9u);
        value ^= value >> 16;
        value *= 0x7feb352du;
        value ^= value >> 15;
        value *= 0x846ca68bu;
        value ^= value >> 16;
        return (value & 0x00ffffffu) / 16777216f;
    }

    private static ProjectileKind? ProjectileKindOf(object kind)
    {
        if (kind is ProjectileKind projectileKind)
        {
            return projectileKind;
        }
        if (kind is string text && Enum.TryParse<ProjectileKind>(text, true, out var parsed))
        {
            return parsed;
        }
        if (kind is int number && Enum.IsDefined(typeof(ProjectileKind), number))
        {
            return (ProjectileKind)number;
        }
        return null;
    }

    private static Color SurfaceColor(SurfaceType surface) => surface switch
    {
        SurfaceType.Metal => new Color(255, 216, 138, 255),
        SurfaceType.Concrete => new Color(216, 210, 198, 235),
        SurfaceType.Brick => new Color(200, 154, 134, 235),
        SurfaceType.Wood => new Color(200, 160, 112, 235),
        SurfaceType.Dirt => new Color(154, 132, 104, 230),
        SurfaceType.Grass => new Color(109, 137, 79, 225),
        SurfaceType.Sand => new Color(216, 199, 154, 235),
        SurfaceType.Water => new Color(125, 183, 220, 205),
        SurfaceType.Glass => new Color(223, 240, 255, 235),
        SurfaceType.Foliage => new Color(94, 139, 73, 220),
        SurfaceType.Flesh => new Color(194, 58, 58, 240),
        SurfaceType.Carpet => new Color(126, 104, 91, 225),
        SurfaceType.Gravel => new Color(143, 139, 130, 230),
        SurfaceType.Snow => new Color(250, 252, 255, 240),
        SurfaceType.Tile => new Color(203, 210, 212, 235),
        SurfaceType.Plastic => new Color(178, 184, 182, 230),
        _ => new Color(200, 189, 168, 235),
    };

    private static Vector3 Perpendicular(Vector3 direction)
    {
        var axis = Math.Abs(direction.Y) < .88f ? Vector3.UnitY : Vector3.UnitX;
        return NormalizeOr(Vector3.Cross(axis, direction), Vector3.UnitX);
    }

    private static Vector3 NormalizeOr(Vector3 value, Vector3 fallback) =>
        value.LengthSquared() > .000001f ? Vector3.Normalize(value) : fallback;

    private static Color Fade(Color color, float amount) => new(
        color.R,
        color.G,
        color.B,
        (byte)Math.Clamp((int)MathF.Round(color.A * Math.Clamp(amount, 0f, 1f)), 0, 255));

    private static float Lerp(float from, float to, float amount) => from + (to - from) * amount;

    private static float EaseOut(float value) => 1f - (1f - value) * (1f - value);

    private static Vector3 ToNumerics(Vec3 value) =>
        new((float)value.X, (float)value.Y, (float)value.Z);
}

using System.Numerics;
using OperationVanguard.Core;
using Raylib_cs;

namespace OperationVanguard.Game.Rendering;

/// <summary>Procedural player, projectile, equipment, and killstreak presentation.</summary>
public sealed class EntityRenderer : IDisposable
{
    private readonly Model _cube;
    private readonly ProceduralModelShader _materials;
    private readonly Dictionary<int, CharacterAnimation> _animation = [];
    private bool _disposed;

    public EntityRenderer()
    {
        _cube = Raylib.LoadModelFromMesh(Raylib.GenMeshCube(1, 1, 1));
        _materials = new ProceduralModelShader();
    }

    public void Draw(WorldState world, int localPlayerId)
    {
        var localTeam = world.Players.GetValueOrDefault(localPlayerId)?.Team ?? Team.None;
        foreach (var id in _animation.Keys.Where(id => !world.Players.ContainsKey(id)).ToArray())
            _animation.Remove(id);
        _materials.Begin();
        try
        {
            foreach (var player in world.Players.Values)
            {
                if (player.Id == localPlayerId || !player.Alive) continue;
                DrawPlayer(player, SimulationTypes.IsEnemyTeam(localTeam, player.Team), world.Time);
            }
            foreach (var projectile in world.Projectiles.Values) DrawProjectile(projectile);
            foreach (var deployable in world.Deployables.Values) DrawDeployable(deployable);
            foreach (var vehicle in world.KillstreakEntities.Values) DrawVehicle(vehicle);
        }
        finally
        {
            _materials.End();
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _materials.Dispose();
        Raylib.UnloadModel(_cube);
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    private void DrawPlayer(PlayerState player, bool enemy, double worldTime)
    {
        var animation = Animation(player, worldTime);
        var fatigues = TeamMaterial(player.Team, enemy);
        var vest = Packed(enemy ? 0x2b2320 : 0x232a30);
        var gear = Packed(0x1b1d1f);
        var boots = Packed(0x141414);
        var skin = Packed(0x9a7357);
        var accent = Packed(enemy ? 0x43d854 : 0xd8452c);

        var rootPosition = ToNumerics(player.Position);
        if (player.MoveState == MoveState.Slide) rootPosition.Y -= .25f;
        var root = new Joint(rootPosition, Quaternion.CreateFromAxisAngle(Vector3.UnitY, (float)player.Yaw));
        var hips = root.Child(new Vector3(0, .95f - animation.Crouch * .5f, 0), Quaternion.Identity);

        DrawPart(hips, new(.340f, .200f, .220f), new(0, 0, 0), fatigues, .85f, .04f);
        DrawPart(hips, new(.360f, .055f, .240f), new(0, .055f, 0), gear, .70f, .25f);
        DrawPart(hips, new(.090f, .090f, .070f), new(-.13f, -.01f, .130f), gear, .70f, .25f);
        DrawPart(hips, new(.070f, .080f, .060f), new(.14f, -.02f, .120f), gear, .70f, .25f);

        var torsoPitch = animation.Crouch * .35f + Math.Clamp((float)-player.Pitch, 0, 1) * .1f;
        var torsoRoll = player.MoveState == MoveState.Slide ? .35f : 0;
        var torsoRotation = Quaternion.CreateFromYawPitchRoll(0, torsoPitch, torsoRoll);
        var torso = hips.Child(new Vector3(0, .10f, 0), torsoRotation);
        DrawPart(torso, new(.400f, .520f, .240f), new(0, .26f, 0), fatigues, .85f, .04f);
        DrawPart(torso, new(.430f, .360f, .285f), new(0, .30f, 0), vest, .82f, .10f);
        for (var index = 0; index < 3; index++)
            DrawPart(torso, new(.075f, .110f, .045f), new((index - 1) * .095f, .235f, -.160f),
                gear, .70f, .25f);
        DrawPart(torso, new(.300f, .045f, .020f), new(0, .415f, -.155f), accent, .50f, .10f);
        DrawPart(torso, new(.110f, .020f, .190f), new(0, .485f, 0), accent, .50f, .10f);

        if (enemy)
        {
            DrawPart(torso, new(.105f, .095f, .230f), new(-.235f, .455f, 0), gear, .70f, .25f);
            DrawPart(torso, new(.105f, .095f, .230f), new(.235f, .455f, 0), gear, .70f, .25f);
            DrawPart(torso, new(.100f, .030f, .220f), new(-.235f, .510f, 0), accent, .50f, .10f);
            DrawPart(torso, new(.100f, .030f, .220f), new(.235f, .510f, 0), accent, .50f, .10f);
        }
        else
        {
            DrawPart(torso, new(.270f, .330f, .150f), new(0, .300f, .185f), gear, .70f, .25f);
            DrawPart(torso, new(.230f, .040f, .160f), new(0, .430f, .190f), accent, .50f, .10f);
            DrawPart(torso, new(.060f, .120f, .055f), new(-.175f, .430f, .120f), gear, .70f, .25f);
            DrawPart(torso, new(.014f, .220f, .014f), new(-.175f, .590f, .120f), gear, .70f, .25f);
        }

        DrawPart(torso, new(.110f, .070f, .110f), new(0, .545f, 0), skin, .90f, 0);
        var head = torso.Child(new Vector3(0, .55f, 0),
            Quaternion.CreateFromAxisAngle(Vector3.UnitX, (float)player.Pitch * .6f));
        DrawPart(head, new(.200f, .220f, .210f), new(0, .10f, 0), skin, .90f, 0);
        DrawPart(head, new(.205f, .090f, .215f), new(0, .045f, -.005f), gear, .70f, .25f);
        DrawPart(head, new(.240f, .100f, .250f), new(0, .200f, .005f), vest, .82f, .10f);
        DrawPart(head, new(.245f, .030f, .100f), new(0, .155f, -.090f), vest, .82f, .10f);
        DrawPart(head, new(.170f, .030f, .020f), new(0, .235f, -.120f), accent, .50f, .10f);
        if (enemy)
        {
            DrawPart(head, new(.014f, .200f, .014f), new(-.085f, .345f, .060f), gear, .70f, .25f);
            DrawPart(head, new(.024f, .028f, .024f), new(-.085f, .455f, .060f), accent, .50f, .10f);
        }
        else
        {
            DrawPart(head, new(.070f, .055f, .070f), new(0, .235f, -.140f), gear, .70f, .25f);
        }

        DrawArm(torso, -1, -animation.Swing * .18f * animation.Stride, fatigues, vest, gear);
        DrawArm(torso, 1, animation.Swing * .12f * animation.Stride, fatigues, vest, gear);
        DrawLeg(hips, -1, animation.Swing * .7f * animation.Stride, fatigues, gear, boots);
        DrawLeg(hips, 1, -animation.Swing * .7f * animation.Stride, fatigues, gear, boots);
    }

    private void DrawArm(Joint torso, float side, float pitch, Color fatigues, Color vest, Color gear)
    {
        var arm = torso.Child(new Vector3(side * .245f, .46f, 0),
            Quaternion.CreateFromAxisAngle(Vector3.UnitX, pitch));
        DrawPart(arm, new(.130f, .300f, .150f), new(0, -.15f, 0), fatigues, .85f, .04f);
        DrawPart(arm, new(.140f, .060f, .160f), new(0, -.020f, 0), vest, .82f, .10f);
        DrawPart(arm, new(.115f, .280f, .130f), new(0, -.44f, 0), fatigues, .85f, .04f);
        DrawPart(arm, new(.120f, .100f, .140f), new(0, -.63f, 0), gear, .70f, .25f);
    }

    private void DrawLeg(Joint hips, float side, float pitch, Color fatigues, Color gear, Color boots)
    {
        var leg = hips.Child(new Vector3(side * .095f, -.10f, 0),
            Quaternion.CreateFromAxisAngle(Vector3.UnitX, pitch));
        DrawPart(leg, new(.150f, .420f, .170f), new(0, -.21f, 0), fatigues, .85f, .04f);
        DrawPart(leg, new(.140f, .070f, .030f), new(0, -.415f, -.078f), gear, .70f, .25f);
        DrawPart(leg, new(.130f, .300f, .150f), new(0, -.57f, 0), fatigues, .85f, .04f);
        DrawPart(leg, new(.150f, .100f, .270f), new(0, -.77f, .045f), boots, .85f, .15f);
    }

    private void DrawProjectile(ProjectileState projectile)
    {
        var color = projectile.Kind switch
        {
            ProjectileKind.SmokeGrenade => new Color(130, 145, 150, 255),
            ProjectileKind.Flashbang => new Color(220, 225, 220, 255),
            ProjectileKind.Rocket => new Color(120, 80, 38, 255),
            ProjectileKind.Molotov => new Color(255, 104, 25, 255),
            _ => new Color(48, 52, 48, 255),
        };
        var radius = projectile.Kind == ProjectileKind.Rocket ? .11f : .075f;
        _materials.Configure(2, .38f, .75f, 30);
        Raylib.DrawSphere(ToNumerics(projectile.Position), radius, color);
    }

    private void DrawDeployable(DeployableState deployable)
    {
        var size = deployable.Kind switch
        {
            DeployableKind.DeployableCover => new Vector3(1.4f, 1.2f, .24f),
            DeployableKind.SentryGun => new Vector3(.62f, .9f, .62f),
            DeployableKind.CarePackage => new Vector3(1.2f, 1.1f, 1.2f),
            DeployableKind.AmmoBox => new Vector3(.55f, .3f, .42f),
            _ => new Vector3(.28f, .16f, .28f),
        };
        var centre = ToNumerics(deployable.Position) + Vector3.UnitY * size.Y / 2;
        var yaw = (float)(deployable.Yaw * MathEx.Rad2Deg);
        DrawPart(centre, size, yaw, new Color(60, 67, 59, 255), 5);
        DrawPart(centre + Vector3.UnitY * size.Y * .28f, new Vector3(size.X * .82f, .055f, size.Z * 1.03f),
            yaw, new Color(112, 124, 96, 255), 1);
        if (deployable.Kind == DeployableKind.SentryGun)
        {
            _materials.Configure(2, .32f, .9f, 30);
            Raylib.DrawCylinderEx(centre + Vector3.UnitY * .22f, centre + new Vector3(0, .22f, -.72f),
                .055f, .035f, 10, new Color(35, 38, 39, 255));
        }
    }

    private void DrawVehicle(KillstreakEntityState vehicle)
    {
        var centre = ToNumerics(vehicle.Position);
        var color = vehicle.Team == Team.Allies
            ? new Color(59, 87, 105, 255)
            : new Color(105, 61, 51, 255);
        var size = vehicle.Kind switch
        {
            KillstreakVehicleKind.AC130 => new Vector3(4.8f, .65f, 2.1f),
            KillstreakVehicleKind.VTOL => new Vector3(3.2f, .58f, 2.7f),
            KillstreakVehicleKind.Chopper => new Vector3(2.7f, .65f, 1.15f),
            _ => new Vector3(1.35f, .35f, 1.35f),
        };
        DrawPart(centre, size, (float)(vehicle.Yaw * MathEx.Rad2Deg), color);
        DrawPart(centre + Vector3.UnitY * .15f, new Vector3(size.X * .68f, size.Y * .42f, size.Z * 1.18f),
            (float)(vehicle.Yaw * MathEx.Rad2Deg), Shade(color, .62), 1);
        if (vehicle.Kind is KillstreakVehicleKind.Chopper or KillstreakVehicleKind.VTOL)
            Raylib.DrawCylinderEx(centre + Vector3.UnitY * .45f, centre + Vector3.UnitY * .48f,
                size.X * .8f, size.X * .8f, 18, new Color(35, 38, 40, 180));
    }

    private void DrawPart(
        Joint joint, Vector3 size, Vector3 offset, Color color, float roughness, float metalness)
    {
        _materials.Configure(0, roughness, metalness, 1);
        var position = joint.Position + Vector3.Transform(offset, joint.Rotation);
        var rotation = Quaternion.Normalize(joint.Rotation);
        var cosine = Math.Clamp(rotation.W, -1, 1);
        var angle = 2 * MathF.Acos(cosine);
        var denominator = MathF.Sqrt(Math.Max(0, 1 - cosine * cosine));
        var axis = denominator < 1e-5f
            ? Vector3.UnitY
            : new Vector3(rotation.X, rotation.Y, rotation.Z) / denominator;
        Raylib.DrawModelEx(_cube, position, axis, angle * (float)MathEx.Rad2Deg, size, color);
    }

    private void DrawPart(Vector3 position, Vector3 size, float yawDegrees, Color color, int detail = 1)
    {
        var metalness = detail == 2 ? .88f : detail == 1 || detail == 5 ? .18f : .04f;
        var roughness = detail switch { 2 => .34f, 3 => .88f, 4 => .86f, _ => .72f };
        _materials.Configure(detail, roughness, metalness, detail == 0 ? 22 : 18);
        Raylib.DrawModelEx(_cube, position, Vector3.UnitY, yawDegrees, size, color);
    }

    private CharacterAnimation Animation(PlayerState player, double worldTime)
    {
        var position = ToNumerics(player.Position);
        if (!_animation.TryGetValue(player.Id, out var state))
        {
            state = new CharacterAnimation { LastPosition = position, LastTime = worldTime };
            _animation[player.Id] = state;
        }

        var deltaTime = Math.Max(0, worldTime - state.LastTime);
        var travelled = Vector3.Distance(position, state.LastPosition);
        state.LastPosition = position;
        state.LastTime = worldTime;
        var crouchTarget = player.Stance == Stance.Prone ? 1 : player.Stance == Stance.Crouch ? .6f : 0;
        if (deltaTime > 0)
            state.Crouch += (crouchTarget - state.Crouch) * (1 - MathF.Exp(-10 * (float)deltaTime));
        var sprinting = player.MoveState is MoveState.Sprint or MoveState.TacticalSprint;
        state.Gait += travelled * (sprinting ? 2.1f : 2.6f);
        state.Swing = MathF.Sin(state.Gait);
        state.Stride = deltaTime > 0
            ? Math.Clamp(travelled / ((float)deltaTime * 6), 0, 1) * (1 - state.Crouch * .5f)
            : 0;
        return state;
    }

    private static Color TeamMaterial(Team team, bool enemy)
    {
        var basis = team switch
        {
            Team.Allies => 0x3b4653,
            Team.Axis => 0x574b3a,
            Team.Hostile => 0x33302b,
            _ => 0x4c4c4c,
        };
        var tint = enemy ? 0x2fae4b : 0xb02f28;
        var amount = enemy ? .32f : .26f;
        var a = Linear(basis);
        var b = Linear(tint);
        return FromLinear(Vector3.Lerp(a, b, amount));
    }

    private static Color Packed(int packed) => new(
        (packed >> 16) & 0xff,
        (packed >> 8) & 0xff,
        packed & 0xff,
        255);

    private static Vector3 Linear(int packed) => new(
        SrgbToLinear(((packed >> 16) & 0xff) / 255f),
        SrgbToLinear(((packed >> 8) & 0xff) / 255f),
        SrgbToLinear((packed & 0xff) / 255f));

    private static Color FromLinear(Vector3 color) => new(
        (int)MathF.Round(LinearToSrgb(color.X) * 255),
        (int)MathF.Round(LinearToSrgb(color.Y) * 255),
        (int)MathF.Round(LinearToSrgb(color.Z) * 255),
        255);

    private static float SrgbToLinear(float value) => value <= .04045f
        ? value / 12.92f
        : MathF.Pow((value + .055f) / 1.055f, 2.4f);

    private static float LinearToSrgb(float value) => value <= .0031308f
        ? value * 12.92f
        : 1.055f * MathF.Pow(value, 1 / 2.4f) - .055f;

    private static Color Shade(Color color, double scale) => new(
        Math.Clamp((int)(color.R * scale), 0, 255),
        Math.Clamp((int)(color.G * scale), 0, 255),
        Math.Clamp((int)(color.B * scale), 0, 255),
        color.A);

    private static Vector3 ToNumerics(Vec3 value) => new((float)value.X, (float)value.Y, (float)value.Z);

    private readonly record struct Joint(Vector3 Position, Quaternion Rotation)
    {
        public Joint Child(Vector3 offset, Quaternion localRotation) => new(
            Position + Vector3.Transform(offset, Rotation),
            Quaternion.Normalize(Quaternion.Concatenate(localRotation, Rotation)));
    }

    private sealed class CharacterAnimation
    {
        public Vector3 LastPosition;
        public double LastTime;
        public float Gait;
        public float Crouch;
        public float Swing;
        public float Stride;
    }
}

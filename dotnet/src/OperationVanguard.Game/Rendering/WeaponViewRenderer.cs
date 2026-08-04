using System.Numerics;
using OperationVanguard.Core;
using Raylib_cs;

namespace OperationVanguard.Game.Rendering;

/// <summary>
/// Procedural first-person weapon presentation. Geometry is derived exclusively from
/// <see cref="WeaponDef.Model"/> and is rendered in a depth-independent camera pass.
/// </summary>
/// <remarks>
/// Call <see cref="Observe"/> once for each simulation event batch, call one of the
/// <c>Update</c> overloads every frame, then call <see cref="Draw"/> after the world
/// camera pass and before the HUD. A Raylib window must exist before construction.
/// </remarks>
public sealed class WeaponViewRenderer : IDisposable
{
    private static readonly Vector3 HipPosition = new(.17f, -.16f, -.34f);
    private static readonly Vector3 HipRotation = new(.02f, -.06f, .015f);
    private static readonly Vector3 SprintPosition = new(.20f, -.22f, -.30f);
    private static readonly Vector3 SprintRotation = new(-.35f, .62f, .28f);
    private static readonly Vector3 MantlePosition = new(.24f, -.34f, -.28f);
    private static readonly Vector3 MantleRotation = new(-.70f, .50f, .40f);
    private static readonly Vector3 CameraForward = new(0, 0, -1);

    private readonly Model _cube;
    private readonly ProceduralModelShader _materials;
    private readonly Texture2D _glassAlbedo;
    private readonly Texture2D _glassNormal;
    private WeaponDef? _definition;
    private string _currentWeaponId = string.Empty;

    private Vector3 _position = HipPosition;
    private Vector3 _rotation = HipRotation;
    private Vector3 _rootPosition = HipPosition;
    private Vector3 _rootRotation = HipRotation;

    private double _swayYaw;
    private double _swayPitch;
    private double _recoilPitch;
    private double _recoilYaw;
    private double _recoilZ;
    private double _landDip;
    private double _bobPhase;
    private double _bobAmount;
    private double _reloadProgress;
    private double _magazineY;
    private double _magazineRoll;
    private double _boltCycle;
    private double _muzzleFlashTime;
    private double _lastYaw;
    private double _lastPitch;
    private double _lastPlayerX;
    private double _lastPlayerZ;
    private bool _anglesInitialised;
    private bool _positionInitialised;
    private bool _visible = true;
    private bool _disposed;

    /// <summary>Creates GPU geometry shared by every procedural weapon part.</summary>
    public WeaponViewRenderer()
    {
        _cube = Raylib.LoadModelFromMesh(Raylib.GenMeshCube(1, 1, 1));
        _materials = new ProceduralModelShader();
        var textureRoot = Path.Combine(AppContext.BaseDirectory, "Assets", "Textures");
        _glassAlbedo = LoadSurfaceTexture(Path.Combine(textureRoot, "glass-albedo.png"));
        _glassNormal = LoadSurfaceTexture(Path.Combine(textureRoot, "glass-normal.png"));
    }

    /// <summary>The weapon definition currently driving the renderer.</summary>
    public string CurrentWeaponId => _currentWeaponId;

    /// <summary>The final camera-local position produced by the animation rig.</summary>
    public Vector3 Position => _rootPosition;

    /// <summary>The final camera-local XYZ Euler rotation, in radians.</summary>
    public Vector3 Rotation => _rootRotation;

    /// <summary>Controls whether <see cref="Draw"/> emits the view model.</summary>
    public bool Visible
    {
        get => _visible;
        set => _visible = value;
    }

    /// <summary>
    /// Consumes local simulation events. Shot events drive recoil, muzzle flash, and
    /// bolt movement; landing events drive the short vertical landing dip.
    /// </summary>
    public void Observe(IEnumerable<SimEvent> events, int localPlayerId)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        foreach (var simEvent in events)
        {
            switch (simEvent)
            {
                case ShotEvent shot when shot.Player == localPlayerId:
                    {
                        var definition = WeaponData.TryGetWeapon(shot.WeaponId) ?? _definition;
                        if (definition is not null) OnShot(definition, shot.ShotIndex);
                        break;
                    }
                case GenericSimEvent { Type: SimEventType.Land } generic
                    when generic.Player == localPlayerId:
                    OnLand(.6);
                    break;
            }
        }
    }

    /// <summary>Applies the visual recoil impulse for one locally-fired shot.</summary>
    public void OnShot(WeaponDef definition, int shotIndex)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        var recoil = definition.Recoil;
        var step = recoil.Pattern.Count == 0
            ? null
            : recoil.Pattern[Math.Clamp(shotIndex, 0, recoil.Pattern.Count - 1)];
        if (step is not null)
        {
            _recoilPitch += step.Pitch * recoil.ViewKickMultiplier * 2.6;
            _recoilYaw += step.Yaw * recoil.ViewKickMultiplier * 2.2;
        }
        _recoilZ += .018 * recoil.ViewKickMultiplier;
        _muzzleFlashTime = .055;

        if (definition.FireMode == FireMode.BoltAction)
            _boltCycle = 1;
    }

    /// <summary>Applies a landing dip, where <paramref name="impact"/> is normally 0..1.</summary>
    public void OnLand(double impact)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        _landDip = Math.Min(.09, _landDip + Math.Max(0, impact) * .05);
    }

    /// <summary>
    /// Convenience update that derives distance and speed from <paramref name="player"/>.
    /// Use the longer overload when an interpolation layer already tracks frame distance.
    /// </summary>
    public void Update(PlayerState player, WeaponDef definition, double deltaTime)
    {
        var distanceMoved = 0d;
        if (_positionInitialised)
        {
            var deltaX = player.Position.X - _lastPlayerX;
            var deltaZ = player.Position.Z - _lastPlayerZ;
            distanceMoved = Math.Sqrt(deltaX * deltaX + deltaZ * deltaZ);
        }

        var horizontalSpeed = Math.Sqrt(
            player.Velocity.X * player.Velocity.X +
            player.Velocity.Z * player.Velocity.Z);
        Update(
            player,
            definition,
            player.Yaw,
            player.Pitch,
            distanceMoved,
            MathEx.Clamp01(horizontalSpeed / 6),
            deltaTime);
    }

    /// <summary>
    /// Advances ADS, sprint/mantle poses, view lag, walk bob, recoil, reload, swap,
    /// and bolt animations. Angle and distance units match the Core simulation.
    /// </summary>
    public void Update(
        PlayerState player,
        WeaponDef definition,
        double yaw,
        double pitch,
        double distanceMoved,
        double speedFraction,
        double deltaTime)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentOutOfRangeException.ThrowIfNegative(deltaTime);

        SetWeapon(definition);

        if (!_anglesInitialised)
        {
            _lastYaw = yaw;
            _lastPitch = pitch;
            _anglesInitialised = true;
        }

        var ads = MathEx.Clamp01(player.AdsProgress);
        var sprinting = player.MoveState is MoveState.Sprint or MoveState.TacticalSprint;
        var mantling = player.MantleTime > 0 || player.MoveState == MoveState.Mantle;

        var yawDelta = yaw - _lastYaw;
        if (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
        if (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
        var pitchDelta = pitch - _lastPitch;
        _lastYaw = yaw;
        _lastPitch = pitch;

        var swayScale = MathEx.Lerp(1, .18, ads) * definition.Handling.SwayAmount * 34;
        _swayYaw = Math.Clamp(_swayYaw + yawDelta * swayScale, -.09, .09);
        _swayPitch = Math.Clamp(_swayPitch + pitchDelta * swayScale, -.07, .07);
        _swayYaw = MathEx.Damp(_swayYaw, 0, 9, deltaTime);
        _swayPitch = MathEx.Damp(_swayPitch, 0, 9, deltaTime);

        _bobPhase += Math.Max(0, distanceMoved) * 1.85;
        _bobAmount = MathEx.Damp(_bobAmount, MathEx.Clamp01(speedFraction), 7, deltaTime);
        var bobScale = _bobAmount * MathEx.Lerp(1, .1, ads);
        var bobX = Math.Sin(_bobPhase) * .014 * bobScale;
        var bobY = Math.Abs(Math.Cos(_bobPhase)) * -.011 * bobScale;
        var bobRoll = Math.Sin(_bobPhase) * .012 * bobScale;

        _recoilPitch = MathEx.Damp(
            _recoilPitch,
            0,
            definition.Recoil.RecoverySpeed * 1.4,
            deltaTime);
        _recoilYaw = MathEx.Damp(
            _recoilYaw,
            0,
            definition.Recoil.RecoverySpeed * 1.4,
            deltaTime);
        _recoilZ = MathEx.Damp(_recoilZ, 0, 12, deltaTime);
        _landDip = MathEx.Damp(_landDip, 0, 10, deltaTime);
        _boltCycle = Math.Max(0, _boltCycle - deltaTime * 4);
        _muzzleFlashTime = Math.Max(0, _muzzleFlashTime - deltaTime);

        var targetPosition = mantling
            ? MantlePosition
            : sprinting && ads < .2
                ? SprintPosition
                : HipPosition;
        var targetRotation = mantling
            ? MantleRotation
            : sprinting && ads < .2
                ? SprintRotation
                : HipRotation;
        var poseRate = ads > .01 ? 1 / Math.Max(.05, definition.Handling.AdsTime) : 12;

        _position = Damp(_position, targetPosition, poseRate, deltaTime);
        _rotation = Damp(_rotation, targetRotation, poseRate, deltaTime);

        var aimOffset = ComputeAdsOffset(definition);
        _rootPosition = new Vector3(
            (float)MathEx.Lerp(_position.X + bobX + _swayYaw, aimOffset.X, ads),
            (float)MathEx.Lerp(_position.Y + bobY - _landDip + _swayPitch, aimOffset.Y, ads),
            (float)MathEx.Lerp(_position.Z + _recoilZ, aimOffset.Z + _recoilZ * .6, ads));
        _rootRotation = new Vector3(
            (float)(MathEx.Lerp(_rotation.X, 0, ads) + _recoilPitch + _swayPitch * .6),
            (float)(MathEx.Lerp(_rotation.Y, 0, ads) + _recoilYaw + _swayYaw * .6),
            (float)MathEx.Lerp(_rotation.Z + bobRoll, 0, ads));

        AnimateAction(player, definition, deltaTime);

        _lastPlayerX = player.Position.X;
        _lastPlayerZ = player.Position.Z;
        _positionInitialised = true;
    }

    /// <summary>
    /// Draws the current weapon in a dedicated 62-degree camera pass with depth
    /// testing disabled, preventing the first-person model from clipping into walls.
    /// </summary>
    public void Draw()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!_visible || _definition is null) return;

        var camera = new Camera3D
        {
            Position = Vector3.Zero,
            Target = CameraForward,
            Up = Vector3.UnitY,
            FovY = 62,
            Projection = CameraProjection.Perspective,
        };

        Raylib.BeginMode3D(camera);
        Rlgl.DisableDepthTest();
        _materials.Begin();
        try
        {
            PushTransform(_rootPosition, _rootRotation);
            DrawWeapon(_definition);
            Rlgl.PopMatrix();
        }
        finally
        {
            _materials.End();
        }
        Raylib.EndMode3D();
    }

    /// <inheritdoc/>
    public void Dispose()
    {
        if (_disposed) return;
        _materials.Dispose();
        Raylib.UnloadTexture(_glassAlbedo);
        Raylib.UnloadTexture(_glassNormal);
        Raylib.UnloadModel(_cube);
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    private void SetWeapon(WeaponDef definition)
    {
        if (definition.Id == _currentWeaponId) return;

        _definition = definition;
        _currentWeaponId = definition.Id;
        _reloadProgress = 0;
        _magazineY = definition.Model.MagStyle == "tube" ? -.026 : -.062;
        _magazineRoll = 0;
        _boltCycle = 0;
    }

    private Vector3 ComputeAdsOffset(WeaponDef definition)
    {
        if (definition.Class == WeaponClass.Melee) return HipPosition;

        var sightHeight = Math.Max(.02, definition.Model.SightHeight);
        var depth = HipPosition.Z - .06f;
        if (definition.Scoped) depth += .04f;
        return new Vector3(0, (float)-sightHeight, depth);
    }

    private void AnimateAction(PlayerState player, WeaponDef definition, double deltaTime)
    {
        if (player.Action == WeaponAction.Reloading)
        {
            var total = Math.Max(.01, definition.Handling.ReloadEmptyTime);
            _reloadProgress = MathEx.Clamp01(1 - player.ActionTimer / total);
            var progress = _reloadProgress;
            var drop = progress < .45
                ? progress / .45
                : 1 - MathEx.Clamp01((progress - .5) / .35);
            _magazineY = -.14 * drop;
            _magazineRoll = -.5 * drop;

            var lift = Math.Sin(progress * Math.PI);
            _rootRotation.X += (float)(.22 * lift);
            _rootRotation.Z += (float)(.16 * lift);
            _rootPosition.Y -= (float)(.05 * lift);
        }
        else
        {
            _magazineY = MathEx.Damp(_magazineY, 0, 14, deltaTime);
            _magazineRoll = MathEx.Damp(_magazineRoll, 0, 14, deltaTime);
        }

        if (player.Action == WeaponAction.Swapping)
        {
            var progress = MathEx.Clamp01(
                player.ActionTimer / Math.Max(.01, definition.Handling.HolsterTime));
            _rootPosition.Y -= (float)(.35 * progress);
            _rootRotation.X -= (float)(.9 * progress);
        }
    }

    private void DrawWeapon(WeaponDef definition)
    {
        var palette = Palette.From(definition.Model);
        if (definition.Id == "riot_shield" && definition.Model.MagStyle == "none")
        {
            DrawRiotShield(palette);
            return;
        }

        var model = definition.Model;
        var length = Math.Max(.16, model.Length);
        var front = -length * .62;
        var rear = length * .38;
        var barrelLength = Math.Clamp(model.BarrelLength, .06, length * .85);
        var breech = front + barrelLength;
        var stockLength = model.StockStyle == "none" ? 0 : length * .26;
        var receiverBack = rear - stockLength;
        var receiverLength = Math.Max(.12, receiverBack - breech);
        var receiverZ = breech + receiverLength / 2;

        DrawTube(.0105, barrelLength, 0, 0, front + barrelLength / 2, palette.Steel, 12);
        DrawTube(.016, .042, 0, 0, front + .021, palette.Steel, 10);
        DrawTube(.013, .014, 0, 0, front + .048, palette.Body, 10);

        var handguardLength = barrelLength * .72;
        var handguardZ = front + barrelLength - handguardLength / 2;
        DrawBox(.050, .052, handguardLength, 0, -.002, handguardZ, palette.Furniture);
        for (var index = 0; index < 3; index++)
        {
            var z = handguardZ - handguardLength * .25 + index * handguardLength / 4;
            DrawBox(.054, .008, .012, 0, .020, z, palette.Steel);
        }
        DrawBox(.030, .034, .030, 0, .010, front + barrelLength * .24, palette.Steel);

        DrawBox(.052, .078, receiverLength, 0, 0, receiverZ, palette.Body);
        DrawBox(.044, .018, receiverLength * .92, 0, .046, receiverZ, palette.Body);
        var magazineZ = receiverBack - .15;
        DrawBox(.042, .040, .076, 0, -.050, magazineZ, palette.Body);

        var gripZ = receiverBack - .035;
        DrawBox(.034, .118, .046, 0, -.098, gripZ + .028, palette.Furniture, -.30);
        var guardZ = receiverBack - .090;
        DrawBox(.010, .050, .012, 0, -.062, guardZ - .030, palette.Body);
        DrawBox(.010, .050, .012, 0, -.062, guardZ + .030, palette.Body);
        DrawBox(.010, .012, .072, 0, -.083, guardZ, palette.Body);
        DrawBox(.008, .030, .009, 0, -.055, guardZ + .010, palette.Steel);

        var boltOffset = .05 * Math.Sin(_boltCycle * Math.PI);
        Rlgl.PushMatrix();
        Rlgl.Translatef(0, .026f, (float)(receiverZ + boltOffset));
        DrawBox(.038, .026, receiverLength * .55, 0, 0, 0, palette.Steel);
        DrawBox(.030, .012, .014, .030, .004, receiverLength * .22, palette.Steel);
        Rlgl.PopMatrix();

        var magazineGroupZ = model.MagStyle == "tube"
            ? front + barrelLength * .55
            : magazineZ;
        Rlgl.PushMatrix();
        Rlgl.Translatef(0, (float)_magazineY, (float)magazineGroupZ);
        Rlgl.Rotatef((float)(_magazineRoll * MathEx.Rad2Deg), 0, 0, 1);
        DrawMagazine(model.MagStyle, front + barrelLength * .55, palette);
        Rlgl.PopMatrix();

        DrawStock(model.StockStyle, receiverBack, rear, palette);

        var sightHeight = Math.Max(.02, model.SightHeight);
        var rearSightZ = receiverBack - .045;
        if (model.HasCarryHandle)
        {
            var handleLength = receiverLength * .55;
            var handleZ = receiverZ + receiverLength * .12;
            var railY = sightHeight - .016;
            DrawBox(.026, .014, handleLength, 0, railY, handleZ, palette.Body);
            DrawBox(
                .024,
                railY - .052,
                .016,
                0,
                (railY + .052) / 2,
                handleZ - handleLength / 2 + .01,
                palette.Body);
            DrawBox(
                .024,
                railY - .052,
                .016,
                0,
                (railY + .052) / 2,
                handleZ + handleLength / 2 - .01,
                palette.Body);
            rearSightZ = handleZ + handleLength / 2 - .02;
        }

        DrawIronSights(sightHeight, rearSightZ, front + .055, palette.Sight);

        if (_muzzleFlashTime > 0)
            DrawMuzzleFlash(front);
    }

    private void DrawMagazine(string style, double barrelZ, Palette palette)
    {
        switch (style)
        {
            case "stick":
                DrawBox(.030, .090, .062, 0, -.045, .004, palette.Furniture, .10);
                DrawBox(.029, .085, .058, 0, -.126, .020, palette.Furniture, .22);
                DrawBox(.032, .010, .064, 0, -.166, .029, palette.Body, .22);
                break;
            case "box":
                DrawBox(.050, .130, .086, 0, -.068, .006, palette.Furniture);
                DrawBox(.054, .012, .090, 0, -.138, .006, palette.Body);
                break;
            case "drum":
                _materials.Configure(0, palette.Furniture.Roughness, palette.Furniture.Metalness, 1);
                Raylib.DrawCylinderEx(
                    new Vector3(-.022f, -.082f, .01f),
                    new Vector3(.022f, -.082f, .01f),
                    .078f,
                    .078f,
                    16,
                    palette.Furniture.Color);
                DrawBox(.030, .050, .055, 0, -.024, .004, palette.Body);
                break;
            case "tube":
                DrawTube(.017, Math.Abs(barrelZ) * .9, 0, 0, 0, palette.Steel, 10);
                DrawBox(.020, .020, .018, 0, .014, Math.Abs(barrelZ) * .42, palette.Body);
                break;
            case "none":
                break;
        }
    }

    private void DrawStock(string style, double from, double to, Palette palette)
    {
        var length = to - from;
        if (length <= .01) return;
        var middle = from + length / 2;

        switch (style)
        {
            case "fixed":
                DrawBox(.046, .074, length, 0, -.014, middle, palette.Furniture);
                DrawBox(.052, .096, .014, 0, -.020, to, palette.Body);
                DrawBox(.036, .016, length * .6, 0, .030, middle + length * .1, palette.Furniture);
                break;
            case "folding":
                DrawBox(.020, .026, .030, 0, -.006, from + .015, palette.Steel);
                DrawBox(.018, .052, length * .92, -.044, -.004, middle, palette.Steel);
                DrawBox(.022, .070, .012, -.044, -.004, to, palette.Furniture);
                break;
            case "skeleton":
                const double bar = .014;
                DrawBox(bar, bar, length, 0, .026, middle, palette.Steel);
                DrawBox(bar, bar, length, 0, -.038, middle, palette.Steel);
                DrawBox(.044, .090, .014, 0, -.006, to, palette.Furniture);
                DrawBox(.030, .014, length * .45, 0, .038, middle + length * .18, palette.Furniture);
                break;
            case "none":
                break;
        }
    }

    private void DrawIronSights(double height, double rearZ, double frontZ, PartMaterial color)
    {
        DrawBox(.006, .024, .007, -.012, height - .004, rearZ, color);
        DrawBox(.006, .024, .007, .012, height - .004, rearZ, color);
        DrawBox(.030, .006, .007, 0, height + .010, rearZ, color);

        DrawBox(.005, .022, .005, 0, height - .006, frontZ, color);
        DrawBox(.005, .026, .006, -.013, height - .004, frontZ, color);
        DrawBox(.005, .026, .006, .013, height - .004, frontZ, color);
        DrawBox(.031, .005, .006, 0, height + .011, frontZ, color);
    }

    private void DrawRiotShield(Palette palette)
    {
        const double width = .62;
        const double height = .98;
        const double thickness = .032;
        const double panelZ = -.30;
        const double panelY = .10;
        const double viewWidth = .30;
        const double viewHeight = .15;
        const double viewY = panelY + .26;

        var top = panelY + height / 2;
        var bottom = panelY - height / 2;
        var upper = top - (viewY + viewHeight / 2);
        var lower = viewY - viewHeight / 2 - bottom;
        var side = (width - viewWidth) / 2;

        DrawBox(width, upper, thickness, 0, top - upper / 2, panelZ, palette.Body);
        DrawBox(width, lower, thickness, 0, bottom + lower / 2, panelZ, palette.Body);
        DrawBox(side, viewHeight, thickness, -(viewWidth + side) / 2, viewY, panelZ, palette.Body);
        DrawBox(side, viewHeight, thickness, (viewWidth + side) / 2, viewY, panelZ, palette.Body);
        DrawBox(
            viewWidth,
            viewHeight,
            thickness * .4,
            0,
            viewY,
            panelZ,
            new PartMaterial(new Color(168, 192, 204, 87), 0, .05f, true));

        DrawBox(width * .94, .026, .014, 0, panelY - .30, panelZ + thickness * .7, palette.Furniture);
        DrawBox(width * .94, .026, .014, 0, panelY + .10, panelZ + thickness * .7, palette.Furniture);
        DrawBox(.030, .030, .16, .05, panelY - .06, panelZ + .10, palette.Furniture);
    }

    private void DrawMuzzleFlash(double muzzleZ)
    {
        var life = (float)MathEx.Clamp01(_muzzleFlashTime / .055);
        var outer = new Color(255, 145, 35, (int)(190 * life));
        var core = new Color(255, 241, 171, (int)(245 * life));
        var muzzle = new Vector3(0, 0, (float)muzzleZ);
        _materials.Configure(2, .22f, .7f, 24);
        Raylib.DrawSphere(muzzle, .025f + .025f * life, core);
        Raylib.DrawCylinderEx(
            muzzle,
            muzzle + new Vector3(0, 0, -.14f - .06f * life),
            .045f * life,
            .002f,
            8,
            outer);
    }

    private void DrawBox(
        double width,
        double height,
        double depth,
        double x,
        double y,
        double z,
        PartMaterial material,
        double rotationX = 0)
    {
        if (material.Textured)
            _materials.ConfigureTextured(_glassAlbedo, _glassNormal, material.Roughness, material.Metalness);
        else
            _materials.Configure(0, material.Roughness, material.Metalness, 1);
        Rlgl.PushMatrix();
        Rlgl.Translatef((float)x, (float)y, (float)z);
        if (rotationX != 0)
            Rlgl.Rotatef((float)(rotationX * MathEx.Rad2Deg), 1, 0, 0);
        Raylib.DrawModelEx(
            _cube,
            Vector3.Zero,
            Vector3.UnitY,
            0,
            new Vector3((float)width, (float)height, (float)depth),
            material.Color);
        Rlgl.PopMatrix();
    }

    private void DrawTube(
        double radius,
        double length,
        double x,
        double y,
        double z,
        PartMaterial material,
        int segments)
    {
        _materials.Configure(0, material.Roughness, material.Metalness, 1);
        var half = (float)(length / 2);
        var centre = new Vector3((float)x, (float)y, (float)z);
        Raylib.DrawCylinderEx(
            centre + new Vector3(0, 0, -half),
            centre + new Vector3(0, 0, half),
            (float)radius,
            (float)radius,
            segments,
            material.Color);
    }

    private static void PushTransform(Vector3 position, Vector3 rotation)
    {
        Rlgl.PushMatrix();
        Rlgl.Translatef(position.X, position.Y, position.Z);
        Rlgl.Rotatef(rotation.Z * (float)MathEx.Rad2Deg, 0, 0, 1);
        Rlgl.Rotatef(rotation.Y * (float)MathEx.Rad2Deg, 0, 1, 0);
        Rlgl.Rotatef(rotation.X * (float)MathEx.Rad2Deg, 1, 0, 0);
    }

    private static Vector3 Damp(Vector3 current, Vector3 target, double rate, double deltaTime) =>
        new(
            (float)MathEx.Damp(current.X, target.X, rate, deltaTime),
            (float)MathEx.Damp(current.Y, target.Y, rate, deltaTime),
            (float)MathEx.Damp(current.Z, target.Z, rate, deltaTime));

    private static Texture2D LoadSurfaceTexture(string path)
    {
        var texture = Raylib.LoadTexture(path);
        Raylib.GenTextureMipmaps(ref texture);
        Raylib.SetTextureFilter(texture, TextureFilter.Trilinear);
        Raylib.SetTextureWrap(texture, TextureWrap.Repeat);
        return texture;
    }

    private readonly record struct PartMaterial(
        Color Color, float Metalness, float Roughness, bool Textured = false);

    private readonly record struct Palette(
        PartMaterial Body, PartMaterial Furniture, PartMaterial Steel, PartMaterial Sight)
    {
        public static Palette From(WeaponModelDef model) => new(
            new(FromPacked(model.Color), .55f, .44f),
            new(FromPacked(model.AccentColor), .18f, .66f),
            new(FromPacked(Darken(model.Color, .55)), .90f, .30f),
            new(new Color(14, 16, 18, 255), .80f, .42f));

        private static Color FromPacked(int packed) => new(
            (byte)((packed >> 16) & 0xff),
            (byte)((packed >> 8) & 0xff),
            (byte)(packed & 0xff),
            (byte)255);

        private static int Darken(int packed, double factor)
        {
            var red = JsRound(((packed >> 16) & 0xff) * factor);
            var green = JsRound(((packed >> 8) & 0xff) * factor);
            var blue = JsRound((packed & 0xff) * factor);
            return red << 16 | green << 8 | blue;
        }

        private static int JsRound(double value) => (int)Math.Floor(value + .5);
    }
}

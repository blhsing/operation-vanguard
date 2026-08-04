using System.Globalization;
using System.Numerics;
using OperationVanguard.Core;
using Raylib_cs;

namespace OperationVanguard.Game.Rendering;

/// <summary>
/// Procedural world presentation for authored Zombies interactables. The
/// renderer only observes session/director state and owns no gameplay state.
/// </summary>
public sealed class ZombiesWorldRenderer : IDisposable
{
    private static readonly Color DoorColor = new(160, 94, 42, 255);
    private static readonly Color WallBuyColor = new(80, 188, 238, 255);
    private static readonly Color MysteryColor = new(232, 177, 52, 255);
    private static readonly Color PackColor = new(160, 80, 224, 255);
    private static readonly Color PowerOffColor = new(174, 52, 43, 255);
    private static readonly Color PowerOnColor = new(75, 214, 112, 255);
    private static readonly Color UsableColor = new(83, 232, 132, 255);
    private static readonly Color BlockedColor = new(244, 83, 69, 255);
    private static readonly Color LockedColor = new(78, 84, 89, 255);
    private static readonly Color DarkMetal = new(31, 36, 39, 255);

    private readonly Model _cube;
    private readonly ProceduralModelShader _materials;
    private bool _disposed;

    public ZombiesWorldRenderer()
    {
        _cube = Raylib.LoadModelFromMesh(Raylib.GenMeshCube(1, 1, 1));
        _materials = new ProceduralModelShader();
    }

    /// <summary>Convenience overload for callers that retain the concrete session.</summary>
    public void Draw(ZombiesSession session) => Draw(
        session.Data,
        session.Director,
        session.Player,
        session.World.Time);

    /// <summary>
    /// Draw all authored interactables and the local proximity beacon. Call
    /// this between <c>Raylib.BeginMode3D(camera)</c> and <c>Raylib.EndMode3D()</c>.
    /// </summary>
    public void Draw(
        ZombiesMapData data,
        ZombiesDirector director,
        PlayerState localPlayer,
        double worldTime)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        director.Players.TryGetValue(localPlayer.Id, out var localState);
        var near = director.InteractableNear(localPlayer.Id);
        _materials.Begin();
        try
        {
            foreach (var definition in data.Interactables)
            {
                var zoneOpen = director.State.OpenZones.Contains(definition.Zone);
                var selected = near?.Def.Id == definition.Id;
                var color = InteractableColor(definition, director, localState, zoneOpen);

                switch (definition.Kind)
                {
                    case InteractKind.Door: DrawDoor(definition, director.State, color); break;
                    case InteractKind.WallBuy: DrawWallBuy(definition, localState, color); break;
                    case InteractKind.MysteryBox: DrawMysteryBox(definition, color, worldTime); break;
                    case InteractKind.PackAPunch:
                        DrawPackAPunch(definition, director.State.PowerOn, color, worldTime);
                        break;
                    case InteractKind.PerkMachine: DrawPerkMachine(definition, localState, color, worldTime); break;
                    case InteractKind.Power: DrawPower(definition, director.State.PowerOn, color, worldTime); break;
                    default: throw new ArgumentOutOfRangeException(nameof(definition.Kind), definition.Kind, null);
                }

                if (selected && near is not null) DrawProximityBeacon(definition, near.Usable, worldTime);
                else DrawIdleMarker(definition.Position, color, zoneOpen);
            }
        }
        finally
        {
            _materials.End();
        }
    }

    /// <summary>Convenience overload for callers that retain the concrete session.</summary>
    public void DrawOverlay(ZombiesSession session, Camera3D camera, UiFont font) =>
        DrawOverlay(session.Director, session.Player, camera, font);

    /// <summary>
    /// Draw the nearby interaction label, cost, and usable/unusable reason.
    /// Call this after <c>Raylib.EndMode3D()</c> with the camera used for the
    /// world pass.
    /// </summary>
    public void DrawOverlay(
        ZombiesDirector director,
        PlayerState localPlayer,
        Camera3D camera,
        UiFont font)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        var near = director.InteractableNear(localPlayer.Id);
        if (near is null)
        {
            return;
        }

        var anchor = ToNumerics(near.Def.Position) + Vector3.UnitY * CueHeight(near.Def.Kind);
        var cameraForward = camera.Target - camera.Position;
        if (cameraForward.LengthSquared() <= float.Epsilon ||
            Vector3.Dot(anchor - camera.Position, cameraForward) <= 0f)
        {
            return;
        }

        var screen = Raylib.GetWorldToScreen(anchor, camera);
        var screenWidth = Raylib.GetScreenWidth();
        var screenHeight = Raylib.GetScreenHeight();
        if (screen.X < -240 || screen.X > screenWidth + 240 ||
            screen.Y < -100 || screen.Y > screenHeight + 100)
        {
            return;
        }

        var title = string.IsNullOrWhiteSpace(near.Def.Label)
            ? KindLabel(near.Def.Kind)
            : near.Def.Label;
        var detail = near.Usable
            ? near.Cost > 0
                ? $"[F / E]  {FormatPoints(near.Cost)} PTS"
                : "[F / E]  INTERACT"
            : BlockedLabel(near.Reason, near.Cost);
        var cueColor = near.Usable ? UsableColor : BlockedColor;

        const float titleSize = 18f;
        const float detailSize = 14f;
        const float horizontalPadding = 18f;
        var titleWidth = font.Measure(title, titleSize).X;
        var detailWidth = font.Measure(detail, detailSize, 1f).X;
        var panelWidth = Math.Clamp(Math.Max(titleWidth, detailWidth) + horizontalPadding * 2, 190f, 430f);
        const float panelHeight = 62f;
        var panelX = Math.Clamp(screen.X - panelWidth / 2f, 12f, screenWidth - panelWidth - 12f);
        var panelY = Math.Clamp(screen.Y - panelHeight - 14f, 12f, screenHeight - panelHeight - 12f);

        Raylib.DrawRectangle(
            (int)panelX,
            (int)panelY,
            (int)panelWidth,
            (int)panelHeight,
            new Color(11, 15, 18, 226));
        Raylib.DrawRectangle((int)panelX, (int)panelY, 4, (int)panelHeight, cueColor);
        Raylib.DrawRectangle(
            (int)panelX + 4,
            (int)panelY,
            (int)panelWidth - 4,
            1,
            new Color(cueColor.R, cueColor.G, cueColor.B, (byte)115));
        font.Draw(title, panelX + horizontalPadding, panelY + 8f, titleSize,
            new Color(235, 241, 244, 255));
        font.Draw(detail, panelX + horizontalPadding, panelY + 36f, detailSize, cueColor, 1f);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _materials.Dispose();
        Raylib.UnloadModel(_cube);
        _disposed = true;
        GC.SuppressFinalize(this);
    }

    private void DrawDoor(ZombieInteractableDef definition, ZombiesState state, Color color)
    {
        var opened = !string.IsNullOrEmpty(definition.OpensZone) &&
                     state.OpenZones.Contains(definition.OpensZone);
        if (opened)
        {
            // Split panels leave the path visually open while preserving the
            // authored doorway as a recognizable landmark.
            DrawPart(definition.Position, new Vector3(-1.08f, 1.1f, 0), new Vector3(.22f, 2.2f, .22f),
                definition.Yaw, Shade(color, .68));
            DrawPart(definition.Position, new Vector3(1.08f, 1.1f, 0), new Vector3(.22f, 2.2f, .22f),
                definition.Yaw, Shade(color, .68));
            DrawPart(definition.Position, new Vector3(0, .035f, 0), new Vector3(1.9f, .07f, .35f),
                definition.Yaw, new Color(PowerOnColor.R, PowerOnColor.G, PowerOnColor.B, (byte)120));
            return;
        }

        DrawPart(definition.Position, new Vector3(0, 1.08f, 0), new Vector3(1.9f, 2.16f, .18f),
            definition.Yaw, Shade(color, .62));
        DrawPart(definition.Position, new Vector3(0, .48f, -.12f), new Vector3(2.05f, .16f, .12f),
            definition.Yaw, color);
        DrawPart(definition.Position, new Vector3(0, 1.12f, -.12f), new Vector3(2.05f, .16f, .12f),
            definition.Yaw, color);
        DrawPart(definition.Position, new Vector3(0, 1.76f, -.12f), new Vector3(2.05f, .16f, .12f),
            definition.Yaw, color);
        DrawPart(definition.Position, new Vector3(-.65f, 1.08f, -.13f), new Vector3(.12f, 2.05f, .1f),
            definition.Yaw, Shade(color, 1.18));
        DrawPart(definition.Position, new Vector3(.65f, 1.08f, -.13f), new Vector3(.12f, 2.05f, .1f),
            definition.Yaw, Shade(color, 1.18));
    }

    private void DrawWallBuy(ZombieInteractableDef definition, ZombiePlayerState? localState, Color color)
    {
        var owned = localState?.OwnedWallWeapons.Contains(definition.WeaponId ?? string.Empty) == true;
        var accent = owned ? UsableColor : color;
        DrawPart(definition.Position, Vector3.Zero, new Vector3(1.25f, .72f, .08f), definition.Yaw,
            new Color(25, 33, 38, 220));
        DrawPart(definition.Position, new Vector3(0, 0, -.055f), new Vector3(1.12f, .59f, .035f),
            definition.Yaw, new Color(accent.R, accent.G, accent.B, (byte)75));

        // Generic rifle silhouette: stock, receiver, barrel, magazine and grip.
        DrawPart(definition.Position, new Vector3(-.36f, .02f, -.105f), new Vector3(.28f, .16f, .045f),
            definition.Yaw, accent);
        DrawPart(definition.Position, new Vector3(-.04f, .02f, -.105f), new Vector3(.42f, .2f, .05f),
            definition.Yaw, accent);
        DrawPart(definition.Position, new Vector3(.35f, .04f, -.105f), new Vector3(.42f, .065f, .04f),
            definition.Yaw, accent);
        DrawPart(definition.Position, new Vector3(.02f, -.16f, -.105f), new Vector3(.13f, .22f, .045f),
            definition.Yaw, accent);
        DrawPart(definition.Position, new Vector3(-.13f, -.15f, -.105f), new Vector3(.08f, .2f, .04f),
            definition.Yaw, accent);
    }

    private void DrawMysteryBox(ZombieInteractableDef definition, Color color, double worldTime)
    {
        DrawPart(definition.Position, new Vector3(0, .36f, 0), new Vector3(1.18f, .62f, .72f),
            definition.Yaw, new Color(74, 48, 27, 255));
        DrawPart(definition.Position, new Vector3(0, .7f, 0), new Vector3(1.24f, .16f, .78f),
            definition.Yaw, Shade(color, .85));
        DrawPart(definition.Position, new Vector3(-.48f, .37f, -.38f), new Vector3(.08f, .54f, .06f),
            definition.Yaw, color);
        DrawPart(definition.Position, new Vector3(.48f, .37f, -.38f), new Vector3(.08f, .54f, .06f),
            definition.Yaw, color);

        var centre = ToNumerics(definition.Position) + Vector3.UnitY * 1.15f;
        var glow = .88f + (float)Math.Sin(worldTime * 3d) * .08f;
        Raylib.DrawSphere(centre + new Vector3(.08f, .12f, 0), .13f, Shade(color, glow));
        Raylib.DrawSphere(centre + new Vector3(-.06f, -.02f, 0), .11f, Shade(color, glow));
        Raylib.DrawCylinderEx(
            centre + new Vector3(-.11f, -.14f, 0),
            centre + new Vector3(-.11f, -.34f, 0),
            .055f,
            .055f,
            8,
            Shade(color, glow));
        Raylib.DrawSphere(centre + new Vector3(-.11f, -.49f, 0), .065f, Shade(color, glow));
    }

    private void DrawPackAPunch(
        ZombieInteractableDef definition,
        bool powerOn,
        Color color,
        double worldTime)
    {
        var active = powerOn ? color : LockedColor;
        DrawPart(definition.Position, new Vector3(0, .72f, 0), new Vector3(1.05f, 1.42f, .72f),
            definition.Yaw, Shade(active, .48));
        DrawPart(definition.Position, new Vector3(0, .86f, -.39f), new Vector3(.7f, .58f, .08f),
            definition.Yaw, new Color(active.R, active.G, active.B, (byte)220));
        DrawPart(definition.Position, new Vector3(0, .31f, -.41f), new Vector3(.6f, .22f, .1f),
            definition.Yaw, DarkMetal);
        DrawPart(definition.Position, new Vector3(-.43f, 1.28f, 0), new Vector3(.15f, .4f, .82f),
            definition.Yaw, active);
        DrawPart(definition.Position, new Vector3(.43f, 1.28f, 0), new Vector3(.15f, .4f, .82f),
            definition.Yaw, active);

        var pulse = .78f + (float)(Math.Sin(worldTime * 4d) * .16d);
        Raylib.DrawSphere(
            ToNumerics(definition.Position) + Vector3.UnitY * 1.6f,
            .16f,
            powerOn ? Shade(active, 1.15, pulse) : LockedColor);
    }

    private void DrawPerkMachine(
        ZombieInteractableDef definition,
        ZombiePlayerState? localState,
        Color color,
        double worldTime)
    {
        var owned = localState?.Perks.Contains(definition.PerkId ?? string.Empty, StringComparer.Ordinal) == true;
        var accent = owned ? UsableColor : color;
        DrawPart(definition.Position, new Vector3(0, .7f, 0), new Vector3(.72f, 1.38f, .58f),
            definition.Yaw, Shade(accent, .52));
        DrawPart(definition.Position, new Vector3(0, .83f, -.315f), new Vector3(.52f, .62f, .07f),
            definition.Yaw, new Color(accent.R, accent.G, accent.B, (byte)225));
        DrawPart(definition.Position, new Vector3(0, .36f, -.34f), new Vector3(.4f, .16f, .08f),
            definition.Yaw, DarkMetal);
        DrawPart(definition.Position, new Vector3(0, 1.45f, 0), new Vector3(.82f, .16f, .66f),
            definition.Yaw, accent);

        var top = ToNumerics(definition.Position) + Vector3.UnitY * 1.67f;
        var glow = owned ? 1.12 : .92 + Math.Sin(worldTime * 2.5d) * .08;
        Raylib.DrawSphere(top, .13f, Shade(accent, glow));
    }

    private void DrawPower(
        ZombieInteractableDef definition,
        bool powerOn,
        Color color,
        double worldTime)
    {
        var accent = powerOn ? PowerOnColor : color;
        DrawPart(definition.Position, new Vector3(0, .62f, 0), new Vector3(.78f, 1.22f, .58f),
            definition.Yaw, Shade(accent, .42));
        DrawPart(definition.Position, new Vector3(0, .72f, -.32f), new Vector3(.55f, .65f, .07f),
            definition.Yaw, DarkMetal);
        DrawPart(definition.Position, new Vector3(0, .95f, -.38f), new Vector3(.38f, .08f, .06f),
            definition.Yaw, accent);

        var front = Transform(definition.Position, new Vector3(0, .55f, -.42f), definition.Yaw);
        var leverEnd = front + new Vector3(
            (float)(Math.Cos(definition.Yaw) * .2d),
            powerOn ? -.28f : .28f,
            (float)(-Math.Sin(definition.Yaw) * .2d));
        Raylib.DrawCylinderEx(front, leverEnd, .055f, .055f, 8, new Color(190, 196, 198, 255));
        Raylib.DrawSphere(leverEnd, .09f, accent);

        var light = ToNumerics(definition.Position) + Vector3.UnitY * 1.38f;
        var glow = powerOn ? .85 + Math.Sin(worldTime * 5d) * .15 : .7;
        Raylib.DrawSphere(light, .095f, Shade(accent, 1.15, glow));
    }

    private static void DrawProximityBeacon(
        ZombieInteractableDef definition,
        bool usable,
        double worldTime)
    {
        var color = usable ? UsableColor : BlockedColor;
        var basePosition = ToNumerics(definition.Position) + Vector3.UnitY * .035f;
        var pulse = .5f + (float)(Math.Sin(worldTime * 5d) * .5d);
        var radius = .62f + pulse * .12f;
        DrawGroundRing(basePosition, radius, color);
        DrawGroundRing(basePosition + Vector3.UnitY * .018f, radius * .78f,
            new Color(color.R, color.G, color.B, (byte)150));

        var top = basePosition + Vector3.UnitY * (CueHeight(definition.Kind) - .1f + pulse * .12f);
        Raylib.DrawLine3D(basePosition, top, new Color(color.R, color.G, color.B, (byte)130));
        DrawDiamond(top, .16f, color);
    }

    private static void DrawIdleMarker(Vec3 position, Color color, bool zoneOpen)
    {
        var alpha = zoneOpen ? (byte)80 : (byte)36;
        DrawGroundRing(
            ToNumerics(position) + Vector3.UnitY * .025f,
            .32f,
            new Color(color.R, color.G, color.B, alpha));
    }

    private static void DrawGroundRing(Vector3 centre, float radius, Color color)
    {
        const int segments = 28;
        var previous = centre + new Vector3(radius, 0, 0);
        for (var index = 1; index <= segments; index++)
        {
            var angle = index * MathF.Tau / segments;
            var next = centre + new Vector3(MathF.Cos(angle) * radius, 0, MathF.Sin(angle) * radius);
            Raylib.DrawLine3D(previous, next, color);
            previous = next;
        }
    }

    private static void DrawDiamond(Vector3 centre, float radius, Color color)
    {
        var top = centre + Vector3.UnitY * radius;
        var bottom = centre - Vector3.UnitY * radius;
        var east = centre + Vector3.UnitX * radius;
        var west = centre - Vector3.UnitX * radius;
        var north = centre + Vector3.UnitZ * radius;
        var south = centre - Vector3.UnitZ * radius;
        foreach (var edge in new[]
                 {
                     (top, east), (top, west), (top, north), (top, south),
                     (bottom, east), (bottom, west), (bottom, north), (bottom, south),
                 })
        {
            Raylib.DrawLine3D(edge.Item1, edge.Item2, color);
        }
    }

    private void DrawPart(Vec3 origin, Vector3 offset, Vector3 size, double yaw, Color color)
    {
        var metallic = color.R < 120 && color.G < 130 && color.B < 135;
        _materials.Configure(metallic ? 2 : 5, metallic ? .38f : .68f, metallic ? .72f : .18f, 14);
        Raylib.DrawModelEx(
            _cube,
            Transform(origin, offset, yaw),
            Vector3.UnitY,
            (float)(yaw * MathEx.Rad2Deg),
            size,
            color);
    }

    private static Vector3 Transform(Vec3 origin, Vector3 offset, double yaw)
    {
        var cosine = (float)Math.Cos(yaw);
        var sine = (float)Math.Sin(yaw);
        return new Vector3(
            (float)origin.X + offset.X * cosine + offset.Z * sine,
            (float)origin.Y + offset.Y,
            (float)origin.Z - offset.X * sine + offset.Z * cosine);
    }

    private static Color InteractableColor(
        ZombieInteractableDef definition,
        ZombiesDirector director,
        ZombiePlayerState? localState,
        bool zoneOpen)
    {
        if (!zoneOpen)
        {
            return LockedColor;
        }

        return definition.Kind switch
        {
            InteractKind.Door => DoorColor,
            InteractKind.WallBuy => WallBuyColor,
            InteractKind.MysteryBox => MysteryColor,
            InteractKind.PackAPunch => director.State.PowerOn ? PackColor : LockedColor,
            InteractKind.Power => director.State.PowerOn ? PowerOnColor : PowerOffColor,
            InteractKind.PerkMachine => PerkColor(definition, localState),
            _ => new Color(205, 211, 214, 255),
        };
    }

    private static Color PerkColor(ZombieInteractableDef definition, ZombiePlayerState? localState)
    {
        if (!string.IsNullOrEmpty(definition.PerkId) &&
            localState?.Perks.Contains(definition.PerkId, StringComparer.Ordinal) == true)
        {
            return UsableColor;
        }

        return !string.IsNullOrEmpty(definition.PerkId) &&
               ZombieData.Perks.TryGetValue(definition.PerkId, out var perk)
            ? FromHex(perk.Color)
            : new Color(91, 170, 206, 255);
    }

    private static string BlockedLabel(string reason, int cost) => reason switch
    {
        "area locked" => "AREA LOCKED",
        "needs power" => "NEEDS POWER",
        "already open" => "ALREADY OPEN",
        "already on" => "POWER IS ON",
        "already owned" => "ALREADY OWNED",
        "no perk slots" => "PERK SLOTS FULL",
        "already upgraded" => "ALREADY UPGRADED",
        "unavailable" => "UNAVAILABLE",
        _ when reason.StartsWith("need ", StringComparison.Ordinal) => $"NEED {FormatPoints(cost)} PTS",
        _ => string.IsNullOrWhiteSpace(reason) ? "UNAVAILABLE" : reason.ToUpperInvariant(),
    };

    private static string KindLabel(InteractKind kind) => kind switch
    {
        InteractKind.Door => "DOOR",
        InteractKind.WallBuy => "WALL BUY",
        InteractKind.MysteryBox => "MYSTERY BOX",
        InteractKind.PackAPunch => "PACK-A-PUNCH",
        InteractKind.PerkMachine => "PERK MACHINE",
        InteractKind.Power => "POWER",
        _ => "INTERACT",
    };

    private static float CueHeight(InteractKind kind) => kind switch
    {
        InteractKind.Door => 2.65f,
        InteractKind.WallBuy => 1.15f,
        InteractKind.MysteryBox => 1.65f,
        InteractKind.PackAPunch => 2.05f,
        InteractKind.PerkMachine => 2.05f,
        InteractKind.Power => 1.9f,
        _ => 1.6f,
    };

    private static string FormatPoints(int points) =>
        points.ToString("N0", CultureInfo.InvariantCulture);

    private static Color FromHex(int value, int alpha = 255) => new(
        (value >> 16) & 0xff,
        (value >> 8) & 0xff,
        value & 0xff,
        alpha);

    private static Color Shade(Color color, double scale, double alphaScale = 1d) => new(
        Math.Clamp((int)Math.Round(color.R * scale), 0, 255),
        Math.Clamp((int)Math.Round(color.G * scale), 0, 255),
        Math.Clamp((int)Math.Round(color.B * scale), 0, 255),
        Math.Clamp((int)Math.Round(color.A * alphaScale), 0, 255));

    private static Vector3 ToNumerics(Vec3 value) =>
        new((float)value.X, (float)value.Y, (float)value.Z);
}

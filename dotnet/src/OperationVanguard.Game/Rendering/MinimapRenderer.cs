using System.Numerics;
using OperationVanguard.Core;
using Raylib_cs;

namespace OperationVanguard.Game.Rendering;

/// <summary>
/// Native counterpart of the web rotating tactical minimap. Static brush
/// geometry rotates around the local player; hostile contacts require a UAV or
/// a recent unsuppressed weapon report.
/// </summary>
public sealed class MinimapRenderer
{
    private const double VisibleRange = 60d;
    private const double GunshotPingDuration = 3d;
    private readonly Dictionary<int, double> _gunshotPings = [];

    public void Observe(IReadOnlyList<SimEvent> events, WorldState world, PlayerState local)
    {
        foreach (var simEvent in events)
        {
            if (simEvent is not ShotEvent { Suppressed: false } shot || shot.Player == local.Id) continue;
            if (!world.Players.TryGetValue(shot.Player, out var shooter)) continue;
            if (!SimulationTypes.IsEnemyTeam(local.Team, shooter.Team)) continue;
            _gunshotPings[shooter.Id] = GunshotPingDuration;
        }
    }

    public void Update(double deltaTime)
    {
        foreach (var id in _gunshotPings.Keys.ToArray())
        {
            var remaining = _gunshotPings[id] - deltaTime;
            if (remaining <= 0) _gunshotPings.Remove(id);
            else _gunshotPings[id] = remaining;
        }
    }

    public void Draw(NativeSession session, UiFont font, int screenWidth)
    {
        const int size = 188;
        const int margin = 25;
        var left = screenWidth - size - margin;
        const int top = 61;
        var center = new Vector2(left + size / 2f, top + size / 2f);
        var local = session.Player;
        var scale = (float)(size / VisibleRange);
        var radius = size / 2f - 4;

        Raylib.DrawCircleV(center, radius + 2, new Color(7, 10, 13, 218));
        Raylib.BeginScissorMode(left + 2, top + 2, size - 4, size - 4);
        DrawBrushes(session.Map, local, center, scale, radius);
        DrawObjectives(session.Map, local, center, scale, radius, font);
        DrawPlayers(session, local, center, scale, radius);
        Raylib.EndScissorMode();

        DrawArrow(center, 0, 7, Color.White);
        var radar = session.Simulation.TeamHasRadar(local.Team);
        Raylib.DrawCircleLinesV(center, radius,
            radar ? new Color(120, 220, 255, 225) : new Color(190, 205, 220, 110));
        if (radar)
        {
            var angle = (float)(session.World.Time * Math.PI);
            var end = center + new Vector2(MathF.Cos(angle), MathF.Sin(angle)) * radius;
            Raylib.DrawLineEx(center, end, 2, new Color(120, 220, 255, 120));
        }
        font.Draw("N", center.X - 5, top + 7, 11, new Color(225, 235, 240, 190));
    }

    private static void DrawBrushes(MapDef map, PlayerState local, Vector2 center, float scale, float radius)
    {
        foreach (var brush in map.Brushes)
        {
            if (!brush.IsVisible || brush.Kind == BrushKind.Plane) continue;
            var dimensions = Dimensions(brush);
            if (dimensions.Height < .6 || dimensions.Width * dimensions.Depth > VisibleRange * VisibleRange * .4)
                continue;
            var offset = RotateOffset(brush.Position.X - local.Position.X, brush.Position.Z - local.Position.Z,
                local.Yaw, scale);
            if (offset.LengthSquared() > (radius + Math.Max(dimensions.Width, dimensions.Depth) * scale) *
                (radius + Math.Max(dimensions.Width, dimensions.Depth) * scale)) continue;

            var color = new Color(145, 162, 174, 64);
            if (brush.Kind == BrushKind.Cylinder)
            {
                Raylib.DrawCircleV(center + offset, (float)(dimensions.Width * scale / 2), color);
                continue;
            }

            var width = (float)Math.Max(1, dimensions.Width * scale);
            var depth = (float)Math.Max(1, dimensions.Depth * scale);
            var rectangle = new Rectangle(center.X + offset.X, center.Y + offset.Y, width, depth);
            Raylib.DrawRectanglePro(rectangle, new Vector2(width / 2, depth / 2),
                (float)(((brush.Yaw ?? 0) + local.Yaw) * MathEx.Rad2Deg), color);
        }
    }

    private static void DrawObjectives(
        MapDef map,
        PlayerState local,
        Vector2 center,
        float scale,
        float radius,
        UiFont font)
    {
        foreach (var objective in map.Objectives)
        {
            if (objective.Kind is not ObjectiveKind.DominationFlag and not ObjectiveKind.Hardpoint) continue;
            var offset = RotateOffset(objective.Position.X - local.Position.X,
                objective.Position.Z - local.Position.Z, local.Yaw, scale);
            if (offset.LengthSquared() > radius * radius) continue;
            var position = center + offset;
            Raylib.DrawCircleV(position, 8, new Color(255, 220, 120, 205));
            var measure = font.Measure(objective.Label, 11);
            font.Draw(objective.Label, position.X - measure.X / 2, position.Y - 6, 11,
                new Color(15, 19, 22, 255));
        }
    }

    private void DrawPlayers(NativeSession session, PlayerState local, Vector2 center, float scale, float radius)
    {
        var radar = session.Simulation.TeamHasRadar(local.Team);
        foreach (var player in session.World.Players.Values)
        {
            if (!player.Alive || player.Id == local.Id) continue;
            var enemy = SimulationTypes.IsEnemyTeam(local.Team, player.Team);
            if (enemy && !radar && !_gunshotPings.ContainsKey(player.Id)) continue;
            var offset = RotateOffset(player.Position.X - local.Position.X, player.Position.Z - local.Position.Z,
                local.Yaw, scale);
            if (offset.LengthSquared() > radius * radius) continue;
            DrawArrow(center + offset, player.Yaw - local.Yaw, 5,
                enemy ? new Color(92, 230, 92, 245) : new Color(245, 76, 68, 245));
        }
    }

    private static Vector2 RotateOffset(double x, double z, double yaw, float scale)
    {
        var cosine = Math.Cos(yaw);
        var sine = Math.Sin(yaw);
        return new Vector2(
            (float)((x * cosine - z * sine) * scale),
            (float)((x * sine + z * cosine) * scale));
    }

    private static void DrawArrow(Vector2 center, double yaw, float size, Color color)
    {
        var cosine = (float)Math.Cos(yaw);
        var sine = (float)Math.Sin(yaw);
        Vector2 Rotate(float x, float y) => center + new Vector2(x * cosine - y * sine, x * sine + y * cosine);
        Raylib.DrawTriangle(Rotate(0, -size), Rotate(-size * .72f, size), Rotate(size * .72f, size), color);
    }

    private static (double Width, double Height, double Depth) Dimensions(Brush brush)
    {
        if (brush.Kind == BrushKind.Cylinder)
        {
            var diameter = (brush.Radius ?? 0) * 2;
            return (diameter, brush.Height ?? 0, diameter);
        }
        return (brush.Size?.X ?? 0, brush.Size?.Y ?? 0, brush.Size?.Z ?? 0);
    }
}

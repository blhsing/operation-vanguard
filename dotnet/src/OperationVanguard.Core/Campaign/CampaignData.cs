namespace OperationVanguard.Core;

internal static class CampaignData
{
    internal static Vec3 V(double x, double y, double z) => new(x, y, z);

    internal static Zone Z(Vec3 center, Vec3 size) => new(center, size);

    internal static AllySpec Ally(
        string id,
        string name,
        Vec3 spawn,
        BotArchetype archetype,
        bool essential = false) => new()
        {
            Id = id,
            Name = name,
            Spawn = spawn,
            Archetype = archetype,
            Essential = essential,
        };

    internal static Wave Wave(
        Vec3 spawn,
        Vec3? post,
        int count,
        double interval,
        double? delay = null,
        bool endless = false,
        BotArchetype[]? archetypes = null) => new()
        {
            Spawn = spawn,
            Post = post,
            Count = count,
            Interval = interval,
            Delay = delay,
            Endless = endless,
            Archetypes = archetypes,
        };
}

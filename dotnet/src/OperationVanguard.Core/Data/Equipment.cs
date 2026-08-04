using System.Collections.ObjectModel;
using System.Text.Json.Serialization;

namespace OperationVanguard.Core;

[JsonConverter(typeof(JsonStringEnumConverter<EquipmentSlot>))]
public enum EquipmentSlot
{
    [JsonStringEnumMemberName("lethal")] Lethal,
    [JsonStringEnumMemberName("tactical")] Tactical,
    [JsonStringEnumMemberName("field")] Field,
}

public sealed class EquipmentEffect
{
    public double? Flash { get; set; }
    public double? Stun { get; set; }
    public double? Smoke { get; set; }
    public double? Emp { get; set; }
    public double? Burn { get; set; }
    public double? Duration { get; set; }
}

public sealed class EquipmentDef
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public EquipmentSlot Slot { get; set; }
    public string Description { get; set; } = "";
    public int Count { get; set; }
    public int UnlockLevel { get; set; }
    public ProjectileKind? ProjectileKind { get; set; }
    public DeployableKind? DeployableKind { get; set; }
    public double? Damage { get; set; }
    public double? Radius { get; set; }
    public double? Fuse { get; set; }
    public double? ThrowSpeed { get; set; }
    public double? ChargeTime { get; set; }
    public EquipmentEffect? Effect { get; set; }
}

public static class EquipmentData
{
    public static IReadOnlyList<EquipmentDef> All { get; }
    public static IReadOnlyDictionary<string, EquipmentDef> Equipment { get; }

    static EquipmentData()
    {
        var all = RegistryJson.DeserializeList<EquipmentDef>(RegistryPayloads.EquipmentJson);
        All = all.AsReadOnly();
        Equipment = new ReadOnlyDictionary<string, EquipmentDef>(
            all.ToDictionary(definition => definition.Id, StringComparer.Ordinal));
    }

    public static EquipmentDef GetEquipment(string id)
        => Equipment.TryGetValue(id, out var definition)
            ? definition
            : throw new KeyNotFoundException($"Unknown equipment: {id}");

    public static IReadOnlyList<EquipmentDef> EquipmentForSlot(EquipmentSlot slot)
        => All.Where(definition => definition.Slot == slot)
            .OrderBy(definition => definition.UnlockLevel)
            .ThenBy(definition => definition.Id, StringComparer.Ordinal)
            .ToArray();
}

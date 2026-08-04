using System.Collections.ObjectModel;

namespace OperationVanguard.Core;

public sealed class PerkEffects
{
    public double? MovementSpeedMult { get; set; }
    public double? AdsSpeedMult { get; set; }
    public double? ReloadSpeedMult { get; set; }
    public double? SwapSpeedMult { get; set; }
    public double? SprintOutMult { get; set; }
    public double? HealthRegenDelayMult { get; set; }
    public double? HealthRegenRateMult { get; set; }
    public int? ExtraLethal { get; set; }
    public int? ExtraTactical { get; set; }
    public bool? SilentMovement { get; set; }
    public bool? HiddenFromUav { get; set; }
    public bool? FlashImmune { get; set; }
    public double? ExplosiveResistMult { get; set; }
    public bool? FallDamageImmune { get; set; }
    public double? KillstreakCostMult { get; set; }
    public bool? Scavenger { get; set; }
    public bool? SeeEnemyEquipment { get; set; }
    public double? MarkEnemiesOnKill { get; set; }
    public double? ExtraArmor { get; set; }
    public bool? DeadMansTrigger { get; set; }
    public double? FasterCapture { get; set; }
    public double? LongerBreathHold { get; set; }
    public double? QuieterFootsteps { get; set; }
    public bool? ExtraKillstreakSlot { get; set; }
}

public sealed class ResolvedPerkEffects
{
    public double MovementSpeedMult { get; set; } = 1;
    public double AdsSpeedMult { get; set; } = 1;
    public double ReloadSpeedMult { get; set; } = 1;
    public double SwapSpeedMult { get; set; } = 1;
    public double SprintOutMult { get; set; } = 1;
    public double HealthRegenDelayMult { get; set; } = 1;
    public double HealthRegenRateMult { get; set; } = 1;
    public int ExtraLethal { get; set; }
    public int ExtraTactical { get; set; }
    public bool SilentMovement { get; set; }
    public bool HiddenFromUav { get; set; }
    public bool FlashImmune { get; set; }
    public double ExplosiveResistMult { get; set; } = 1;
    public bool FallDamageImmune { get; set; }
    public double KillstreakCostMult { get; set; } = 1;
    public bool Scavenger { get; set; }
    public bool SeeEnemyEquipment { get; set; }
    public double MarkEnemiesOnKill { get; set; }
    public double ExtraArmor { get; set; }
    public bool DeadMansTrigger { get; set; }
    public double FasterCapture { get; set; }
    public double LongerBreathHold { get; set; }
    public double QuieterFootsteps { get; set; }
    public bool ExtraKillstreakSlot { get; set; }
}

public sealed class PerkDef
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public int Tier { get; set; }
    public string Description { get; set; } = "";
    public string Icon { get; set; } = "";
    public int UnlockLevel { get; set; }
    public PerkEffects Effects { get; set; } = new();
}

public static class PerkData
{
    public static IReadOnlyList<PerkDef> All { get; }
    public static IReadOnlyDictionary<string, PerkDef> Perks { get; }

    static PerkData()
    {
        var all = RegistryJson.DeserializeList<PerkDef>(RegistryPayloads.PerksJson);
        All = all.AsReadOnly();
        Perks = new ReadOnlyDictionary<string, PerkDef>(
            all.ToDictionary(perk => perk.Id, StringComparer.Ordinal));
    }

    public static PerkDef GetPerk(string id)
        => Perks.TryGetValue(id, out var perk)
            ? perk
            : throw new KeyNotFoundException($"Unknown perk: {id}");

    public static IReadOnlyList<PerkDef> PerksForTier(int tier)
    {
        if (tier is < 1 or > 3) throw new ArgumentOutOfRangeException(nameof(tier));
        return All.Where(perk => perk.Tier == tier)
            .OrderBy(perk => perk.UnlockLevel)
            .ThenBy(perk => perk.Id, StringComparer.Ordinal)
            .ToArray();
    }

    public static ResolvedPerkEffects CombinePerkEffects(IReadOnlyList<string> perkIds)
    {
        var output = new ResolvedPerkEffects();
        foreach (var id in perkIds)
        {
            if (!Perks.TryGetValue(id, out var perk)) continue;
            var effects = perk.Effects;
            output.MovementSpeedMult *= effects.MovementSpeedMult ?? 1;
            output.AdsSpeedMult *= effects.AdsSpeedMult ?? 1;
            output.ReloadSpeedMult *= effects.ReloadSpeedMult ?? 1;
            output.SwapSpeedMult *= effects.SwapSpeedMult ?? 1;
            output.SprintOutMult *= effects.SprintOutMult ?? 1;
            output.HealthRegenDelayMult *= effects.HealthRegenDelayMult ?? 1;
            output.HealthRegenRateMult *= effects.HealthRegenRateMult ?? 1;
            output.ExplosiveResistMult *= effects.ExplosiveResistMult ?? 1;
            output.KillstreakCostMult *= effects.KillstreakCostMult ?? 1;

            output.ExtraLethal += effects.ExtraLethal ?? 0;
            output.ExtraTactical += effects.ExtraTactical ?? 0;
            output.MarkEnemiesOnKill += effects.MarkEnemiesOnKill ?? 0;
            output.ExtraArmor += effects.ExtraArmor ?? 0;
            output.FasterCapture += effects.FasterCapture ?? 0;
            output.LongerBreathHold += effects.LongerBreathHold ?? 0;
            output.QuieterFootsteps += effects.QuieterFootsteps ?? 0;

            output.SilentMovement |= effects.SilentMovement ?? false;
            output.HiddenFromUav |= effects.HiddenFromUav ?? false;
            output.FlashImmune |= effects.FlashImmune ?? false;
            output.FallDamageImmune |= effects.FallDamageImmune ?? false;
            output.Scavenger |= effects.Scavenger ?? false;
            output.SeeEnemyEquipment |= effects.SeeEnemyEquipment ?? false;
            output.DeadMansTrigger |= effects.DeadMansTrigger ?? false;
            output.ExtraKillstreakSlot |= effects.ExtraKillstreakSlot ?? false;
        }
        return output;
    }
}

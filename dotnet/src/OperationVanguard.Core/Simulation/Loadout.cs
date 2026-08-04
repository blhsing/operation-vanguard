namespace OperationVanguard.Core;

/// <summary>
/// Serializable create-a-class selection. Resolution into live weapon and perk data
/// is deliberately kept separate so stale saved/networked selections can be repaired.
/// </summary>
public sealed class Loadout
{
    public string Name { get; set; } = string.Empty;
    public string Primary { get; set; } = string.Empty;
    public List<string> PrimaryAttachments { get; set; } = [];
    public string Secondary { get; set; } = string.Empty;
    public List<string> SecondaryAttachments { get; set; } = [];
    public string Lethal { get; set; } = string.Empty;
    public string Tactical { get; set; } = string.Empty;
    public List<string> Perks { get; set; } = [];
    public string FieldUpgrade { get; set; } = string.Empty;
    public List<string> Killstreaks { get; set; } = [];
}

/// <summary>Everything the simulation needs from a loadout after registry lookup.</summary>
public sealed class ResolvedLoadout
{
    public WeaponDef Primary { get; set; } = new();
    public WeaponDef Secondary { get; set; } = new();
    public EquipmentDef? Lethal { get; set; }
    public EquipmentDef? Tactical { get; set; }
    public ResolvedPerkEffects Perks { get; set; } = new();
    public List<string> PerkIds { get; set; } = [];
    public string FieldUpgrade { get; set; } = string.Empty;
    public List<string> Killstreaks { get; set; } = [];
}

/// <summary>Preferred engagement interval for a bot archetype, in metres.</summary>
public readonly record struct ArchetypeRange(double Min, double Max);

/// <summary>Loadout resolution, spawn application, sanitisation, and bot presets.</summary>
public static class LoadoutSystem
{
    private static readonly string[] RusherPrimaries = ["mp9k", "vector9", "skorp", "p90x"];
    private static readonly string[] SniperPrimaries = ["r700t", "svk12", "sp96"];
    private static readonly string[] SupportPrimaries = ["m60e", "rpd74", "lw90"];
    private static readonly string[] ScoutPrimaries = ["dmr14", "mk18", "ebr7", "aug77"];
    private static readonly string[] RiflemanPrimaries = ["vk47", "m5a1", "gr63", "ks12", "fr55"];

    public static IReadOnlyList<BotArchetype> BotArchetypes { get; } =
        [BotArchetype.Rifleman, BotArchetype.Rusher, BotArchetype.Sniper, BotArchetype.Support, BotArchetype.Scout];

    /// <summary>The starting class, playable at rank zero.</summary>
    public static Loadout DefaultLoadout(string name = "Default") => new()
    {
        Name = name,
        Primary = WeaponData.DefaultPrimary,
        PrimaryAttachments = [],
        Secondary = WeaponData.DefaultSecondary,
        SecondaryAttachments = [],
        Lethal = "frag",
        Tactical = "flashbang",
        Perks = [],
        FieldUpgrade = string.Empty,
        Killstreaks = KillstreakData.DefaultKillstreaks.Take(3).ToList(),
    };

    /// <summary>Resolve a selection while tolerating stale or unknown registry ids.</summary>
    public static ResolvedLoadout ResolveLoadout(Loadout loadout)
    {
        var primaryBase = TryGetWeapon(loadout.Primary) ?? WeaponData.GetWeapon(WeaponData.DefaultPrimary);
        var secondaryBase = TryGetWeapon(loadout.Secondary) ?? WeaponData.GetWeapon(WeaponData.DefaultSecondary);

        var primaryAttachments = (loadout.PrimaryAttachments ?? [])
            .Take(AttachmentData.MaxEquippedAttachments)
            .ToArray();
        var secondaryAttachments = (loadout.SecondaryAttachments ?? [])
            .Take(AttachmentData.MaxEquippedAttachments)
            .ToArray();

        var perkIds = (loadout.Perks ?? [])
            .Where(id => id is { Length: > 0 })
            .ToList();

        return new ResolvedLoadout
        {
            Primary = AttachmentData.ResolveWeapon(primaryBase, primaryAttachments),
            Secondary = AttachmentData.ResolveWeapon(secondaryBase, secondaryAttachments),
            Lethal = TryGetEquipment(loadout.Lethal),
            Tactical = TryGetEquipment(loadout.Tactical),
            Perks = PerkData.CombinePerkEffects(perkIds),
            PerkIds = perkIds,
            FieldUpgrade = loadout.FieldUpgrade ?? string.Empty,
            Killstreaks = (loadout.Killstreaks ?? []).Take(3).ToList(),
        };
    }

    /// <summary>Rebuild all spawn-scoped player equipment from a resolved loadout.</summary>
    public static void ApplyLoadout(PlayerState player, ResolvedLoadout resolved)
    {
        player.Weapons =
        [
            WorldFactory.CreateWeaponState(
                resolved.Primary.Id,
                resolved.Primary.MagSize,
                resolved.Primary.StartingReserve),
            WorldFactory.CreateWeaponState(
                resolved.Secondary.Id,
                resolved.Secondary.MagSize,
                resolved.Secondary.StartingReserve),
        ];
        player.ActiveSlot = WeaponSlot.Primary;

        player.Perks = [.. resolved.PerkIds];
        player.FieldUpgrade = resolved.FieldUpgrade;
        player.Killstreaks = [.. resolved.Killstreaks];

        player.LethalCount = (resolved.Lethal?.Count ?? 0) + resolved.Perks.ExtraLethal;
        player.TacticalCount = (resolved.Tactical?.Count ?? 0) + resolved.Perks.ExtraTactical;

        player.MaxHealth = 100d + resolved.Perks.ExtraArmor;
        player.Health = player.MaxHealth;
        player.Armor = 0d;

        player.FieldUpgradeCharge = 0d;
        player.KillstreakInventory = [];
    }

    /// <summary>Return a corrected copy containing only unlocked, valid selections.</summary>
    public static Loadout SanitizeLoadout(Loadout loadout, int playerLevel)
    {
        var output = new Loadout
        {
            Name = loadout.Name,
            Primary = loadout.Primary,
            PrimaryAttachments = (loadout.PrimaryAttachments ?? [])
                .Take(AttachmentData.MaxEquippedAttachments)
                .ToList(),
            Secondary = loadout.Secondary,
            SecondaryAttachments = (loadout.SecondaryAttachments ?? [])
                .Take(AttachmentData.MaxEquippedAttachments)
                .ToList(),
            Lethal = loadout.Lethal,
            Tactical = loadout.Tactical,
            Perks = [],
            FieldUpgrade = loadout.FieldUpgrade,
            Killstreaks = (loadout.Killstreaks ?? []).Take(3).ToList(),
        };

        var primary = TryGetWeapon(output.Primary);
        if (primary is null || primary.UnlockLevel > playerLevel)
        {
            output.Primary = WeaponData.DefaultPrimary;
        }

        var secondary = TryGetWeapon(output.Secondary);
        if (secondary is null || secondary.UnlockLevel > playerLevel)
        {
            output.Secondary = WeaponData.DefaultSecondary;
        }

        if (TryGetEquipment(output.Lethal) is null)
        {
            output.Lethal = "frag";
        }

        if (TryGetEquipment(output.Tactical) is null)
        {
            output.Tactical = "flashbang";
        }

        var seenTiers = new HashSet<int>();
        foreach (var id in loadout.Perks ?? [])
        {
            if (id is null || !PerkData.Perks.TryGetValue(id, out var perk))
            {
                continue;
            }

            if (perk.UnlockLevel > playerLevel || !seenTiers.Add(perk.Tier))
            {
                continue;
            }

            output.Perks.Add(id);
        }

        return output;
    }

    /// <summary>Create a deterministic, archetype-appropriate bot class.</summary>
    public static Loadout BotLoadout(BotArchetype archetype, int pickIndex)
    {
        var output = DefaultLoadout(ArchetypeName(archetype));

        switch (archetype)
        {
            case BotArchetype.Rusher:
                output.Primary = Pick(RusherPrimaries, pickIndex);
                output.Secondary = "mp5c";
                output.Lethal = "semtex";
                output.Tactical = "flashbang";
                break;
            case BotArchetype.Sniper:
                output.Primary = Pick(SniperPrimaries, pickIndex);
                output.Secondary = "gs17";
                output.Lethal = "claymore";
                output.Tactical = "smoke";
                break;
            case BotArchetype.Support:
                output.Primary = Pick(SupportPrimaries, pickIndex);
                output.Secondary = "p226";
                output.Lethal = "c4";
                output.Tactical = "stun";
                break;
            case BotArchetype.Scout:
                output.Primary = Pick(ScoutPrimaries, pickIndex);
                output.Secondary = "p226";
                output.Lethal = "throwing_knife";
                output.Tactical = "snapshot";
                break;
            default:
                output.Primary = Pick(RiflemanPrimaries, pickIndex);
                output.Secondary = "p226";
                output.Lethal = "frag";
                output.Tactical = "flashbang";
                break;
        }

        if (TryGetWeapon(output.Primary) is null) output.Primary = WeaponData.DefaultPrimary;
        if (TryGetWeapon(output.Secondary) is null) output.Secondary = WeaponData.DefaultSecondary;
        if (TryGetEquipment(output.Lethal) is null) output.Lethal = "frag";
        if (TryGetEquipment(output.Tactical) is null) output.Tactical = "flashbang";

        return output;
    }

    public static ArchetypeRange ArchetypeRange(BotArchetype archetype) => archetype switch
    {
        BotArchetype.Rusher => new ArchetypeRange(0d, 14d),
        BotArchetype.Sniper => new ArchetypeRange(28d, 90d),
        BotArchetype.Support => new ArchetypeRange(10d, 40d),
        BotArchetype.Scout => new ArchetypeRange(15d, 50d),
        _ => new ArchetypeRange(5d, 32d),
    };

    private static WeaponDef? TryGetWeapon(string? id) =>
        id is null ? null : WeaponData.TryGetWeapon(id);

    private static EquipmentDef? TryGetEquipment(string? id) =>
        id is not null && EquipmentData.Equipment.TryGetValue(id, out var equipment) ? equipment : null;

    private static string Pick(IReadOnlyList<string> values, int pickIndex)
    {
        var index = pickIndex % values.Count;
        return index < 0 ? string.Empty : values[index];
    }

    private static string ArchetypeName(BotArchetype archetype) => archetype switch
    {
        BotArchetype.Rusher => "rusher",
        BotArchetype.Sniper => "sniper",
        BotArchetype.Support => "support",
        BotArchetype.Scout => "scout",
        _ => "rifleman",
    };
}

using System.Collections.ObjectModel;

namespace OperationVanguard.Core;

public sealed class StatModifier
{
    public double? AdsTime { get; set; }
    public double? SprintOutTime { get; set; }
    public double? DrawTime { get; set; }
    public double? ReloadTime { get; set; }
    public double? MovementSpeed { get; set; }
    public double? AdsSpeed { get; set; }
    public double? RecoilPitch { get; set; }
    public double? RecoilYaw { get; set; }
    public double? HipSpread { get; set; }
    public double? AdsSpread { get; set; }
    public double? DamageRangeScale { get; set; }
    public double? Penetration { get; set; }
    public double? MuzzleVelocity { get; set; }
    public double? SwayAmount { get; set; }
    public double? MagSizeAdd { get; set; }
    public double? AdsZoomAdd { get; set; }
    public bool? Suppressed { get; set; }
    public bool? HidesMinimapDot { get; set; }
}

public sealed class AttachmentDef
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public AttachmentSlot Slot { get; set; }
    public string Description { get; set; } = "";
    public List<WeaponClass> Classes { get; set; } = [];
    public StatModifier Mods { get; set; } = new();
    public int UnlockLevel { get; set; }
    public List<string> Pros { get; set; } = [];
    public List<string> Cons { get; set; } = [];
}

public static class AttachmentData
{
    public const int AttachmentSlotCount = 8;
    public const int MaxEquippedAttachments = 5;
    private const int MaxUnlockLevel = 30;

    public static IReadOnlyList<AttachmentDef> All { get; }
    public static IReadOnlyDictionary<string, AttachmentDef> Attachments { get; }

    static AttachmentData()
    {
        var all = RegistryJson.DeserializeList<AttachmentDef>(RegistryPayloads.AttachmentsJson);
        All = all.AsReadOnly();
        Attachments = new ReadOnlyDictionary<string, AttachmentDef>(
            all.ToDictionary(attachment => attachment.Id, StringComparer.Ordinal));
    }

    public static AttachmentDef GetAttachment(string id)
        => Attachments.TryGetValue(id, out var attachment)
            ? attachment
            : throw new KeyNotFoundException($"Unknown attachment: {id}");

    public static IReadOnlyList<AttachmentDef> AttachmentsForSlot(
        AttachmentSlot slot,
        WeaponClass weaponClass)
        => All
            .Where(attachment => attachment.Slot == slot
                                 && (attachment.Classes.Count == 0 || attachment.Classes.Contains(weaponClass)))
            .OrderBy(attachment => attachment.UnlockLevel)
            .ThenBy(attachment => attachment.Id, StringComparer.Ordinal)
            .ToArray();

    public static WeaponDef ResolveWeapon(WeaponDef baseWeapon, IReadOnlyList<string> attachmentIds)
    {
        var output = baseWeapon.Clone();
        var equipped = SelectAttachments(attachmentIds);
        if (equipped.Count == 0) return output;

        var mods = Accumulate(equipped);
        output.Handling.AdsTime *= mods.AdsTime;
        output.Handling.SprintOutTime *= mods.SprintOutTime;
        output.Handling.DrawTime *= mods.DrawTime;
        output.Handling.MovementSpeedMultiplier *= mods.MovementSpeed;
        output.Handling.AdsSpeedMultiplier *= mods.AdsSpeed;
        output.Handling.SwayAmount *= mods.SwayAmount;

        output.Handling.ReloadTime *= mods.ReloadTime;
        output.Handling.ReloadEmptyTime *= mods.ReloadTime;
        output.Handling.ReloadAmmoTime *= mods.ReloadTime;
        output.Handling.ReloadEmptyAmmoTime *= mods.ReloadTime;

        foreach (var step in output.Recoil.Pattern)
        {
            step.Pitch *= mods.RecoilPitch;
            step.Yaw *= mods.RecoilYaw;
        }
        output.Recoil.RandomPitch *= mods.RecoilPitch;
        output.Recoil.RandomYaw *= mods.RecoilYaw;

        output.Spread.HipMin *= mods.HipSpread;
        output.Spread.HipMax *= mods.HipSpread;
        output.Spread.AdsMin *= mods.AdsSpread;
        output.Spread.AdsMax *= mods.AdsSpread;

        foreach (var stop in output.Damage) stop.Distance *= mods.DamageRangeScale;
        output.Penetration *= mods.Penetration;
        output.MuzzleVelocity *= mods.MuzzleVelocity;
        output.MagSize = Math.Max(1, DataNumber.JsRoundToInt(output.MagSize + mods.MagSizeAdd));
        output.AdsZoom = Math.Max(1, output.AdsZoom + mods.AdsZoomAdd);

        if (mods.Suppressed) output.Audio.Suppressed = true;
        if (mods.HidesMinimapDot && !output.Traits.Contains(WeaponTrait.AlwaysSuppressed))
            output.Traits.Add(WeaponTrait.AlwaysSuppressed);

        return output;
    }

    public static IReadOnlyList<string> ValidateAttachments()
    {
        var errors = new List<string>();
        foreach (var pair in Attachments)
        {
            var key = pair.Key;
            var definition = pair.Value;
            if (!string.Equals(key, definition.Id, StringComparison.Ordinal))
                errors.Add($"{key}: table key does not match id \"{definition.Id}\"");

            if (definition.UnlockLevel is < 0 or > MaxUnlockLevel)
                errors.Add($"{definition.Id}: unlockLevel {definition.UnlockLevel} is outside 0..{MaxUnlockLevel}");

            var mods = definition.Mods;
            var hasDownside =
                IsPenaltyLowerIsBetter(mods.AdsTime)
                || IsPenaltyLowerIsBetter(mods.SprintOutTime)
                || IsPenaltyLowerIsBetter(mods.DrawTime)
                || IsPenaltyLowerIsBetter(mods.ReloadTime)
                || IsPenaltyLowerIsBetter(mods.RecoilPitch)
                || IsPenaltyLowerIsBetter(mods.RecoilYaw)
                || IsPenaltyLowerIsBetter(mods.HipSpread)
                || IsPenaltyLowerIsBetter(mods.AdsSpread)
                || IsPenaltyLowerIsBetter(mods.SwayAmount)
                || IsPenaltyHigherIsBetter(mods.MovementSpeed)
                || IsPenaltyHigherIsBetter(mods.AdsSpeed)
                || IsPenaltyHigherIsBetter(mods.DamageRangeScale)
                || IsPenaltyHigherIsBetter(mods.Penetration)
                || IsPenaltyHigherIsBetter(mods.MuzzleVelocity)
                || (mods.MagSizeAdd ?? 0) < 0;

            if (!hasDownside)
                errors.Add($"{definition.Id}: has no downside — every attachment must cost something");
        }
        return errors;
    }

    private static bool IsPenaltyLowerIsBetter(double? value) => value is > 1;
    private static bool IsPenaltyHigherIsBetter(double? value) => value is < 1;

    private static List<AttachmentDef> SelectAttachments(IReadOnlyList<string> attachmentIds)
    {
        var picked = new List<AttachmentDef>();
        var usedSlots = new HashSet<AttachmentSlot>();
        foreach (var id in attachmentIds)
        {
            if (picked.Count >= MaxEquippedAttachments) break;
            if (!Attachments.TryGetValue(id, out var definition)) continue;
            if (!usedSlots.Add(definition.Slot)) continue;
            picked.Add(definition);
        }
        return picked;
    }

    private static AccumulatedMods Accumulate(IReadOnlyList<AttachmentDef> definitions)
    {
        var accumulated = new AccumulatedMods();
        foreach (var definition in definitions)
        {
            var mods = definition.Mods;
            accumulated.AdsTime *= mods.AdsTime ?? 1;
            accumulated.SprintOutTime *= mods.SprintOutTime ?? 1;
            accumulated.DrawTime *= mods.DrawTime ?? 1;
            accumulated.ReloadTime *= mods.ReloadTime ?? 1;
            accumulated.MovementSpeed *= mods.MovementSpeed ?? 1;
            accumulated.AdsSpeed *= mods.AdsSpeed ?? 1;
            accumulated.RecoilPitch *= mods.RecoilPitch ?? 1;
            accumulated.RecoilYaw *= mods.RecoilYaw ?? 1;
            accumulated.HipSpread *= mods.HipSpread ?? 1;
            accumulated.AdsSpread *= mods.AdsSpread ?? 1;
            accumulated.DamageRangeScale *= mods.DamageRangeScale ?? 1;
            accumulated.Penetration *= mods.Penetration ?? 1;
            accumulated.MuzzleVelocity *= mods.MuzzleVelocity ?? 1;
            accumulated.SwayAmount *= mods.SwayAmount ?? 1;
            accumulated.MagSizeAdd += mods.MagSizeAdd ?? 0;
            accumulated.AdsZoomAdd += mods.AdsZoomAdd ?? 0;
            accumulated.Suppressed |= mods.Suppressed ?? false;
            accumulated.HidesMinimapDot |= mods.HidesMinimapDot ?? false;
        }
        return accumulated;
    }

    private sealed class AccumulatedMods
    {
        public double AdsTime { get; set; } = 1;
        public double SprintOutTime { get; set; } = 1;
        public double DrawTime { get; set; } = 1;
        public double ReloadTime { get; set; } = 1;
        public double MovementSpeed { get; set; } = 1;
        public double AdsSpeed { get; set; } = 1;
        public double RecoilPitch { get; set; } = 1;
        public double RecoilYaw { get; set; } = 1;
        public double HipSpread { get; set; } = 1;
        public double AdsSpread { get; set; } = 1;
        public double DamageRangeScale { get; set; } = 1;
        public double Penetration { get; set; } = 1;
        public double MuzzleVelocity { get; set; } = 1;
        public double SwayAmount { get; set; } = 1;
        public double MagSizeAdd { get; set; }
        public double AdsZoomAdd { get; set; }
        public bool Suppressed { get; set; }
        public bool HidesMinimapDot { get; set; }
    }
}

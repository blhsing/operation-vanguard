using System.Collections.ObjectModel;
using System.Globalization;

namespace OperationVanguard.Core;

public static class WeaponData
{
    private const double ValidationHealth = 100;

    public const string DefaultPrimary = "vk47";
    public const string DefaultSecondary = "p226";

    public static IReadOnlyList<WeaponDef> All { get; }
    public static IReadOnlyDictionary<string, WeaponDef> Weapons { get; }
    public static IReadOnlyDictionary<WeaponClass, IReadOnlyList<WeaponDef>> WeaponsByClass { get; }
    public static IReadOnlyList<string> WeaponIds { get; }

    static WeaponData()
    {
        var all = RegistryJson.DeserializeList<WeaponDef>(RegistryPayloads.WeaponsJson);
        All = all.AsReadOnly();
        Weapons = new ReadOnlyDictionary<string, WeaponDef>(
            all.ToDictionary(weapon => weapon.Id, StringComparer.Ordinal));
        WeaponIds = all.Select(weapon => weapon.Id).ToArray();

        var byClass = new Dictionary<WeaponClass, IReadOnlyList<WeaponDef>>();
        foreach (var weaponClass in Enum.GetValues<WeaponClass>())
        {
            byClass[weaponClass] = all.Where(weapon => weapon.Class == weaponClass).ToArray();
        }
        WeaponsByClass = new ReadOnlyDictionary<WeaponClass, IReadOnlyList<WeaponDef>>(byClass);
    }

    public static WeaponDef GetWeapon(string id)
        => Weapons.TryGetValue(id, out var weapon)
            ? weapon
            : throw new KeyNotFoundException($"Unknown weapon id: {id}");

    public static WeaponDef? TryGetWeapon(string id)
        => Weapons.TryGetValue(id, out var weapon) ? weapon : null;

    public static IReadOnlyList<WeaponDef> WeaponsUnlockedAt(int level)
        => All.Where(weapon => weapon.UnlockLevel <= level).ToArray();

    public static IReadOnlyList<string> ValidateArsenal()
    {
        var errors = new List<string>();

        foreach (var weapon in All)
        {
            var tag = weapon.Id;
            if (weapon.MagSize <= 0) errors.Add($"{tag}: magSize must be > 0");
            if (weapon.Damage.Count < 1) errors.Add($"{tag}: needs at least one damage stop");
            if (weapon.Recoil.Pattern.Count == 0) errors.Add($"{tag}: empty recoil pattern");
            if (weapon.Rpm <= 0) errors.Add($"{tag}: rpm must be > 0");

            for (var i = 1; i < weapon.Damage.Count; i++)
            {
                var previous = weapon.Damage[i - 1];
                var current = weapon.Damage[i];
                if (current.Distance <= previous.Distance)
                    errors.Add($"{tag}: damage stop {i} distance must increase");
                if (current.Damage > previous.Damage + 1e-6)
                    errors.Add($"{tag}: damage increases with range at stop {i}");
            }

            if (weapon.AttachmentSlots.Distinct().Count() != weapon.AttachmentSlots.Count)
                errors.Add($"{tag}: duplicate attachment slots");

            if (weapon.Class is not WeaponClass.Melee and not WeaponClass.Launcher)
            {
                foreach (var distance in new[] { 3, 8, 15, 25, 40, 60 })
                {
                    var ttk = WeaponMath.TimeToKill(weapon, distance, ValidationHealth);
                    if (double.IsFinite(ttk) && ttk > 0 && ttk < 0.15)
                    {
                        errors.Add($"{tag}: body TTK {DataNumber.JsTruncateToInt(ttk * 1000)}ms at {distance}m is below the 150ms floor");
                    }
                }
            }

            switch (weapon.Class)
            {
                case WeaponClass.AssaultRifle:
                {
                    var ttk = WeaponMath.TimeToKill(weapon, 20, ValidationHealth);
                    if (ttk is < 0.25 or > 0.42)
                        errors.Add($"{tag}: AR TTK at 20m is {DataNumber.JsTruncateToInt(ttk * 1000)}ms, want 250-420ms");
                    break;
                }
                case WeaponClass.SubmachineGun:
                {
                    var close = WeaponMath.TimeToKill(weapon, 10, ValidationHealth);
                    if (close is < 0.18 or > 0.32)
                        errors.Add($"{tag}: SMG TTK at 10m is {DataNumber.JsTruncateToInt(close * 1000)}ms, want 180-320ms");
                    var far = WeaponMath.TimeToKill(weapon, 35, ValidationHealth);
                    if (double.IsFinite(far) && far < close * 1.25)
                    {
                        errors.Add($"{tag}: SMG does not fall off enough (10m {DataNumber.JsTruncateToInt(close * 1000)}ms vs 35m {DataNumber.JsTruncateToInt(far * 1000)}ms)");
                    }
                    break;
                }
                case WeaponClass.SniperRifle:
                {
                    if (weapon.Handling.AdsTime < 0.5)
                    {
                        errors.Add($"{tag}: sniper adsTime {weapon.Handling.AdsTime.ToString(CultureInfo.InvariantCulture)}s is below the 0.5s floor");
                    }
                    if (weapon.Traits.Contains(WeaponTrait.OneShotUpperTorso))
                    {
                        var first = weapon.Damage[0];
                        if (WeaponMath.DamageAtRange(weapon.Damage, first.Distance) < ValidationHealth)
                            errors.Add($"{tag}: claims one-shot torso but deals < 100 at its first stop");
                    }
                    break;
                }
                case WeaponClass.Shotgun:
                {
                    var closeDamage = WeaponMath.DamageAtRange(weapon.Damage, 5) * weapon.Pellets;
                    var farDamage = WeaponMath.DamageAtRange(weapon.Damage, 16) * weapon.Pellets;
                    if (closeDamage < ValidationHealth * 0.9)
                        errors.Add($"{tag}: shotgun deals only {Math.Round(closeDamage, MidpointRounding.AwayFromZero):F0} at 5m, want ~lethal");
                    if (farDamage > ValidationHealth * 0.45)
                        errors.Add($"{tag}: shotgun still deals {Math.Round(farDamage, MidpointRounding.AwayFromZero):F0} at 16m, want it weak");
                    break;
                }
            }
        }

        var bestArAt30 = WeaponsByClass[WeaponClass.AssaultRifle]
            .Min(weapon => WeaponMath.TimeToKill(weapon, 30, ValidationHealth));
        var bestSmgAt30 = WeaponsByClass[WeaponClass.SubmachineGun]
            .Min(weapon => WeaponMath.TimeToKill(weapon, 30, ValidationHealth));
        if (bestSmgAt30 <= bestArAt30)
        {
            errors.Add($"cross-class: best SMG at 30m ({DataNumber.JsTruncateToInt(bestSmgAt30 * 1000)}ms) beats best AR ({DataNumber.JsTruncateToInt(bestArAt30 * 1000)}ms)");
        }

        if (!Weapons.ContainsKey(DefaultPrimary))
            errors.Add($"DEFAULT_PRIMARY '{DefaultPrimary}' does not exist");
        if (!Weapons.ContainsKey(DefaultSecondary))
            errors.Add($"DEFAULT_SECONDARY '{DefaultSecondary}' does not exist");

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var weapon in All)
        {
            if (!ids.Add(weapon.Id)) errors.Add($"duplicate weapon id: {weapon.Id}");
        }

        return errors;
    }
}

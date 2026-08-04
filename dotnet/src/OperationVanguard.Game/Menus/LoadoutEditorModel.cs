using OperationVanguard.Core;
using OperationVanguard.Game.Profile;

namespace OperationVanguard.Game.Menus;

/// <summary>Keyboard-friendly native create-a-class model backed by the exact Core registries.</summary>
public sealed class LoadoutEditorModel
{
    private readonly NativeProfile _profile;

    public LoadoutEditorModel(NativeProfile profile)
    {
        _profile = profile;
    }

    public int Selection { get; private set; }
    public int Scroll { get; private set; }

    public IReadOnlyList<LoadoutEditorRow> Rows => BuildRows();

    public void Move(int direction, int visibleRows)
    {
        var count = Rows.Count;
        if (count == 0) return;
        Selection = Wrap(Selection + direction, count);
        if (Selection < Scroll) Scroll = Selection;
        if (Selection >= Scroll + visibleRows) Scroll = Selection - visibleRows + 1;
        Scroll = Math.Clamp(Scroll, 0, Math.Max(0, count - visibleRows));
    }

    public void Select(int selection, int visibleRows)
    {
        var count = Rows.Count;
        if (count == 0) return;
        Selection = Math.Clamp(selection, 0, count - 1);
        if (Selection < Scroll) Scroll = Selection;
        if (Selection >= Scroll + visibleRows) Scroll = Selection - visibleRows + 1;
        Scroll = Math.Clamp(Scroll, 0, Math.Max(0, count - visibleRows));
    }

    public bool Adjust(int direction)
    {
        var rows = Rows;
        if (rows.Count == 0) return false;
        Selection = Math.Clamp(Selection, 0, rows.Count - 1);
        var changed = rows[Selection].Adjust(direction);
        Selection = Math.Clamp(Selection, 0, Math.Max(0, Rows.Count - 1));
        return changed;
    }

    private List<LoadoutEditorRow> BuildRows()
    {
        var rows = new List<LoadoutEditorRow>();
        var loadout = _profile.Loadouts[_profile.ActiveLoadout];
        rows.Add(new("兵種", $"{_profile.ActiveLoadout + 1:00} · {loadout.Name}",
            "十個兵種欄位會分別保存。", direction =>
            {
                _profile.ActiveLoadout = Wrap(_profile.ActiveLoadout + direction, _profile.Loadouts.Count);
                return true;
            }));

        AddWeaponRows(rows, "主武器", loadout, true);
        AddWeaponRows(rows, "副武器", loadout, false);
        AddChoice(rows, "致命裝備", loadout.Lethal,
            EquipmentData.EquipmentForSlot(EquipmentSlot.Lethal).Where(Unlocked).ToArray(),
            item => item.Id, item => item.Name, item => item.Description,
            value => loadout.Lethal = value);
        AddChoice(rows, "戰術裝備", loadout.Tactical,
            EquipmentData.EquipmentForSlot(EquipmentSlot.Tactical).Where(Unlocked).ToArray(),
            item => item.Id, item => item.Name, item => item.Description,
            value => loadout.Tactical = value);
        AddChoice(rows, "戰地升級", loadout.FieldUpgrade,
            EquipmentData.EquipmentForSlot(EquipmentSlot.Field).Where(Unlocked).ToArray(),
            item => item.Id, item => item.Name, item => item.Description,
            value => loadout.FieldUpgrade = value, allowNone: true);

        for (var tier = 1; tier <= 3; tier++)
        {
            var capturedTier = tier;
            var current = loadout.Perks.FirstOrDefault(id => PerkData.Perks.TryGetValue(id, out var perk) &&
                                                              perk.Tier == capturedTier) ?? string.Empty;
            AddChoice(rows, $"特技 {tier}", current, PerkData.PerksForTier(tier).Where(Unlocked).ToArray(),
                item => item.Id, item => item.Name, item => item.Description,
                value =>
                {
                    loadout.Perks.RemoveAll(id => PerkData.Perks.TryGetValue(id, out var perk) &&
                                                  perk.Tier == capturedTier);
                    if (!string.IsNullOrEmpty(value)) loadout.Perks.Add(value);
                }, allowNone: true);
        }

        var streakChoices = KillstreakData.All.Where(Unlocked)
            .OrderBy(item => item.Cost).ThenBy(item => item.Id, StringComparer.Ordinal).ToArray();
        for (var slot = 0; slot < 3; slot++)
        {
            var capturedSlot = slot;
            var current = slot < loadout.Killstreaks.Count ? loadout.Killstreaks[slot] : string.Empty;
            AddChoice(rows, $"連殺獎勵 {slot + 1}", current, streakChoices,
                item => item.Id, item => $"{item.Name} ({item.Cost})", item => item.Description,
                value =>
                {
                    while (loadout.Killstreaks.Count <= capturedSlot) loadout.Killstreaks.Add(string.Empty);
                    loadout.Killstreaks[capturedSlot] = value;
                    for (var index = loadout.Killstreaks.Count - 1; index >= 0; index--)
                    {
                        var id = loadout.Killstreaks[index];
                        if (string.IsNullOrEmpty(id) || loadout.Killstreaks.IndexOf(id) != index)
                            loadout.Killstreaks.RemoveAt(index);
                    }
                }, allowNone: true);
        }
        return rows;
    }

    private void AddWeaponRows(List<LoadoutEditorRow> rows, string label, Loadout loadout, bool primary)
    {
        var weaponId = primary ? loadout.Primary : loadout.Secondary;
        var attachments = primary ? loadout.PrimaryAttachments : loadout.SecondaryAttachments;
        var unlockedWeapons = WeaponData.All.Where(Unlocked).ToArray();
        var baseWeapon = WeaponData.TryGetWeapon(weaponId) ?? unlockedWeapons[0];
        var resolved = AttachmentData.ResolveWeapon(baseWeapon, attachments);
        var closeTtk = WeaponMath.TimeToKill(resolved, 8, GameConstants.Health.Maximum);
        var farTtk = WeaponMath.TimeToKill(resolved, 30, GameConstants.Health.Maximum);
        var detail = $"{WeaponClassName(baseWeapon.Class)} · 8m TTK {Milliseconds(closeTtk)} · " +
                     $"30m TTK {Milliseconds(farTtk)} · {resolved.Rpm:0} rpm · {resolved.MagSize} 發";
        AddChoice(rows, label, baseWeapon.Id, unlockedWeapons,
            item => item.Id, item => item.Name, _ => detail,
            value =>
            {
                if (primary) loadout.Primary = value;
                else loadout.Secondary = value;
                attachments.Clear();
            });

        foreach (var slot in baseWeapon.AttachmentSlots)
        {
            var current = attachments.FirstOrDefault(id =>
                AttachmentData.Attachments.TryGetValue(id, out var attachment) && attachment.Slot == slot) ??
                          string.Empty;
            var choices = AttachmentData.AttachmentsForSlot(slot, baseWeapon.Class).Where(Unlocked).ToArray();
            var currentDef = string.IsNullOrEmpty(current) ? null : AttachmentData.GetAttachment(current);
            var description = currentDef is null
                ? $"{AttachmentSlotName(slot)}配件；最多 {AttachmentData.MaxEquippedAttachments} 件。"
                : $"{currentDef.Description}  + {string.Join("、", currentDef.Pros)}  − {string.Join("、", currentDef.Cons)}";
            AddChoice(rows, $"  {AttachmentSlotName(slot)}", current, choices,
                item => item.Id, item => item.Name, _ => description,
                value =>
                {
                    attachments.RemoveAll(id => AttachmentData.Attachments.TryGetValue(id, out var attachment) &&
                                                   attachment.Slot == slot);
                    if (string.IsNullOrEmpty(value)) return;
                    if (attachments.Count < AttachmentData.MaxEquippedAttachments) attachments.Add(value);
                }, allowNone: true,
                canSelect: value => string.IsNullOrEmpty(value) || !string.IsNullOrEmpty(current) ||
                                    attachments.Count < AttachmentData.MaxEquippedAttachments);
        }
    }

    private void AddChoice<T>(
        List<LoadoutEditorRow> rows,
        string label,
        string current,
        IReadOnlyList<T> choices,
        Func<T, string> id,
        Func<T, string> name,
        Func<T, string> description,
        Action<string> apply,
        bool allowNone = false,
        Func<string, bool>? canSelect = null)
    {
        var ids = choices.Select(id).ToList();
        if (allowNone) ids.Insert(0, string.Empty);
        if (ids.Count == 0) return;
        var index = ids.IndexOf(current);
        if (index < 0) index = 0;
        var activeId = ids[index];
        var active = choices.FirstOrDefault(item => id(item) == activeId);
        var value = string.IsNullOrEmpty(activeId) ? "— 無 —" : active is null ? activeId : name(active);
        var detail = active is null ? "未裝備。" : description(active);
        rows.Add(new(label, value, detail, direction =>
        {
            var target = ids[Wrap(index + direction, ids.Count)];
            if (canSelect is not null && !canSelect(target)) return false;
            apply(target);
            return target != activeId;
        }));
    }

    private bool Unlocked(WeaponDef item) => item.UnlockLevel <= _profile.Rank;
    private bool Unlocked(AttachmentDef item) => item.UnlockLevel <= _profile.Rank;
    private bool Unlocked(EquipmentDef item) => item.UnlockLevel <= _profile.Rank;
    private bool Unlocked(PerkDef item) => item.UnlockLevel <= _profile.Rank;
    private bool Unlocked(KillstreakDef item) => item.UnlockLevel <= _profile.Rank;

    private static string Milliseconds(double seconds) =>
        double.IsFinite(seconds) ? $"{Math.Round(seconds * 1000):0}ms" : "—";

    private static string WeaponClassName(WeaponClass value) => value switch
    {
        WeaponClass.AssaultRifle => "突擊步槍",
        WeaponClass.SubmachineGun => "衝鋒槍",
        WeaponClass.LightMachineGun => "輕機槍",
        WeaponClass.SniperRifle => "狙擊步槍",
        WeaponClass.MarksmanRifle => "精準步槍",
        WeaponClass.Shotgun => "霰彈槍",
        WeaponClass.Pistol => "手槍",
        WeaponClass.Launcher => "發射器",
        WeaponClass.Melee => "近戰",
        _ => "特殊",
    };

    private static string AttachmentSlotName(AttachmentSlot value) => value switch
    {
        AttachmentSlot.Muzzle => "槍口",
        AttachmentSlot.Barrel => "槍管",
        AttachmentSlot.Optic => "瞄具",
        AttachmentSlot.Underbarrel => "槍管下掛",
        AttachmentSlot.Magazine => "彈匣",
        AttachmentSlot.Stock => "槍托",
        AttachmentSlot.RearGrip => "後握把",
        AttachmentSlot.Laser => "雷射",
        _ => value.ToString(),
    };

    private static int Wrap(int value, int count) => count <= 0 ? 0 : (value % count + count) % count;
}

public sealed record LoadoutEditorRow(
    string Label,
    string Value,
    string Description,
    Func<int, bool> Adjust);

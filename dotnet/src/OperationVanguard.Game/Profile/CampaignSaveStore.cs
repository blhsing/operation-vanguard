using System.Text.Json;
using OperationVanguard.Core;

namespace OperationVanguard.Game.Profile;

public sealed class CampaignSaveDocument
{
    public int Version { get; init; } = CampaignSaveStore.CurrentVersion;
    public DateTimeOffset SavedAtUtc { get; init; }
    public required CampaignSaveSnapshot Snapshot { get; init; }
}

/// <summary>Atomic persistence for the native campaign quick-save slot.</summary>
public static class CampaignSaveStore
{
    public const int CurrentVersion = 1;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
    };

    public static string SavePath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "OperationVanguard",
        "campaign-quicksave.json");

    public static bool Save(CampaignSaveSnapshot snapshot, string? path = null)
    {
        try
        {
            var target = path ?? SavePath;
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            var document = new CampaignSaveDocument
            {
                SavedAtUtc = DateTimeOffset.UtcNow,
                Snapshot = snapshot,
            };
            var temporary = target + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(document, JsonOptions));
            File.Move(temporary, target, true);
            return true;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }

    public static CampaignSaveDocument? Load(string? path = null)
    {
        try
        {
            var target = path ?? SavePath;
            if (!File.Exists(target)) return null;
            var document = JsonSerializer.Deserialize<CampaignSaveDocument>(
                File.ReadAllText(target),
                JsonOptions);
            if (document is null || document.Version != CurrentVersion) return null;
            var save = document.Snapshot;
            if (save is null ||
                string.IsNullOrWhiteSpace(save.MissionId) ||
                !CampaignCatalog.MissionIds.Contains(save.MissionId) ||
                save.Position is null ||
                !double.IsFinite(save.Position.X) ||
                !double.IsFinite(save.Position.Y) ||
                !double.IsFinite(save.Position.Z) ||
                !double.IsFinite(save.Yaw) ||
                !double.IsFinite(save.Pitch) ||
                save.Weapons is null ||
                save.Weapons.Count < 2 ||
                save.Weapons.Any(weapon => weapon is null ||
                    string.IsNullOrWhiteSpace(weapon.DefId) ||
                    weapon.Attachments is null) ||
                (int)save.ActiveSlot < 0 ||
                (int)save.ActiveSlot >= save.Weapons.Count ||
                save.Objectives is null ||
                save.Objectives.Count == 0 ||
                save.Objectives.Any(pair => pair.Value is null))
            {
                return null;
            }
            return document;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

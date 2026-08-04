namespace OperationVanguard.Core;

/// <summary>The campaign's six missions in authored play order.</summary>
public static class CampaignCatalog
{
    public static IReadOnlyList<MissionDef> CampaignMissions { get; } =
    [
        CampaignDefinitions.ColdOpen,
        CampaignDefinitions.AshAndStone,
        CampaignDefinitions.CrackingTower,
        CampaignDefinitions.LineThree,
        CampaignDefinitions.Noon,
        CampaignDefinitions.LastFloor,
    ];

    public static IReadOnlyDictionary<string, MissionDef> Missions { get; } = CampaignMissions
        .ToDictionary(mission => mission.Id, StringComparer.Ordinal);

    public static IReadOnlyList<string> MissionIds { get; } = CampaignMissions
        .Select(mission => mission.Id)
        .ToArray();

    public static MissionDef GetMission(string id)
    {
        if (!Missions.TryGetValue(id, out var mission))
        {
            throw new KeyNotFoundException($"Unknown mission id: {id}");
        }

        return mission;
    }

    public static MissionDef? TryGetMission(string id) =>
        Missions.TryGetValue(id, out var mission) ? mission : null;

    public static MissionDef? NextMission(string id)
    {
        for (var index = 0; index < CampaignMissions.Count; index++)
        {
            if (CampaignMissions[index].Id == id)
            {
                return index + 1 < CampaignMissions.Count ? CampaignMissions[index + 1] : null;
            }
        }

        return null;
    }

    public static IReadOnlyDictionary<string, IReadOnlyList<string>> ValidateAllMissions()
    {
        var output = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        foreach (var mission in CampaignMissions)
        {
            var errors = CampaignValidation.ValidateMission(mission);
            if (errors.Count > 0)
            {
                output[mission.Id] = errors;
            }
        }

        return output;
    }
}

public static partial class CampaignDefinitions;

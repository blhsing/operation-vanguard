using System.Text.Json;
using System.Text.Json.Serialization;

namespace OperationVanguard.Core;

[JsonConverter(typeof(JsonStringEnumConverter<ObjectiveKind>))]
public enum ObjectiveKind
{
    [JsonStringEnumMemberName("dom_flag")] DominationFlag,
    [JsonStringEnumMemberName("bomb_site")] BombSite,
    [JsonStringEnumMemberName("hardpoint")] Hardpoint,
    [JsonStringEnumMemberName("hq")] Headquarters,
    [JsonStringEnumMemberName("capture")] Capture,
}

public static class ObjectiveKindIds
{
    public static string ToId(this ObjectiveKind kind) => kind switch
    {
        ObjectiveKind.DominationFlag => "dom_flag",
        ObjectiveKind.BombSite => "bomb_site",
        ObjectiveKind.Hardpoint => "hardpoint",
        ObjectiveKind.Headquarters => "hq",
        ObjectiveKind.Capture => "capture",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, null),
    };

    public static ObjectiveKind FromId(string id) => id switch
    {
        "dom_flag" => ObjectiveKind.DominationFlag,
        "bomb_site" => ObjectiveKind.BombSite,
        "hardpoint" => ObjectiveKind.Hardpoint,
        "hq" => ObjectiveKind.Headquarters,
        "capture" => ObjectiveKind.Capture,
        _ => throw new KeyNotFoundException($"Unknown objective kind: {id}"),
    };

    public static bool TryFromId(string id, out ObjectiveKind kind)
    {
        switch (id)
        {
            case "dom_flag": kind = ObjectiveKind.DominationFlag; return true;
            case "bomb_site": kind = ObjectiveKind.BombSite; return true;
            case "hardpoint": kind = ObjectiveKind.Hardpoint; return true;
            case "hq": kind = ObjectiveKind.Headquarters; return true;
            case "capture": kind = ObjectiveKind.Capture; return true;
            default: kind = default; return false;
        }
    }
}

public sealed class ModeScoring
{
    public double Kill { get; set; }
    public double Assist { get; set; }
    public double Capture { get; set; }
    public double Defend { get; set; }
    public double ObjectiveTick { get; set; }
    public double ObjectiveTickInterval { get; set; }
    public double Plant { get; set; }
    public double Defuse { get; set; }
    public double Confirm { get; set; }
    public double Deny { get; set; }
}

public sealed class GameModeDef
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string ShortName { get; set; } = "";
    public string Description { get; set; } = "";
    public bool TeamBased { get; set; }
    public double ScoreLimit { get; set; }
    public double TimeLimit { get; set; }
    public int RoundsToWin { get; set; }
    public double RoundTime { get; set; }
    public bool Respawn { get; set; }
    public double RespawnDelay { get; set; }
    public ObjectiveKind? ObjectiveKind { get; set; }
    public ModeScoring Scoring { get; set; } = new();
    public Dictionary<string, JsonElement> Params { get; set; } = new(StringComparer.Ordinal);
    public bool KillstreaksEnabled { get; set; }
    public bool ScorestreaksOnly { get; set; }
    public bool TeamScoresOnKill { get; set; }
    public List<int> TeamSize { get; set; } = [];
    public string IntroLine { get; set; } = "";

    public double NumberParam(string key, double fallback = 0)
        => Params.TryGetValue(key, out var value) && value.ValueKind == JsonValueKind.Number
            ? value.GetDouble()
            : fallback;

    public bool BoolParam(string key, bool fallback = false)
        => Params.TryGetValue(key, out var value)
            ? value.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => fallback,
            }
            : fallback;

    public string StringParam(string key, string fallback = "")
        => Params.TryGetValue(key, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? fallback
            : fallback;
}

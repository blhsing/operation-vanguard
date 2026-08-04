using static OperationVanguard.Core.CampaignData;

namespace OperationVanguard.Core;

public static partial class CampaignDefinitions
{
    public static MissionDef ColdOpen { get; } = new()
    {
        Id = "cold_open",
        Name = "冷開場",
        MapId = "shipment_yard",
        Brief =
            "一座貨櫃場，位在河的錯誤那一岸。情報說有十來名非正規軍" +
            "把那裡當集結點。情報以前也錯過。",
        Insertion = new(V(-11, 0.1, 13), 0),
        Difficulty = DifficultyId.Recruit,
        Allies =
        [
            Ally("vasquez", "Vasquez", V(-8, 0.1, 13), BotArchetype.Rifleman),
        ],
        Objectives =
        [
            new Objective
            {
                Id = "push",
                Label = "清空近側貨櫃堆",
                Line = "Vasquez：跟緊我。他們就在貨櫃之間——沒什麼花招。",
                Trigger = new EliminateTrigger(2),
                Waves =
                [
                    Wave(V(10, 0.1, -11), V(13, 0.1, -11), 1, 6.4,
                        archetypes: [BotArchetype.Rifleman]),
                    Wave(V(-5, 0.1, -5), V(-5, 0.1, -2), 1, 8, delay: 3,
                        archetypes: [BotArchetype.Rifleman]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "clear",
                Label = "清空貨櫃場",
                After = ["push"],
                Line = "Vasquez：貨櫃堆裡還有。注意縫隙。",
                Trigger = new EliminateTrigger(4),
                Waves =
                [
                    Wave(V(13, 0.1, 4), V(10, 0.1, 4), 2, 8,
                        archetypes: [BotArchetype.Rifleman]),
                    Wave(V(-11, 0.1, -8), V(-11, 0.1, -5), 2, 9.6, delay: 6,
                        archetypes: [BotArchetype.Rifleman]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "hold",
                Label = "固守待撤離",
                After = ["clear"],
                Line = "指揮部：直升機四分鐘後到。守住你手上的。",
                Trigger = new SurviveTrigger(30),
                Waves =
                [
                    Wave(V(10, 0.1, -11), V(10, 0.1, -11), 1, 14.4, endless: true,
                        archetypes: [BotArchetype.Rifleman]),
                    Wave(V(-11, 0.1, 10), V(-11, 0.1, 10), 1, 17.6, delay: 5, endless: true,
                        archetypes: [BotArchetype.Rifleman]),
                ],
            },
        ],
        Outro = "貨櫃場清空。他們說是十二個非正規軍。",
    };
}

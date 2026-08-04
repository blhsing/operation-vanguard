using static OperationVanguard.Core.CampaignData;

namespace OperationVanguard.Core;

public static partial class CampaignDefinitions
{
    public static MissionDef LastFloor { get; } = new()
    {
        Id = "last_floor",
        Name = "最後一層",
        MapId = "highrise",
        Brief =
            "四十層樓高，兩座塔樓，中間一座停機坪。所有" +
            "要緊的人都在這個屋頂上，沒有一個想到樓梯會是" +
            "比較安全的下去方式。",
        Insertion = new(V(0, 0.1, 27), -0.16),
        Difficulty = DifficultyId.Regular,
        Allies =
        [
            Ally("kowalczyk", "Kowalczyk", V(-4, 0.1, 26), BotArchetype.Rifleman),
            Ally("adeyemi", "Adeyemi", V(4, 0.1, 26), BotArchetype.Support),
            Ally("strand", "Strand", V(0, 0.1, 30), BotArchetype.Sniper),
        ],
        Garrison =
        [
            Wave(V(0, 0.1, -27), V(0, 0.1, -27), 2, 2.4,
                archetypes: [BotArchetype.Rifleman]),
            Wave(V(19.5, 3.65, 4), V(19.5, 3.65, 4), 1, 3.2,
                archetypes: [BotArchetype.Sniper]),
        ],
        Objectives =
        [
            new Objective
            {
                Id = "service_core",
                Label = "清空服務核心",
                Line = "Kowalczyk：東塔。兩層樓，上面那層是他們的。",
                Trigger = new ReachTrigger(Z(V(26, 2.0, -4), V(16, 9, 14))),
                ReapOnComplete = true,
                Waves =
                [
                    Wave(V(27, 3.65, -8), V(27, 3.65, -8), 2, 5.6,
                        archetypes: [BotArchetype.Rifleman, BotArchetype.Sniper]),
                    Wave(V(33, 0.1, -23.4), V(33, 0.1, -23.4), 2, 6.4, delay: 3,
                        archetypes: [BotArchetype.Rusher]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "north_tower",
                Label = "清空北塔",
                After = ["service_core"],
                Line = "Adeyemi：西側更糟。房間短、玻璃牆，完全沒有射角。",
                Trigger = new ReachTrigger(Z(V(-24, 2.0, -8), V(16, 9, 16))),
                ReapOnComplete = true,
                Waves =
                [
                    Wave(V(-20, 2.9, -8), V(-20, 2.9, -8), 2, 6.4,
                        archetypes: [BotArchetype.Rusher, BotArchetype.Rifleman]),
                    Wave(V(-33, 0.1, -23.4), V(-33, 0.1, -23.4), 2, 7.2, delay: 4,
                        archetypes: [BotArchetype.Rifleman]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "mark",
                Label = "標記降落區",
                After = ["north_tower"],
                Line = "Strand：停機坪上沒有掩體，而這是單面刃。把它做完。",
                Trigger = new InteractTrigger(Z(V(0, 0.5, 0), V(13, 6, 13)), 6, "標記降落區"),
                Waves =
                [
                    Wave(V(0, 0.1, -27), V(0, 0.1, -27), 2, 12, delay: 5,
                        archetypes: [BotArchetype.Rifleman]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "hold_pad",
                Label = "守住停機坪",
                After = ["mark"],
                Line = "指揮部：兩分鐘。屋頂上的每一個東西現在都知道你在哪。",
                Trigger = new HoldTrigger(Z(V(0, 0.5, 0), V(18, 7, 18)), 55),
                Waves =
                [
                    Wave(V(0, 0.1, -27), V(0, 0.1, -27), 1, 7.2, endless: true,
                        archetypes: [BotArchetype.Rusher]),
                    Wave(V(-38, 0.1, 0), V(-38, 0.1, 0), 1, 9.6, delay: 3, endless: true,
                        archetypes: [BotArchetype.Rifleman]),
                    Wave(V(39, 0.1, 4), V(39, 0.1, 4), 1, 11.2, delay: 6, endless: true,
                        archetypes: [BotArchetype.Sniper, BotArchetype.Scout]),
                ],
            },
        ],
        Outro = "起飛。屋頂上沒剩下任何人揮手。",
    };
}

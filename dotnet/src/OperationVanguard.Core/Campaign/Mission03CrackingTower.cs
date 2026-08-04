using static OperationVanguard.Core.CampaignData;

namespace OperationVanguard.Core;

public static partial class CampaignDefinitions
{
    public static MissionDef CrackingTower { get; } = new()
    {
        Id = "cracking_tower",
        Name = "裂解塔",
        MapId = "refinery",
        Brief =
            "他們讓煉油廠以半產能運轉了六週，" +
            "差額運往我們追不上的地方。兩包炸藥，兩座塔，" +
            "在壓力掉下來之前撤出。",
        Insertion = new(V(-2, 0.1, 35), -0.16),
        Difficulty = DifficultyId.Regular,
        Allies =
        [
            Ally("brandt", "Brandt", V(-6, 0.1, 34), BotArchetype.Rifleman),
            Ally("sood", "Sood", V(2, 0.1, 34), BotArchetype.Support),
        ],
        Garrison =
        [
            Wave(V(16, 0.1, -26), V(16, 0.1, -26), 2, 2.4,
                archetypes: [BotArchetype.Rifleman]),
        ],
        Objectives =
        [
            new Objective
            {
                Id = "east_approach",
                Label = "抵達東側裂解塔",
                Line = "Brandt：先打東塔。那座最吵——沒人會聽見我們動手。",
                Trigger = new ReachTrigger(Z(V(28, 0, 0), V(12, 6, 12))),
                Waves =
                [
                    Wave(V(30, 0.1, -25), V(30, 0.1, -25), 3, 5.6,
                        archetypes: [BotArchetype.Rifleman, BotArchetype.Rusher]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "charge_east",
                Label = "安裝炸藥",
                After = ["east_approach"],
                Line = "Sood：按住按鍵別放。我幫你擋著。",
                Trigger = new InteractTrigger(Z(V(28, 0, 0), V(9, 6, 9)), 8, "安裝炸藥"),
                Waves =
                [
                    Wave(V(41, 0.1, -16), V(41, 0.1, -16), 1, 9.6, endless: true,
                        archetypes: [BotArchetype.Rusher]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "west_approach",
                Label = "轉往西塔",
                After = ["charge_east"],
                Line = "Brandt：他們知道了。往西側，快。",
                Trigger = new ReachTrigger(Z(V(-31, 0, -8), V(12, 6, 12))),
                Waves =
                [
                    Wave(V(-29, 0.1, -24), V(-29, 0.1, -24), 3, 4.8,
                        archetypes: [BotArchetype.Rifleman]),
                    Wave(V(-36, 0.1, -12), V(-36, 0.1, -12), 2, 6.4, delay: 4,
                        archetypes: [BotArchetype.Sniper]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "charge_west",
                Label = "安裝第二包炸藥",
                After = ["west_approach"],
                Line = "Sood：再來一次。除了炸藥以外什麼都別管。",
                Trigger = new InteractTrigger(Z(V(-31, 0, -8), V(9, 6, 9)), 8, "安裝炸藥"),
                Waves =
                [
                    Wave(V(-29, 0.1, -24), V(-29, 0.1, -24), 1, 8, endless: true,
                        archetypes: [BotArchetype.Rusher, BotArchetype.Rifleman]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "exfil",
                Label = "前往撤離點",
                After = ["charge_west"],
                Line = "指揮部：炸藥已啟動。你有九十秒，還有一段長路。",
                TimeLimit = 110,
                Trigger = new ReachTrigger(Z(V(-2, 0, 35), V(16, 6, 12))),
                Waves =
                [
                    Wave(V(-2, 0.1, -35), V(-2, 0.1, -35), 1, 12.8, endless: true,
                        archetypes: [BotArchetype.Rifleman]),
                ],
            },
        ],
        Outro = "炸藥送出去了。他們有一陣子什麼都運不出去。",
    };
}

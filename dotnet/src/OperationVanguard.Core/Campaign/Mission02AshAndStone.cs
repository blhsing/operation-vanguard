using static OperationVanguard.Core.CampaignData;

namespace OperationVanguard.Core;

public static partial class CampaignDefinitions
{
    public static MissionDef AshAndStone { get; } = new()
    {
        Id = "ash_and_stone",
        Name = "灰燼與磚石",
        MapId = "crossfire",
        Brief =
            "這座村莊卡在唯一一條北上的路上。這個月已經四度易手，" +
            "沒有人守住廣場超過一天。",
        Insertion = new(V(0, 0.1, 34), -0.18),
        Difficulty = DifficultyId.Regular,
        Allies =
        [
            Ally("reyes", "Reyes", V(-3, 0.1, 33), BotArchetype.Rifleman),
            Ally("okafor", "Okafor", V(3, 0.1, 33), BotArchetype.Support),
        ],
        Garrison =
        [
            Wave(V(0, 0.1, -18), V(0, 0.1, -18), 2, 1.6,
                archetypes: [BotArchetype.Rifleman]),
            Wave(V(29, 0.1, -18), V(29, 0.1, -18), 1, 1.6,
                archetypes: [BotArchetype.Sniper]),
        ],
        Objectives =
        [
            new Objective
            {
                Id = "west",
                Label = "奪取西側通道",
                Line = "Reyes：走左邊。從中間上去會被攔腰打斷。",
                Trigger = new ReachTrigger(Z(V(-29, 0, 16), V(10, 5, 10))),
                Waves =
                [
                    Wave(V(-31, 0.1, -12), V(-31, 0.1, -12), 3, 5.6,
                        archetypes: [BotArchetype.Rifleman, BotArchetype.Rusher]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "square",
                Label = "擊潰廣場守軍",
                After = ["west"],
                Line = "Okafor：他們在噴泉周圍掘壕固守。你說一聲。",
                Trigger = new EliminateTrigger(5),
                Waves =
                [
                    Wave(V(0, 0.1, -18), V(0, 0.1, -18), 4, 4.8,
                        archetypes: [BotArchetype.Rifleman]),
                    Wave(V(29, 0.1, -24), V(29, 0.1, -24), 3, 6.4, delay: 5,
                        archetypes: [BotArchetype.Rusher]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "hold",
                Label = "守住廣場",
                After = ["square"],
                Line = "指揮部：裝甲正沿著路上來。守住廣場，等它上來為止。",
                Trigger = new HoldTrigger(Z(V(0, 0, 0), V(14, 6, 14)), 40),
                Waves =
                [
                    Wave(V(0, 0.1, -34), V(0, 0.1, -34), 1, 11.2, endless: true,
                        archetypes: [BotArchetype.Rifleman]),
                    Wave(V(-29, 0.1, -25), V(-29, 0.1, -25), 1, 14.4, delay: 4, endless: true,
                        archetypes: [BotArchetype.Rusher, BotArchetype.Scout]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "north",
                Label = "清空北向道路",
                After = ["hold"],
                Line = "Reyes：路通了。過去看看。",
                Trigger = new ReachTrigger(Z(V(0, 0, -34), V(14, 5, 12))),
                Waves =
                [
                    Wave(V(-29, 0.1, -25), V(-29, 0.1, -25), 2, 6.4,
                        archetypes: [BotArchetype.Sniper, BotArchetype.Rifleman]),
                ],
            },
        ],
        Outro = "村子是我們的了。頂多一天。",
    };
}

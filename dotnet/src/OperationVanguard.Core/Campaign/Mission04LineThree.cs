using static OperationVanguard.Core.CampaignData;

namespace OperationVanguard.Core;

public static partial class CampaignDefinitions
{
    public static MissionDef LineThree { get; } = new()
    {
        Id = "line_three",
        Name = "三號線",
        MapId = "subway",
        Brief =
            "地面上所有通訊都被北側月台上的一具中繼台干擾。" +
            "Marchetti可以把它掉頭對準他們。Marchetti" +
            "在任何情況下都不能中彈。",
        Insertion = new(V(-13, 0.1, 32), -0.14),
        Difficulty = DifficultyId.Regular,
        Allies =
        [
            Ally("marchetti", "Marchetti", V(-15, 0.1, 34), BotArchetype.Support, essential: true),
            Ally("doyle", "Doyle", V(-11, 0.1, 33), BotArchetype.Rusher),
            Ally("ferrara", "Ferrara", V(13, 0.1, 33), BotArchetype.Rifleman),
        ],
        Garrison =
        [
            Wave(V(-13, 0.1, -18), V(-13, 0.1, -18), 2, 2.4,
                archetypes: [BotArchetype.Rifleman]),
            Wave(V(13, 0.1, -18), V(13, 0.1, -18), 1, 3.2,
                archetypes: [BotArchetype.Rusher]),
        ],
        Objectives =
        [
            new Objective
            {
                Id = "concourse",
                Label = "清空中央大廳",
                Line = "Doyle：先兩側月台，再中間。讓Marchetti待在你後面。",
                Trigger = new EliminateTrigger(4),
                Waves =
                [
                    Wave(V(13, 0.1, -18), V(13, 0.1, -18), 3, 4.8,
                        archetypes: [BotArchetype.Rusher, BotArchetype.Rifleman]),
                    Wave(V(-13, 0.1, -18), V(-13, 0.1, -18), 2, 6.4, delay: 3,
                        archetypes: [BotArchetype.Rifleman]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "mezzanine",
                Label = "奪取夾層",
                After = ["concourse"],
                Line = "Ferrara：他們在走道上。他們不清掉，我們哪裡都去不了。",
                Trigger = new ReachTrigger(Z(V(21, 4.3, -18), V(10, 4, 12))),
                Waves =
                [
                    Wave(V(21, 4.3, -18), V(21, 4.3, -18), 2, 6.4,
                        archetypes: [BotArchetype.Sniper, BotArchetype.Rifleman]),
                    Wave(V(-21, 4.3, 14), V(-21, 4.3, 14), 1, 8, delay: 4,
                        archetypes: [BotArchetype.Scout]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "escort",
                Label = "護送Marchetti到北側中繼台",
                After = ["mezzanine"],
                Line = "Marchetti：移動中。別讓我後悔這麼做。",
                Trigger = new EscortTrigger("marchetti", Z(V(-15, 0, -20), V(14, 6, 14))),
                Waves =
                [
                    Wave(V(13, 0.1, -30), V(13, 0.1, -30), 1, 11.2, endless: true,
                        archetypes: [BotArchetype.Rifleman]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "cover",
                Label = "在中繼台掩護Marchetti",
                After = ["escort"],
                Line = "Marchetti：九十秒。沒人朝我開槍的話會更快。",
                Trigger = new SurviveTrigger(45),
                Waves =
                [
                    Wave(V(-13, 0.1, -30), V(-13, 0.1, -30), 1, 8, endless: true,
                        archetypes: [BotArchetype.Rusher]),
                    Wave(V(13, 0.1, -30), V(13, 0.1, -30), 1, 9.6, delay: 3, endless: true,
                        archetypes: [BotArchetype.Rifleman]),
                ],
            },
        ],
        Outro = "中繼台到手。Marchetti希望大家記下來：有人朝他開槍。",
    };
}

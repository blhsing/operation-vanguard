using static OperationVanguard.Core.CampaignData;

namespace OperationVanguard.Core;

public static partial class CampaignDefinitions
{
    public static MissionDef Noon { get; } = new()
    {
        Id = "noon",
        Name = "正午",
        MapId = "dust_market",
        Brief =
            "他們在正午、在光天化日下把錢運過市集，因為" +
            "從來沒有人蠢到會在正午、在光天化日下來把它拿走。",
        Insertion = new(V(0, 0.1, 34), -0.16),
        Difficulty = DifficultyId.Regular,
        Allies =
        [
            Ally("nasser", "Nasser", V(-4, 0.1, 33), BotArchetype.Rusher),
            Ally("lindqvist", "Lindqvist", V(4, 0.1, 33), BotArchetype.Sniper),
        ],
        Garrison =
        [
            Wave(V(0, 0.1, -28), V(0, 0.1, -28), 2, 2.4,
                archetypes: [BotArchetype.Rifleman]),
            Wave(V(-20, 0.1, -30), V(-20, 0.1, -30), 1, 3.2,
                archetypes: [BotArchetype.Rusher]),
        ],
        Objectives =
        [
            new Objective
            {
                Id = "market",
                Label = "強行通過市集",
                Line = "Nasser：攤位只擋得住一個方向。挑清楚。",
                Trigger = new EliminateTrigger(6),
                Waves =
                [
                    Wave(V(0, 0.1, -28), V(0, 0.1, -28), 4, 4,
                        archetypes: [BotArchetype.Rusher, BotArchetype.Rifleman]),
                    Wave(V(16, 0.1, -18), V(16, 0.1, -18), 3, 5.6, delay: 3,
                        archetypes: [BotArchetype.Rifleman]),
                    Wave(V(-16, 0.1, 12), V(-16, 0.1, 12), 2, 8, delay: 8,
                        archetypes: [BotArchetype.Scout]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "colonnade",
                Label = "清空柱廊",
                After = ["market"],
                Line = "Lindqvist：西側。你把我帶過去，我從拱門那邊有射角。",
                Trigger = new ReachTrigger(Z(V(-28, 0, 14), V(12, 6, 12))),
                Waves =
                [
                    Wave(V(-38, 0.1, -22), V(-38, 0.1, -22), 3, 5.6,
                        archetypes: [BotArchetype.Rifleman, BotArchetype.Sniper]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "terrace",
                Label = "奪取屋頂平台",
                After = ["colonnade"],
                Line = "Nasser：樓梯在另一頭。要繞很遠，而且沒別條路。",
                Trigger = new ReachTrigger(Z(V(28, 6.75, 6), V(16, 5, 22))),
                Waves =
                [
                    Wave(V(28, 6.85, -2), V(28, 6.85, -2), 2, 6.4,
                        archetypes: [BotArchetype.Rifleman]),
                    Wave(V(39, 0.1, -12), V(39, 0.1, -12), 2, 6.4, delay: 4,
                        archetypes: [BotArchetype.Rusher]),
                ],
                Checkpoint = true,
            },
            new Objective
            {
                Id = "hold",
                Label = "固守平台待撤離",
                After = ["terrace"],
                Line = "指揮部：屋頂就是降落區。想上來的都得走樓梯。",
                Trigger = new HoldTrigger(Z(V(28, 6.75, 6), V(18, 5, 24)), 50),
                Waves =
                [
                    Wave(V(39, 0.1, -12), V(39, 0.1, -12), 1, 8, endless: true,
                        archetypes: [BotArchetype.Rusher]),
                    Wave(V(20, 0.1, 30), V(20, 0.1, 30), 1, 11.2, delay: 4, endless: true,
                        archetypes: [BotArchetype.Rifleman]),
                ],
            },
        ],
        Outro = "錢上了直升機。難得的是，我們也上了。",
    };
}

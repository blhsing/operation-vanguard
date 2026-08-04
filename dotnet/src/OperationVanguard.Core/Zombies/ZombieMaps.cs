namespace OperationVanguard.Core;

public static class ZombieMaps
{
    private static Vec3 V(double x, double y, double z) => new(x, y, z);

    public static ZombiesMapData Crossfire { get; } = new()
    {
        MapId = "crossfire",
        PlayerSpawns = [V(-2, .1, 30), V(2, .1, 30), V(-2, .1, 27), V(2, .1, 27)],
        StartingWeapon = "p226",
        StartingPistol = "p226",
        StartingPoints = 500,
        Zones =
        [
            Zone("start", "南廣場", true,
                V(-12, .1, 34), V(12, .1, 34), V(-16, .1, 26), V(16, .1, 26)),
            Zone("mid", "市集廣場", false,
                V(-10, .1, 8), V(10, .1, 10), V(-9, .1, -8), V(9, .1, -6)),
            Zone("west", "西側巷弄", false,
                V(-33, .1, 20), V(-34, .1, -4), V(-30, .1, -22)),
            Zone("warehouse", "倉庫", false,
                V(24, .1, 8), V(23, .1, -14), V(34, .1, 2)),
            Zone("north", "北側貨場", false,
                V(-12, .1, -30), V(12, .1, -30), V(0, .1, -34)),
        ],
        Interactables =
        [
            I("door_mid", InteractKind.Door, V(0, .1, 20), 0, 750, "start", "清除瓦礫",
                opensZone: "mid"),
            I("door_west", InteractKind.Door, V(-26, .1, 22), Math.PI / 2, 1000, "start",
                "開啟巷弄鐵門", opensZone: "west"),
            I("door_warehouse", InteractKind.Door, V(27, .1, 18), -Math.PI / 2, 1250, "start",
                "開啟裝卸門", opensZone: "warehouse"),
            I("door_north", InteractKind.Door, V(0, .1, -22), 0, 1500, "mid", "撬開北側閘門",
                opensZone: "north"),

            I("wall_smg", InteractKind.WallBuy, V(-7, 1.2, 31), Math.PI, 1000, "start", "MP9-K",
                weaponId: "mp9k", ammoCost: 450),
            I("wall_shotgun", InteractKind.WallBuy, V(7, 1.2, 31), Math.PI, 1200, "start",
                "M870 破門", weaponId: "m870", ammoCost: 500),
            I("wall_ar", InteractKind.WallBuy, V(-4, 1.2, 2), -Math.PI / 2, 1400, "mid",
                "VK-47 山貓", weaponId: "vk47", ammoCost: 600),
            I("wall_smg2", InteractKind.WallBuy, V(-30, 1.2, 6), -Math.PI / 2, 1300, "west",
                "Vector-9", weaponId: "vector9", ammoCost: 550),
            I("wall_lmg", InteractKind.WallBuy, V(22, 1.2, -6), Math.PI / 2, 1800, "warehouse",
                "M60-E 鐵砧", weaponId: "m60e", ammoCost: 750),
            I("wall_sniper", InteractKind.WallBuy, V(-8, 1.2, -28), 0, 1600, "north",
                "GR-63 鐵鎚", weaponId: "gr63", ammoCost: 700),

            I("power", InteractKind.Power, V(20, .1, -16), 0, 0, "warehouse", "啟動電力"),
            I("box", InteractKind.MysteryBox, V(19, .1, 6), Math.PI, 0, "warehouse", "神秘箱"),
            I("pap", InteractKind.PackAPunch, V(0, .1, -30), Math.PI, 0, "north", "強化機",
                requiresPower: true),
            I("perk_revive", InteractKind.PerkMachine, V(6, .1, 27), Math.PI, 0, "start",
                "快速復活", perkId: "quick_revive"),
            I("perk_jugg", InteractKind.PerkMachine, V(21, .1, 2), Math.PI / 2, 0, "warehouse",
                "重裝可樂", perkId: "juggernog", requiresPower: true),
            I("perk_speed", InteractKind.PerkMachine, V(-32, .1, -14), -Math.PI / 2, 0, "west",
                "快速可樂", perkId: "speed_cola", requiresPower: true),
            I("perk_doubletap", InteractKind.PerkMachine, V(-10, .1, -26), 0, 0, "north",
                "雙倍快發", perkId: "double_tap", requiresPower: true),
            I("perk_stamin", InteractKind.PerkMachine, V(-6, .1, 12), Math.PI, 0, "mid",
                "耐力增強", perkId: "stamin_up", requiresPower: true),
        ],
    };

    public static IReadOnlyDictionary<string, ZombiesMapData> All { get; } =
        new Dictionary<string, ZombiesMapData>(StringComparer.Ordinal) { [Crossfire.MapId] = Crossfire };

    public static IReadOnlyList<string> Ids { get; } = [.. All.Keys];

    public static ZombiesMapData Get(string mapId) => All.TryGetValue(mapId, out var data)
        ? data
        : throw new KeyNotFoundException($"No zombies layout for map: {mapId}");

    public static bool HasLayout(string mapId) => All.ContainsKey(mapId);

    private static ZombieZoneDef Zone(string id, string name, bool starting, params Vec3[] spawns) => new()
    {
        Id = id,
        Name = name,
        StartingZone = starting,
        SpawnPoints = spawns,
    };

    private static ZombieInteractableDef I(
        string id,
        InteractKind kind,
        Vec3 position,
        double yaw,
        int cost,
        string zone,
        string label,
        string? opensZone = null,
        string? weaponId = null,
        int? ammoCost = null,
        string? perkId = null,
        bool requiresPower = false) => new()
        {
            Id = id,
            Kind = kind,
            Position = position,
            Yaw = yaw,
            Cost = cost,
            Zone = zone,
            OpensZone = opensZone,
            WeaponId = weaponId,
            AmmoCost = ammoCost,
            PerkId = perkId,
            RequiresPower = requiresPower,
            Label = label,
        };
}

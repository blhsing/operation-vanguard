using OperationVanguard.Core;
using OperationVanguard.Game.Profile;

namespace OperationVanguard.Game.Tests;

public sealed class CampaignSaveTests
{
    [Fact]
    public void QuickSaveRoundTripRestoresCampaignAndPlayerProgress()
    {
        var path = Path.Combine(Path.GetTempPath(), $"operation-vanguard-save-{Guid.NewGuid():N}.json");
        try
        {
            var mission = CampaignCatalog.GetMission("cold_open");
            var original = new LocalSession(
                mission,
                "Alice",
                LoadoutSystem.DefaultLoadout("Test"));
            var campaign = Assert.IsType<CampaignDirector>(original.Campaign);
            var player = original.Player;
            var objective = campaign.State.Objectives.Values.First();

            campaign.State.Elapsed = 73.25;
            campaign.State.Restarts = 2;
            campaign.State.LastLine = "Checkpoint secured";
            objective.Active = true;
            objective.Elapsed = 8.5;
            objective.Progress = .625;
            objective.Kills = 3;
            player.Position = new Vec3(11.5, 2.25, -19.75);
            player.Yaw = 1.25;
            player.Pitch = -.18;
            player.Health = 67;
            player.Armor = 24;
            player.ActiveSlot = WeaponSlot.Secondary;
            player.LethalCount = 1;
            player.TacticalCount = 2;
            player.FieldUpgradeCharge = .72;
            player.Weapons[0].AmmoInMag = 13;
            player.Weapons[0].AmmoReserve = 91;

            Assert.True(CampaignSaveStore.Save(campaign.CaptureSave(player), path));
            var document = Assert.IsType<CampaignSaveDocument>(CampaignSaveStore.Load(path));
            var restored = new LocalSession(
                mission,
                "Alice",
                LoadoutSystem.DefaultLoadout("Test"),
                document.Snapshot);
            var restoredCampaign = Assert.IsType<CampaignDirector>(restored.Campaign);
            var restoredObjective = restoredCampaign.State.Objectives[objective.Id];

            Assert.Equal(MissionPhase.Active, restoredCampaign.State.Phase);
            Assert.Equal(73.25, restoredCampaign.State.Elapsed);
            Assert.Equal(2, restoredCampaign.State.Restarts);
            Assert.Equal("Checkpoint secured", restoredCampaign.State.LastLine);
            Assert.True(restoredObjective.Active);
            Assert.Equal(8.5, restoredObjective.Elapsed);
            Assert.Equal(.625, restoredObjective.Progress);
            Assert.Equal(3, restoredObjective.Kills);
            Assert.Equal(11.5, restored.Player.Position.X);
            Assert.Equal(2.25, restored.Player.Position.Y);
            Assert.Equal(-19.75, restored.Player.Position.Z);
            Assert.Equal(1.25, restored.Player.Yaw);
            Assert.Equal(-.18, restored.Player.Pitch);
            Assert.Equal(67, restored.Player.Health);
            Assert.Equal(24, restored.Player.Armor);
            Assert.Equal(WeaponSlot.Secondary, restored.Player.ActiveSlot);
            Assert.Equal(1, restored.Player.LethalCount);
            Assert.Equal(2, restored.Player.TacticalCount);
            Assert.Equal(.72, restored.Player.FieldUpgradeCharge);
            Assert.Equal(13, restored.Player.Weapons[0].AmmoInMag);
            Assert.Equal(91, restored.Player.Weapons[0].AmmoReserve);
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
            if (File.Exists(path + ".tmp")) File.Delete(path + ".tmp");
        }
    }

    [Fact]
    public void InvalidQuickSaveIsIgnored()
    {
        var path = Path.Combine(Path.GetTempPath(), $"operation-vanguard-save-{Guid.NewGuid():N}.json");
        try
        {
            File.WriteAllText(path, "{ not valid json");
            Assert.Null(CampaignSaveStore.Load(path));
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }

    [Fact]
    public void QuickSaveWithMissingSnapshotIsIgnored()
    {
        var path = Path.Combine(Path.GetTempPath(), $"operation-vanguard-save-{Guid.NewGuid():N}.json");
        try
        {
            File.WriteAllText(path,
                """{"version":1,"savedAtUtc":"2026-08-03T00:00:00Z","snapshot":null}""");
            Assert.Null(CampaignSaveStore.Load(path));
        }
        finally
        {
            if (File.Exists(path)) File.Delete(path);
        }
    }
}

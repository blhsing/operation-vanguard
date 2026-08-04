using OperationVanguard.Core;

namespace OperationVanguard.Tests;

public sealed class ContentTests
{
    [Fact]
    public void EveryRegistryHasTheSameIdsAsTheWebReference()
    {
        AssertIds("weapons", WeaponData.All.Select(item => item.Id));
        AssertIds("attachments", AttachmentData.All.Select(item => item.Id));
        AssertIds("perks", PerkData.All.Select(item => item.Id));
        AssertIds("equipment", EquipmentData.All.Select(item => item.Id));
        AssertIds("killstreaks", KillstreakData.All.Select(item => item.Id));
        AssertIds("modes", ModeData.All.Select(item => item.Id));
        AssertIds("maps", Maps.All.Select(item => item.Id));
    }

    [Fact]
    public void BalanceAndContentValidatorsAreClean()
    {
        Assert.Empty(WeaponData.ValidateArsenal());
        Assert.Empty(AttachmentData.ValidateAttachments());
        Assert.Empty(CampaignCatalog.ValidateAllMissions());
        foreach (var map in Maps.All)
            Assert.Empty(Maps.ValidateStructure(map));
    }

    [Fact]
    public void CanonicalCountsAndDefaultsArePresent()
    {
        Assert.Equal(36, WeaponData.All.Count);
        Assert.Equal(56, AttachmentData.All.Count);
        Assert.Equal(27, PerkData.All.Count);
        Assert.Equal(23, EquipmentData.All.Count);
        Assert.Equal(16, KillstreakData.All.Count);
        Assert.Equal(10, ModeData.All.Count);
        Assert.Equal(6, Maps.All.Count);
        Assert.Equal(6, CampaignCatalog.CampaignMissions.Count);
        Assert.Equal("vk47", WeaponData.DefaultPrimary);
        Assert.Equal("p226", WeaponData.DefaultSecondary);
        Assert.Equal("tdm", ModeData.DefaultMode);
        Assert.Equal("crossfire", Maps.DefaultId);
        Assert.Equal(20, ModeData.GunGameLadder().Count);
    }

    private static void AssertIds(string propertyName, IEnumerable<string> actualIds)
    {
        var expected = ParityFixture.Content.GetProperty(propertyName).EnumerateObject()
            .Select(property => property.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var actual = actualIds.Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(expected, actual);
    }
}

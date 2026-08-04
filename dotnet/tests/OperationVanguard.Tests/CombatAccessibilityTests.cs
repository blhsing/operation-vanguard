using OperationVanguard.Core;

namespace OperationVanguard.Tests;

public sealed class CombatAccessibilityTests
{
    [Fact]
    public void HumanHitboxAssistTurnsANearMissIntoAHit()
    {
        var target = new PlayerState
        {
            Id = 2,
            Alive = true,
            Position = new Vec3(0d, 0d, 0d),
            Stance = Stance.Stand,
            PreviousStance = Stance.Stand,
            StanceProgress = 1d,
            Yaw = 0d,
        };
        var height = Movement.CurrentHeight(target);
        var origin = new Vec3(.09d, height * .845d, 5d);
        var direction = new Vec3(0d, 0d, -1d);

        var normal = Combat.RaycastPlayer(origin, direction, 10d, target, new HitboxHit());
        var assisted = Combat.RaycastPlayer(origin, direction, 10d, target, new HitboxHit(), 1.25d);

        Assert.False(normal.Hit);
        Assert.True(assisted.Hit);
        Assert.Equal(HitLocation.Neck, assisted.Location);
    }
}

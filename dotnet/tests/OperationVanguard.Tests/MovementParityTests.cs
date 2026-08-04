using OperationVanguard.Core;

namespace OperationVanguard.Tests;

public sealed class MovementParityTests
{
    private static readonly QueryFilter MovementFilter = new(CollisionLayer.Movement);

    [Fact]
    public void CollisionWorldReportsGroundVisibilityAndBoundedSweeps()
    {
        var world = ObstacleWorld();
        Assert.InRange(world.GroundHeightAt(0, 0, 10, 20), -0.01, 0.01);
        Assert.Equal(double.NegativeInfinity, world.GroundHeightAt(100, 100, 10, 20));
        Assert.False(world.IsVisible(new Vec3(0, 1.5, 0), new Vec3(10, 1.5, 0),
            new QueryFilter(CollisionLayer.Sight)));
        Assert.True(world.IsVisible(new Vec3(0, 1.5, 25), new Vec3(10, 1.5, 25),
            new QueryFilter(CollisionLayer.Sight)));

        foreach (var delta in new[]
                 {
                     new Vec3(20, 0, 0), new Vec3(-20, 0, 0), new Vec3(0, -50, 0),
                     new Vec3(.001, 0, 0),
                 })
        {
            var hit = world.SweepCapsule(new Vec3(0, 1, 0), GameConstants.StanceHeight.Stand,
                GameConstants.PlayerRadius, delta, MovementFilter, new SweepHit());
            Assert.InRange(hit.Fraction, 0, 1);
        }
    }

    [Fact]
    public void CapsuleSlidesPastACrateCorner()
    {
        var world = new BrushCollisionWorld(
        [
            Box(new Vec3(0, -.5, 0), new Vec3(60, 1, 60)),
            Box(new Vec3(-9.5, .5, 9.5), new Vec3(1, 1, 1), SurfaceType.Wood),
        ], Bounds(-30, -5, -30, 30, 20, 30));
        var offset = GameConstants.PlayerRadius / Math.Sqrt(2);
        var player = MakePlayer(-10 - offset, 0, 10 + offset);
        var start = player.Position.Z;

        Simulate(player, world, Input(forward: 1), 1.5);

        Assert.True(start - player.Position.Z > 3,
            "a capsule grazing a corner at full speed must get past it");
    }

    [Fact]
    public void CapsuleStepsOntoLowCylinder()
    {
        var world = new BrushCollisionWorld(
        [
            Box(new Vec3(0, -.5, 0), new Vec3(60, 1, 60)),
            Cylinder(new Vec3(0, .15, 0), 6, .3),
        ], Bounds(-30, -5, -30, 30, 20, 30));
        var player = MakePlayer(0, .2, 12);

        Simulate(player, world, Input(forward: 1), 2.5);

        Assert.True(player.Position.Y > .25);
        Assert.True(Math.Abs(player.Position.Z) < 6);
    }

    [Fact]
    public void GravityLandsAndKeepsPlayerOnFloor()
    {
        var world = FlatWorld();
        var dropped = MakePlayer(0, 6, 0);
        Simulate(dropped, world, Input(), 3);
        Assert.True(dropped.OnGround);
        Assert.InRange(dropped.Position.Y, -.1, .1);
        Assert.True(Math.Abs(dropped.Velocity.Y) < 3);

        var standing = MakePlayer(0, .05, 0, 2);
        Simulate(standing, world, Input(), 10);
        Assert.InRange(standing.Position.Y, -.05, .15);
    }

    [Fact]
    public void WalkingAccelerationFrictionAndDirectionalMultipliersMatchTuning()
    {
        var world = FlatWorld();
        var forward = MakePlayer();
        Simulate(forward, world, Input(), .5);
        Simulate(forward, world, Input(forward: 1), 1.5);
        var baseSpeed = Movement.HorizontalSpeed(forward);
        Assert.InRange(baseSpeed, GameConstants.Move.BaseSpeed * .85, GameConstants.Move.BaseSpeed * 1.15);

        Simulate(forward, world, Input(), .25);
        Assert.True(Movement.HorizontalSpeed(forward) < .6);

        var straight = MakePlayer(id: 2);
        Simulate(straight, world, Input(), .5);
        Simulate(straight, world, Input(forward: 1), 2);
        var diagonal = MakePlayer(id: 3);
        Simulate(diagonal, world, Input(), .5);
        Simulate(diagonal, world, Input(forward: 1, right: 1), 2);
        Assert.True(Movement.HorizontalSpeed(diagonal) <= Movement.HorizontalSpeed(straight) + .05);

        var sprinter = MakePlayer(id: 4);
        Simulate(sprinter, world, Input(), .5);
        Simulate(sprinter, world, Input(forward: 1, buttons: InputFlag.Sprint), 2);
        Assert.True(Movement.HorizontalSpeed(sprinter) > Movement.HorizontalSpeed(straight) * 1.25);

        var backward = MakePlayer(id: 5);
        Simulate(backward, world, Input(), .5);
        Simulate(backward, world, Input(forward: -1), 2);
        Assert.True(Movement.HorizontalSpeed(backward) < Movement.HorizontalSpeed(straight) * .95);
    }

    [Fact]
    public void WallsStopHeadOnMotionButPreserveTangentialMotion()
    {
        var world = ObstacleWorld();
        var headOn = MakePlayer();
        Simulate(headOn, world, Input(), .5);
        Simulate(headOn, world, Input(forward: 1, yaw: -Math.PI / 2, buttons: InputFlag.Sprint), 4);
        Assert.True(headOn.Position.X < 5 - GameConstants.PlayerRadius + .1);

        var glancing = MakePlayer(4, .05, -8, 2);
        Simulate(glancing, world, Input(), .5);
        var startZ = glancing.Position.Z;
        Simulate(glancing, world,
            Input(forward: 1, right: .6, yaw: Math.PI, buttons: InputFlag.Sprint), 2);
        Assert.True(Math.Abs(glancing.Position.Z - startZ) > 3);
    }

    [Fact]
    public void ShortStepsAndRampsAreWalkableButTallObstaclesBlock()
    {
        var world = ObstacleWorld();
        var stepper = MakePlayer(0, .05, -25);
        Simulate(stepper, world, Input(), .5);
        Simulate(stepper, world, Input(forward: 1), 3);
        Assert.True(stepper.Position.Z < -31);
        Assert.True(stepper.Position.Y > .2);
        Assert.True(stepper.OnGround);

        var blocked = MakePlayer(0, .05, 25, 2);
        Simulate(blocked, world, Input(), .5);
        Simulate(blocked, world, Input(forward: 1, yaw: Math.PI, buttons: InputFlag.Sprint), 3);
        Assert.True(blocked.Position.Z < 29.5);
        Assert.True(blocked.Position.Y < .2);

        var climber = MakePlayer(10.5, 2.5, 8, 3);
        Simulate(climber, world, Input(), 1);
        var startY = climber.Position.Y;
        Simulate(climber, world, Input(forward: 1, yaw: -Math.PI / 2), 1.2);
        Assert.InRange(climber.Position.X, 11.5, 16);
        Assert.True(climber.Position.Y > startY + .5);
        Assert.True(climber.OnGround);
        Assert.InRange(climber.GroundNormal.Y, .5, .999);
    }

    [Fact]
    public void JumpLeavesGroundReturnsAndCannotDoubleJump()
    {
        var world = FlatWorld();
        var player = MakePlayer();
        Simulate(player, world, Input(), .5);
        Movement.StepMovement(player, Input(buttons: InputFlag.Jump), world, GameConstants.TickDt);
        Simulate(player, world, Input(buttons: InputFlag.Jump), .2);
        Assert.False(player.OnGround);
        Assert.True(player.Position.Y > .3);
        Simulate(player, world, Input(), 2);
        Assert.True(player.OnGround);
        Assert.InRange(player.Position.Y, -.1, .1);

        var second = MakePlayer(id: 2);
        Simulate(second, world, Input(), .5);
        Simulate(second, world, Input(buttons: InputFlag.Jump), .3);
        var peak = second.Position.Y;
        Simulate(second, world, Input(buttons: InputFlag.Jump), .3);
        Assert.True(second.Position.Y < peak + GameConstants.Move.JumpVelocity * .3);
    }

    [Fact]
    public void CrouchChangesHeightAndSpeed()
    {
        var world = FlatWorld();
        var player = MakePlayer();
        Simulate(player, world, Input(), .5);
        var standing = Movement.CurrentHeight(player);
        Simulate(player, world, Input(buttons: InputFlag.Crouch), 1);
        Assert.Equal(Stance.Crouch, player.Stance);
        Assert.True(Movement.CurrentHeight(player) < standing);
        Assert.InRange(Movement.CurrentHeight(player), GameConstants.StanceHeight.Crouch - .01,
            GameConstants.StanceHeight.Crouch + .01);

        var upright = MakePlayer(id: 2);
        Simulate(upright, world, Input(), .5);
        Simulate(upright, world, Input(forward: 1), 2);
        var crouched = MakePlayer(id: 3);
        Simulate(crouched, world, Input(), .5);
        Simulate(crouched, world, Input(forward: 1, buttons: InputFlag.Crouch), 2);
        Assert.True(Movement.HorizontalSpeed(crouched) < Movement.HorizontalSpeed(upright) * .75);
    }

    [Fact]
    public void SprintToCrouchSlidesThenTerminates()
    {
        var world = FlatWorld();
        var player = MakePlayer();
        Simulate(player, world, Input(), .5);
        Simulate(player, world, Input(forward: 1, buttons: InputFlag.Sprint), 1.5);
        var sprintSpeed = Movement.HorizontalSpeed(player);
        Movement.StepMovement(player,
            Input(forward: 1, buttons: InputFlag.Sprint | InputFlag.Crouch), world,
            GameConstants.TickDt);
        Assert.Equal(MoveState.Slide, player.MoveState);
        Assert.True(Movement.HorizontalSpeed(player) > sprintSpeed);

        Simulate(player, world, Input(forward: 1, buttons: InputFlag.Sprint | InputFlag.Crouch), 2.5);
        Assert.NotEqual(MoveState.Slide, player.MoveState);
    }

    [Fact]
    public void ReleasingSprintOrPressingFireRestoresWeaponReadyMovementState()
    {
        var world = FlatWorld();

        var released = MakePlayer();
        Simulate(released, world, Input(), .5);
        Simulate(released, world, Input(forward: 1, buttons: InputFlag.Sprint), .5);
        Assert.Equal(MoveState.Sprint, released.MoveState);

        Movement.StepMovement(released, Input(forward: 1), world, GameConstants.TickDt);
        Assert.NotEqual(MoveState.Sprint, released.MoveState);
        Assert.NotEqual(MoveState.TacticalSprint, released.MoveState);
        Assert.True(released.SprintOutPending);

        var firing = MakePlayer(id: 2);
        Simulate(firing, world, Input(), .5);
        Simulate(firing, world, Input(forward: 1, buttons: InputFlag.Sprint), .5);
        Assert.Equal(MoveState.Sprint, firing.MoveState);

        Movement.StepMovement(firing,
            Input(forward: 1, buttons: InputFlag.Sprint | InputFlag.Fire),
            world,
            GameConstants.TickDt);
        Assert.NotEqual(MoveState.Sprint, firing.MoveState);
        Assert.NotEqual(MoveState.TacticalSprint, firing.MoveState);
        Assert.True(firing.SprintOutPending);
    }

    [Fact]
    public void HostileInputNeverProducesNonFinitePosition()
    {
        var world = FlatWorld();
        var player = MakePlayer(y: 2);
        for (var index = 0; index < 600; index++)
        {
            Movement.StepMovement(player, new InputCommand
            {
                Dt = GameConstants.TickDt,
                MoveForward = index % 3 == 0 ? 1e6 : -1,
                MoveRight = index % 2 == 0 ? -1e6 : 1,
                Yaw = index * 7.3,
                Pitch = index * 3.1,
                Buttons = 0xffff,
            }, world, GameConstants.TickDt);
            Assert.True(double.IsFinite(player.Position.X));
            Assert.True(double.IsFinite(player.Position.Y));
            Assert.True(double.IsFinite(player.Position.Z));
        }
    }

    [Fact]
    public void IdenticalInputsProduceBitIdenticalPositions()
    {
        Vec3 RunOnce(int id)
        {
            var world = FlatWorld();
            var player = MakePlayer(0, 2, 0, id);
            for (var index = 0; index < 300; index++)
            {
                Movement.StepMovement(player, new InputCommand
                {
                    Dt = GameConstants.TickDt,
                    MoveForward = Math.Sin(index * .11),
                    MoveRight = Math.Cos(index * .07),
                    Yaw = index * .03,
                    Buttons = (int)(index % 40 == 0 ? InputFlag.Jump : InputFlag.Sprint),
                }, world, GameConstants.TickDt);
            }
            return MathEx.Clone(player.Position);
        }

        var first = RunOnce(4001);
        var second = RunOnce(4001);
        Assert.Equal(first.X, second.X);
        Assert.Equal(first.Y, second.Y);
        Assert.Equal(first.Z, second.Z);
    }

    private static BrushCollisionWorld FlatWorld() => new(
        [Box(new Vec3(0, -.5, 0), new Vec3(200, 1, 200))],
        Bounds(-100, -5, -100, 100, 20, 100));

    private static BrushCollisionWorld ObstacleWorld() => new(
    [
        Box(new Vec3(0, -.5, 0), new Vec3(120, 1, 120)),
        Box(new Vec3(5, 2, 0), new Vec3(.5, 4, 40)),
        Box(new Vec3(0, .15, -40), new Vec3(20, .3, 20)),
        Box(new Vec3(0, .6, 30), new Vec3(20, 1.2, 1), SurfaceType.Wood),
        Ramp(new Vec3(13, 1, 8), new Vec3(6, 2, 6), RiseDirection.PositiveX),
    ], Bounds(-60, -5, -60, 60, 20, 60));

    private static PlayerState MakePlayer(
        double x = 0,
        double y = .05,
        double z = 0,
        int id = 1)
    {
        var player = WorldFactory.CreatePlayer(new CreatePlayerOptions
        {
            Id = id,
            Name = "Test",
            Team = Team.Allies,
            Position = new Vec3(x, y, z),
        });
        WorldFactory.RespawnPlayer(player, new Vec3(x, y, z), 0);
        Movement.ResetStride(id);
        return player;
    }

    private static InputCommand Input(
        double forward = 0,
        double right = 0,
        double yaw = 0,
        InputFlag buttons = InputFlag.None) => new()
        {
            Dt = GameConstants.TickDt,
            MoveForward = forward,
            MoveRight = right,
            Yaw = yaw,
            Buttons = (int)buttons,
        };

    private static void Simulate(
        PlayerState player,
        BrushCollisionWorld world,
        InputCommand input,
        double seconds)
    {
        var ticks = (int)Math.Round(seconds / GameConstants.TickDt);
        for (var index = 0; index < ticks; index++)
            Movement.StepMovement(player, input, world, GameConstants.TickDt);
    }

    private static Brush Box(Vec3 position, Vec3 size, SurfaceType surface = SurfaceType.Concrete) => new()
    {
        Kind = BrushKind.Box,
        Position = position,
        Size = size,
        Surface = surface,
    };

    private static Brush Cylinder(Vec3 position, double radius, double height) => new()
    {
        Kind = BrushKind.Cylinder,
        Position = position,
        Radius = radius,
        Height = height,
        Segments = 24,
        Surface = SurfaceType.Concrete,
    };

    private static Brush Ramp(Vec3 position, Vec3 size, RiseDirection rise) => new()
    {
        Kind = BrushKind.Ramp,
        Position = position,
        Size = size,
        Rise = rise,
        Surface = SurfaceType.Concrete,
    };

    private static MapBounds Bounds(double minX, double minY, double minZ, double maxX, double maxY,
        double maxZ) => new()
        {
            Min = new Vec3(minX, minY, minZ),
            Max = new Vec3(maxX, maxY, maxZ),
        };
}

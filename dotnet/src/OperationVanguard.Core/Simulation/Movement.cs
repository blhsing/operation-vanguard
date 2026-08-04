namespace OperationVanguard.Core;

/// <summary>Per-tick modifiers folded in from perks, weapon weight, and status effects.</summary>
public sealed class MovementModifiers
{
    public double SpeedMultiplier { get; set; } = 1d;
    public double AdsSpeedMultiplier { get; set; } = 1d;
    public double AdsProgress { get; set; }
    public bool SprintBlocked { get; set; }
    public bool SlideBlocked { get; set; }
    public double SlowMultiplier { get; set; } = 1d;
    public bool FallDamageImmune { get; set; }
}

/// <summary>Notable movement outcomes produced by one simulation tick.</summary>
public sealed class MovementResult
{
    public bool Jumped { get; set; }
    public bool Landed { get; set; }
    public double FallDamage { get; set; }
    public bool StartedSlide { get; set; }
    public bool StartedMantle { get; set; }
    public double DistanceMoved { get; set; }
    public bool Footstep { get; set; }
    public bool FootstepLoud { get; set; }
}

/// <summary>Deterministic stateless character movement controller.</summary>
public static class Movement
{
    private static readonly Vec3 WishDirection = new();
    private static readonly Vec3 Forward = new();
    private static readonly Vec3 Right = new();
    private static readonly Vec3 Delta = new();
    private static readonly Vec3 Remaining = new();
    private static readonly Vec3 PlaneNormal = new();
    private static readonly Vec3 ProbeStart = new();
    private static readonly Vec3 ProbeDelta = new();
    private static readonly Vec3 Temporary = new();
    private static readonly SweepHit Sweep = new();
    private static readonly SweepHit Sweep2 = new();
    private static readonly SweepHit StepUpSweep = new();

    private static readonly QueryFilter MovementFilter = new() { Layers = CollisionLayer.Movement };
    private static readonly MovementResult SharedResult = new();
    private static readonly Dictionary<int, double> StrideAccumulator = [];

    private const double WalkStride = 2.05d;
    private const double SprintStride = 2.45d;
    private const double CrouchStride = 2.4d;
    private const double ProneStride = 3.2d;

    public static MovementModifiers DefaultModifiers { get; } = new();

    public static void ResetStride(int playerId) => StrideAccumulator.Remove(playerId);

    public static double CurrentHeight(PlayerState player)
    {
        var target = StanceHeight(player.Stance);
        if (player.StanceProgress >= 1d)
        {
            return target;
        }

        var from = StanceHeight(player.PreviousStance);
        return MathEx.Lerp(from, target, player.StanceProgress);
    }

    public static double CurrentEyeHeight(PlayerState player)
    {
        var target = EyeHeight(player.Stance);
        if (player.StanceProgress >= 1d)
        {
            return target;
        }

        var from = EyeHeight(player.PreviousStance);
        return MathEx.Lerp(from, target, player.StanceProgress);
    }

    public static Vec3 EyePosition(Vec3 result, PlayerState player)
    {
        result.X = player.Position.X;
        result.Y = player.Position.Y + CurrentEyeHeight(player);
        result.Z = player.Position.Z;

        if (player.Lean != 0d)
        {
            MathEx.AnglesToRight(Temporary, player.Yaw);
            result.X += Temporary.X * player.Lean * GameConstants.Lean.MaximumOffset;
            result.Z += Temporary.Z * player.Lean * GameConstants.Lean.MaximumOffset;
        }

        return result;
    }

    public static double StanceHeight(Stance stance) => stance switch
    {
        Stance.Crouch => GameConstants.StanceHeight.Crouch,
        Stance.Prone => GameConstants.StanceHeight.Prone,
        _ => GameConstants.StanceHeight.Stand,
    };

    public static double EyeHeight(Stance stance) => stance switch
    {
        Stance.Crouch => GameConstants.EyeHeight.Crouch,
        Stance.Prone => GameConstants.EyeHeight.Prone,
        _ => GameConstants.EyeHeight.Stand,
    };

    /// <summary>
    /// Advance one player by one tick. The returned object is shared and must be consumed
    /// before the next call, matching the allocation-free TypeScript implementation.
    /// </summary>
    public static MovementResult StepMovement(
        PlayerState player,
        InputCommand input,
        ICollisionWorld world,
        double deltaTime,
        MovementModifiers? modifiers = null)
    {
        var mods = modifiers ?? DefaultModifiers;
        SharedResult.Jumped = false;
        SharedResult.Landed = false;
        SharedResult.FallDamage = 0d;
        SharedResult.StartedSlide = false;
        SharedResult.StartedMantle = false;
        SharedResult.DistanceMoved = 0d;
        SharedResult.Footstep = false;
        SharedResult.FootstepLoud = false;

        if (!player.Alive)
        {
            ApplyGravityOnly(player, world, deltaTime);
            return SharedResult;
        }

        ApplyViewAngles(player, input);

        if (player.MantleTime > 0d)
        {
            StepMantle(player, deltaTime);
            return SharedResult;
        }

        TickTimers(player, deltaTime);
        UpdateStance(player, input, world, deltaTime);
        UpdateLean(player, input, deltaTime);

        var wasOnGround = player.OnGround;
        BuildWishDirection(player, input, WishDirection);
        var stoppedSprinting = UpdateSprint(player, input, mods);
        UpdateSlide(player, input, world, deltaTime, mods);
        if (stoppedSprinting && player.MoveState is MoveState.Sprint or MoveState.TacticalSprint)
        {
            player.MoveState = player.OnGround ? MoveState.Walk : MoveState.Air;
        }

        if (player.MoveState == MoveState.Slide)
        {
            ApplySlideFriction(player, deltaTime);
        }
        else if (player.OnGround)
        {
            ApplyGroundMovement(player, input, deltaTime, mods);
        }
        else
        {
            ApplyAirMovement(player, deltaTime);
        }

        if (TryJump(player, input, world, deltaTime))
        {
            SharedResult.Jumped = true;
        }

        ApplyGravity(player, deltaTime);

        var startY = player.Position.Y;
        var preMoveX = player.Position.X;
        var preMoveZ = player.Position.Z;
        MoveWithCollision(player, world, MovementFilter, deltaTime);

        var wasAirborne = !wasOnGround;
        UpdateGrounded(player, world, MovementFilter, deltaTime);

        if (wasAirborne && player.OnGround)
        {
            SharedResult.Landed = true;
            var fallDistance = player.FallPeakY - player.Position.Y;
            if (!mods.FallDamageImmune && fallDistance > GameConstants.Move.SafeFallHeight)
            {
                var amount = MathEx.Clamp01(
                    (fallDistance - GameConstants.Move.SafeFallHeight) /
                    (GameConstants.Move.LethalFallHeight - GameConstants.Move.SafeFallHeight));
                SharedResult.FallDamage = amount * GameConstants.Move.MaximumFallDamage;
            }

            player.FallPeakY = player.Position.Y;
        }

        if (!player.OnGround)
        {
            player.FallPeakY = Math.Max(player.FallPeakY, player.Position.Y);
        }
        else
        {
            player.FallPeakY = player.Position.Y;
        }

        if (TryMantle(player, input, world, MovementFilter))
        {
            SharedResult.StartedMantle = true;
        }

        var dx = player.Position.X - preMoveX;
        var dz = player.Position.Z - preMoveZ;
        var absoluteY = Math.Abs(player.Position.Y - startY);
        SharedResult.DistanceMoved = Math.Sqrt(dx * dx + dz * dz + absoluteY * absoluteY * 0.25d);

        UpdateMoveState(player);
        UpdateFootsteps(player, SharedResult);
        return SharedResult;
    }

    private static void ApplyViewAngles(PlayerState player, InputCommand input)
    {
        player.Yaw = input.Yaw;
        player.Pitch = MathEx.Clamp(input.Pitch, -Math.PI / 2d + 0.01d, Math.PI / 2d - 0.01d);
    }

    private static void TickTimers(PlayerState player, double deltaTime)
    {
        player.SlideCooldown = Math.Max(0d, player.SlideCooldown - deltaTime);
        player.JumpCooldown = Math.Max(0d, player.JumpCooldown - deltaTime);
        player.GroundLockout = Math.Max(0d, player.GroundLockout - deltaTime);
        player.TacticalSprintCooldown = Math.Max(0d, player.TacticalSprintCooldown - deltaTime);

        if (player.OnGround)
        {
            player.AirTime = 0d;
        }
        else
        {
            player.AirTime += deltaTime;
        }
    }

    private static void UpdateStance(
        PlayerState player,
        InputCommand input,
        ICollisionWorld world,
        double deltaTime)
    {
        var wantsProne = SimulationTypes.HasFlag(input.Buttons, InputFlag.Prone);
        var wantsCrouch = SimulationTypes.HasFlag(input.Buttons, InputFlag.Crouch);

        var desired = wantsProne
            ? Stance.Prone
            : wantsCrouch
                ? Stance.Crouch
                : Stance.Stand;

        if (player.MoveState == MoveState.Slide)
        {
            desired = Stance.Crouch;
        }

        if (desired != player.Stance && IsTallerStance(desired, player.Stance) &&
            !HasHeadroom(player, desired, world))
        {
            desired = player.Stance;
        }

        if (desired != player.Stance)
        {
            player.PreviousStance = player.Stance;
            player.Stance = desired;
            player.StanceProgress = 0d;
        }

        var duration = StanceTransitionTime(player.PreviousStance, player.Stance);
        player.StanceProgress = duration <= 0d
            ? 1d
            : MathEx.Clamp01(player.StanceProgress + deltaTime / duration);
    }

    private static bool IsTallerStance(Stance a, Stance b) => StanceHeight(a) > StanceHeight(b);

    private static bool HasHeadroom(PlayerState player, Stance target, ICollisionWorld world)
    {
        var targetHeight = StanceHeight(target);
        var currentHeight = CurrentHeight(player);
        var growth = targetHeight - currentHeight;
        if (growth <= 0d)
        {
            return true;
        }

        MathEx.Copy(ProbeStart, player.Position);
        MathEx.Set(ProbeDelta, 0d, growth + 0.02d, 0d);
        world.SweepCapsule(
            ProbeStart,
            currentHeight,
            GameConstants.PlayerRadius,
            ProbeDelta,
            MovementFilter,
            Sweep2);
        return !Sweep2.Hit || Sweep2.Fraction >= 0.99d;
    }

    private static double StanceTransitionTime(Stance from, Stance to)
    {
        if (from == to) return 0d;
        if (from == Stance.Stand && to == Stance.Crouch)
            return GameConstants.StanceTransition.StandToCrouch;
        if (from == Stance.Crouch && to == Stance.Stand)
            return GameConstants.StanceTransition.CrouchToStand;
        if (from == Stance.Crouch && to == Stance.Prone)
            return GameConstants.StanceTransition.CrouchToProne;
        if (from == Stance.Prone && to == Stance.Crouch)
            return GameConstants.StanceTransition.ProneToCrouch;
        if (from == Stance.Stand && to == Stance.Prone)
            return GameConstants.StanceTransition.StandToProne;
        return GameConstants.StanceTransition.ProneToStand;
    }

    private static void UpdateLean(PlayerState player, InputCommand input, double deltaTime)
    {
        var target = 0d;
        if (SimulationTypes.HasFlag(input.Buttons, InputFlag.LeanLeft)) target -= 1d;
        if (SimulationTypes.HasFlag(input.Buttons, InputFlag.LeanRight)) target += 1d;

        if (player.MoveState is MoveState.Sprint or MoveState.TacticalSprint)
        {
            target = 0d;
        }

        player.Lean = MathEx.MoveTowards(
            player.Lean,
            target,
            GameConstants.Lean.Speed * deltaTime);
    }

    private static Vec3 BuildWishDirection(PlayerState player, InputCommand input, Vec3 result)
    {
        MathEx.AnglesToForwardFlat(Forward, player.Yaw);
        MathEx.AnglesToRight(Right, player.Yaw);
        var forward = MathEx.Clamp(input.MoveForward, -1d, 1d);
        var right = MathEx.Clamp(input.MoveRight, -1d, 1d);

        result.X = Forward.X * forward + Right.X * right;
        result.Y = 0d;
        result.Z = Forward.Z * forward + Right.Z * right;

        var lengthSquared = MathEx.LengthSquared(result);
        if (lengthSquared > 1d)
        {
            var inverse = 1d / Math.Sqrt(lengthSquared);
            result.X *= inverse;
            result.Z *= inverse;
        }

        return result;
    }

    private static double ComputeMaximumSpeed(
        PlayerState player,
        InputCommand input,
        MovementModifiers modifiers)
    {
        var speed = GameConstants.Move.BaseSpeed *
                    modifiers.SpeedMultiplier *
                    modifiers.SlowMultiplier;

        switch (player.Stance)
        {
            case Stance.Crouch:
                speed *= GameConstants.Move.CrouchMultiplier;
                break;
            case Stance.Prone:
                speed *= GameConstants.Move.ProneMultiplier;
                break;
        }

        if (player.MoveState == MoveState.TacticalSprint)
        {
            speed *= GameConstants.Move.TacticalSprintMultiplier;
        }
        else if (player.MoveState == MoveState.Sprint)
        {
            speed *= GameConstants.Move.SprintMultiplier;
        }
        else
        {
            var forward = input.MoveForward;
            var right = input.MoveRight;
            if (forward < -0.1d && Math.Abs(forward) >= Math.Abs(right))
            {
                speed *= GameConstants.Move.BackMultiplier;
            }
            else if (Math.Abs(right) > Math.Abs(forward))
            {
                speed *= GameConstants.Move.StrafeMultiplier;
            }
        }

        if (modifiers.AdsProgress > 0d)
        {
            var adsFactor = MathEx.Lerp(
                1d,
                GameConstants.Move.AdsMultiplier * modifiers.AdsSpeedMultiplier,
                modifiers.AdsProgress);
            speed *= adsFactor;
        }

        return speed;
    }

    private static bool UpdateSprint(PlayerState player, InputCommand input, MovementModifiers modifiers)
    {
        var wantsSprint = SimulationTypes.HasFlag(input.Buttons, InputFlag.Sprint);
        var wantsTacticalSprint = SimulationTypes.HasFlag(input.Buttons, InputFlag.TacticalSprint);
        var wantsFire = SimulationTypes.HasFlag(input.Buttons, InputFlag.Fire);
        var movingForward = input.MoveForward > 0.35d;
        var canSprint =
            wantsSprint &&
            movingForward &&
            !wantsFire &&
            !modifiers.SprintBlocked &&
            player.Stance == Stance.Stand &&
            modifiers.AdsProgress < 0.2d &&
            player.MoveState != MoveState.Slide;

        if (!canSprint)
        {
            var stoppedSprinting = player.MoveState is MoveState.Sprint or MoveState.TacticalSprint;
            if (stoppedSprinting)
            {
                player.SprintOutPending = true;
            }

            player.TacticalSprintTime = 0d;
            return stoppedSprinting;
        }

        if (wantsTacticalSprint &&
            player.TacticalSprintCooldown <= 0d &&
            player.TacticalSprintTime < GameConstants.Move.TacticalSprintDuration)
        {
            player.MoveState = MoveState.TacticalSprint;
        }
        else
        {
            player.MoveState = MoveState.Sprint;
            if (player.TacticalSprintTime > 0d)
            {
                player.TacticalSprintCooldown = GameConstants.Move.TacticalSprintCooldown;
                player.TacticalSprintTime = 0d;
            }
        }

        return false;
    }

    private static void UpdateSlide(
        PlayerState player,
        InputCommand input,
        ICollisionWorld world,
        double deltaTime,
        MovementModifiers modifiers)
    {
        _ = world;
        if (player.MoveState == MoveState.Slide)
        {
            player.SlideTime += deltaTime;
            var speed = Math.Sqrt(
                player.Velocity.X * player.Velocity.X + player.Velocity.Z * player.Velocity.Z);
            var releasedCrouch = !SimulationTypes.HasFlag(input.Buttons, InputFlag.Crouch);
            if (player.SlideTime >= GameConstants.Slide.Duration ||
                speed < GameConstants.Move.BaseSpeed * 0.55d ||
                releasedCrouch)
            {
                EndSlide(player);
            }

            return;
        }

        if (modifiers.SlideBlocked || player.SlideCooldown > 0d || !player.OnGround) return;
        if (!SimulationTypes.HasFlag(input.Buttons, InputFlag.Crouch)) return;

        var wasSprinting = player.MoveState is MoveState.Sprint or MoveState.TacticalSprint;
        if (!wasSprinting) return;

        var horizontalSpeed = Math.Sqrt(
            player.Velocity.X * player.Velocity.X + player.Velocity.Z * player.Velocity.Z);
        if (horizontalSpeed < GameConstants.Slide.MinimumSpeed) return;

        MathEx.Set(Temporary, player.Velocity.X, 0d, player.Velocity.Z);
        MathEx.Normalize(Temporary, Temporary);
        player.Velocity.X = Temporary.X * GameConstants.Slide.BoostSpeed;
        player.Velocity.Z = Temporary.Z * GameConstants.Slide.BoostSpeed;

        player.MoveState = MoveState.Slide;
        player.SlideTime = 0d;
        player.PreviousStance = player.Stance;
        player.Stance = Stance.Crouch;
        player.StanceProgress = 0d;
        SharedResult.StartedSlide = true;
    }

    private static void EndSlide(PlayerState player)
    {
        player.MoveState = MoveState.Walk;
        player.SlideTime = 0d;
        player.SlideCooldown = GameConstants.Slide.Cooldown;
    }

    private static void ApplySlideFriction(PlayerState player, double deltaTime)
    {
        var speed = Math.Sqrt(
            player.Velocity.X * player.Velocity.X + player.Velocity.Z * player.Velocity.Z);
        if (speed <= 0d) return;

        var slopeBoost = -player.GroundNormal.Y < -0.999d ? 0d : player.GroundNormal.Y;
        var downhill = MathEx.Dot(player.Velocity, player.GroundNormal) < 0d
            ? GameConstants.Slide.SlopeAcceleration
            : 0d;
        _ = slopeBoost;

        var drop = Math.Max(
            0d,
            GameConstants.Slide.Friction * deltaTime - downhill * deltaTime);
        var newSpeed = Math.Max(0d, speed - drop);
        var scale = newSpeed / speed;
        player.Velocity.X *= scale;
        player.Velocity.Z *= scale;
    }

    private static void ApplyGroundMovement(
        PlayerState player,
        InputCommand input,
        double deltaTime,
        MovementModifiers modifiers)
    {
        var maximumSpeed = ComputeMaximumSpeed(player, input, modifiers);
        var wishSpeed = MathEx.Length(WishDirection) * maximumSpeed;
        var speed = Math.Sqrt(
            player.Velocity.X * player.Velocity.X + player.Velocity.Z * player.Velocity.Z);

        if (speed > 0d)
        {
            var control = Math.Max(speed, GameConstants.Move.BaseSpeed * 0.25d);
            var drop = control * GameConstants.Move.GroundFriction * deltaTime *
                       (wishSpeed > 0.01d ? 0.35d : 1d);
            var newSpeed = Math.Max(0d, speed - drop);
            var scale = newSpeed / speed;
            player.Velocity.X *= scale;
            player.Velocity.Z *= scale;
        }

        if (wishSpeed < 0.01d) return;

        var currentSpeedAlongWish =
            player.Velocity.X * WishDirection.X + player.Velocity.Z * WishDirection.Z;
        var addSpeed = wishSpeed - currentSpeedAlongWish;
        if (addSpeed <= 0d) return;

        var acceleration = GameConstants.Move.GroundAcceleration * wishSpeed * deltaTime;
        if (acceleration > addSpeed) acceleration = addSpeed;

        player.Velocity.X += WishDirection.X * acceleration;
        player.Velocity.Z += WishDirection.Z * acceleration;
    }

    private static void ApplyAirMovement(PlayerState player, double deltaTime)
    {
        if (MathEx.LengthSquared(WishDirection) < 0.0001d) return;

        var currentAlongWish =
            player.Velocity.X * WishDirection.X + player.Velocity.Z * WishDirection.Z;
        var addSpeed = GameConstants.Move.MaximumAirSpeedGain - currentAlongWish;
        if (addSpeed <= 0d) return;

        var acceleration = GameConstants.Move.AirAcceleration * deltaTime;
        if (acceleration > addSpeed) acceleration = addSpeed;
        player.Velocity.X += WishDirection.X * acceleration;
        player.Velocity.Z += WishDirection.Z * acceleration;
    }

    private static bool TryJump(
        PlayerState player,
        InputCommand input,
        ICollisionWorld world,
        double deltaTime)
    {
        var pressed = SimulationTypes.HasFlag(input.Buttons, InputFlag.Jump);
        if (pressed)
        {
            player.JumpBuffer = GameConstants.Move.JumpBufferTime;
        }
        else
        {
            player.JumpBuffer = Math.Max(0d, player.JumpBuffer - deltaTime);
        }

        if (player.JumpBuffer <= 0d || player.JumpCooldown > 0d) return false;
        var grounded = player.OnGround || player.AirTime <= GameConstants.Move.CoyoteTime;
        if (!grounded) return false;

        if (player.Stance != Stance.Stand)
        {
            if (HasHeadroom(player, Stance.Stand, world))
            {
                player.PreviousStance = player.Stance;
                player.Stance = Stance.Stand;
                player.StanceProgress = 0d;
            }

            return false;
        }

        if (player.MoveState == MoveState.Slide)
        {
            EndSlide(player);
        }

        player.Velocity.Y = GameConstants.Move.JumpVelocity;
        player.OnGround = false;
        player.JumpCooldown = GameConstants.Move.JumpCooldown;
        player.JumpBuffer = 0d;
        player.GroundLockout = 0.14d;
        player.AirTime = GameConstants.Move.CoyoteTime + 0.001d;
        player.FallPeakY = player.Position.Y;
        return true;
    }

    private static void ApplyGravity(PlayerState player, double deltaTime)
    {
        if (player.OnGround && player.Velocity.Y <= 0d)
        {
            player.Velocity.Y = -2d;
            return;
        }

        player.Velocity.Y -= GameConstants.Move.Gravity * deltaTime;
        if (player.Velocity.Y < -GameConstants.Move.MaximumFallSpeed)
        {
            player.Velocity.Y = -GameConstants.Move.MaximumFallSpeed;
        }
    }

    private static void ApplyGravityOnly(PlayerState player, ICollisionWorld world, double deltaTime)
    {
        player.Velocity.Y -= GameConstants.Move.Gravity * deltaTime;
        if (player.Velocity.Y < -GameConstants.Move.MaximumFallSpeed)
        {
            player.Velocity.Y = -GameConstants.Move.MaximumFallSpeed;
        }

        MathEx.Scale(Delta, player.Velocity, deltaTime);
        var height = CurrentHeight(player);
        world.SweepCapsule(
            player.Position,
            height,
            GameConstants.PlayerRadius,
            Delta,
            MovementFilter,
            Sweep);
        MathEx.AddScaled(player.Position, player.Position, Delta, Sweep.Fraction);
        if (Sweep.Hit && Sweep.Normal.Y > 0.5d)
        {
            player.Velocity.Y = 0d;
            player.OnGround = true;
        }
    }

    private static void MoveWithCollision(
        PlayerState player,
        ICollisionWorld world,
        QueryFilter filter,
        double deltaTime)
    {
        var height = CurrentHeight(player);
        MathEx.Scale(Remaining, player.Velocity, deltaTime);

        for (var iteration = 0; iteration < 4; iteration++)
        {
            if (MathEx.LengthSquared(Remaining) < 1e-8d) break;

            world.SweepCapsule(
                player.Position,
                height,
                GameConstants.PlayerRadius,
                Remaining,
                filter,
                Sweep);

            if (Sweep.StartedSolid)
            {
                if (world.ResolvePenetration(
                        player.Position,
                        height,
                        GameConstants.PlayerRadius,
                        filter,
                        Temporary))
                {
                    MathEx.Copy(player.Position, Temporary);
                }

                break;
            }

            MathEx.AddScaled(player.Position, player.Position, Remaining, Sweep.Fraction);
            if (!Sweep.Hit) break;

            if (player.OnGround &&
                Sweep.Normal.Y < 0.2d &&
                TryStepUp(player, world, filter, height, Remaining, Sweep.Fraction))
            {
                continue;
            }

            MathEx.Copy(PlaneNormal, Sweep.Normal);
            MathEx.Scale(Remaining, Remaining, 1d - Sweep.Fraction);
            MathEx.ProjectOnPlane(Remaining, Remaining, PlaneNormal);
            MathEx.ProjectOnPlane(player.Velocity, player.Velocity, PlaneNormal);
        }

        if (!double.IsFinite(player.Position.X + player.Position.Y + player.Position.Z))
        {
            MathEx.Set(player.Position, 0d, 0d, 0d);
            MathEx.Set(player.Velocity, 0d, 0d, 0d);
        }
    }

    private static bool TryStepUp(
        PlayerState player,
        ICollisionWorld world,
        QueryFilter filter,
        double height,
        Vec3 remaining,
        double usedFraction)
    {
        var leftover = 1d - usedFraction;
        if (leftover < 0.01d) return false;

        MathEx.Copy(ProbeStart, player.Position);
        MathEx.Set(ProbeDelta, 0d, GameConstants.Move.StepHeight, 0d);
        world.SweepCapsule(
            ProbeStart,
            height,
            GameConstants.PlayerRadius,
            ProbeDelta,
            filter,
            StepUpSweep);
        var lift = GameConstants.Move.StepHeight * StepUpSweep.Fraction;
        if (lift < 0.02d) return false;
        ProbeStart.Y += lift;

        MathEx.Scale(ProbeDelta, remaining, leftover);
        ProbeDelta.Y = 0d;
        world.SweepCapsule(
            ProbeStart,
            height,
            GameConstants.PlayerRadius,
            ProbeDelta,
            filter,
            StepUpSweep);
        if (StepUpSweep.Fraction < 0.15d) return false;
        MathEx.AddScaled(ProbeStart, ProbeStart, ProbeDelta, StepUpSweep.Fraction);

        MathEx.Set(ProbeDelta, 0d, -(lift + 0.02d), 0d);
        world.SweepCapsule(
            ProbeStart,
            height,
            GameConstants.PlayerRadius,
            ProbeDelta,
            filter,
            StepUpSweep);
        if (!StepUpSweep.Hit) return false;
        MathEx.AddScaled(ProbeStart, ProbeStart, ProbeDelta, StepUpSweep.Fraction);

        if (StepUpSweep.Normal.Y < Math.Cos(GameConstants.Move.MaximumSlopeAngle)) return false;
        MathEx.Copy(player.Position, ProbeStart);
        MathEx.Scale(remaining, remaining, 0d);
        return true;
    }

    private static void UpdateGrounded(
        PlayerState player,
        ICollisionWorld world,
        QueryFilter filter,
        double deltaTime)
    {
        _ = deltaTime;
        var height = CurrentHeight(player);
        if (player.GroundLockout > 0d)
        {
            player.OnGround = false;
            MathEx.Set(player.GroundNormal, 0d, 1d, 0d);
            return;
        }

        var probe = GameConstants.Move.GroundSnapDistance;
        MathEx.Set(ProbeDelta, 0d, -probe, 0d);
        world.SweepCapsule(
            player.Position,
            height,
            GameConstants.PlayerRadius,
            ProbeDelta,
            filter,
            Sweep2);

        var walkable = Sweep2.Hit &&
                       Sweep2.Normal.Y >= Math.Cos(GameConstants.Move.MaximumSlopeAngle);
        if (walkable)
        {
            player.OnGround = true;
            MathEx.Copy(player.GroundNormal, Sweep2.Normal);
            if (Sweep2.Fraction > 0d && Sweep2.Fraction < 1d)
            {
                player.Position.Y -= probe * Sweep2.Fraction;
            }

            player.Velocity.Y = 0d;
        }
        else
        {
            player.OnGround = false;
            MathEx.Set(player.GroundNormal, 0d, 1d, 0d);
        }
    }

    private static bool TryMantle(
        PlayerState player,
        InputCommand input,
        ICollisionWorld world,
        QueryFilter filter)
    {
        if (player.MantleTime > 0d || player.Stance == Stance.Prone) return false;

        var wantsUp =
            SimulationTypes.HasFlag(input.Buttons, InputFlag.Jump) ||
            SimulationTypes.HasFlag(input.Buttons, InputFlag.Use);
        if (!wantsUp || input.MoveForward < 0.3d) return false;

        MathEx.AnglesToForwardFlat(Forward, player.Yaw);
        MathEx.Copy(ProbeStart, player.Position);
        ProbeStart.Y += GameConstants.Move.StepHeight + 0.1d;
        MathEx.Scale(ProbeDelta, Forward, GameConstants.Mantle.Reach);
        world.SweepCapsule(
            ProbeStart,
            0.4d,
            GameConstants.PlayerRadius * 0.9d,
            ProbeDelta,
            filter,
            Sweep2);
        if (!Sweep2.Hit || Sweep2.Fraction > 0.85d) return false;

        MathEx.AddScaled(
            ProbeStart,
            ProbeStart,
            Forward,
            GameConstants.Mantle.Reach * 0.95d);
        ProbeStart.Y = player.Position.Y + GameConstants.Mantle.MaximumHeight + 0.4d;
        var ledgeY = world.GroundHeightAt(
            ProbeStart.X,
            ProbeStart.Z,
            ProbeStart.Y,
            GameConstants.Mantle.MaximumHeight + 0.6d);
        if (!double.IsFinite(ledgeY)) return false;

        var climb = ledgeY - player.Position.Y;
        if (climb < GameConstants.Mantle.MinimumHeight ||
            climb > GameConstants.Mantle.MaximumHeight)
        {
            return false;
        }

        MathEx.Set(Temporary, ProbeStart.X, ledgeY + 0.03d, ProbeStart.Z);
        if (!world.IsCapsuleFree(
                Temporary,
                GameConstants.Mantle.Clearance,
                GameConstants.PlayerRadius * 0.95d,
                filter))
        {
            return false;
        }

        player.MantleTime = 0.0001d;
        player.MantleDuration = MathEx.Lerp(
            GameConstants.Mantle.MinimumDuration,
            GameConstants.Mantle.MaximumDuration,
            MathEx.Clamp01(
                (climb - GameConstants.Mantle.MinimumHeight) /
                (GameConstants.Mantle.MaximumHeight - GameConstants.Mantle.MinimumHeight)));
        MathEx.Copy(player.MantleStart, player.Position);
        MathEx.Copy(player.MantleEnd, Temporary);
        player.MoveState = MoveState.Mantle;
        MathEx.Set(player.Velocity, 0d, 0d, 0d);
        return true;
    }

    private static void StepMantle(PlayerState player, double deltaTime)
    {
        player.MantleTime += deltaTime;
        var amount = MathEx.Clamp01(player.MantleTime / player.MantleDuration);
        var vertical = Math.Sin(amount * Math.PI * 0.5d);
        var horizontal = amount * amount * (3d - 2d * amount);

        player.Position.X = MathEx.Lerp(player.MantleStart.X, player.MantleEnd.X, horizontal);
        player.Position.Z = MathEx.Lerp(player.MantleStart.Z, player.MantleEnd.Z, horizontal);
        player.Position.Y = MathEx.Lerp(player.MantleStart.Y, player.MantleEnd.Y, vertical);

        if (amount >= 1d)
        {
            player.MantleTime = 0d;
            player.MoveState = MoveState.Walk;
            player.OnGround = true;
            MathEx.Set(player.Velocity, 0d, 0d, 0d);
        }
    }

    private static void UpdateMoveState(PlayerState player)
    {
        if (player.MoveState is MoveState.Slide or MoveState.Mantle) return;
        if (!player.OnGround)
        {
            player.MoveState = MoveState.Air;
            return;
        }

        if (player.MoveState is MoveState.Sprint or MoveState.TacticalSprint) return;
        var speedSquared =
            player.Velocity.X * player.Velocity.X + player.Velocity.Z * player.Velocity.Z;
        player.MoveState = speedSquared > 0.35d ? MoveState.Walk : MoveState.Idle;
    }

    private static void UpdateFootsteps(PlayerState player, MovementResult result)
    {
        if (!player.OnGround || player.MoveState == MoveState.Slide) return;

        var stride = player.MoveState is MoveState.Sprint or MoveState.TacticalSprint
            ? SprintStride
            : player.Stance == Stance.Prone
                ? ProneStride
                : player.Stance == Stance.Crouch
                    ? CrouchStride
                    : WalkStride;

        var accumulated =
            (StrideAccumulator.TryGetValue(player.Id, out var previous) ? previous : 0d) +
            result.DistanceMoved;
        if (accumulated >= stride)
        {
            StrideAccumulator[player.Id] = accumulated - stride;
            result.Footstep = true;
            result.FootstepLoud =
                player.Stance == Stance.Stand &&
                player.MoveState is MoveState.Sprint or MoveState.TacticalSprint;
        }
        else
        {
            StrideAccumulator[player.Id] = accumulated;
        }
    }

    public static double HorizontalSpeed(PlayerState player) =>
        Math.Sqrt(
            player.Velocity.X * player.Velocity.X + player.Velocity.Z * player.Velocity.Z);

    public static double SmoothedEyeHeight(PlayerState player, double previous, double deltaTime) =>
        MathEx.Damp(previous, CurrentEyeHeight(player), 18d, deltaTime);

    public static double CameraRoll(PlayerState player, InputCommand input)
    {
        if (player.MoveState == MoveState.Slide) return GameConstants.Slide.CameraRoll;
        var strafe = MathEx.Clamp(input.MoveRight, -1d, 1d);
        return -strafe * 0.018d + player.Lean * GameConstants.Lean.MaximumAngle;
    }

    public static bool IsMovementLocked(PlayerState player) => player.MantleTime > 0d;
}

namespace OperationVanguard.Core;

public sealed partial class BrushCollisionWorld
{
    private bool ColliderOverlapsCapsule(
        BrushCollider collider,
        Vec3 position,
        double height,
        double radius,
        Vec3? minimumTranslation)
    {
        if (collider.Shape == ColliderShape.Cylinder)
        {
            return CylinderOverlapsCapsule(
                collider,
                position,
                height,
                radius,
                minimumTranslation);
        }

        var dx = position.X - collider.Center.X;
        var dz = position.Z - collider.Center.Z;
        var localX = dx * collider.CosYaw - dz * collider.SinYaw;
        var localZ = dx * collider.SinYaw + dz * collider.CosYaw;
        var segmentBottom = position.Y - collider.Center.Y;
        var segmentTop = segmentBottom + height;
        var boxBottom = -collider.Half.Y;
        var boxTop = collider.Half.Y;

        var closestX = MathEx.Clamp(localX, -collider.Half.X, collider.Half.X);
        var closestZ = MathEx.Clamp(localZ, -collider.Half.Z, collider.Half.Z);
        var distanceX = localX - closestX;
        var distanceZ = localZ - closestZ;
        var horizontalDistanceSquared = distanceX * distanceX + distanceZ * distanceZ;
        var verticalOverlap =
            Math.Min(segmentTop, boxTop) - Math.Max(segmentBottom, boxBottom);

        if (verticalOverlap <= ContactEpsilon)
        {
            var verticalGap = Math.Max(0d, -verticalOverlap);
            if (horizontalDistanceSquared + verticalGap * verticalGap > radius * radius)
            {
                return false;
            }

            if (minimumTranslation is not null)
            {
                MathEx.Set(minimumTranslation, 0d, 0d, 0d);
            }

            return false;
        }

        if (horizontalDistanceSquared > radius * radius)
        {
            return false;
        }

        if (collider.SlopeNormal is not null)
        {
            var normal = collider.SlopeNormal;
            var feetHeightAbovePlane =
                normal.X * position.X +
                normal.Y * position.Y +
                normal.Z * position.Z -
                collider.SlopeD;
            if (feetHeightAbovePlane > 0d && feetHeightAbovePlane > 0.02d)
            {
                if (minimumTranslation is not null)
                {
                    MathEx.Set(minimumTranslation, 0d, 0d, 0d);
                }

                return false;
            }

            if (minimumTranslation is not null)
            {
                var push = Math.Max(0d, -feetHeightAbovePlane) + 0.001d;
                MathEx.Set(
                    minimumTranslation,
                    normal.X * push,
                    normal.Y * push,
                    normal.Z * push);
            }

            return true;
        }

        if (minimumTranslation is null)
        {
            return true;
        }

        var pushX = collider.Half.X + radius - Math.Abs(localX);
        var pushZ = collider.Half.Z + radius - Math.Abs(localZ);
        var pushUp = boxTop - segmentBottom;
        var pushDown = segmentTop - boxBottom;
        var bestDepth = double.PositiveInfinity;
        var selectedDepth = 0d;
        var selectedX = 0d;
        var selectedY = 0d;
        var selectedZ = 0d;

        if (pushX > 0d)
        {
            bestDepth = pushX;
            selectedDepth = pushX;
            selectedX = NonzeroSign(localX);
        }

        if (pushZ > 0d && pushZ < bestDepth)
        {
            bestDepth = pushZ;
            selectedDepth = pushZ;
            selectedX = 0d;
            selectedY = 0d;
            selectedZ = NonzeroSign(localZ);
        }

        var upwardDepth = Math.Max(0d, pushUp);
        if (upwardDepth > 0d && upwardDepth * 0.6d < bestDepth)
        {
            bestDepth = upwardDepth * 0.6d;
            selectedDepth = upwardDepth;
            selectedX = 0d;
            selectedY = 1d;
            selectedZ = 0d;
        }

        var downwardDepth = Math.Max(0d, pushDown);
        if (downwardDepth > 0d && downwardDepth < bestDepth)
        {
            bestDepth = downwardDepth;
            selectedDepth = downwardDepth;
            selectedX = 0d;
            selectedY = -1d;
            selectedZ = 0d;
        }

        if (!double.IsFinite(bestDepth))
        {
            MathEx.Set(minimumTranslation, 0d, 0.01d, 0d);
            return true;
        }

        if (selectedY != 0d)
        {
            MathEx.Set(
                minimumTranslation,
                0d,
                selectedY * (selectedDepth + 0.001d),
                0d);
            return true;
        }

        var escapeX = selectedX;
        var escapeZ = selectedZ;
        var escapeDepth = selectedDepth + 0.001d;

        // Outside both slabs means contact is with the rounded corner, not a
        // face. Preserve the tuned winning depth, but use the radial normal.
        if (Math.Abs(localX) > collider.Half.X && Math.Abs(localZ) > collider.Half.Z)
        {
            var distance = Math.Sqrt(horizontalDistanceSquared);
            if (distance > 1e-6d)
            {
                escapeX = distanceX / distance;
                escapeZ = distanceZ / distance;
                escapeDepth = radius - distance + 0.001d;
            }
        }

        var worldX = escapeX * collider.CosYaw + escapeZ * collider.SinYaw;
        var worldZ = -escapeX * collider.SinYaw + escapeZ * collider.CosYaw;
        MathEx.Set(minimumTranslation, worldX * escapeDepth, 0d, worldZ * escapeDepth);
        return true;
    }

    private static bool CylinderOverlapsCapsule(
        BrushCollider collider,
        Vec3 position,
        double height,
        double radius,
        Vec3? minimumTranslation)
    {
        var segmentBottom = position.Y;
        var segmentTop = position.Y + height;
        var cylinderBottom = collider.Center.Y - collider.Half.Y;
        var cylinderTop = collider.Center.Y + collider.Half.Y;
        if (Math.Min(segmentTop, cylinderTop) - Math.Max(segmentBottom, cylinderBottom) <=
            ContactEpsilon)
        {
            return false;
        }

        var dx = position.X - collider.Center.X;
        var dz = position.Z - collider.Center.Z;
        var distanceSquared = dx * dx + dz * dz;
        var reach = collider.Half.X + radius;
        if (distanceSquared > reach * reach)
        {
            return false;
        }

        if (minimumTranslation is null)
        {
            return true;
        }

        var distance = Math.Sqrt(distanceSquared);
        var radialPush = reach - distance;
        var upwardPush = Math.Max(0d, cylinderTop - segmentBottom);
        var downwardPush = Math.Max(0d, segmentTop - cylinderBottom);
        var weightedUpwardPush = upwardPush * 0.6d;

        if (distance >= 1e-5d &&
            radialPush <= weightedUpwardPush &&
            radialPush <= downwardPush)
        {
            var push = radialPush + 0.001d;
            MathEx.Set(
                minimumTranslation,
                dx / distance * push,
                0d,
                dz / distance * push);
        }
        else if (weightedUpwardPush <= downwardPush)
        {
            MathEx.Set(minimumTranslation, 0d, upwardPush + 0.001d, 0d);
        }
        else
        {
            MathEx.Set(minimumTranslation, 0d, -(downwardPush + 0.001d), 0d);
        }

        return true;
    }

    private bool DynamicOverlapsCapsule(
        DynamicCollider dynamicCollider,
        Vec3 position,
        double height,
        double radius,
        Vec3? minimumTranslation)
    {
        if (dynamicCollider.Kind == DynamicColliderKind.Capsule)
        {
            var segmentBottom = position.Y;
            var segmentTop = position.Y + height;
            if (segmentBottom > dynamicCollider.Position.Y + dynamicCollider.Height ||
                segmentTop < dynamicCollider.Position.Y)
            {
                return false;
            }

            var dx = position.X - dynamicCollider.Position.X;
            var dz = position.Z - dynamicCollider.Position.Z;
            var distanceSquared = dx * dx + dz * dz;
            var reach = dynamicCollider.Radius + radius;
            if (distanceSquared > reach * reach)
            {
                return false;
            }

            if (minimumTranslation is null)
            {
                return true;
            }

            var distance = Math.Sqrt(distanceSquared);
            if (distance < 1e-5d)
            {
                MathEx.Set(minimumTranslation, reach, 0d, 0d);
                return true;
            }

            var push = reach - distance + 0.001d;
            MathEx.Set(
                minimumTranslation,
                dx / distance * push,
                0d,
                dz / distance * push);
            return true;
        }

        var size = dynamicCollider.Size ?? DefaultDynamicBoxSize;
        var yaw = dynamicCollider.Yaw ?? 0d;
        _tempCollider.Center.X = dynamicCollider.Position.X;
        _tempCollider.Center.Y = dynamicCollider.Position.Y;
        _tempCollider.Center.Z = dynamicCollider.Position.Z;
        _tempCollider.Half.X = size.X / 2d;
        _tempCollider.Half.Y = size.Y / 2d;
        _tempCollider.Half.Z = size.Z / 2d;
        _tempCollider.Yaw = yaw;
        _tempCollider.CosYaw = Math.Cos(yaw);
        _tempCollider.SinYaw = Math.Sin(yaw);
        _tempCollider.SlopeNormal = null;
        return ColliderOverlapsCapsule(
            _tempCollider,
            position,
            height,
            radius,
            minimumTranslation);
    }

    private double RayCollider(
        Vec3 origin,
        Vec3 direction,
        double maxDistance,
        BrushCollider collider,
        Vec3 outputNormal)
    {
        if (collider.Shape == ColliderShape.Cylinder)
        {
            return RayCylinder(origin, direction, maxDistance, collider, outputNormal);
        }

        var dx = origin.X - collider.Center.X;
        var dz = origin.Z - collider.Center.Z;
        MathEx.Set(
            _local,
            dx * collider.CosYaw - dz * collider.SinYaw,
            origin.Y - collider.Center.Y,
            dx * collider.SinYaw + dz * collider.CosYaw);
        MathEx.Set(
            _localDir,
            direction.X * collider.CosYaw - direction.Z * collider.SinYaw,
            direction.Y,
            direction.X * collider.SinYaw + direction.Z * collider.CosYaw);
        MathEx.Set(
            _localBoxMin,
            -collider.Half.X,
            -collider.Half.Y,
            -collider.Half.Z);
        MathEx.Set(
            _localBoxMax,
            collider.Half.X,
            collider.Half.Y,
            collider.Half.Z);

        var distance = MathEx.RayAabb(_local, _localDir, _localBox, maxDistance);
        if (distance < 0d)
        {
            return -1d;
        }

        if (collider.SlopeNormal is not null)
        {
            var normal = collider.SlopeNormal;
            var denominator = MathEx.Dot(direction, normal);
            var originDistance =
                normal.X * origin.X +
                normal.Y * origin.Y +
                normal.Z * origin.Z -
                collider.SlopeD;
            if (originDistance >= 0d)
            {
                if (denominator >= -MathEx.Epsilon)
                {
                    return -1d;
                }

                var planeDistance = -originDistance / denominator;
                if (planeDistance < 0d || planeDistance > maxDistance)
                {
                    return -1d;
                }

                MathEx.Set(
                    _point,
                    origin.X + direction.X * planeDistance,
                    origin.Y + direction.Y * planeDistance,
                    origin.Z + direction.Z * planeDistance);
                if (!PointInsideBoxXz(collider, _point))
                {
                    return -1d;
                }

                MathEx.Copy(outputNormal, normal);
                return planeDistance;
            }

            BoxNormalAt(collider, _local, _localDir, distance, outputNormal);
            return distance;
        }

        BoxNormalAt(collider, _local, _localDir, distance, outputNormal);
        return distance;
    }

    private static bool PointInsideBoxXz(BrushCollider collider, Vec3 point)
    {
        var dx = point.X - collider.Center.X;
        var dz = point.Z - collider.Center.Z;
        var localX = dx * collider.CosYaw - dz * collider.SinYaw;
        var localZ = dx * collider.SinYaw + dz * collider.CosYaw;
        return Math.Abs(localX) <= collider.Half.X + 1e-4d &&
               Math.Abs(localZ) <= collider.Half.Z + 1e-4d;
    }

    private void BoxNormalAt(
        BrushCollider collider,
        Vec3 localOrigin,
        Vec3 localDirection,
        double distance,
        Vec3 outputNormal)
    {
        var hitX = localOrigin.X + localDirection.X * distance;
        var hitY = localOrigin.Y + localDirection.Y * distance;
        var hitZ = localOrigin.Z + localDirection.Z * distance;
        var relativeX = collider.Half.X > MathEx.Epsilon
            ? Math.Abs(hitX) / collider.Half.X
            : 0d;
        var relativeY = collider.Half.Y > MathEx.Epsilon
            ? Math.Abs(hitY) / collider.Half.Y
            : 0d;
        var relativeZ = collider.Half.Z > MathEx.Epsilon
            ? Math.Abs(hitZ) / collider.Half.Z
            : 0d;

        if (relativeY >= relativeX && relativeY >= relativeZ)
        {
            MathEx.Set(_localNormal, 0d, NonzeroSign(hitY), 0d);
        }
        else if (relativeX >= relativeZ)
        {
            MathEx.Set(_localNormal, NonzeroSign(hitX), 0d, 0d);
        }
        else
        {
            MathEx.Set(_localNormal, 0d, 0d, NonzeroSign(hitZ));
        }

        MathEx.Set(
            outputNormal,
            _localNormal.X * collider.CosYaw + _localNormal.Z * collider.SinYaw,
            _localNormal.Y,
            -_localNormal.X * collider.SinYaw + _localNormal.Z * collider.CosYaw);
    }

    private static double RayCylinder(
        Vec3 origin,
        Vec3 direction,
        double maxDistance,
        BrushCollider collider,
        Vec3 outputNormal)
    {
        var radius = collider.Half.X;
        var bottom = collider.Center.Y - collider.Half.Y;
        var top = collider.Center.Y + collider.Half.Y;
        var originX = origin.X - collider.Center.X;
        var originZ = origin.Z - collider.Center.Z;
        var quadraticA = direction.X * direction.X + direction.Z * direction.Z;
        var quadraticB = 2d * (originX * direction.X + originZ * direction.Z);
        var quadraticC = originX * originX + originZ * originZ - radius * radius;
        var best = -1d;

        if (quadraticA > MathEx.Epsilon)
        {
            var discriminant =
                quadraticB * quadraticB - 4d * quadraticA * quadraticC;
            if (discriminant >= 0d)
            {
                var root = Math.Sqrt(discriminant);
                var first = (-quadraticB - root) / (2d * quadraticA);
                var second = (-quadraticB + root) / (2d * quadraticA);
                if (!TryCylinderSide(first))
                {
                    TryCylinderSide(second);
                }
            }
        }

        if (Math.Abs(direction.Y) > MathEx.Epsilon)
        {
            TryCap(bottom, false);
            TryCap(top, true);
        }

        return best;

        bool TryCylinderSide(double distance)
        {
            if (distance < 0d || distance > maxDistance)
            {
                return false;
            }

            var y = origin.Y + direction.Y * distance;
            if (y < bottom || y > top)
            {
                return false;
            }

            if (best < 0d || distance < best)
            {
                best = distance;
                var normalX = originX + direction.X * distance;
                var normalZ = originZ + direction.Z * distance;
                var normalLength = Math.Sqrt(normalX * normalX + normalZ * normalZ);
                var inverse = 1d / (normalLength == 0d ? 1d : normalLength);
                MathEx.Set(outputNormal, normalX * inverse, 0d, normalZ * inverse);
            }

            return true;
        }

        void TryCap(double capY, bool isTop)
        {
            var distance = (capY - origin.Y) / direction.Y;
            if (distance < 0d || distance > maxDistance ||
                (best >= 0d && distance >= best))
            {
                return;
            }

            var pointX = originX + direction.X * distance;
            var pointZ = originZ + direction.Z * distance;
            if (pointX * pointX + pointZ * pointZ > radius * radius)
            {
                return;
            }

            best = distance;
            MathEx.Set(outputNormal, 0d, isTop ? 1d : -1d, 0d);
        }
    }

    private double RayDynamic(
        Vec3 origin,
        Vec3 direction,
        double maxDistance,
        DynamicCollider dynamicCollider,
        Vec3 outputNormal)
    {
        if (dynamicCollider.Kind == DynamicColliderKind.Capsule)
        {
            _tempCollider.Shape = ColliderShape.Cylinder;
            _tempCollider.Center.X = dynamicCollider.Position.X;
            _tempCollider.Center.Y = dynamicCollider.Position.Y + dynamicCollider.Height / 2d;
            _tempCollider.Center.Z = dynamicCollider.Position.Z;
            _tempCollider.Half.X = dynamicCollider.Radius;
            _tempCollider.Half.Y = dynamicCollider.Height / 2d;
            _tempCollider.Half.Z = dynamicCollider.Radius;
            _tempCollider.SlopeNormal = null;
            return RayCylinder(origin, direction, maxDistance, _tempCollider, outputNormal);
        }

        var size = dynamicCollider.Size ?? DefaultDynamicBoxSize;
        var yaw = dynamicCollider.Yaw ?? 0d;
        _tempCollider.Shape = ColliderShape.Box;
        _tempCollider.Center.X = dynamicCollider.Position.X;
        _tempCollider.Center.Y = dynamicCollider.Position.Y;
        _tempCollider.Center.Z = dynamicCollider.Position.Z;
        _tempCollider.Half.X = size.X / 2d;
        _tempCollider.Half.Y = size.Y / 2d;
        _tempCollider.Half.Z = size.Z / 2d;
        _tempCollider.Yaw = yaw;
        _tempCollider.CosYaw = Math.Cos(yaw);
        _tempCollider.SinYaw = Math.Sin(yaw);
        _tempCollider.SlopeNormal = null;
        return RayCollider(origin, direction, maxDistance, _tempCollider, outputNormal);
    }

    private double MeasureThickness(
        Vec3 origin,
        Vec3 direction,
        double entryDistance,
        BrushCollider collider)
    {
        var span = 2d * Math.Sqrt(
            collider.Half.X * collider.Half.X +
            collider.Half.Y * collider.Half.Y +
            collider.Half.Z * collider.Half.Z);
        var step = Math.Max(0.05d, span / 16d);
        for (var distance = step; distance <= span + step; distance += step)
        {
            var rayDistance = entryDistance + distance;
            MathEx.Set(
                _point,
                origin.X + direction.X * rayDistance,
                origin.Y + direction.Y * rayDistance,
                origin.Z + direction.Z * rayDistance);
            if (!PointInsideCollider(collider, _point))
            {
                return distance;
            }
        }

        return span;
    }

    private static bool PointInsideCollider(BrushCollider collider, Vec3 point)
    {
        if (Math.Abs(point.Y - collider.Center.Y) > collider.Half.Y)
        {
            return false;
        }

        if (collider.Shape == ColliderShape.Cylinder)
        {
            var dx = point.X - collider.Center.X;
            var dz = point.Z - collider.Center.Z;
            return dx * dx + dz * dz <= collider.Half.X * collider.Half.X;
        }

        if (!PointInsideBoxXz(collider, point))
        {
            return false;
        }

        if (collider.SlopeNormal is not null)
        {
            var normal = collider.SlopeNormal;
            return normal.X * point.X + normal.Y * point.Y + normal.Z * point.Z -
                collider.SlopeD <= 0d;
        }

        return true;
    }

    private static double NonzeroSign(double value) => value < 0d ? -1d : 1d;

    private static Vec3 DefaultDynamicBoxSize { get; } = new(0.5d, 0.5d, 0.5d);
}

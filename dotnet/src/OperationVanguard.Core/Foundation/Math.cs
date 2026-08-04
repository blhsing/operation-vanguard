namespace OperationVanguard.Core;

/// <summary>
/// Mutable, double-precision vector used by the deterministic simulation.
/// This deliberately does not use System.Numerics.Vector3, whose components are floats.
/// </summary>
public sealed class Vec3
{
    public double X { get; set; }
    public double Y { get; set; }
    public double Z { get; set; }

    public Vec3()
    {
    }

    public Vec3(double x, double y, double z)
    {
        X = x;
        Y = y;
        Z = z;
    }
}

/// <summary>Mutable two-dimensional vector used for spread samples.</summary>
public sealed class Vec2
{
    public double X { get; set; }
    public double Y { get; set; }

    public Vec2()
    {
    }

    public Vec2(double x, double y)
    {
        X = x;
        Y = y;
    }
}

/// <summary>FPS view angles in radians.</summary>
public sealed class ViewAngles
{
    public double Yaw { get; set; }
    public double Pitch { get; set; }

    public ViewAngles()
    {
    }

    public ViewAngles(double yaw, double pitch)
    {
        Yaw = yaw;
        Pitch = pitch;
    }
}

/// <summary>Mutable axis-aligned bounding box.</summary>
public sealed class Aabb
{
    public Vec3 Min { get; set; }
    public Vec3 Max { get; set; }

    public Aabb()
        : this(new Vec3(), new Vec3())
    {
    }

    public Aabb(Vec3 min, Vec3 max)
    {
        Min = min;
        Max = max;
    }
}

/// <summary>
/// Allocation-free double-precision math helpers ported from web/src/shared/math.ts.
/// Methods which mutate a vector return that same vector, matching the TypeScript API.
/// </summary>
public static class MathEx
{
    public const double Epsilon = 1e-6;
    public const double Deg2Rad = Math.PI / 180d;
    public const double Rad2Deg = 180d / Math.PI;
    public const double Tau = Math.PI * 2d;

    public static Vec3 CreateVec3(double x = 0d, double y = 0d, double z = 0d) => new(x, y, z);

    public static Vec3 Set(Vec3 result, double x, double y, double z)
    {
        result.X = x;
        result.Y = y;
        result.Z = z;
        return result;
    }

    public static Vec3 Copy(Vec3 result, Vec3 value)
    {
        result.X = value.X;
        result.Y = value.Y;
        result.Z = value.Z;
        return result;
    }

    public static Vec3 Clone(Vec3 value) => new(value.X, value.Y, value.Z);

    public static Vec3 Add(Vec3 result, Vec3 a, Vec3 b)
    {
        result.X = a.X + b.X;
        result.Y = a.Y + b.Y;
        result.Z = a.Z + b.Z;
        return result;
    }

    public static Vec3 Subtract(Vec3 result, Vec3 a, Vec3 b)
    {
        result.X = a.X - b.X;
        result.Y = a.Y - b.Y;
        result.Z = a.Z - b.Z;
        return result;
    }

    public static Vec3 Scale(Vec3 result, Vec3 value, double scalar)
    {
        result.X = value.X * scalar;
        result.Y = value.Y * scalar;
        result.Z = value.Z * scalar;
        return result;
    }

    /// <summary>result = a + b * scalar.</summary>
    public static Vec3 AddScaled(Vec3 result, Vec3 a, Vec3 b, double scalar)
    {
        result.X = a.X + b.X * scalar;
        result.Y = a.Y + b.Y * scalar;
        result.Z = a.Z + b.Z * scalar;
        return result;
    }

    public static Vec3 Multiply(Vec3 result, Vec3 a, Vec3 b)
    {
        result.X = a.X * b.X;
        result.Y = a.Y * b.Y;
        result.Z = a.Z * b.Z;
        return result;
    }

    public static Vec3 Negate(Vec3 result, Vec3 value)
    {
        result.X = -value.X;
        result.Y = -value.Y;
        result.Z = -value.Z;
        return result;
    }

    public static double Dot(Vec3 a, Vec3 b) => a.X * b.X + a.Y * b.Y + a.Z * b.Z;

    public static Vec3 Cross(Vec3 result, Vec3 a, Vec3 b)
    {
        var ax = a.X;
        var ay = a.Y;
        var az = a.Z;
        var bx = b.X;
        var by = b.Y;
        var bz = b.Z;
        result.X = ay * bz - az * by;
        result.Y = az * bx - ax * bz;
        result.Z = ax * by - ay * bx;
        return result;
    }

    public static double LengthSquared(Vec3 value) =>
        value.X * value.X + value.Y * value.Y + value.Z * value.Z;

    public static double Length(Vec3 value) => Math.Sqrt(LengthSquared(value));

    public static double DistanceSquared(Vec3 a, Vec3 b)
    {
        var dx = a.X - b.X;
        var dy = a.Y - b.Y;
        var dz = a.Z - b.Z;
        return dx * dx + dy * dy + dz * dz;
    }

    public static double Distance(Vec3 a, Vec3 b) => Math.Sqrt(DistanceSquared(a, b));

    public static double DistanceXz(Vec3 a, Vec3 b)
    {
        var dx = a.X - b.X;
        var dz = a.Z - b.Z;
        return Math.Sqrt(dx * dx + dz * dz);
    }

    public static Vec3 Normalize(Vec3 result, Vec3 value)
    {
        var lengthSquared = LengthSquared(value);
        if (lengthSquared < Epsilon)
        {
            return Set(result, 0d, 0d, 0d);
        }

        var inverse = 1d / Math.Sqrt(lengthSquared);
        result.X = value.X * inverse;
        result.Y = value.Y * inverse;
        result.Z = value.Z * inverse;
        return result;
    }

    public static Vec3 Lerp(Vec3 result, Vec3 a, Vec3 b, double amount)
    {
        result.X = a.X + (b.X - a.X) * amount;
        result.Y = a.Y + (b.Y - a.Y) * amount;
        result.Z = a.Z + (b.Z - a.Z) * amount;
        return result;
    }

    public static Vec3 ClampLength(Vec3 result, Vec3 value, double maximum)
    {
        var lengthSquared = LengthSquared(value);
        if (lengthSquared > maximum * maximum && lengthSquared > Epsilon)
        {
            return Scale(result, value, maximum / Math.Sqrt(lengthSquared));
        }

        return Copy(result, value);
    }

    public static Vec3 ProjectOnPlane(Vec3 result, Vec3 value, Vec3 normal)
    {
        var projection = Dot(value, normal);
        result.X = value.X - normal.X * projection;
        result.Y = value.Y - normal.Y * projection;
        result.Z = value.Z - normal.Z * projection;
        return result;
    }

    public static Vec3 Reflect(Vec3 result, Vec3 value, Vec3 normal, double bounce = 1d)
    {
        var projection = Dot(value, normal) * (1d + bounce);
        result.X = value.X - normal.X * projection;
        result.Y = value.Y - normal.Y * projection;
        result.Z = value.Z - normal.Z * projection;
        return result;
    }

    public static bool Equals(Vec3 a, Vec3 b, double tolerance = Epsilon) =>
        Math.Abs(a.X - b.X) <= tolerance &&
        Math.Abs(a.Y - b.Y) <= tolerance &&
        Math.Abs(a.Z - b.Z) <= tolerance;

    public static bool IsFinite(Vec3 value) =>
        double.IsFinite(value.X) && double.IsFinite(value.Y) && double.IsFinite(value.Z);

    public static Vec3 AnglesToForward(Vec3 result, double yaw, double pitch)
    {
        var cosinePitch = Math.Cos(pitch);
        result.X = -Math.Sin(yaw) * cosinePitch;
        result.Y = -Math.Sin(pitch);
        result.Z = -Math.Cos(yaw) * cosinePitch;
        return result;
    }

    public static Vec3 AnglesToForwardFlat(Vec3 result, double yaw)
    {
        result.X = -Math.Sin(yaw);
        result.Y = 0d;
        result.Z = -Math.Cos(yaw);
        return result;
    }

    public static Vec3 AnglesToRight(Vec3 result, double yaw)
    {
        result.X = Math.Cos(yaw);
        result.Y = 0d;
        result.Z = -Math.Sin(yaw);
        return result;
    }

    public static double ForwardToYaw(Vec3 direction) => Math.Atan2(-direction.X, -direction.Z);

    public static double ForwardToPitch(Vec3 direction)
    {
        var horizontal = Math.Sqrt(direction.X * direction.X + direction.Z * direction.Z);
        return Math.Atan2(-direction.Y, horizontal);
    }

    /// <summary>Wrap an angle to (-PI, PI], matching the JavaScript remainder path.</summary>
    public static double WrapAngle(double angle)
    {
        var wrapped = (angle + Math.PI) % Tau;
        if (wrapped < 0d)
        {
            wrapped += Tau;
        }

        return wrapped - Math.PI;
    }

    public static double AngleDelta(double from, double to) => WrapAngle(to - from);

    public static double AngleLerp(double from, double to, double amount) =>
        WrapAngle(from + AngleDelta(from, to) * amount);

    public static double AngleApproach(double from, double to, double maximumStep)
    {
        var delta = AngleDelta(from, to);
        if (Math.Abs(delta) <= maximumStep)
        {
            return WrapAngle(to);
        }

        return WrapAngle(from + JsSign(delta) * maximumStep);
    }

    public static double Clamp(double value, double low, double high) =>
        value < low ? low : value > high ? high : value;

    public static double Clamp01(double value) => value < 0d ? 0d : value > 1d ? 1d : value;

    public static double Lerp(double a, double b, double amount) => a + (b - a) * amount;

    public static double InverseLerp(double a, double b, double value)
    {
        if (Math.Abs(b - a) < Epsilon)
        {
            return 0d;
        }

        return Clamp01((value - a) / (b - a));
    }

    public static double Remap(
        double value,
        double inputA,
        double inputB,
        double outputA,
        double outputB) =>
        Lerp(outputA, outputB, InverseLerp(inputA, inputB, value));

    public static double Smoothstep(double edge0, double edge1, double value)
    {
        var amount = InverseLerp(edge0, edge1, value);
        return amount * amount * (3d - 2d * amount);
    }

    public static double Smootherstep(double edge0, double edge1, double value)
    {
        var amount = InverseLerp(edge0, edge1, value);
        return amount * amount * amount * (amount * (amount * 6d - 15d) + 10d);
    }

    public static double Damp(double current, double target, double rate, double deltaTime) =>
        Lerp(current, target, 1d - Math.Exp(-rate * deltaTime));

    public static Vec3 Damp(Vec3 result, Vec3 current, Vec3 target, double rate, double deltaTime)
    {
        var amount = 1d - Math.Exp(-rate * deltaTime);
        return Lerp(result, current, target, amount);
    }

    public static double MoveTowards(double current, double target, double maximumDelta)
    {
        var delta = target - current;
        if (Math.Abs(delta) <= maximumDelta)
        {
            return target;
        }

        return current + JsSign(delta) * maximumDelta;
    }

    public static double Sign(double value) => value > 0d ? 1d : value < 0d ? -1d : 0d;

    /// <summary>Round to a fixed number of decimals using JavaScript Math.round tie semantics.</summary>
    public static double RoundTo(double value, int decimals)
    {
        var multiplier = Math.Pow(10d, decimals);
        return JsRound(value * multiplier) / multiplier;
    }

    public static Aabb CreateAabb(Vec3 min, Vec3 max) => new(min, max);

    public static Aabb AabbFromCenterSize(Vec3 center, Vec3 size) =>
        new(
            new Vec3(center.X - size.X / 2d, center.Y - size.Y / 2d, center.Z - size.Z / 2d),
            new Vec3(center.X + size.X / 2d, center.Y + size.Y / 2d, center.Z + size.Z / 2d));

    public static bool AabbContains(Aabb box, Vec3 point) =>
        point.X >= box.Min.X && point.X <= box.Max.X &&
        point.Y >= box.Min.Y && point.Y <= box.Max.Y &&
        point.Z >= box.Min.Z && point.Z <= box.Max.Z;

    public static bool AabbOverlaps(Aabb a, Aabb b) =>
        a.Min.X <= b.Max.X && a.Max.X >= b.Min.X &&
        a.Min.Y <= b.Max.Y && a.Max.Y >= b.Min.Y &&
        a.Min.Z <= b.Max.Z && a.Max.Z >= b.Min.Z;

    public static Aabb AabbExpand(Aabb result, Aabb box, double amount)
    {
        result.Min.X = box.Min.X - amount;
        result.Min.Y = box.Min.Y - amount;
        result.Min.Z = box.Min.Z - amount;
        result.Max.X = box.Max.X + amount;
        result.Max.Y = box.Max.Y + amount;
        result.Max.Z = box.Max.Z + amount;
        return result;
    }

    public static Vec3 AabbClosestPoint(Vec3 result, Aabb box, Vec3 point)
    {
        result.X = Clamp(point.X, box.Min.X, box.Max.X);
        result.Y = Clamp(point.Y, box.Min.Y, box.Max.Y);
        result.Z = Clamp(point.Z, box.Min.Z, box.Max.Z);
        return result;
    }

    /// <summary>Slab-method ray/AABB intersection. Direction must be normalized.</summary>
    public static double RayAabb(Vec3 origin, Vec3 direction, Aabb box, double maximumDistance)
    {
        var minimum = 0d;
        var maximum = maximumDistance;

        if (!IntersectSlab(origin.X, direction.X, box.Min.X, box.Max.X, ref minimum, ref maximum) ||
            !IntersectSlab(origin.Y, direction.Y, box.Min.Y, box.Max.Y, ref minimum, ref maximum) ||
            !IntersectSlab(origin.Z, direction.Z, box.Min.Z, box.Max.Z, ref minimum, ref maximum))
        {
            return -1d;
        }

        return minimum;
    }

    public static Vec3 AabbNormalAt(Vec3 result, Aabb box, Vec3 point)
    {
        var centerX = (box.Min.X + box.Max.X) * 0.5d;
        var centerY = (box.Min.Y + box.Max.Y) * 0.5d;
        var centerZ = (box.Min.Z + box.Max.Z) * 0.5d;
        var extentX = OrEpsilon((box.Max.X - box.Min.X) * 0.5d);
        var extentY = OrEpsilon((box.Max.Y - box.Min.Y) * 0.5d);
        var extentZ = OrEpsilon((box.Max.Z - box.Min.Z) * 0.5d);

        var deltaX = (point.X - centerX) / extentX;
        var deltaY = (point.Y - centerY) / extentY;
        var deltaZ = (point.Z - centerZ) / extentZ;
        var absoluteX = Math.Abs(deltaX);
        var absoluteY = Math.Abs(deltaY);
        var absoluteZ = Math.Abs(deltaZ);

        if (absoluteX >= absoluteY && absoluteX >= absoluteZ)
        {
            return Set(result, JsSign(deltaX) == 0d || double.IsNaN(deltaX) ? 1d : JsSign(deltaX), 0d, 0d);
        }

        if (absoluteY >= absoluteZ)
        {
            return Set(result, 0d, JsSign(deltaY) == 0d || double.IsNaN(deltaY) ? 1d : JsSign(deltaY), 0d);
        }

        return Set(result, 0d, 0d, JsSign(deltaZ) == 0d || double.IsNaN(deltaZ) ? 1d : JsSign(deltaZ));
    }

    public static double PointSegmentDistanceSquared(
        Vec3 point,
        Vec3 a,
        Vec3 b,
        Vec3? closestPoint = null)
    {
        var abX = b.X - a.X;
        var abY = b.Y - a.Y;
        var abZ = b.Z - a.Z;
        var apX = point.X - a.X;
        var apY = point.Y - a.Y;
        var apZ = point.Z - a.Z;

        var segmentLengthSquared = abX * abX + abY * abY + abZ * abZ;
        var amount = segmentLengthSquared < Epsilon
            ? 0d
            : (apX * abX + apY * abY + apZ * abZ) / segmentLengthSquared;
        amount = Clamp01(amount);

        var closestX = a.X + abX * amount;
        var closestY = a.Y + abY * amount;
        var closestZ = a.Z + abZ * amount;
        if (closestPoint is not null)
        {
            Set(closestPoint, closestX, closestY, closestZ);
        }

        var dx = point.X - closestX;
        var dy = point.Y - closestY;
        var dz = point.Z - closestZ;
        return dx * dx + dy * dy + dz * dz;
    }

    public static double RayCapsule(
        Vec3 origin,
        Vec3 direction,
        Vec3 basePosition,
        double height,
        double radius,
        double maximumDistance)
    {
        var originX = origin.X - basePosition.X;
        var originZ = origin.Z - basePosition.Z;
        var quadraticA = direction.X * direction.X + direction.Z * direction.Z;
        var quadraticB = 2d * (originX * direction.X + originZ * direction.Z);
        var quadraticC = originX * originX + originZ * originZ - radius * radius;
        var best = -1d;

        if (quadraticA > Epsilon)
        {
            var discriminant = quadraticB * quadraticB - 4d * quadraticA * quadraticC;
            if (discriminant >= 0d)
            {
                var root = Math.Sqrt(discriminant);
                TestCylinder((-quadraticB - root) / (2d * quadraticA));
                TestCylinder((-quadraticB + root) / (2d * quadraticA));
            }
        }
        else if (quadraticC <= 0d)
        {
            TestHorizontalCap(basePosition.Y);
            TestHorizontalCap(basePosition.Y + height);
        }

        TestHemisphere(basePosition.Y, bottom: true);
        TestHemisphere(basePosition.Y + height, bottom: false);
        return best;

        void TestCylinder(double distance)
        {
            if (distance < 0d || distance > maximumDistance)
            {
                return;
            }

            var y = origin.Y + direction.Y * distance;
            if (y >= basePosition.Y && y <= basePosition.Y + height && (best < 0d || distance < best))
            {
                best = distance;
            }
        }

        void TestHorizontalCap(double capY)
        {
            if (Math.Abs(direction.Y) < Epsilon)
            {
                return;
            }

            var distance = (capY - origin.Y) / direction.Y;
            if (distance >= 0d && distance <= maximumDistance && (best < 0d || distance < best))
            {
                best = distance;
            }
        }

        void TestHemisphere(double capY, bool bottom)
        {
            var capX = origin.X - basePosition.X;
            var capYOffset = origin.Y - capY;
            var capZ = origin.Z - basePosition.Z;
            var b = 2d * (capX * direction.X + capYOffset * direction.Y + capZ * direction.Z);
            var c = capX * capX + capYOffset * capYOffset + capZ * capZ - radius * radius;
            var discriminant = b * b - 4d * c;
            if (discriminant < 0d)
            {
                return;
            }

            var root = Math.Sqrt(discriminant);
            TestHemisphereDistance((-b - root) / 2d);
            TestHemisphereDistance((-b + root) / 2d);

            void TestHemisphereDistance(double distance)
            {
                if (distance < 0d || distance > maximumDistance)
                {
                    return;
                }

                var y = origin.Y + direction.Y * distance;
                var correctHalf = bottom ? y <= basePosition.Y : y >= basePosition.Y + height;
                if (correctHalf && (best < 0d || distance < best))
                {
                    best = distance;
                }
            }
        }
    }

    public static double RaySphere(
        Vec3 origin,
        Vec3 direction,
        Vec3 center,
        double radius,
        double maximumDistance)
    {
        var originX = origin.X - center.X;
        var originY = origin.Y - center.Y;
        var originZ = origin.Z - center.Z;
        var quadraticB = 2d * (originX * direction.X + originY * direction.Y + originZ * direction.Z);
        var quadraticC = originX * originX + originY * originY + originZ * originZ - radius * radius;
        var discriminant = quadraticB * quadraticB - 4d * quadraticC;
        if (discriminant < 0d)
        {
            return -1d;
        }

        var root = Math.Sqrt(discriminant);
        var first = (-quadraticB - root) / 2d;
        var second = (-quadraticB + root) / 2d;
        if (first >= 0d && first <= maximumDistance)
        {
            return first;
        }

        return second >= 0d && second <= maximumDistance ? second : -1d;
    }

    public static bool InCone(
        Vec3 origin,
        Vec3 direction,
        Vec3 target,
        double halfAngleRadians,
        double maximumDistance)
    {
        var dx = target.X - origin.X;
        var dy = target.Y - origin.Y;
        var dz = target.Z - origin.Z;
        var distanceSquared = dx * dx + dy * dy + dz * dz;
        if (distanceSquared > maximumDistance * maximumDistance)
        {
            return false;
        }

        if (distanceSquared < Epsilon)
        {
            return true;
        }

        var inverse = 1d / Math.Sqrt(distanceSquared);
        var cosineAngle = (dx * direction.X + dy * direction.Y + dz * direction.Z) * inverse;
        return cosineAngle >= Math.Cos(halfAngleRadians);
    }

    public static double PointPlaneDistance(Vec3 point, Vec3 planePoint, Vec3 planeNormal) =>
        (point.X - planePoint.X) * planeNormal.X +
        (point.Y - planePoint.Y) * planeNormal.Y +
        (point.Z - planePoint.Z) * planeNormal.Z;

    // Shared scratch vectors intentionally mirror the TypeScript implementation.
    public static Vec3 TempA { get; } = new();
    public static Vec3 TempB { get; } = new();
    public static Vec3 TempC { get; } = new();
    public static Vec3 TempD { get; } = new();

    private static bool IntersectSlab(
        double origin,
        double direction,
        double slabMinimum,
        double slabMaximum,
        ref double minimum,
        ref double maximum)
    {
        if (Math.Abs(direction) < Epsilon)
        {
            return origin >= slabMinimum && origin <= slabMaximum;
        }

        var inverse = 1d / direction;
        var first = (slabMinimum - origin) * inverse;
        var second = (slabMaximum - origin) * inverse;
        if (first > second)
        {
            (first, second) = (second, first);
        }

        minimum = Math.Max(minimum, first);
        maximum = Math.Min(maximum, second);
        return minimum <= maximum;
    }

    private static double JsSign(double value) =>
        value > 0d ? 1d : value < 0d ? -1d : value;

    private static double JsRound(double value)
    {
        if (!double.IsFinite(value) || value == 0d)
        {
            return value;
        }

        var floor = Math.Floor(value);
        return value - floor < 0.5d ? floor : floor + 1d;
    }

    private static double OrEpsilon(double value) => value == 0d || double.IsNaN(value) ? Epsilon : value;
}

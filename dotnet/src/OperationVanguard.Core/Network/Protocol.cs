using System.Buffers.Binary;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace OperationVanguard.Core;

public enum NetMessage : byte
{
    Hello = 1,
    Welcome = 2,
    Reject = 3,
    Input = 4,
    Snapshot = 5,
    Events = 6,
    Ping = 7,
    Pong = 8,
    Respawn = 9,
    Chat = 10,
    Bye = 11,
}

public sealed class PlayerSnapshot
{
    public int Id { get; set; }
    public int Team { get; set; }
    public bool Alive { get; set; }
    public bool OnGround { get; set; }
    public bool IsBot { get; set; }
    public int Stance { get; set; }
    public int MoveState { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
    public double Z { get; set; }
    public double Vx { get; set; }
    public double Vy { get; set; }
    public double Vz { get; set; }
    public double Yaw { get; set; }
    public double Pitch { get; set; }
    public int Health { get; set; }
    public int WeaponSlot { get; set; }
    public double Lean { get; set; }
}

public sealed class Snapshot
{
    public uint Tick { get; set; }
    public double ServerTime { get; set; }
    public uint AckedInput { get; set; }
    public List<PlayerSnapshot> Players { get; set; } = [];
    /// <summary>
    /// Optional C# presentation extension. It is appended after the parity wire
    /// frame, so protocol-v8 web clients safely ignore it and legacy servers
    /// remain readable by native clients.
    /// </summary>
    public SnapshotExtension? Extension { get; set; }
}

public sealed class SnapshotExtension
{
    public SnapshotMatchState Match { get; set; } = new();
    public List<ObjectiveSummaryEntry> Objectives { get; set; } = [];
    public List<PlayerCombatSnapshot> Players { get; set; } = [];
}

public sealed class SnapshotMatchState
{
    public MatchPhase Phase { get; set; }
    public double TimeRemaining { get; set; }
    public int Round { get; set; }
    public List<TeamScore> Scores { get; set; } = [];
    public Team? Winner { get; set; }
}

public sealed class WeaponCombatSnapshot
{
    public string DefId { get; set; } = string.Empty;
    public int AmmoInMag { get; set; }
    public int AmmoReserve { get; set; }
    public List<string> Attachments { get; set; } = [];
    public int ShotsInBurst { get; set; }
    public double RecoilYaw { get; set; }
    public double RecoilPitch { get; set; }
    public double Spread { get; set; }
    public double NextFireTime { get; set; }
    public double Heat { get; set; }
}

public sealed class PlayerCombatSnapshot
{
    public int Id { get; set; }
    public double MaxHealth { get; set; }
    public double Armor { get; set; }
    public double RespawnTimer { get; set; }
    public List<WeaponCombatSnapshot> Weapons { get; set; } = [];
    public double AdsProgress { get; set; }
    public bool IsAds { get; set; }
    public WeaponAction Action { get; set; }
    public double ActionTimer { get; set; }
    public int LethalCount { get; set; }
    public int TacticalCount { get; set; }
    public double FieldUpgradeCharge { get; set; }
    public List<string> KillstreakInventory { get; set; } = [];
    public double FlashAmount { get; set; }
    public double ConcussionAmount { get; set; }
    public double EmpTime { get; set; }
    public int Kills { get; set; }
    public int Deaths { get; set; }
    public int Assists { get; set; }
    public double Score { get; set; }
    public int Killstreak { get; set; }
    public int BestKillstreak { get; set; }
    public double StreakScore { get; set; }
    public int Captures { get; set; }
    public int Defends { get; set; }
    public int Plants { get; set; }
    public int Defuses { get; set; }
    public double DamageDealt { get; set; }
    public int Headshots { get; set; }
}

public sealed class WireInput
{
    public uint Seq { get; set; }
    public uint Tick { get; set; }
    public double Dt { get; set; }
    public double MoveForward { get; set; }
    public double MoveRight { get; set; }
    public double Yaw { get; set; }
    public double Pitch { get; set; }
    public uint Buttons { get; set; }
    public int WeaponSlot { get; set; }
}

public sealed class HelloPayload
{
    public int ProtocolVersion { get; set; }
    public string Name { get; set; } = "";
    public object? Loadout { get; set; }
}

public sealed class WelcomePayload
{
    public int YourId { get; set; }
    public string MapId { get; set; } = "";
    public string ModeId { get; set; } = "";
    public string Seed { get; set; } = "";
    public int TickRate { get; set; }
    public int SnapshotRate { get; set; }
}

public sealed class RejectPayload
{
    public string Reason { get; set; } = "";
}

public sealed class ByePayload
{
    public int Id { get; set; }
    public string Reason { get; set; } = "";
}

public sealed class ChatPayload
{
    public int From { get; set; }
    public string Text { get; set; } = "";
}

public sealed class NetWriter
{
    private byte[] _bytes;
    private int _offset;

    public NetWriter(int capacity = 64 * 1024)
    {
        _bytes = new byte[capacity];
    }

    public void U8(int value)
    {
        Need(1);
        _bytes[_offset++] = unchecked((byte)value);
    }

    public void I8(int value)
    {
        Need(1);
        _bytes[_offset++] = unchecked((byte)(sbyte)value);
    }

    public void U16(int value)
    {
        Need(2);
        BinaryPrimitives.WriteUInt16LittleEndian(_bytes.AsSpan(_offset, 2), unchecked((ushort)value));
        _offset += 2;
    }

    public void U32(uint value)
    {
        Need(4);
        BinaryPrimitives.WriteUInt32LittleEndian(_bytes.AsSpan(_offset, 4), value);
        _offset += 4;
    }

    public void F32(double value)
    {
        Need(4);
        BinaryPrimitives.WriteSingleLittleEndian(_bytes.AsSpan(_offset, 4), (float)value);
        _offset += 4;
    }

    public void String(string value)
    {
        var count = Encoding.UTF8.GetByteCount(value);
        if (count > ushort.MaxValue) throw new ArgumentOutOfRangeException(nameof(value), "UTF-8 string is too long.");
        U16(count);
        Need(count);
        Encoding.UTF8.GetBytes(value, _bytes.AsSpan(_offset, count));
        _offset += count;
    }

    public byte[] Finish() => _bytes.AsSpan(0, _offset).ToArray();

    private void Need(int count)
    {
        if (_offset + count <= _bytes.Length) return;
        Array.Resize(ref _bytes, Math.Max(_bytes.Length * 2, _offset + count));
    }
}

public sealed class NetReader
{
    private readonly byte[] _bytes;
    private int _offset;

    public NetReader(byte[] bytes)
    {
        _bytes = bytes;
    }

    public bool Done => _offset >= _bytes.Length;

    public byte U8()
    {
        Require(1);
        return _bytes[_offset++];
    }

    public sbyte I8() => unchecked((sbyte)U8());

    public ushort U16()
    {
        Require(2);
        var value = BinaryPrimitives.ReadUInt16LittleEndian(_bytes.AsSpan(_offset, 2));
        _offset += 2;
        return value;
    }

    public uint U32()
    {
        Require(4);
        var value = BinaryPrimitives.ReadUInt32LittleEndian(_bytes.AsSpan(_offset, 4));
        _offset += 4;
        return value;
    }

    public float F32()
    {
        Require(4);
        var value = BinaryPrimitives.ReadSingleLittleEndian(_bytes.AsSpan(_offset, 4));
        _offset += 4;
        return value;
    }

    public string String()
    {
        var count = U16();
        Require(count);
        var value = Encoding.UTF8.GetString(_bytes, _offset, count);
        _offset += count;
        return value;
    }

    private void Require(int count)
    {
        if (_offset + count > _bytes.Length)
            throw new InvalidDataException("Network frame ended before its declared payload.");
    }
}

public readonly record struct DecodedControl<T>(NetMessage Type, T Payload);

public static class NetProtocol
{
    private const double AngleScale = 65536d / (Math.PI * 2d);
    private const int FlagAlive = 1 << 0;
    private const int FlagOnGround = 1 << 1;
    private const int FlagBot = 1 << 2;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        // JSON.stringify writes Unicode characters directly. The default .NET
        // encoder emits \u escapes, which is valid JSON but not byte parity.
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static ushort PackAngle(double radians)
    {
        var turns = radians * AngleScale;
        var wrapped = ((turns % 65536d) + 65536d) % 65536d;
        return unchecked((ushort)(int)wrapped);
    }

    public static double UnpackAngle(int packed)
    {
        var angle = packed / AngleScale;
        return angle > Math.PI ? angle - Math.PI * 2d : angle;
    }

    public static byte[] EncodeControl<T>(NetMessage type, T payload)
    {
        var writer = new NetWriter(1024);
        writer.U8((byte)type);
        writer.String(UnescapeSupplementaryUnicode(JsonSerializer.Serialize(payload, JsonOptions)));
        return writer.Finish();
    }

    /// <summary>
    /// Encode simulation events with the exact JSON unions consumed by the web
    /// client. Most shared enums are numeric on the TypeScript wire; only the
    /// event discriminator and hit-location string union are textual. Keeping
    /// this conversion local avoids a global enum converter changing team,
    /// surface, damage-cause, projectile, or match-state payloads.
    /// </summary>
    public static byte[] EncodeEvents(IReadOnlyList<SimEvent> events)
    {
        ArgumentNullException.ThrowIfNull(events);
        return EncodeControl(
            NetMessage.Events,
            events.Select(ToWebEvent).ToArray());
    }

    public static DecodedControl<T> DecodeControl<T>(byte[] bytes)
    {
        var reader = new NetReader(bytes);
        var type = (NetMessage)reader.U8();
        var payload = JsonSerializer.Deserialize<T>(reader.String(), JsonOptions)
            ?? throw new InvalidDataException("Control payload contained JSON null.");
        return new DecodedControl<T>(type, payload);
    }

    private static Dictionary<string, object?> ToWebEvent(SimEvent simulationEvent)
    {
        var output = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["type"] = WebEventType(simulationEvent.Type),
            ["tick"] = simulationEvent.Tick,
        };

        switch (simulationEvent)
        {
            case ShotEvent shot:
                output["player"] = shot.Player;
                output["weaponId"] = shot.WeaponId;
                output["origin"] = shot.Origin;
                output["direction"] = shot.Direction;
                output["suppressed"] = shot.Suppressed;
                output["shotIndex"] = shot.ShotIndex;
                break;

            case ImpactEvent impact:
                output["position"] = impact.Position;
                output["normal"] = impact.Normal;
                output["surface"] = impact.Surface;
                output["shooter"] = impact.Shooter;
                output["penetrated"] = impact.Penetrated;
                break;

            case HitEvent hit:
                output["attacker"] = hit.Attacker;
                output["victim"] = hit.Victim;
                output["location"] = WebHitLocation(hit.Location);
                output["damage"] = hit.Damage;
                output["lethal"] = hit.Lethal;
                output["position"] = hit.Position;
                output["weaponId"] = hit.WeaponId;
                break;

            case DamageEvent damage:
                output["victim"] = damage.Victim;
                output["attacker"] = damage.Attacker;
                output["amount"] = damage.Amount;
                output["direction"] = damage.Direction;
                output["cause"] = damage.Cause;
                break;

            case KillEvent kill:
                output["killer"] = kill.Killer;
                output["victim"] = kill.Victim;
                output["assists"] = kill.Assists;
                output["weaponId"] = kill.WeaponId;
                output["headshot"] = kill.Headshot;
                output["cause"] = kill.Cause;
                output["distance"] = kill.Distance;
                output["killerWasLowHealth"] = kill.KillerWasLowHealth;
                output["victimPosition"] = kill.VictimPosition;
                output["killerPosition"] = kill.KillerPosition;
                break;

            case ExplosionEvent explosion:
                output["position"] = explosion.Position;
                output["radius"] = explosion.Radius;
                output["owner"] = explosion.Owner;
                output["kind"] = explosion.Kind;
                break;

            case FootstepEvent footstep:
                output["player"] = footstep.Player;
                output["position"] = footstep.Position;
                output["surface"] = footstep.Surface;
                output["loud"] = footstep.Loud;
                break;

            case ScoreEvent score:
                output["player"] = score.Player;
                output["amount"] = score.Amount;
                output["reason"] = score.Reason;
                break;

            case AnnounceEvent announce:
                output["team"] = announce.Team;
                output["line"] = announce.Line;
                break;

            case GenericSimEvent generic:
                if (generic.Player is { } player) output["player"] = player;
                if (generic.Team is { } team) output["team"] = team;
                if (generic.Position is { } position) output["position"] = position;
                if (generic.Data is not null) output["data"] = generic.Data;
                break;

            default:
                throw new InvalidDataException(
                    $"Unsupported simulation event payload '{simulationEvent.GetType().Name}'.");
        }

        return output;
    }

    private static string WebEventType(SimEventType type) => type switch
    {
        SimEventType.Shot => "shot",
        SimEventType.Impact => "impact",
        SimEventType.Hit => "hit",
        SimEventType.Kill => "kill",
        SimEventType.Damage => "damage",
        SimEventType.Reload => "reload",
        SimEventType.ReloadComplete => "reload_complete",
        SimEventType.WeaponSwap => "weapon_swap",
        SimEventType.Melee => "melee",
        SimEventType.Footstep => "footstep",
        SimEventType.Jump => "jump",
        SimEventType.Land => "land",
        SimEventType.Slide => "slide",
        SimEventType.Mantle => "mantle",
        SimEventType.Spawn => "spawn",
        SimEventType.Death => "death",
        SimEventType.ProjectileThrown => "projectile_thrown",
        SimEventType.Explosion => "explosion",
        SimEventType.Flash => "flash",
        SimEventType.ObjectiveCaptured => "objective_captured",
        SimEventType.ObjectiveContested => "objective_contested",
        SimEventType.ObjectiveNeutralized => "objective_neutralized",
        SimEventType.BombPlanted => "bomb_planted",
        SimEventType.BombDefused => "bomb_defused",
        SimEventType.KillstreakEarned => "killstreak_earned",
        SimEventType.KillstreakCalled => "killstreak_called",
        SimEventType.KillstreakDestroyed => "killstreak_destroyed",
        SimEventType.ScoreAwarded => "score_awarded",
        SimEventType.MedalEarned => "medal_earned",
        SimEventType.MatchStateChanged => "match_state_changed",
        SimEventType.RoundStart => "round_start",
        SimEventType.RoundEnd => "round_end",
        SimEventType.Chat => "chat",
        SimEventType.Announce => "announce",
        SimEventType.TagCollected => "tag_collected",
        SimEventType.DeployablePlaced => "deployable_placed",
        SimEventType.DeployableDestroyed => "deployable_destroyed",
        _ => throw new InvalidDataException($"Unknown simulation event type '{type}'."),
    };

    private static string WebHitLocation(HitLocation location) => location switch
    {
        HitLocation.Head => "head",
        HitLocation.Neck => "neck",
        HitLocation.Chest => "chest",
        HitLocation.Stomach => "stomach",
        HitLocation.UpperArm => "upperArm",
        HitLocation.LowerArm => "lowerArm",
        HitLocation.UpperLeg => "upperLeg",
        HitLocation.LowerLeg => "lowerLeg",
        HitLocation.Foot => "foot",
        _ => throw new InvalidDataException($"Unknown hit location '{location}'."),
    };

    public static NetMessage PeekType(ReadOnlySpan<byte> bytes)
    {
        if (bytes.IsEmpty) throw new InvalidDataException("Network frame is empty.");
        return (NetMessage)bytes[0];
    }

    public static byte[] EncodeSnapshot(Snapshot snapshot)
    {
        var writer = new NetWriter(8 * 1024);
        writer.U8((byte)NetMessage.Snapshot);
        writer.U32(snapshot.Tick);
        writer.F32(snapshot.ServerTime);
        writer.U32(snapshot.AckedInput);
        writer.U16(snapshot.Players.Count);

        foreach (var player in snapshot.Players)
        {
            writer.U16(player.Id);
            writer.U8((player.Alive ? FlagAlive : 0) |
                      (player.OnGround ? FlagOnGround : 0) |
                      (player.IsBot ? FlagBot : 0));
            writer.U8(player.Team);
            writer.U8(player.Stance);
            writer.U8(player.MoveState);
            writer.F32(player.X);
            writer.F32(player.Y);
            writer.F32(player.Z);
            writer.F32(player.Vx);
            writer.F32(player.Vy);
            writer.F32(player.Vz);
            writer.U16(PackAngle(player.Yaw));
            writer.U16(PackAngle(player.Pitch));
            writer.U8(player.Health);
            writer.U8(player.WeaponSlot);
            writer.I8(JsRound(player.Lean * 127d));
        }

        if (snapshot.Extension is { } extension)
        {
            writer.U8(1);
            writer.String(UnescapeSupplementaryUnicode(JsonSerializer.Serialize(extension, JsonOptions)));
        }

        return writer.Finish();
    }

    public static Snapshot DecodeSnapshot(byte[] bytes)
    {
        var reader = new NetReader(bytes);
        _ = reader.U8();
        var snapshot = new Snapshot
        {
            Tick = reader.U32(),
            ServerTime = reader.F32(),
            AckedInput = reader.U32(),
        };
        var count = reader.U16();
        for (var index = 0; index < count; index++)
        {
            var id = reader.U16();
            var flags = reader.U8();
            snapshot.Players.Add(new PlayerSnapshot
            {
                Id = id,
                Alive = (flags & FlagAlive) != 0,
                OnGround = (flags & FlagOnGround) != 0,
                IsBot = (flags & FlagBot) != 0,
                Team = reader.U8(),
                Stance = reader.U8(),
                MoveState = reader.U8(),
                X = reader.F32(),
                Y = reader.F32(),
                Z = reader.F32(),
                Vx = reader.F32(),
                Vy = reader.F32(),
                Vz = reader.F32(),
                Yaw = UnpackAngle(reader.U16()),
                Pitch = UnpackAngle(reader.U16()),
                Health = reader.U8(),
                WeaponSlot = reader.U8(),
                Lean = reader.I8() / 127d,
            });
        }

        if (!reader.Done)
        {
            var extensionVersion = reader.U8();
            var json = reader.String();
            if (extensionVersion == 1)
            {
                snapshot.Extension = JsonSerializer.Deserialize<SnapshotExtension>(json, JsonOptions)
                    ?? throw new InvalidDataException("Snapshot extension contained JSON null.");
            }
        }

        return snapshot;
    }

    public static byte[] EncodeInputs(IReadOnlyList<WireInput> inputs)
    {
        var writer = new NetWriter(2048);
        writer.U8((byte)NetMessage.Input);
        var count = Math.Min(inputs.Count, GameConstants.Network.MaximumInputsPerPacket);
        writer.U8(count);
        for (var index = inputs.Count - count; index < inputs.Count; index++)
        {
            var input = inputs[index];
            writer.U32(input.Seq);
            writer.U32(input.Tick);
            writer.F32(input.Dt);
            writer.I8(JsRound(input.MoveForward * 127d));
            writer.I8(JsRound(input.MoveRight * 127d));
            writer.U16(PackAngle(input.Yaw));
            writer.U16(PackAngle(input.Pitch));
            writer.U32(input.Buttons);
            writer.U8(input.WeaponSlot);
        }
        return writer.Finish();
    }

    public static IReadOnlyList<WireInput> DecodeInputs(byte[] bytes)
    {
        var reader = new NetReader(bytes);
        _ = reader.U8();
        var count = reader.U8();
        var output = new List<WireInput>(count);
        for (var index = 0; index < count; index++)
        {
            output.Add(new WireInput
            {
                Seq = reader.U32(),
                Tick = reader.U32(),
                Dt = reader.F32(),
                MoveForward = reader.I8() / 127d,
                MoveRight = reader.I8() / 127d,
                Yaw = UnpackAngle(reader.U16()),
                Pitch = UnpackAngle(reader.U16()),
                Buttons = reader.U32(),
                WeaponSlot = reader.U8(),
            });
        }
        return output;
    }

    private static int JsRound(double value) => checked((int)Math.Floor(value + 0.5d));

    // System.Text.Json escapes non-BMP characters as UTF-16 surrogate pairs
    // even with UnsafeRelaxedJsonEscaping. JSON.stringify writes the scalar as
    // UTF-8, so collapse only active (not backslash-escaped) surrogate escapes.
    private static string UnescapeSupplementaryUnicode(string json)
    {
        StringBuilder? output = null;
        var copyFrom = 0;
        for (var index = 0; index + 11 < json.Length; index++)
        {
            if (json[index] != '\\' || json[index + 1] != 'u' ||
                json[index + 6] != '\\' || json[index + 7] != 'u') continue;

            var precedingSlashes = 0;
            for (var before = index - 1; before >= 0 && json[before] == '\\'; before--) precedingSlashes++;
            if ((precedingSlashes & 1) != 0) continue;
            if (!ushort.TryParse(json.AsSpan(index + 2, 4), System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var high) ||
                !ushort.TryParse(json.AsSpan(index + 8, 4), System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var low) ||
                !char.IsSurrogatePair((char)high, (char)low)) continue;

            output ??= new StringBuilder(json.Length);
            output.Append(json, copyFrom, index - copyFrom);
            output.Append(char.ConvertFromUtf32(char.ConvertToUtf32((char)high, (char)low)));
            index += 11;
            copyFrom = index + 1;
        }

        if (output is null) return json;
        output.Append(json, copyFrom, json.Length - copyFrom);
        return output.ToString();
    }
}

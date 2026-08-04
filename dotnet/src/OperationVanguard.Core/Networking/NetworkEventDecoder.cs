using System.Text.Json;

namespace OperationVanguard.Core;

/// <summary>
/// Restores the discriminated SimEvent JSON union used by control frames. It
/// accepts both TypeScript's string event tags and the C# server's numeric tags.
/// </summary>
internal static class NetworkEventDecoder
{
    private static readonly IReadOnlyDictionary<string, SimEventType> EventTypes =
        new Dictionary<string, SimEventType>(StringComparer.Ordinal)
        {
            ["shot"] = SimEventType.Shot,
            ["impact"] = SimEventType.Impact,
            ["hit"] = SimEventType.Hit,
            ["kill"] = SimEventType.Kill,
            ["damage"] = SimEventType.Damage,
            ["reload"] = SimEventType.Reload,
            ["reload_complete"] = SimEventType.ReloadComplete,
            ["weapon_swap"] = SimEventType.WeaponSwap,
            ["melee"] = SimEventType.Melee,
            ["footstep"] = SimEventType.Footstep,
            ["jump"] = SimEventType.Jump,
            ["land"] = SimEventType.Land,
            ["slide"] = SimEventType.Slide,
            ["mantle"] = SimEventType.Mantle,
            ["spawn"] = SimEventType.Spawn,
            ["death"] = SimEventType.Death,
            ["projectile_thrown"] = SimEventType.ProjectileThrown,
            ["explosion"] = SimEventType.Explosion,
            ["flash"] = SimEventType.Flash,
            ["objective_captured"] = SimEventType.ObjectiveCaptured,
            ["objective_contested"] = SimEventType.ObjectiveContested,
            ["objective_neutralized"] = SimEventType.ObjectiveNeutralized,
            ["bomb_planted"] = SimEventType.BombPlanted,
            ["bomb_defused"] = SimEventType.BombDefused,
            ["killstreak_earned"] = SimEventType.KillstreakEarned,
            ["killstreak_called"] = SimEventType.KillstreakCalled,
            ["killstreak_destroyed"] = SimEventType.KillstreakDestroyed,
            ["score_awarded"] = SimEventType.ScoreAwarded,
            ["medal_earned"] = SimEventType.MedalEarned,
            ["match_state_changed"] = SimEventType.MatchStateChanged,
            ["round_start"] = SimEventType.RoundStart,
            ["round_end"] = SimEventType.RoundEnd,
            ["chat"] = SimEventType.Chat,
            ["announce"] = SimEventType.Announce,
            ["tag_collected"] = SimEventType.TagCollected,
            ["deployable_placed"] = SimEventType.DeployablePlaced,
            ["deployable_destroyed"] = SimEventType.DeployableDestroyed,
        };

    public static IReadOnlyList<SimEvent> Decode(byte[] bytes)
    {
        var payload = NetProtocol.DecodeControl<JsonElement>(bytes).Payload;
        if (payload.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("Events control payload must be a JSON array.");
        }

        var output = new List<SimEvent>(payload.GetArrayLength());
        foreach (var element in payload.EnumerateArray())
        {
            try
            {
                output.Add(DecodeEvent(element));
            }
            catch (InvalidDataException)
            {
                // TypeScript keeps structural events and the presentation switch
                // ignores unknown discriminants one at a time. Match that forward-
                // compatibility boundary instead of dropping the rest of a batch.
            }
        }

        return output;
    }

    private static SimEvent DecodeEvent(JsonElement element)
    {
        var type = ReadEventType(element.GetProperty("type"));
        SimEvent output = type switch
        {
            SimEventType.Shot => new ShotEvent
            {
                Player = Int(element, "player"),
                WeaponId = String(element, "weaponId"),
                Origin = Vec3(element, "origin"),
                Direction = Vec3(element, "direction"),
                Suppressed = Bool(element, "suppressed"),
                ShotIndex = Int(element, "shotIndex"),
            },
            SimEventType.Impact => new ImpactEvent
            {
                Position = Vec3(element, "position"),
                Normal = Vec3(element, "normal"),
                Surface = EnumValue<SurfaceType>(element, "surface"),
                Shooter = Int(element, "shooter"),
                Penetrated = Bool(element, "penetrated"),
            },
            SimEventType.Hit => new HitEvent
            {
                Attacker = Int(element, "attacker"),
                Victim = Int(element, "victim"),
                Location = EnumValue<HitLocation>(element, "location"),
                Damage = Double(element, "damage"),
                Lethal = Bool(element, "lethal"),
                Position = Vec3(element, "position"),
                WeaponId = String(element, "weaponId"),
            },
            SimEventType.Damage => new DamageEvent
            {
                Victim = Int(element, "victim"),
                Attacker = Int(element, "attacker"),
                Amount = Double(element, "amount"),
                Direction = Vec3(element, "direction"),
                Cause = EnumValue<DamageCause>(element, "cause"),
            },
            SimEventType.Kill => new KillEvent
            {
                Killer = Int(element, "killer"),
                Victim = Int(element, "victim"),
                Assists = IntArray(element, "assists"),
                WeaponId = String(element, "weaponId"),
                Headshot = Bool(element, "headshot"),
                Cause = EnumValue<DamageCause>(element, "cause"),
                Distance = Double(element, "distance"),
                KillerWasLowHealth = Bool(element, "killerWasLowHealth"),
                VictimPosition = Vec3(element, "victimPosition"),
                KillerPosition = Vec3(element, "killerPosition"),
            },
            SimEventType.Explosion => new ExplosionEvent
            {
                Position = Vec3(element, "position"),
                Radius = Double(element, "radius"),
                Owner = Int(element, "owner"),
                Kind = ExplosionKind(element.GetProperty("kind")),
            },
            SimEventType.Footstep => new FootstepEvent
            {
                Player = Int(element, "player"),
                Position = Vec3(element, "position"),
                Surface = EnumValue<SurfaceType>(element, "surface"),
                Loud = Bool(element, "loud"),
            },
            SimEventType.ScoreAwarded => new ScoreEvent
            {
                Player = Int(element, "player"),
                Amount = Double(element, "amount"),
                Reason = String(element, "reason"),
            },
            SimEventType.Announce => new AnnounceEvent
            {
                Team = EnumValue<Team>(element, "team"),
                Line = String(element, "line"),
            },
            _ => Generic(element, type),
        };

        output.Tick = Int(element, "tick");
        return output;
    }

    private static GenericSimEvent Generic(JsonElement element, SimEventType type)
    {
        var output = new GenericSimEvent(type);
        if (element.TryGetProperty("player", out var player) && player.ValueKind == JsonValueKind.Number)
        {
            output.Player = player.GetInt32();
        }

        if (element.TryGetProperty("team", out var team) &&
            team.ValueKind is JsonValueKind.Number or JsonValueKind.String)
        {
            output.Team = EnumValue<Team>(team);
        }

        if (element.TryGetProperty("position", out var position) && position.ValueKind == JsonValueKind.Object)
        {
            output.Position = Vec3(position);
        }

        if (element.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
        {
            output.Data = Object(data);
        }

        return output;
    }

    private static SimEventType ReadEventType(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Number)
        {
            return (SimEventType)value.GetInt32();
        }

        var text = value.GetString() ?? string.Empty;
        if (EventTypes.TryGetValue(text, out var type))
        {
            return type;
        }

        if (Enum.TryParse<SimEventType>(text, true, out type))
        {
            return type;
        }

        throw new InvalidDataException($"Unknown simulation event type '{text}'.");
    }

    private static object ExplosionKind(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String)
        {
            var text = value.GetString() ?? string.Empty;
            if (text == "killstreak")
            {
                return text;
            }

            if (Enum.TryParse<ProjectileKind>(text, true, out var parsed))
            {
                return parsed;
            }

            return text;
        }

        return (ProjectileKind)value.GetInt32();
    }

    private static T EnumValue<T>(JsonElement element, string property)
        where T : struct, Enum => EnumValue<T>(element.GetProperty(property));

    private static T EnumValue<T>(JsonElement value)
        where T : struct, Enum
    {
        if (value.ValueKind == JsonValueKind.Number)
        {
            return (T)Enum.ToObject(typeof(T), value.GetInt32());
        }

        var text = value.GetString() ?? string.Empty;
        if (Enum.TryParse<T>(text, true, out var parsed))
        {
            return parsed;
        }

        throw new InvalidDataException($"Unknown {typeof(T).Name} value '{text}'.");
    }

    private static Vec3 Vec3(JsonElement element, string property) => Vec3(element.GetProperty(property));

    private static Vec3 Vec3(JsonElement element) => new(
        element.GetProperty("x").GetDouble(),
        element.GetProperty("y").GetDouble(),
        element.GetProperty("z").GetDouble());

    private static List<int> IntArray(JsonElement element, string property)
    {
        var output = new List<int>();
        foreach (var value in element.GetProperty(property).EnumerateArray())
        {
            output.Add(value.GetInt32());
        }

        return output;
    }

    private static Dictionary<string, object?> Object(JsonElement element)
    {
        var output = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject())
        {
            output[property.Name] = Unknown(property.Value);
        }

        return output;
    }

    private static object? Unknown(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.Object => Object(value),
        JsonValueKind.Array => value.EnumerateArray().Select(Unknown).ToList(),
        JsonValueKind.String => value.GetString(),
        JsonValueKind.Number when value.TryGetInt32(out var integer) => integer,
        JsonValueKind.Number when value.TryGetInt64(out var integer) => integer,
        JsonValueKind.Number => value.GetDouble(),
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => null,
    };

    private static int Int(JsonElement element, string property) =>
        element.GetProperty(property).GetInt32();

    private static double Double(JsonElement element, string property) =>
        element.GetProperty(property).GetDouble();

    private static bool Bool(JsonElement element, string property) =>
        element.GetProperty(property).GetBoolean();

    private static string String(JsonElement element, string property) =>
        element.GetProperty(property).GetString() ?? string.Empty;
}

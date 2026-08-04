using System.Text.Json;
using OperationVanguard.Core;

namespace OperationVanguard.Server;

/// <summary>
/// Transport-independent connection used by the authoritative room. Production
/// supplies a WebSocket link; tests can use an in-memory collector.
/// </summary>
public interface IClientLink
{
    void Send(byte[] bytes);
    void Close(string reason);
}

public sealed class GameServerOptions
{
    public string MapId { get; set; } = Maps.DefaultId;
    public string ModeId { get; set; } = ModeData.DefaultMode;
    public string? Seed { get; set; }
    public int BotCount { get; set; }
    public string Difficulty { get; set; } = "regular";
}

/// <summary>
/// One authoritative multiplayer room. It owns the only simulation that may be
/// advanced and accepts intent, never client-authored positions or damage.
/// </summary>
public sealed class GameServer : IDisposable
{
    private sealed class Connected
    {
        public required IClientLink Link { get; init; }
        public required int PlayerId { get; init; }
        public required string Name { get; init; }
        public uint AckedInput { get; set; }
        public List<WireInput> Queue { get; } = [];
        public double LastHeard { get; set; }
    }

    private readonly object _gate = new();
    private readonly GameServerOptions _options;
    private readonly string _seed;
    private readonly NavGraph _navigation;
    private readonly BotController _bots;
    private readonly Dictionary<int, Connected> _clients = [];
    private readonly List<int> _botIds = [];

    private double _snapshotAccumulator;
    private double _time;

    public GameServer(GameServerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        _options = new GameServerOptions
        {
            MapId = options.MapId,
            ModeId = options.ModeId,
            Seed = options.Seed,
            BotCount = options.BotCount,
            Difficulty = options.Difficulty,
        };
        _seed = options.Seed ?? $"srv-{options.MapId}";

        Sim = new GameSimulation(new GameOptions
        {
            MapId = options.MapId,
            ModeId = options.ModeId,
            Seed = _seed,
        });
        _navigation = new NavGraph(Sim.Map, Sim.Collision);
        _bots = new BotController(Sim, _navigation, new Rng(0x00c0ffeeu));

        if (!BotData.Difficulties.TryGetValue(options.Difficulty, out var difficulty))
        {
            throw new ArgumentException($"Unknown bot difficulty: {options.Difficulty}", nameof(options));
        }

        FillWithBots(options.BotCount, difficulty);
    }

    /// <summary>The authoritative simulation, exposed for diagnostics and tests.</summary>
    public GameSimulation Sim { get; }

    /// <summary>Descriptive alias for callers that prefer the full name.</summary>
    public GameSimulation Simulation => Sim;

    public int PlayerCount
    {
        get
        {
            lock (_gate)
            {
                return _clients.Count;
            }
        }
    }

    /// <summary>
    /// Admit a client and return its player id, or send a rejection and return
    /// <see langword="null"/>. Protocol compatibility is checked first.
    /// </summary>
    public int? Join(IClientLink link, HelloPayload hello)
    {
        ArgumentNullException.ThrowIfNull(link);
        ArgumentNullException.ThrowIfNull(hello);

        lock (_gate)
        {
            int? Reject(string reason)
            {
                link.Send(NetProtocol.EncodeControl(NetMessage.Reject, new RejectPayload
                {
                    Reason = reason,
                }));
                link.Close(reason);
                return null;
            }

            if (hello.ProtocolVersion != GameConstants.Network.ProtocolVersion)
            {
                return Reject(
                    $"protocol {hello.ProtocolVersion} != server {GameConstants.Network.ProtocolVersion}");
            }

            if (Sim.World.Players.Count >= GameConstants.MaxPlayers)
            {
                return Reject("server full");
            }

            var name = SanitiseName(hello.Name);
            var player = Sim.AddPlayer(new AddPlayerOptions
            {
                Name = name,
                Team = ThinnestTeam(),
                IsBot = false,
                Loadout = SanitiseLoadout(hello.Loadout),
            });

            _clients[player.Id] = new Connected
            {
                Link = link,
                PlayerId = player.Id,
                Name = name,
                AckedInput = 0,
                LastHeard = _time,
            };

            link.Send(NetProtocol.EncodeControl(NetMessage.Welcome, new WelcomePayload
            {
                YourId = player.Id,
                MapId = _options.MapId,
                ModeId = _options.ModeId,
                Seed = _seed,
                TickRate = (int)Math.Round(1d / GameConstants.TickDt),
                SnapshotRate = GameConstants.Network.SnapshotRate,
            }));

            return player.Id;
        }
    }

    public void Leave(int id, string reason = "left")
    {
        lock (_gate)
        {
            LeaveCore(id, reason);
        }
    }

    /// <summary>Handle one client frame. Malformed input is dropped locally.</summary>
    public void Receive(int id, byte[] bytes)
    {
        ArgumentNullException.ThrowIfNull(bytes);

        lock (_gate)
        {
            if (!_clients.TryGetValue(id, out var client))
            {
                return;
            }

            // Even a malformed frame proves the transport is alive, matching the
            // browser server's last-heard ordering.
            client.LastHeard = _time;

            try
            {
                switch (NetProtocol.PeekType(bytes))
                {
                    case NetMessage.Input:
                        foreach (var input in NetProtocol.DecodeInputs(bytes))
                        {
                            if (input.Seq <= client.AckedInput)
                            {
                                continue;
                            }

                            client.Queue.Add(input);
                        }

                        var maximumQueued = GameConstants.Network.MaximumInputsPerPacket * 2;
                        if (client.Queue.Count > maximumQueued)
                        {
                            client.Queue.RemoveRange(0, client.Queue.Count - maximumQueued);
                        }
                        break;

                    case NetMessage.Respawn:
                        Sim.RequestRespawn(id);
                        break;

                    case NetMessage.Ping:
                        {
                            var payload = NetProtocol.DecodeControl<JsonElement>(bytes).Payload;
                            client.Link.Send(NetProtocol.EncodeControl(NetMessage.Pong, payload));
                            break;
                        }

                    case NetMessage.Chat:
                        {
                            var payload = NetProtocol.DecodeControl<JsonElement>(bytes).Payload;
                            var text = ChatText(payload);
                            if (text.Length > GameConstants.Network.MaximumChatLength)
                            {
                                text = text[..GameConstants.Network.MaximumChatLength];
                            }

                            if (text.Length > 0)
                            {
                                Broadcast(NetProtocol.EncodeControl(NetMessage.Chat, new ChatPayload
                                {
                                    From = id,
                                    Text = text,
                                }));
                            }
                            break;
                        }

                    default:
                        break;
                }
            }
            catch
            {
                // A malformed frame is a client problem, not a room failure.
            }
        }
    }

    /// <summary>Advance one simulation tick and send snapshots when due.</summary>
    public IReadOnlyList<SimEvent> Tick(double deltaTime = GameConstants.TickDt)
    {
        lock (_gate)
        {
            _time += deltaTime;

            foreach (var client in _clients.Values)
            {
                InputCommand command;
                if (client.Queue.Count > 0)
                {
                    var wire = client.Queue[0];
                    client.Queue.RemoveAt(0);
                    command = ToCommand(wire, client);
                }
                else
                {
                    command = RepeatLook(client.PlayerId);
                }

                Sim.SetInput(client.PlayerId, command);
            }

            _bots.Update(deltaTime);
            var events = Sim.Step(deltaTime);

            _snapshotAccumulator += deltaTime;
            var snapshotInterval = 1d / GameConstants.Network.SnapshotRate;
            if (_snapshotAccumulator >= snapshotInterval)
            {
                // Deliberately subtract only once. The outer fixed-step loop owns
                // catch-up and the TypeScript room does the same.
                _snapshotAccumulator -= snapshotInterval;
                SendSnapshots();
                if (events.Count > 0)
                {
                    Broadcast(NetProtocol.EncodeEvents(events));
                }
            }

            DropSilentClients();
            return events;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var id in _clients.Keys.ToArray())
            {
                LeaveCore(id, "server closing");
            }

            foreach (var id in _botIds)
            {
                _bots.Unregister(id);
            }
        }
    }

    private void LeaveCore(int id, string reason)
    {
        if (!_clients.Remove(id))
        {
            return;
        }

        Sim.RemovePlayer(id);
        Broadcast(NetProtocol.EncodeControl(NetMessage.Bye, new ByePayload
        {
            Id = id,
            Reason = reason,
        }));
    }

    private InputCommand ToCommand(WireInput wire, Connected client)
    {
        var command = SimulationTypes.CreateEmptyInput();
        command.Seq = unchecked((int)wire.Seq);
        command.Tick = unchecked((int)wire.Tick);
        command.Dt = Math.Min(
            Math.Max(wire.Dt, 0d),
            GameConstants.Network.MaximumInputDt);
        command.MoveForward = ClampOne(wire.MoveForward);
        command.MoveRight = ClampOne(wire.MoveRight);
        command.Yaw = wire.Yaw;
        command.Pitch = Math.Min(Math.Max(wire.Pitch, -Math.PI / 2d), Math.PI / 2d);
        command.Buttons = unchecked((int)wire.Buttons);
        client.AckedInput = wire.Seq;
        return command;
    }

    private InputCommand RepeatLook(int id)
    {
        Sim.World.Players.TryGetValue(id, out var player);
        var command = SimulationTypes.CreateEmptyInput();
        command.Dt = GameConstants.TickDt;
        command.Tick = Sim.World.Tick;
        command.Yaw = player?.Yaw ?? 0d;
        command.Pitch = player?.Pitch ?? 0d;
        return command;
    }

    private void DropSilentClients()
    {
        foreach (var client in _clients.Values.ToArray())
        {
            if (_time - client.LastHeard > GameConstants.Network.TimeoutSeconds)
            {
                LeaveCore(client.PlayerId, "timed out");
            }
        }
    }

    private void SendSnapshots()
    {
        var players = CollectPlayers();
        var extension = CollectSnapshotExtension();
        foreach (var client in _clients.Values)
        {
            client.Link.Send(NetProtocol.EncodeSnapshot(new Snapshot
            {
                Tick = unchecked((uint)Sim.World.Tick),
                ServerTime = _time,
                AckedInput = client.AckedInput,
                Players = players,
                Extension = extension,
            }));
        }
    }

    private SnapshotExtension CollectSnapshotExtension() => new()
    {
        Match = new SnapshotMatchState
        {
            Phase = Sim.World.Match.Phase,
            TimeRemaining = Sim.World.Match.TimeRemaining,
            Round = Sim.World.Match.Round,
            Winner = Sim.World.Match.Winner,
            Scores = Sim.World.Match.Scores.Select(score => new TeamScore
            {
                Team = score.Team,
                Score = score.Score,
                RoundsWon = score.RoundsWon,
            }).ToList(),
        },
        Objectives = Sim.ObjectiveStatus().ToList(),
        Players = Sim.World.Players.Values.Select(player => new PlayerCombatSnapshot
        {
            Id = player.Id,
            MaxHealth = player.MaxHealth,
            Armor = player.Armor,
            RespawnTimer = player.RespawnTimer,
            Weapons = player.Weapons.Select(weapon => new WeaponCombatSnapshot
            {
                DefId = weapon.DefId,
                AmmoInMag = weapon.AmmoInMag,
                AmmoReserve = weapon.AmmoReserve,
                Attachments = weapon.Attachments.ToList(),
                ShotsInBurst = weapon.ShotsInBurst,
                RecoilYaw = weapon.RecoilYaw,
                RecoilPitch = weapon.RecoilPitch,
                Spread = weapon.Spread,
                NextFireTime = weapon.NextFireTime,
                Heat = weapon.Heat,
            }).ToList(),
            AdsProgress = player.AdsProgress,
            IsAds = player.IsAds,
            Action = player.Action,
            ActionTimer = player.ActionTimer,
            LethalCount = player.LethalCount,
            TacticalCount = player.TacticalCount,
            FieldUpgradeCharge = player.FieldUpgradeCharge,
            KillstreakInventory = player.KillstreakInventory.ToList(),
            FlashAmount = player.FlashAmount,
            ConcussionAmount = player.ConcussionAmount,
            EmpTime = player.EmpTime,
            Kills = player.Kills,
            Deaths = player.Deaths,
            Assists = player.Assists,
            Score = player.Score,
            Killstreak = player.Killstreak,
            BestKillstreak = player.BestKillstreak,
            StreakScore = player.StreakScore,
            Captures = player.Captures,
            Defends = player.Defends,
            Plants = player.Plants,
            Defuses = player.Defuses,
            DamageDealt = player.DamageDealt,
            Headshots = player.Headshots,
        }).ToList(),
    };

    private List<PlayerSnapshot> CollectPlayers()
    {
        var output = new List<PlayerSnapshot>(Sim.World.Players.Count);
        foreach (var player in Sim.World.Players.Values)
        {
            var roundedHealth = (int)Math.Floor(player.Health + 0.5d);
            output.Add(new PlayerSnapshot
            {
                Id = player.Id,
                Team = (int)player.Team,
                Alive = player.Alive,
                OnGround = player.OnGround,
                IsBot = player.IsBot,
                Stance = (int)player.Stance,
                MoveState = (int)player.MoveState,
                X = player.Position.X,
                Y = player.Position.Y,
                Z = player.Position.Z,
                Vx = player.Velocity.X,
                Vy = player.Velocity.Y,
                Vz = player.Velocity.Z,
                Yaw = player.Yaw,
                Pitch = player.Pitch,
                Health = Math.Clamp(roundedHealth, 0, byte.MaxValue),
                WeaponSlot = (int)player.ActiveSlot,
                Lean = player.Lean,
            });
        }

        return output;
    }

    private void Broadcast(byte[] bytes)
    {
        foreach (var client in _clients.Values)
        {
            client.Link.Send(bytes);
        }
    }

    private void FillWithBots(int count, BotDifficulty difficulty)
    {
        for (var index = 0; index < count; index++)
        {
            var archetype = LoadoutSystem.BotArchetypes[index % LoadoutSystem.BotArchetypes.Count];
            var bot = Sim.AddPlayer(new AddPlayerOptions
            {
                Name = $"Bot{index + 1}",
                Team = ThinnestTeam(),
                IsBot = true,
                BotSkill = 0.5d,
                Loadout = LoadoutSystem.BotLoadout(archetype, index),
            });
            _bots.Register(bot.Id, archetype, difficulty);
            _botIds.Add(bot.Id);
        }
    }

    private Team ThinnestTeam()
    {
        if (!Sim.Mode.TeamBased)
        {
            return Team.None;
        }

        var allies = 0;
        var axis = 0;
        foreach (var player in Sim.World.Players.Values)
        {
            if (player.Team == Team.Allies)
            {
                allies++;
            }
            else if (player.Team == Team.Axis)
            {
                axis++;
            }
        }

        return allies <= axis ? Team.Allies : Team.Axis;
    }

    private static double ClampOne(double value) =>
        value < -1d ? -1d : value > 1d ? 1d : value;

    private static string SanitiseName(object? raw)
    {
        var source = raw as string ?? string.Empty;
        var cleaned = new string(source
            .Where(character => character is > '\u001f' and not '\u007f')
            .ToArray())
            .Trim();
        if (cleaned.Length > GameConstants.Network.MaximumNameLength)
        {
            cleaned = cleaned[..GameConstants.Network.MaximumNameLength];
        }

        return cleaned.Length > 0 ? cleaned : "Player";
    }

    private static Loadout SanitiseLoadout(object? raw)
    {
        var output = LoadoutSystem.DefaultLoadout();
        switch (raw)
        {
            case Loadout loadout:
                return MergeLoadout(output, loadout);

            case JsonElement { ValueKind: JsonValueKind.Object } element:
                AdoptString(element, "name", value => output.Name = value);
                AdoptString(element, "primary", value => output.Primary = value);
                AdoptStrings(element, "primaryAttachments", value => output.PrimaryAttachments = value);
                AdoptString(element, "secondary", value => output.Secondary = value);
                AdoptStrings(element, "secondaryAttachments", value => output.SecondaryAttachments = value);
                AdoptString(element, "lethal", value => output.Lethal = value);
                AdoptString(element, "tactical", value => output.Tactical = value);
                AdoptStrings(element, "perks", value => output.Perks = value);
                AdoptString(element, "fieldUpgrade", value => output.FieldUpgrade = value);
                AdoptStrings(element, "killstreaks", value => output.Killstreaks = value);
                return output;

            default:
                return output;
        }
    }

    private static Loadout MergeLoadout(Loadout fallback, Loadout supplied) => new()
    {
        Name = supplied.Name ?? fallback.Name,
        Primary = supplied.Primary ?? fallback.Primary,
        PrimaryAttachments = supplied.PrimaryAttachments is null
            ? [.. fallback.PrimaryAttachments]
            : [.. supplied.PrimaryAttachments],
        Secondary = supplied.Secondary ?? fallback.Secondary,
        SecondaryAttachments = supplied.SecondaryAttachments is null
            ? [.. fallback.SecondaryAttachments]
            : [.. supplied.SecondaryAttachments],
        Lethal = supplied.Lethal ?? fallback.Lethal,
        Tactical = supplied.Tactical ?? fallback.Tactical,
        Perks = supplied.Perks is null ? [.. fallback.Perks] : [.. supplied.Perks],
        FieldUpgrade = supplied.FieldUpgrade ?? fallback.FieldUpgrade,
        Killstreaks = supplied.Killstreaks is null
            ? [.. fallback.Killstreaks]
            : [.. supplied.Killstreaks],
    };

    private static void AdoptString(JsonElement source, string name, Action<string> adopt)
    {
        if (source.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
        {
            adopt(value.GetString() ?? string.Empty);
        }
    }

    private static void AdoptStrings(JsonElement source, string name, Action<List<string>> adopt)
    {
        if (!source.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        var strings = new List<string>();
        foreach (var item in value.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                return;
            }

            strings.Add(item.GetString() ?? string.Empty);
        }

        adopt(strings);
    }

    private static string ChatText(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Object ||
            !payload.TryGetProperty("text", out var text) ||
            text.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return string.Empty;
        }

        return text.ValueKind switch
        {
            JsonValueKind.String => text.GetString() ?? string.Empty,
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            JsonValueKind.Number => text.GetRawText(),
            JsonValueKind.Array => string.Join(",", text.EnumerateArray().Select(ChatScalar)),
            JsonValueKind.Object => "[object Object]",
            _ => string.Empty,
        };
    }

    private static string ChatScalar(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString() ?? string.Empty,
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.Number => value.GetRawText(),
        JsonValueKind.Null => string.Empty,
        JsonValueKind.Array => string.Join(",", value.EnumerateArray().Select(ChatScalar)),
        JsonValueKind.Object => "[object Object]",
        _ => string.Empty,
    };
}

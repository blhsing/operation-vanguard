/**
 * The authoritative room.
 *
 * Owns one `GameSimulation` and is the only thing allowed to advance it. A
 * client sends what it *did* — movement intent, look angles, buttons — and never
 * where it ended up; the server decides that, and the snapshot it sends back is
 * the truth. Everything that could be cheated by a modified client is therefore
 * on this side of the wire: collision, damage, line of sight, spawn selection,
 * killstreak earning.
 *
 * It is deliberately transport-agnostic. A `ClientLink` is anything with `send`
 * and `close`, so the whole room can be driven in-process by a test with no
 * sockets involved — which is the only practical way to assert that two clients
 * converge on the same world.
 *
 * What this does NOT do yet, stated plainly because half-finished netcode that
 * claims to be finished is worse than none:
 *   - No lag compensation. `MAX_LAG_COMPENSATION` and `LAG_COMP_HISTORY_TICKS`
 *     exist in constants.ts and nothing rewinds hitboxes yet, so a shot is
 *     resolved against where the target is when the packet lands.
 *   - No delta compression. Every snapshot is a full one.
 *   - No interest management. `NET.interestRadius` is unused; everyone gets
 *     everyone.
 */

import { MAX_PLAYERS, NET, TICK_DT } from '../shared/constants.js';
import { Rng } from '../shared/rng.js';
import { GameSimulation } from '../shared/sim/game.js';
import { NavGraph } from '../shared/ai/navigation.js';
import { BotController, DIFFICULTIES, type BotDifficulty } from '../shared/ai/bot.js';
import { BOT_ARCHETYPES, botLoadout, defaultLoadout, type BotArchetype, type Loadout } from '../shared/sim/loadout.js';
import {
  NetMessage,
  decodeControl,
  decodeInputs,
  encodeControl,
  encodeSnapshot,
  peekType,
  type ByePayload,
  type ChatPayload,
  type HelloPayload,
  type PlayerSnapshot,
  type RejectPayload,
  type Snapshot,
  type WelcomePayload,
  type WireInput,
} from '../shared/net/protocol.js';
import {
  Team,
  createEmptyInput,
  type InputCommand,
  type PlayerId,
  type SimEvent,
} from '../shared/types.js';

/** Anything the room can talk to. A socket in production, an array in a test. */
export interface ClientLink {
  send(bytes: Uint8Array): void;
  close(reason: string): void;
}

interface Connected {
  link: ClientLink;
  playerId: PlayerId;
  name: string;
  /** Highest input sequence folded into the simulation, echoed in snapshots. */
  ackedInput: number;
  /** Inputs received but not yet consumed, oldest first. */
  queue: WireInput[];
  lastHeard: number;
}

export interface GameServerOptions {
  mapId: string;
  modeId: string;
  seed?: string;
  /** Bots added to keep a thin lobby playable. */
  botCount?: number;
  difficulty?: keyof typeof DIFFICULTIES;
}

export class GameServer {
  readonly sim: GameSimulation;
  private readonly nav: NavGraph;
  private readonly bots: BotController;
  private readonly clients = new Map<PlayerId, Connected>();
  private readonly botIds: PlayerId[] = [];

  private snapshotAccum = 0;
  private time = 0;

  constructor(private readonly opts: GameServerOptions) {
    this.sim = new GameSimulation({
      mapId: opts.mapId,
      modeId: opts.modeId,
      seed: opts.seed ?? `srv-${opts.mapId}`,
    });
    this.nav = new NavGraph(this.sim.map, this.sim.collision);
    this.bots = new BotController(this.sim, this.nav, new Rng(0xc0ffee));
    this.fillWithBots(opts.botCount ?? 0, DIFFICULTIES[opts.difficulty ?? 'regular']!);
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  /**
   * Admit a client, or refuse it and say why.
   *
   * Returns the assigned player id, or null if the connection was rejected — in
   * which case the link has already been sent a Reject and closed.
   */
  join(link: ClientLink, hello: HelloPayload): PlayerId | null {
    const reject = (reason: string): null => {
      link.send(encodeControl(NetMessage.Reject, { reason } satisfies RejectPayload));
      link.close(reason);
      return null;
    };

    if (hello.protocolVersion !== NET.protocolVersion) {
      // Version skew produces garbled structs rather than an honest failure, so
      // it is checked before anything else is read.
      return reject(
        `protocol ${hello.protocolVersion} != server ${NET.protocolVersion}`,
      );
    }
    if (this.sim.world.players.size >= MAX_PLAYERS) return reject('server full');

    const name = sanitiseName(hello.name);
    const player = this.sim.addPlayer({
      name,
      team: this.thinnestTeam(),
      isBot: false,
      loadout: sanitiseLoadout(hello.loadout),
    });

    this.clients.set(player.id, {
      link,
      playerId: player.id,
      name,
      ackedInput: 0,
      queue: [],
      lastHeard: this.time,
    });

    link.send(
      encodeControl(NetMessage.Welcome, {
        yourId: player.id,
        mapId: this.opts.mapId,
        modeId: this.opts.modeId,
        seed: this.opts.seed ?? `srv-${this.opts.mapId}`,
        tickRate: Math.round(1 / TICK_DT),
        snapshotRate: NET.snapshotRate,
      } satisfies WelcomePayload),
    );

    return player.id;
  }

  leave(id: PlayerId, reason = 'left'): void {
    const c = this.clients.get(id);
    if (!c) return;
    this.clients.delete(id);
    this.sim.removePlayer(id);
    this.broadcast(encodeControl(NetMessage.Bye, { id, reason } satisfies ByePayload));
  }

  get playerCount(): number {
    return this.clients.size;
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  /** Handle one frame from a client. Never throws on malformed input. */
  receive(id: PlayerId, bytes: Uint8Array): void {
    const c = this.clients.get(id);
    if (!c) return;
    c.lastHeard = this.time;

    try {
      switch (peekType(bytes)) {
        case NetMessage.Input: {
          for (const input of decodeInputs(bytes)) {
            // Anything already folded in is a duplicate from a resend.
            if (input.seq <= c.ackedInput) continue;
            c.queue.push(input);
          }
          // A client that stalls and then floods must not be able to buy itself
          // a burst of extra movement. Keep only the most recent batch's worth.
          if (c.queue.length > NET.maxInputsPerPacket * 2) {
            c.queue.splice(0, c.queue.length - NET.maxInputsPerPacket * 2);
          }
          break;
        }
        case NetMessage.Respawn:
          this.sim.requestRespawn(id);
          break;
        case NetMessage.Ping:
          c.link.send(encodeControl(NetMessage.Pong, decodeControl(bytes).payload));
          break;
        case NetMessage.Chat: {
          const { payload } = decodeControl<ChatPayload>(bytes);
          const text = String(payload?.text ?? '').slice(0, NET.maxChatLength);
          if (text.length > 0) {
            this.broadcast(encodeControl(NetMessage.Chat, { from: id, text } satisfies ChatPayload));
          }
          break;
        }
        default:
          break;
      }
    } catch {
      // A malformed frame is a client problem, not a server one. Drop it.
    }
  }

  // -------------------------------------------------------------------------
  // Stepping
  // -------------------------------------------------------------------------

  /** Advance one simulation tick and, when due, send snapshots. */
  tick(dt: number = TICK_DT): SimEvent[] {
    this.time += dt;

    for (const c of this.clients.values()) {
      const input = c.queue.shift();
      this.sim.setInput(c.playerId, input ? this.toCommand(input, c) : this.repeatLook(c.playerId));
    }

    this.bots.update(dt);
    const events = this.sim.step(dt);

    this.snapshotAccum += dt;
    const interval = 1 / NET.snapshotRate;
    if (this.snapshotAccum >= interval) {
      this.snapshotAccum -= interval;
      this.sendSnapshots();
      if (events.length > 0) {
        this.broadcast(encodeControl(NetMessage.Events, events));
      }
    }

    this.dropSilentClients();
    return events;
  }

  /**
   * Turn a wire input into a command the simulation will accept.
   *
   * Everything a hostile client could inflate is clamped here. `dt` is the
   * important one: the simulation advances a player by the time their command
   * claims to cover, so a client that says a tick took a second moves sixty
   * times as far for free.
   */
  private toCommand(w: WireInput, c: Connected): InputCommand {
    const cmd = createEmptyInput();
    cmd.seq = w.seq;
    cmd.tick = w.tick;
    cmd.dt = Math.min(Math.max(w.dt, 0), NET.maxInputDt);
    cmd.moveForward = clamp1(w.moveForward);
    cmd.moveRight = clamp1(w.moveRight);
    cmd.yaw = w.yaw;
    cmd.pitch = Math.min(Math.max(w.pitch, -Math.PI / 2), Math.PI / 2);
    cmd.buttons = w.buttons >>> 0;
    c.ackedInput = w.seq;
    return cmd;
  }

  /**
   * What to feed the simulation for a client whose packet has not arrived.
   *
   * Their last look direction with no buttons and no movement. Repeating the
   * whole previous command instead would keep them running — and a player who
   * drops out mid-sprint should stop, not sprint on through the wall they were
   * heading for.
   */
  private repeatLook(id: PlayerId): InputCommand {
    const p = this.sim.world.players.get(id);
    const cmd = createEmptyInput();
    cmd.dt = TICK_DT;
    cmd.tick = this.sim.world.tick;
    cmd.yaw = p?.yaw ?? 0;
    cmd.pitch = p?.pitch ?? 0;
    return cmd;
  }

  private dropSilentClients(): void {
    for (const c of [...this.clients.values()]) {
      if (this.time - c.lastHeard > NET.timeoutSeconds) this.leave(c.playerId, 'timed out');
    }
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * One snapshot per client, not one broadcast.
   *
   * They differ only in `ackedInput`, but that field is what the recipient uses
   * to decide which of its predicted inputs to replay, so it has to be theirs.
   * The player array is built once and shared.
   */
  private sendSnapshots(): void {
    const players = this.collectPlayers();
    for (const c of this.clients.values()) {
      const snap: Snapshot = {
        tick: this.sim.world.tick,
        serverTime: this.time,
        ackedInput: c.ackedInput,
        players,
      };
      c.link.send(encodeSnapshot(snap));
    }
  }

  private collectPlayers(): PlayerSnapshot[] {
    const out: PlayerSnapshot[] = [];
    for (const p of this.sim.world.players.values()) {
      out.push({
        id: p.id,
        team: p.team,
        alive: p.alive,
        onGround: p.onGround,
        isBot: p.isBot,
        stance: p.stance,
        moveState: p.moveState,
        x: p.position.x,
        y: p.position.y,
        z: p.position.z,
        vx: p.velocity.x,
        vy: p.velocity.y,
        vz: p.velocity.z,
        yaw: p.yaw,
        pitch: p.pitch,
        health: Math.max(0, Math.min(255, Math.round(p.health))),
        weaponSlot: p.activeSlot,
        lean: p.lean,
      });
    }
    return out;
  }

  private broadcast(bytes: Uint8Array): void {
    for (const c of this.clients.values()) c.link.send(bytes);
  }

  // -------------------------------------------------------------------------
  // Bots
  // -------------------------------------------------------------------------

  private fillWithBots(count: number, difficulty: BotDifficulty): void {
    for (let i = 0; i < count; i++) {
      const archetype: BotArchetype = BOT_ARCHETYPES[i % BOT_ARCHETYPES.length]!;
      const bot = this.sim.addPlayer({
        name: `Bot${i + 1}`,
        team: this.thinnestTeam(),
        isBot: true,
        botSkill: 0.5,
        loadout: botLoadout(archetype, i),
      });
      this.bots.register(bot.id, archetype, difficulty);
      this.botIds.push(bot.id);
    }
  }

  /** Put the joiner wherever there is room, so teams do not drift apart. */
  private thinnestTeam(): Team {
    if (!this.sim.mode.teamBased) return Team.None;
    let allies = 0;
    let axis = 0;
    for (const p of this.sim.world.players.values()) {
      if (p.team === Team.Allies) allies++;
      else if (p.team === Team.Axis) axis++;
    }
    return allies <= axis ? Team.Allies : Team.Axis;
  }

  dispose(): void {
    for (const id of [...this.clients.keys()]) this.leave(id, 'server closing');
    for (const id of this.botIds) this.bots.unregister(id);
  }
}

// ---------------------------------------------------------------------------

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

function sanitiseName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  // Control characters would corrupt a killfeed and are never legitimate.
  const cleaned = s.replace(/[ -]/g, '').trim();
  return cleaned.slice(0, NET.maxNameLength) || 'Player';
}

/**
 * Never trust a loadout off the wire.
 *
 * A client that sends an unknown weapon id, or one it has not unlocked, must not
 * be able to spawn holding it. Anything that does not survive the arsenal's own
 * lookup falls back to the default, which is the same thing that happens to a
 * corrupted local profile.
 */
function sanitiseLoadout(raw: unknown): Loadout {
  if (!raw || typeof raw !== 'object') return defaultLoadout();
  try {
    // `defaultLoadout` fills every field, so anything missing or malformed in the
    // client's version is simply not adopted.
    return { ...defaultLoadout(), ...(raw as Partial<Loadout>) };
  } catch {
    return defaultLoadout();
  }
}

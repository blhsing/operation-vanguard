/**
 * Objective modes.
 *
 * One engine drives Domination, Hardpoint, Headquarters, Search & Destroy and
 * Kill Confirmed. They differ in *which* zones are live, *how* ownership changes
 * and *what* it pays — all of which are parameters — rather than in the shape of
 * the logic, which is always: find who is standing in the zone, resolve contest,
 * advance progress, pay out.
 *
 * The rules implemented here are the ones players already know, and they are
 * treated as specification. A Domination flag captures in ten seconds and faster
 * with more people on it; a contested flag does nothing at all; a planted bomb
 * runs 45 seconds and can be defused in seven and a half. Getting these wrong is
 * instantly obvious to anyone who has played the genre.
 */

import { clamp01, v3distance } from '../math.js';
import {
  MatchPhase,
  SimEventType,
  Team,
  isEnemyTeam,
  opposingTeam,
  type PlayerId,
  type PlayerState,
  type SimEvent,
  type WorldState,
} from '../types.js';
import type { MapDef, ObjectiveDef } from '../map/map-types.js';
import { ObjectiveKind } from '../map/map-types.js';
import type { GameModeDef } from '../data/modes.js';

// ---------------------------------------------------------------------------
// Zone state
// ---------------------------------------------------------------------------

export interface ZoneState {
  def: ObjectiveDef;
  /** Who owns it. Team.None means neutral. */
  owner: Team;
  /** Capture progress toward `capturingTeam`, 0..1. */
  progress: number;
  capturingTeam: Team;
  /** True while both teams have someone inside. */
  contested: boolean;
  /** Whether this zone is currently live (Hardpoint rotation, HQ spawn). */
  active: boolean;
  /** Players inside right now, refreshed every tick. */
  occupants: PlayerId[];
  /** Seconds this zone has been active, for rotation timing. */
  activeTime: number;
  /** Accumulates toward the next scoring tick. */
  tickAccum: number;
  /** Everyone who contributed to the current capture, for capture credit. */
  contributors: Set<PlayerId>;
}

export interface BombState {
  planted: boolean;
  /** Which site index it is planted at, or -1. */
  site: number;
  /** Seconds until detonation once planted. */
  timer: number;
  /** Plant/defuse progress, 0..1. */
  progress: number;
  /** Who is currently interacting. */
  actor: PlayerId;
  defusing: boolean;
  /** True once it has gone off or been defused this round. */
  resolved: boolean;
  /** Which team is attacking this round. */
  attackers: Team;
}

/** A dropped dog tag in Kill Confirmed. */
export interface TagState {
  id: number;
  /** Team of the player who died — the enemy collects to confirm. */
  team: Team;
  position: { x: number; y: number; z: number };
  life: number;
  victim: PlayerId;
  killer: PlayerId;
}

export interface ObjectiveState {
  zones: ZoneState[];
  bomb: BombState;
  tags: TagState[];
  nextTagId: number;
  /** Index of the live Hardpoint/HQ zone in `zones`, or -1. */
  liveZone: number;
  /** Seconds until the next rotation. */
  rotationTimer: number;
  /** Score ticks awarded so far this match, for the HUD. */
  totalTicks: number;
}

export function createObjectiveState(map: MapDef, mode: GameModeDef): ObjectiveState {
  const kind = mode.objectiveKind;
  const defs = kind ? map.objectives.filter((o) => o.kind === kind) : [];

  const zones: ZoneState[] = defs
    .slice()
    // Hardpoint and HQ rotate in the author's declared order.
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((def) => ({
      def,
      owner: def.initialOwner ?? Team.None,
      progress: 0,
      capturingTeam: Team.None,
      contested: false,
      active: kind === ObjectiveKind.DominationFlag,
      occupants: [],
      activeTime: 0,
      tickAccum: 0,
      contributors: new Set<PlayerId>(),
    }));

  // Rotating modes start with only their first zone live.
  const rotating = kind === ObjectiveKind.Hardpoint || kind === ObjectiveKind.Headquarters;
  if (rotating && zones.length > 0) zones[0]!.active = true;

  return {
    zones,
    bomb: {
      planted: false,
      site: -1,
      timer: 0,
      progress: 0,
      actor: 0,
      defusing: false,
      resolved: false,
      // Allies attack first; sides swap at the half.
      attackers: Team.Allies,
    },
    tags: [],
    nextTagId: 1,
    liveZone: rotating && zones.length > 0 ? 0 : -1,
    rotationTimer: rotating ? num(mode.params.rotationTime, 60) : 0,
    totalTicks: 0,
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

/**
 * Is a player inside a zone?
 *
 * A box test rather than a radius, because zones are authored as boxes and a
 * player standing in the corner of a marked area must count — "I was on the
 * point" disputes are the fastest way to lose trust in an objective mode.
 */
function isInside(player: PlayerState, def: ObjectiveDef): boolean {
  const p = player.position;
  const c = def.position;
  const h = def.size;
  return (
    Math.abs(p.x - c.x) <= h.x / 2 &&
    Math.abs(p.z - c.z) <= h.z / 2 &&
    // Vertical tolerance is generous upward so a catwalk over the point still
    // counts, but not so generous that a player two storeys up captures it.
    p.y >= c.y - 2 &&
    p.y <= c.y + h.y
  );
}

function refreshOccupants(world: WorldState, zone: ZoneState): { allies: number; axis: number } {
  zone.occupants.length = 0;
  let allies = 0;
  let axis = 0;

  for (const player of world.players.values()) {
    if (!player.alive) continue;
    if (!isInside(player, zone.def)) continue;
    zone.occupants.push(player.id);
    if (player.team === Team.Allies) allies++;
    else if (player.team === Team.Axis) axis++;
  }

  zone.contested = allies > 0 && axis > 0;
  return { allies, axis };
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface ObjectiveTickResult {
  events: SimEvent[];
  /** Score to add per team this tick. */
  teamScore: Map<Team, number>;
  /** Score to award to individual players. */
  playerScore: Array<{ player: PlayerId; amount: number; reason: string }>;
  /** Set when the mode has decided the round/match is over. */
  roundWinner: Team | null;
  /** Spawn group weights, so spawns flip as objectives change hands. */
  spawnWeights: Record<string, number> | null;
}

const _result: ObjectiveTickResult = {
  events: [],
  teamScore: new Map(),
  playerScore: [],
  roundWinner: null,
  spawnWeights: null,
};

export function stepObjectives(
  world: WorldState,
  map: MapDef,
  mode: GameModeDef,
  state: ObjectiveState,
  dt: number,
): ObjectiveTickResult {
  _result.events = [];
  _result.teamScore.clear();
  _result.playerScore.length = 0;
  _result.roundWinner = null;
  _result.spawnWeights = null;

  if (world.match.phase !== MatchPhase.Live && world.match.phase !== MatchPhase.Overtime) {
    return _result;
  }

  switch (mode.objectiveKind) {
    case ObjectiveKind.DominationFlag:
      stepDomination(world, mode, state, dt);
      break;
    case ObjectiveKind.Hardpoint:
      stepHardpoint(world, mode, state, dt);
      break;
    case ObjectiveKind.Headquarters:
      stepHeadquarters(world, mode, state, dt);
      break;
    case ObjectiveKind.BombSite:
      stepSearchAndDestroy(world, map, mode, state, dt);
      break;
    default:
      break;
  }

  if (mode.id === 'kc') stepKillConfirmed(world, mode, state, dt);

  return _result;
}

function addTeamScore(team: Team, amount: number): void {
  _result.teamScore.set(team, (_result.teamScore.get(team) ?? 0) + amount);
}

function addPlayerScore(player: PlayerId, amount: number, reason: string): void {
  _result.playerScore.push({ player, amount, reason });
}

// ---------------------------------------------------------------------------
// Domination
// ---------------------------------------------------------------------------

function stepDomination(
  world: WorldState,
  mode: GameModeDef,
  state: ObjectiveState,
  dt: number,
): void {
  const captureTime = num(mode.params.captureTime, 10);
  const perExtra = num(mode.params.captureSpeedPerExtraPlayer, 0.5);
  const decayRate = num(mode.params.captureDecayRate, 0.5);

  for (const zone of state.zones) {
    const { allies, axis } = refreshOccupants(world, zone);

    // A contested flag does nothing — no capture, no tick. That stalemate is
    // what turns a flag into a fight rather than a race.
    if (zone.contested) {
      emit(SimEventType.ObjectiveContested, { label: zone.def.label });
      continue;
    }

    const presentTeam = allies > 0 ? Team.Allies : axis > 0 ? Team.Axis : Team.None;
    const count = Math.max(allies, axis);

    if (presentTeam !== Team.None && presentTeam !== zone.owner) {
      // Capture rate is sub-linear in headcount: a second player helps a lot, a
      // fifth barely at all, so stacking a flag is a poor use of a team.
      const rate = (1 + (count - 1) * perExtra) / captureTime;

      if (zone.capturingTeam !== presentTeam) {
        zone.capturingTeam = presentTeam;
        zone.progress = 0;
        zone.contributors.clear();
      }
      for (const id of zone.occupants) zone.contributors.add(id);

      zone.progress = clamp01(zone.progress + rate * dt);

      if (zone.progress >= 1) {
        const previous = zone.owner;
        zone.owner = presentTeam;
        zone.progress = 0;
        zone.capturingTeam = Team.None;

        for (const id of zone.contributors) {
          const player = world.players.get(id);
          if (player && player.team === presentTeam) {
            player.captures++;
            addPlayerScore(id, mode.scoring.capture, 'capture');
          }
        }
        zone.contributors.clear();

        emit(SimEventType.ObjectiveCaptured, {
          label: zone.def.label,
          team: presentTeam,
          previousOwner: previous,
        });
        _result.spawnWeights = dominationSpawnWeights(state);
      }
    } else if (presentTeam === Team.None && zone.progress > 0) {
      // Nobody on it: progress bleeds back, so a half-capture is not banked.
      zone.progress = Math.max(0, zone.progress - (decayRate / captureTime) * dt);
      if (zone.progress <= 0) zone.capturingTeam = Team.None;
    } else if (presentTeam === zone.owner) {
      // Owners standing on their own flag defend it: progress toward an enemy
      // capture is pushed back faster than it decays on its own.
      if (zone.capturingTeam !== Team.None && zone.capturingTeam !== zone.owner) {
        zone.progress = Math.max(0, zone.progress - (2 / captureTime) * dt * count);
        if (zone.progress <= 0) zone.capturingTeam = Team.None;
      }
    }

    // --- scoring tick ------------------------------------------------------
    if (zone.owner !== Team.None && !zone.contested) {
      zone.tickAccum += dt;
      if (zone.tickAccum >= mode.scoring.objectiveTickInterval) {
        zone.tickAccum -= mode.scoring.objectiveTickInterval;
        addTeamScore(zone.owner, mode.scoring.objectiveTick);
        state.totalTicks++;

        // Players holding their own flag get defence credit.
        for (const id of zone.occupants) {
          const player = world.players.get(id);
          if (player && player.team === zone.owner) {
            player.defends++;
            addPlayerScore(id, mode.scoring.defend, 'defend');
          }
        }
      }
    }
  }
}

/**
 * Bias spawns toward the half of the map a team controls.
 *
 * This is what makes Domination spawns flip when a flag changes hands, and it is
 * most of why the mode feels different from Team Deathmatch on the same map.
 */
function dominationSpawnWeights(state: ObjectiveState): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const zone of state.zones) {
    const label = zone.def.label.toLowerCase();
    if (zone.owner === Team.Allies) {
      weights[`allies_${label}`] = 1;
      weights[`contested_${label}`] = 0.6;
    } else if (zone.owner === Team.Axis) {
      weights[`axis_${label}`] = 1;
      weights[`contested_${label}`] = 0.6;
    }
  }
  return weights;
}

// ---------------------------------------------------------------------------
// Hardpoint
// ---------------------------------------------------------------------------

function stepHardpoint(
  world: WorldState,
  mode: GameModeDef,
  state: ObjectiveState,
  dt: number,
): void {
  if (state.zones.length === 0) return;

  const rotationTime = num(mode.params.rotationTime, 60);
  const rotationGap = num(mode.params.rotationGap, 5);

  state.rotationTimer -= dt;

  if (state.rotationTimer <= 0) {
    if (state.liveZone >= 0) {
      // Zone expires; a short gap resets the fight before the next one opens.
      state.zones[state.liveZone]!.active = false;
      state.zones[state.liveZone]!.owner = Team.None;
      state.liveZone = -1;
      state.rotationTimer = rotationGap;
      emit(SimEventType.ObjectiveNeutralized, {});
    } else {
      // Advance to the next zone in the authored rotation.
      const next = (findLastIndex(state.zones) + 1) % state.zones.length;
      state.liveZone = next;
      state.zones[next]!.active = true;
      state.zones[next]!.owner = Team.None;
      state.zones[next]!.tickAccum = 0;
      state.zones[next]!.activeTime = 0;
      state.rotationTimer = rotationTime;
      emit(SimEventType.RoundStart, { hardpoint: state.zones[next]!.def.label });
    }
    return;
  }

  if (state.liveZone < 0) return;
  const zone = state.zones[state.liveZone]!;
  zone.activeTime += dt;

  const { allies, axis } = refreshOccupants(world, zone);

  if (zone.contested) {
    // Contested pauses scoring entirely — holding the point means holding it
    // alone.
    emit(SimEventType.ObjectiveContested, { label: zone.def.label });
    return;
  }

  const holder = allies > 0 ? Team.Allies : axis > 0 ? Team.Axis : Team.None;

  if (holder !== Team.None && holder !== zone.owner) {
    zone.owner = holder;
    for (const id of zone.occupants) {
      addPlayerScore(id, mode.scoring.capture, 'capture');
    }
    emit(SimEventType.ObjectiveCaptured, { label: zone.def.label, team: holder });
  }

  if (zone.owner !== Team.None && holder === zone.owner) {
    zone.tickAccum += dt;
    while (zone.tickAccum >= mode.scoring.objectiveTickInterval) {
      zone.tickAccum -= mode.scoring.objectiveTickInterval;
      addTeamScore(zone.owner, mode.scoring.objectiveTick);
      state.totalTicks++;
      for (const id of zone.occupants) {
        addPlayerScore(id, mode.scoring.defend, 'hold');
      }
    }
  }
}

function findLastIndex(zones: ZoneState[]): number {
  for (let i = zones.length - 1; i >= 0; i--) {
    if (zones[i]!.activeTime > 0) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Headquarters
// ---------------------------------------------------------------------------

function stepHeadquarters(
  world: WorldState,
  mode: GameModeDef,
  state: ObjectiveState,
  dt: number,
): void {
  if (state.zones.length === 0) return;

  const captureTime = num(mode.params.captureTime, 8);
  const holdTime = num(mode.params.holdTime, 60);
  const respawnGap = num(mode.params.respawnGap, 8);

  if (state.liveZone < 0) {
    state.rotationTimer -= dt;
    if (state.rotationTimer <= 0) {
      const next = (findLastIndex(state.zones) + 1) % state.zones.length;
      state.liveZone = next;
      const zone = state.zones[next]!;
      zone.active = true;
      zone.owner = Team.None;
      zone.progress = 0;
      zone.activeTime = 0;
      zone.tickAccum = 0;
      emit(SimEventType.RoundStart, { hq: zone.def.label });
    }
    return;
  }

  const zone = state.zones[state.liveZone]!;
  zone.activeTime += dt;

  const { allies, axis } = refreshOccupants(world, zone);

  if (zone.owner === Team.None) {
    // Uncaptured: whoever is alone on it takes it.
    if (!zone.contested) {
      const taker = allies > 0 ? Team.Allies : axis > 0 ? Team.Axis : Team.None;
      if (taker !== Team.None) {
        const count = Math.max(allies, axis);
        zone.capturingTeam = taker;
        zone.progress = clamp01(zone.progress + (dt / captureTime) * (1 + (count - 1) * 0.5));
        for (const id of zone.occupants) zone.contributors.add(id);

        if (zone.progress >= 1) {
          zone.owner = taker;
          zone.progress = 0;
          zone.tickAccum = 0;
          for (const id of zone.contributors) {
            addPlayerScore(id, mode.scoring.capture, 'capture');
            const p = world.players.get(id);
            if (p) p.captures++;
          }
          zone.contributors.clear();
          emit(SimEventType.ObjectiveCaptured, { label: zone.def.label, team: taker });
        }
      } else {
        zone.progress = Math.max(0, zone.progress - dt / captureTime);
      }
    }
    return;
  }

  // Owned: tick score, and expire after the hold window.
  zone.tickAccum += dt;
  while (zone.tickAccum >= mode.scoring.objectiveTickInterval) {
    zone.tickAccum -= mode.scoring.objectiveTickInterval;
    addTeamScore(zone.owner, mode.scoring.objectiveTick);
    state.totalTicks++;
  }

  if (zone.activeTime > holdTime) {
    zone.active = false;
    zone.owner = Team.None;
    state.liveZone = -1;
    state.rotationTimer = respawnGap;
    emit(SimEventType.ObjectiveNeutralized, { label: zone.def.label });
  }
}

/**
 * Whether a player may respawn.
 *
 * Headquarters' defining rule: the team holding the HQ does not respawn, which
 * turns every capture into a countdown on your own numbers.
 */
export function respawnAllowed(
  mode: GameModeDef,
  state: ObjectiveState,
  player: PlayerState,
): boolean {
  if (mode.objectiveKind !== ObjectiveKind.Headquarters) return true;
  if (!num(mode.params.ownerRespawnDisabled, 1)) return true;
  if (state.liveZone < 0) return true;
  const zone = state.zones[state.liveZone]!;
  return zone.owner !== player.team;
}

// ---------------------------------------------------------------------------
// Search & Destroy
// ---------------------------------------------------------------------------

function stepSearchAndDestroy(
  world: WorldState,
  map: MapDef,
  mode: GameModeDef,
  state: ObjectiveState,
  dt: number,
): void {
  const bomb = state.bomb;
  const plantTime = num(mode.params.plantTime, 5);
  const defuseTime = num(mode.params.defuseTime, 7.5);

  if (bomb.resolved) return;

  if (bomb.planted) {
    bomb.timer -= dt;

    if (bomb.timer <= 0) {
      bomb.resolved = true;
      _result.roundWinner = bomb.attackers;
      emit(SimEventType.Explosion, { bomb: true });
      return;
    }

    // Defusing: a defender alone on the site.
    const site = state.zones[bomb.site];
    if (site) {
      refreshOccupants(world, site);
      const defenders = site.occupants
        .map((id) => world.players.get(id))
        .filter((p): p is PlayerState => !!p && p.team !== bomb.attackers);

      if (defenders.length > 0) {
        bomb.defusing = true;
        bomb.actor = defenders[0]!.id;
        bomb.progress = clamp01(bomb.progress + dt / defuseTime);
        if (bomb.progress >= 1) {
          bomb.resolved = true;
          bomb.planted = false;
          _result.roundWinner = opposingTeam(bomb.attackers);
          const p = world.players.get(bomb.actor);
          if (p) {
            p.defuses++;
            addPlayerScore(p.id, mode.scoring.defuse, 'defuse');
          }
          emit(SimEventType.BombDefused, { player: bomb.actor });
        }
      } else {
        // Interrupted defuses restart. Partial credit would remove the tension
        // that makes a defuse worth contesting.
        bomb.defusing = false;
        bomb.progress = 0;
      }
    }
    return;
  }

  // Not yet planted: an attacker alone on a site plants.
  let planting = false;
  for (let i = 0; i < state.zones.length; i++) {
    const site = state.zones[i]!;
    refreshOccupants(world, site);
    const attackers = site.occupants
      .map((id) => world.players.get(id))
      .filter((p): p is PlayerState => !!p && p.team === bomb.attackers);

    if (attackers.length === 0) continue;

    planting = true;
    bomb.actor = attackers[0]!.id;
    bomb.progress = clamp01(bomb.progress + dt / plantTime);

    if (bomb.progress >= 1) {
      bomb.planted = true;
      bomb.site = i;
      bomb.timer = num(mode.params.bombTimer, 45);
      bomb.progress = 0;
      const p = world.players.get(bomb.actor);
      if (p) {
        p.plants++;
        addPlayerScore(p.id, mode.scoring.plant, 'plant');
      }
      emit(SimEventType.BombPlanted, { site: site.def.label, player: bomb.actor });
    }
    break;
  }

  if (!planting) bomb.progress = 0;

  // Elimination: with no respawns, wiping a team ends the round.
  let attackersAlive = 0;
  let defendersAlive = 0;
  for (const player of world.players.values()) {
    if (!player.alive) continue;
    if (player.team === bomb.attackers) attackersAlive++;
    else defendersAlive++;
  }

  if (attackersAlive === 0 && !bomb.planted) {
    bomb.resolved = true;
    _result.roundWinner = opposingTeam(bomb.attackers);
  } else if (defendersAlive === 0) {
    bomb.resolved = true;
    _result.roundWinner = bomb.attackers;
  }

  void map;
}

/** Reset for a new Search & Destroy round, swapping sides at the half. */
export function resetRound(state: ObjectiveState, mode: GameModeDef, round: number): void {
  const swapAfter = num(mode.params.swapSidesAfterRound, 6);
  state.bomb = {
    planted: false,
    site: -1,
    timer: 0,
    progress: 0,
    actor: 0,
    defusing: false,
    resolved: false,
    attackers: round > swapAfter ? Team.Axis : Team.Allies,
  };
  for (const zone of state.zones) {
    zone.owner = zone.def.initialOwner ?? Team.None;
    zone.progress = 0;
    zone.capturingTeam = Team.None;
    zone.contested = false;
    zone.occupants.length = 0;
    zone.tickAccum = 0;
    zone.activeTime = 0;
    zone.contributors.clear();
  }
  state.tags.length = 0;
}

// ---------------------------------------------------------------------------
// Kill Confirmed
// ---------------------------------------------------------------------------

/** Drop a tag where a player died. Called by the sim on every kill. */
export function dropTag(
  state: ObjectiveState,
  victim: PlayerState,
  killer: PlayerId,
  lifetime: number,
): void {
  state.tags.push({
    id: state.nextTagId++,
    team: victim.team,
    position: { x: victim.position.x, y: victim.position.y + 0.3, z: victim.position.z },
    life: lifetime,
    victim: victim.id,
    killer,
  });
}

function stepKillConfirmed(
  world: WorldState,
  mode: GameModeDef,
  state: ObjectiveState,
  dt: number,
): void {
  const radius = num(mode.params.tagPickupRadius, 1.6);

  for (let i = state.tags.length - 1; i >= 0; i--) {
    const tag = state.tags[i]!;
    tag.life -= dt;
    if (tag.life <= 0) {
      state.tags.splice(i, 1);
      continue;
    }

    for (const player of world.players.values()) {
      if (!player.alive) continue;
      if (v3distance(player.position, tag.position) > radius) continue;

      const enemyTag = isEnemyTeam(player.team, tag.team);

      if (enemyTag) {
        // Confirm: the kill finally counts for the team.
        addTeamScore(player.team, 1);
        addPlayerScore(player.id, mode.scoring.confirm, 'confirm');
        // The original killer shares the credit, which is what stops confirming
        // from feeling like someone stealing your kill.
        if (tag.killer !== player.id) {
          addPlayerScore(tag.killer, Math.round(mode.scoring.confirm * 0.5), 'confirmed');
        }
        emit(SimEventType.TagCollected, { player: player.id, denied: false });
      } else {
        // Deny: your teammate's tag never becomes a point for the enemy.
        addPlayerScore(player.id, mode.scoring.deny, 'deny');
        emit(SimEventType.TagCollected, { player: player.id, denied: true });
      }

      state.tags.splice(i, 1);
      break;
    }
  }
}

// ---------------------------------------------------------------------------

function emit(type: SimEventType, data: Record<string, unknown>): void {
  _result.events.push({
    type,
    tick: 0,
    data,
  } as SimEvent);
}

// ---------------------------------------------------------------------------
// Queries for the HUD and the AI
// ---------------------------------------------------------------------------

/** Zones a team should be attacking right now, nearest-first for the caller. */
export function contestableZones(state: ObjectiveState, team: Team): ZoneState[] {
  return state.zones.filter((z) => z.active && z.owner !== team);
}

/** Zones a team owns and should be defending. */
export function ownedZones(state: ObjectiveState, team: Team): ZoneState[] {
  return state.zones.filter((z) => z.active && z.owner === team);
}

/** Compact snapshot for the HUD. */
export function objectiveSummary(state: ObjectiveState): Array<{
  label: string;
  owner: Team;
  progress: number;
  contested: boolean;
  active: boolean;
}> {
  return state.zones.map((z) => ({
    label: z.def.label,
    owner: z.owner,
    progress: z.progress,
    contested: z.contested,
    active: z.active,
  }));
}


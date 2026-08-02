/**
 * The Zombies mode.
 *
 * Rounds, the horde, the points economy, and everything you can spend points on.
 *
 * The mode's whole design rests on one loop: you are paid for shooting, you
 * spend that on being able to shoot better, and the round curve outruns you
 * anyway. Every number here is in service of keeping that treadmill honest —
 * hits pay so a bad starting pistol is survivable, doors are cheap early so you
 * are never trapped, and the genuinely powerful upgrades sit deep in the map so
 * that reaching them is the risk you are being asked to take.
 *
 * The director owns no simulation of its own. Zombies are ordinary players on
 * Team.Hostile driven through the normal input path, and every point of damage
 * in either direction goes through `GameSimulation.damagePlayer`, so friendly
 * fire, hitboxes, explosions and wallbangs all behave exactly as they do in
 * multiplayer.
 */

import { HEALTH } from '../constants.js';
import { clamp01, v3distance, vec3, type Vec3 } from '../math.js';
import { Rng } from '../rng.js';
import {
  MatchPhase,
  SimEventType,
  Stance,
  Team,
  WeaponSlot,
  type PlayerId,
  type PlayerState,
  type SimEvent,
} from '../types.js';
import type { GameSimulation } from '../sim/game.js';
import type { NavGraph } from '../ai/navigation.js';
import { createWeaponState } from '../sim/world.js';
import { getWeapon, tryGetWeapon, WEAPONS_BY_CLASS } from '../data/weapons.js';
import { WeaponClass, type WeaponDef } from '../data/weapon-types.js';
import type { MovementModifiers } from '../sim/movement.js';
import type { WeaponModifiers } from '../sim/weapon-system.js';

import {
  DOWN,
  InteractKind,
  MAX_ZOMBIE_PERKS,
  MYSTERY_BOX_COST,
  PACK_A_PUNCH_COST,
  POINTS,
  ROUND_CURVE,
  WALL_AMMO_MAGS,
  ZOMBIE_PERKS,
  spawnIntervalForRound,
  zombieCountForRound,
  zombieHealthForRound,
  zombieSpeedForRound,
  type InteractableDef,
  type ZombiesMapData,
} from './zombie-types.js';
import { ZOMBIE_MELEE_DAMAGE, ZombieDirectorAI } from './zombie-ai.js';

// ---------------------------------------------------------------------------

export enum RoundPhase {
  /** Between rounds. */
  Intermission = 'intermission',
  /** Zombies still spawning or alive. */
  Active = 'active',
  /** Everyone is down or dead. */
  GameOver = 'game_over',
}

export interface ZombiePlayerState {
  points: number;
  /** Points earned across the whole game, for the end screen. */
  totalEarned: number;
  perks: string[];
  downed: boolean;
  /** Seconds until bleed-out. */
  bleedOut: number;
  /** Progress being revived, 0..1. */
  reviveProgress: number;
  /** Who is currently reviving them. */
  reviver: PlayerId;
  /** Whether Quick Revive's self-revive has been spent. */
  selfReviveUsed: boolean;
  /** True once they have bled out and are staying down until the round ends. */
  bledOut: boolean;
  kills: number;
  downs: number;
  revives: number;
  /** Wall buys already owned, so a repeat purchase buys ammo instead. */
  ownedWallWeapons: Set<string>;
  /** Weapons that have been Pack-a-Punched. */
  upgraded: Set<string>;
}

export interface ZombiesState {
  round: number;
  phase: RoundPhase;
  /** Zombies still to spawn this round. */
  remainingToSpawn: number;
  /** Seconds until the next spawn. */
  spawnTimer: number;
  /** Seconds left of the between-round pause. */
  intermissionTimer: number;
  powerOn: boolean;
  openZones: Set<string>;
  /** How many rounds were survived, for the summary. */
  highestRound: number;
}

// ---------------------------------------------------------------------------

const _spawnPos = vec3();

export class ZombiesDirector {
  readonly state: ZombiesState;
  readonly players = new Map<PlayerId, ZombiePlayerState>();

  private readonly ai: ZombieDirectorAI;
  private readonly zombieIds = new Set<PlayerId>();
  private readonly events: SimEvent[] = [];
  private nextZombieName = 1;

  constructor(
    private readonly sim: GameSimulation,
    nav: NavGraph,
    private readonly rng: Rng,
    private readonly data: ZombiesMapData,
  ) {
    this.ai = new ZombieDirectorAI(nav, rng);

    this.state = {
      round: 0,
      phase: RoundPhase.Intermission,
      remainingToSpawn: 0,
      spawnTimer: 0,
      // A moment before the first round so players can read the map.
      intermissionTimer: 5,
      powerOn: false,
      openZones: new Set(
        data.zones.filter((z) => z.startingZone).map((z) => z.id),
      ),
      highestRound: 0,
    };

    // Zombies has no timer and no score limit; the match ends when the players do.
    sim.world.match.phase = MatchPhase.Live;
    sim.world.match.timeRemaining = 0;

    // Modifiers for perks and the downed state are applied through the sim's
    // hook rather than by mutating player state, so nothing here has to
    // second-guess what the weapon or movement systems already computed.
    sim.modifierHook = (player, move, weapon) => this.applyModifiers(player, move, weapon);
    sim.damageMultiplierHook = (attacker, weaponId) => this.damageMultiplier(attacker, weaponId);
  }

  // -------------------------------------------------------------------------
  // Players
  // -------------------------------------------------------------------------

  /** Register a human or bot survivor. */
  addSurvivor(player: PlayerState): void {
    this.players.set(player.id, {
      points: this.data.startingPoints,
      totalEarned: this.data.startingPoints,
      perks: [],
      downed: false,
      bleedOut: 0,
      reviveProgress: 0,
      reviver: 0,
      selfReviveUsed: false,
      bledOut: false,
      kills: 0,
      downs: 0,
      revives: 0,
      ownedWallWeapons: new Set(),
      upgraded: new Set(),
    });
    this.equipStartingLoadout(player);
  }

  private equipStartingLoadout(player: PlayerState): void {
    const pistol = tryGetWeapon(this.data.startingPistol) ?? getWeapon('p226');
    player.weapons = [];
    player.weapons[WeaponSlot.Primary] = createWeaponState(
      pistol.id,
      pistol.magSize,
      pistol.startingReserve,
    );
    player.activeSlot = WeaponSlot.Primary;
    player.maxHealth = HEALTH.max;
    player.health = HEALTH.max;
  }

  get survivors(): PlayerState[] {
    const out: PlayerState[] = [];
    for (const id of this.players.keys()) {
      const p = this.sim.world.players.get(id);
      if (p) out.push(p);
    }
    return out;
  }

  /** Survivors still on their feet. */
  get standing(): PlayerState[] {
    return this.survivors.filter((p) => p.alive && !this.players.get(p.id)!.downed);
  }

  // -------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------

  step(dt: number, simEvents: readonly SimEvent[]): SimEvent[] {
    this.events.length = 0;

    this.consumeSimEvents(simEvents);
    // Catch anyone who died from any source before deciding anything else.
    this.reconcileDowns();
    this.stepDowned(dt);

    if (this.state.phase === RoundPhase.GameOver) return this.events;

    // Zombies act, then their melee is applied through the normal damage path.
    const hits = this.ai.update(this.sim.world, dt, (id, cmd) => this.sim.setInput(id, cmd));
    for (const hit of hits) this.applyZombieMelee(hit.zombie, hit.victim);

    this.stepRound(dt);

    // Reconcile again: the zombie melee above lands inside this same tick, so a
    // player killed by it would otherwise be seen as dead-but-not-downed by the
    // game-over check a few lines later.
    this.reconcileDowns();
    this.checkGameOver();

    return this.events;
  }

  // -------------------------------------------------------------------------
  // Rounds
  // -------------------------------------------------------------------------

  private stepRound(dt: number): void {
    const s = this.state;

    if (s.phase === RoundPhase.Intermission) {
      s.intermissionTimer -= dt;
      if (s.intermissionTimer <= 0) this.beginRound();
      return;
    }

    // Spawn the wave gradually rather than all at once, so a round is a rising
    // tide instead of a single wall arriving.
    if (s.remainingToSpawn > 0) {
      s.spawnTimer -= dt;
      if (s.spawnTimer <= 0 && this.zombieIds.size < ROUND_CURVE.maxAlive) {
        this.spawnZombie();
        s.remainingToSpawn--;
        s.spawnTimer = spawnIntervalForRound(s.round);
      }
    }

    if (s.remainingToSpawn <= 0 && this.aliveZombies === 0) {
      this.endRound();
    }
  }

  private beginRound(): void {
    const s = this.state;
    s.round++;
    s.highestRound = Math.max(s.highestRound, s.round);
    s.phase = RoundPhase.Active;
    s.remainingToSpawn = zombieCountForRound(s.round, Math.max(1, this.survivors.length));
    s.spawnTimer = 0;

    this.emit(SimEventType.RoundStart, {
      round: s.round,
      zombies: s.remainingToSpawn,
      health: zombieHealthForRound(s.round),
    });
    this.emitAnnounce(`第${s.round}回合`);
  }

  private endRound(): void {
    const s = this.state;
    s.phase = RoundPhase.Intermission;
    s.intermissionTimer = ROUND_CURVE.intermission;

    for (const player of this.survivors) {
      this.award(player.id, POINTS.roundBonus, 'round_survived');

      // Anyone who bled out is back on their feet for the next round. Surviving
      // a round is the unit of progress, so losing a player mid-round should
      // cost that round, not the game.
      const zs = this.players.get(player.id);
      if (zs?.bledOut) {
        zs.bledOut = false;
        this.reviveNow(player, zs);
        this.equipStartingLoadout(player);
      }
    }

    this.emit(SimEventType.RoundEnd, { round: s.round });
  }

  private get aliveZombies(): number {
    let n = 0;
    for (const id of this.zombieIds) {
      const z = this.sim.world.players.get(id);
      if (z?.alive) n++;
    }
    return n;
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /**
   * Spawn a zombie in an open zone, preferring one away from the players.
   *
   * Spawning on top of somebody is not difficulty, it is an ambush the player
   * had no way to see coming — so points near a survivor are heavily penalised
   * without being banned outright, since on a small map they may be all there is.
   */
  private spawnZombie(): void {
    const candidates: Vec3[] = [];
    for (const zone of this.data.zones) {
      if (!this.state.openZones.has(zone.id)) continue;
      for (const point of zone.spawnPoints) candidates.push(point);
    }
    if (candidates.length === 0) return;

    const standing = this.standing;
    let best: Vec3 | null = null;
    let bestScore = -Infinity;

    for (const point of candidates) {
      let nearest = Infinity;
      for (const player of standing) {
        nearest = Math.min(nearest, v3distance(point, player.position));
      }
      // Sweet spot: far enough not to be an ambush, close enough to arrive soon.
      const score =
        nearest < 8 ? -100 + nearest : -Math.abs(nearest - 22) + this.rng.range(0, 6);
      if (score > bestScore) {
        bestScore = score;
        best = point;
      }
    }
    if (!best) return;

    const ground = this.sim.collision.groundHeightAt(best.x, best.z, best.y + 4, 12);
    _spawnPos.x = best.x;
    _spawnPos.y = Number.isFinite(ground) ? ground + 0.05 : best.y;
    _spawnPos.z = best.z;

    const zombie = this.sim.addPlayer({
      name: `Zombie ${this.nextZombieName++}`,
      team: Team.Hostile,
      isBot: true,
    });

    this.sim.spawnPlayer(zombie);
    zombie.position.x = _spawnPos.x;
    zombie.position.y = _spawnPos.y;
    zombie.position.z = _spawnPos.z;

    const health = zombieHealthForRound(this.state.round);
    zombie.maxHealth = health;
    zombie.health = health;
    // No weapons at all: `activeWeapon` returns undefined and the weapon system
    // exits immediately, so a zombie can never fire anything.
    zombie.weapons = [];

    this.zombieIds.add(zombie.id);
    this.ai.register(zombie.id, zombie.position);
  }

  // -------------------------------------------------------------------------
  // Damage in both directions
  // -------------------------------------------------------------------------

  private applyZombieMelee(zombieId: PlayerId, victimId: PlayerId): void {
    const victim = this.sim.world.players.get(victimId);
    const zombie = this.sim.world.players.get(zombieId);
    if (!victim || !zombie || !victim.alive) return;

    const zs = this.players.get(victimId);
    // A downed player is already out of the fight; letting zombies finish them
    // instantly removes any chance of a revive.
    if (zs?.downed) return;

    this.sim.damagePlayer(victim, {
      amount: ZOMBIE_MELEE_DAMAGE,
      attacker: zombie.id,
      victim: victim.id,
      cause: 7,
      weaponId: 'zombie',
      location: 'chest',
      position: vec3(victim.position.x, victim.position.y + 1, victim.position.z),
      direction: vec3(0, 0, 1),
      distance: v3distance(zombie.position, victim.position),
      ignoreArmor: false,
    });
  }

  /**
   * Turn the simulation's own events into points and downs.
   *
   * Reading events rather than hooking damage means the economy sees exactly
   * what the rest of the game saw, including wallbangs and explosion kills.
   */
  private consumeSimEvents(simEvents: readonly SimEvent[]): void {
    for (const event of simEvents) {
      // Damage events are emitted for EVERY source; Hit events only come from
      // the hitscan path. Paying on Damage means a grenade kill earns what a
      // rifle kill earns, which is what stops explosives being a dead end.
      if (event.type === SimEventType.Damage) {
        const victim = this.sim.world.players.get(event.victim);
        if (!victim || victim.team !== Team.Hostile) continue;
        if (!this.players.has(event.attacker)) continue;
        // The killing blow is paid for by the Kill event instead.
        if (victim.alive) this.award(event.attacker, POINTS.hit, 'hit');
        continue;
      }

      if (event.type === SimEventType.Kill) {
        const victim = this.sim.world.players.get(event.victim);
        if (!victim) continue;

        if (victim.team === Team.Hostile) {
          this.onZombieKilled(victim, event.killer, event.headshot, event.cause);
        } else if (this.players.has(victim.id)) {
          this.onSurvivorDown(victim);
        }
      }
    }
  }

  private onZombieKilled(
    zombie: PlayerState,
    killerId: PlayerId,
    headshot: boolean,
    cause: number,
  ): void {
    this.zombieIds.delete(zombie.id);
    this.ai.unregister(zombie.id);

    const zs = this.players.get(killerId);
    if (zs) {
      const award =
        cause === 2 ? POINTS.meleeKill : headshot ? POINTS.headshotKill : POINTS.kill;
      this.award(killerId, award, headshot ? 'headshot_kill' : 'kill');
      zs.kills++;
    }

    // Remove the corpse promptly; a zombies round leaves a lot of them.
    this.sim.removePlayer(zombie.id);
  }

  /**
   * A survivor reaching zero health goes DOWN rather than dying.
   *
   * This is the mechanic the whole co-op mode hangs off: a mistake costs you
   * your position and your perks, but it gives your team something to do about it.
   */
  private onSurvivorDown(player: PlayerState): void {
    const zs = this.players.get(player.id);
    if (!zs || zs.downed) return;

    // Quick Revive picks you up once when nobody else can.
    if (
      zs.perks.includes('quick_revive') &&
      !zs.selfReviveUsed &&
      this.standing.length === 0
    ) {
      zs.selfReviveUsed = true;
      this.reviveNow(player, zs);
      this.emitAnnounce('快速復活');
      return;
    }

    zs.downed = true;
    zs.downs++;
    zs.bleedOut = DOWN.bleedOutTime;
    zs.reviveProgress = 0;
    zs.reviver = 0;
    // Going down costs the perks — the punishment that makes them worth
    // protecting rather than a one-time purchase.
    zs.perks = [];

    // Back on their feet as a crawler with a pistol.
    player.alive = true;
    player.health = 1;
    player.maxHealth = HEALTH.max;
    player.respawnTimer = 0;
    player.stance = Stance.Prone;
    player.previousStance = Stance.Prone;
    player.stanceProgress = 1;
    this.equipStartingLoadout(player);
    player.health = 1;

    this.emit(SimEventType.Death, { player: player.id, downed: true });
    this.emitAnnounce(`${player.name}倒地`);
  }

  /**
   * Put down any survivor who is dead but not yet marked as such.
   *
   * Relying solely on the Kill event left a one-tick window — the player was
   * dead, the event had not been consumed yet, and `checkGameOver` ran inside
   * the gap and ended the game while they should have been crawling. Sweeping
   * state rather than reacting to an event makes this independent of the order
   * damage happens to be applied in, and covers sources that never emit a Kill
   * attributed to a survivor at all.
   */
  private reconcileDowns(): void {
    for (const [id, zs] of this.players) {
      const player = this.sim.world.players.get(id);
      if (!player) continue;
      if (player.alive || zs.downed || zs.bledOut) continue;
      this.onSurvivorDown(player);
    }
  }

  private stepDowned(dt: number): void {
    for (const [id, zs] of this.players) {
      if (!zs.downed) continue;
      const player = this.sim.world.players.get(id);
      if (!player) continue;

      zs.bleedOut -= dt;
      if (zs.bleedOut <= 0) {
        // Bled out. They stay out until the round ends, which is what makes a
        // failed revive actually cost something.
        zs.downed = false;
        zs.bledOut = true;
        player.alive = false;
        player.health = 0;
        player.respawnTimer = Infinity;
        this.emit(SimEventType.Death, { player: id, bledOut: true });
        continue;
      }

      // Someone standing and close enough picks them up.
      let reviver: PlayerState | null = null;
      for (const other of this.standing) {
        if (other.id === id) continue;
        if (v3distance(other.position, player.position) <= DOWN.reviveRadius) {
          reviver = other;
          break;
        }
      }

      if (!reviver) {
        // Interrupted revives reset. Partial credit would remove the tension of
        // reviving under fire, which is the best moment the mode has.
        zs.reviveProgress = 0;
        zs.reviver = 0;
        continue;
      }

      const reviverState = this.players.get(reviver.id);
      const speed = reviverState?.perks.includes('quick_revive')
        ? 1 / (ZOMBIE_PERKS.quick_revive!.reviveMult ?? 0.45)
        : 1;

      zs.reviver = reviver.id;
      zs.reviveProgress = clamp01(zs.reviveProgress + (dt / DOWN.reviveTime) * speed);

      if (zs.reviveProgress >= 1) {
        this.reviveNow(player, zs);
        this.award(reviver.id, POINTS.revive, 'revive');
        const rs = this.players.get(reviver.id);
        if (rs) rs.revives++;
        this.emitAnnounce(`${player.name}已救起`);
      }
    }
  }

  private reviveNow(player: PlayerState, zs: ZombiePlayerState): void {
    zs.downed = false;
    zs.bledOut = false;
    zs.bleedOut = 0;
    zs.reviveProgress = 0;
    zs.reviver = 0;
    player.alive = true;
    player.health = DOWN.reviveHealth;
    player.maxHealth = HEALTH.max;
    player.stance = Stance.Stand;
    player.previousStance = Stance.Stand;
    player.stanceProgress = 1;
  }

  private checkGameOver(): void {
    if (this.state.phase === RoundPhase.GameOver) return;
    if (this.players.size === 0) return;

    // Over when nobody is standing and nobody is still crawling.
    for (const [id, zs] of this.players) {
      const player = this.sim.world.players.get(id);
      if (!player) continue;
      if (zs.downed || (player.alive && !zs.downed)) return;
    }

    this.state.phase = RoundPhase.GameOver;
    this.emit(SimEventType.MatchStateChanged, {
      gameOver: true,
      round: this.state.round,
    });
    this.emitAnnounce(`撐過${this.state.highestRound}回合`);
  }

  // -------------------------------------------------------------------------
  // Modifiers
  // -------------------------------------------------------------------------

  /**
   * Fold perks, the downed state and zombie speed into the per-tick modifiers.
   *
   * Applied through the simulation's hook so nothing here duplicates the
   * movement or weapon systems' own maths.
   */
  private applyModifiers(
    player: PlayerState,
    move: MovementModifiers,
    weapon: WeaponModifiers,
  ): void {
    if (player.team === Team.Hostile) {
      // Zombie speed is a movement multiplier, so they still collide, slide off
      // walls and fail to climb exactly like a player would.
      const base = zombieSpeedForRound(this.state.round) / 4.6;
      move.speedMultiplier = base * this.ai.speedMultiplier(player.id);
      move.sprintBlocked = false;
      weapon.fireBlocked = true;
      return;
    }

    const zs = this.players.get(player.id);
    if (!zs) return;

    if (zs.downed) {
      move.speedMultiplier *= DOWN.crawlSpeedMult;
      move.slideBlocked = true;
      move.sprintBlocked = true;
      return;
    }

    for (const perkId of zs.perks) {
      const perk = ZOMBIE_PERKS[perkId];
      if (!perk) continue;
      if (perk.speedMult) move.speedMultiplier *= perk.speedMult;
      if (perk.reloadMult) weapon.reloadSpeedMult *= perk.reloadMult;
    }
  }

  /** Rate-of-fire multiplier from Double Tap, applied by the caller. */
  fireRateMultiplier(playerId: PlayerId): number {
    const zs = this.players.get(playerId);
    if (!zs) return 1;
    let mult = 1;
    for (const perkId of zs.perks) {
      const perk = ZOMBIE_PERKS[perkId];
      if (perk?.fireRateMult) mult *= perk.fireRateMult;
    }
    return mult;
  }

  // -------------------------------------------------------------------------
  // Economy
  // -------------------------------------------------------------------------

  private award(playerId: PlayerId, amount: number, reason: string): void {
    const zs = this.players.get(playerId);
    if (!zs || amount <= 0) return;
    zs.points += amount;
    zs.totalEarned += amount;
    this.emit(SimEventType.ScoreAwarded, { player: playerId, amount, reason });
  }

  private spend(playerId: PlayerId, amount: number): boolean {
    const zs = this.players.get(playerId);
    if (!zs || zs.points < amount) return false;
    zs.points -= amount;
    return true;
  }

  points(playerId: PlayerId): number {
    return this.players.get(playerId)?.points ?? 0;
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  /** The thing a player is close enough to use, with why they cannot. */
  interactableNear(playerId: PlayerId): {
    def: InteractableDef;
    usable: boolean;
    reason: string;
    cost: number;
  } | null {
    const player = this.sim.world.players.get(playerId);
    const zs = this.players.get(playerId);
    if (!player || !zs || zs.downed) return null;

    let best: InteractableDef | null = null;
    let bestDist = 3.0;
    for (const def of this.data.interactables) {
      const d = v3distance(player.position, def.position);
      if (d < bestDist) {
        bestDist = d;
        best = def;
      }
    }
    if (!best) return null;

    const cost = this.costOf(best, playerId);
    const reason = this.blockedReason(best, playerId, cost);
    return { def: best, usable: reason === '', reason, cost };
  }

  private costOf(def: InteractableDef, playerId: PlayerId): number {
    const zs = this.players.get(playerId);
    switch (def.kind) {
      case InteractKind.MysteryBox:
        return MYSTERY_BOX_COST;
      case InteractKind.PackAPunch:
        return PACK_A_PUNCH_COST;
      case InteractKind.PerkMachine:
        return ZOMBIE_PERKS[def.perkId ?? '']?.cost ?? 0;
      case InteractKind.WallBuy:
        // Second purchase of a gun you already carry is an ammo refill, and much
        // cheaper — otherwise a wall weapon is a one-shot novelty.
        return zs?.ownedWallWeapons.has(def.weaponId ?? '')
          ? (def.ammoCost ?? Math.round(def.cost * 0.4))
          : def.cost;
      default:
        return def.cost;
    }
  }

  private blockedReason(def: InteractableDef, playerId: PlayerId, cost: number): string {
    const zs = this.players.get(playerId);
    if (!zs) return 'unavailable';

    if (!this.state.openZones.has(def.zone)) return 'area locked';
    if (def.requiresPower && !this.state.powerOn) return 'needs power';
    if (def.kind === InteractKind.Door && this.state.openZones.has(def.opensZone ?? '')) {
      return 'already open';
    }
    if (def.kind === InteractKind.Power && this.state.powerOn) return 'already on';
    if (def.kind === InteractKind.PerkMachine) {
      if (zs.perks.includes(def.perkId ?? '')) return 'already owned';
      if (zs.perks.length >= MAX_ZOMBIE_PERKS) return 'no perk slots';
    }
    if (def.kind === InteractKind.PackAPunch) {
      const held = this.sim.world.players.get(playerId)?.weapons[
        this.sim.world.players.get(playerId)?.activeSlot ?? 0
      ];
      if (held && zs.upgraded.has(held.defId)) return 'already upgraded';
    }
    if (cost > 0 && zs.points < cost) return `need ${cost}`;
    return '';
  }

  /** Attempt to use whatever the player is standing at. */
  interact(playerId: PlayerId): { ok: boolean; message: string } {
    const near = this.interactableNear(playerId);
    if (!near) return { ok: false, message: '' };
    if (!near.usable) return { ok: false, message: near.reason };

    const player = this.sim.world.players.get(playerId);
    const zs = this.players.get(playerId);
    if (!player || !zs) return { ok: false, message: '' };

    const { def, cost } = near;
    if (cost > 0 && !this.spend(playerId, cost)) return { ok: false, message: 'not enough points' };

    // Anything below that returns ok:false must not have cost the player
    // anything. Charging for a purchase that did not happen is the single worst
    // bug an economy can have, so the refund is a backstop even though
    // blockedReason is supposed to have caught it already.
    const refundOnFailure = (result: { ok: boolean; message: string }) => {
      if (!result.ok && cost > 0) this.award(playerId, cost, 'refund');
      return result;
    };

    switch (def.kind) {
      case InteractKind.Door:
        if (def.opensZone) {
          this.state.openZones.add(def.opensZone);
          this.emit(SimEventType.ObjectiveCaptured, { zone: def.opensZone });
          this.emitAnnounce(`${this.zoneName(def.opensZone)}已開啟`);
        }
        return { ok: true, message: 'opened' };

      case InteractKind.Power:
        this.state.powerOn = true;
        this.emitAnnounce('電力已啟動');
        return { ok: true, message: 'power on' };

      case InteractKind.WallBuy:
        return refundOnFailure(this.buyWallWeapon(player, zs, def));

      case InteractKind.MysteryBox:
        return refundOnFailure(this.rollMysteryBox(player, zs));

      case InteractKind.PackAPunch:
        return refundOnFailure(this.packAPunch(player, zs));

      case InteractKind.PerkMachine:
        if (def.perkId) {
          zs.perks.push(def.perkId);
          this.applyPerkOnPurchase(player, def.perkId);
          this.emit(SimEventType.MedalEarned, { player: playerId, perk: def.perkId });
          return { ok: true, message: ZOMBIE_PERKS[def.perkId]?.name ?? 'perk' };
        }
        return { ok: false, message: '' };

      default:
        return { ok: false, message: '' };
    }
  }

  private applyPerkOnPurchase(player: PlayerState, perkId: string): void {
    const perk = ZOMBIE_PERKS[perkId];
    if (!perk) return;
    if (perk.healthMult) {
      // Juggernog raises the ceiling and tops you up, which is why it is the
      // first thing anyone buys.
      player.maxHealth = Math.round(HEALTH.max * perk.healthMult);
      player.health = player.maxHealth;
    }
  }

  private buyWallWeapon(
    player: PlayerState,
    zs: ZombiePlayerState,
    def: InteractableDef,
  ): { ok: boolean; message: string } {
    const weapon = tryGetWeapon(def.weaponId ?? '');
    if (!weapon) return { ok: false, message: '' };

    const owned = zs.ownedWallWeapons.has(weapon.id);
    const existing = player.weapons.find((w) => w?.defId === weapon.id);

    if (owned && existing) {
      existing.ammoReserve = Math.min(
        weapon.maxReserve,
        existing.ammoReserve + weapon.magSize * WALL_AMMO_MAGS,
      );
      return { ok: true, message: 'ammo' };
    }

    // Replace the weapon in hand rather than accumulating an arsenal — two
    // weapons is the whole inventory, and choosing between them is the point.
    const slot = player.weapons.length < 2 ? player.weapons.length : player.activeSlot;
    player.weapons[slot] = createWeaponState(
      weapon.id,
      weapon.magSize,
      weapon.startingReserve,
    );
    player.activeSlot = slot as WeaponSlot;
    zs.ownedWallWeapons.add(weapon.id);
    return { ok: true, message: weapon.name };
  }

  /**
   * The Mystery Box.
   *
   * Weighted away from the weakest guns so it is not a punishment, and away from
   * the very strongest so it is not a replacement for the wall buys. Everything
   * in the pool is at least a sidegrade to what a player can buy.
   */
  private rollMysteryBox(
    player: PlayerState,
    zs: ZombiePlayerState,
  ): { ok: boolean; message: string } {
    const pool: WeaponDef[] = [
      ...WEAPONS_BY_CLASS[WeaponClass.AssaultRifle],
      ...WEAPONS_BY_CLASS[WeaponClass.SubmachineGun],
      ...WEAPONS_BY_CLASS[WeaponClass.LightMachineGun],
      ...WEAPONS_BY_CLASS[WeaponClass.Shotgun],
      ...WEAPONS_BY_CLASS[WeaponClass.SniperRifle],
      ...WEAPONS_BY_CLASS[WeaponClass.MarksmanRifle],
      ...WEAPONS_BY_CLASS[WeaponClass.Launcher],
    ];
    if (pool.length === 0) return { ok: false, message: '' };

    const weights = pool.map((w) => {
      switch (w.class) {
        case WeaponClass.LightMachineGun:
          return 14; // The best zombies guns; still not guaranteed.
        case WeaponClass.Launcher:
          return 4; // Rare and situational.
        case WeaponClass.SniperRifle:
          return 6;
        default:
          return 10;
      }
    });

    const weapon = this.rng.pickWeighted(pool, weights);
    const slot = player.weapons.length < 2 ? player.weapons.length : player.activeSlot;
    player.weapons[slot] = createWeaponState(
      weapon.id,
      weapon.magSize,
      weapon.startingReserve,
    );
    player.activeSlot = slot as WeaponSlot;

    this.emit(SimEventType.MedalEarned, { player: player.id, box: weapon.id });
    void zs;
    return { ok: true, message: weapon.name };
  }

  /**
   * Pack-a-Punch: upgrade the weapon in your hands.
   *
   * Modelled as a straight damage and magazine multiplier rather than a
   * bespoke variant per gun, because the interesting decision is *whether* to
   * spend five thousand points, not which of thirty-six upgrade tables you get.
   */
  private packAPunch(
    player: PlayerState,
    zs: ZombiePlayerState,
  ): { ok: boolean; message: string } {
    const state = player.weapons[player.activeSlot];
    if (!state) return { ok: false, message: '' };
    if (zs.upgraded.has(state.defId)) return { ok: false, message: 'already upgraded' };

    zs.upgraded.add(state.defId);
    const base = tryGetWeapon(state.defId);
    if (base) {
      state.ammoInMag = Math.round(base.magSize * PAP_MAG_MULT);
      state.ammoReserve = Math.min(
        base.maxReserve * 2,
        Math.round(base.startingReserve * PAP_MAG_MULT),
      );
    }

    this.emit(SimEventType.MedalEarned, { player: player.id, packAPunch: state.defId });
    return { ok: true, message: 'upgraded' };
  }

  /** Damage multiplier for an upgraded weapon, read by the damage path. */
  damageMultiplier(playerId: PlayerId, weaponId: string): number {
    const zs = this.players.get(playerId);
    return zs?.upgraded.has(weaponId) ? PAP_DAMAGE_MULT : 1;
  }

  private zoneName(zoneId: string): string {
    return this.data.zones.find((z) => z.id === zoneId)?.name ?? zoneId;
  }

  // -------------------------------------------------------------------------

  private emit(type: SimEventType, data: Record<string, unknown>): void {
    this.events.push({ type, tick: this.sim.world.tick, data } as SimEvent);
  }

  private emitAnnounce(line: string): void {
    this.events.push({
      type: SimEventType.Announce,
      tick: this.sim.world.tick,
      team: Team.Allies,
      line,
    } as SimEvent);
  }

  dispose(): void {
    this.ai.clear();
    this.zombieIds.clear();
    this.players.clear();
    this.sim.modifierHook = null;
    this.sim.damageMultiplierHook = null;
  }
}

/** Pack-a-Punch multipliers. Big enough to matter, small enough to still lose. */
export const PAP_DAMAGE_MULT = 2.4;
export const PAP_MAG_MULT = 2;

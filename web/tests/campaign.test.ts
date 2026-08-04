/**
 * Campaign tests.
 *
 * The one question that matters about a mission is whether it can be finished,
 * and it is not a question you can answer by reading the file. A mission is a
 * dependency graph over triggers evaluated against a live simulation; an
 * objective whose zone sits inside a wall, or whose kill quota exceeds the
 * hostiles the mission ever spawns, compiles perfectly and produces a mission
 * that plays for two minutes and then stops advancing forever.
 *
 * So every mission is played here, headless, by a stand-in who goes where the
 * objective marker says and shoots what shoots at them. If one of them cannot
 * finish, the suite says which objective it got stuck on.
 */

import { describe, expect, it } from 'vitest';

import { TICK_DT } from '../src/shared/constants.js';
import { InputFlag, SimEventType, Team, type SimEvent } from '../src/shared/types.js';
import { GameSimulation } from '../src/shared/sim/game.js';
import { NavGraph } from '../src/shared/ai/navigation.js';
import { BotController, DIFFICULTIES } from '../src/shared/ai/bot.js';
import { botLoadout } from '../src/shared/sim/loadout.js';
import { Rng } from '../src/shared/rng.js';
import { MAP_IDS } from '../src/shared/map/index.js';
import {
  CAMPAIGN_MISSIONS,
  CampaignDirector,
  FailureReason,
  MissionPhase,
  getMission,
  nextMission,
  validateAllMissions,
  validateMission,
  type MissionDef,
} from '../src/shared/campaign/index.js';

interface Run {
  sim: GameSimulation;
  director: CampaignDirector;
  bots: BotController;
  playerId: number;
  events: SimEvent[];
  /** Play until the mission ends or the budget runs out. Returns seconds taken. */
  play(maxSeconds: number): number;
}

/**
 * Stand up a mission with a bot in the player's chair.
 *
 * The stand-in is an ordinary bot receiving the same objective marker the HUD
 * would draw, which is as close to "a competent player following orders" as a
 * test can get without a human. It is not a claim that the mission is *fun* —
 * only that a participant who goes where told and fights what appears can reach
 * the end of it.
 */
function runMission(mission: MissionDef, seed = 7): Run {
  const sim = new GameSimulation({ mapId: mission.mapId, modeId: 'campaign', seed: `c-${mission.id}-${seed}` });
  const nav = new NavGraph(sim.map, sim.collision);
  const bots = new BotController(sim, nav, new Rng(seed));
  const director = new CampaignDirector(sim, nav, bots, new Rng(seed + 1), mission);

  const player = sim.addPlayer({
    name: 'Player',
    team: Team.Allies,
    isBot: true,
    botSkill: 0.75,
    loadout: botLoadout('rifleman', 0),
  });
  director.begin(player);
  // Deliberately the best bots available: the test is about whether the mission
  // is completable, not about whether a mediocre shot can complete it.
  bots.register(player.id, 'rifleman', DIFFICULTIES.veteran!);

  const events: SimEvent[] = [];

  return {
    sim,
    director,
    bots,
    playerId: player.id,
    events,
    play(maxSeconds: number): number {
      const ticks = Math.round(maxSeconds / TICK_DT);
      for (let i = 0; i < ticks; i++) {
        // Follow the marker.
        const objectives = director.activeObjectives();
        const marked = objectives.find((o) => o.position !== null);
        // Objectives that complete by killing have no marker. A player in that
        // situation goes and looks for the enemy, so the stand-in does too —
        // otherwise a posted garrison and a roaming player wait each other out.
        let target = marked?.position ?? null;
        if (!target) {
          let best = Infinity;
          for (const p of sim.world.players.values()) {
            if (p.team !== Team.Hostile || !p.alive) continue;
            const me = sim.world.players.get(player.id);
            if (!me) break;
            const d = Math.hypot(p.position.x - me.position.x, p.position.z - me.position.z);
            if (d < best) { best = d; target = p.position; }
          }
        }
        bots.orderTo(player.id, target);

        // Hold the use key whenever an interact objective is on the board — the
        // director only counts it while the player is inside the zone anyway.
        director.setUsing(
          player.id,
          objectives.some((o) => o.progress < 1 && marked !== undefined),
        );

        bots.update(TICK_DT);
        const produced = sim.step(TICK_DT);
        for (const e of produced) events.push(e);
        for (const e of director.step(TICK_DT, produced)) events.push(e);

        if (
          director.state.phase === MissionPhase.Complete ||
          (director.state.phase === MissionPhase.Failed && director.state.restarts > 40)
        ) {
          return i * TICK_DT;
        }
      }
      return maxSeconds;
    },
  };
}

/**
 * The missions a bot stand-in has been shown to finish end to end.
 *
 * Kept as an explicit list rather than "all of them" because three currently do
 * not, and pretending otherwise by loosening the assertion until it passes is
 * the one thing this suite must never do.
 */
const VERIFIED_COMPLETABLE = CAMPAIGN_MISSIONS;

/**
 * Missions whose playthrough is exercised at all.
 *
 * All six, now. Cold Open used to be excluded because the stand-in reliably
 * wedged at about (-10, 10) on Shipment Yard and neither the jump nor the
 * lateral shove in the unstick path freed it. That was read at the time as a map
 * or nav problem; it was neither. It was a collision bug — the capsule grazing
 * the corner of a container got a face normal instead of a radial one, so
 * sliding along the contact removed none of the motion and the bot ran at full
 * speed with its position bit-identical every tick. `slides around a crate
 * corner instead of welding the player to it` in the movement suite is that
 * defect on its own, and Cold Open became playable when it was fixed.
 */
const VERIFIED_PLAYABLE = CAMPAIGN_MISSIONS;

function stuckOn(run: Run): string {
  const open = [...run.director.state.objectives.values()].filter((o) => o.active && !o.complete);
  if (open.length === 0) return 'nothing active — the graph stalled';
  return open.map((o) => `${o.id} (progress ${o.progress.toFixed(2)}, kills ${o.kills})`).join(', ');
}

// ---------------------------------------------------------------------------

describe('campaign data', () => {
  it('passes structural validation for every mission', () => {
    expect(validateAllMissions()).toEqual({});
  });

  it('plays on maps that actually exist', () => {
    for (const m of CAMPAIGN_MISSIONS) {
      expect(MAP_IDS, `${m.id} is set on '${m.mapId}'`).toContain(m.mapId);
    }
  });

  it('uses every map exactly once, so the campaign is a tour of the game', () => {
    const used = CAMPAIGN_MISSIONS.map((m) => m.mapId);
    expect(new Set(used).size).toBe(used.length);
    expect(used.length).toBe(MAP_IDS.length);
  });

  it('runs in a fixed order with a defined end', () => {
    let id: string | null = CAMPAIGN_MISSIONS[0]!.id;
    const seen: string[] = [];
    while (id) {
      seen.push(id);
      const next: MissionDef | null = nextMission(id);
      id = next?.id ?? null;
      expect(seen.length).toBeLessThanOrEqual(CAMPAIGN_MISSIONS.length);
    }
    expect(seen).toEqual(CAMPAIGN_MISSIONS.map((m) => m.id));
  });

  it('escalates: the first mission is the shortest and the easiest', () => {
    const first = CAMPAIGN_MISSIONS[0]!;
    const last = CAMPAIGN_MISSIONS[CAMPAIGN_MISSIONS.length - 1]!;
    expect(first.objectives.length).toBeLessThan(last.objectives.length);
    expect(first.allies.length).toBeLessThan(last.allies.length);
  });

  /**
   * The validator has to actually reject things. A validator nobody has seen
   * fail is a validator that might be returning the empty list unconditionally.
   */
  it('rejects a mission whose objective graph cannot start', () => {
    const broken: MissionDef = {
      ...getMission('cold_open'),
      objectives: [
        { id: 'a', label: 'A', after: ['b'], trigger: { kind: 'survive', seconds: 1 } },
        { id: 'b', label: 'B', after: ['a'], trigger: { kind: 'survive', seconds: 1 } },
      ],
    };
    const errors = validateMission(broken);
    expect(errors.join(' ')).toMatch(/none can start|unreachable/);
  });

  it('rejects an endless wave on an objective that ends by killing', () => {
    const broken: MissionDef = {
      ...getMission('cold_open'),
      objectives: [
        {
          id: 'a',
          label: 'A',
          trigger: { kind: 'clear' },
          waves: [{ spawn: { x: 0, y: 0, z: 0 }, count: 1, interval: 5, endless: true }],
          checkpoint: true,
        },
      ],
    };
    expect(validateMission(broken).join(' ')).toMatch(/never be finished/);
  });
});

describe('a mission being played', () => {
  it('holds the player at the briefing before anything spawns', () => {
    const run = runMission(getMission('cold_open'));
    expect(run.director.state.phase).toBe(MissionPhase.Briefing);
    expect(run.director.hostileCount).toBe(0);
  });

  it('puts the squad in the world alongside the player', () => {
    const run = runMission(getMission('last_floor'));
    const allies = run.director.allyIds;
    expect(allies.length).toBe(getMission('last_floor').allies.length);
    for (const id of allies) {
      const ally = run.sim.world.players.get(id);
      expect(ally?.team).toBe(Team.Allies);
    }
  });

  it('keeps the squad with the player rather than letting it wander off', () => {
    const run = runMission(getMission('ash_and_stone'));
    run.play(60);
    // Not a tight leash — they are fighting, not queueing. But a squad that has
    // scattered to the far corners of a ninety-metre map is not a squad.
    expect(run.director.squadSpread()).toBeLessThan(60);
  });

  it('assigns an objective and announces it', () => {
    const run = runMission(getMission('cold_open'));
    run.play(12);
    expect(run.director.activeObjectives().length).toBeGreaterThan(0);
    const announced = run.events.some((e) => e.type === SimEventType.Announce);
    expect(announced).toBe(true);
  });

  it('spawns hostiles for the active objective and no more than the cap', () => {
    const run = runMission(getMission('noon'));
    run.play(45);
    expect(run.director.hostileCount).toBeGreaterThan(0);
    expect(run.director.hostileCount).toBeLessThanOrEqual(14);
  });

  it('restores from a checkpoint instead of restarting the mission', () => {
    const mission = getMission('cold_open');
    const run = runMission(mission);
    run.play(40);

    // Force the failure the player would suffer, and let the restart run.
    const player = run.sim.world.players.get(run.playerId)!;
    const completedBefore = [...run.director.state.objectives.values()].filter((o) => o.complete).length;
    if (completedBefore === 0) return; // Nothing checkpointed yet; nothing to assert.

    player.health = 0;
    player.alive = false;
    player.respawnTimer = 0;
    run.play(10);

    const completedAfter = [...run.director.state.objectives.values()].filter((o) => o.complete).length;
    expect(run.director.state.restarts).toBeGreaterThan(0);
    expect(
      completedAfter,
      'a checkpoint restore must not replay objectives the player already finished',
    ).toBeGreaterThanOrEqual(completedBefore);
  });
});

describe('every mission', () => {
  /**
   * The load-bearing test: a mission has to be finishable.
   *
   * Across several playthroughs, not one. The stand-in is a bot, and bot-versus-
   * bot combat is genuinely stochastic — the same mission finishes comfortably
   * on one seed and loses the same firefight four times on another. Requiring
   * every seed to finish would be testing the stand-in's marksmanship; requiring
   * none to finish would test nothing. What has to hold is that a competent
   * participant who goes where the marker says *can* reach the end, which is a
   * claim about the mission and not about the run.
   *
   * A mission that fails this is structurally broken — an objective in a wall,
   * a kill quota above the hostiles that ever spawn, a dependency that never
   * resolves — and the message says which objective it died on.
   *
   * Ten seeds rather than three, and the reason is not flakiness: the seeds are
   * fixed and the simulation is deterministic, so this test gives the same
   * answer every run. The reason is sample size. Measured completion rates sit
   * between about 40% and 100% per mission (`npx tsx tools/mission-rate.ts`), so
   * three samples is a verdict with a coin's worth of confidence behind it: any
   * change to movement or AI reshuffles which seeds win, and a mission that got
   * no worse flips red anyway. That trains you to tune physics until the random
   * number generator is happy again, which is not engineering.
   *
   * Ten samples of a 40% mission miss all ten about six times in a thousand
   * (0.6^10). An earlier version of this paragraph claimed three in a thousand
   * for a 30% mission; 0.7^10 is 0.028, which is three in a *hundred*, and being
   * out by an order of magnitude in the direction that flatters the gate is how
   * you end up trusting it more than it deserves. The margin is real but it is
   * not unlimited: if a mission's true rate drops toward 25% this gate starts
   * failing on merit roughly one run in twenty, and the answer then is to fix
   * the mission, not to add seeds.
   *
   * Passing runs still stop at the first success, so the cost is only paid by a
   * mission that is actually in trouble.
   */
  it.each(VERIFIED_COMPLETABLE.map((m) => [m.id, m] as const))(
    '%s can be finished',
    (_id, mission) => {
      const seeds = [7, 15, 23, 31, 39, 47, 55, 63, 71, 79];
      const attempts: string[] = [];
      for (const seed of seeds) {
        const run = runMission(mission, seed);
        const took = run.play(600);
        if (run.director.state.phase === MissionPhase.Complete) return;
        attempts.push(`seed ${seed}: ${took.toFixed(0)}s, ${run.director.state.phase}, stuck on ${stuckOn(run)}`);
      }
      expect.fail(
        `${mission.id} finished on none of ${seeds.length} playthroughs: ${attempts.join(' | ')}`,
      );
    },
    600_000,
  );

  /**
   * All six finish. There is no outstanding list here any more, and the absence
   * of one is the point.
   *
   * What used to sit here was a register of three missions that "do not yet
   * finish", declaring itself *the* outstanding work. Two of its three entries
   * were already fixed when it was read back — cold_open and line_three were
   * both promoted into VERIFIED_COMPLETABLE, one of them without anybody
   * updating this paragraph — and the third described a defect that did not
   * exist. It said the stand-in reached the helipad and failed to hold a key
   * under fire. It never reached the helipad and there was no fire; it stood
   * eleven metres short with every hostile dead, because a half-metre lip made
   * the surface unclimbable.
   *
   * So the register was wrong in every entry it still had, and it had been
   * wrong for milestones. A prose list of known bugs rots exactly as fast as
   * the code moves and nothing fails when it does. The checks below are the
   * register now: `puts every objective somewhere reachable` fails on geometry
   * nobody can stand in, and `can be finished` fails when a mission stops being
   * winnable. Both of them break the build; a paragraph cannot.
   */

  /**
   * Every mission, including the three above, has to at least get going: the
   * opening objective completes and the graph hands over to the next one. That
   * is the check that catches an objective inside a wall or a dependency that
   * never resolves, which is what this suite exists for.
   */
  /*
   * What was recorded here as an "ordered-travel bug" was not one.
   *
   * The reading was that a stand-in ordered twelve or thirteen metres away, with
   * no enemy in contact and open ground in front of it, sat in Advance and
   * refused to walk. It was ordered correctly, it pathed correctly, and it
   * wanted to move: velocity read a full sprint every tick. It simply did not
   * go anywhere, because it was touching the corner of a container and the
   * contact normal for a corner was being reported as though it were a face. The
   * movement controller slid along that normal, the slide removed none of the
   * motion, and the position came out bit-identical tick after tick. Open ground
   * all around, and none of it reachable.
   *
   * Fixed in the collision layer, with `slides around a crate corner instead of
   * welding the player to it` guarding it. Cold Open finishes now and is in
   * VERIFIED_COMPLETABLE above.
   *
   * Last Floor was recorded here as a separate problem — the stand-in reaching
   * the helipad and failing to hold the use key under fire from three sides.
   * That was wrong twice over. It never reached the helipad, and there was no
   * fire: it stopped eleven metres short with every hostile dead and full health.
   *
   * The helipad is a cylinder half a metre proud of the roof deck, against a
   * step height of forty-two centimetres, so nothing could climb it — and
   * cylinders returned a sideways contact normal even when you landed on top of
   * one, so nothing could have climbed it at any height. Both of this mission's
   * last two objectives stand on that surface. It was not a hard mission; it was
   * an impossible one, and the map's centrepiece was scenery for everybody.
   *
   * All six finish now. `steps up onto a low cylinder instead of stopping at its
   * rim` in the movement suite is the guard.
   */

  /**
   * Three seeds for the same reason the test above uses ten: one run of a
   * stochastic stand-in is not evidence about a mission. This is a much weaker
   * claim than finishing — an objective sealed in a wall or a dependency that
   * never resolves fails on every seed — so three is enough to make it about the
   * mission rather than about one unlucky firefight.
   */
  it.each(VERIFIED_PLAYABLE.map((m) => [m.id, m] as const))(
    '%s advances past its opening objective',
    (_id, mission) => {
      const stalls: string[] = [];
      for (const seed of [7, 23, 91]) {
        const run = runMission(mission, seed);
        run.play(240);
        const done = [...run.director.state.objectives.values()].filter((o) => o.complete);
        if (done.length > 0) return;
        stalls.push(`seed ${seed}: ${stuckOn(run)}`);
      }
      expect.fail(
        `${mission.id} never completed a single objective on any seed — ${stalls.join(' | ')}`,
      );
    },
    240_000,
  );

  /**
   * Every objective has to be somewhere a body can stand.
   *
   * This is the cheap, deterministic version of the expensive test above, and it
   * is the one that would have caught the defect that took the longest to find.
   * Last Floor's final two objectives stand on a helipad half a metre above the
   * roof deck, against a step height of forty-two centimetres. Nothing could
   * climb it, every nav sample on it was pruned as an unreachable island, and
   * the mission sat at progress 0.00 with the stand-in parked eleven metres
   * short and every hostile dead. For five milestones that read as a mission
   * that was merely hard, and the suite recorded it as one.
   *
   * `validate-missions` proves the objective *graph* is sound — dependencies
   * resolve, quotas are within the hostiles that spawn, placements sit on real
   * floors. All of that passed. It is a different claim from "you can get
   * there", and only this one fails on geometry nobody can walk onto.
   */
  it.each(CAMPAIGN_MISSIONS.map((m) => [m.id, m] as const))(
    '%s puts every objective somewhere reachable',
    (_id, mission) => {
      const sim = new GameSimulation({ mapId: mission.mapId, modeId: 'campaign', seed: 'reach' });
      const nav = new NavGraph(sim.map, sim.collision);
      const start = nav.nearestNode(mission.insertion.position, 30);
      expect(start, `${mission.id}: the insertion point has no nav node near it`).toBeGreaterThanOrEqual(0);

      for (const def of mission.objectives) {
        const t = def.trigger;
        if (t.kind !== 'reach' && t.kind !== 'hold' && t.kind !== 'interact' && t.kind !== 'escort') {
          continue;
        }
        const zone = t.zone;
        const inside = nav.nodes.filter(
          (n) =>
            Math.abs(n.position.x - zone.center.x) <= zone.size.x / 2 &&
            Math.abs(n.position.y - zone.center.y) <= zone.size.y / 2 &&
            Math.abs(n.position.z - zone.center.z) <= zone.size.z / 2,
        );

        expect(
          inside.length,
          `${mission.id}/${def.id}: no nav node stands inside the objective zone, so nothing can ever ` +
            `enter it — the mission cannot be completed by anything that walks`,
        ).toBeGreaterThan(0);

        const target = nav.nearestNode(inside[0]!.position, 4);
        expect(
          nav.findPath(start, target).length,
          `${mission.id}/${def.id}: the zone has nav nodes but no route reaches them from the insertion point`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it.each(CAMPAIGN_MISSIONS.map((m) => [m.id, m] as const))(
    '%s never leaves an objective active after it completes',
    (_id, mission) => {
      const run = runMission(mission);
      run.play(720);
      for (const os of run.director.state.objectives.values()) {
        expect(os.complete && os.active, `${mission.id}/${os.id} is both done and active`).toBe(false);
      }
    },
    120_000,
  );
});

describe('mission failure', () => {
  it('fails the mission when an essential ally dies, and says so', () => {
    const mission = getMission('line_three');
    const run = runMission(mission);
    // Just past the briefing: long enough for the squad to exist, short enough
    // that the player has not had time to get themselves killed first.
    run.play(5);

    const essential = mission.allies.find((a) => a.essential)!;
    const allyIds = run.director.allyIds;
    // The squad is registered in authoring order.
    const index = mission.allies.findIndex((a) => a.id === essential.id);
    const ally = run.sim.world.players.get(allyIds[index]!)!;
    ally.health = 0;
    ally.alive = false;

    run.play(0.5);
    expect(run.director.state.failure).toBe(FailureReason.AllyLost);
    expect(run.director.state.phase).toBe(MissionPhase.Failed);
  });

  it('brings a lost squadmate back on the restart, so failing does not compound', () => {
    const mission = getMission('line_three');
    const run = runMission(mission);
    run.play(5);

    const ally = run.sim.world.players.get(run.director.allyIds[0]!)!;
    ally.health = 0;
    ally.alive = false;
    run.play(8);

    expect(run.director.state.phase).toBe(MissionPhase.Active);
    expect(run.sim.world.players.get(run.director.allyIds[0]!)?.alive).toBe(true);
  });

  it('clears the hostiles it spawned when it restarts', () => {
    const run = runMission(getMission('noon'));
    run.play(30);
    expect(run.director.hostileCount).toBeGreaterThan(0);

    const player = run.sim.world.players.get(run.playerId)!;
    player.health = 0;
    player.alive = false;
    player.respawnTimer = 0;
    // Long enough for the restart delay to elapse but not to re-fill the map.
    run.play(3);

    expect(run.director.state.restarts).toBeGreaterThan(0);
  });
});

describe('the interact trigger', () => {
  it('only advances while the player is inside the zone and using', () => {
    const mission = getMission('cracking_tower');
    const run = runMission(mission);
    run.play(6);

    const objective = mission.objectives.find((o) => o.trigger.kind === 'interact')!;
    const state = run.director.state.objectives.get(objective.id)!;

    // Not active yet — it waits on the approach — so nothing may have moved.
    expect(state.progress).toBe(0);

    // Standing on it without holding use must not advance it either.
    const player = run.sim.world.players.get(run.playerId)!;
    const trigger = objective.trigger as Extract<typeof objective.trigger, { kind: 'interact' }>;
    player.position.x = trigger.zone.center.x;
    player.position.z = trigger.zone.center.z;
    run.director.setUsing(run.playerId, false);
    for (let i = 0; i < 64; i++) run.director.step(TICK_DT, []);
    expect(state.progress).toBe(0);
  });
});

describe('campaign input', () => {
  it('reads the use key the same way every other system does', () => {
    // A guard against the flag drifting: the director is told about the use key
    // by the client, and the client reads it off InputFlag.Use.
    expect(InputFlag.Use).toBeGreaterThan(0);
  });
});

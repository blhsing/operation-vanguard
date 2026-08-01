/**
 * Map registry and validation.
 *
 * `validateMap` runs in the test suite over every registered map. It exists
 * because level-design mistakes are the class of bug that is invisible until a
 * player is standing inside a wall in a live match — and because maps are hand
 * authored as data, a typo in a coordinate produces no compile error at all.
 */

import { PLAYER_RADIUS, STANCE_HEIGHT } from '../constants.js';
import { vec3, type Vec3 } from '../math.js';
import { Team } from '../types.js';
import { BrushCollisionWorld } from '../collision/brush-collision.js';
import { CollisionLayer, type QueryFilter } from '../collision/collision-types.js';
import type { MapDef } from './map-types.js';

import { CROSSFIRE } from './maps/crossfire.js';

export const MAPS: Record<string, MapDef> = {
  [CROSSFIRE.id]: CROSSFIRE,
};

export const MAP_IDS: string[] = Object.keys(MAPS);

export function getMap(id: string): MapDef {
  const m = MAPS[id];
  if (!m) throw new Error(`Unknown map id: ${id}`);
  return m;
}

export function tryGetMap(id: string): MapDef | undefined {
  return MAPS[id];
}

export const DEFAULT_MAP = CROSSFIRE.id;

/** Maps that declare support for a mode (an empty list means "all modes"). */
export function mapsForMode(modeId: string): MapDef[] {
  return Object.values(MAPS).filter(
    (m) => !m.supportedModes || m.supportedModes.length === 0 || m.supportedModes.includes(modeId),
  );
}

/** Maps sized for a given player count, falling back to everything. */
export function mapsForPlayerCount(count: number): MapDef[] {
  const fits = Object.values(MAPS).filter(
    (m) => count >= m.playerCount[0] && count <= m.playerCount[1],
  );
  return fits.length > 0 ? fits : Object.values(MAPS);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SPAWN_FILTER: QueryFilter = { layers: CollisionLayer.Movement };

function inBounds(p: Vec3, bounds: MapDef['bounds'], margin = 0): boolean {
  return (
    p.x >= bounds.min.x - margin &&
    p.x <= bounds.max.x + margin &&
    p.z >= bounds.min.z - margin &&
    p.z <= bounds.max.z + margin &&
    p.y >= bounds.min.y - margin &&
    p.y <= bounds.max.y + margin
  );
}

/**
 * Check a map for the mistakes that actually happen when authoring level data.
 * Returns a list of human-readable problems; empty means the map is sound.
 *
 * The spawn checks build a real collision world and run real queries rather than
 * approximating with AABBs, because "is there floor under this point and room for
 * a player to stand" is precisely the question the game asks at spawn time.
 */
export function validateMap(map: MapDef): string[] {
  const errors: string[] = [];
  const tag = map.id;

  if (map.brushes.length === 0) {
    errors.push(`${tag}: has no geometry`);
    return errors;
  }

  if (map.bounds.min.x >= map.bounds.max.x || map.bounds.min.z >= map.bounds.max.z) {
    errors.push(`${tag}: bounds are inverted or degenerate`);
    return errors;
  }

  const collision = new BrushCollisionWorld(map.brushes, map.bounds);

  // --- spawns -------------------------------------------------------------
  const alliedSpawns = map.spawns.filter((s) => s.team === Team.Allies);
  const axisSpawns = map.spawns.filter((s) => s.team === Team.Axis);
  const neutralSpawns = map.spawns.filter((s) => s.team === Team.None);

  if (alliedSpawns.length < 8) {
    errors.push(`${tag}: only ${alliedSpawns.length} Allied spawns, want at least 8`);
  }
  if (axisSpawns.length < 8) {
    errors.push(`${tag}: only ${axisSpawns.length} Axis spawns, want at least 8`);
  }
  if (neutralSpawns.length < 4) {
    errors.push(`${tag}: only ${neutralSpawns.length} neutral spawns for free-for-all, want 4+`);
  }

  let blockedSpawns = 0;
  let floatingSpawns = 0;
  let outOfBoundsSpawns = 0;

  for (const spawn of map.spawns) {
    if (!inBounds(spawn.position, map.bounds)) {
      outOfBoundsSpawns++;
      if (outOfBoundsSpawns <= 3) {
        errors.push(
          `${tag}: spawn '${spawn.group}' at (${spawn.position.x}, ${spawn.position.z}) is outside bounds`,
        );
      }
      continue;
    }

    // There must be ground beneath it, within a short drop.
    const groundY = collision.groundHeightAt(
      spawn.position.x,
      spawn.position.z,
      spawn.position.y + 3,
      12,
    );
    if (!Number.isFinite(groundY)) {
      floatingSpawns++;
      if (floatingSpawns <= 3) {
        errors.push(
          `${tag}: spawn '${spawn.group}' at (${spawn.position.x}, ${spawn.position.z}) has no ground beneath it`,
        );
      }
      continue;
    }

    // And a standing player must fit there.
    const feet = vec3(spawn.position.x, groundY + 0.05, spawn.position.z);
    if (!collision.isCapsuleFree(feet, STANCE_HEIGHT.stand, PLAYER_RADIUS, SPAWN_FILTER)) {
      blockedSpawns++;
      if (blockedSpawns <= 5) {
        errors.push(
          `${tag}: spawn '${spawn.group}' at (${spawn.position.x}, ${spawn.position.z}) is inside geometry`,
        );
      }
    }
  }

  if (blockedSpawns > 5) errors.push(`${tag}: ...and ${blockedSpawns - 5} more blocked spawns`);
  if (floatingSpawns > 3) errors.push(`${tag}: ...and ${floatingSpawns - 3} more floating spawns`);

  // --- objectives ---------------------------------------------------------
  const byKind = new Map<string, Set<string>>();
  for (const obj of map.objectives) {
    let labels = byKind.get(obj.kind);
    if (!labels) {
      labels = new Set();
      byKind.set(obj.kind, labels);
    }
    if (labels.has(obj.label)) {
      errors.push(`${tag}: duplicate objective label '${obj.label}' for kind '${obj.kind}'`);
    }
    labels.add(obj.label);

    if (!inBounds(obj.position, map.bounds)) {
      errors.push(`${tag}: objective '${obj.label}' (${obj.kind}) is outside bounds`);
    }
    if (obj.size.x <= 0 || obj.size.y <= 0 || obj.size.z <= 0) {
      errors.push(`${tag}: objective '${obj.label}' has a non-positive size`);
    }
  }

  const domFlags = map.objectives.filter((o) => o.kind === 'dom_flag');
  if (domFlags.length !== 0 && domFlags.length !== 3) {
    errors.push(`${tag}: Domination needs exactly 3 flags, found ${domFlags.length}`);
  }
  const bombSites = map.objectives.filter((o) => o.kind === 'bomb_site');
  if (bombSites.length !== 0 && bombSites.length !== 2) {
    errors.push(`${tag}: Search & Destroy needs exactly 2 bomb sites, found ${bombSites.length}`);
  }
  const hardpoints = map.objectives.filter((o) => o.kind === 'hardpoint');
  if (hardpoints.length > 0) {
    if (hardpoints.length < 3) {
      errors.push(`${tag}: Hardpoint rotation needs at least 3 zones, found ${hardpoints.length}`);
    }
    const orders = hardpoints.map((h) => h.order ?? -1).sort((a, b) => a - b);
    for (let i = 0; i < orders.length; i++) {
      if (orders[i] !== i) {
        errors.push(`${tag}: Hardpoint zone orders must be 0..n-1 with no gaps, got [${orders}]`);
        break;
      }
    }
  }

  // --- lanes --------------------------------------------------------------
  if (map.lanes.length < 2) {
    errors.push(`${tag}: needs at least 2 lanes to describe its layout`);
  }
  for (const lane of map.lanes) {
    if (lane.path.length < 2) {
      errors.push(`${tag}: lane '${lane.name}' needs at least 2 waypoints`);
    }
    for (const p of lane.path) {
      if (!inBounds(p, map.bounds, 2)) {
        errors.push(`${tag}: lane '${lane.name}' has a waypoint outside bounds`);
        break;
      }
    }
  }

  // --- cover --------------------------------------------------------------
  if (map.coverPoints.length < 20) {
    errors.push(
      `${tag}: only ${map.coverPoints.length} cover points — bots will look lost with fewer than 20`,
    );
  }
  for (const c of map.coverPoints) {
    if (c.exposure < 0 || c.exposure > 1) {
      errors.push(`${tag}: cover point at (${c.position.x}, ${c.position.z}) has exposure outside 0..1`);
      break;
    }
  }

  // --- nav links ----------------------------------------------------------
  for (const link of map.navLinks) {
    if (!inBounds(link.from, map.bounds, 2) || !inBounds(link.to, map.bounds, 2)) {
      errors.push(`${tag}: nav link from (${link.from.x}, ${link.from.z}) leaves the map`);
      break;
    }
    if (link.cost <= 0) {
      errors.push(`${tag}: nav link has a non-positive cost`);
      break;
    }
  }

  // --- geometry containment ------------------------------------------------
  let outside = 0;
  for (const brush of map.brushes) {
    if (!inBounds(brush.position, map.bounds, 4)) outside++;
  }
  if (outside > 0) {
    errors.push(`${tag}: ${outside} brushes sit outside the declared bounds`);
  }

  return errors;
}

/** Validate every registered map at once. Used by the test suite and by CI. */
export function validateAllMaps(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, map] of Object.entries(MAPS)) {
    const errs = validateMap(map);
    if (errs.length > 0) out[id] = errs;
  }
  return out;
}

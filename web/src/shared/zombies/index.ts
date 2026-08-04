/**
 * Zombies map registry.
 *
 * Zombie layouts are keyed by the multiplayer map they are built on, so a map
 * can be used for both without carrying data the other mode never reads.
 */

import type { ZombiesMapData } from './zombie-types.js';
import { CROSSFIRE_ZOMBIES } from './maps/crossfire-zombies.js';

export const ZOMBIES_MAPS: Record<string, ZombiesMapData> = {
  [CROSSFIRE_ZOMBIES.mapId]: CROSSFIRE_ZOMBIES,
};

export const ZOMBIES_MAP_IDS: string[] = Object.keys(ZOMBIES_MAPS);

export function getZombiesMap(mapId: string): ZombiesMapData {
  const data = ZOMBIES_MAPS[mapId];
  if (!data) throw new Error(`No zombies layout for map: ${mapId}`);
  return data;
}

export function hasZombiesLayout(mapId: string): boolean {
  return mapId in ZOMBIES_MAPS;
}

export * from './zombie-types.js';
export { ZombiesDirector, RoundPhase } from './zombies.js';
export type { ZombiePlayerState, ZombiesState } from './zombies.js';

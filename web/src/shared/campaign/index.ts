/**
 * The campaign: six missions across the six maps, in order.
 *
 * Missions are validated in the test suite the same way maps are, because they
 * are the same kind of thing — hand-authored data where a typo compiles cleanly
 * and produces a mission that plays for ninety seconds and then never advances.
 */

import { validateMission, validateMissionGeometry, type MissionDef } from './campaign-types.js';

import { COLD_OPEN } from './missions/01-cold-open.js';
import { ASH_AND_STONE } from './missions/02-crossfire.js';
import { CRACKING_TOWER } from './missions/03-refinery.js';
import { LINE_THREE } from './missions/04-subway.js';
import { NOON } from './missions/05-dust-market.js';
import { LAST_FLOOR } from './missions/06-highrise.js';

/** In the order they are meant to be played. */
export const CAMPAIGN_MISSIONS: MissionDef[] = [
  COLD_OPEN,
  ASH_AND_STONE,
  CRACKING_TOWER,
  LINE_THREE,
  NOON,
  LAST_FLOOR,
];

export const MISSIONS: Record<string, MissionDef> = Object.fromEntries(
  CAMPAIGN_MISSIONS.map((m) => [m.id, m]),
);

export const MISSION_IDS: string[] = CAMPAIGN_MISSIONS.map((m) => m.id);

export function getMission(id: string): MissionDef {
  const m = MISSIONS[id];
  if (!m) throw new Error(`Unknown mission id: ${id}`);
  return m;
}

export function tryGetMission(id: string): MissionDef | undefined {
  return MISSIONS[id];
}

/** The mission after this one, or null at the end of the campaign. */
export function nextMission(id: string): MissionDef | null {
  const i = CAMPAIGN_MISSIONS.findIndex((m) => m.id === id);
  return i >= 0 && i + 1 < CAMPAIGN_MISSIONS.length ? CAMPAIGN_MISSIONS[i + 1]! : null;
}

/** Validate every mission at once. Used by the test suite and by CI. */
export function validateAllMissions(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of CAMPAIGN_MISSIONS) {
    const errs = validateMission(m);
    if (errs.length > 0) out[m.id] = errs;
  }
  return out;
}

export { CampaignDirector, type MissionState } from './campaign.js';
export {
  CAMPAIGN,
  FailureReason,
  MissionPhase,
  validateMission,
  validateMissionGeometry,
  type AllySpec,
  type CampaignHudObjective,
  type MissionDef,
  type Objective,
  type ObjectiveState,
  type Trigger,
  type Wave,
  type Zone,
} from './campaign-types.js';

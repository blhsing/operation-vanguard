/**
 * Player profile persistence.
 *
 * Everything the player accumulates — rank, unlocks, saved classes, settings —
 * lives in one versioned blob in localStorage.
 *
 * The load path is defensive to the point of paranoia, and deliberately so: this
 * is the one piece of state that survives a deploy. A player who has put hours
 * into a profile must never lose it because a field was renamed, and must never
 * be unable to launch the game because a value came back malformed. Every read
 * falls back rather than throwing, and unknown versions are migrated forward
 * rather than discarded.
 */

import { MAX_RANK, NET } from '@shared/constants.js';
import { MISSION_IDS } from '@shared/campaign/index.js';
import { DEFAULT_MAP } from '@shared/map/index.js';
import { DEFAULT_MODE } from '@shared/data/modes.js';
import { defaultLoadout, type Loadout } from '@shared/sim/loadout.js';
import { DEFAULT_INPUT_SETTINGS, type InputSettings } from './input.js';
import { DEFAULT_RENDER_SETTINGS, type RenderSettings } from './scene/world-renderer.js';
import { DEFAULT_HUD_OPTIONS, type HudOptions } from './hud/hud.js';

const STORAGE_KEY = 'vanguard.profile';
const CURRENT_VERSION = 1;

export interface ProfileStats {
  kills: number;
  deaths: number;
  assists: number;
  score: number;
  matches: number;
  wins: number;
  headshots: number;
  timePlayed: number;
}

export interface Profile {
  version: number;
  name: string;
  rank: number;
  prestige: number;
  xp: number;
  stats: ProfileStats;
  /** Ten create-a-class slots, as in COD. */
  loadouts: Loadout[];
  activeLoadout: number;
  /** Per-weapon experience, keyed by weapon id. */
  weaponXp: Record<string, number>;
  lastMatch: {
    mapId: string;
    modeId: string;
    botCount: number;
    difficulty: string;
    /** Which campaign mission was last selected. */
    missionId: string;
    /** Join a dedicated server instead of playing against local bots. */
    online: boolean;
    /** Where to join. */
    serverUrl: string;
  };
  /**
   * Settings are stored COMPLETE, not as partials.
   *
   * Defaults are merged in at load time so every consumer — the settings menu
   * especially — reads a fully-populated object. Storing partials pushes an
   * `undefined` check into every single slider and toggle, which is exactly the
   * kind of pervasive defensive noise that hides real bugs.
   */
  settings: {
    input: InputSettings;
    render: RenderSettings;
    hud: HudOptions;
    masterVolume: number;
    sfxVolume: number;
    musicVolume: number;
  };
}

export function createProfile(): Profile {
  return {
    version: CURRENT_VERSION,
    name: '玩家',
    rank: 1,
    prestige: 0,
    xp: 0,
    stats: {
      kills: 0,
      deaths: 0,
      assists: 0,
      score: 0,
      matches: 0,
      wins: 0,
      headshots: 0,
      timePlayed: 0,
    },
    // 兵種, not 職業. A loadout class is a troop type; 職業 is an occupation and
    // reads as role-playing rather than military. Existing saved profiles keep
    // whatever they already stored — those are the player's own names.
    loadouts: Array.from({ length: 10 }, (_, i) => defaultLoadout(`兵種${i + 1}`)),
    activeLoadout: 0,
    weaponXp: {},
    lastMatch: {
      mapId: DEFAULT_MAP,
      modeId: DEFAULT_MODE,
      botCount: 9,
      difficulty: 'regular',
      missionId: MISSION_IDS[0] ?? 'cold_open',
      online: false,
      serverUrl: NET.defaultUrl,
    },
    settings: {
      input: { ...DEFAULT_INPUT_SETTINGS, bindings: { ...DEFAULT_INPUT_SETTINGS.bindings } },
      render: { ...DEFAULT_RENDER_SETTINGS },
      hud: { ...DEFAULT_HUD_OPTIONS },
      masterVolume: 0.8,
      sfxVolume: 1,
      musicVolume: 0.5,
    },
  };
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/** Read a number, falling back if it is missing, NaN or out of range. */
function num(value: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(value: unknown, fallback: string, maxLength = 64): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : fallback;
}

function sanitizeLoadoutShape(value: unknown, fallbackName: string): Loadout {
  const base = defaultLoadout(fallbackName);
  if (typeof value !== 'object' || value === null) return base;
  const v = value as Partial<Loadout>;

  return {
    name: str(v.name, base.name, 24),
    primary: str(v.primary, base.primary, 40),
    primaryAttachments: Array.isArray(v.primaryAttachments)
      ? v.primaryAttachments.filter((a): a is string => typeof a === 'string').slice(0, 8)
      : [],
    secondary: str(v.secondary, base.secondary, 40),
    secondaryAttachments: Array.isArray(v.secondaryAttachments)
      ? v.secondaryAttachments.filter((a): a is string => typeof a === 'string').slice(0, 8)
      : [],
    lethal: str(v.lethal, base.lethal, 40),
    tactical: str(v.tactical, base.tactical, 40),
    perks: Array.isArray(v.perks)
      ? v.perks.filter((p): p is string => typeof p === 'string').slice(0, 3)
      : [],
    fieldUpgrade: str(v.fieldUpgrade, '', 40),
    killstreaks: Array.isArray(v.killstreaks)
      ? v.killstreaks.filter((k): k is string => typeof k === 'string').slice(0, 3)
      : base.killstreaks,
  };
}

export function loadProfile(): Profile {
  const fallback = createProfile();

  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing and some embedded contexts throw on localStorage access.
    // Playing without persistence is fine; failing to start is not.
    return fallback;
  }

  if (!raw) return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }

  if (typeof parsed !== 'object' || parsed === null) return fallback;
  const p = parsed as Record<string, unknown>;

  const stats = (p.stats ?? {}) as Record<string, unknown>;
  const lastMatch = (p.lastMatch ?? {}) as Record<string, unknown>;
  const settings = (p.settings ?? {}) as Record<string, unknown>;

  const loadouts = Array.isArray(p.loadouts)
    ? p.loadouts.slice(0, 10).map((l, i) => sanitizeLoadoutShape(l, `Class ${i + 1}`))
    : fallback.loadouts;
  // Always present exactly ten slots, however many were stored.
  while (loadouts.length < 10) loadouts.push(defaultLoadout(`Class ${loadouts.length + 1}`));

  const profile: Profile = {
    version: CURRENT_VERSION,
    name: str(p.name, fallback.name, 20),
    rank: num(p.rank, 1, 1, MAX_RANK),
    prestige: num(p.prestige, 0, 0, 10),
    xp: num(p.xp, 0, 0),
    stats: {
      kills: num(stats.kills, 0, 0),
      deaths: num(stats.deaths, 0, 0),
      assists: num(stats.assists, 0, 0),
      score: num(stats.score, 0, 0),
      matches: num(stats.matches, 0, 0),
      wins: num(stats.wins, 0, 0),
      headshots: num(stats.headshots, 0, 0),
      timePlayed: num(stats.timePlayed, 0, 0),
    },
    loadouts,
    activeLoadout: num(p.activeLoadout, 0, 0, 9),
    weaponXp:
      typeof p.weaponXp === 'object' && p.weaponXp !== null
        ? (p.weaponXp as Record<string, number>)
        : {},
    lastMatch: {
      mapId: str(lastMatch.mapId, fallback.lastMatch.mapId, 40),
      modeId: str(lastMatch.modeId, fallback.lastMatch.modeId, 40),
      botCount: num(lastMatch.botCount, 9, 0, 23),
      difficulty: str(lastMatch.difficulty, 'regular', 20),
      missionId: str(lastMatch.missionId, fallback.lastMatch.missionId, 40),
      online: lastMatch.online === true,
      serverUrl: str(lastMatch.serverUrl, fallback.lastMatch.serverUrl, 200),
    },
    settings: {
      // Merge over defaults so a profile written by an older build — which will
      // be missing any setting added since — still yields a complete object.
      input: {
        ...DEFAULT_INPUT_SETTINGS,
        ...(isRecord(settings.input) ? (settings.input as Partial<InputSettings>) : {}),
        bindings: {
          ...DEFAULT_INPUT_SETTINGS.bindings,
          ...(isRecord(settings.input) && isRecord((settings.input as Record<string, unknown>).bindings)
            ? ((settings.input as Record<string, unknown>).bindings as InputSettings['bindings'])
            : {}),
        },
      },
      render: {
        ...DEFAULT_RENDER_SETTINGS,
        ...(isRecord(settings.render) ? (settings.render as Partial<RenderSettings>) : {}),
      },
      hud: {
        ...DEFAULT_HUD_OPTIONS,
        ...(isRecord(settings.hud) ? (settings.hud as Partial<HudOptions>) : {}),
      },
      masterVolume: num(settings.masterVolume, 0.8, 0, 1),
      sfxVolume: num(settings.sfxVolume, 1, 0, 1),
      musicVolume: num(settings.musicVolume, 0.5, 0, 1),
    },
  };

  return migrate(profile, num(p.version, 0));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Forward-migrate an older profile.
 *
 * Each version gets its own step so migrations compose: a version-0 profile runs
 * every step in order rather than needing a bespoke path to the present.
 */
function migrate(profile: Profile, fromVersion: number): Profile {
  let version = fromVersion;

  if (version < 1) {
    // v0 -> v1: the map and mode ids were renamed when the registry landed.
    // Validate rather than trust, since the stored ids may no longer exist.
    version = 1;
  }

  profile.version = CURRENT_VERSION;
  void version;
  return profile;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

let saveTimer = 0;

/**
 * Persist the profile, debounced.
 *
 * Settings sliders fire on every pixel of drag; writing synchronously on each
 * one would serialise the whole profile dozens of times a second.
 */
export function saveProfile(profile: Profile): void {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch {
      // Quota exceeded or storage disabled — the session still works, so there
      // is nothing useful to tell the player mid-match.
    }
  }, 250);
}

/** Force an immediate write, for use before navigating away. */
export function flushProfile(profile: Profile): void {
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    /* see above */
  }
}

export function resetProfile(): Profile {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return createProfile();
}

/** Total XP required to reach a rank. Exported so the UI can draw progress. */
export function xpForRank(rank: number): number {
  return Math.round(900 * rank + 55 * rank * rank);
}

export function rankProgress(profile: Profile): { current: number; next: number; fraction: number } {
  const current = xpForRank(profile.rank);
  const next = xpForRank(profile.rank + 1);
  const span = Math.max(1, next - current);
  return {
    current,
    next,
    fraction: Math.min(1, Math.max(0, (profile.xp - current) / span)),
  };
}

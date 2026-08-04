/**
 * Emit deterministic reference fixtures consumed by the C# port.
 *
 * These files are intentionally produced by the shipping TypeScript modules,
 * not duplicated tables. A content change therefore makes the cross-language
 * parity gate fail until both implementations agree again.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ATTACHMENTS } from '../src/shared/data/attachments.js';
import { EQUIPMENT } from '../src/shared/data/equipment.js';
import { KILLSTREAKS } from '../src/shared/data/killstreaks.js';
import { GAME_MODES } from '../src/shared/data/modes.js';
import { PERKS } from '../src/shared/data/perks.js';
import { WEAPONS } from '../src/shared/data/weapons.js';
import { MAPS } from '../src/shared/map/index.js';
import { CAMPAIGN_MISSIONS } from '../src/shared/campaign/index.js';
import { ZOMBIES_MAPS } from '../src/shared/zombies/index.js';
import {
  DOWN,
  MAX_ZOMBIE_PERKS,
  MYSTERY_BOX_COST,
  PACK_A_PUNCH_COST,
  POINTS,
  ROUND_CURVE,
  WALL_AMMO_MAGS,
  ZOMBIE_PERKS,
} from '../src/shared/zombies/zombie-types.js';
import { Rng, hashString, mixSeeds } from '../src/shared/rng.js';
import {
  NetMessage,
  encodeControl,
  encodeInputs,
  encodeSnapshot,
  packAngle,
  unpackAngle,
  type Snapshot,
  type WireInput,
} from '../src/shared/net/protocol.js';
import {
  DamageCause,
  MatchPhase,
  ProjectileKind,
  SimEventType,
  SurfaceType,
  Team,
  type SimEvent,
} from '../src/shared/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(here, '../../dotnet/parity');
mkdirSync(outputDirectory, { recursive: true });

function canonicalise(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { $number: String(value) };
  }
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = canonicalise(child);
    }
    return result;
  }
  return value;
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(
    resolve(outputDirectory, name),
    `${JSON.stringify(canonicalise(value), null, 2)}\n`,
    'utf8',
  );
}

const rngSeeds = [0, 1, 7, 0x7fffffff, 0x80000000, 0xffffffff];
const rng = rngSeeds.map((seed) => {
  const generator = new Rng(seed);
  const values = Array.from({ length: 32 }, () => ({
    value: generator.next(),
    state: generator.getState(),
  }));

  const gaussianGenerator = new Rng(seed);
  const gaussian = Array.from({ length: 8 }, () => gaussianGenerator.gaussian());
  const discGenerator = new Rng(seed);
  const unitDisc = Array.from({ length: 8 }, () => discGenerator.unitDisc({ x: 0, y: 0 }));

  return { seed, values, gaussian, unitDisc };
});

const hashInputs = ['', 'operation-vanguard', 'crossfire', '先鋒行動', '🎮'];

writeJson('rng.json', {
  schemaVersion: 1,
  sequences: rng,
  hashes: Object.fromEntries(hashInputs.map((input) => [input, hashString(input)])),
  mixedSeeds: [
    { values: [], result: mixSeeds() },
    { values: [0], result: mixSeeds(0) },
    { values: [1, 2, 3], result: mixSeeds(1, 2, 3) },
    { values: [0xffffffff, 0x80000000, 7], result: mixSeeds(0xffffffff, 0x80000000, 7) },
  ],
});

writeJson('content.json', {
  schemaVersion: 1,
  weapons: WEAPONS,
  attachments: ATTACHMENTS,
  perks: PERKS,
  equipment: EQUIPMENT,
  killstreaks: KILLSTREAKS,
  modes: GAME_MODES,
  maps: MAPS,
  campaign: CAMPAIGN_MISSIONS,
  zombies: {
    maps: ZOMBIES_MAPS,
    perks: ZOMBIE_PERKS,
    maxPerks: MAX_ZOMBIE_PERKS,
    mysteryBoxCost: MYSTERY_BOX_COST,
    packAPunchCost: PACK_A_PUNCH_COST,
    wallAmmoMags: WALL_AMMO_MAGS,
    roundCurve: ROUND_CURVE,
    points: POINTS,
    down: DOWN,
  },
});

const snapshot: Snapshot = {
  tick: 0xfedcba98,
  serverTime: 1234.5678,
  ackedInput: 0x89abcdef,
  players: [
    {
      id: 7,
      team: 1,
      alive: true,
      onGround: true,
      isBot: false,
      stance: 0,
      moveState: 3,
      x: 12.25,
      y: -0.125,
      z: -41.75,
      vx: 3.5,
      vy: -7.25,
      vz: 0.0625,
      yaw: -Math.PI * 1.75,
      pitch: Math.PI / 3,
      health: 217,
      weaponSlot: 1,
      lean: -0.375,
    },
    {
      id: 65535,
      team: 3,
      alive: false,
      onGround: false,
      isBot: true,
      stance: 2,
      moveState: 8,
      x: -0.5,
      y: 100.125,
      z: 0.3333333333333333,
      vx: -999.75,
      vy: 0,
      vz: 999.75,
      yaw: Math.PI,
      pitch: -Math.PI,
      health: 0,
      weaponSlot: 0,
      lean: 1,
    },
  ],
};

const inputs: WireInput[] = Array.from({ length: 20 }, (_, index) => ({
  seq: 1000 + index,
  tick: 5000 + index * 2,
  dt: 1 / (30 + index),
  moveForward: (index - 9.5) / 9.5,
  moveRight: Math.sin(index),
  yaw: index * Math.PI / 7 - Math.PI * 2,
  pitch: Math.PI / 2 - index * 0.17,
  buttons: (0x80000000 + index * 65539) >>> 0,
  weaponSlot: index % 2,
}));

const helloPayload = {
  protocolVersion: 8,
  name: '先鋒 🎮',
  loadout: { primary: 'vk47', attachments: ['red_dot', 'foregrip'] },
};

const events: SimEvent[] = [
  {
    type: SimEventType.Hit,
    tick: 17,
    attacker: 7,
    victim: 9,
    location: 'upperArm',
    damage: 33.5,
    lethal: false,
    position: { x: 1.25, y: 2, z: -3.5 },
    weaponId: 'vk47',
  },
  {
    type: SimEventType.Footstep,
    tick: 18,
    player: 9,
    position: { x: -4, y: 0.125, z: 6.5 },
    surface: SurfaceType.Wood,
    loud: true,
  },
  {
    type: SimEventType.Damage,
    tick: 19,
    victim: 9,
    attacker: 7,
    amount: 12.25,
    direction: { x: 0, y: 0.5, z: -1 },
    cause: DamageCause.Explosion,
  },
  {
    type: SimEventType.Explosion,
    tick: 20,
    position: { x: 8, y: 1, z: -2 },
    radius: 5.5,
    owner: 7,
    kind: ProjectileKind.Frag,
  },
  {
    type: SimEventType.RoundStart,
    tick: 21,
    player: 7,
    team: Team.Allies,
    position: { x: 3, y: 0, z: 4 },
    data: { round: 2, phase: MatchPhase.Live },
  },
];

writeJson('protocol.json', {
  schemaVersion: 1,
  angles: [-Math.PI * 4, -Math.PI, -0.0001, 0, Math.PI, Math.PI * 2, Math.PI * 9.25]
    .map((radians) => ({ radians, packed: packAngle(radians), unpacked: unpackAngle(packAngle(radians)) })),
  control: {
    type: NetMessage.Hello,
    payload: helloPayload,
    base64: Buffer.from(encodeControl(NetMessage.Hello, helloPayload)).toString('base64'),
  },
  events: {
    value: events,
    base64: Buffer.from(encodeControl(NetMessage.Events, events)).toString('base64'),
  },
  snapshot: {
    value: snapshot,
    base64: Buffer.from(encodeSnapshot(snapshot)).toString('base64'),
  },
  inputs: {
    source: inputs,
    encodedCount: 16,
    base64: Buffer.from(encodeInputs(inputs)).toString('base64'),
  },
});

console.log(`Wrote .NET parity fixtures to ${outputDirectory}`);

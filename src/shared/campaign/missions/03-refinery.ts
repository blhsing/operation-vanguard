/**
 * Mission 3 — Cracking Tower. Refinery.
 *
 * The first mission that asks for something other than shooting. Two charges,
 * on opposite sides of a working refinery, each of which takes long enough to
 * set that you cannot do it alone while anyone is looking at you — so the squad
 * stops being scenery here and starts being the reason you survive.
 */

import { vec3 } from '../../math.js';
import type { MissionDef } from '../campaign-types.js';

export const CRACKING_TOWER: MissionDef = {
  id: 'cracking_tower',
  name: 'Cracking Tower',
  mapId: 'refinery',
  brief:
    'They have been running the refinery at half capacity for six weeks and ' +
    'shipping the difference somewhere we cannot follow. Two charges, both towers, ' +
    'and out before the pressure drops.',
  insertion: { position: vec3(-2, 0.1, 35), yaw: -0.16 },
  difficulty: 'regular',

  allies: [
    { id: 'brandt', name: 'Brandt', spawn: vec3(-6, 0.1, 34), archetype: 'rifleman' },
    { id: 'sood', name: 'Sood', spawn: vec3(2, 0.1, 34), archetype: 'support' },
  ],

  garrison: [{ spawn: vec3(16, 0.1, -26), post: vec3(16, 0.1, -26), count: 2, interval: 2.4, archetypes: ['rifleman'] }],

  objectives: [
    {
      id: 'east_approach',
      label: 'Reach the east cracking tower',
      line: 'Brandt: East tower first. It is the loud one — nobody will hear us start.',
      trigger: { kind: 'reach', zone: { center: vec3(28, 0, 0), size: vec3(12, 6, 12) } },
      waves: [{ spawn: vec3(30, 0.1, -25), post: vec3(30, 0.1, -25), count: 3, interval: 5.6, archetypes: ['rifleman', 'rusher'] }],
      checkpoint: true,
    },
    {
      id: 'charge_east',
      label: 'Set the charge',
      after: ['east_approach'],
      line: 'Sood: Hold the key down and do not let go. I will keep them off you.',
      trigger: {
        kind: 'interact',
        zone: { center: vec3(28, 0, 0), size: vec3(9, 6, 9) },
        seconds: 8,
        verb: 'SET CHARGE',
      },
      waves: [
        { spawn: vec3(41, 0.1, -16), post: vec3(41, 0.1, -16), count: 1, interval: 9.6, endless: true, archetypes: ['rusher'] },
      ],
      checkpoint: true,
    },
    {
      id: 'west_approach',
      label: 'Cross to the west tower',
      after: ['charge_east'],
      line: 'Brandt: They know now. West side, and quickly.',
      trigger: { kind: 'reach', zone: { center: vec3(-31, 0, -8), size: vec3(12, 6, 12) } },
      waves: [
        { spawn: vec3(-29, 0.1, -24), post: vec3(-29, 0.1, -24), count: 3, interval: 4.8, archetypes: ['rifleman'] },
        { spawn: vec3(-36, 0.1, -12), post: vec3(-36, 0.1, -12), count: 2, interval: 6.4, delay: 4, archetypes: ['sniper'] },
      ],
      checkpoint: true,
    },
    {
      id: 'charge_west',
      label: 'Set the second charge',
      after: ['west_approach'],
      line: 'Sood: Same again. Ignore everything that is not the charge.',
      trigger: {
        kind: 'interact',
        zone: { center: vec3(-31, 0, -8), size: vec3(9, 6, 9) },
        seconds: 8,
        verb: 'SET CHARGE',
      },
      waves: [
        { spawn: vec3(-29, 0.1, -24), post: vec3(-29, 0.1, -24), count: 1, interval: 8, endless: true, archetypes: ['rusher', 'rifleman'] },
      ],
      checkpoint: true,
    },
    {
      id: 'exfil',
      label: 'Get to the extraction point',
      after: ['charge_west'],
      line: 'Command: Charges are live. You have ninety seconds and a long walk.',
      timeLimit: 110,
      trigger: { kind: 'reach', zone: { center: vec3(-2, 0, 35), size: vec3(16, 6, 12) } },
      waves: [
        { spawn: vec3(-2, 0.1, -35), post: vec3(-2, 0.1, -35), count: 1, interval: 12.8, endless: true, archetypes: ['rifleman'] },
      ],
    },
  ],

  outro: 'Charges away. They will be shipping nothing for a while.',
};

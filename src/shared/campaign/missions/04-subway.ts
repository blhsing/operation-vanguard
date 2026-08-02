/**
 * Mission 4 — Line Three. Subway.
 *
 * The escort. Marchetti is a signals technician who has to reach the northern
 * relay on foot, and he is the only character in the campaign whose death ends
 * the mission — which is why this one is set underground, where there are no
 * long angles and everything that kills him has to come close enough to be
 * killed first.
 */

import { vec3 } from '../../math.js';
import type { MissionDef } from '../campaign-types.js';

export const LINE_THREE: MissionDef = {
  id: 'line_three',
  name: 'Line Three',
  mapId: 'subway',
  brief:
    'Everything above ground is being jammed from a relay on the northern ' +
    'platform. Marchetti can turn it around and point it at them. Marchetti ' +
    'cannot, under any circumstances, be shot.',
  insertion: { position: vec3(-13, 0.1, 32), yaw: -0.14 },
  difficulty: 'regular',

  allies: [
    { id: 'marchetti', name: 'Marchetti', spawn: vec3(-15, 0.1, 34), archetype: 'support', essential: true },
    { id: 'doyle', name: 'Doyle', spawn: vec3(-11, 0.1, 33), archetype: 'rusher' },
    { id: 'ferrara', name: 'Ferrara', spawn: vec3(13, 0.1, 33), archetype: 'rifleman' },
  ],

  garrison: [
    { spawn: vec3(-13, 0.1, -18), post: vec3(-13, 0.1, -18), count: 2, interval: 2.4, archetypes: ['rifleman'] },
    { spawn: vec3(13, 0.1, -18), post: vec3(13, 0.1, -18), count: 1, interval: 3.2, archetypes: ['rusher'] },
  ],

  objectives: [
    {
      id: 'concourse',
      label: 'Clear the central concourse',
      line: 'Doyle: Both platforms, then the middle. Keep Marchetti behind you.',
      trigger: { kind: 'eliminate', count: 4 },
      waves: [
        { spawn: vec3(13, 0.1, -18), post: vec3(13, 0.1, -18), count: 3, interval: 4.8, archetypes: ['rusher', 'rifleman'] },
        { spawn: vec3(-13, 0.1, -18), post: vec3(-13, 0.1, -18), count: 2, interval: 6.4, delay: 3, archetypes: ['rifleman'] },
      ],
      checkpoint: true,
    },
    {
      id: 'mezzanine',
      label: 'Take the mezzanine',
      after: ['concourse'],
      line: 'Ferrara: They are on the walkway. We are not going anywhere until they are not.',
      trigger: { kind: 'reach', zone: { center: vec3(21, 4.3, -18), size: vec3(10, 4, 12) } },
      waves: [
        { spawn: vec3(21, 4.3, -18), post: vec3(21, 4.3, -18), count: 2, interval: 6.4, archetypes: ['sniper', 'rifleman'] },
        { spawn: vec3(-21, 4.3, 14), post: vec3(-21, 4.3, 14), count: 1, interval: 8, delay: 4, archetypes: ['scout'] },
      ],
      checkpoint: true,
    },
    {
      id: 'escort',
      label: 'Get Marchetti to the northern relay',
      after: ['mezzanine'],
      line: 'Marchetti: Moving. Do not let me regret this.',
      trigger: { kind: 'escort', ally: 'marchetti', zone: { center: vec3(-15, 0, -20), size: vec3(14, 6, 14) } },
      waves: [
        { spawn: vec3(13, 0.1, -30), post: vec3(13, 0.1, -30), count: 1, interval: 11.2, endless: true, archetypes: ['rifleman'] },
      ],
      checkpoint: true,
    },
    {
      id: 'cover',
      label: 'Cover Marchetti at the relay',
      after: ['escort'],
      line: 'Marchetti: Ninety seconds. Less if nobody shoots me.',
      trigger: { kind: 'survive', seconds: 45 },
      waves: [
        { spawn: vec3(-13, 0.1, -30), post: vec3(-13, 0.1, -30), count: 1, interval: 8, endless: true, archetypes: ['rusher'] },
        {
          spawn: vec3(13, 0.1, -30),
          post: vec3(13, 0.1, -30),
          count: 1,
          interval: 9.6,
          delay: 3,
          endless: true,
          archetypes: ['rifleman'],
        },
      ],
    },
  ],

  outro: 'Relay is ours. Marchetti would like it noted that he was shot at.',
};

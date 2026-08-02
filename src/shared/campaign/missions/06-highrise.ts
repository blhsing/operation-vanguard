/**
 * Mission 6 — Last Floor. Highrise.
 *
 * The finale, and the only mission that ends where it started: on the helipad
 * in the middle of the roof, which has no cover at all and is the one place the
 * bird can land. Both towers have to be cleared first, because a single rifle
 * left in either of them makes the pad unholdable — which is the argument the
 * whole map has been making since the first time anyone crossed it.
 */

import { vec3 } from '../../math.js';
import type { MissionDef } from '../campaign-types.js';

export const LAST_FLOOR: MissionDef = {
  id: 'last_floor',
  name: 'Last Floor',
  mapId: 'highrise',
  brief:
    'Forty storeys up, two towers and a helipad between them. Everyone who ' +
    'matters is on this roof and none of them expected the stairs to be the ' +
    'safe way down.',
  insertion: { position: vec3(0, 0.1, 27), yaw: -0.16 },
  difficulty: 'regular',

  allies: [
    { id: 'kowalczyk', name: 'Kowalczyk', spawn: vec3(-4, 0.1, 26), archetype: 'rifleman' },
    { id: 'adeyemi', name: 'Adeyemi', spawn: vec3(4, 0.1, 26), archetype: 'support' },
    { id: 'strand', name: 'Strand', spawn: vec3(0, 0.1, 30), archetype: 'sniper' },
  ],

  garrison: [
    { spawn: vec3(0, 0.1, -27), post: vec3(0, 0.1, -27), count: 2, interval: 2.4, archetypes: ['rifleman'] },
    { spawn: vec3(19.5, 3.65, 4), post: vec3(19.5, 3.65, 4), count: 1, interval: 3.2, archetypes: ['sniper'] },
  ],

  objectives: [
    {
      id: 'service_core',
      label: 'Clear the service core',
      line: 'Kowalczyk: East tower. Two floors, and they own the upper one.',
      trigger: { kind: 'reach', zone: { center: vec3(26, 2.0, -4), size: vec3(16, 9, 14) } },
      waves: [
        { spawn: vec3(27, 3.65, -8), post: vec3(27, 3.65, -8), count: 2, interval: 5.6, archetypes: ['rifleman', 'sniper'] },
        { spawn: vec3(33, 0.1, -23.4), post: vec3(33, 0.1, -23.4), count: 2, interval: 6.4, delay: 3, archetypes: ['rusher'] },
      ],
      checkpoint: true,
    },
    {
      id: 'north_tower',
      label: 'Clear the north tower',
      after: ['service_core'],
      line: 'Adeyemi: West side is worse. Short rooms, glass walls, no angles at all.',
      trigger: { kind: 'reach', zone: { center: vec3(-24, 2.0, -8), size: vec3(16, 9, 16) } },
      waves: [
        { spawn: vec3(-20, 2.9, -8), post: vec3(-20, 2.9, -8), count: 2, interval: 6.4, archetypes: ['rusher', 'rifleman'] },
        { spawn: vec3(-33, 0.1, -23.4), post: vec3(-33, 0.1, -23.4), count: 2, interval: 7.2, delay: 4, archetypes: ['rifleman'] },
      ],
      checkpoint: true,
    },
    {
      id: 'mark',
      label: 'Mark the landing zone',
      after: ['north_tower'],
      line: 'Strand: Pad is clear of cover, which cuts exactly one way. Get it done.',
      trigger: {
        kind: 'interact',
        zone: { center: vec3(0, 0.5, 0), size: vec3(13, 6, 13) },
        seconds: 10,
        verb: 'MARK LZ',
      },
      waves: [
        { spawn: vec3(0, 0.1, -27), post: vec3(0, 0.1, -27), count: 1, interval: 9.6, endless: true, archetypes: ['rifleman'] },
      ],
      checkpoint: true,
    },
    {
      id: 'hold_pad',
      label: 'Hold the helipad',
      after: ['mark'],
      line: 'Command: Two minutes. Everything on that roof now knows where you are.',
      trigger: { kind: 'hold', zone: { center: vec3(0, 0.5, 0), size: vec3(18, 7, 18) }, seconds: 55 },
      waves: [
        { spawn: vec3(0, 0.1, -27), post: vec3(0, 0.1, -27), count: 1, interval: 7.2, endless: true, archetypes: ['rusher'] },
        {
          spawn: vec3(-38, 0.1, 0),
          post: vec3(-38, 0.1, 0),
          count: 1,
          interval: 9.6,
          delay: 3,
          endless: true,
          archetypes: ['rifleman'],
        },
        {
          spawn: vec3(39, 0.1, 4),
          post: vec3(39, 0.1, 4),
          count: 1,
          interval: 11.2,
          delay: 6,
          endless: true,
          archetypes: ['sniper', 'scout'],
        },
      ],
    },
  ],

  outro: 'Wheels up. Nobody left on the roof to wave.',
};

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
  name: '最後一層',
  mapId: 'highrise',
  brief:
    '四十層樓高，兩座塔樓，中間一座停機坪。所有' +
    '要緊的人都在這個屋頂上，沒有一個想到樓梯會是' +
    '比較安全的下去方式。',
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
      label: '清空服務核心',
      line: 'Kowalczyk：東塔。兩層樓，上面那層是他們的。',
      trigger: { kind: 'reach', zone: { center: vec3(26, 2.0, -4), size: vec3(16, 9, 14) } },
      reapOnComplete: true,
      waves: [
        { spawn: vec3(27, 3.65, -8), post: vec3(27, 3.65, -8), count: 2, interval: 5.6, archetypes: ['rifleman', 'sniper'] },
        { spawn: vec3(33, 0.1, -23.4), post: vec3(33, 0.1, -23.4), count: 2, interval: 6.4, delay: 3, archetypes: ['rusher'] },
      ],
      checkpoint: true,
    },
    {
      id: 'north_tower',
      label: '清空北塔',
      after: ['service_core'],
      line: 'Adeyemi：西側更糟。房間短、玻璃牆，完全沒有射角。',
      trigger: { kind: 'reach', zone: { center: vec3(-24, 2.0, -8), size: vec3(16, 9, 16) } },
      reapOnComplete: true,
      waves: [
        { spawn: vec3(-20, 2.9, -8), post: vec3(-20, 2.9, -8), count: 2, interval: 6.4, archetypes: ['rusher', 'rifleman'] },
        { spawn: vec3(-33, 0.1, -23.4), post: vec3(-33, 0.1, -23.4), count: 2, interval: 7.2, delay: 4, archetypes: ['rifleman'] },
      ],
      checkpoint: true,
    },
    {
      id: 'mark',
      label: '標記降落區',
      after: ['north_tower'],
      line: 'Strand：停機坪上沒有掩體，而這是單面刃。把它做完。',
      trigger: {
        kind: 'interact',
        zone: { center: vec3(0, 0.5, 0), size: vec3(13, 6, 13) },
        seconds: 6,
        verb: '標記降落區',
      },
      waves: [
        // Not endless. An objective that asks the player to stand still cannot also
        // put them under fire that never stops: the pad never clears, they never get
        // the six seconds, and the mission is a stalemate rather than a fight.
        { spawn: vec3(0, 0.1, -27), post: vec3(0, 0.1, -27), count: 2, interval: 12, delay: 5, archetypes: ['rifleman'] },
      ],
      checkpoint: true,
    },
    {
      id: 'hold_pad',
      label: '守住停機坪',
      after: ['mark'],
      line: '指揮部：兩分鐘。屋頂上的每一個東西現在都知道你在哪。',
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

  outro: '起飛。屋頂上沒剩下任何人揮手。',
};

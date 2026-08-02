/**
 * Mission 2 — Ash and Stone. Crossfire.
 *
 * The first mission with a shape: a village with three ways through it, and an
 * objective in the middle that is only holdable if you have taken one of the
 * flanks first. The garrison is deliberately placed so that walking straight up
 * the centre gets you shot from both sides, which is the lesson.
 */

import { vec3 } from '../../math.js';
import type { MissionDef } from '../campaign-types.js';

export const ASH_AND_STONE: MissionDef = {
  id: 'ash_and_stone',
  name: '灰燼與磚石',
  mapId: 'crossfire',
  brief:
    '這座村莊卡在唯一一條北上的路上。這個月已經四度易手，' +
    '沒有人守住廣場超過一天。',
  insertion: { position: vec3(0, 0.1, 34), yaw: -0.18 },
  difficulty: 'regular',

  allies: [
    { id: 'reyes', name: 'Reyes', spawn: vec3(-3, 0.1, 33), archetype: 'rifleman' },
    { id: 'okafor', name: 'Okafor', spawn: vec3(3, 0.1, 33), archetype: 'support' },
  ],

  garrison: [
    { spawn: vec3(0, 0.1, -18), post: vec3(0, 0.1, -18), count: 2, interval: 1.6, archetypes: ['rifleman'] },
    { spawn: vec3(29, 0.1, -18), post: vec3(29, 0.1, -18), count: 1, interval: 1.6, archetypes: ['sniper'] },
  ],

  objectives: [
    {
      id: 'west',
      label: '奪取西側通道',
      line: 'Reyes：走左邊。從中間上去會被攔腰打斷。',
      trigger: { kind: 'reach', zone: { center: vec3(-29, 0, 16), size: vec3(10, 5, 10) } },
      waves: [
        { spawn: vec3(-31, 0.1, -12), post: vec3(-31, 0.1, -12), count: 3, interval: 5.6, archetypes: ['rifleman', 'rusher'] },
      ],
      checkpoint: true,
    },
    {
      id: 'square',
      label: '擊潰廣場守軍',
      after: ['west'],
      line: 'Okafor：他們在噴泉周圍掘壕固守。你說一聲。',
      trigger: { kind: 'eliminate', count: 5 },
      waves: [
        { spawn: vec3(0, 0.1, -18), post: vec3(0, 0.1, -18), count: 4, interval: 4.8, archetypes: ['rifleman'] },
        { spawn: vec3(29, 0.1, -24), post: vec3(29, 0.1, -24), count: 3, interval: 6.4, delay: 5, archetypes: ['rusher'] },
      ],
      checkpoint: true,
    },
    {
      id: 'hold',
      label: '守住廣場',
      after: ['square'],
      line: '指揮部：裝甲正沿著路上來。守住廣場，等它上來為止。',
      trigger: { kind: 'hold', zone: { center: vec3(0, 0, 0), size: vec3(14, 6, 14) }, seconds: 40 },
      waves: [
        { spawn: vec3(0, 0.1, -34), post: vec3(0, 0.1, -34), count: 1, interval: 11.2, endless: true, archetypes: ['rifleman'] },
        {
          spawn: vec3(-29, 0.1, -25),
          post: vec3(-29, 0.1, -25),
          count: 1,
          interval: 14.4,
          delay: 4,
          endless: true,
          archetypes: ['rusher', 'scout'],
        },
      ],
      checkpoint: true,
    },
    {
      id: 'north',
      label: '清空北向道路',
      after: ['hold'],
      line: 'Reyes：路通了。過去看看。',
      trigger: { kind: 'reach', zone: { center: vec3(0, 0, -34), size: vec3(14, 5, 12) } },
      waves: [{ spawn: vec3(-29, 0.1, -25), post: vec3(-29, 0.1, -25), count: 2, interval: 6.4, archetypes: ['sniper', 'rifleman'] }],
    },
  ],

  outro: '村子是我們的了。頂多一天。',
};

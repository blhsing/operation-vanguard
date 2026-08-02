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
  name: '三號線',
  mapId: 'subway',
  brief:
    '地面上所有通訊都被北側月台上的一具中繼台干擾。' +
    'Marchetti可以把它掉頭對準他們。Marchetti' +
    '在任何情況下都不能中彈。',
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
      label: '清空中央大廳',
      line: 'Doyle：先兩側月台，再中間。讓Marchetti待在你後面。',
      trigger: { kind: 'eliminate', count: 4 },
      waves: [
        { spawn: vec3(13, 0.1, -18), post: vec3(13, 0.1, -18), count: 3, interval: 4.8, archetypes: ['rusher', 'rifleman'] },
        { spawn: vec3(-13, 0.1, -18), post: vec3(-13, 0.1, -18), count: 2, interval: 6.4, delay: 3, archetypes: ['rifleman'] },
      ],
      checkpoint: true,
    },
    {
      id: 'mezzanine',
      label: '奪取夾層',
      after: ['concourse'],
      line: 'Ferrara：他們在走道上。他們不清掉，我們哪裡都去不了。',
      trigger: { kind: 'reach', zone: { center: vec3(21, 4.3, -18), size: vec3(10, 4, 12) } },
      waves: [
        { spawn: vec3(21, 4.3, -18), post: vec3(21, 4.3, -18), count: 2, interval: 6.4, archetypes: ['sniper', 'rifleman'] },
        { spawn: vec3(-21, 4.3, 14), post: vec3(-21, 4.3, 14), count: 1, interval: 8, delay: 4, archetypes: ['scout'] },
      ],
      checkpoint: true,
    },
    {
      id: 'escort',
      label: '護送Marchetti到北側中繼台',
      after: ['mezzanine'],
      line: 'Marchetti：移動中。別讓我後悔這麼做。',
      trigger: { kind: 'escort', ally: 'marchetti', zone: { center: vec3(-15, 0, -20), size: vec3(14, 6, 14) } },
      waves: [
        { spawn: vec3(13, 0.1, -30), post: vec3(13, 0.1, -30), count: 1, interval: 11.2, endless: true, archetypes: ['rifleman'] },
      ],
      checkpoint: true,
    },
    {
      id: 'cover',
      label: '在中繼台掩護Marchetti',
      after: ['escort'],
      line: 'Marchetti：九十秒。沒人朝我開槍的話會更快。',
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

  outro: '中繼台到手。Marchetti希望大家記下來：有人朝他開槍。',
};

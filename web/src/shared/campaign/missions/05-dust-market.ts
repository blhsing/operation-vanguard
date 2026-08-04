/**
 * Mission 5 — Noon. Dust Market.
 *
 * The mission that uses the map's one real idea: the bazaar in the middle is
 * unwinnable at range and the roof terrace is unwinnable up close, so the
 * mission makes you fight through the first to reach the second and then holds
 * you on it while they come up the stairs.
 */

import { vec3 } from '../../math.js';
import type { MissionDef } from '../campaign-types.js';

export const NOON: MissionDef = {
  id: 'noon',
  name: '正午',
  mapId: 'dust_market',
  brief:
    '他們在正午、在光天化日下把錢運過市集，因為' +
    '從來沒有人蠢到會在正午、在光天化日下來把它拿走。',
  insertion: { position: vec3(0, 0.1, 34), yaw: -0.16 },
  difficulty: 'regular',

  allies: [
    { id: 'nasser', name: 'Nasser', spawn: vec3(-4, 0.1, 33), archetype: 'rusher' },
    { id: 'lindqvist', name: 'Lindqvist', spawn: vec3(4, 0.1, 33), archetype: 'sniper' },
  ],

  garrison: [
    { spawn: vec3(0, 0.1, -28), post: vec3(0, 0.1, -28), count: 2, interval: 2.4, archetypes: ['rifleman'] },
    { spawn: vec3(-20, 0.1, -30), post: vec3(-20, 0.1, -30), count: 1, interval: 3.2, archetypes: ['rusher'] },
  ],

  objectives: [
    {
      id: 'market',
      label: '強行通過市集',
      line: 'Nasser：攤位只擋得住一個方向。挑清楚。',
      trigger: { kind: 'eliminate', count: 6 },
      waves: [
        { spawn: vec3(0, 0.1, -28), post: vec3(0, 0.1, -28), count: 4, interval: 4, archetypes: ['rusher', 'rifleman'] },
        { spawn: vec3(16, 0.1, -18), post: vec3(16, 0.1, -18), count: 3, interval: 5.6, delay: 3, archetypes: ['rifleman'] },
        { spawn: vec3(-16, 0.1, 12), post: vec3(-16, 0.1, 12), count: 2, interval: 8, delay: 8, archetypes: ['scout'] },
      ],
      checkpoint: true,
    },
    {
      id: 'colonnade',
      label: '清空柱廊',
      after: ['market'],
      line: 'Lindqvist：西側。你把我帶過去，我從拱門那邊有射角。',
      trigger: { kind: 'reach', zone: { center: vec3(-28, 0, 14), size: vec3(12, 6, 12) } },
      waves: [{ spawn: vec3(-38, 0.1, -22), post: vec3(-38, 0.1, -22), count: 3, interval: 5.6, archetypes: ['rifleman', 'sniper'] }],
      checkpoint: true,
    },
    {
      id: 'terrace',
      label: '奪取屋頂平台',
      after: ['colonnade'],
      line: 'Nasser：樓梯在另一頭。要繞很遠，而且沒別條路。',
      trigger: { kind: 'reach', zone: { center: vec3(28, 6.75, 6), size: vec3(16, 5, 22) } },
      waves: [
        { spawn: vec3(28, 6.85, -2), post: vec3(28, 6.85, -2), count: 2, interval: 6.4, archetypes: ['rifleman'] },
        { spawn: vec3(39, 0.1, -12), post: vec3(39, 0.1, -12), count: 2, interval: 6.4, delay: 4, archetypes: ['rusher'] },
      ],
      checkpoint: true,
    },
    {
      id: 'hold',
      label: '固守平台待撤離',
      after: ['terrace'],
      line: '指揮部：屋頂就是降落區。想上來的都得走樓梯。',
      trigger: { kind: 'hold', zone: { center: vec3(28, 6.75, 6), size: vec3(18, 5, 24) }, seconds: 50 },
      waves: [
        { spawn: vec3(39, 0.1, -12), post: vec3(39, 0.1, -12), count: 1, interval: 8, endless: true, archetypes: ['rusher'] },
        {
          spawn: vec3(20, 0.1, 30),
          post: vec3(20, 0.1, 30),
          count: 1,
          interval: 11.2,
          delay: 4,
          endless: true,
          archetypes: ['rifleman'],
        },
      ],
    },
  ],

  outro: '錢上了直升機。難得的是，我們也上了。',
};

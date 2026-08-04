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
  name: '裂解塔',
  mapId: 'refinery',
  brief:
    '他們讓煉油廠以半產能運轉了六週，' +
    '差額運往我們追不上的地方。兩包炸藥，兩座塔，' +
    '在壓力掉下來之前撤出。',
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
      label: '抵達東側裂解塔',
      line: 'Brandt：先打東塔。那座最吵——沒人會聽見我們動手。',
      trigger: { kind: 'reach', zone: { center: vec3(28, 0, 0), size: vec3(12, 6, 12) } },
      waves: [{ spawn: vec3(30, 0.1, -25), post: vec3(30, 0.1, -25), count: 3, interval: 5.6, archetypes: ['rifleman', 'rusher'] }],
      checkpoint: true,
    },
    {
      id: 'charge_east',
      label: '安裝炸藥',
      after: ['east_approach'],
      line: 'Sood：按住按鍵別放。我幫你擋著。',
      trigger: {
        kind: 'interact',
        zone: { center: vec3(28, 0, 0), size: vec3(9, 6, 9) },
        seconds: 8,
        verb: '安裝炸藥',
      },
      waves: [
        { spawn: vec3(41, 0.1, -16), post: vec3(41, 0.1, -16), count: 1, interval: 9.6, endless: true, archetypes: ['rusher'] },
      ],
      checkpoint: true,
    },
    {
      id: 'west_approach',
      label: '轉往西塔',
      after: ['charge_east'],
      line: 'Brandt：他們知道了。往西側，快。',
      trigger: { kind: 'reach', zone: { center: vec3(-31, 0, -8), size: vec3(12, 6, 12) } },
      waves: [
        { spawn: vec3(-29, 0.1, -24), post: vec3(-29, 0.1, -24), count: 3, interval: 4.8, archetypes: ['rifleman'] },
        { spawn: vec3(-36, 0.1, -12), post: vec3(-36, 0.1, -12), count: 2, interval: 6.4, delay: 4, archetypes: ['sniper'] },
      ],
      checkpoint: true,
    },
    {
      id: 'charge_west',
      label: '安裝第二包炸藥',
      after: ['west_approach'],
      line: 'Sood：再來一次。除了炸藥以外什麼都別管。',
      trigger: {
        kind: 'interact',
        zone: { center: vec3(-31, 0, -8), size: vec3(9, 6, 9) },
        seconds: 8,
        verb: '安裝炸藥',
      },
      waves: [
        { spawn: vec3(-29, 0.1, -24), post: vec3(-29, 0.1, -24), count: 1, interval: 8, endless: true, archetypes: ['rusher', 'rifleman'] },
      ],
      checkpoint: true,
    },
    {
      id: 'exfil',
      label: '前往撤離點',
      after: ['charge_west'],
      line: '指揮部：炸藥已啟動。你有九十秒，還有一段長路。',
      timeLimit: 110,
      trigger: { kind: 'reach', zone: { center: vec3(-2, 0, 35), size: vec3(16, 6, 12) } },
      waves: [
        { spawn: vec3(-2, 0.1, -35), post: vec3(-2, 0.1, -35), count: 1, interval: 12.8, endless: true, archetypes: ['rifleman'] },
      ],
    },
  ],

  outro: '炸藥送出去了。他們有一陣子什麼都運不出去。',
};

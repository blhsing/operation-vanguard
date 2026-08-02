/**
 * Mission 1 — Cold Open. Shipment Yard.
 *
 * The shortest mission in the campaign and the only one that is really a
 * handshake: forty metres square, one squadmate, and nowhere at all to hide.
 * It exists to teach the two things every later mission assumes — that the
 * objective marker is where you are supposed to be, and that standing still in
 * the open is how you die.
 */

import { vec3 } from '../../math.js';
import type { MissionDef } from '../campaign-types.js';

export const COLD_OPEN: MissionDef = {
  id: 'cold_open',
  name: '冷開場',
  mapId: 'shipment_yard',
  brief:
    '一座貨櫃場，位在河的錯誤那一岸。情報說有十來名非正規軍' +
    '把那裡當集結點。情報以前也錯過。',
  insertion: { position: vec3(-14, 0.1, -14), yaw: 0 },
  difficulty: 'recruit',

  allies: [{ id: 'vasquez', name: 'Vasquez', spawn: vec3(-11, 0.1, -15), archetype: 'rifleman' }],

  objectives: [
    {
      id: 'push',
      label: '清空近側貨櫃堆',
      line: 'Vasquez：跟緊我。他們就在貨櫃之間——沒什麼花招。',
      // Kill-based, not "reach the middle". Shipment Yard is forty metres of
      // container maze with two-metre lanes, and an objective marker in the
      // centre of it asks the player to solve a navigation puzzle on the one map
      // in the game that is entirely about reflexes.
      trigger: { kind: 'eliminate', count: 3 },
      waves: [
        { spawn: vec3(9, 0.1, 6), count: 1, interval: 6.4, post: vec3(7, 0.1, 4), archetypes: ['rifleman'] },
        { spawn: vec3(-3, 0.1, -5), count: 1, interval: 8, delay: 3, post: vec3(-2, 0.1, -3), archetypes: ['rifleman'] },
      ],
      checkpoint: true,
    },
    {
      id: 'clear',
      label: '清空貨櫃場',
      after: ['push'],
      line: 'Vasquez：貨櫃堆裡還有。注意縫隙。',
      trigger: { kind: 'eliminate', count: 5 },
      waves: [
        { spawn: vec3(8.5, 0.1, -9), count: 2, interval: 8, post: vec3(7, 0.1, -7), archetypes: ['rifleman'] },
        { spawn: vec3(-8.5, 0.1, 9), count: 2, interval: 9.6, delay: 6, post: vec3(-7, 0.1, 7), archetypes: ['rifleman'] },
      ],
      checkpoint: true,
    },
    {
      id: 'hold',
      label: '固守待撤離',
      after: ['clear'],
      line: '指揮部：直升機四分鐘後到。守住你手上的。',
      trigger: { kind: 'survive', seconds: 30 },
      waves: [
        { spawn: vec3(9, 0.1, 6), post: vec3(9, 0.1, 6), count: 1, interval: 14.4, endless: true, archetypes: ['rifleman'] },
        {
          spawn: vec3(-9, 0.1, -6),
          post: vec3(-9, 0.1, -6),
          count: 1,
          interval: 17.6,
          delay: 5,
          endless: true,
          archetypes: ['rifleman'],
        },
      ],
    },
  ],

  outro: '貨櫃場清空。他們說是十二個非正規軍。',
};

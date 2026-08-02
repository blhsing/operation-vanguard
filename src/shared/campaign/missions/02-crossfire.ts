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
  name: 'Ash and Stone',
  mapId: 'crossfire',
  brief:
    'The village sits on the only road north. It has changed hands four times ' +
    'this month and nobody has held the square for longer than a day.',
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
      label: 'Take the west approach',
      line: 'Reyes: Left side. If we go up the middle they will cut us in half.',
      trigger: { kind: 'reach', zone: { center: vec3(-29, 0, 16), size: vec3(10, 5, 10) } },
      waves: [
        { spawn: vec3(-31, 0.1, -12), post: vec3(-31, 0.1, -12), count: 3, interval: 5.6, archetypes: ['rifleman', 'rusher'] },
      ],
      checkpoint: true,
    },
    {
      id: 'square',
      label: 'Break the garrison in the square',
      after: ['west'],
      line: 'Okafor: They are dug in around the fountain. Say when.',
      trigger: { kind: 'eliminate', count: 5 },
      waves: [
        { spawn: vec3(0, 0.1, -18), post: vec3(0, 0.1, -18), count: 4, interval: 4.8, archetypes: ['rifleman'] },
        { spawn: vec3(29, 0.1, -24), post: vec3(29, 0.1, -24), count: 3, interval: 6.4, delay: 5, archetypes: ['rusher'] },
      ],
      checkpoint: true,
    },
    {
      id: 'hold',
      label: 'Hold the square',
      after: ['square'],
      line: 'Command: Armour is coming up the road. Hold the square until it does.',
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
      label: 'Clear the north road',
      after: ['hold'],
      line: 'Reyes: Road is open. Let us go and look at it.',
      trigger: { kind: 'reach', zone: { center: vec3(0, 0, -34), size: vec3(14, 5, 12) } },
      waves: [{ spawn: vec3(-29, 0.1, -25), post: vec3(-29, 0.1, -25), count: 2, interval: 6.4, archetypes: ['sniper', 'rifleman'] }],
    },
  ],

  outro: 'Village is ours. Give it a day.',
};

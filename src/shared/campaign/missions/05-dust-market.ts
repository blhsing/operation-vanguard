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
  name: 'Noon',
  mapId: 'dust_market',
  brief:
    'They move their money through the market at midday, in the open, because ' +
    'nobody has ever been stupid enough to come and take it at midday, in the open.',
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
      label: 'Fight through the market',
      line: 'Nasser: Stalls give you cover from exactly one direction. Pick it carefully.',
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
      label: 'Clear the colonnade',
      after: ['market'],
      line: 'Lindqvist: West side. I have an angle from the arches if you can get me there.',
      trigger: { kind: 'reach', zone: { center: vec3(-28, 0, 14), size: vec3(12, 6, 12) } },
      waves: [{ spawn: vec3(-38, 0.1, -22), post: vec3(-38, 0.1, -22), count: 3, interval: 5.6, archetypes: ['rifleman', 'sniper'] }],
      checkpoint: true,
    },
    {
      id: 'terrace',
      label: 'Take the roof terrace',
      after: ['colonnade'],
      line: 'Nasser: Stairs are on the far side. It is a long way round and there is no other way.',
      trigger: { kind: 'reach', zone: { center: vec3(28, 6.75, 6), size: vec3(16, 5, 22) } },
      waves: [
        { spawn: vec3(28, 6.85, -2), post: vec3(28, 6.85, -2), count: 2, interval: 6.4, archetypes: ['rifleman'] },
        { spawn: vec3(39, 0.1, -12), post: vec3(39, 0.1, -12), count: 2, interval: 6.4, delay: 4, archetypes: ['rusher'] },
      ],
      checkpoint: true,
    },
    {
      id: 'hold',
      label: 'Hold the terrace for extraction',
      after: ['terrace'],
      line: 'Command: Rooftop is the LZ. Everything that wants it has to use the stairs.',
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

  outro: 'Money is on the bird. So, remarkably, are we.',
};

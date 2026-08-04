/**
 * The dedicated server.
 *
 * A thin shell: it owns a WebSocket listener and hands every frame to a
 * `GameServer`, which is where all the actual authority lives. Keeping the
 * transport out of the room is what lets the test suite drive the same code
 * with no sockets at all.
 *
 *   npm run server                      # crossfire / tdm, 6 bots, port 8790
 *   npm run server -- --map subway --mode domination --bots 8 --port 9000
 */

import { WebSocketServer, type WebSocket } from 'ws';

import { NET, TICK_DT } from '../shared/constants.js';
import { MAP_IDS } from '../shared/map/index.js';
import { MODE_IDS } from '../shared/data/modes.js';
import {
  NetMessage,
  decodeControl,
  peekType,
  type HelloPayload,
} from '../shared/net/protocol.js';
import type { PlayerId } from '../shared/types.js';
import { GameServer, type ClientLink } from './game-server.js';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const mapId = arg('map', 'crossfire');
const modeId = arg('mode', 'tdm');
const port = Number(arg('port', String(NET.defaultPort)));
const botCount = Number(arg('bots', '6'));

if (!MAP_IDS.includes(mapId)) {
  console.error(`unknown map "${mapId}"; one of: ${MAP_IDS.join(', ')}`);
  process.exit(1);
}
if (!MODE_IDS.includes(modeId)) {
  console.error(`unknown mode "${modeId}"; one of: ${MODE_IDS.join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

const game = new GameServer({ mapId, modeId, botCount });
const wss = new WebSocketServer({ port });

/** Sockets that have connected but not yet said hello. */
const pending = new Set<WebSocket>();
const bySocket = new Map<WebSocket, PlayerId>();

wss.on('connection', (socket) => {
  socket.binaryType = 'nodebuffer';
  pending.add(socket);

  const link: ClientLink = {
    send: (bytes) => {
      if (socket.readyState === socket.OPEN) socket.send(bytes);
    },
    close: (reason) => socket.close(1000, reason.slice(0, 120)),
  };

  socket.on('message', (raw: Buffer) => {
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

    const known = bySocket.get(socket);
    if (known !== undefined) {
      game.receive(known, bytes);
      return;
    }

    // Nothing but a hello is accepted before the handshake completes: a client
    // that could send inputs first would be moving a player that does not exist.
    if (peekType(bytes) !== NetMessage.Hello) {
      socket.close(1002, 'expected hello');
      return;
    }

    try {
      const { payload } = decodeControl<HelloPayload>(bytes);
      const id = game.join(link, payload);
      if (id !== null) {
        pending.delete(socket);
        bySocket.set(socket, id);
        console.log(`+ ${payload.name} joined as ${id} (${game.playerCount} playing)`);
      }
    } catch {
      socket.close(1002, 'malformed hello');
    }
  });

  const drop = (): void => {
    pending.delete(socket);
    const id = bySocket.get(socket);
    if (id === undefined) return;
    bySocket.delete(socket);
    game.leave(id);
    console.log(`- ${id} left (${game.playerCount} playing)`);
  };

  socket.on('close', drop);
  socket.on('error', drop);
});

// ---------------------------------------------------------------------------
// The tick loop
// ---------------------------------------------------------------------------

/*
 * A fixed step driven by an accumulator against the real clock, not a bare
 * setInterval.
 *
 * `setInterval` drifts, and a server whose tick rate drifts is a server whose
 * weapon timing quietly disagrees with every client's prediction. The catch-up
 * is capped for the same reason it is capped in the browser: a process that has
 * been descheduled for a second must not then simulate a second of movement in
 * one burst.
 */
const MAX_CATCH_UP = 5;
let last = performance.now();
let accumulator = 0;

const timer = setInterval(() => {
  const now = performance.now();
  accumulator += (now - last) / 1000;
  last = now;

  let steps = 0;
  while (accumulator >= TICK_DT && steps < MAX_CATCH_UP) {
    game.tick(TICK_DT);
    accumulator -= TICK_DT;
    steps++;
  }
  if (steps === MAX_CATCH_UP) accumulator = 0;
}, Math.max(1, Math.floor((TICK_DT * 1000) / 2)));

console.log(
  `Operation Vanguard server on :${port}  —  ${mapId} / ${modeId}, ` +
    `${botCount} bots, protocol ${NET.protocolVersion}`,
);

function shutdown(): void {
  clearInterval(timer);
  for (const socket of [...pending, ...bySocket.keys()]) {
    socket.close(1001, 'server shutting down');
  }
  game.dispose();
  wss.close(() => process.exit(0));
  // Do not hang forever on a socket that will not close.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

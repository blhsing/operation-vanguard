/**
 * Smoke-test the dedicated server over a real socket.
 *
 * The unit tests drive `GameServer` in-process with fake links, which proves the
 * room is right and proves nothing about the process around it — argument
 * parsing, the WebSocket listener, the handshake, binary framing over a real
 * transport, or whether the tick loop actually ticks. This starts the server as
 * a child process, connects two clients to it, plays for a few seconds and
 * checks they both see a moving world.
 *
 *   npm run verify:server
 */

import { spawn } from 'node:child_process';
import WebSocket from 'ws';

import { NET, TICK_DT } from '../src/shared/constants.js';
import {
  NetMessage,
  decodeControl,
  decodeSnapshot,
  encodeControl,
  encodeInputs,
  peekType,
  type Snapshot,
  type WelcomePayload,
} from '../src/shared/net/protocol.js';
import { defaultLoadout } from '../src/shared/sim/loadout.js';

const PORT = 8799;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = spawn(
  process.execPath,
  ['--import', 'tsx', 'src/server/main.ts', '--port', String(PORT), '--bots', '4'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

let serverLog = '';
server.stdout.on('data', (d: Buffer) => (serverLog += d.toString()));
server.stderr.on('data', (d: Buffer) => (serverLog += d.toString()));

function bail(message: string): never {
  server.kill();
  console.error(`${message}\n--- server output ---\n${serverLog.trim()}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------

class TestClient {
  readonly snapshots: Snapshot[] = [];
  welcome: WelcomePayload | null = null;
  private seq = 1;

  private constructor(private readonly ws: WebSocket, readonly label: string) {}

  static async connect(label: string): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.binaryType = 'nodebuffer';
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const client = new TestClient(ws, label);
    ws.on('message', (raw: Buffer) => {
      const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      switch (peekType(bytes)) {
        case NetMessage.Welcome:
          client.welcome = decodeControl<WelcomePayload>(bytes).payload;
          break;
        case NetMessage.Snapshot:
          client.snapshots.push(decodeSnapshot(bytes));
          break;
        case NetMessage.Reject:
          bail(`${label} rejected: ${JSON.stringify(decodeControl(bytes).payload)}`);
          break;
        default:
          break;
      }
    });

    ws.send(
      encodeControl(NetMessage.Hello, {
        protocolVersion: NET.protocolVersion,
        name: label,
        loadout: defaultLoadout(),
      }),
    );
    return client;
  }

  /**
   * Hold forward, in real time.
   *
   * Deliberately not as fast as possible. The server ticks against the wall
   * clock, so a client that fires three seconds of input in two hundred
   * milliseconds is not playing for three seconds — it is queueing, and the
   * snapshot count that comes back measures the test's sleep pattern rather
   * than the server's tick rate.
   */
  async runForward(seconds: number): Promise<void> {
    const stepMs = TICK_DT * 1000;
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      this.ws.send(
        encodeInputs([
          {
            seq: this.seq++,
            tick: this.seq,
            dt: TICK_DT,
            moveForward: 1,
            moveRight: 0,
            yaw: 0,
            pitch: 0,
            buttons: 0,
            weaponSlot: 0,
          },
        ]),
      );
      await sleep(stepMs);
    }
  }

  close(): void {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------

await sleep(2500); // let tsx compile and the listener bind
if (server.exitCode !== null) bail(`server exited early with code ${server.exitCode}`);

const alice = await TestClient.connect('Alice');
const bob = await TestClient.connect('Bob');
await sleep(600);

if (!alice.welcome) bail('Alice never got a welcome');
if (!bob.welcome) bail('Bob never got a welcome');
if (alice.welcome.yourId === bob.welcome.yourId) bail('both clients got the same player id');

console.log(
  `handshake  ${alice.welcome.mapId}/${alice.welcome.modeId}  ` +
    `tick ${alice.welcome.tickRate} Hz, snapshots ${alice.welcome.snapshotRate} Hz  ` +
    `ids ${alice.welcome.yourId} and ${bob.welcome.yourId}`,
);

const before = alice.snapshots.length;
await alice.runForward(3);
await sleep(500);

const received = alice.snapshots.length - before;
const latest = alice.snapshots.at(-1);
if (!latest) bail('no snapshots arrived');

// Both humans plus the four bots.
const expectedPlayers = 6;
if (latest.players.length !== expectedPlayers) {
  bail(`expected ${expectedPlayers} players in the snapshot, got ${latest.players.length}`);
}
if (latest.ackedInput === 0) bail('the server never acknowledged an input');

const me = latest.players.find((p) => p.id === alice.welcome!.yourId);
if (!me) bail('Alice is not in her own snapshot');

// Bob sees Alice too, and at the same place — that is the whole point.
const bobsView = bob.snapshots.at(-1)?.players.find((p) => p.id === alice.welcome!.yourId);
if (!bobsView) bail('Bob cannot see Alice');
const disagreement = Math.hypot(bobsView.x - me.x, bobsView.z - me.z);

console.log(
  `play       ${received} snapshots in 3s  acked input ${latest.ackedInput}  ` +
    `tick ${latest.tick}  ${latest.players.length} players`,
);
console.log(
  `agreement  Alice at (${me.x.toFixed(1)}, ${me.z.toFixed(1)}); ` +
    `Bob sees her ${disagreement.toFixed(2)}m away`,
);

// Three seconds at the snapshot rate, with slack for scheduling jitter and the
// fact that timers on Windows are not precise.
const expectedSnapshots = NET.snapshotRate * 3 * 0.6;
if (received < expectedSnapshots) {
  bail(`only ${received} snapshots in 3 seconds, expected around ${NET.snapshotRate * 3}`);
}
// They may be one snapshot apart in time, which at sprint speed is a fraction
// of a metre. Anything larger means they are not looking at the same world.
if (disagreement > 2) bail(`the two clients disagree about where Alice is by ${disagreement}m`);

alice.close();
bob.close();
await sleep(300);
server.kill();

console.log('clean      two clients, one authoritative world');

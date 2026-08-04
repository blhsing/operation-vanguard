/**
 * Drive the standalone build in real Chrome, from a `file://` URL.
 *
 * Loading the document proves the script and stylesheet resolved off the disk;
 * it does not prove the game runs. This starts an actual match through the menu,
 * lets it simulate, and reports what the renderer and the simulation are doing —
 * over the DevTools protocol, because there is no other way to script a page
 * Chrome will not let anything else reach.
 *
 * It also, incidentally, proves the sibling files loaded: nothing renders if the
 * stylesheet 404s and nothing happens at all if the script does.
 *
 *   npm run verify:standalone
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error('no Chrome found; set one of the paths in this file');

const file = resolve('offline/index.html');
if (!existsSync(file)) throw new Error('build it first: npm run build:standalone');

const profile = resolve('.verify/cdp');
rmSync(profile, { recursive: true, force: true });
mkdirSync(profile, { recursive: true });

const PORT = 9333;
const proc = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    // Software WebGL, so this works on a machine with no usable GPU.
    '--enable-unsafe-swiftshader',
    '--window-size=1280,800',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    `file://${file.replace(/\\/g, '/')}`,
  ],
  { stdio: 'ignore' },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function target(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('file://'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('Chrome never exposed a debuggable page');
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.once('open', r));

let nextId = 1;
const pending = new Map<number, (v: unknown) => void>();
const consoleErrors: string[] = [];

ws.on('message', (raw: Buffer) => {
  const msg = JSON.parse(raw.toString()) as {
    id?: number;
    method?: string;
    result?: unknown;
    params?: { exceptionDetails?: { text?: string }; entry?: { level: string; text: string } };
  };
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.result);
    pending.delete(msg.id);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params?.exceptionDetails as
      | { text?: string; exception?: { description?: string; className?: string; value?: unknown } }
      | undefined;
    // The bare `text` is usually just "Uncaught (in promise)". What the thing
    // actually was lives on the exception object.
    consoleErrors.push(
      [d?.text, d?.exception?.description, d?.exception?.className, JSON.stringify(d?.exception?.value)]
        .filter((x) => x && x !== 'undefined')
        .join(' :: '),
    );
  }
  if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
    consoleErrors.push(msg.params.entry.text);
  }
});

function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r));
}

async function evaluate<T>(expression: string): Promise<T> {
  const res = (await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: T }; exceptionDetails?: { text: string } };
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
  return res.result?.value as T;
}

await send('Runtime.enable');
await send('Log.enable');
await sleep(2500);

// --- boot -------------------------------------------------------------------

const boot = await evaluate<{ title: string; protocol: string; buttons: number }>(`
  ({ title: document.title, protocol: location.protocol,
     buttons: document.querySelectorAll('.menu-btn').length })
`);
console.log(`loaded  ${boot.protocol}  "${boot.title}"  ${boot.buttons} menu buttons`);
if (boot.protocol !== 'file:') throw new Error(`expected a file:// origin, got ${boot.protocol}`);
if (boot.buttons === 0) throw new Error('the menu never rendered');

// --- start a match ----------------------------------------------------------

/**
 * Clicked by label, not by selector.
 *
 * The menu is built in code and its classes are an implementation detail, but
 * the two labels a player reads to get into a match are the contract. They are
 * Chinese now, which is the point: if the localisation ever regressed to English
 * this verification would stop finding them, which is a signal and not a
 * nuisance.
 */
async function clickLabelled(label: string): Promise<void> {
  const hit = await evaluate<boolean>(`
    (() => {
      const b = [...document.querySelectorAll('button')]
        .filter((el) => el.offsetParent !== null)
        .find((el) => el.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return false;
      b.click();
      return true;
    })()
  `);
  if (!hit) {
    const seen = await evaluate<string[]>(
      `[...document.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => b.textContent.trim())`,
    );
    throw new Error(`no visible button labelled "${label}"; visible: ${seen.join(' | ')}`);
  }
}

await clickLabelled('開始遊戲');
await sleep(500);
await clickLabelled('開始對戰');
await sleep(10000);

/*
 * Observed from the outside, deliberately.
 *
 * `window.__vanguard` is a development-only handle and a production bundle does
 * not have one, so a check that reaches for it passes in dev and fails on the
 * artefact people actually run. Everything below is what a player can see: the
 * canvas has a WebGL context, the HUD is populated, the ammo counter is counting
 * something, and the picture is not a single flat colour.
 */
const match = await evaluate<{
  canvas: boolean;
  webgl: boolean;
  width: number;
  height: number;
  hudNodes: number;
  ammo: string;
  bootGone: boolean;
}>(`
  (() => {
    const canvas = document.querySelector('canvas');
    const hud = document.querySelector('.hud');
    const ammo = document.querySelector('.hud-ammo-current');
    let webgl = false;
    try { webgl = !!(canvas && (canvas.getContext('webgl2') || canvas.getContext('webgl'))); } catch {}
    return {
      canvas: !!canvas,
      webgl,
      width: canvas ? canvas.width : 0,
      height: canvas ? canvas.height : 0,
      hudNodes: hud ? hud.querySelectorAll('*').length : 0,
      ammo: ammo ? ammo.textContent.trim() : '',
      bootGone: !document.getElementById('boot'),
    };
  })()
`);

console.log(
  `match   canvas ${match.width}x${match.height}  webgl ${match.webgl}  ` +
    `hud ${match.hudNodes} nodes  ammo "${match.ammo}"  boot cleared ${match.bootGone}`,
);

if (!match.canvas) throw new Error('no canvas — the match never started');
if (!match.webgl) throw new Error('the canvas has no WebGL context');
if (match.hudNodes < 20) throw new Error('the HUD never populated');
if (!/^[0-9]+$/.test(match.ammo)) throw new Error(`ammo counter reads "${match.ammo}"`);

const shot = (await send('Page.captureScreenshot', { format: 'png' })) as { data: string };
const png = Buffer.from(shot.data, 'base64');
writeFileSync('.verify/standalone-match.png', png);

// A WebGL canvas that failed to draw is a uniform rectangle, and a uniform
// rectangle compresses to almost nothing. This is a crude check and it is the
// one that catches "the context exists and renders black".
if (png.length < 24_000) {
  throw new Error(`the frame is ${png.length} bytes — almost certainly a blank canvas`);
}

/*
 * Pointer lock is the one expected complaint, and audio would be the other.
 * Both require a real user gesture, and a scripted click is not one — so a
 * headless run always sees `NotAllowedError: A user gesture is required to
 * request Pointer Lock`. That is the harness's limitation, not the bundle's.
 *
 * Everything filtered is printed anyway. A verification that quietly swallows
 * errors is not a verification.
 */
const BENIGN = /favicon|AudioContext|user gesture|not allowed to start|play\(\) failed/i;
const fatal = consoleErrors.filter((e) => !BENIGN.test(e));
const ignored = consoleErrors.filter((e) => BENIGN.test(e));
if (ignored.length > 0) console.log(`ignored ${ignored.length}: ${ignored.join(' / ').slice(0, 200)}`);
if (fatal.length > 0) throw new Error(`console errors:\n  ${fatal.join('\n  ')}`);

console.log('clean   no console errors');
console.log('shot    .verify/standalone-match.png');

/*
 * The other file somebody is going to double-click.
 *
 * Everything above verifies offline/index.html, which is the file that works.
 * The file at the top of a fresh clone is index.html, it is the obvious one to
 * open, and from a file:// origin it is a dead end: it points at TypeScript that
 * only a dev server can transform, so Chrome refuses the module script and the
 * boot screen sits at 引擎初始化中… for ever with the explanation in a console
 * nobody has open.
 *
 * There is a guard in that file to say so. It shipped broken and stayed broken
 * for five milestones — it queried for the module script from an inline script
 * above it, so the node did not exist yet and the test was false every time.
 * Nothing noticed, because every check that existed pointed at the offline copy,
 * where the guard has been deliberately deleted. The build asserted the block was
 * absent; the browser harness loaded the file it is absent from. Two checks, both
 * green, neither of them looking at the thing that was broken.
 *
 * So the harness now opens the entry a person opens.
 */
const sourceEntry = resolve('index.html');
await send('Page.enable');
// This page is *expected* to log a CORS refusal — that is the condition being
// detected, not a failure — so the error tally above is closed out first.
consoleErrors.length = 0;
await send('Page.navigate', { url: `file://${sourceEntry.replace(/\\/g, '/')}` });
await sleep(2500);

const guard = await evaluate<{ fired: boolean; pointsAtOffline: boolean; stillSpinning: boolean }>(`
  (() => {
    const err = document.querySelector('#boot .boot-error');
    return {
      fired: !!err,
      pointsAtOffline: !!err && err.textContent.includes('offline/index.html'),
      stillSpinning: !!document.getElementById('boot-status'),
    };
  })()
`);

if (!guard.fired || guard.stillSpinning) {
  throw new Error(
    'index.html opened from file:// still hangs on the boot screen — the double-click dead end is back',
  );
}
if (!guard.pointsAtOffline) {
  throw new Error('the source-entry guard fired but never says to open offline/index.html');
}
console.log('source  index.html from file:// explains itself and points at offline/');

ws.close();
proc.kill();

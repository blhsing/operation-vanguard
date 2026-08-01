/**
 * Bootstrap and shell.
 *
 * Owns everything outside a live match: the main menu, the settings screens, the
 * pause menu and the post-match summary. It creates a `GameClient` when a match
 * starts and destroys it when one ends, so a long session can't accumulate state
 * from previous matches.
 *
 * Deliberately plain DOM. A framework here would be a dependency, a build-size
 * cost and an extra abstraction for perhaps a dozen screens that mostly consist
 * of a list of settings.
 */

import './styles.css';

import { MAP_IDS, getMap } from '@shared/map/index.js';
import { MULTIPLAYER_MODE_IDS, getMode } from '@shared/data/modes.js';
import { Team } from '@shared/types.js';
import { defaultLoadout, type Loadout } from '@shared/sim/loadout.js';
import { DIFFICULTIES } from '@shared/ai/bot.js';

import { GameClient, type ClientSettings, type MatchConfig } from './game-client.js';
import type { QualityTier } from './scene/world-renderer.js';
import { getAudioEngine } from './audio/index.js';
import { loadProfile, saveProfile, type Profile } from './profile.js';

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const app = document.getElementById('app');
if (!app) throw new Error('#app is missing from the document');

const boot = document.getElementById('boot');
const bootProgress = document.getElementById('boot-progress');
const bootStatus = document.getElementById('boot-status');

function setBootProgress(fraction: number, status: string): void {
  if (bootProgress) bootProgress.style.width = `${Math.round(fraction * 100)}%`;
  if (bootStatus) bootStatus.textContent = status;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let profile: Profile = loadProfile();
let client: GameClient | null = null;

const canvas = document.createElement('canvas');
canvas.id = 'game';
app.appendChild(canvas);

const hudLayer = document.createElement('div');
hudLayer.id = 'hud-layer';
app.appendChild(hudLayer);

const menuLayer = document.createElement('div');
menuLayer.id = 'menu-layer';
app.appendChild(menuLayer);

function currentSettings(): ClientSettings {
  // The profile already stores complete settings objects.
  return {
    input: profile.settings.input,
    render: profile.settings.render,
    hud: profile.settings.hud,
    masterVolume: profile.settings.masterVolume,
    sfxVolume: profile.settings.sfxVolume,
    musicVolume: profile.settings.musicVolume,
  };
}

// ---------------------------------------------------------------------------
// Menu plumbing
// ---------------------------------------------------------------------------

type ScreenId = 'main' | 'play' | 'loadout' | 'settings' | 'pause' | 'results' | 'controls';

const screens = new Map<ScreenId, HTMLElement>();
let activeScreen: ScreenId | null = null;

function showScreen(id: ScreenId | null): void {
  for (const [key, el] of screens) {
    el.hidden = key !== id;
  }
  activeScreen = id;
  menuLayer.style.pointerEvents = id ? 'auto' : 'none';
  document.body.style.cursor = id ? 'default' : 'none';
}

function makeScreen(id: ScreenId, title: string, subtitle: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'menu';
  el.hidden = true;
  el.innerHTML = `
    <div class="menu-header">
      <h1 class="menu-title">${title}</h1>
      <p class="menu-subtitle">${subtitle}</p>
    </div>
    <div class="menu-body"></div>
    <div class="menu-footer"><span class="menu-hintbar"></span></div>
  `;
  menuLayer.appendChild(el);
  screens.set(id, el);
  return el;
}

function body(el: HTMLElement): HTMLElement {
  return el.querySelector<HTMLElement>('.menu-body')!;
}

function footer(el: HTMLElement): HTMLElement {
  return el.querySelector<HTMLElement>('.menu-footer')!;
}

function button(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'menu-btn' + (primary ? ' is-primary' : '');
  b.textContent = label;
  b.addEventListener('click', () => {
    getAudioEngine().playUi('click');
    onClick();
  });
  b.addEventListener('mouseenter', () => getAudioEngine().playUi('hover'));
  return b;
}

function panel(title: string): HTMLElement {
  const p = document.createElement('div');
  p.className = 'menu-panel';
  p.innerHTML = `<h2>${title}</h2>`;
  return p;
}

// --- field builders --------------------------------------------------------

function fieldRow(label: string, hint?: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field';
  row.innerHTML = `<label>${label}</label>`;
  if (hint) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = hint;
    row.appendChild(h);
  }
  return row;
}

function sliderField(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  format: (v: number) => string,
  onChange: (v: number) => void,
  hint?: string,
): HTMLElement {
  const row = fieldRow(label, hint);
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);

  const out = document.createElement('span');
  out.className = 'value';
  out.textContent = format(value);

  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = format(v);
    onChange(v);
  });

  row.insertBefore(input, row.querySelector('.hint'));
  row.insertBefore(out, row.querySelector('.hint'));
  return row;
}

function selectField<T extends string>(
  label: string,
  value: T,
  options: Array<{ value: T; label: string }>,
  onChange: (v: T) => void,
  hint?: string,
): HTMLElement {
  const row = fieldRow(label, hint);
  const select = document.createElement('select');
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    if (opt.value === value) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener('change', () => onChange(select.value as T));
  row.insertBefore(select, row.querySelector('.hint'));
  row.insertBefore(document.createElement('span'), row.querySelector('.hint'));
  return row;
}

function toggleField(
  label: string,
  value: boolean,
  onChange: (v: boolean) => void,
  hint?: string,
): HTMLElement {
  const row = fieldRow(label, hint);
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  row.insertBefore(input, row.querySelector('.hint'));
  row.insertBefore(document.createElement('span'), row.querySelector('.hint'));
  return row;
}

function textField(
  label: string,
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const row = fieldRow(label);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.maxLength = 20;
  input.addEventListener('change', () => onChange(input.value.trim() || 'Player'));
  row.appendChild(input);
  row.appendChild(document.createElement('span'));
  return row;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function buildMainMenu(): void {
  const screen = makeScreen('main', 'OPERATION VANGUARD', 'Browser-native tactical shooter');
  const b = body(screen);

  const nav = document.createElement('div');
  nav.className = 'menu-nav';
  nav.appendChild(button('Play', () => showScreen('play'), true));
  nav.appendChild(button('Loadout', () => { buildLoadoutScreen(); showScreen('loadout'); }));
  nav.appendChild(button('Settings', () => { buildSettingsScreen(); showScreen('settings'); }));
  nav.appendChild(button('Controls', () => { buildControlsScreen(); showScreen('controls'); }));
  b.appendChild(nav);

  const info = panel('Briefing');
  info.innerHTML += `
    <p style="color:var(--ink-dim);line-height:1.7;font-size:13px;max-width:52ch">
      A full multiplayer shooter that runs entirely in your browser. No downloads,
      no plugins, and not a single binary asset — every texture, weapon model,
      sound and map is generated from code at runtime.
    </p>
    <div class="field"><label>Rank</label><span></span><span class="value">${profile.rank}</span></div>
    <div class="field"><label>Career kills</label><span></span><span class="value">${profile.stats.kills}</span></div>
    <div class="field"><label>Matches played</label><span></span><span class="value">${profile.stats.matches}</span></div>
  `;
  b.appendChild(info);
}

function buildPlayScreen(): void {
  const screen = makeScreen('play', 'PLAY', 'Configure the match');
  const b = body(screen);
  b.innerHTML = '';

  const nav = document.createElement('div');
  nav.className = 'menu-nav';
  nav.appendChild(button('Start match', () => startMatch(), true));
  nav.appendChild(button('Back', () => showScreen('main')));
  b.appendChild(nav);

  const p = panel('Match setup');

  p.appendChild(
    selectField(
      'Map',
      profile.lastMatch.mapId,
      MAP_IDS.map((id) => ({ value: id, label: getMap(id).name })),
      (v) => {
        profile.lastMatch.mapId = v;
        saveProfile(profile);
      },
    ),
  );

  p.appendChild(
    selectField(
      'Mode',
      profile.lastMatch.modeId,
      MULTIPLAYER_MODE_IDS.map((id) => ({ value: id, label: getMode(id).name })),
      (v) => {
        profile.lastMatch.modeId = v;
        saveProfile(profile);
      },
    ),
  );

  p.appendChild(
    sliderField(
      'Bots',
      profile.lastMatch.botCount,
      1,
      17,
      1,
      (v) => String(v),
      (v) => {
        profile.lastMatch.botCount = v;
        saveProfile(profile);
      },
      'More bots means a busier match and a heavier CPU load.',
    ),
  );

  p.appendChild(
    selectField(
      'Bot difficulty',
      profile.lastMatch.difficulty,
      Object.keys(DIFFICULTIES).map((k) => ({ value: k, label: DIFFICULTIES[k]!.name })),
      (v) => {
        profile.lastMatch.difficulty = v;
        saveProfile(profile);
      },
      'Difficulty changes reaction time and aim, never damage.',
    ),
  );

  p.appendChild(
    textField('Callsign', profile.name, (v) => {
      profile.name = v;
      saveProfile(profile);
    }),
  );

  b.appendChild(p);
}

function buildSettingsScreen(): void {
  screens.get('settings')?.remove();
  screens.delete('settings');

  const screen = makeScreen('settings', 'SETTINGS', 'Video, audio and gameplay');
  const b = body(screen);

  const nav = document.createElement('div');
  nav.className = 'menu-nav';
  nav.appendChild(button('Back', () => showScreen(client ? 'pause' : 'main')));
  b.appendChild(nav);

  const wrap = document.createElement('div');

  // --- video --------------------------------------------------------------
  const video = panel('Video');
  const r = profile.settings.render;

  video.appendChild(
    sliderField('Field of view', r.fov, 65, 120, 1, (v) => `${v}°`, (v) => {
      r.fov = v;
      applyLiveSettings();
    }, 'Higher values show more of the world and make targets smaller.'),
  );

  video.appendChild(
    selectField<QualityTier>(
      'Quality',
      r.quality,
      [
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'ultra', label: 'Ultra' },
      ],
      (v) => {
        r.quality = v;
        applyLiveSettings();
      },
    ),
  );

  video.appendChild(
    sliderField('Render scale', r.resolutionScale, 0.5, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => {
      r.resolutionScale = v;
      applyLiveSettings();
    }, 'The cheapest way to gain frames on a slow machine.'),
  );

  video.appendChild(toggleField('Shadows', r.shadows, (v) => { r.shadows = v; applyLiveSettings(); }));
  video.appendChild(toggleField('Show FPS', r.showFps, (v) => { r.showFps = v; applyLiveSettings(); }));
  video.appendChild(
    sliderField('Brightness', r.brightness, 0.6, 1.6, 0.05, (v) => v.toFixed(2), (v) => {
      r.brightness = v;
      applyLiveSettings();
    }),
  );
  wrap.appendChild(video);

  // --- audio --------------------------------------------------------------
  const audio = panel('Audio');
  audio.appendChild(
    sliderField('Master', profile.settings.masterVolume, 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => {
      profile.settings.masterVolume = v;
      applyLiveSettings();
    }),
  );
  audio.appendChild(
    sliderField('Effects', profile.settings.sfxVolume, 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => {
      profile.settings.sfxVolume = v;
      applyLiveSettings();
    }),
  );
  audio.appendChild(
    sliderField('Music', profile.settings.musicVolume, 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => {
      profile.settings.musicVolume = v;
      applyLiveSettings();
    }),
  );
  wrap.appendChild(audio);

  // --- gameplay -----------------------------------------------------------
  const gameplay = panel('Gameplay');
  const inp = profile.settings.input;

  gameplay.appendChild(
    sliderField('Mouse sensitivity', inp.sensitivity, 0.1, 4, 0.05, (v) => v.toFixed(2), (v) => {
      inp.sensitivity = v;
      applyLiveSettings();
    }),
  );
  gameplay.appendChild(
    sliderField('ADS sensitivity', inp.adsSensitivityScale, 0.2, 1.5, 0.05, (v) => v.toFixed(2), (v) => {
      inp.adsSensitivityScale = v;
      applyLiveSettings();
    }, 'Relative to hipfire sensitivity while aiming.'),
  );
  gameplay.appendChild(toggleField('Invert vertical look', inp.invertY, (v) => { inp.invertY = v; applyLiveSettings(); }));
  gameplay.appendChild(toggleField('Toggle aim', inp.toggleAds, (v) => { inp.toggleAds = v; applyLiveSettings(); }));
  gameplay.appendChild(toggleField('Toggle crouch', inp.toggleCrouch, (v) => { inp.toggleCrouch = v; applyLiveSettings(); }));
  gameplay.appendChild(toggleField('Automatic sprint', inp.autoSprint, (v) => { inp.autoSprint = v; applyLiveSettings(); }));
  wrap.appendChild(gameplay);

  // --- accessibility ------------------------------------------------------
  const access = panel('Accessibility');
  const h = profile.settings.hud;
  access.appendChild(
    selectField(
      'Colourblind mode',
      h.colorblindMode,
      [
        { value: 'off' as const, label: 'Off' },
        { value: 'protanopia' as const, label: 'Protanopia' },
        { value: 'deuteranopia' as const, label: 'Deuteranopia' },
        { value: 'tritanopia' as const, label: 'Tritanopia' },
      ],
      (v) => {
        h.colorblindMode = v;
        applyLiveSettings();
      },
      'Remaps the friend/foe colours, the one distinction the game depends on.',
    ),
  );
  access.appendChild(
    sliderField('HUD scale', h.hudScale, 0.75, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => {
      h.hudScale = v;
      applyLiveSettings();
    }),
  );
  access.appendChild(toggleField('Show crosshair', h.showCrosshair, (v) => { h.showCrosshair = v; applyLiveSettings(); }));
  access.appendChild(toggleField('Show minimap', h.showMinimap, (v) => { h.showMinimap = v; applyLiveSettings(); }));
  access.appendChild(toggleField('Show killfeed', h.showKillfeed, (v) => { h.showKillfeed = v; applyLiveSettings(); }));
  access.appendChild(toggleField('Show damage numbers', h.showDamageNumbers, (v) => { h.showDamageNumbers = v; applyLiveSettings(); }));
  wrap.appendChild(access);

  b.appendChild(wrap);

  const f = footer(screen);
  f.querySelector('.menu-hintbar')!.textContent = 'Changes apply immediately and are saved automatically';
}

function buildControlsScreen(): void {
  screens.get('controls')?.remove();
  screens.delete('controls');

  const screen = makeScreen('controls', 'CONTROLS', 'Default bindings');
  const b = body(screen);

  const nav = document.createElement('div');
  nav.className = 'menu-nav';
  nav.appendChild(button('Back', () => showScreen(client ? 'pause' : 'main')));
  b.appendChild(nav);

  const p = panel('Keyboard and mouse');
  const rows: Array<[string, string]> = [
    ['Move', 'W A S D'],
    ['Sprint', 'Shift'],
    ['Tactical sprint', 'Shift (tap twice)'],
    ['Jump / mantle', 'Space'],
    ['Crouch', 'Ctrl or C'],
    ['Slide', 'Ctrl while sprinting'],
    ['Prone', 'Z'],
    ['Fire', 'Left mouse'],
    ['Aim', 'Right mouse'],
    ['Reload', 'R'],
    ['Melee', 'V or middle mouse'],
    ['Swap weapon', '1 / 2'],
    ['Lethal', 'G'],
    ['Tactical', 'Q'],
    ['Field upgrade', 'X'],
    ['Killstreaks', '3 / 4 / 5'],
    ['Scoreboard', 'Tab (hold)'],
    ['Pause', 'Escape'],
  ];
  for (const [action, key] of rows) {
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `<label>${action}</label><span></span><span class="value">${key}</span>`;
    p.appendChild(row);
  }
  b.appendChild(p);

  const gp = panel('Gamepad');
  gp.innerHTML += `<p style="color:var(--ink-dim);font-size:13px;line-height:1.7">
    A connected controller is detected automatically and uses the standard
    layout: sticks to move and look, triggers to aim and fire, A to jump,
    B to crouch, X to reload, Y to swap, bumpers for equipment.
  </p>`;
  b.appendChild(gp);
}

function buildLoadoutScreen(): void {
  screens.get('loadout')?.remove();
  screens.delete('loadout');

  const screen = makeScreen('loadout', 'LOADOUT', 'Create a class');
  const b = body(screen);

  const nav = document.createElement('div');
  nav.className = 'menu-nav';
  nav.appendChild(button('Back', () => showScreen(client ? 'pause' : 'main')));
  b.appendChild(nav);

  const p = panel('Primary and secondary');
  void p;

  // The full class editor is built from the weapon and attachment tables; it is
  // rendered lazily here so the module graph for a first paint stays small.
  void import('./menus/loadout-editor.js').then(({ renderLoadoutEditor }) => {
    renderLoadoutEditor(b, profile, () => saveProfile(profile));
  });
}

function buildPauseScreen(): void {
  const screen = makeScreen('pause', 'PAUSED', 'Match in progress');
  const b = body(screen);

  const nav = document.createElement('div');
  nav.className = 'menu-nav';
  nav.appendChild(button('Resume', () => { showScreen(null); client?.resume(); }, true));
  nav.appendChild(button('Settings', () => { buildSettingsScreen(); showScreen('settings'); }));
  nav.appendChild(button('Controls', () => { buildControlsScreen(); showScreen('controls'); }));
  nav.appendChild(button('Quit to menu', () => endMatch()));
  b.appendChild(nav);
}

function buildResultsScreen(winner: Team | null): void {
  screens.get('results')?.remove();
  screens.delete('results');

  const screen = makeScreen('results', 'MATCH OVER', '');
  const b = body(screen);
  b.style.gridTemplateColumns = '1fr';

  const localTeam = client?.sim.world.players.get(client.localId)?.team ?? Team.None;
  const outcome =
    winner === null ? 'draw' : winner === localTeam || winner === Team.None ? 'victory' : 'defeat';

  const banner = document.createElement('div');
  banner.className = `result-banner ${outcome}`;
  banner.textContent = outcome === 'victory' ? 'VICTORY' : outcome === 'defeat' ? 'DEFEAT' : 'DRAW';
  b.appendChild(banner);

  const p = panel('Final scoreboard');
  const table = document.createElement('table');
  table.style.width = '100%';
  table.innerHTML =
    '<tr><th class="sb-name">PLAYER</th><th>SCORE</th><th>K</th><th>D</th><th>A</th></tr>';
  for (const player of client?.sim.scoreboard() ?? []) {
    const tr = document.createElement('tr');
    if (player.id === client?.localId) tr.className = 'is-local';
    tr.innerHTML =
      `<td class="sb-name">${player.name}</td><td>${player.score}</td>` +
      `<td>${player.kills}</td><td>${player.deaths}</td><td>${player.assists}</td>`;
    table.appendChild(tr);
  }
  p.appendChild(table);
  b.appendChild(p);

  const f = footer(screen);
  f.appendChild(button('Play again', () => { endMatch(); startMatch(); }, true));
  f.appendChild(button('Main menu', () => endMatch()));
}

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------

function startMatch(): void {
  endMatch(false);

  const config: MatchConfig = {
    mapId: profile.lastMatch.mapId,
    modeId: profile.lastMatch.modeId,
    botCount: profile.lastMatch.botCount,
    difficulty: profile.lastMatch.difficulty as keyof typeof DIFFICULTIES,
    playerName: profile.name,
    loadout: profile.loadouts[profile.activeLoadout] ?? defaultLoadout(),
  };

  showScreen(null);
  setBootProgress(0.4, 'Building map…');

  client = new GameClient(canvas, hudLayer, config, currentSettings());
  client.onPause = () => showScreen('pause');
  client.onMatchEnd = (winner) => {
    recordMatchStats();
    buildResultsScreen(winner);
    showScreen('results');
  };

  client.hud.setFpsVisible(profile.settings.render.showFps);
  client.start();

  // Audio needs a user gesture; the click that started the match is one.
  void getAudioEngine().resume();
  client.input.requestLock();

  if (boot) boot.style.display = 'none';

  // Dev-only handle. requestAnimationFrame does not fire in a headless or
  // hidden tab, so automated checks need a way to drive frames directly.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__vanguard = {
      client,
      profile,
      /** Advance the game by `frames` frames without relying on rAF. */
      step(frames = 1): void {
        for (let i = 0; i < frames; i++) {
          (client as unknown as { frame: (t: number) => void }).frame(
            performance.now() + i * 16.7,
          );
        }
      },
    };
  }
}

function endMatch(returnToMenu = true): void {
  if (client) {
    recordMatchStats();
    client.dispose();
    client = null;
  }
  if (returnToMenu) {
    // Rebuild the main menu so the career stats on it are current.
    screens.get('main')?.remove();
    screens.delete('main');
    buildMainMenu();
    showScreen('main');
  }
}

function recordMatchStats(): void {
  if (!client) return;
  const local = client.sim.world.players.get(client.localId);
  if (!local) return;

  profile.stats.kills += local.kills;
  profile.stats.deaths += local.deaths;
  profile.stats.assists += local.assists;
  profile.stats.score += local.score;
  profile.stats.matches += 1;
  profile.xp += local.score;

  // Rank up on a simple escalating curve.
  while (profile.rank < 55 && profile.xp >= xpForRank(profile.rank + 1)) {
    profile.rank++;
    getAudioEngine().playUi('levelup');
  }

  saveProfile(profile);
}

function xpForRank(rank: number): number {
  // Quadratic so early ranks come fast and later ones are a real commitment.
  return Math.round(900 * rank + 55 * rank * rank);
}

function applyLiveSettings(): void {
  saveProfile(profile);
  client?.applySettings(currentSettings());
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

setBootProgress(0.15, 'Loading systems…');

buildMainMenu();
buildPlayScreen();
buildPauseScreen();

setBootProgress(1, 'Ready');

// Give the boot screen a beat so it doesn't flash past unreadably fast.
window.setTimeout(() => {
  if (boot) boot.remove();
  showScreen('main');
}, 260);

// Pause automatically when the tab loses focus mid-match, rather than letting
// the player be shot while they are looking at something else.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && client?.state === 'playing') {
    client.togglePause();
  }
});

// Surface unexpected failures instead of leaving a black screen.
window.addEventListener('error', (e) => {
  console.error('[vanguard]', e.error ?? e.message);
});

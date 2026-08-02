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
import { MISSION_IDS, getMission } from '@shared/campaign/index.js';
import { PLAYABLE_MODE_IDS, ZOMBIES_MODE_ID, getMode } from '@shared/data/modes.js';
import { hasZombiesLayout } from '@shared/zombies/index.js';
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
  input.addEventListener('change', () => onChange(input.value.trim() || '玩家'));
  row.appendChild(input);
  row.appendChild(document.createElement('span'));
  return row;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function buildMainMenu(): void {
  const screen = makeScreen('main', '先鋒行動', '瀏覽器原生戰術射擊遊戲');
  const b = body(screen);

  const nav = document.createElement('div');
  nav.className = 'menu-nav';
  nav.appendChild(button('開始遊戲', () => showScreen('play'), true));
  nav.appendChild(button('配裝', () => { buildLoadoutScreen(); showScreen('loadout'); }));
  nav.appendChild(button('設定', () => { buildSettingsScreen(); showScreen('settings'); }));
  nav.appendChild(button('操作', () => { buildControlsScreen(); showScreen('controls'); }));
  b.appendChild(nav);

  const info = panel('簡報');
  info.innerHTML += `
    <p style="color:var(--ink-dim);line-height:1.7;font-size:13px;max-width:52ch">
      完全在瀏覽器中執行的多人射擊遊戲。不用下載、不用外掛，
      也沒有任何一個二進位資產——所有貼圖、武器模型、音效與地圖，
      都在執行時由程式碼生成。
    </p>
    <div class="field"><label>軍階</label><span></span><span class="value">${profile.rank}</span></div>
    <div class="field"><label>生涯擊殺</label><span></span><span class="value">${profile.stats.kills}</span></div>
    <div class="field"><label>對戰場數</label><span></span><span class="value">${profile.stats.matches}</span></div>
  `;
  b.appendChild(info);
}

function buildPlayScreen(): void {
  screens.get('play')?.remove();
  screens.delete('play');
  const screen = makeScreen('play', '開始遊戲', '設定本場對戰');
  const b = body(screen);
  b.innerHTML = '';

  const nav = document.createElement('div');
  nav.className = 'menu-nav';
  nav.appendChild(button('開始對戰', () => startMatch(), true));
  nav.appendChild(button('返回', () => showScreen('main')));
  b.appendChild(nav);

  const p = panel('對戰設定');

  const isCampaign = profile.lastMatch.modeId === 'campaign';

  // A mission brings its own map, so the campaign picks one instead of the other.
  if (isCampaign) {
    p.appendChild(
      selectField(
        '任務',
        profile.lastMatch.missionId,
        MISSION_IDS.map((id, i) => ({
          value: id,
          label: `${String(i + 1).padStart(2, '0')} · ${getMission(id).name}`,
        })),
        (v) => {
          profile.lastMatch.missionId = v;
          profile.lastMatch.mapId = getMission(v).mapId;
          saveProfile(profile);
          buildPlayScreen();
          showScreen('play');
        },
      ),
    );
  } else {
    p.appendChild(
      selectField(
        '地圖',
        profile.lastMatch.mapId,
        MAP_IDS.map((id) => ({ value: id, label: getMap(id).name })),
        (v) => {
          profile.lastMatch.mapId = v;
          saveProfile(profile);
          buildPlayScreen();
          showScreen('play');
        },
      ),
    );
  }

  // Zombies only appears for maps that actually have a layout authored for it.
  const availableModes = PLAYABLE_MODE_IDS.filter(
    (id) => id !== ZOMBIES_MODE_ID || hasZombiesLayout(profile.lastMatch.mapId),
  );
  if (!availableModes.includes(profile.lastMatch.modeId)) {
    profile.lastMatch.modeId = availableModes[0] ?? 'tdm';
  }

  p.appendChild(
    selectField(
      '模式',
      profile.lastMatch.modeId,
      availableModes.map((id) => ({ value: id, label: getMode(id).name })),
      (v) => {
        profile.lastMatch.modeId = v;
        saveProfile(profile);
        // Switching to or from Zombies changes what the other fields mean.
        buildPlayScreen();
        showScreen('play');
      },
    ),
  );

  if (!isCampaign) p.appendChild(
    sliderField(
      profile.lastMatch.modeId === ZOMBIES_MODE_ID ? '合作隊友' : '電腦兵',
      profile.lastMatch.botCount,
      0,
      profile.lastMatch.modeId === ZOMBIES_MODE_ID ? 3 : 17,
      1,
      (v) => String(v),
      (v) => {
        profile.lastMatch.botCount = v;
        saveProfile(profile);
      },
      '電腦兵越多，戰場越熱鬧，CPU負擔也越重。',
    ),
  );

  p.appendChild(
    selectField(
      '電腦兵難度',
      profile.lastMatch.difficulty,
      Object.keys(DIFFICULTIES).map((k) => ({ value: k, label: DIFFICULTIES[k]!.name })),
      (v) => {
        profile.lastMatch.difficulty = v;
        saveProfile(profile);
      },
      '難度只改變反應時間與準度，不會改變傷害。',
    ),
  );

  p.appendChild(
    textField('呼號', profile.name, (v) => {
      profile.name = v;
      saveProfile(profile);
    }),
  );

  b.appendChild(p);
}

function buildSettingsScreen(): void {
  screens.get('settings')?.remove();
  screens.delete('settings');

  const screen = makeScreen('settings', '設定', '影像、音效與遊戲設定');
  const b = body(screen);

  const nav = document.createElement('div');
  nav.className = 'menu-nav';
  nav.appendChild(button('返回', () => showScreen(client ? 'pause' : 'main')));
  b.appendChild(nav);

  const wrap = document.createElement('div');

  // --- video --------------------------------------------------------------
  const video = panel('影像');
  const r = profile.settings.render;

  video.appendChild(
    sliderField('視野', r.fov, 65, 120, 1, (v) => `${v}°`, (v) => {
      r.fov = v;
      applyLiveSettings();
    }, '數值越高，看到的範圍越廣，目標也越小。'),
  );

  video.appendChild(
    selectField<QualityTier>(
      '畫質',
      r.quality,
      [
        { value: 'low', label: '低' },
        { value: 'medium', label: '中' },
        { value: 'high', label: '高' },
        { value: 'ultra', label: '極高' },
      ],
      (v) => {
        r.quality = v;
        applyLiveSettings();
      },
    ),
  );

  video.appendChild(
    sliderField('算繪比例', r.resolutionScale, 0.5, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => {
      r.resolutionScale = v;
      applyLiveSettings();
    }, '在效能不佳的機器上，這是換取幀數最划算的做法。'),
  );

  video.appendChild(toggleField('陰影', r.shadows, (v) => { r.shadows = v; applyLiveSettings(); }));
  video.appendChild(toggleField('顯示FPS', r.showFps, (v) => { r.showFps = v; applyLiveSettings(); }));
  video.appendChild(
    sliderField('亮度', r.brightness, 0.6, 1.6, 0.05, (v) => v.toFixed(2), (v) => {
      r.brightness = v;
      applyLiveSettings();
    }),
  );
  wrap.appendChild(video);

  // --- audio --------------------------------------------------------------
  const audio = panel('音效');
  audio.appendChild(
    sliderField('主音量', profile.settings.masterVolume, 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => {
      profile.settings.masterVolume = v;
      applyLiveSettings();
    }),
  );
  audio.appendChild(
    sliderField('效果音', profile.settings.sfxVolume, 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => {
      profile.settings.sfxVolume = v;
      applyLiveSettings();
    }),
  );
  audio.appendChild(
    sliderField('音樂', profile.settings.musicVolume, 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => {
      profile.settings.musicVolume = v;
      applyLiveSettings();
    }),
  );
  wrap.appendChild(audio);

  // --- gameplay -----------------------------------------------------------
  const gameplay = panel('遊戲');
  const inp = profile.settings.input;

  gameplay.appendChild(
    sliderField('滑鼠靈敏度', inp.sensitivity, 0.1, 4, 0.05, (v) => v.toFixed(2), (v) => {
      inp.sensitivity = v;
      applyLiveSettings();
    }),
  );
  gameplay.appendChild(
    sliderField('瞄準靈敏度', inp.adsSensitivityScale, 0.2, 1.5, 0.05, (v) => v.toFixed(2), (v) => {
      inp.adsSensitivityScale = v;
      applyLiveSettings();
    }, '瞄準時相對於腰射靈敏度的倍率。'),
  );
  gameplay.appendChild(toggleField('垂直視角反轉', inp.invertY, (v) => { inp.invertY = v; applyLiveSettings(); }));
  gameplay.appendChild(toggleField('切換式瞄準', inp.toggleAds, (v) => { inp.toggleAds = v; applyLiveSettings(); }));
  gameplay.appendChild(toggleField('切換式蹲下', inp.toggleCrouch, (v) => { inp.toggleCrouch = v; applyLiveSettings(); }));
  gameplay.appendChild(toggleField('自動衝刺', inp.autoSprint, (v) => { inp.autoSprint = v; applyLiveSettings(); }));
  wrap.appendChild(gameplay);

  // --- accessibility ------------------------------------------------------
  const access = panel('輔助功能');
  const h = profile.settings.hud;
  access.appendChild(
    selectField(
      '色盲模式',
      h.colorblindMode,
      [
        { value: 'off' as const, label: '關閉' },
        { value: 'protanopia' as const, label: '紅色盲' },
        { value: 'deuteranopia' as const, label: '綠色盲' },
        { value: 'tritanopia' as const, label: '藍色盲' },
      ],
      (v) => {
        h.colorblindMode = v;
        applyLiveSettings();
      },
      '重新配置敵我顏色——這是遊戲唯一仰賴的區分方式。',
    ),
  );
  access.appendChild(
    sliderField('HUD縮放', h.hudScale, 0.75, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => {
      h.hudScale = v;
      applyLiveSettings();
    }),
  );
  access.appendChild(toggleField('顯示準星', h.showCrosshair, (v) => { h.showCrosshair = v; applyLiveSettings(); }));
  access.appendChild(toggleField('顯示小地圖', h.showMinimap, (v) => { h.showMinimap = v; applyLiveSettings(); }));
  access.appendChild(toggleField('顯示擊殺訊息', h.showKillfeed, (v) => { h.showKillfeed = v; applyLiveSettings(); }));
  access.appendChild(toggleField('顯示傷害數字', h.showDamageNumbers, (v) => { h.showDamageNumbers = v; applyLiveSettings(); }));
  wrap.appendChild(access);

  b.appendChild(wrap);

  const f = footer(screen);
  f.querySelector('.menu-hintbar')!.textContent = '變更立即生效並自動儲存';
}

function buildControlsScreen(): void {
  screens.get('controls')?.remove();
  screens.delete('controls');

  const screen = makeScreen('controls', '操作', '預設按鍵配置');
  const b = body(screen);

  const nav = document.createElement('div');
  nav.className = 'menu-nav';
  nav.appendChild(button('返回', () => showScreen(client ? 'pause' : 'main')));
  b.appendChild(nav);

  const p = panel('鍵盤與滑鼠');
  const rows: Array<[string, string]> = [
    ['移動', 'W A S D'],
    ['衝刺', 'Shift'],
    ['戰術衝刺', 'Shift（連按兩下）'],
    ['跳躍／翻越', 'Space'],
    ['蹲下', 'Ctrl或C'],
    ['滑鏟', '衝刺時按Ctrl'],
    ['趴下', 'Z'],
    ['開火', '滑鼠左鍵'],
    ['瞄準', '滑鼠右鍵'],
    ['重新裝填', 'R'],
    ['近戰', 'V或滑鼠中鍵'],
    ['切換武器', '1 / 2'],
    ['致命裝備', 'G'],
    ['戰術裝備', 'Q'],
    ['戰地升級', 'X'],
    ['連殺獎勵', '3 / 4 / 5'],
    ['計分板', 'Tab（長按）'],
    ['暫停', 'Escape'],
  ];
  for (const [action, key] of rows) {
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `<label>${action}</label><span></span><span class="value">${key}</span>`;
    p.appendChild(row);
  }
  b.appendChild(p);

  const gp = panel('遊戲手把');
  gp.innerHTML += `<p style="color:var(--ink-dim);font-size:13px;line-height:1.7">
    接上的手把會自動偵測，並套用標準配置：搖桿移動與轉視角，扳機瞄準與開火，
    A跳躍、B蹲下、X重新裝填、Y切換武器，肩鍵使用裝備。
  </p>`;
  b.appendChild(gp);
}

function buildLoadoutScreen(): void {
  screens.get('loadout')?.remove();
  screens.delete('loadout');

  const screen = makeScreen('loadout', '配裝', '建立職業');
  const b = body(screen);

  const nav = document.createElement('div');
  nav.className = 'menu-nav';
  nav.appendChild(button('返回', () => showScreen(client ? 'pause' : 'main')));
  b.appendChild(nav);

  const p = panel('主武器與副武器');
  void p;

  // The full class editor is built from the weapon and attachment tables; it is
  // rendered lazily here so the module graph for a first paint stays small.
  void import('./menus/loadout-editor.js').then(({ renderLoadoutEditor }) => {
    renderLoadoutEditor(b, profile, () => saveProfile(profile));
  });
}

function buildPauseScreen(): void {
  const screen = makeScreen('pause', '已暫停', '對戰進行中');
  const b = body(screen);

  const nav = document.createElement('div');
  nav.className = 'menu-nav';
  nav.appendChild(button('繼續遊戲', () => { showScreen(null); client?.resume(); }, true));
  nav.appendChild(button('設定', () => { buildSettingsScreen(); showScreen('settings'); }));
  nav.appendChild(button('操作', () => { buildControlsScreen(); showScreen('controls'); }));
  nav.appendChild(button('離開至主選單', () => endMatch()));
  b.appendChild(nav);
}

function buildResultsScreen(winner: Team | null): void {
  screens.get('results')?.remove();
  screens.delete('results');

  const screen = makeScreen('results', '對戰結束', '');
  const b = body(screen);
  b.style.gridTemplateColumns = '1fr';

  const localTeam = client?.sim.world.players.get(client.localId)?.team ?? Team.None;
  const outcome =
    winner === null ? 'draw' : winner === localTeam || winner === Team.None ? 'victory' : 'defeat';

  const banner = document.createElement('div');
  banner.className = `result-banner ${outcome}`;
  banner.textContent = outcome === 'victory' ? '勝利' : outcome === 'defeat' ? '落敗' : '平手';
  b.appendChild(banner);

  const p = panel('最終計分板');
  const table = document.createElement('table');
  table.style.width = '100%';
  table.innerHTML =
    '<tr><th class="sb-name">玩家</th><th>分數</th><th>擊殺</th><th>死亡</th><th>助攻</th></tr>';
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
  f.appendChild(button('再來一場', () => { endMatch(); startMatch(); }, true));
  f.appendChild(button('主選單', () => endMatch()));
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

  // A mission dictates its own map; the stored one is only a cache of it.
  if (config.modeId === 'campaign') {
    const mission = getMission(profile.lastMatch.missionId);
    config.missionId = mission.id;
    config.mapId = mission.mapId;
  }

  showScreen(null);
  setBootProgress(0.4, '地圖建構中…');

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

setBootProgress(0.15, '系統載入中…');

buildMainMenu();
buildPlayScreen();
buildPauseScreen();

setBootProgress(1, '就緒');

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

/**
 * The heads-up display.
 *
 * Built from DOM rather than drawn into the WebGL canvas. That is a deliberate
 * trade: DOM costs a compositing layer, but it gives crisp text at any
 * resolution, real accessibility semantics, and CSS transitions for the dozens
 * of small animations a shooter HUD needs — none of which are free in a canvas.
 * The only element that genuinely needs per-pixel control is the minimap, which
 * gets its own 2D canvas.
 *
 * The HUD reads state and events; it never writes to the simulation.
 */

import { HEALTH, TEAM_COLORS } from '@shared/constants.js';
import { clamp01, lerp, wrapAngle } from '@shared/math.js';
import {
  DamageCause,
  MatchPhase,
  SimEventType,
  Team,
  WeaponAction,
  isEnemyTeam,
  type DamageEvent,
  type KillEvent,
  type PlayerId,
  type PlayerState,
  type SimEvent,
  type WorldState,
} from '@shared/types.js';
import type { WeaponDef } from '@shared/data/weapon-types.js';
import type { MapDef } from '@shared/map/map-types.js';
import { Minimap } from './minimap.js';

/** How long each transient HUD element stays up. */
const TIMING = {
  hitmarker: 0.32,
  killfeedEntry: 6,
  damageIndicator: 1.4,
  xpPopup: 2.2,
  medal: 3.0,
  announce: 3.5,
} as const;

interface Hitmarker {
  life: number;
  lethal: boolean;
  headshot: boolean;
}

interface DamageIndicator {
  /** Direction to the attacker in world space, converted to screen angle. */
  worldAngle: number;
  life: number;
  amount: number;
}

interface KillfeedEntry {
  killerName: string;
  victimName: string;
  weaponName: string;
  headshot: boolean;
  killerIsLocal: boolean;
  victimIsLocal: boolean;
  killerTeam: Team;
  victimTeam: Team;
  life: number;
  el: HTMLElement;
}

interface XpPopup {
  text: string;
  amount: number;
  life: number;
  el: HTMLElement;
}

export interface HudOptions {
  colorblindMode: 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia';
  showCrosshair: boolean;
  showMinimap: boolean;
  showKillfeed: boolean;
  showDamageNumbers: boolean;
  hudScale: number;
  crosshairColor: string;
}

export const DEFAULT_HUD_OPTIONS: HudOptions = {
  colorblindMode: 'off',
  showCrosshair: true,
  showMinimap: true,
  showKillfeed: true,
  showDamageNumbers: true,
  hudScale: 1,
  crosshairColor: '#e8f4ff',
};

export class Hud {
  readonly root: HTMLElement;
  options: HudOptions;

  private readonly els: {
    crosshair: HTMLElement;
    crosshairLines: HTMLElement[];
    hitmarker: HTMLElement;
    health: HTMLElement;
    healthFill: HTMLElement;
    vignette: HTMLElement;
    flash: HTMLElement;
    ammoCurrent: HTMLElement;
    ammoReserve: HTMLElement;
    weaponName: HTMLElement;
    fireMode: HTMLElement;
    equipment: HTMLElement;
    killfeed: HTMLElement;
    damageRing: HTMLElement;
    scoreAllies: HTMLElement;
    scoreAxis: HTMLElement;
    timer: HTMLElement;
    modeName: HTMLElement;
    streakBar: HTMLElement;
    xpFeed: HTMLElement;
    announce: HTMLElement;
    compass: HTMLElement;
    compassStrip: HTMLElement;
    scoreboard: HTMLElement;
    killcam: HTMLElement;
    respawn: HTMLElement;
    fps: HTMLElement;
    lowHealth: HTMLElement;
  };

  private readonly minimap: Minimap;

  private hitmarker: Hitmarker | null = null;
  private readonly damageIndicators: DamageIndicator[] = [];
  private readonly killfeed: KillfeedEntry[] = [];
  private readonly xpPopups: XpPopup[] = [];
  private announceTimer = 0;

  /** Smoothed crosshair spread in pixels. */
  private crosshairGap = 6;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private fpsValue = 0;

  private scoreboardVisible = false;

  constructor(container: HTMLElement, map: MapDef, options: HudOptions = DEFAULT_HUD_OPTIONS) {
    this.options = { ...options };
    this.root = document.createElement('div');
    this.root.className = 'hud';
    container.appendChild(this.root);

    this.root.innerHTML = HUD_TEMPLATE;

    const q = <T extends HTMLElement>(sel: string): T => {
      const el = this.root.querySelector<T>(sel);
      if (!el) throw new Error(`HUD template is missing ${sel}`);
      return el;
    };

    this.els = {
      crosshair: q('.hud-crosshair'),
      crosshairLines: Array.from(this.root.querySelectorAll<HTMLElement>('.hud-crosshair span')),
      hitmarker: q('.hud-hitmarker'),
      health: q('.hud-health'),
      healthFill: q('.hud-health-fill'),
      vignette: q('.hud-vignette'),
      flash: q('.hud-flash'),
      ammoCurrent: q('.hud-ammo-current'),
      ammoReserve: q('.hud-ammo-reserve'),
      weaponName: q('.hud-weapon-name'),
      fireMode: q('.hud-firemode'),
      equipment: q('.hud-equipment'),
      killfeed: q('.hud-killfeed'),
      damageRing: q('.hud-damage-ring'),
      scoreAllies: q('.hud-score-allies'),
      scoreAxis: q('.hud-score-axis'),
      timer: q('.hud-timer'),
      modeName: q('.hud-mode'),
      streakBar: q('.hud-streaks'),
      xpFeed: q('.hud-xp'),
      announce: q('.hud-announce'),
      compass: q('.hud-compass'),
      compassStrip: q('.hud-compass-strip'),
      scoreboard: q('.hud-scoreboard'),
      killcam: q('.hud-killcam'),
      respawn: q('.hud-respawn'),
      fps: q('.hud-fps'),
      lowHealth: q('.hud-lowhealth'),
    };

    this.minimap = new Minimap(q('.hud-minimap-canvas') as HTMLCanvasElement, map);
    this.buildCompass();
    this.applyOptions();
  }

  applyOptions(): void {
    this.root.style.setProperty('--hud-scale', String(this.options.hudScale));
    this.root.dataset.colorblind = this.options.colorblindMode;
    this.els.crosshair.style.display = this.options.showCrosshair ? '' : 'none';
    this.els.killfeed.style.display = this.options.showKillfeed ? '' : 'none';
    const minimapEl = this.root.querySelector<HTMLElement>('.hud-minimap');
    if (minimapEl) minimapEl.style.display = this.options.showMinimap ? '' : 'none';
    for (const line of this.els.crosshairLines) {
      line.style.background = this.options.crosshairColor;
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Consume this tick's simulation events.
   *
   * Everything that flashes, pops or scrolls originates here, which means the
   * HUD stays a pure function of what actually happened in the match.
   */
  handleEvents(events: readonly SimEvent[], world: WorldState, localId: PlayerId): void {
    for (const event of events) {
      switch (event.type) {
        case SimEventType.Hit: {
          if (event.attacker !== localId) break;
          this.hitmarker = {
            life: TIMING.hitmarker,
            lethal: event.lethal,
            headshot: event.location === 'head',
          };
          if (this.options.showDamageNumbers) {
            this.pushXp(`${Math.round(event.damage)}`, 0, 'damage');
          }
          break;
        }

        case SimEventType.Damage: {
          const dmg = event as DamageEvent;
          if (dmg.victim !== localId) break;
          if (dmg.attacker === localId) break;
          // Convert the world-space direction into an angle we can rotate a
          // wedge to. The HUD later subtracts the player's yaw so the indicator
          // points at the attacker regardless of which way the player turns.
          const angle = Math.atan2(-dmg.direction.x, -dmg.direction.z);
          this.damageIndicators.push({
            worldAngle: angle,
            life: TIMING.damageIndicator,
            amount: dmg.amount,
          });
          break;
        }

        case SimEventType.Kill:
          this.pushKillfeed(event as KillEvent, world, localId);
          break;

        case SimEventType.ScoreAwarded:
          if (event.player === localId) {
            this.pushXp(formatScoreReason(event.reason), event.amount, 'score');
          }
          break;

        case SimEventType.KillstreakEarned:
          if (event.player === localId) {
            this.showAnnounce('KILLSTREAK READY');
          }
          break;

        case SimEventType.Announce:
          this.showAnnounce((event as { line: string }).line);
          break;

        default:
          break;
      }
    }
  }

  private pushKillfeed(event: KillEvent, world: WorldState, localId: PlayerId): void {
    const killer = world.players.get(event.killer);
    const victim = world.players.get(event.victim);
    if (!victim) return;

    const el = document.createElement('div');
    el.className = 'hud-killfeed-entry';

    const involvedLocally = event.killer === localId || event.victim === localId;
    if (involvedLocally) el.classList.add('is-local');

    const killerName = killer && killer.id !== victim.id ? killer.name : '';
    const localTeam = world.players.get(localId)?.team ?? Team.None;

    const killerClass = killer
      ? isEnemyTeam(localTeam, killer.team)
        ? 'enemy'
        : 'friendly'
      : 'neutral';
    const victimClass = isEnemyTeam(localTeam, victim.team) ? 'enemy' : 'friendly';

    const causeIcon =
      event.cause === DamageCause.Melee
        ? '🔪'
        : event.cause === DamageCause.Explosion
          ? '💥'
          : event.cause === DamageCause.Fall
            ? '⤓'
            : '';

    el.innerHTML =
      `<span class="kf-name ${killerClass}">${escapeHtml(killerName)}</span>` +
      `<span class="kf-weapon">${event.headshot ? '⌖ ' : ''}${causeIcon}${escapeHtml(shortWeaponName(event.weaponId))}</span>` +
      `<span class="kf-name ${victimClass}">${escapeHtml(victim.name)}</span>`;

    this.els.killfeed.appendChild(el);
    this.killfeed.push({
      killerName,
      victimName: victim.name,
      weaponName: event.weaponId,
      headshot: event.headshot,
      killerIsLocal: event.killer === localId,
      victimIsLocal: event.victim === localId,
      killerTeam: killer?.team ?? Team.None,
      victimTeam: victim.team,
      life: TIMING.killfeedEntry,
      el,
    });

    // Cap the feed; older entries scroll off rather than accumulating.
    while (this.killfeed.length > 6) {
      const old = this.killfeed.shift();
      old?.el.remove();
    }
  }

  private pushXp(text: string, amount: number, kind: 'score' | 'damage'): void {
    const el = document.createElement('div');
    el.className = `hud-xp-entry is-${kind}`;
    el.textContent = amount > 0 ? `+${amount} ${text}` : text;
    this.els.xpFeed.appendChild(el);
    this.xpPopups.push({ text, amount, life: TIMING.xpPopup, el });

    while (this.xpPopups.length > 5) {
      this.xpPopups.shift()?.el.remove();
    }
  }

  showAnnounce(line: string): void {
    this.els.announce.textContent = line;
    this.els.announce.classList.add('is-visible');
    this.announceTimer = TIMING.announce;
  }

  // -------------------------------------------------------------------------
  // Per-frame update
  // -------------------------------------------------------------------------

  update(
    world: WorldState,
    localId: PlayerId,
    weapon: WeaponDef | null,
    spreadRadians: number,
    dt: number,
    fov: number,
  ): void {
    const player = world.players.get(localId);

    this.tickTransients(dt);
    this.updateFps(dt);

    if (!player) return;

    this.updateHealth(player);
    this.updateAmmo(player, weapon);
    this.updateCrosshair(player, spreadRadians, dt, fov);
    this.updateDamageIndicators(player);
    this.updateMatchState(world, player);
    this.updateCompass(player);
    this.updateRespawn(player);
    this.updateStreaks(player);

    if (this.options.showMinimap) {
      this.minimap.render(world, player);
    }

    if (this.scoreboardVisible) {
      this.renderScoreboard(world, localId);
    }
  }

  private tickTransients(dt: number): void {
    if (this.hitmarker) {
      this.hitmarker.life -= dt;
      if (this.hitmarker.life <= 0) {
        this.hitmarker = null;
        this.els.hitmarker.className = 'hud-hitmarker';
      } else {
        this.els.hitmarker.className =
          'hud-hitmarker is-visible' +
          (this.hitmarker.lethal ? ' is-lethal' : '') +
          (this.hitmarker.headshot ? ' is-headshot' : '');
      }
    }

    for (let i = this.killfeed.length - 1; i >= 0; i--) {
      const entry = this.killfeed[i]!;
      entry.life -= dt;
      if (entry.life <= 0) {
        entry.el.remove();
        this.killfeed.splice(i, 1);
      } else if (entry.life < 0.5) {
        entry.el.style.opacity = String(entry.life / 0.5);
      }
    }

    for (let i = this.xpPopups.length - 1; i >= 0; i--) {
      const popup = this.xpPopups[i]!;
      popup.life -= dt;
      if (popup.life <= 0) {
        popup.el.remove();
        this.xpPopups.splice(i, 1);
      } else if (popup.life < 0.6) {
        popup.el.style.opacity = String(popup.life / 0.6);
      }
    }

    for (let i = this.damageIndicators.length - 1; i >= 0; i--) {
      this.damageIndicators[i]!.life -= dt;
      if (this.damageIndicators[i]!.life <= 0) this.damageIndicators.splice(i, 1);
    }

    if (this.announceTimer > 0) {
      this.announceTimer -= dt;
      if (this.announceTimer <= 0) this.els.announce.classList.remove('is-visible');
    }
  }

  private updateFps(dt: number): void {
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fpsValue = Math.round(this.fpsFrames / this.fpsAccum);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
    }
    this.els.fps.textContent = `${this.fpsValue} FPS`;
  }

  private updateHealth(player: PlayerState): void {
    const frac = clamp01(player.health / Math.max(1, player.maxHealth));
    this.els.healthFill.style.width = `${frac * 100}%`;

    // COD signals damage with a red screen vignette rather than a health bar the
    // player has to look away from the fight to read. The bar is secondary.
    const hurt = 1 - frac;
    this.els.vignette.style.opacity = String(hurt * hurt * 0.85);

    // A distinct pulse below the "one more hit" threshold.
    const critical = frac < 0.3 && player.alive;
    this.els.lowHealth.classList.toggle('is-visible', critical);

    // Regeneration is visible: the bar brightens while healing.
    const regenerating = player.timeSinceDamage > HEALTH.regenDelay && frac < 1;
    this.els.health.classList.toggle('is-regen', regenerating);

    // Flashbang.
    this.els.flash.style.opacity = String(clamp01(player.flashAmount));
  }

  private updateAmmo(player: PlayerState, weapon: WeaponDef | null): void {
    const state = player.weapons[player.activeSlot];
    if (!state || !weapon) {
      this.els.ammoCurrent.textContent = '--';
      this.els.ammoReserve.textContent = '--';
      return;
    }

    this.els.ammoCurrent.textContent = String(state.ammoInMag);
    this.els.ammoReserve.textContent = String(state.ammoReserve);
    this.els.weaponName.textContent = weapon.name;
    this.els.fireMode.textContent = weapon.fireMode.toUpperCase();

    // Low-ammo warning at the point where the player should be thinking about
    // reloading, not when it is already too late.
    const low = state.ammoInMag <= Math.max(1, Math.ceil(weapon.magSize * 0.25));
    this.els.ammoCurrent.classList.toggle('is-low', low);
    this.els.ammoCurrent.classList.toggle('is-empty', state.ammoInMag === 0);

    this.els.equipment.textContent = `✦ ${player.lethalCount}   ✧ ${player.tacticalCount}`;

    this.els.weaponName.classList.toggle(
      'is-reloading',
      player.action === WeaponAction.Reloading,
    );
  }

  /**
   * The dynamic crosshair.
   *
   * Its gap is the weapon's actual bullet spread, projected to screen pixels —
   * not a decorative animation. A player who learns to read it is reading real
   * information about where their next round can go.
   */
  private updateCrosshair(
    player: PlayerState,
    spreadRadians: number,
    dt: number,
    fov: number,
  ): void {
    const halfHeight = window.innerHeight * 0.5;
    const focal = halfHeight / Math.tan((fov * Math.PI) / 360);
    const targetGap = Math.max(3, Math.tan(spreadRadians) * focal);

    // Smooth, but let it open faster than it closes: the opening is a warning
    // and should be immediate, the closing is a reward and can ease.
    const rate = targetGap > this.crosshairGap ? 30 : 9;
    this.crosshairGap = lerp(this.crosshairGap, targetGap, clamp01(rate * dt));

    const gap = Math.round(this.crosshairGap);
    this.els.crosshair.style.setProperty('--gap', `${gap}px`);

    // Hidden entirely while fully aimed on a scoped weapon — the scope reticle
    // takes over — and while sprinting, where it would be lying.
    const hide = player.adsProgress > 0.85 || player.moveState === 2 || player.moveState === 3;
    this.els.crosshair.classList.toggle('is-hidden', hide);
  }

  private updateDamageIndicators(player: PlayerState): void {
    // Rebuild cheaply: there are rarely more than three at once.
    let html = '';
    for (const ind of this.damageIndicators) {
      // Rotate into view space so the wedge points at the attacker.
      const relative = wrapAngle(ind.worldAngle - player.yaw);
      const deg = (relative * 180) / Math.PI;
      const opacity = clamp01(ind.life / TIMING.damageIndicator);
      html += `<div class="hud-damage-wedge" style="transform:rotate(${deg}deg);opacity:${opacity}"></div>`;
    }
    this.els.damageRing.innerHTML = html;
  }

  private updateMatchState(world: WorldState, player: PlayerState): void {
    const match = world.match;
    const allies = match.scores.find((s) => s.team === Team.Allies)?.score ?? 0;
    const axis = match.scores.find((s) => s.team === Team.Axis)?.score ?? 0;

    // Show the local player's team on the left, always — players should never
    // have to work out which number is theirs mid-fight.
    const localIsAxis = player.team === Team.Axis;
    this.els.scoreAllies.textContent = String(localIsAxis ? axis : allies);
    this.els.scoreAxis.textContent = String(localIsAxis ? allies : axis);

    const seconds = Math.max(0, Math.ceil(match.timeRemaining));
    const mm = Math.floor(seconds / 60);
    const ss = seconds % 60;
    this.els.timer.textContent = `${mm}:${ss.toString().padStart(2, '0')}`;
    this.els.timer.classList.toggle('is-urgent', seconds <= 30 && match.phase === MatchPhase.Live);

    this.els.modeName.textContent =
      match.phase === MatchPhase.Warmup
        ? 'WARMUP'
        : match.phase === MatchPhase.MatchEnd
          ? 'MATCH OVER'
          : world.modeId.toUpperCase();
  }

  /**
   * The compass strip.
   *
   * Built once as a repeating ruler and scrolled by yaw, which is far cheaper
   * than regenerating tick marks each frame and gives perfectly smooth motion.
   */
  private buildCompass(): void {
    const marks: string[] = [];
    const labels: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    // Two full turns so scrolling never runs off either end.
    for (let rep = 0; rep < 2; rep++) {
      for (let deg = 0; deg < 360; deg += 15) {
        const label = labels[deg];
        marks.push(
          label
            ? `<span class="cm cm-major">${label}</span>`
            : `<span class="cm"></span>`,
        );
      }
    }
    this.els.compassStrip.innerHTML = marks.join('');
  }

  private updateCompass(player: PlayerState): void {
    // yaw 0 looks toward -Z, which we call north.
    let heading = (-player.yaw * 180) / Math.PI;
    heading = ((heading % 360) + 360) % 360;
    // Each 15° mark is 44px wide; scroll by the fraction of a full turn.
    const pxPerDegree = (24 * 44) / 360;
    this.els.compassStrip.style.transform = `translateX(${-heading * pxPerDegree}px)`;
  }

  private updateRespawn(player: PlayerState): void {
    if (player.alive) {
      this.els.respawn.classList.remove('is-visible');
      this.els.killcam.classList.remove('is-visible');
      return;
    }
    this.els.respawn.classList.add('is-visible');
    const t = Math.max(0, player.respawnTimer);
    this.els.respawn.innerHTML =
      t > 0.05
        ? `<div class="respawn-label">RESPAWNING IN</div><div class="respawn-time">${t.toFixed(1)}</div>`
        : `<div class="respawn-label">PRESS FIRE TO RESPAWN</div>`;
  }

  private updateStreaks(player: PlayerState): void {
    if (player.killstreakInventory.length === 0) {
      this.els.streakBar.innerHTML = '';
      return;
    }
    this.els.streakBar.innerHTML = player.killstreakInventory
      .map(
        (id, i) =>
          `<div class="hud-streak"><span class="key">${i + 3}</span>${escapeHtml(id.replace(/_/g, ' ').toUpperCase())}</div>`,
      )
      .join('');
  }

  // -------------------------------------------------------------------------
  // Scoreboard
  // -------------------------------------------------------------------------

  setScoreboardVisible(visible: boolean): void {
    this.scoreboardVisible = visible;
    this.els.scoreboard.classList.toggle('is-visible', visible);
  }

  private renderScoreboard(world: WorldState, localId: PlayerId): void {
    const players = Array.from(world.players.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.kills !== a.kills) return b.kills - a.kills;
      return a.deaths - b.deaths;
    });

    const teamBased = players.some((p) => p.team === Team.Axis);

    const row = (p: PlayerState): string => {
      const kd = p.deaths === 0 ? p.kills.toFixed(2) : (p.kills / p.deaths).toFixed(2);
      return (
        `<tr class="${p.id === localId ? 'is-local' : ''} ${p.alive ? '' : 'is-dead'}">` +
        `<td class="sb-name">${p.isBot ? '<span class="sb-bot">BOT</span> ' : ''}${escapeHtml(p.name)}</td>` +
        `<td>${p.score}</td><td>${p.kills}</td><td>${p.deaths}</td><td>${p.assists}</td><td>${kd}</td>` +
        `</tr>`
      );
    };

    const header =
      '<tr><th class="sb-name">PLAYER</th><th>SCORE</th><th>K</th><th>D</th><th>A</th><th>K/D</th></tr>';

    if (teamBased) {
      const allies = players.filter((p) => p.team === Team.Allies);
      const axis = players.filter((p) => p.team === Team.Axis);
      this.els.scoreboard.innerHTML =
        `<div class="sb-team sb-allies"><h3>ALLIES</h3><table>${header}${allies.map(row).join('')}</table></div>` +
        `<div class="sb-team sb-axis"><h3>AXIS</h3><table>${header}${axis.map(row).join('')}</table></div>`;
    } else {
      this.els.scoreboard.innerHTML =
        `<div class="sb-team"><h3>FREE-FOR-ALL</h3><table>${header}${players.map(row).join('')}</table></div>`;
    }
  }

  /**
   * Reveal an enemy on the minimap because they fired unsuppressed.
   *
   * Exposed on the HUD rather than reaching into the minimap from the client,
   * so "what the player is allowed to know" stays owned by one module.
   */
  pingEnemy(id: PlayerId, x: number, z: number): void {
    this.minimap.addGunshotPing(id, x, z);
  }

  /** Seconds of UAV coverage remaining, which unhides enemies on the minimap. */
  setUav(secondsRemaining: number): void {
    this.minimap.setUav(secondsRemaining);
  }

  setFpsVisible(visible: boolean): void {
    this.els.fps.style.display = visible ? '' : 'none';
  }

  dispose(): void {
    this.minimap.dispose();
    this.root.remove();
  }
}

// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortWeaponName(id: string): string {
  if (!id) return '';
  return id.replace(/_/g, '-').toUpperCase();
}

function formatScoreReason(reason: string): string {
  switch (reason) {
    case 'kill':
      return 'KILL';
    case 'assist':
      return 'ASSIST';
    case 'capture':
      return 'CAPTURE';
    case 'defend':
      return 'DEFEND';
    default:
      return reason.toUpperCase();
  }
}

const HUD_TEMPLATE = `
<div class="hud-vignette"></div>
<div class="hud-lowhealth"></div>
<div class="hud-flash"></div>

<div class="hud-crosshair"><span class="ch-top"></span><span class="ch-bottom"></span><span class="ch-left"></span><span class="ch-right"></span><span class="ch-dot"></span></div>
<div class="hud-hitmarker"><span></span><span></span><span></span><span></span></div>
<div class="hud-damage-ring"></div>

<div class="hud-top">
  <div class="hud-scorebar">
    <span class="hud-score-allies">0</span>
    <div class="hud-timerblock"><span class="hud-timer">0:00</span><span class="hud-mode">TDM</span></div>
    <span class="hud-score-axis">0</span>
  </div>
  <div class="hud-compass"><div class="hud-compass-strip"></div><div class="hud-compass-needle"></div></div>
</div>

<div class="hud-minimap"><canvas class="hud-minimap-canvas" width="220" height="220"></canvas></div>

<div class="hud-killfeed"></div>
<div class="hud-xp"></div>
<div class="hud-announce"></div>

<div class="hud-bottomright">
  <div class="hud-weapon-name">—</div>
  <div class="hud-ammo"><span class="hud-ammo-current">0</span><span class="hud-ammo-sep">/</span><span class="hud-ammo-reserve">0</span></div>
  <div class="hud-firemode">AUTO</div>
  <div class="hud-equipment"></div>
</div>

<div class="hud-bottomleft">
  <div class="hud-health"><div class="hud-health-fill"></div></div>
  <div class="hud-streaks"></div>
</div>

<div class="hud-respawn"></div>
<div class="hud-killcam"></div>
<div class="hud-scoreboard"></div>
<div class="hud-fps">0 FPS</div>
`;

/**
 * The minimap.
 *
 * A 2D canvas rather than DOM, because it redraws entirely every frame and
 * because the map outline needs per-pixel drawing anyway.
 *
 * The rule that matters most: **only show what the player is entitled to know.**
 * Friendlies always appear. Enemies appear only when a UAV is up, when they fire
 * an unsuppressed weapon (briefly), or when they are directly visible. Drawing
 * every enemy all the time would make the map trivially readable and delete the
 * information game that a shooter is built on.
 */

import { TEAM_COLORS } from '@shared/constants.js';
import { clamp01, wrapAngle } from '@shared/math.js';
import { Team, isEnemyTeam, type PlayerId, type PlayerState, type WorldState } from '@shared/types.js';
import { BrushKind, type MapDef } from '@shared/map/map-types.js';

/** How long an unsuppressed shot leaves the shooter on the enemy minimap. */
const GUNSHOT_PING_DURATION = 2.2;

interface Ping {
  id: PlayerId;
  x: number;
  z: number;
  life: number;
  kind: 'gunshot' | 'uav' | 'objective';
}

export class Minimap {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly size: number;

  /** Pre-rendered map outline; the geometry never changes during a match. */
  private background: HTMLCanvasElement | null = null;
  private readonly pings: Ping[] = [];

  /** Metres shown across the minimap. Smaller = more zoomed in. */
  private range = 60;
  private uavTimeRemaining = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly map: MapDef,
  ) {
    this.ctx = canvas.getContext('2d');
    this.size = canvas.width;
    this.renderBackground();
  }

  /**
   * Draw the static map once into an offscreen canvas at world scale.
   *
   * Rendering the outline every frame would mean iterating a few hundred brushes
   * sixty times a second for an image that never changes.
   */
  private renderBackground(): void {
    const world = this.worldExtent();
    const px = 512;
    const canvas = document.createElement('canvas');
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = 'rgba(12,16,20,0.82)';
    ctx.fillRect(0, 0, px, px);

    const scale = px / world.span;
    const toX = (x: number): number => (x - world.minX) * scale;
    const toY = (z: number): number => (z - world.minZ) * scale;

    // Only draw brushes that read as walls or cover from above. Including the
    // ground plane would fill the whole map with one grey rectangle.
    ctx.fillStyle = 'rgba(150,165,180,0.30)';
    ctx.strokeStyle = 'rgba(190,205,220,0.45)';
    ctx.lineWidth = 1;

    for (const brush of this.map.brushes) {
      if (brush.visible === false) continue;
      if (brush.kind === BrushKind.Plane) continue;

      let w: number;
      let d: number;
      if (brush.kind === BrushKind.Cylinder) {
        w = brush.radius * 2;
        d = brush.radius * 2;
      } else {
        w = brush.size.x;
        d = brush.size.z;
      }

      // Skip the ground and anything too thin to be meaningful from above.
      const height = brush.kind === BrushKind.Cylinder ? brush.height : brush.size.y;
      if (height < 0.6) continue;
      if (w * d > world.span * world.span * 0.4) continue;

      const cx = toX(brush.position.x);
      const cy = toY(brush.position.z);
      const sw = w * scale;
      const sh = d * scale;

      ctx.save();
      ctx.translate(cx, cy);
      if (brush.yaw) ctx.rotate(brush.yaw);
      if (brush.kind === BrushKind.Cylinder) {
        ctx.beginPath();
        ctx.arc(0, 0, (w * scale) / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
      }
      ctx.restore();
    }

    this.background = canvas;
  }

  private worldExtent(): { minX: number; minZ: number; span: number } {
    const b = this.map.bounds;
    const spanX = b.max.x - b.min.x;
    const spanZ = b.max.z - b.min.z;
    const span = Math.max(spanX, spanZ);
    // Centre the shorter axis so the map isn't stretched.
    return {
      minX: b.min.x - (span - spanX) / 2,
      minZ: b.min.z - (span - spanZ) / 2,
      span,
    };
  }

  /** Called when an enemy fires without a suppressor. */
  addGunshotPing(id: PlayerId, x: number, z: number): void {
    const existing = this.pings.find((p) => p.id === id && p.kind === 'gunshot');
    if (existing) {
      existing.x = x;
      existing.z = z;
      existing.life = GUNSHOT_PING_DURATION;
      return;
    }
    this.pings.push({ id, x, z, life: GUNSHOT_PING_DURATION, kind: 'gunshot' });
  }

  setUav(secondsRemaining: number): void {
    this.uavTimeRemaining = secondsRemaining;
  }

  render(world: WorldState, local: PlayerState): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const dt = 1 / 60;
    for (let i = this.pings.length - 1; i >= 0; i--) {
      this.pings[i]!.life -= dt;
      if (this.pings[i]!.life <= 0) this.pings.splice(i, 1);
    }
    this.uavTimeRemaining = Math.max(0, this.uavTimeRemaining - dt);

    const s = this.size;
    const half = s / 2;
    ctx.clearRect(0, 0, s, s);

    // Clip to a circle: a square minimap in a corner reads as a menu, a round
    // one reads as an instrument.
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 2, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = 'rgba(10,13,17,0.72)';
    ctx.fillRect(0, 0, s, s);

    // The map rotates under a fixed player arrow — the orientation players find
    // easiest to act on without translating between two frames of reference.
    const pxPerMetre = s / this.range;
    ctx.translate(half, half);
    ctx.rotate(local.yaw);

    if (this.background) {
      const world2 = this.worldExtent();
      const bgScale = (world2.span * pxPerMetre) / this.background.width;
      ctx.save();
      ctx.scale(bgScale, bgScale);
      ctx.drawImage(
        this.background,
        (-(local.position.x - world2.minX) / world2.span) * this.background.width,
        (-(local.position.z - world2.minZ) / world2.span) * this.background.height,
      );
      ctx.restore();
    }

    // --- objectives ---------------------------------------------------------
    for (const obj of this.map.objectives) {
      if (obj.kind !== 'dom_flag' && obj.kind !== 'hardpoint') continue;
      const dx = (obj.position.x - local.position.x) * pxPerMetre;
      const dz = (obj.position.z - local.position.z) * pxPerMetre;
      ctx.save();
      ctx.translate(dx, dz);
      ctx.rotate(-local.yaw);
      ctx.fillStyle = 'rgba(255,220,120,0.9)';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(obj.label, 0, 0);
      ctx.restore();
    }

    // --- players ------------------------------------------------------------
    const uavActive = this.uavTimeRemaining > 0;

    for (const player of world.players.values()) {
      if (!player.alive || player.id === local.id) continue;

      const enemy = isEnemyTeam(local.team, player.team);
      let show = !enemy;

      if (enemy) {
        // Enemies are shown only when the player has earned the information.
        if (uavActive) show = true;
        else if (this.pings.some((p) => p.id === player.id)) show = true;
      }
      if (!show) continue;

      const dx = (player.position.x - local.position.x) * pxPerMetre;
      const dz = (player.position.z - local.position.z) * pxPerMetre;
      if (dx * dx + dz * dz > half * half) continue;

      ctx.save();
      ctx.translate(dx, dz);
      // Counter-rotate the icon so the arrow points the right way on a rotating map.
      ctx.rotate(player.yaw - local.yaw + Math.PI);

      ctx.fillStyle = enemy
        ? `#${TEAM_COLORS.enemy.toString(16).padStart(6, '0')}`
        : `#${TEAM_COLORS.friendly.toString(16).padStart(6, '0')}`;

      // A triangle, so facing is legible at a glance.
      ctx.beginPath();
      ctx.moveTo(0, -5);
      ctx.lineTo(4, 4);
      ctx.lineTo(-4, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.restore();

    // --- the player themselves ---------------------------------------------
    ctx.save();
    ctx.translate(half, half);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Ring, plus a UAV sweep line while one is up.
    ctx.strokeStyle = uavActive ? 'rgba(120,220,255,0.85)' : 'rgba(200,215,230,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(half, half, half - 2, 0, Math.PI * 2);
    ctx.stroke();

    if (uavActive) {
      const sweep = (performance.now() / 1000) % 2 / 2;
      ctx.save();
      ctx.translate(half, half);
      ctx.rotate(sweep * Math.PI * 2);
      const grad = ctx.createLinearGradient(0, 0, half, 0);
      grad.addColorStop(0, 'rgba(120,220,255,0.35)');
      grad.addColorStop(1, 'rgba(120,220,255,0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(half, 0);
      ctx.stroke();
      ctx.restore();
    }
  }

  setRange(metres: number): void {
    this.range = Math.max(20, Math.min(200, metres));
  }

  dispose(): void {
    this.pings.length = 0;
    this.background = null;
  }
}

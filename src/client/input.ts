/**
 * Input.
 *
 * Turns keyboard, mouse, gamepad and touch into the single `InputCommand` the
 * simulation understands. Nothing downstream knows which device produced a
 * command, which is what lets a controller player and a mouse player share one
 * prediction path.
 *
 * Two details matter more than the rest:
 *
 *  - **Mouse look is accumulated, not sampled.** Browsers deliver movement
 *    events faster than the tick rate and in irregular batches, so deltas are
 *    summed between ticks and applied whole. Sampling the latest event instead
 *    silently drops motion and makes fast flicks undershoot.
 *  - **Buttons are latched.** A key pressed and released inside one tick still
 *    registers, because a 64 Hz tick is 15 ms and a fast click can fit inside
 *    one. Without latching, the game eats inputs at high frame rates.
 */

import { RENDER } from '@shared/constants.js';
import { clamp } from '@shared/math.js';
import { InputFlag, createEmptyInput, type InputCommand } from '@shared/types.js';

export type ActionName =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'crouch'
  | 'prone'
  | 'sprint'
  | 'fire'
  | 'ads'
  | 'reload'
  | 'melee'
  | 'use'
  | 'lethal'
  | 'tactical'
  | 'swap'
  | 'leanLeft'
  | 'leanRight'
  | 'fieldUpgrade'
  | 'scoreboard'
  | 'pause'
  | 'killstreak1'
  | 'killstreak2'
  | 'killstreak3';

export type KeyBindings = Record<ActionName, string[]>;

/**
 * What each action is called on the controls screen.
 *
 * Lives here rather than in the menu so it cannot drift from the actions it
 * names — the screen that used to describe the controls was a hand-written list
 * and had no way of knowing when a binding changed underneath it.
 */
export const ACTION_LABELS: Record<ActionName, string> = {
  forward: '前進',
  back: '後退',
  left: '向左',
  right: '向右',
  jump: '跳躍／翻越',
  crouch: '蹲下／滑鏟',
  prone: '趴下',
  sprint: '衝刺',
  fire: '開火',
  ads: '瞄準',
  reload: '裝填',
  melee: '近戰',
  use: '互動／購買',
  lethal: '致命裝備',
  tactical: '戰術裝備',
  swap: '切換武器',
  leanLeft: '向左傾身',
  leanRight: '向右傾身',
  fieldUpgrade: '戰地升級',
  scoreboard: '計分板',
  pause: '暫停',
  killstreak1: '連殺獎勵 1',
  killstreak2: '連殺獎勵 2',
  killstreak3: '連殺獎勵 3',
};

/** Defaults follow the PC shooter convention players already have muscle memory for. */
export const DEFAULT_BINDINGS: KeyBindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  prone: ['KeyZ'],
  sprint: ['ShiftLeft'],
  fire: ['Mouse0'],
  ads: ['Mouse2'],
  reload: ['KeyR'],
  melee: ['KeyV', 'Mouse1'],
  use: ['KeyF', 'KeyE'],
  lethal: ['KeyG'],
  tactical: ['KeyQ'],
  swap: ['Digit1', 'Digit2'],
  leanLeft: ['KeyQ'],
  leanRight: ['KeyE'],
  fieldUpgrade: ['KeyX'],
  scoreboard: ['Tab'],
  pause: ['Escape'],
  killstreak1: ['Digit3'],
  killstreak2: ['Digit4'],
  killstreak3: ['Digit5'],
};

export interface InputSettings {
  /** Mouse sensitivity multiplier. 1.0 is roughly COD's default. */
  sensitivity: number;
  /** Separate multiplier applied while aiming, so scopes can be slowed. */
  adsSensitivityScale: number;
  invertY: boolean;
  /** Hold to aim, or click to toggle. */
  toggleAds: boolean;
  toggleCrouch: boolean;
  /** Auto-sprint removes the need to hold shift. */
  autoSprint: boolean;
  /** Controller stick deadzone, 0..1. */
  deadzone: number;
  /** Controller look sensitivity. */
  gamepadSensitivity: number;
  /** Controller aim assist strength, 0 = off. */
  aimAssist: number;
  bindings: KeyBindings;
}

export const DEFAULT_INPUT_SETTINGS: InputSettings = {
  sensitivity: 1.0,
  adsSensitivityScale: 0.8,
  invertY: false,
  toggleAds: false,
  toggleCrouch: false,
  autoSprint: false,
  deadzone: 0.14,
  gamepadSensitivity: 2.4,
  aimAssist: 0.5,
  bindings: DEFAULT_BINDINGS,
};

/**
 * Radians of view rotation per unit of raw mouse movement at sensitivity 1.
 * Chosen so that 1.0 here lands close to the feel of 6/11 Windows + 800 DPI in
 * a typical shooter, which is the reference point most players calibrate from.
 */
const MOUSE_RADIANS_PER_COUNT = 0.0022;

export class InputManager {
  settings: InputSettings;

  /** Whether the pointer is locked and gameplay input should be consumed. */
  private locked = false;

  /** Keys currently held, and keys pressed at any point since the last tick. */
  private readonly held = new Set<string>();
  private readonly pressedThisTick = new Set<string>();
  private readonly releasedThisTick = new Set<string>();

  /** Accumulated mouse delta since the last tick, in raw counts. */
  private mouseDx = 0;
  private mouseDy = 0;

  private yaw = 0;
  private pitch = 0;

  private adsToggled = false;
  private crouchToggled = false;
  private sequence = 0;

  /** Slot the player wants to trigger, latched until consumed. */
  private killstreakRequest = -1;
  private swapRequest = false;

  private readonly element: HTMLElement;
  private disposed = false;

  /** Set when the player asks to open the menu; the client consumes it. */
  pauseRequested = false;
  scoreboardHeld = false;

  constructor(element: HTMLElement, settings: InputSettings = DEFAULT_INPUT_SETTINGS) {
    this.element = element;
    this.settings = { ...settings, bindings: { ...settings.bindings } };
    this.attach();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private attach(): void {
    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }

  requestLock(): void {
    void this.element.requestPointerLock?.();
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  get isLocked(): boolean {
    return this.locked;
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private onPointerLockChange = (): void => {
    this.locked = document.pointerLockElement === this.element;
    if (!this.locked) {
      // Releasing the pointer must clear held keys, or the player walks into a
      // wall while the pause menu is open.
      this.held.clear();
      this.mouseDx = 0;
      this.mouseDy = 0;
    }
  };

  private onBlur = (): void => {
    this.held.clear();
    this.mouseDx = 0;
    this.mouseDy = 0;
  };

  private onContextMenu = (e: Event): void => {
    if (this.locked) e.preventDefault();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;

    // Escape is handled even without lock so the menu always opens.
    if (e.code === 'Escape') {
      this.pauseRequested = true;
      return;
    }
    if (!this.locked) return;

    // Tab would move focus and F-keys would trigger browser UI.
    if (e.code === 'Tab' || e.code.startsWith('F') || e.code === 'Space') {
      e.preventDefault();
    }

    this.held.add(e.code);
    this.pressedThisTick.add(e.code);
    this.handleDiscrete(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
    this.releasedThisTick.add(e.code);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.locked) return;
    const code = `Mouse${e.button}`;
    this.held.add(code);
    this.pressedThisTick.add(code);
    this.handleDiscrete(code);
  };

  private onMouseUp = (e: MouseEvent): void => {
    const code = `Mouse${e.button}`;
    this.held.delete(code);
    this.releasedThisTick.add(code);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    // Accumulate: several move events arrive per frame and all of them count.
    this.mouseDx += e.movementX;
    this.mouseDy += e.movementY;
  };

  /** Actions that fire on press rather than while held. */
  private handleDiscrete(code: string): void {
    const b = this.settings.bindings;

    if (this.settings.toggleAds && b.ads.includes(code)) {
      this.adsToggled = !this.adsToggled;
    }
    if (this.settings.toggleCrouch && b.crouch.includes(code)) {
      this.crouchToggled = !this.crouchToggled;
    }
    if (b.swap.includes(code)) this.swapRequest = true;
    if (b.killstreak1.includes(code)) this.killstreakRequest = 0;
    if (b.killstreak2.includes(code)) this.killstreakRequest = 1;
    if (b.killstreak3.includes(code)) this.killstreakRequest = 2;
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  private isDown(action: ActionName): boolean {
    const codes = this.settings.bindings[action];
    for (const code of codes) {
      if (this.held.has(code)) return true;
    }
    return false;
  }

  /** True if the action was pressed at any point since the last tick. */
  private wasPressed(action: ActionName): boolean {
    const codes = this.settings.bindings[action];
    for (const code of codes) {
      if (this.pressedThisTick.has(code)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Gamepad
  // -------------------------------------------------------------------------

  private readonly gamepadState = {
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0,
    buttons: 0,
    connected: false,
  };

  private pollGamepad(): void {
    const pads = navigator.getGamepads?.();
    const pad = pads ? Array.from(pads).find((p) => p && p.connected) : null;
    if (!pad) {
      this.gamepadState.connected = false;
      return;
    }
    this.gamepadState.connected = true;

    const dz = this.settings.deadzone;
    const apply = (v: number): number => {
      const a = Math.abs(v);
      if (a < dz) return 0;
      // Rescale past the deadzone so the stick doesn't jump on activation.
      const scaled = (a - dz) / (1 - dz);
      return Math.sign(v) * scaled * scaled;
    };

    this.gamepadState.moveX = apply(pad.axes[0] ?? 0);
    this.gamepadState.moveY = apply(pad.axes[1] ?? 0);
    this.gamepadState.lookX = apply(pad.axes[2] ?? 0);
    this.gamepadState.lookY = apply(pad.axes[3] ?? 0);

    // Standard mapping: RT fire, LT ads, A jump, B crouch, X reload, R3 melee,
    // Y swap, LB tactical, RB lethal.
    let buttons = 0;
    const pressed = (i: number): boolean => (pad.buttons[i]?.pressed ?? false) ||
      (pad.buttons[i]?.value ?? 0) > 0.5;

    if (pressed(7)) buttons |= InputFlag.Fire;
    if (pressed(6)) buttons |= InputFlag.Ads;
    if (pressed(0)) buttons |= InputFlag.Jump;
    if (pressed(1)) buttons |= InputFlag.Crouch;
    if (pressed(2)) buttons |= InputFlag.Reload;
    if (pressed(3)) buttons |= InputFlag.SwapWeapon;
    if (pressed(4)) buttons |= InputFlag.Tactical;
    if (pressed(5)) buttons |= InputFlag.Lethal;
    if (pressed(10)) buttons |= InputFlag.Sprint;
    if (pressed(11)) buttons |= InputFlag.Melee;
    this.gamepadState.buttons = buttons;
  }

  // -------------------------------------------------------------------------
  // Per-tick command construction
  // -------------------------------------------------------------------------

  /**
   * Build the command for this tick.
   *
   * `adsProgress` is passed in so aim sensitivity can be scaled smoothly while
   * zooming rather than snapping when ADS begins — that snap is one of the most
   * common causes of a shooter feeling "off" without players being able to say why.
   */
  poll(dt: number, adsProgress: number): InputCommand {
    this.pollGamepad();

    const cmd = createEmptyInput();
    cmd.seq = ++this.sequence;
    cmd.dt = dt;

    // --- look ---------------------------------------------------------------
    const sensScale =
      this.settings.sensitivity *
      (1 + (this.settings.adsSensitivityScale - 1) * adsProgress);

    this.yaw -= this.mouseDx * MOUSE_RADIANS_PER_COUNT * sensScale;
    const pitchDelta = this.mouseDy * MOUSE_RADIANS_PER_COUNT * sensScale;
    this.pitch += this.settings.invertY ? -pitchDelta : pitchDelta;
    this.mouseDx = 0;
    this.mouseDy = 0;

    if (this.gamepadState.connected) {
      const gs = this.settings.gamepadSensitivity * sensScale * dt;
      this.yaw -= this.gamepadState.lookX * gs;
      const gpPitch = this.gamepadState.lookY * gs;
      this.pitch += this.settings.invertY ? -gpPitch : gpPitch;
    }

    // Clamp just short of vertical: exactly ±90° makes the yaw basis degenerate.
    this.pitch = clamp(this.pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);

    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;

    // --- movement -----------------------------------------------------------
    let moveF = 0;
    let moveR = 0;
    if (this.isDown('forward')) moveF += 1;
    if (this.isDown('back')) moveF -= 1;
    if (this.isDown('right')) moveR += 1;
    if (this.isDown('left')) moveR -= 1;

    if (this.gamepadState.connected) {
      moveF += -this.gamepadState.moveY;
      moveR += this.gamepadState.moveX;
    }

    cmd.moveForward = clamp(moveF, -1, 1);
    cmd.moveRight = clamp(moveR, -1, 1);

    // --- buttons ------------------------------------------------------------
    let buttons = this.gamepadState.buttons;

    if (this.isDown('jump')) buttons |= InputFlag.Jump;
    if (this.settings.toggleCrouch ? this.crouchToggled : this.isDown('crouch')) {
      buttons |= InputFlag.Crouch;
    }
    if (this.isDown('prone')) buttons |= InputFlag.Prone;

    const sprinting =
      this.isDown('sprint') || (this.settings.autoSprint && cmd.moveForward > 0.5);
    if (sprinting) buttons |= InputFlag.Sprint;
    // Holding sprint while already sprinting escalates to tactical sprint.
    if (sprinting && this.isDown('forward') && this.wasPressed('sprint')) {
      buttons |= InputFlag.TacticalSprint;
    }

    if (this.isDown('fire')) buttons |= InputFlag.Fire;
    if (this.settings.toggleAds ? this.adsToggled : this.isDown('ads')) {
      buttons |= InputFlag.Ads;
    }
    if (this.isDown('reload')) buttons |= InputFlag.Reload;
    if (this.isDown('melee')) buttons |= InputFlag.Melee;
    if (this.isDown('use')) buttons |= InputFlag.Use;
    if (this.isDown('lethal')) buttons |= InputFlag.Lethal;
    if (this.isDown('tactical')) buttons |= InputFlag.Tactical;
    if (this.isDown('fieldUpgrade')) buttons |= InputFlag.FieldUpgrade;
    if (this.isDown('leanLeft')) buttons |= InputFlag.LeanLeft;
    if (this.isDown('leanRight')) buttons |= InputFlag.LeanRight;

    if (this.swapRequest) {
      buttons |= InputFlag.SwapWeapon;
      this.swapRequest = false;
    }

    cmd.buttons = buttons;
    cmd.killstreakSlot = this.killstreakRequest;
    this.killstreakRequest = -1;

    this.scoreboardHeld = this.isDown('scoreboard');

    // Latched presses are consumed once the command is built.
    this.pressedThisTick.clear();
    this.releasedThisTick.clear();

    return cmd;
  }

  /** Align the view with a spawn orientation without generating mouse motion. */
  setViewAngles(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = clamp(pitch, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
  }

  getViewAngles(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  /** Apply weapon recoil to the player's actual view, as COD does. */
  applyRecoil(pitchKick: number, yawKick: number): void {
    this.pitch = clamp(this.pitch - pitchKick, -Math.PI / 2 + 0.02, Math.PI / 2 - 0.02);
    this.yaw += yawKick;
  }

  /** Consume a pending pause request. */
  takePauseRequest(): boolean {
    const v = this.pauseRequested;
    this.pauseRequested = false;
    return v;
  }

  get fovLimits(): { min: number; max: number } {
    return { min: RENDER.minFov, max: RENDER.maxFov };
  }
}

// ---------------------------------------------------------------------------
// Touch controls
// ---------------------------------------------------------------------------

/**
 * A minimal virtual-stick layer for touch devices.
 *
 * Kept deliberately simple: a movement stick on the left, look-drag on the
 * right, and a fire button. A shooter is not really playable on touch, but
 * refusing to run at all on a phone is worse than running badly.
 */
export class TouchControls {
  private moveId = -1;
  private lookId = -1;
  private moveOrigin = { x: 0, y: 0 };
  moveX = 0;
  moveY = 0;
  lookDx = 0;
  lookDy = 0;
  firing = false;

  constructor(private readonly element: HTMLElement) {
    element.addEventListener('touchstart', this.onStart, { passive: false });
    element.addEventListener('touchmove', this.onMove, { passive: false });
    element.addEventListener('touchend', this.onEnd);
    element.addEventListener('touchcancel', this.onEnd);
  }

  static get isTouchDevice(): boolean {
    return typeof window !== 'undefined' && 'ontouchstart' in window;
  }

  private onStart = (e: TouchEvent): void => {
    e.preventDefault();
    for (const touch of Array.from(e.changedTouches)) {
      const half = window.innerWidth / 2;
      if (touch.clientX < half && this.moveId === -1) {
        this.moveId = touch.identifier;
        this.moveOrigin = { x: touch.clientX, y: touch.clientY };
      } else if (this.lookId === -1) {
        this.lookId = touch.identifier;
        this.firing = true;
      }
    }
  };

  private onMove = (e: TouchEvent): void => {
    e.preventDefault();
    for (const touch of Array.from(e.changedTouches)) {
      if (touch.identifier === this.moveId) {
        const dx = touch.clientX - this.moveOrigin.x;
        const dy = touch.clientY - this.moveOrigin.y;
        const radius = 70;
        this.moveX = clamp(dx / radius, -1, 1);
        this.moveY = clamp(dy / radius, -1, 1);
      } else if (touch.identifier === this.lookId) {
        this.lookDx += touch.clientX - (this.lastLookX ?? touch.clientX);
        this.lookDy += touch.clientY - (this.lastLookY ?? touch.clientY);
        this.lastLookX = touch.clientX;
        this.lastLookY = touch.clientY;
      }
    }
  };

  private lastLookX: number | undefined;
  private lastLookY: number | undefined;

  private onEnd = (e: TouchEvent): void => {
    for (const touch of Array.from(e.changedTouches)) {
      if (touch.identifier === this.moveId) {
        this.moveId = -1;
        this.moveX = 0;
        this.moveY = 0;
      } else if (touch.identifier === this.lookId) {
        this.lookId = -1;
        this.firing = false;
        this.lastLookX = undefined;
        this.lastLookY = undefined;
      }
    }
  };

  consumeLook(): { dx: number; dy: number } {
    const out = { dx: this.lookDx, dy: this.lookDy };
    this.lookDx = 0;
    this.lookDy = 0;
    return out;
  }

  dispose(): void {
    this.element.removeEventListener('touchstart', this.onStart);
    this.element.removeEventListener('touchmove', this.onMove);
    this.element.removeEventListener('touchend', this.onEnd);
    this.element.removeEventListener('touchcancel', this.onEnd);
  }
}

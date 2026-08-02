/**
 * The key-binding screen.
 *
 * Two things wrong with what this replaces, and the second is the one that
 * matters. It was a hardcoded list of key names, so it could — and did — drift
 * away from what the game actually reads. And it was only a list: you could look
 * at the controls and not change them, which makes the game unplayable for
 * anyone who cannot reach the keys it happened to pick.
 *
 * This reads `InputSettings.bindings` and writes back to it, so the screen
 * cannot disagree with the game, and every action can be rebound.
 */

import { ACTION_LABELS, DEFAULT_BINDINGS, type ActionName, type InputSettings } from '../input.js';

/** How a browser key code should read to a human. */
function keyLabel(code: string): string {
  if (code === 'Mouse0') return '滑鼠左鍵';
  if (code === 'Mouse1') return '滑鼠中鍵';
  if (code === 'Mouse2') return '滑鼠右鍵';
  if (code.startsWith('Mouse')) return `滑鼠按鍵${code.slice(5)}`;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return `方向鍵${code.slice(5)}`;
  if (code === 'Space') return '空白鍵';
  if (code.endsWith('Left')) return `左${code.slice(0, -4)}`;
  if (code.endsWith('Right')) return `右${code.slice(0, -5)}`;
  return code;
}

export interface KeybindScreenOptions {
  settings: InputSettings;
  /** Called whenever a binding changes, so the caller can persist and re-apply. */
  onChange: () => void;
}

/** Renders the screen and returns a teardown for its window-level listeners. */
export function renderKeybinds(container: HTMLElement, opts: KeybindScreenOptions): () => void {
  const { settings, onChange } = opts;

  /** The row waiting for a key, if any. Only ever one. */
  let capturing: { action: ActionName; slot: number; el: HTMLElement } | null = null;

  function stopCapture(): void {
    if (!capturing) return;
    capturing.el.classList.remove('is-capturing');
    capturing.el.textContent = keyLabel(settings.bindings[capturing.action][capturing.slot] ?? '—');
    capturing = null;
  }

  /**
   * Take the next key or mouse button pressed.
   *
   * Captured on the window during the capture phase so the binding is taken
   * before anything else can act on it — otherwise rebinding Escape closes the
   * menu, and rebinding a movement key moves the player behind the dialog.
   */
  function onKey(ev: KeyboardEvent): void {
    if (!capturing) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.code === 'Escape') {
      stopCapture();
      return;
    }
    assign(ev.code);
  }

  function onMouse(ev: MouseEvent): void {
    if (!capturing) return;
    ev.preventDefault();
    ev.stopPropagation();
    assign(`Mouse${ev.button}`);
  }

  function assign(code: string): void {
    if (!capturing) return;
    const { action, slot } = capturing;

    // A key bound to two things at once does something surprising exactly once
    // and is then never trusted again, so take it off whatever had it.
    for (const other of Object.keys(settings.bindings) as ActionName[]) {
      settings.bindings[other] = settings.bindings[other].filter(
        (c, i) => !(c === code && !(other === action && i === slot)),
      );
    }

    const list = settings.bindings[action].slice();
    list[slot] = code;
    settings.bindings[action] = list.filter(Boolean);

    stopCapture();
    onChange();
    draw();
  }

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', onMouse, true);

  function draw(): void {
    container.innerHTML = '';

    for (const [action, label] of Object.entries(ACTION_LABELS) as Array<[ActionName, string]>) {
      const row = document.createElement('div');
      row.className = 'field';
      row.innerHTML = `<label>${label}</label>`;

      // Two slots per action: a primary and an alternate, which is what most of
      // the defaults already use and what a left-handed or one-handed layout
      // needs to be able to express.
      for (let slot = 0; slot < 2; slot++) {
        const key = document.createElement('button');
        key.className = 'keybind';
        key.textContent = keyLabel(settings.bindings[action][slot] ?? '—');
        key.addEventListener('click', (ev) => {
          ev.stopPropagation();
          stopCapture();
          capturing = { action, slot, el: key };
          key.classList.add('is-capturing');
          key.textContent = '按下按鍵…';
        });
        row.appendChild(key);
      }

      container.appendChild(row);
    }

    const reset = document.createElement('button');
    reset.className = 'menu-btn';
    reset.textContent = '恢復預設按鍵';
    reset.addEventListener('click', () => {
      for (const action of Object.keys(DEFAULT_BINDINGS) as ActionName[]) {
        settings.bindings[action] = [...DEFAULT_BINDINGS[action]];
      }
      onChange();
      draw();
    });
    container.appendChild(reset);
  }

  draw();

  return () => {
    stopCapture();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', onMouse, true);
  };
}

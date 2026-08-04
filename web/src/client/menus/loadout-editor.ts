/**
 * The create-a-class editor.
 *
 * Its job is to make a build's trade-offs legible. Every weapon and attachment
 * in this game costs something, and a menu that only lists names hides exactly
 * the information the player needs — so each selection shows its live effect on
 * the stats that decide gunfights, recomputed through the same `resolveWeapon`
 * the simulation uses. What you read here is what you will get.
 */

import { HEALTH, MAX_RANK } from '@shared/constants.js';
import {
  AttachmentSlot,
  MAX_EQUIPPED_ATTACHMENTS,
  WeaponClass,
  damageAtRange,
  timeToKill,
  type WeaponDef,
} from '@shared/data/weapon-types.js';
import { WEAPONS_BY_CLASS, getWeapon, tryGetWeapon } from '@shared/data/weapons.js';
import { ATTACHMENTS, attachmentsForSlot, resolveWeapon } from '@shared/data/attachments.js';
import { PERKS, perksForTier } from '@shared/data/perks.js';
import { EQUIPMENT, equipmentForSlot } from '@shared/data/equipment.js';
import { KILLSTREAKS } from '@shared/data/killstreaks.js';
import type { Loadout } from '@shared/sim/loadout.js';
import type { Profile } from '../profile.js';
import { getAudioEngine } from '../audio/index.js';

const SLOT_NAMES: Record<AttachmentSlot, string> = {
  [AttachmentSlot.Muzzle]: '槍口',
  [AttachmentSlot.Barrel]: '槍管',
  [AttachmentSlot.Optic]: '瞄具',
  [AttachmentSlot.Underbarrel]: '槍管下掛',
  [AttachmentSlot.Magazine]: '彈匣',
  [AttachmentSlot.Stock]: '槍托',
  [AttachmentSlot.RearGrip]: '後握把',
  [AttachmentSlot.Laser]: '雷射',
};

const CLASS_NAMES: Record<WeaponClass, string> = {
  [WeaponClass.AssaultRifle]: '突擊步槍',
  [WeaponClass.SubmachineGun]: '衝鋒槍',
  [WeaponClass.LightMachineGun]: '輕機槍',
  [WeaponClass.SniperRifle]: '狙擊步槍',
  [WeaponClass.MarksmanRifle]: '精準步槍',
  [WeaponClass.Shotgun]: '霰彈槍',
  [WeaponClass.Pistol]: '手槍',
  [WeaponClass.Launcher]: '發射器',
  [WeaponClass.Melee]: '近戰',
  [WeaponClass.Special]: '特殊',
};

export function renderLoadoutEditor(
  container: HTMLElement,
  profile: Profile,
  onChange: () => void,
): void {
  // Remove any previous render so re-entering the screen doesn't stack panels.
  container.querySelectorAll('.loadout-panel').forEach((el) => el.remove());

  const wrap = document.createElement('div');
  wrap.className = 'loadout-panel';
  container.appendChild(wrap);

  let slotIndex = profile.activeLoadout;

  const rerender = (): void => {
    wrap.innerHTML = '';
    const loadout = profile.loadouts[slotIndex] ?? profile.loadouts[0]!;

    wrap.appendChild(buildSlotPicker(profile, slotIndex, (i) => {
      slotIndex = i;
      profile.activeLoadout = i;
      onChange();
      rerender();
    }));

    wrap.appendChild(
      buildWeaponPanel('主武器', loadout, profile, 'primary', 'primaryAttachments', () => {
        onChange();
        rerender();
      }),
    );
    wrap.appendChild(
      buildWeaponPanel('副武器', loadout, profile, 'secondary', 'secondaryAttachments', () => {
        onChange();
        rerender();
      }),
    );
    wrap.appendChild(buildEquipmentPanel(loadout, profile, () => { onChange(); rerender(); }));
    wrap.appendChild(buildPerkPanel(loadout, profile, () => { onChange(); rerender(); }));
    wrap.appendChild(buildKillstreakPanel(loadout, profile, () => { onChange(); rerender(); }));
  };

  rerender();
}

// ---------------------------------------------------------------------------

function panel(title: string): HTMLElement {
  const p = document.createElement('div');
  p.className = 'menu-panel';
  p.innerHTML = `<h2>${title}</h2>`;
  return p;
}

function buildSlotPicker(
  profile: Profile,
  active: number,
  onPick: (i: number) => void,
): HTMLElement {
  const p = panel('兵種');
  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.flexWrap = 'wrap';
  row.style.gap = '6px';

  profile.loadouts.forEach((loadout, i) => {
    const b = document.createElement('button');
    b.className = 'menu-btn' + (i === active ? ' is-primary' : '');
    b.style.padding = '8px 12px';
    b.style.fontSize = '12px';
    b.textContent = loadout.name || `兵種${i + 1}`;
    b.addEventListener('click', () => {
      getAudioEngine().playUi('click');
      onPick(i);
    });
    row.appendChild(b);
  });

  p.appendChild(row);

  const rename = document.createElement('div');
  rename.className = 'field';
  rename.innerHTML = '<label>兵種名稱</label>';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 20;
  input.value = profile.loadouts[active]?.name ?? '';
  input.addEventListener('change', () => {
    const l = profile.loadouts[active];
    if (l) l.name = input.value.trim() || `兵種${active + 1}`;
    onPick(active);
  });
  rename.appendChild(input);
  rename.appendChild(document.createElement('span'));
  p.appendChild(rename);

  return p;
}

// ---------------------------------------------------------------------------

function buildWeaponPanel(
  title: string,
  loadout: Loadout,
  profile: Profile,
  weaponKey: 'primary' | 'secondary',
  attachKey: 'primaryAttachments' | 'secondaryAttachments',
  onChange: () => void,
): HTMLElement {
  const p = panel(title);

  const base = tryGetWeapon(loadout[weaponKey]) ?? getWeapon('vk47');
  const equipped = loadout[attachKey] ?? [];
  const resolved = resolveWeapon(base, equipped);

  // --- weapon picker --------------------------------------------------------
  const picker = document.createElement('div');
  picker.className = 'field';
  picker.innerHTML = '<label>武器</label>';

  const select = document.createElement('select');
  for (const cls of Object.values(WeaponClass)) {
    const list = WEAPONS_BY_CLASS[cls] ?? [];
    if (list.length === 0) continue;
    const group = document.createElement('optgroup');
    group.label = CLASS_NAMES[cls];
    for (const w of list) {
      const locked = w.unlockLevel > profile.rank;
      const o = document.createElement('option');
      o.value = w.id;
      o.textContent = locked ? `${w.name} — 軍階${w.unlockLevel}` : w.name;
      o.disabled = locked;
      if (w.id === base.id) o.selected = true;
      group.appendChild(o);
    }
    select.appendChild(group);
  }
  select.addEventListener('change', () => {
    loadout[weaponKey] = select.value;
    // Attachments are weapon-specific; carrying them across would silently
    // equip parts the new gun has no slot for.
    loadout[attachKey] = [];
    onChange();
  });
  picker.appendChild(select);
  picker.appendChild(document.createElement('span'));
  p.appendChild(picker);

  p.appendChild(statBlock(base, resolved));

  // --- attachments ----------------------------------------------------------
  const count = equipped.length;
  const header = document.createElement('div');
  header.className = 'field';
  header.innerHTML =
    `<label>配件</label><span></span>` +
    `<span class="value">${count} / ${MAX_EQUIPPED_ATTACHMENTS}</span>`;
  p.appendChild(header);

  for (const slot of base.attachmentSlots) {
    const options = attachmentsForSlot(slot, base.class).filter(
      (a) => a.unlockLevel <= Math.min(MAX_RANK, profile.rank),
    );
    if (options.length === 0) continue;

    const current = equipped.find((id) => ATTACHMENTS[id]?.slot === slot) ?? '';

    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `<label>${SLOT_NAMES[slot]}</label>`;

    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— 無 —';
    sel.appendChild(none);

    for (const att of options) {
      const o = document.createElement('option');
      o.value = att.id;
      o.textContent = att.name;
      if (att.id === current) o.selected = true;
      sel.appendChild(o);
    }

    sel.addEventListener('change', () => {
      const next = (loadout[attachKey] ?? []).filter((id) => ATTACHMENTS[id]?.slot !== slot);
      if (sel.value) {
        if (next.length >= MAX_EQUIPPED_ATTACHMENTS) {
          // At the cap, tell the player rather than silently ignoring the click.
          getAudioEngine().playUi('error');
          sel.value = current;
          return;
        }
        next.push(sel.value);
      }
      loadout[attachKey] = next;
      onChange();
    });

    row.appendChild(sel);
    row.appendChild(document.createElement('span'));

    // Pros and cons make the cost of every part explicit.
    const att = current ? ATTACHMENTS[current] : undefined;
    if (att) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      const pros = att.pros.map((s) => `+ ${s}`).join('   ');
      const cons = att.cons.map((s) => `− ${s}`).join('   ');
      hint.innerHTML =
        `<span style="color:var(--positive)">${escapeHtml(pros)}</span>   ` +
        `<span style="color:var(--negative)">${escapeHtml(cons)}</span>`;
      row.appendChild(hint);
    }

    p.appendChild(row);
  }

  return p;
}

/**
 * Live weapon stats, showing the effect of the current build.
 *
 * Time-to-kill is computed with the same helper the balance tests use, so this
 * is not a marketing bar chart — it is the number that decides the gunfight.
 */
function statBlock(base: WeaponDef, resolved: WeaponDef): HTMLElement {
  const block = document.createElement('div');

  const rows: Array<[string, string, number]> = [];

  const ttkClose = timeToKill(resolved, 8, HEALTH.max, 1);
  const ttkFar = timeToKill(resolved, 30, HEALTH.max, 1);
  const baseTtkClose = timeToKill(base, 8, HEALTH.max, 1);
  const baseTtkFar = timeToKill(base, 30, HEALTH.max, 1);

  rows.push(['8公尺TTK', fmtMs(ttkClose), sign(baseTtkClose - ttkClose)]);
  rows.push(['30公尺TTK', fmtMs(ttkFar), sign(baseTtkFar - ttkFar)]);
  rows.push([
    '30公尺傷害',
    damageAtRange(resolved.damage, 30).toFixed(0),
    sign(damageAtRange(resolved.damage, 30) - damageAtRange(base.damage, 30)),
  ]);
  rows.push([
    '瞄準時間',
    `${(resolved.handling.adsTime * 1000).toFixed(0)} ms`,
    sign(base.handling.adsTime - resolved.handling.adsTime),
  ]);
  rows.push([
    '裝填',
    `${resolved.handling.reloadTime.toFixed(2)} s`,
    sign(base.handling.reloadTime - resolved.handling.reloadTime),
  ]);
  rows.push(['彈匣', String(resolved.magSize), sign(resolved.magSize - base.magSize)]);
  rows.push(['射速', `${resolved.rpm} rpm`, 0]);
  rows.push([
    '移動速度',
    `${Math.round(resolved.handling.movementSpeedMultiplier * 100)}%`,
    sign(resolved.handling.movementSpeedMultiplier - base.handling.movementSpeedMultiplier),
  ]);
  rows.push([
    '消音',
    resolved.audio.suppressed ? '是' : '否',
    resolved.audio.suppressed && !base.audio.suppressed ? 1 : 0,
  ]);

  for (const [label, value, delta] of rows) {
    const row = document.createElement('div');
    row.className = 'field';
    const colour =
      delta > 0 ? 'var(--positive)' : delta < 0 ? 'var(--negative)' : 'var(--ink-dim)';
    const arrow = delta > 0 ? ' ▲' : delta < 0 ? ' ▼' : '';
    row.innerHTML =
      `<label style="color:var(--ink-dim);font-size:12px">${label}</label><span></span>` +
      `<span class="value" style="color:${colour}">${value}${arrow}</span>`;
    block.appendChild(row);
  }

  return block;
}

function fmtMs(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  return `${Math.round(seconds * 1000)} ms`;
}

/** Sign of a change, tolerant of floating-point noise. */
function sign(delta: number): number {
  if (Math.abs(delta) < 1e-6) return 0;
  return delta > 0 ? 1 : -1;
}

// ---------------------------------------------------------------------------

function buildEquipmentPanel(loadout: Loadout, profile: Profile, onChange: () => void): HTMLElement {
  const p = panel('裝備');

  const mk = (
    label: string,
    slot: 'lethal' | 'tactical' | 'field',
    key: 'lethal' | 'tactical' | 'fieldUpgrade',
  ): void => {
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `<label>${label}</label>`;
    const sel = document.createElement('select');

    if (slot === 'field') {
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '— 無 —';
      sel.appendChild(none);
    }

    for (const def of equipmentForSlot(slot)) {
      const locked = def.unlockLevel > profile.rank;
      const o = document.createElement('option');
      o.value = def.id;
      o.textContent = locked ? `${def.name} — 軍階${def.unlockLevel}` : def.name;
      o.disabled = locked;
      if (def.id === loadout[key]) o.selected = true;
      sel.appendChild(o);
    }

    sel.addEventListener('change', () => {
      loadout[key] = sel.value;
      onChange();
    });

    row.appendChild(sel);
    row.appendChild(document.createElement('span'));

    const def = EQUIPMENT[loadout[key]];
    if (def) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = def.description;
      row.appendChild(hint);
    }

    p.appendChild(row);
  };

  mk('致命裝備', 'lethal', 'lethal');
  mk('戰術裝備', 'tactical', 'tactical');
  mk('戰地升級', 'field', 'fieldUpgrade');

  return p;
}

function buildPerkPanel(loadout: Loadout, profile: Profile, onChange: () => void): HTMLElement {
  const p = panel('特技');

  for (const tier of [1, 2, 3] as const) {
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `<label>特技${tier}</label>`;

    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— 無 —';
    sel.appendChild(none);

    const current = (loadout.perks ?? []).find((id) => PERKS[id]?.tier === tier) ?? '';

    for (const perk of perksForTier(tier)) {
      const locked = perk.unlockLevel > profile.rank;
      const o = document.createElement('option');
      o.value = perk.id;
      o.textContent = locked ? `${perk.name} — 軍階${perk.unlockLevel}` : perk.name;
      o.disabled = locked;
      if (perk.id === current) o.selected = true;
      sel.appendChild(o);
    }

    sel.addEventListener('change', () => {
      const next = (loadout.perks ?? []).filter((id) => PERKS[id]?.tier !== tier);
      if (sel.value) next.push(sel.value);
      loadout.perks = next;
      onChange();
    });

    row.appendChild(sel);
    row.appendChild(document.createElement('span'));

    const perk = current ? PERKS[current] : undefined;
    if (perk) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = perk.description;
      row.appendChild(hint);
    }

    p.appendChild(row);
  }

  return p;
}

function buildKillstreakPanel(
  loadout: Loadout,
  profile: Profile,
  onChange: () => void,
): HTMLElement {
  const p = panel('連殺獎勵');

  const all = Object.values(KILLSTREAKS).sort((a, b) => a.cost - b.cost);

  for (let i = 0; i < 3; i++) {
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `<label>欄位${i + 1}</label>`;

    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— 無 —';
    sel.appendChild(none);

    for (const ks of all) {
      const locked = ks.unlockLevel > profile.rank;
      const o = document.createElement('option');
      o.value = ks.id;
      o.textContent = locked ? `${ks.name} (${ks.cost}) — 軍階${ks.unlockLevel}` : `${ks.name} (${ks.cost})`;
      o.disabled = locked;
      if (ks.id === loadout.killstreaks[i]) o.selected = true;
      sel.appendChild(o);
    }

    sel.addEventListener('change', () => {
      const next = [...(loadout.killstreaks ?? [])];
      next[i] = sel.value;
      // Streaks must be unique: equipping the same one twice is always a mistake.
      loadout.killstreaks = next.filter((id, idx) => id && next.indexOf(id) === idx);
      onChange();
    });

    row.appendChild(sel);
    row.appendChild(document.createElement('span'));

    const ks = KILLSTREAKS[loadout.killstreaks[i] ?? ''];
    if (ks) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = ks.description;
      row.appendChild(hint);
    }

    p.appendChild(row);
  }

  return p;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

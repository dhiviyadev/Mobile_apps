/**
 * Settings menu (hub and in-game). Tabs: Graphics, Controls, Audio.
 * Every control writes straight into the settings store, which notifies the
 * running game, so changes apply live.
 */
import { audio } from '../audio/audio';
import { isTouchDevice } from '../device';
import { type QualitySetting, type Settings, settings } from '../settings';
import { clear, h, removeWithTransition, svg } from './dom';

const CLOSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

type Tab = 'graphics' | 'controls' | 'audio';

export interface SettingsMenuOptions {
  /** Shown as an extra button in the Controls tab (opens the touch layout editor). */
  onEditTouchLayout?: () => void;
  onClose?: () => void;
  /** Extra in-game actions (e.g. "Leave room") rendered at the bottom. */
  footer?: HTMLElement;
}

let openMenu: HTMLElement | null = null;

export function openSettings(opts: SettingsMenuOptions = {}): void {
  if (openMenu) return;
  let tab: Tab = 'graphics';
  const body = h('div', { class: 'settings-body scrollable' });
  const tabs = h('div', { class: 'segmented settings-tabs' });

  const renderTabs = () => {
    clear(tabs);
    for (const [id, label] of [['graphics', 'Graphics'], ['controls', 'Controls'], ['audio', 'Audio']] as [Tab, string][]) {
      tabs.appendChild(h('button', { class: `seg-btn ${tab === id ? 'active' : ''}`, onclick: () => { tab = id; renderTabs(); renderBody(); } }, label));
    }
  };

  const renderBody = () => {
    clear(body);
    if (tab === 'graphics') {
      body.append(
        selectRow('Quality preset', 'quality', [
          ['auto', `Auto (${settings.get().detectedQuality ?? 'not measured yet'})`],
          ['low', 'Low — best for older tablets'],
          ['medium', 'Medium'],
          ['high', 'High'],
        ]),
        sliderRow('Render distance (Voxelvale)', 'renderDistance', 2, 8, 1, (v) => `${v} chunks`),
        toggleRow('Dynamic resolution', 'dynamicResolution', 'Lowers resolution automatically when the frame rate drops.'),
        toggleRow('Show FPS & ping', 'showStats'),
      );
    } else if (tab === 'controls') {
      body.append(
        sliderRow('Touch look sensitivity', 'lookSensitivity', 0.2, 3, 0.05, (v) => v.toFixed(2)),
        sliderRow('Mouse sensitivity', 'mouseSensitivity', 0.2, 3, 0.05, (v) => v.toFixed(2)),
        toggleRow('Invert Y axis', 'invertY'),
        toggleRow('Left-handed layout', 'leftHanded', 'Joystick on the right, look and buttons on the left.'),
        toggleRow('Aim assist (touch only)', 'aimAssist', 'Slightly slows aiming when your crosshair is over an opponent.'),
        sliderRow('Button size', 'touchButtonScale', 0.7, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`),
        sliderRow('Button opacity', 'touchOpacity', 0.3, 1, 0.05, (v) => `${Math.round(v * 100)}%`),
      );
      if (opts.onEditTouchLayout) {
        body.append(
          h('div', { class: 'setting-row' },
            h('div', { class: 'setting-label' }, 'Touch layout', h('small', null, 'Drag buttons to move them, pinch or use +/- to resize.')),
            h('button', { class: 'btn btn-sm', onclick: () => { close(); opts.onEditTouchLayout!(); } }, 'Edit layout'),
          ),
        );
      } else if (isTouchDevice()) {
        body.append(h('p', { class: 'setting-note' }, 'Open the settings during a game to rearrange the on-screen buttons.'));
      }
      body.append(
        h('div', { class: 'setting-row' },
          h('div', { class: 'setting-label' }, 'Reset touch layout'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => settings.update({ touchLayout: {} }) }, 'Reset'),
        ),
      );
    } else {
      body.append(
        sliderRow('Master volume', 'masterVolume', 0, 1, 0.05, pct),
        sliderRow('Music', 'musicVolume', 0, 1, 0.05, pct),
        sliderRow('Sound effects', 'sfxVolume', 0, 1, 0.05, pct, () => audio.play('click')),
      );
    }
  };

  const close = () => {
    if (!openMenu) return;
    removeWithTransition(openMenu);
    openMenu = null;
    opts.onClose?.();
  };

  renderTabs();
  renderBody();
  openMenu = h('div', { class: 'modal-backdrop settings-backdrop entering', onclick: (e: Event) => e.target === openMenu && close() },
    h('div', { class: 'modal settings-modal', role: 'dialog', 'aria-label': 'Settings', 'data-testid': 'settings' },
      h('div', { class: 'settings-head' },
        h('h3', null, 'Settings'),
        h('button', { class: 'icon-btn', 'aria-label': 'Close settings', onclick: close }, svg(CLOSE_ICON)),
      ),
      tabs,
      body,
      opts.footer ?? null,
    ),
  );
  document.body.appendChild(openMenu);
  requestAnimationFrame(() => openMenu?.classList.remove('entering'));
}

export function closeSettings(): void {
  openMenu?.querySelector<HTMLButtonElement>('.settings-head .icon-btn')?.click();
}

export const isSettingsOpen = (): boolean => openMenu !== null;

// ---- row builders ----------------------------------------------------------------

const pct = (v: number) => `${Math.round(v * 100)}%`;

type NumericKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

function sliderRow(label: string, key: NumericKey, min: number, max: number, step: number, fmt: (v: number) => string, onChange?: () => void): HTMLElement {
  const value = h('span', { class: 'setting-value' }, fmt(settings.get()[key]));
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(settings.get()[key]) });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    value.textContent = fmt(v);
    settings.update({ [key]: v } as Partial<Settings>);
    onChange?.();
  });
  return h('div', { class: 'setting-row slider-row' },
    h('div', { class: 'setting-label' }, label, value),
    input,
  );
}

function toggleRow(label: string, key: BoolKey, hint?: string): HTMLElement {
  const input = h('input', { type: 'checkbox', class: 'toggle', checked: settings.get()[key] });
  input.addEventListener('change', () => settings.update({ [key]: input.checked } as Partial<Settings>));
  return h('label', { class: 'setting-row' },
    h('div', { class: 'setting-label' }, label, hint ? h('small', null, hint) : null),
    input,
  );
}

function selectRow(label: string, key: 'quality', options: [QualitySetting, string][]): HTMLElement {
  const select = h('select', { class: 'select' },
    options.map(([v, text]) => h('option', { value: v, selected: settings.get()[key] === v }, text)),
  );
  select.addEventListener('change', () => settings.update({ [key]: select.value as QualitySetting }));
  return h('div', { class: 'setting-row' }, h('div', { class: 'setting-label' }, label), select);
}

/**
 * On-screen touch controls for tablets:
 *  - floating virtual joystick on the left (appears where the thumb lands;
 *    pushing to the rim auto-sprints)
 *  - drag-to-look anywhere else on the screen
 *  - large action buttons; "look-through" buttons (like Fire) also turn the
 *    camera while held, so you can shoot and aim with one thumb
 *  - every button can be moved and resized in a built-in layout editor;
 *    left-handed mode mirrors the whole layout
 *
 * Multi-touch is handled with Pointer Events, tracking each pointerId separately.
 */
import { settings, type TouchButtonLayout } from '../settings';
import { h } from '../ui/dom';
import type { Action, InputManager } from './InputManager';

export interface TouchButtonDef {
  id: string;
  action?: Action;
  /** Custom handler instead of (or in addition to) an action. */
  onPress?: () => void;
  label?: string;
  /** Inline SVG markup (trusted, hard-coded). */
  icon?: string;
  /** Default centre in the right-handed layout, as fractions of the safe area. */
  x: number;
  y: number;
  /** Base diameter in CSS pixels. */
  size: number;
  mode: 'hold' | 'tap' | 'toggle';
  /** Dragging while holding this button also turns the camera. */
  lookThrough?: boolean;
  variant?: 'primary' | 'accent' | 'small';
}

export interface TouchLayout {
  /** Key prefix for saved positions, e.g. "voxel". */
  id: string;
  buttons: TouchButtonDef[];
  /** Width fraction (from the stick side) where the joystick zone ends. */
  stickZone: number;
}

type PointerRole =
  | { kind: 'stick' }
  | { kind: 'look' }
  | { kind: 'button'; id: string; look: boolean }
  | { kind: 'edit'; id: string; moved: boolean };

interface TrackedPointer {
  role: PointerRole;
  lastX: number;
  lastY: number;
  startX: number;
  startY: number;
}

interface ButtonState {
  def: TouchButtonDef;
  el: HTMLElement;
  pointers: number;
  toggled: boolean;
  hidden: boolean;
}

const STICK_RADIUS = 62;

export class TouchControls {
  readonly el: HTMLElement;
  private readonly stickBase: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private readonly buttons = new Map<string, ButtonState>();
  private readonly pointers = new Map<number, TrackedPointer>();
  private stickCenter = { x: 0, y: 0 };
  private stickActive = false;
  private editing = false;
  private editBar: HTMLElement | null = null;
  private selectedId: string | null = null;
  private onEditDone: (() => void) | null = null;
  private readonly unsubscribe: () => void;
  private readonly disposers: (() => void)[] = [];

  constructor(
    private readonly input: InputManager,
    private readonly layout: TouchLayout,
    parent: HTMLElement,
  ) {
    this.stickKnob = h('div', { class: 'stick-knob' });
    this.stickBase = h('div', { class: 'stick-base idle' }, this.stickKnob);
    this.el = h('div', { class: 'touch-layer' }, this.stickBase);
    for (const def of layout.buttons) {
      const el = h('div', { class: `touch-btn ${def.variant ?? ''}`, dataset: { id: def.id }, role: 'button', 'aria-label': def.label ?? def.id });
      if (def.icon) el.innerHTML = def.icon;
      if (def.label) el.appendChild(h('span', { class: 'touch-btn-label' }, def.label));
      el.addEventListener('pointerdown', (e) => this.onButtonDown(e, def.id));
      this.el.appendChild(el);
      this.buttons.set(def.id, { def, el, pointers: 0, toggled: false, hidden: false });
    }
    parent.appendChild(this.el);

    const listen = (target: EventTarget, type: string, fn: (e: any) => void) => {
      target.addEventListener(type, fn, { passive: false });
      this.disposers.push(() => target.removeEventListener(type, fn));
    };
    listen(this.el, 'pointerdown', (e: PointerEvent) => this.onLayerDown(e));
    listen(window, 'pointermove', (e: PointerEvent) => this.onMove(e));
    listen(window, 'pointerup', (e: PointerEvent) => this.onUp(e));
    listen(window, 'pointercancel', (e: PointerEvent) => this.onUp(e));
    listen(window, 'resize', () => this.applyLayout());

    this.unsubscribe = settings.subscribe((_s, changed) => {
      if (changed.some((k) => k === 'touchLayout' || k === 'leftHanded' || k === 'touchButtonScale' || k === 'touchOpacity')) this.applyLayout();
    });
    this.applyLayout();
  }

  // ---- public API --------------------------------------------------------------

  setVisible(visible: boolean): void {
    this.el.classList.toggle('hidden', !visible);
    if (!visible) this.releaseEverything();
  }

  /** Update a button's label / visibility / highlight at runtime. */
  setButton(id: string, opts: { label?: string; hidden?: boolean; active?: boolean; disabled?: boolean; icon?: string }): void {
    const b = this.buttons.get(id);
    if (!b) return;
    if (opts.icon !== undefined) {
      b.el.innerHTML = opts.icon;
      if (b.def.label) b.el.appendChild(h('span', { class: 'touch-btn-label' }, opts.label ?? b.def.label));
    }
    if (opts.label !== undefined) {
      const l = b.el.querySelector('.touch-btn-label');
      if (l) l.textContent = opts.label;
    }
    if (opts.hidden !== undefined && opts.hidden !== b.hidden) {
      b.hidden = opts.hidden;
      b.el.classList.toggle('hidden', opts.hidden);
      if (opts.hidden) this.releaseButton(b);
    }
    if (opts.active !== undefined) b.el.classList.toggle('on', opts.active);
    if (opts.disabled !== undefined) b.el.classList.toggle('disabled', opts.disabled);
  }

  /** Forces a toggle button's state (e.g. un-crouch after a respawn). */
  setToggled(id: string, on: boolean): void {
    const b = this.buttons.get(id);
    if (!b || b.def.mode !== 'toggle' || b.toggled === on) return;
    b.toggled = on;
    b.el.classList.toggle('on', on);
    if (b.def.action) {
      if (on) this.input.press(b.def.action, true);
      else this.input.release(b.def.action);
    }
  }

  /** Enters the drag-and-resize layout editor. */
  startEditing(onDone?: () => void): void {
    this.releaseEverything();
    this.editing = true;
    this.onEditDone = onDone ?? null;
    this.el.classList.add('editing');
    const sizeLabel = h('span', { class: 'edit-size' }, '');
    const minus = h('button', { class: 'btn btn-sm', onclick: () => this.resizeSelected(-0.1) }, '−');
    const plus = h('button', { class: 'btn btn-sm', onclick: () => this.resizeSelected(0.1) }, '+');
    this.editBar = h('div', { class: 'edit-bar' },
      h('span', { class: 'edit-hint' }, 'Drag buttons to move · tap one to resize'),
      h('div', { class: 'edit-size-row' }, minus, sizeLabel, plus),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => this.resetLayout() }, 'Reset'),
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => this.stopEditing() }, 'Done'),
    );
    this.editBar.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.appendChild(this.editBar);
    this.select(null);
  }

  stopEditing(): void {
    if (!this.editing) return;
    this.editing = false;
    this.el.classList.remove('editing');
    this.editBar?.remove();
    this.editBar = null;
    this.select(null);
    this.onEditDone?.();
  }

  isEditing(): boolean {
    return this.editing;
  }

  dispose(): void {
    this.releaseEverything();
    this.unsubscribe();
    for (const d of this.disposers) d();
    this.el.remove();
  }

  // ---- layout -----------------------------------------------------------------

  private key(id: string): string {
    return `${this.layout.id}:${id}`;
  }

  private applyLayout(): void {
    const s = settings.get();
    const mirror = s.leftHanded;
    this.el.classList.toggle('left-handed', mirror);
    this.el.style.setProperty('--touch-opacity', String(s.touchOpacity));
    for (const b of this.buttons.values()) {
      const o: TouchButtonLayout | undefined = s.touchLayout[this.key(b.def.id)];
      const x = o?.x ?? b.def.x;
      const y = o?.y ?? b.def.y;
      const size = b.def.size * (o?.scale ?? 1) * s.touchButtonScale;
      b.el.style.left = `${(mirror ? 1 - x : x) * 100}%`;
      b.el.style.top = `${y * 100}%`;
      b.el.style.width = b.el.style.height = `${Math.round(size)}px`;
    }
    const r = STICK_RADIUS * s.touchButtonScale;
    this.stickBase.style.width = this.stickBase.style.height = `${r * 2}px`;
    this.stickKnob.style.width = this.stickKnob.style.height = `${r * 0.9}px`;
    if (!this.stickActive) this.placeStickIdle();
  }

  private placeStickIdle(): void {
    const rect = this.el.getBoundingClientRect();
    const r = STICK_RADIUS * settings.get().touchButtonScale;
    const fx = settings.get().leftHanded ? 0.86 : 0.14;
    const x = Math.max(r + 8, Math.min(rect.width - r - 8, rect.width * fx));
    const y = Math.max(r + 8, rect.height * 0.74);
    this.moveStickBase(x, y);
    this.stickKnob.style.transform = 'translate(-50%, -50%)';
  }

  private moveStickBase(x: number, y: number): void {
    this.stickBase.style.left = `${x}px`;
    this.stickBase.style.top = `${y}px`;
  }

  // ---- pointer handling ------------------------------------------------------------

  private localPoint(e: PointerEvent): { x: number; y: number; w: number; h: number } {
    const rect = this.el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, w: rect.width, h: rect.height };
  }

  private inStickZone(x: number, w: number): boolean {
    const zone = this.layout.stickZone * w;
    return settings.get().leftHanded ? x > w - zone : x < zone;
  }

  private onLayerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    if (this.editing) {
      this.select(null);
      return;
    }
    const p = this.localPoint(e);
    let role: PointerRole;
    if (!this.stickActive && this.inStickZone(p.x, p.w)) {
      role = { kind: 'stick' };
      this.stickActive = true;
      const r = STICK_RADIUS * settings.get().touchButtonScale;
      this.stickCenter = { x: Math.max(r, Math.min(p.w - r, p.x)), y: Math.max(r, Math.min(p.h - r, p.y)) };
      this.moveStickBase(this.stickCenter.x, this.stickCenter.y);
      this.stickBase.classList.remove('idle');
      this.updateStick(p.x, p.y);
    } else {
      role = { kind: 'look' };
    }
    this.track(e, role);
  }

  private onButtonDown(e: PointerEvent, id: string): void {
    if (e.pointerType === 'mouse' && !this.editing) return;
    e.preventDefault();
    e.stopPropagation();
    const b = this.buttons.get(id)!;
    if (this.editing) {
      this.select(id);
      this.track(e, { kind: 'edit', id, moved: false });
      return;
    }
    if (b.hidden || b.el.classList.contains('disabled')) return;
    this.track(e, { kind: 'button', id, look: !!b.def.lookThrough });
    b.pointers++;
    b.el.classList.add('pressed');
    const action = b.def.action;
    if (b.def.mode === 'toggle') {
      this.setToggled(id, !b.toggled);
    } else if (action) {
      if (b.def.mode === 'tap') this.input.tap(action, true);
      else this.input.press(action, true);
    }
    b.def.onPress?.();
    if (navigator.vibrate && settings.get().touchOpacity > 0) {
      try {
        navigator.vibrate(8);
      } catch {
        /* ignore */
      }
    }
  }

  private track(e: PointerEvent, role: PointerRole): void {
    this.pointers.set(e.pointerId, { role, lastX: e.clientX, lastY: e.clientY, startX: e.clientX, startY: e.clientY });
  }

  private onMove(e: PointerEvent): void {
    const t = this.pointers.get(e.pointerId);
    if (!t) return;
    e.preventDefault();
    const dx = e.clientX - t.lastX;
    const dy = e.clientY - t.lastY;
    t.lastX = e.clientX;
    t.lastY = e.clientY;
    const role = t.role;
    if (role.kind === 'stick') {
      const p = this.localPoint(e);
      this.updateStick(p.x, p.y);
    } else if (role.kind === 'look' || (role.kind === 'button' && role.look)) {
      this.input.addLook(dx, dy, 'touch');
    } else if (role.kind === 'edit') {
      if (Math.hypot(e.clientX - t.startX, e.clientY - t.startY) > 6) role.moved = true;
      if (role.moved) this.dragButton(role.id, e);
    }
  }

  private onUp(e: PointerEvent): void {
    const t = this.pointers.get(e.pointerId);
    if (!t) return;
    this.pointers.delete(e.pointerId);
    const role = t.role;
    if (role.kind === 'stick') {
      this.stickActive = false;
      this.input.setStick(0, 0);
      this.stickBase.classList.add('idle');
      this.placeStickIdle();
    } else if (role.kind === 'button') {
      const b = this.buttons.get(role.id);
      if (b) {
        b.pointers = Math.max(0, b.pointers - 1);
        if (b.pointers === 0) {
          b.el.classList.remove('pressed');
          if (b.def.mode === 'hold' && b.def.action) this.input.release(b.def.action);
        }
      }
    }
  }

  private updateStick(x: number, y: number): void {
    const r = STICK_RADIUS * settings.get().touchButtonScale;
    let dx = x - this.stickCenter.x;
    let dy = y - this.stickCenter.y;
    const len = Math.hypot(dx, dy);
    if (len > r) {
      dx = (dx / len) * r;
      dy = (dy / len) * r;
    }
    this.stickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    let nx = dx / r;
    let ny = -dy / r;
    const mag = Math.hypot(nx, ny);
    const dead = 0.12;
    if (mag < dead) {
      nx = ny = 0;
    } else {
      // Rescale so output starts at 0 just outside the dead zone.
      const k = (mag - dead) / (1 - dead) / mag;
      nx *= k;
      ny *= k;
    }
    this.input.setStick(nx, ny);
  }

  private releaseButton(b: ButtonState): void {
    b.pointers = 0;
    b.el.classList.remove('pressed');
    if (b.def.action && b.def.mode !== 'toggle') this.input.release(b.def.action);
    for (const [id, t] of this.pointers) if (t.role.kind === 'button' && t.role.id === b.def.id) this.pointers.delete(id);
  }

  private releaseEverything(): void {
    for (const b of this.buttons.values()) this.releaseButton(b);
    this.pointers.clear();
    this.stickActive = false;
    this.input.setStick(0, 0);
    this.stickBase.classList.add('idle');
    this.placeStickIdle();
  }

  // ---- layout editor -------------------------------------------------------------

  private select(id: string | null): void {
    this.selectedId = id;
    for (const b of this.buttons.values()) b.el.classList.toggle('selected', b.def.id === id);
    const label = this.editBar?.querySelector('.edit-size');
    const row = this.editBar?.querySelector<HTMLElement>('.edit-size-row');
    if (row) row.style.visibility = id ? 'visible' : 'hidden';
    if (label && id) {
      const o = settings.get().touchLayout[this.key(id)];
      label.textContent = `${Math.round((o?.scale ?? 1) * 100)}%`;
    }
  }

  private currentLayout(id: string): TouchButtonLayout {
    const b = this.buttons.get(id)!;
    const o = settings.get().touchLayout[this.key(id)];
    return { x: o?.x ?? b.def.x, y: o?.y ?? b.def.y, scale: o?.scale ?? 1 };
  }

  private saveLayout(id: string, l: TouchButtonLayout): void {
    settings.update({ touchLayout: { ...settings.get().touchLayout, [this.key(id)]: l } });
  }

  private dragButton(id: string, e: PointerEvent): void {
    const p = this.localPoint(e);
    let fx = Math.max(0.03, Math.min(0.97, p.x / p.w));
    const fy = Math.max(0.05, Math.min(0.95, p.y / p.h));
    if (settings.get().leftHanded) fx = 1 - fx; // stored in right-handed space
    this.saveLayout(id, { ...this.currentLayout(id), x: fx, y: fy });
  }

  private resizeSelected(delta: number): void {
    if (!this.selectedId) return;
    const l = this.currentLayout(this.selectedId);
    l.scale = Math.max(0.6, Math.min(1.8, Math.round((l.scale + delta) * 10) / 10));
    this.saveLayout(this.selectedId, l);
    this.select(this.selectedId);
  }

  private resetLayout(): void {
    const prefix = `${this.layout.id}:`;
    const kept = Object.fromEntries(Object.entries(settings.get().touchLayout).filter(([k]) => !k.startsWith(prefix)));
    settings.update({ touchLayout: kept });
    this.select(null);
  }
}

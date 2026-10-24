/**
 * Keyboard + mouse bindings with pointer lock (desktop browsers).
 * iOS Safari has no pointer lock; touch controls take over there.
 */
import { supportsPointerLock } from '../device';
import type { Action, InputManager } from './InputManager';

const KEY_ACTIONS: Record<string, Action> = {
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'crouch',
  KeyC: 'crouch',
  KeyR: 'reload',
  KeyV: 'melee',
  KeyF: 'melee',
  KeyQ: 'weaponPrev',
  KeyE: 'weaponNext',
  Tab: 'scoreboard',
  KeyT: 'chat',
  Enter: 'chat',
  KeyB: 'loadout',
};

const SLOT_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'];

export class KeyboardMouse {
  private down = new Set<string>();
  private disposers: (() => void)[] = [];
  /** Called when pointer lock is lost without us asking (Esc). */
  onUnlock: (() => void) | null = null;
  private wantLock = false;
  /**
   * Pointer lock was refused and has never worked here (sandboxed iframes,
   * WebViews): fall back to drag-to-look. A refusal after it once worked is
   * just the browser's cooldown after Esc, so it doesn't count.
   */
  private lockFailed = false;
  private lockWorked = false;

  constructor(
    private readonly input: InputManager,
    private readonly target: HTMLElement,
  ) {
    const on = <K extends keyof WindowEventMap>(el: Window | Document | HTMLElement, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      el.addEventListener(type, fn, opts);
      this.disposers.push(() => el.removeEventListener(type, fn, opts));
    };

    on(window, 'keydown', (e: KeyboardEvent) => this.onKey(e, true));
    on(window, 'keyup', (e: KeyboardEvent) => this.onKey(e, false));
    on(window, 'blur', () => {
      this.down.clear();
      this.updateMove();
      this.input.releaseAll();
    });
    on(target, 'mousedown', (e: MouseEvent) => {
      if (this.isLocked() || !supportsPointerLock() || this.lockFailed) {
        if (e.button === 0) this.input.press('primary');
        if (e.button === 2) this.input.press('secondary');
      } else {
        this.lock();
      }
    });
    on(window, 'mouseup', (e: MouseEvent) => {
      if (e.button === 0) this.input.release('primary');
      if (e.button === 2) this.input.release('secondary');
    });
    on(document, 'mousemove', (e: MouseEvent) => {
      if (this.isLocked()) this.input.addLook(e.movementX, e.movementY, 'mouse');
      else if (this.lockFailed && e.buttons & 3) this.input.addLook(e.movementX, e.movementY, 'mouse');
    });
    on(document, 'pointerlockerror', () => this.onLockRefused());
    on(target, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      this.input.scrollSlot(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    on(target, 'contextmenu', (e: Event) => e.preventDefault());
    on(document, 'pointerlockchange', () => {
      if (this.isLocked()) {
        this.lockWorked = true;
        this.lockFailed = false;
      } else {
        this.input.release('primary');
        this.input.release('secondary');
        if (this.wantLock) this.onUnlock?.();
      }
    });
  }

  isLocked(): boolean {
    return document.pointerLockElement === this.target;
  }

  lock(): void {
    if (!supportsPointerLock()) return;
    this.wantLock = true;
    try {
      const r = this.target.requestPointerLock() as unknown as Promise<void> | undefined;
      r?.catch?.(() => this.onLockRefused());
    } catch {
      /* ignore */
    }
  }

  private onLockRefused(): void {
    if (!this.lockWorked) this.lockFailed = true;
  }

  unlock(): void {
    this.wantLock = false;
    if (this.isLocked()) document.exitPointerLock();
  }

  dispose(): void {
    this.unlock();
    for (const d of this.disposers) d();
  }

  private onKey(e: KeyboardEvent, isDown: boolean): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.code === 'Escape') {
      if (isDown) this.input.tap('menu');
      return;
    }
    if (e.code === 'Tab') e.preventDefault();
    if (isDown) {
      if (e.repeat) return;
      this.down.add(e.code);
      const slot = SLOT_KEYS.indexOf(e.code);
      if (slot >= 0) this.input.selectSlot(slot);
      const action = KEY_ACTIONS[e.code];
      if (action) this.input.press(action);
    } else {
      this.down.delete(e.code);
      const action = KEY_ACTIONS[e.code];
      if (action) this.input.release(action);
    }
    this.updateMove();
  }

  private updateMove(): void {
    const d = this.down;
    const x = (d.has('KeyD') || d.has('ArrowRight') ? 1 : 0) - (d.has('KeyA') || d.has('ArrowLeft') ? 1 : 0);
    const y = (d.has('KeyW') || d.has('ArrowUp') ? 1 : 0) - (d.has('KeyS') || d.has('ArrowDown') ? 1 : 0);
    this.input.setKeyboardMove(x, y);
  }
}

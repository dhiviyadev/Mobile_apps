/**
 * Device-independent input state. Keyboard/mouse and touch controls both feed
 * this; games read one consolidated InputFrame per frame via consume().
 */
import { settings } from '../settings';

export type Action =
  | 'jump'
  | 'crouch'
  | 'sprint'
  | 'primary' // break block / fire
  | 'secondary' // place block / aim
  | 'reload'
  | 'melee'
  | 'weaponNext'
  | 'weaponPrev'
  | 'menu'
  | 'chat'
  | 'scoreboard'
  | 'loadout';

export interface InputFrame {
  /** Strafe (-1 left .. 1 right). */
  moveX: number;
  /** Forward (-1 back .. 1 forward). */
  moveY: number;
  /** Radians to add to yaw / pitch this frame (positive yaw = turn left, positive pitch = look up). */
  lookYaw: number;
  lookPitch: number;
  held: ReadonlySet<Action>;
  pressed: ReadonlySet<Action>;
  released: ReadonlySet<Action>;
  /** Hotbar / weapon wheel scrolling (+1 next, -1 previous). */
  slotDelta: number;
  /** Direct slot pick (0-based), e.g. number keys or tapping the hotbar. */
  slotSelect: number | null;
  /** True while the stick is pushed to the edge (auto-sprint on touch). */
  stickSprint: boolean;
  /** Last input came from touch (affects aim assist, UI hints). */
  touch: boolean;
}

const MOUSE_RAD_PER_PX = 0.0022;
const TOUCH_RAD_PER_PX = 0.0048;

export class InputManager {
  private held = new Set<Action>();
  private pressed = new Set<Action>();
  private released = new Set<Action>();
  /** Taps that must be released on the next frame (tap buttons). */
  private pendingRelease = new Set<Action>();
  private yaw = 0;
  private pitch = 0;
  private slotDelta = 0;
  private slotSelect: number | null = null;
  private keys = { x: 0, y: 0 };
  private stick = { x: 0, y: 0 };
  private lastWasTouch = false;
  /** Disabled while menus/chat are open: everything is released. */
  private enabled = true;
  /** Set by games each frame (aim assist slowdown); applies to touch look only. */
  touchLookMultiplier = 1;

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.releaseAll();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  press(action: Action, fromTouch = false): void {
    if (!this.enabled) return;
    this.lastWasTouch = fromTouch;
    if (!this.held.has(action)) {
      this.held.add(action);
      this.pressed.add(action);
    }
  }

  release(action: Action): void {
    if (this.held.delete(action)) this.released.add(action);
  }

  /** Press now and release automatically after the next consume(). */
  tap(action: Action, fromTouch = false): void {
    this.press(action, fromTouch);
    this.pendingRelease.add(action);
  }

  isHeld(action: Action): boolean {
    return this.held.has(action);
  }

  /** Raw pixel deltas from mouse or touch; converted with the right sensitivity. */
  addLook(dxPx: number, dyPx: number, source: 'mouse' | 'touch'): void {
    if (!this.enabled) return;
    const s = settings.get();
    let k: number;
    if (source === 'touch') {
      k = TOUCH_RAD_PER_PX * s.lookSensitivity * this.touchLookMultiplier;
      this.lastWasTouch = true;
    } else {
      k = MOUSE_RAD_PER_PX * s.mouseSensitivity;
      this.lastWasTouch = false;
    }
    this.yaw -= dxPx * k;
    this.pitch -= dyPx * k * (s.invertY ? -1 : 1);
  }

  setKeyboardMove(x: number, y: number): void {
    this.keys.x = x;
    this.keys.y = y;
    if (x || y) this.lastWasTouch = false;
  }

  setStick(x: number, y: number): void {
    this.stick.x = x;
    this.stick.y = y;
    if (x || y) this.lastWasTouch = true;
  }

  scrollSlot(delta: number): void {
    if (this.enabled) this.slotDelta += delta;
  }

  selectSlot(index: number): void {
    if (this.enabled) this.slotSelect = index;
  }

  releaseAll(): void {
    for (const a of this.held) this.released.add(a);
    this.held.clear();
    this.stick.x = this.stick.y = 0;
    this.keys.x = this.keys.y = 0;
    this.yaw = this.pitch = 0;
  }

  consume(): InputFrame {
    let mx = this.keys.x + this.stick.x;
    let my = this.keys.y + this.stick.y;
    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    const frame: InputFrame = {
      moveX: this.enabled ? mx : 0,
      moveY: this.enabled ? my : 0,
      lookYaw: this.yaw,
      lookPitch: this.pitch,
      held: new Set(this.held),
      pressed: this.pressed,
      released: this.released,
      slotDelta: this.slotDelta,
      slotSelect: this.slotSelect,
      stickSprint: Math.hypot(this.stick.x, this.stick.y) > 0.93,
      touch: this.lastWasTouch,
    };
    this.pressed = new Set();
    this.released = new Set();
    this.yaw = this.pitch = 0;
    this.slotDelta = 0;
    this.slotSelect = null;
    for (const a of this.pendingRelease) this.release(a);
    this.pendingRelease.clear();
    return frame;
  }
}

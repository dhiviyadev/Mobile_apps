/**
 * Movement presentation (design-arena-movement §7): the camera's eye height,
 * slide tilt, speed zoom and landing dip; footsteps (local and remote), slide
 * sounds and dust; the touch Crouch button that turns into a Slide button
 * while a slide is possible; and a leave-page guard (Ctrl+W while sliding
 * with Ctrl would otherwise close the tab).
 *
 * Camera motion is optional (Settings.cameraMotion): with it off, roll, FOV
 * and dip are exactly zero.
 */
import { canStartSlide, clamp, type CommandEvents, eyeHeight, MOVE, type Phase, type PlayerSim, SLIDE } from '@hub/shared';
import { audio } from '../../../core/audio/audio';
import type { InputFrame } from '../../../core/input/InputManager';
import { type Settings, settings } from '../../../core/settings';
import { GAME_ICONS } from '../../../core/ui/icons';
import type { ArenaClient, ArenaFeature, CameraFx, RemotePose } from './types';

/** Distance between footsteps (m): about 3.5 steps/s at run speed. */
export const FOOTSTEP_STRIDE = 2.6;
/** A touch Crouch tap that starts a slide within this long does not latch crouch (ms). */
const TOUCH_UNLATCH_MS = 450;
/** One-time "tap Crouch while running" tip on touch. */
const SLIDE_TIP_KEY = 'arcfire.tip.slide';
/** Constant slide tilt and the extra tilt into a sideways slide (rad). */
const SLIDE_ROLL = 0.045;
const SLIDE_ROLL_LATERAL = 0.06;
/** Extra FOV (deg) at full slide speed; on own pad launches. */
const SPEED_FOV = 7;
const LAUNCH_FOV_KICK = 6;
/** Remote movement deltas above this are respawns or teleports, not steps (m). */
const TELEPORT = 2;
const LOCAL_DUST_EVERY = 0.09;
const REMOTE_DUST_EVERY = 0.07;

interface RemoteMotion {
  x: number;
  z: number;
  step: number;
  sliding: boolean;
  dust: number;
}

function readTip(): boolean {
  try {
    return localStorage.getItem(SLIDE_TIP_KEY) === '1';
  } catch {
    return false;
  }
}

export class MovementFx implements ArenaFeature {
  /** The camera modifiers of the last frame (read by ArenaGame and tests). */
  readonly fx: CameraFx = { eye: 1.6, roll: 0, fovAdd: 0, dipY: 0 };
  private eyeSmooth = 1.6;
  private motion = settings.get().cameraMotion;
  private roll = 0;
  private speedFov = 0;
  private fovKick = 0;
  private landDip = 0;
  private dipNow = 0;
  // input
  private crouchPressAt = -1e9;
  private slideReadyShown = false;
  private tipShown = readTip();
  private playSince = 0;
  // sounds and dust
  private stepDist = 0;
  private lastX = NaN;
  private lastZ = NaN;
  private dustTimer = 0;
  private readonly remotes = new Map<string, RemoteMotion>();

  constructor(readonly client: ArenaClient) {
    window.addEventListener('beforeunload', this.onBeforeUnload);
  }

  /** Camera modifiers for the live player this frame (ArenaGame calls it while alive). */
  camera(p: PlayerSim, dt: number): CameraFx {
    this.eyeSmooth += (eyeHeight(p.crouching, p.sliding) - this.eyeSmooth) * Math.min(1, dt * (p.sliding ? 18 : 14));
    const fx = this.fx;
    fx.eye = this.eyeSmooth;
    if (!this.motion) {
      fx.roll = fx.fovAdd = fx.dipY = 0;
      return fx;
    }
    // Slide tilt: a little always, more when the slide drifts sideways (leaning into it).
    const lateral = p.vx * Math.cos(p.yaw) - p.vz * Math.sin(p.yaw);
    const rollTarget = p.sliding ? SLIDE_ROLL - clamp(lateral / 12, -1, 1) * SLIDE_ROLL_LATERAL : 0;
    this.roll += (rollTarget - this.roll) * Math.min(1, dt * 10);
    // Speed zoom: nothing at run speed, full at a fresh slide. Never while aiming (exact ADS FOV).
    if (p.aiming || p.ads > 0) this.speedFov = 0;
    else {
      const k = clamp((Math.hypot(p.vx, p.vz) - 0.98 * MOVE.walkSpeed) / (SLIDE.boostCap - MOVE.walkSpeed), 0, 1);
      this.speedFov += (SPEED_FOV * k - this.speedFov) * Math.min(1, dt * 8);
    }
    this.fovKick *= Math.exp(-dt * 4);
    this.dipNow += (this.landDip - this.dipNow) * Math.min(1, dt * 30);
    this.landDip *= Math.exp(-dt * 8);
    fx.roll = this.roll;
    fx.fovAdd = this.speedFov + this.fovKick;
    fx.dipY = this.dipNow;
    return fx;
  }

  beforeCommands(input: InputFrame): void {
    if (input.pressed.has('crouch')) this.crouchPressAt = performance.now();
  }

  onLocalCommand(ev: CommandEvents, p: PlayerSim): void {
    if (ev.jumped) audio.play('jump');
    if (ev.landed > 6) audio.play('land', { volume: Math.min(1, ev.landed / 14) });
    if (this.motion && ev.landed > 5) this.landDip = Math.min(0.12, ev.landed * 0.008);
    if (ev.slideStarted) {
      audio.play('slide', { volume: 0.8 });
      // A touch tap that slid should not leave the toggle latched: stand up when the slide ends.
      const touch = this.client.touch;
      if (touch && performance.now() - this.crouchPressAt < TOUCH_UNLATCH_MS) touch.setToggled('crouch', false);
    }
    if (ev.launched >= 0 && this.motion) this.fovKick = LAUNCH_FOV_KICK;
    this.footsteps(p);
  }

  onPhase(phase: Phase): void {
    if (phase === 'live' || phase === 'warmup') this.playSince = performance.now();
  }

  update(dt: number, remotes: ReadonlyMap<string, RemotePose>): void {
    const c = this.client;
    const p = c.predicted;
    const phase = c.match.phase;
    const frozen = phase === 'loadout' || phase === 'matchEnd' || phase === 'vote';
    this.updateSlideButton(!!p && p.alive && !frozen && canStartSlide(p, c.yaw));
    // Local slide dust, ahead of the feet so it shows when looking down.
    if (p?.alive && p.sliding) {
      this.dustTimer -= dt;
      if (this.dustTimer <= 0) {
        this.dustTimer = LOCAL_DUST_EVERY;
        c.effects.dust([p.x + p.vx * 0.15, p.y + 0.05, p.z + p.vz * 0.15], 3);
      }
    } else this.dustTimer = 0;
    this.updateRemotes(dt, remotes);
  }

  onSettings(s: Readonly<Settings>, changed: readonly (keyof Settings)[]): void {
    if (!changed.includes('cameraMotion')) return;
    this.motion = s.cameraMotion;
    if (!this.motion) this.roll = this.speedFov = this.fovKick = this.landDip = this.dipNow = 0;
  }

  dispose(): void {
    window.removeEventListener('beforeunload', this.onBeforeUnload);
  }

  // ---- internals --------------------------------------------------------------------------------

  /** Mid-match, ask before leaving the page (Ctrl+W while sliding with Ctrl held closes Chrome tabs). */
  private readonly onBeforeUnload = (e: BeforeUnloadEvent): void => {
    const phase = this.client.match.phase;
    if (phase === 'warmup' || phase === 'matchEnd') return;
    e.preventDefault();
    e.returnValue = '';
  };

  /** Local footsteps every stride while running on the ground (crouch-walking is silent). */
  private footsteps(p: PlayerSim): void {
    const d = Number.isNaN(this.lastX) ? 0 : Math.hypot(p.x - this.lastX, p.z - this.lastZ);
    this.lastX = p.x;
    this.lastZ = p.z;
    if (d > TELEPORT || !p.alive || !p.onGround || p.sliding || p.crouching) return;
    this.stepDist += d;
    if (this.stepDist < FOOTSTEP_STRIDE) return;
    this.stepDist -= FOOTSTEP_STRIDE;
    audio.play('footstep', { volume: 0.45, pitch: 0.92 + Math.random() * 0.16 });
  }

  /** Touch: the Crouch button shows the Slide icon while a slide would start; first time, a tip. */
  private updateSlideButton(ready: boolean): void {
    const touch = this.client.touch;
    if (!touch || ready === this.slideReadyShown) return;
    this.slideReadyShown = ready;
    touch.setButton('crouch', { icon: ready ? GAME_ICONS.slide : GAME_ICONS.crouch });
    this.client.container.querySelector('.touch-btn[data-id="crouch"]')?.classList.toggle('slide-ready', ready);
    // Wait until the round banner has gone before teaching.
    if (ready && !this.tipShown && performance.now() - this.playSince > 1500) {
      this.tipShown = true;
      this.client.hud.showBanner('Slide', 'Tap Crouch while running', 2200);
      try {
        localStorage.setItem(SLIDE_TIP_KEY, '1');
      } catch {
        /* private mode: the tip may show again next time */
      }
    }
  }

  /** Remote footsteps, slide sounds and slide dust from the interpolated poses. */
  private updateRemotes(dt: number, remotes: ReadonlyMap<string, RemotePose>): void {
    const c = this.client;
    const cam = c.camera.position;
    for (const [id, r] of remotes) {
      if (!r.alive) {
        this.remotes.delete(id);
        continue;
      }
      const m = this.remotes.get(id);
      if (!m) {
        this.remotes.set(id, { x: r.x, z: r.z, step: 0, sliding: r.sliding, dust: 0 });
        continue;
      }
      const d = Math.hypot(r.x - m.x, r.z - m.z);
      m.x = r.x;
      m.z = r.z;
      if (d > TELEPORT) {
        m.step = 0;
        m.sliding = r.sliding;
        continue;
      }
      if (r.onGround && !r.crouching && !r.sliding) {
        m.step += d;
        if (m.step >= FOOTSTEP_STRIDE) {
          m.step -= FOOTSTEP_STRIDE;
          audio.playAt('footstep', r.x - cam.x, r.z - cam.z, c.yaw, 24, 0.7);
        }
      }
      if (r.sliding && !m.sliding) audio.playAt('slide', r.x - cam.x, r.z - cam.z, c.yaw, 30, 0.8);
      m.sliding = r.sliding;
      if (r.sliding) {
        m.dust -= dt;
        if (m.dust <= 0) {
          m.dust = REMOTE_DUST_EVERY;
          c.effects.dust([r.x, r.y + 0.05, r.z], 3);
        }
      } else m.dust = 0;
    }
    for (const id of this.remotes.keys()) if (!remotes.has(id)) this.remotes.delete(id);
  }
}

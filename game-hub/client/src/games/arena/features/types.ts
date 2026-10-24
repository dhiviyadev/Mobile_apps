/**
 * Contract between ArenaGame and its feature modules (movement, items, weapons, maps).
 *
 * ArenaGame owns the frame loop, netcode (prediction, reconciliation,
 * interpolation), camera placement and the generic match UI. Each feature
 * module adds its own presentation and input through the hooks below, called
 * at fixed points of the frame in feature order [moveFx, itemsFx, weaponFx, mapFx].
 */
import type * as THREE from 'three';
import type { ArenaEvent, ArenaMap, BoxWorld, CommandEvents, Phase, PlayerSim } from '@hub/shared';
import type { InputFrame, InputManager } from '../../../core/input/InputManager';
import type { KeyboardMouse } from '../../../core/input/KeyboardMouse';
import type { TouchControls } from '../../../core/input/TouchControls';
import type { GameRenderer } from '../../../core/render/GameRenderer';
import type { Settings } from '../../../core/settings';
import type { AvatarRenderer } from '../../common/Avatars';
import type { ArenaBackend, MatchInfo, PoseData } from '../backend';
import type { Effects } from '../render/Effects';
import type { Viewmodel } from '../render/Viewmodel';
import type { ArenaHud } from '../ui/ArenaHud';

/** Vertical field of view (deg) when not aiming. */
export const BASE_FOV = 78;

/** An interpolated remote player as drawn this frame. */
export interface RemotePose extends PoseData {
  /** Horizontal speed (m/s) measured between the two interpolation snapshots. */
  speed: number;
}

/** What ArenaGame exposes to its feature modules. Do not read `world`/`map` in a feature constructor. */
export interface ArenaClient {
  readonly backend: ArenaBackend;
  readonly container: HTMLElement;
  readonly renderer: GameRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly effects: Effects;
  readonly viewmodel: Viewmodel;
  readonly avatars: AvatarRenderer;
  readonly hud: ArenaHud;
  readonly input: InputManager;
  readonly kbm: KeyboardMouse;
  readonly touch: TouchControls | null;
  readonly world: BoxWorld;
  readonly map: ArenaMap;
  readonly match: MatchInfo;
  readonly predicted: PlayerSim | null;
  readonly latestPoses: ReadonlyMap<string, PoseData>;
  /** View angles (rad); features may nudge them (recoil). */
  yaw: number;
  pitch: number;
  /** Smoothed vertical FOV (deg) of the world camera. */
  readonly fov: number;
  isEnemy(id: string): boolean;
  playerName(id: string): { name: string; color: string };
}

/** Camera modifiers from MovementFx, applied after placing the camera at the predicted feet. */
export interface CameraFx {
  /** Eye height above the feet (m). */
  eye: number;
  /** Camera roll (rad). */
  roll: number;
  /** Degrees added to the FOV target. */
  fovAdd: number;
  /** Downward camera offset (m), e.g. a landing dip. */
  dipY: number;
}

/** Hook points, called in feature order [moveFx, itemsFx, weaponFx, mapFx]. Every hook is optional. */
export interface ArenaFeature {
  onMapLoaded?(map: ArenaMap, world: BoxWorld): void;
  onMapDisposed?(): void;
  /** Once per frame, after input.consume(), before commands are built. */
  beforeCommands?(input: InputFrame, dt: number): void;
  /** Extra buttons OR-ed into one 60 Hz command (before it is predicted). `p` is the state *before* this command. */
  commandButtons?(p: PlayerSim | null, first: boolean): number;
  /** After a command was applied to the predicted player (not called for reconciliation replays). */
  onLocalCommand?(ev: CommandEvents, p: PlayerSim): void;
  /** Every authoritative event, after ArenaGame's generic handling. */
  onEvent?(e: ArenaEvent): void;
  /** Phase changed; prev is null on the first frame. Runs after ArenaGame's generic handling. */
  onPhase?(phase: Phase, prev: Phase | null): void;
  /** Per frame, after the camera is placed. */
  update?(dt: number, remotes: ReadonlyMap<string, RemotePose>): void;
  /** Per frame, last before rendering (aim assist, auto-shoot targeting for the next frame). */
  lateUpdate?(dt: number, input: InputFrame, remotes: ReadonlyMap<string, RemotePose>): void;
  onSettings?(s: Readonly<Settings>, changed: readonly (keyof Settings)[]): void;
  dispose?(): void;
}

/**
 * Voxelvale game: wires renderer, world streaming, player, interaction,
 * HUD, touch/keyboard input, sky, and (optionally) networking together and
 * runs the frame loop.
 */
import * as THREE from 'three';
import {
  Block,
  createWorldGenerator,
  DAY_LENGTH_SECONDS,
  forwardFromYawPitch,
  HOTBAR_BLOCKS,
  StreamedFluids,
  type VoxelMode,
  WORLD_LIMIT,
} from '@hub/shared';
import { audio } from '../../core/audio/audio';
import { isTouchDevice } from '../../core/device';
import { InputManager, type InputFrame } from '../../core/input/InputManager';
import { KeyboardMouse } from '../../core/input/KeyboardMouse';
import { TouchControls } from '../../core/input/TouchControls';
import { GameRenderer } from '../../core/render/GameRenderer';
import { StatsOverlay } from '../../core/render/StatsOverlay';
import { settings } from '../../core/settings';
import { h } from '../../core/ui/dom';
import { dialog, type LoadingScreen } from '../../core/ui/overlays';
import { isSettingsOpen } from '../../core/ui/settingsMenu';
import { PauseMenu } from '../common/PauseMenu';
import { voxelTouchLayout } from './controls';
import { BlockFx } from './fx/BlockFx';
import { ParkourRun } from './parkour/ParkourRun';
import { BlockInteraction } from './player/BlockInteraction';
import { LocalPlayer } from './player/LocalPlayer';
import { Sky, SKY_RADIUS } from './sky/Sky';
import { formatTime, VoxelHud } from './ui/VoxelHud';
import { createAtlasCanvas, createAtlasTexture } from './world/atlas';
import { createBlockGeometry } from './world/blockGeometry';
import { createCrackMaterial, createLiquidMaterial, createOpaqueMaterial, createVoxelUniforms } from './world/materials';
import { defaultWorkerCount, WorkerPool } from './world/WorkerPool';
import { World } from './world/World';

/** Hooks the multiplayer layer plugs into (phase 3). Offline play uses the defaults. */
export interface VoxelNetHooks {
  roomCode: string;
  ping(): number;
  /** Called for every local edit request; return false to stop local application. */
  requestEdit(x: number, y: number, z: number, id: number): boolean;
  /** Called every frame with the local player's state. */
  sendState(x: number, y: number, z: number, yaw: number, pitch: number, flags: number): void;
  /** Called every frame to update remote players etc. */
  update(dt: number, camera: THREE.Camera): void;
  isOccupied(x: number, y: number, z: number): boolean;
  openChat?(): void;
  isChatOpen?(): boolean;
  roomBest?(): { name: string; ms: number } | null;
  players?(): { name: string; color: number; you: boolean; connected: boolean }[];
  parkourEvent?(e: { kind: string; index?: number; timeMs?: number }): void;
  serverTime?(): number | null;
  dispose(): void;
}

export interface VoxelGameOptions {
  container: HTMLElement;
  seed: number;
  mode: VoxelMode;
  loading: LoadingScreen;
  onExit: (message?: string) => void;
  /** Saved edits / position for offline worlds. */
  initialEdits?: [number, number, number, number][];
  initialPlayer?: { x: number; y: number; z: number; yaw: number; pitch: number } | null;
  initialTime?: number;
  /** Show the chat button (online play). */
  chat?: boolean;
  /** Persist offline worlds (called periodically and on exit). */
  onSave?: (game: VoxelGame) => void;
  onResetWorld?: () => void;
}

const OFFLINE_SAVE_INTERVAL = 30;
/** Offline water simulation rate (online, the server runs it). */
const FLUID_INTERVAL = 0.2;

export class VoxelGame {
  readonly renderer: GameRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(72, 1, 0.08, 500);
  readonly world: World;
  readonly player: LocalPlayer;
  readonly sky: Sky;
  readonly input = new InputManager();
  readonly hud: VoxelHud;
  readonly parkour: ParkourRun | null;
  net: VoxelNetHooks | null = null;

  private readonly pool: WorkerPool;
  private readonly uniforms;
  private readonly fx: BlockFx;
  readonly interaction: BlockInteraction;
  private readonly kbm: KeyboardMouse;
  private readonly touch: TouchControls | null;
  private readonly stats: StatsOverlay;
  private readonly pause: PauseMenu;
  private readonly handScene = new THREE.Scene();
  private readonly handCamera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);
  private held: THREE.Mesh;
  private heldBlock: Block = HOTBAR_BLOCKS[0];
  /** Sky and block light on the held block (0..15), easing toward the light at the eye. */
  private heldSky = 15;
  private heldLamp = 0;
  /** Light bytes last written into the held block's geometry (-1: rewrite). */
  private heldLightKey = -1;
  private readonly clickToPlay: HTMLElement | null;
  private raf = 0;
  private running = false;
  private disposed = false;
  private saveTimer = OFFLINE_SAVE_INTERVAL;
  /** Flowing water for offline play; online, water changes arrive as server edits. */
  private readonly fluids: StreamedFluids;
  private fluidTimer = FLUID_INTERVAL;
  private readonly unsubscribeSettings: () => void;
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpEye = new THREE.Vector3();
  private readonly fwd = { x: 0, y: 0, z: 0 };
  private readonly resizeOff: () => void;

  constructor(private readonly opts: VoxelGameOptions) {
    const { container, seed, mode } = opts;
    this.renderer = new GameRenderer(container);
    this.renderer.renderer.autoClear = false;

    // World + materials
    const atlasCanvas = createAtlasCanvas();
    const atlas = createAtlasTexture(atlasCanvas);
    this.uniforms = createVoxelUniforms(atlas);
    const opaque = createOpaqueMaterial(this.uniforms);
    const liquid = createLiquidMaterial(this.uniforms);
    this.pool = new WorkerPool(defaultWorkerCount());
    this.world = new World(this.pool, seed, mode, opaque, liquid);
    this.applyRenderDistance();
    this.scene.add(this.world.group);

    this.sky = new Sky(Math.round(40 * this.renderer.profile.effects));
    if (opts.initialTime !== undefined) this.sky.time = opts.initialTime;
    this.scene.add(this.sky.group);
    this.scene.add(this.camera);

    this.fx = new BlockFx(createCrackMaterial(this.uniforms), this.renderer.profile.effects);
    this.scene.add(this.fx.group);

    // Player at the generator's spawn (or the saved offline position).
    const gen = createWorldGenerator(seed, mode);
    const spawn = opts.initialPlayer ?? { ...gen.findSpawn(), yaw: 0, pitch: 0 };
    this.player = new LocalPlayer(this.camera, spawn.x, spawn.y, spawn.z);
    this.player.yaw = spawn.yaw;
    this.player.pitch = spawn.pitch;
    this.parkour = gen.course ? new ParkourRun(gen.course, `${seed}`) : null;
    if (this.parkour) this.player.yaw = -Math.PI / 2; // face along +X, the course direction

    for (const e of opts.initialEdits ?? []) this.world.setBlock(e[0], e[1], e[2], e[3]);
    this.fluids = new StreamedFluids(this.world);
    this.fluids.restore(opts.initialEdits ?? []);

    this.interaction = new BlockInteraction(
      {
        getBlock: this.world.getBlock,
        canEdit: () => !this.parkour,
        edit: (x, y, z, id) => this.requestEdit(x, y, z, id),
        isOccupied: (x, y, z) => this.net?.isOccupied(x, y, z) ?? false,
      },
      this.fx,
    );

    // Held block in a separate overlay pass so it never clips into walls.
    this.handScene.add(new THREE.AmbientLight(0xffffff, 1));
    this.held = new THREE.Mesh(createBlockGeometry(this.heldBlock, 0.24), opaque);
    this.handScene.add(this.held);

    // Input
    this.kbm = new KeyboardMouse(this.input, this.renderer.canvas);
    this.kbm.onUnlock = () => this.openPause();
    this.touch = isTouchDevice()
      ? new TouchControls(this.input, voxelTouchLayout(() => this.openPause(), opts.chat ? () => this.net?.openChat?.() : null), container)
      : null;
    if (this.parkour) {
      this.touch?.setButton('break', { hidden: true });
      this.touch?.setButton('place', { hidden: true });
    }

    this.hud = new VoxelHud(container, atlasCanvas, (i) => this.input.selectSlot(i), !!this.parkour);
    this.stats = new StatsOverlay(container, this.renderer, () => this.net?.ping() ?? null);
    this.pause = new PauseMenu(container, {
      title: this.parkour ? 'Voxelvale · Parkour' : 'Voxelvale',
      roomCode: null,
      onResume: () => this.resume(),
      onLeave: () => this.exit(),
      onEditLayout: this.touch ? () => this.editLayout() : undefined,
      extra: this.pauseExtras(),
      players: () => this.net?.players?.() ?? [],
    });
    this.clickToPlay = this.touch
      ? null
      : h('div', { class: 'click-to-play', onclick: () => this.kbm.lock() },
          h('div', { class: 'ctp-card' },
            h('h2', null, 'Click to play'),
            h('p', null, 'WASD move · Space jump · Shift sprint · Ctrl crouch'),
            h('p', null, 'Left click break · Right click place · Wheel / 1-0 pick block · Esc menu'),
          ),
        );
    if (this.clickToPlay) container.appendChild(this.clickToPlay);

    this.resizeOff = this.renderer.onResize((w, hgt) => {
      this.camera.aspect = w / hgt;
      this.camera.updateProjectionMatrix();
      this.handCamera.aspect = w / hgt;
      this.handCamera.updateProjectionMatrix();
    });
    this.unsubscribeSettings = settings.subscribe((_s, changed) => {
      if (changed.includes('renderDistance') || changed.includes('quality') || changed.includes('detectedQuality')) this.applyRenderDistance();
    });
    document.addEventListener('visibilitychange', this.onVisibility);
    if (import.meta.env.DEV) (window as unknown as { __voxel?: VoxelGame }).__voxel = this;
  }

  /** Streams in the spawn area, reporting progress, then starts the loop. */
  async start(): Promise<void> {
    const { loading } = this.opts;
    const b = this.player.body;
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (this.disposed) return resolve();
        this.world.update(b.x, b.z);
        const r = this.world.readiness(b.x, b.z, 1);
        loading.set(0.4 + r * 0.55, 'Building terrain');
        if (r >= 1) resolve();
        else requestAnimationFrame(tick);
      };
      tick();
    });
    this.player.unstick(this.world.getBlock);
    audio.playMusic('voxel');
    this.running = true;
    this.raf = requestAnimationFrame(this.frame);
  }

  setNet(net: VoxelNetHooks): void {
    this.net = net;
    this.pause.setRoomCode(net.roomCode);
    this.fluids.clear();
  }

  /** Applies an edit coming from the server (or local offline play). */
  applyEdit(x: number, y: number, z: number, id: number): void {
    this.world.setBlock(x, y, z, id);
  }

  /**
   * The edits an offline save should keep: the world's edits without the
   * cells only flowing water wrote (saved sources flow again after loading).
   */
  savedEdits(): Iterable<[number, number, number, number]> {
    return this.fluids.saveEdits(this.world.allEdits());
  }

  exit(message?: string): void {
    this.opts.onSave?.(this);
    this.opts.onExit(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.unsubscribeSettings();
    this.resizeOff();
    this.net?.dispose();
    this.kbm.dispose();
    this.touch?.dispose();
    this.hud.dispose();
    this.stats.dispose();
    this.pause.close();
    this.clickToPlay?.remove();
    this.world.dispose();
    this.pool.dispose();
    this.sky.dispose();
    this.fx.dispose();
    this.held.geometry.dispose();
    this.renderer.dispose();
  }

  // ---- frame loop ---------------------------------------------------------------------

  private frame = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    if (!this.renderer.frameAllowed()) return;
    const dt = this.renderer.beginFrame();
    const input = this.input.consume();
    const paused = this.pause.isOpen || isSettingsOpen() || this.touch?.isEditing() === true || this.net?.isChatOpen?.() === true;
    this.input.setEnabled(!paused);

    if (input.pressed.has('menu')) this.togglePause();
    if (input.pressed.has('chat')) this.net?.openChat?.();
    if (input.pressed.has('scoreboard')) this.hud.toggleHelp();
    this.handleHotbar(input);

    // Look + movement
    this.player.look(input.lookYaw, input.lookPitch);
    const b = this.player.body;
    this.player.update(
      dt,
      {
        strafe: input.moveX,
        forward: input.moveY,
        jump: input.held.has('jump'),
        crouch: input.held.has('crouch'),
        sprint: input.held.has('sprint') || input.stickSprint,
        autoJump: settings.get().autoJump,
      },
      this.world.getBlock,
      !this.world.isLoaded(b.x, b.z),
    );
    this.clampToWorld();
    this.world.update(b.x, b.z);

    // Interaction
    forwardFromYawPitch(this.player.yaw, this.player.pitch, this.fwd);
    this.tmpDir.set(this.fwd.x, this.fwd.y, this.fwd.z);
    this.camera.getWorldPosition(this.tmpEye);
    this.interaction.update(dt, input, this.tmpEye, this.tmpDir, HOTBAR_BLOCKS[this.hud.selected], b);

    // Parkour rules
    if (this.parkour) this.updateParkour();
    if (!this.net) this.updateFluids(dt);

    // Sky / lighting
    const serverTime = this.net?.serverTime?.() ?? null;
    if (serverTime !== null) this.sky.time = serverTime;
    this.sky.update(serverTime !== null ? 0 : dt / DAY_LENGTH_SECONDS, this.camera.position);
    this.updateLighting();

    this.fx.update(dt);
    this.net?.sendState(b.x, b.y, b.z, this.player.yaw, this.player.pitch, (this.player.crouching ? 1 : 0) | (b.inWater ? 2 : 0));
    this.net?.update(dt, this.camera);
    this.updateHeldItem(dt);
    this.hud.setUnderwater(b.headInWater);
    this.clickToPlay?.classList.toggle('hidden', paused || this.kbm.isLocked());

    // Render world, then the held block on top.
    const r = this.renderer.renderer;
    r.clear();
    r.render(this.scene, this.camera);
    r.clearDepth();
    r.render(this.handScene, this.handCamera);

    if (this.opts.onSave) {
      this.saveTimer -= dt;
      if (this.saveTimer <= 0) {
        this.saveTimer = OFFLINE_SAVE_INTERVAL;
        this.opts.onSave(this);
      }
    }
  };

  private updateLighting(): void {
    const u = this.uniforms;
    u.uDaylight.value = this.sky.daylight;
    u.uTime.value = performance.now() / 1000;
    const underwater = this.player.body.headInWater;
    const far = this.world.renderDistance * 16;
    if (underwater) {
      u.uFogColor.value.setHex(0x1d4f7a).multiplyScalar(0.4 + this.sky.daylight * 0.6);
      u.uFogNear.value = 2;
      u.uFogFar.value = 22;
    } else {
      u.uFogColor.value.copy(this.sky.horizon);
      u.uFogNear.value = far * 0.6;
      u.uFogFar.value = far * 0.95;
    }
  }

  private handleHotbar(input: InputFrame): void {
    if (this.parkour) return;
    let idx = this.hud.selected;
    if (input.slotSelect !== null && input.slotSelect < HOTBAR_BLOCKS.length) idx = input.slotSelect;
    if (input.slotDelta) idx += input.slotDelta;
    if (idx !== this.hud.selected) {
      this.hud.select(idx);
      audio.play('click');
      this.setHeldBlock(HOTBAR_BLOCKS[this.hud.selected]);
    }
  }

  private setHeldBlock(block: Block): void {
    if (block === this.heldBlock) return;
    this.heldBlock = block;
    this.held.geometry.dispose();
    this.held.geometry = createBlockGeometry(block, 0.24);
    this.heldLightKey = -1;
  }

  private updateHeldItem(dt: number): void {
    this.held.visible = !this.parkour;
    const b = this.player.body;
    const speed = Math.hypot(b.vx, b.vz);
    const t = performance.now() / 1000;
    const bob = b.onGround ? Math.sin(t * 9) * 0.012 * Math.min(1, speed / 4) : 0;
    const swing = this.interaction.swing;
    this.held.position.set(0.34, -0.25 + bob - swing * 0.06, -0.6 + swing * 0.08);
    this.held.rotation.set(0.25 - swing * 0.6, -0.6 + swing * 0.2, 0.08);
    this.updateHeldLight(dt);
  }

  /** Lights the held block like the cell the eye is in (dark in caves, warm near lamps). */
  private updateHeldLight(dt: number): void {
    const e = this.tmpEye;
    const light = this.world.lightAt(Math.floor(e.x), Math.floor(e.y), Math.floor(e.z));
    const ease = Math.min(1, dt * 6);
    this.heldSky += ((light >> 4) - this.heldSky) * ease;
    this.heldLamp += ((light & 15) - this.heldLamp) * ease;
    const sky = Math.round(this.heldSky * 17);
    const lamp = Math.round(this.heldLamp * 17);
    const key = (sky << 8) | lamp;
    if (key === this.heldLightKey) return;
    this.heldLightKey = key;
    const attr = this.held.geometry.getAttribute('light') as THREE.BufferAttribute;
    const bytes = attr.array as Uint8Array;
    for (let i = 0; i < attr.count; i++) {
      bytes[i * 4 + 1] = sky;
      bytes[i * 4 + 2] = lamp;
    }
    attr.needsUpdate = true;
  }

  private requestEdit(x: number, y: number, z: number, id: number): void {
    if (this.net) {
      if (!this.net.requestEdit(x, y, z, id)) return;
    }
    this.world.setBlock(x, y, z, id);
    if (!this.net) this.fluids.notifyEdit(x, y, z);
  }

  /** Offline water: a few simulation steps per second, like the server. */
  private updateFluids(dt: number): void {
    this.fluidTimer -= dt;
    if (this.fluidTimer > 0) return;
    this.fluidTimer = FLUID_INTERVAL;
    this.fluids.step();
  }

  private updateParkour(): void {
    const run = this.parkour!;
    const b = this.player.body;
    const ev = run.update(b.x, b.y, b.z, b.onGround, this.world.getBlock);
    if (ev) {
      this.net?.parkourEvent?.(ev);
      switch (ev.kind) {
        case 'start':
          this.hud.flash('Go!', 800, 'good');
          audio.play('countdown');
          break;
        case 'checkpoint':
          this.hud.flash(`Checkpoint ${ev.index}/${run.totalCheckpoints}`, 1300, 'good');
          audio.play('checkpoint');
          break;
        case 'respawn': {
          const p = run.respawnPoint();
          this.player.teleport(p.x, p.y, p.z);
          this.hud.flash('Back to checkpoint', 900);
          audio.play('splash');
          break;
        }
        case 'finish':
          this.hud.flash(ev.best ? `New best! ${(ev.timeMs / 1000).toFixed(2)} s` : `Finished in ${(ev.timeMs / 1000).toFixed(2)} s`, 3500, 'good');
          audio.play('finish');
          break;
      }
    }
    this.hud.setParkour(run.elapsedMs, run.checkpoint, run.totalCheckpoints, run.best, run.running);
    const roomBest = this.net?.roomBest?.();
    this.hud.setRoomBest(roomBest ? `Room best: ${roomBest.name} ${formatTime(roomBest.ms)}` : '');
  }

  private clampToWorld(): void {
    const b = this.player.body;
    const lim = WORLD_LIMIT - 0.5;
    b.x = Math.max(-lim, Math.min(lim, b.x));
    b.z = Math.max(-lim, Math.min(lim, b.z));
  }

  private applyRenderDistance(): void {
    const s = settings.get();
    // The slider wins; low-quality devices are capped to keep frame time sane.
    const cap = this.renderer.profile.preset === 'low' ? 3 : this.renderer.profile.preset === 'medium' ? 5 : 8;
    this.world.renderDistance = Math.min(cap, s.renderDistance);
    const far = this.world.renderDistance * 16 + 32;
    this.camera.far = Math.max(SKY_RADIUS * 1.2, far);
    this.camera.updateProjectionMatrix();
  }

  private pauseExtras(): { label: string; onClick: () => void; danger?: boolean }[] {
    const extras: { label: string; onClick: () => void; danger?: boolean }[] = [];
    if (this.parkour) {
      extras.push({
        label: 'Restart course',
        onClick: () => {
          this.parkour!.restart();
          const p = this.parkour!.respawnPoint();
          this.player.teleport(p.x, p.y, p.z);
          this.player.yaw = -Math.PI / 2;
          this.net?.parkourEvent?.({ kind: 'restart' });
        },
      });
    }
    if (this.opts.onResetWorld) {
      extras.push({
        label: 'New world',
        danger: true,
        onClick: async () => {
          const ok = await dialog('Start a new world?', 'Your current offline world and its builds will be deleted.', [
            { label: 'Cancel', value: '' },
            { label: 'New world', value: 'yes', danger: true },
          ]);
          if (ok === 'yes') this.opts.onResetWorld!();
          else this.resume();
        },
      });
    }
    return extras;
  }

  private openPause(): void {
    if (this.pause.isOpen || this.disposed) return;
    this.kbm.unlock();
    this.pause.open();
    this.input.setEnabled(false);
  }

  private togglePause(): void {
    if (this.pause.isOpen) {
      this.pause.close();
      this.resume();
    } else this.openPause();
  }

  private resume(): void {
    this.input.setEnabled(true);
    if (!this.touch) this.kbm.lock();
  }

  private editLayout(): void {
    this.input.setEnabled(false);
    this.touch?.startEditing(() => this.resume());
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      this.opts.onSave?.(this);
      this.input.releaseAll();
    }
  };
}

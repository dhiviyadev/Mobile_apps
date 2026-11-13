/**
 * Voxelvale game: wires renderer, world streaming, player, interaction,
 * HUD, touch/keyboard input, sky, and (optionally) networking together and
 * runs the frame loop.
 */
import * as THREE from 'three';
import {
  blockDef,
  CHUNK_HEIGHT,
  createWorldGenerator,
  DAY_LENGTH_SECONDS,
  forwardFromYawPitch,
  type GenVersion,
  LATEST_GEN_VERSION,
  StreamedFluids,
  type WorldGenerator,
  type VoxelMode,
  type Waypoint,
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
import { EntityView } from './entities/EntityView';
import { LocalEntities } from './entities/LocalEntities';
import type { HotbarSource, InteractionHooks, MoveMods, VoxelModule } from './modules';
import type { VoxelNet } from './net/VoxelNet';
import { SurvivalController } from './survival/SurvivalController';
import { LocalTeleport, NetTeleport } from './teleport/backends';
import { TeleportController } from './teleport/TeleportController';
import { LocalPortal, NetPortal } from './portal/backends';
import { PortalController } from './portal/PortalController';
import { HeldItemView } from './render/HeldItemView';
import { createItemIcons } from './ui/itemIcons';
import { WorldFeatures } from './world/WorldFeatures';
import { BlockFx } from './fx/BlockFx';
import { ParkourRun } from './parkour/ParkourRun';
import { BlockInteraction } from './player/BlockInteraction';
import { LocalPlayer } from './player/LocalPlayer';
import { Sky, SKY_RADIUS } from './sky/Sky';
import { formatTime, type IconFor, VoxelHud } from './ui/VoxelHud';
import { createAtlasCanvas, createAtlasTexture } from './world/atlas';
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
  /** Terrain generator version of this world (online: VoxelState.genVersion; offline: save `gen`). Default LATEST. */
  genVersion?: GenVersion;
  /** Played through a server (set by net/online.ts): no local creature sim. */
  online?: boolean;
  /** Offline save payloads owned by packages (index.ts OfflineSave.mobs / .survival). */
  initialMobs?: unknown;
  initialSurvival?: unknown;
  /** Offline: saved teleport places and the auto-decline setting (from the world file's WAYP section). */
  initialPlaces?: Waypoint[];
  initialAutoDecline?: boolean;
  /** Extra pause menu entries (hosting: who can join, save now). */
  pauseExtras?: { label: string; onClick: () => void; danger?: boolean }[];
  /** Runs before leaving (hosting: wait for the server's last save); the exit waits for it. */
  beforeExit?: () => Promise<void>;
}

const OFFLINE_SAVE_INTERVAL = 30;
/** Offline water simulation rate (online, the server runs it). */
const FLUID_INTERVAL = 0.2;
/** Fog weight of height differences above water (uFogVertical): 200 blocks down fog like 30 sideways. */
const AIR_FOG_VERTICAL = 0.15;

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
  /** Same generator the workers use (biomes, structures, spawn). */
  readonly generator: WorldGenerator;
  // ---- packages (see modules.ts) ----
  readonly worldFeatures: WorldFeatures;
  /** Sandbox and survival (creative in sandbox); null in parkour. */
  readonly survival: SurvivalController | null;
  /** Creatures as rendered; null in parkour. */
  readonly entities: EntityView | null;
  /** Offline creature sim; null online and in parkour. */
  readonly localEntities: LocalEntities | null;
  /** Teleport menu (saved places, requests); null in parkour. */
  readonly teleport: TeleportController | null;
  /** Lattice Rings, the realm sky and its banners (package D). */
  readonly portal: PortalController | null;
  private readonly modules: VoxelModule[];
  /** Touch controls (packages relabel buttons with setButton). */
  readonly touchControls: TouchControls | null;

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
  /** First-person held item (WP-B): blocks, weapons, tools, shields, bows, food. */
  readonly heldView: HeldItemView;
  private heldBlock = -1;
  /** Terrain material and uniforms (survival drops, ghosts and held items share them). */
  readonly voxelMaterials: { opaque: THREE.ShaderMaterial; uniforms: ReturnType<typeof createVoxelUniforms> };
  /** Item icon drawer (hotbar, bag, picker). */
  readonly itemIcons: IconFor;
  /** The game's DOM container (modal overlays mount here). */
  readonly hudContainer: HTMLElement;
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
    this.voxelMaterials = { opaque, uniforms: this.uniforms };
    this.hudContainer = container;
    this.itemIcons = createItemIcons(atlasCanvas).iconFor;
    this.heldView = new HeldItemView(opaque, this.uniforms);
    this.pool = new WorkerPool(defaultWorkerCount());
    this.world = new World(this.pool, { seed, mode, genVersion: opts.genVersion ?? LATEST_GEN_VERSION }, opaque, liquid);
    this.applyRenderDistance();
    this.scene.add(this.world.group);

    this.sky = new Sky(Math.round(40 * this.renderer.profile.effects));
    if (opts.initialTime !== undefined) this.sky.time = opts.initialTime;
    this.scene.add(this.sky.group);
    this.scene.add(this.camera);

    this.fx = new BlockFx(createCrackMaterial(this.uniforms), this.renderer.profile.effects);
    this.scene.add(this.fx.group);

    // Player at the generator's spawn (or the saved offline position).
    const gen = createWorldGenerator(seed, mode, opts.genVersion ?? LATEST_GEN_VERSION);
    this.generator = gen;
    const spawn = opts.initialPlayer ?? { ...gen.findSpawn(), yaw: 0, pitch: 0 };
    this.player = new LocalPlayer(this.camera, spawn.x, spawn.y, spawn.z);
    this.player.yaw = spawn.yaw;
    this.player.pitch = spawn.pitch;
    this.parkour = gen.course ? new ParkourRun(gen.course, `${seed}`) : null;
    if (this.parkour) this.player.yaw = -Math.PI / 2; // face along +X, the course direction

    for (const e of opts.initialEdits ?? []) this.world.setBlock(e[0], e[1], e[2], e[3]);
    this.fluids = new StreamedFluids(this.world);
    this.fluids.restore(opts.initialEdits ?? []);

    // Packages. Order matters for hooks: creatures first, then survival, then the world area.
    this.worldFeatures = new WorldFeatures(this);
    const combat = mode !== 'parkour';
    this.survival = combat ? new SurvivalController(this, { mode: mode === 'survival' ? 'survival' : 'sandbox', online: !!opts.online, saved: opts.initialSurvival }) : null;
    this.entities = combat ? new EntityView(this) : null;
    this.localEntities = combat && !opts.online ? new LocalEntities(this, { mode, saved: opts.initialMobs }) : null;
    this.survival?.setEntities(this.localEntities?.api ?? null);
    this.teleport = combat ? new TeleportController(this) : null;
    if (this.teleport && !opts.online) {
      this.teleport.attach(new LocalTeleport(this, mode === 'survival', opts.initialPlaces ?? [], !!opts.initialAutoDecline, this.teleport.onEvent));
    }
    this.portal = combat ? new PortalController(this) : null;
    if (this.portal && !opts.online) this.portal.attach(new LocalPortal(this, mode === 'survival', this.portal.onEvent));
    // The portal module comes first: a Dusk Lens used on a Lattice Stone must not be taken as a placement.
    this.modules = [this.portal, this.entities, this.survival, this.worldFeatures, this.teleport].filter((m): m is NonNullable<typeof m> => m !== null);

    const hook = <K extends keyof InteractionHooks>(k: K): InteractionHooks[K] | undefined => this.modules.find((m) => m.interaction?.[k])?.interaction?.[k];
    // Creatures and players can both be under the crosshair, and creatures, chests and items can all use secondary: ask every module.
    const hooks = <K extends keyof InteractionHooks>(k: K) => this.modules.map((m) => m.interaction?.[k]).filter((f): f is NonNullable<InteractionHooks[K]> => !!f);
    this.interaction = new BlockInteraction(
      {
        getBlock: this.world.getBlock,
        canEdit: () => !this.parkour,
        edit: (x, y, z, id) => this.requestEdit(x, y, z, id),
        isOccupied: (x, y, z) => (this.net?.isOccupied(x, y, z) ?? false) || (this.entities?.overlapsCell(x, y, z) ?? false),
        breakSeconds: (b) => hook('breakSeconds')?.(b) ?? blockDef(b).hardness,
        onDigStart: (x, y, z) => {
          for (const f of hooks('onDigStart')) f(x, y, z);
        },
        entityDistance: () => Math.min(Infinity, ...hooks('entityDistance').map((f) => f())),
        onSecondary: (t, pressed) => hooks('onSecondary').some((f) => f(t, pressed)),
      },
      this.fx,
    );
    this.interaction.decorHidden = !this.world.decor;
    this.player.onStep = (b) => {
      for (const m of this.modules) m.onStep?.(b);
    };

    // Held item in a separate overlay pass so it never clips into walls.
    this.handScene.add(new THREE.AmbientLight(0xffffff, 1));
    this.handScene.add(this.heldView.group);

    // Input
    this.kbm = new KeyboardMouse(this.input, this.renderer.canvas);
    // The block picker releases the pointer itself: that is not a pause.
    this.kbm.onUnlock = () => {
      if (!this.modules.some((m) => m.isModalOpen?.())) this.openPause();
    };
    this.touch = isTouchDevice()
      ? new TouchControls(
          this.input,
          voxelTouchLayout({
            onMenu: () => this.openPause(),
            onChat: opts.chat ? () => this.net?.openChat?.() : null,
            onBlocks: mode === 'sandbox' ? () => this.worldFeatures.openPicker() : null,
            onInventory: mode === 'survival' ? () => this.survival?.openInventory() : null,
            onTeleport: combat ? () => this.teleport?.toggle() : null,
            combat,
          }),
          container,
        )
      : null;
    this.touchControls = this.touch;
    this.touch?.setButton('guard', { hidden: true });
    if (this.parkour) {
      this.touch?.setButton('break', { hidden: true });
      this.touch?.setButton('place', { hidden: true });
    }

    this.hud = new VoxelHud(container, this.itemIcons, (i) => this.input.selectSlot(i), !!this.parkour);
    this.hud.onLongPress = mode === 'sandbox' ? (i) => this.worldFeatures.openPicker(i) : null;
    this.syncHotbar(true);
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
            mode === 'sandbox' ? h('p', null, 'B blocks · Middle click pick block') : null,
            mode === 'parkour' ? null : h('p', null, `${mode === 'survival' ? 'E bag · Q drop · F swap hands · ' : ''}Z guard · Right click use / draw / eat · P teleport`),
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
    if ('session' in net) {
      this.survival?.attachNet(net as VoxelNet);
      this.entities?.attachNet(net as VoxelNet);
    }
    this.pause.setRoomCode(net.roomCode);
    if (this.teleport && 'session' in net) this.teleport.attach(new NetTeleport((net as VoxelNet).session, this.teleport.onEvent));
    if (this.portal && 'session' in net) this.portal.attach(new NetPortal((net as VoxelNet).session, this.portal.onEvent));
    this.fluids.clear();
  }

  /** Applies an edit coming from the server (or local offline play). */
  applyEdit(x: number, y: number, z: number, id: number): void {
    this.world.setBlock(x, y, z, id);
  }

  /**
   * Offline gameplay edit (boss altar -> dormant, support cascades): applied,
   * kept in the save like a player edit, seen by fluids and packages.
   */
  applyWorldEdit(x: number, y: number, z: number, id: number): void {
    const before = this.world.getBlock(x, y, z);
    if (before === id) return;
    this.world.setBlock(x, y, z, id);
    this.fluids.notifyEdit(x, y, z);
    for (const m of this.modules) m.afterLocalEdit?.(x, y, z, before, id);
  }

  /** Hotbar owner in this mode (survival inventory, else the sandbox hotbar). */
  get hotbar(): HotbarSource {
    return this.survival?.hotbar ?? this.worldFeatures.hotbar;
  }

  /**
   * The edits an offline save should keep: the world's edits without the
   * cells only flowing water wrote (saved sources flow again after loading).
   */
  savedEdits(): Iterable<[number, number, number, number]> {
    return this.fluids.saveEdits(this.world.allEdits());
  }

  private exiting = false;

  exit(message?: string): void {
    if (this.exiting) return;
    this.exiting = true;
    this.opts.onSave?.(this);
    const before = this.opts.beforeExit;
    if (!before) {
      this.opts.onExit(message);
      return;
    }
    const note = h('div', { class: 'tp-warm', 'data-testid': 'saving-note' }, 'Saving your world…');
    this.hudContainer.appendChild(note);
    void before()
      .catch(() => undefined)
      .then(() => this.opts.onExit(message));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.unsubscribeSettings();
    this.resizeOff();
    for (const m of this.modules) m.dispose?.();
    this.localEntities?.dispose();
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
    this.heldView.dispose();
    this.renderer.dispose();
  }

  // ---- frame loop ---------------------------------------------------------------------

  private frame = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    if (!this.renderer.frameAllowed()) return;
    const dt = this.renderer.beginFrame();
    const input = this.input.consume();
    const modal = this.modules.some((m) => m.isModalOpen?.());
    const paused = modal || this.pause.isOpen || isSettingsOpen() || this.touch?.isEditing() === true || this.net?.isChatOpen?.() === true;
    this.input.setEnabled(!paused);

    if (input.pressed.has('menu') && !modal) this.togglePause();
    if (input.pressed.has('chat')) this.net?.openChat?.();
    if (input.pressed.has('scoreboard')) this.hud.toggleHelp();
    this.handleHotbar(input);

    // Packages adjust movement (guard, draw, eating, slow, starving; dead/resting lock it).
    const mods: MoveMods = {};
    for (const m of this.modules) {
      const r = m.beforePhysics?.(dt, input);
      if (!r) continue;
      mods.speedMul = (mods.speedMul ?? 1) * (r.speedMul ?? 1);
      mods.noSprint = mods.noSprint || r.noSprint;
      mods.locked = mods.locked || r.locked;
    }

    // Look + movement
    this.player.look(input.lookYaw, input.lookPitch);
    const b = this.player.body;
    const locked = mods.locked === true;
    this.player.update(
      dt,
      {
        strafe: locked ? 0 : input.moveX,
        forward: locked ? 0 : input.moveY,
        jump: !locked && input.held.has('jump'),
        crouch: !locked && input.held.has('crouch'),
        sprint: !locked && (input.held.has('sprint') || input.stickSprint),
        autoJump: settings.get().autoJump,
        speedMul: mods.speedMul,
        noSprint: mods.noSprint,
      },
      this.world.getBlock,
      !this.world.isLoaded(b.x, b.z),
    );
    this.clampToWorld();
    this.world.update(b.x, b.z);
    this.localEntities?.update(dt, paused);

    // Interaction
    forwardFromYawPitch(this.player.yaw, this.player.pitch, this.fwd);
    this.tmpDir.set(this.fwd.x, this.fwd.y, this.fwd.z);
    this.camera.getWorldPosition(this.tmpEye);
    this.interaction.update(dt, input, this.tmpEye, this.tmpDir, locked ? null : this.hotbar.placeable(this.hud.selected), b, this.player.yaw);

    // Parkour rules
    if (this.parkour) this.updateParkour();
    if (!this.net) this.updateFluids(dt);

    // Sky / lighting
    const serverTime = this.net?.serverTime?.() ?? null;
    if (serverTime !== null) this.sky.time = serverTime;
    this.sky.update(serverTime !== null ? 0 : dt / DAY_LENGTH_SECONDS, this.camera.position);
    this.updateLighting();

    this.fx.update(dt);
    this.entities?.render(dt, this.camera, this.sky.daylight);
    for (const m of this.modules) m.update?.(dt, input, paused);
    this.syncHotbar(false);
    this.net?.sendState(b.x, b.y, b.z, this.player.yaw, this.player.pitch, (this.player.crouching ? 1 : 0) | (b.inWater ? 2 : 0) | (this.player.sprinting ? 4 : 0));
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
      u.uFogVertical.value = 1;
    } else {
      u.uFogColor.value.copy(this.sky.horizon);
      // Biome fog tint (WorldFeatures eases it between biomes).
      const tint = this.worldFeatures.fogTint;
      if (tint.weight > 0) u.uFogColor.value.lerp(tint.color, (0.15 + 0.15 * this.sky.daylight) * tint.weight);
      // The Gloamreach is hazier: its mist closes the view in a little.
      const gloam = this.sky.realmMix;
      u.uFogNear.value = far * (0.6 - 0.28 * gloam);
      u.uFogFar.value = far * (0.95 - 0.2 * gloam);
      // Height counts little: the ground stays visible from the top of a tall build.
      u.uFogVertical.value = AIR_FOG_VERTICAL;
    }
  }

  private handleHotbar(input: InputFrame): void {
    if (this.parkour) return;
    let idx = this.hud.selected;
    const n = this.hotbar.views().length;
    if (input.slotSelect !== null && input.slotSelect < n) idx = input.slotSelect;
    if (input.slotDelta) idx += input.slotDelta;
    if (idx !== this.hud.selected) {
      this.hud.select(idx);
      audio.play('click');
      this.setHeldBlock(this.hotbar.heldItem(this.hud.selected));
    }
  }

  /** Pushes hotbar changes from its owner to the HUD (and the held block). */
  private syncHotbar(force: boolean): void {
    const src = this.hotbar;
    if (!src.takeChanged() && !force) return;
    this.hud.setSlots(src.views());
    this.hud.setOffhand(src.offhand?.());
    this.setHeldBlock(src.heldItem(this.hud.selected));
  }

  /** The held item model (blocks, weapons, tools, shields, bows, food). */
  private setHeldBlock(item: number): void {
    if (item === this.heldBlock) return;
    this.heldBlock = item;
    this.heldView.setItem(item);
  }

  private updateHeldItem(dt: number): void {
    this.heldView.visible = !this.parkour;
    const b = this.player.body;
    const speed = Math.hypot(b.vx, b.vz);
    const t = performance.now() / 1000;
    const bob = b.onGround ? Math.sin(t * 9) * 0.012 * Math.min(1, speed / 4) : 0;
    const e = this.tmpEye;
    this.heldView.update(dt, bob, this.interaction.swing, this.world.lightAt(Math.floor(e.x), Math.floor(e.y), Math.floor(e.z)));
    // Hurt kick: a short camera roll toward the hit side.
    if (settings.get().cameraMotion) this.camera.rotation.z = this.heldView.hurtRoll;
  }

  /** Frees the mouse for an overlay (bag, death screen) without opening the pause menu. */
  releasePointer(): void {
    this.kbm.unlock();
  }

  /** Takes the mouse back after an overlay closes (desktop). */
  capturePointer(): void {
    if (!this.touch && !this.pause.isOpen) this.kbm.lock();
  }

  private requestEdit(x: number, y: number, z: number, id: number): void {
    if (this.net) {
      if (!this.net.requestEdit(x, y, z, id)) return;
    }
    const before = this.world.getBlock(x, y, z);
    this.world.setBlock(x, y, z, id);
    if (!this.net) {
      this.fluids.notifyEdit(x, y, z);
      for (const m of this.modules) m.afterLocalEdit?.(x, y, z, before, id);
    }
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
    const lim = this.generator.limit - 0.5;
    b.x = Math.max(-lim, Math.min(lim, b.x));
    b.z = Math.max(-lim, Math.min(lim, b.z));
  }

  private applyRenderDistance(): void {
    const s = settings.get();
    // The slider wins; low-quality devices are capped to keep frame time sane.
    const cap = this.renderer.profile.preset === 'low' ? 3 : this.renderer.profile.preset === 'medium' ? 5 : 8;
    this.world.renderDistance = Math.min(cap, s.renderDistance);
    // Dense ground cover costs vertices: hidden on the low preset (and not targeted then).
    this.world.decor = this.renderer.profile.preset !== 'low';
    if (this.interaction) this.interaction.decorHidden = !this.world.decor;
    // Far enough for the sky, the loaded chunks and the ground seen from the build height.
    const far = Math.hypot(this.world.renderDistance * 16 + 32, CHUNK_HEIGHT);
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
    if (this.teleport) extras.push({ label: 'Teleport…', onClick: () => this.teleport!.open() });
    extras.push(...(this.survival?.pauseEntries() ?? []));
    extras.push(...(this.opts.pauseExtras ?? []));
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
    this.opts.onSave?.(this);
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

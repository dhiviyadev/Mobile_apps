/**
 * Arcfire Arena client game.
 *
 * Netcode model (identical offline and online):
 *  - Input is sampled into 60 Hz commands. Each command is applied to a
 *    locally predicted copy of our player immediately (movement, weapon
 *    timers, ammo, spread) and sent to the authority.
 *  - When a snapshot arrives, we take the authoritative state for the last
 *    acknowledged command and replay the not-yet-acknowledged commands on
 *    top (reconciliation). Small differences are smoothed visually.
 *  - Other players are drawn slightly in the past, interpolated between the
 *    two snapshots around the render time. The tick we render at is sent
 *    with every command so the server can rewind hitboxes (lag compensation).
 *
 * Presentation that belongs to one feature lives in a feature module
 * (features/: movement, items, weapons, maps) that ArenaGame calls at fixed
 * hook points (features/types.ts); this class keeps the frame loop, netcode,
 * camera and the generic match UI.
 */
import * as THREE from 'three';
import {
  applyCommand,
  type ArenaEvent,
  type ArenaMap,
  type BoxWorld,
  Buttons,
  clonePlayerSim,
  CMD_DT,
  type Command,
  createArenaWorld,
  flatArenaMap,
  type Phase,
  type PlayerSim,
  TICK_RATE,
  viewDir,
  WeaponId,
  weaponDef,
} from '@hub/shared';
import { audio } from '../../core/audio/audio';
import { isTouchDevice } from '../../core/device';
import { type InputFrame, InputManager } from '../../core/input/InputManager';
import { KeyboardMouse } from '../../core/input/KeyboardMouse';
import { TouchControls } from '../../core/input/TouchControls';
import { GameRenderer } from '../../core/render/GameRenderer';
import { StatsOverlay } from '../../core/render/StatsOverlay';
import { settings } from '../../core/settings';
import { h, hexColor } from '../../core/ui/dom';
import { isSettingsOpen } from '../../core/ui/settingsMenu';
import { AvatarRenderer, type AvatarPose } from '../common/Avatars';
import { PauseMenu } from '../common/PauseMenu';
import type { ArenaBackend, MatchInfo, PoseData, SnapshotFrame } from './backend';
import { arenaTouchLayout } from './controls';
import { ItemsFx } from './features/ItemsFx';
import { MapFx } from './features/MapFx';
import { MovementFx } from './features/MovementFx';
import { type ArenaClient, type ArenaFeature, BASE_FOV, type RemotePose } from './features/types';
import { WeaponFx } from './features/WeaponFx';
import { Effects } from './render/Effects';
import { arenaHeldModel } from './render/heldModels';
import { buildMapMesh, buildSkyDome } from './render/MapRenderer';
import { Viewmodel } from './render/Viewmodel';
import { ArenaHud } from './ui/ArenaHud';
import { LoadoutPicker } from './ui/LoadoutPicker';
import { MatchEndScreen, Scoreboard, TEAM_COLORS, TEAM_NAMES } from './ui/Scoreboard';
import { WarmupPanel } from './ui/WarmupPanel';
import type { NetMatchInfo } from './net/NetBackend';

const MAX_CMDS_PER_FRAME = 6;
const SNAP_BUFFER = 40;

export interface ArenaChat {
  toggle(): void;
  readonly isOpen: boolean;
  dispose(): void;
}

export interface ArenaGameOptions {
  container: HTMLElement;
  backend: ArenaBackend;
  onExit: (message?: string) => void;
  /** Online only: builds the chat box once the game exists. */
  createChat?: (container: HTMLElement) => ArenaChat;
}

export class ArenaGame implements ArenaClient {
  readonly renderer: GameRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 300);
  readonly backend: ArenaBackend;
  readonly container: HTMLElement;
  world!: BoxWorld;
  map!: ArenaMap;
  private mapMesh: THREE.Mesh | null = null;
  private sky: THREE.Mesh | null = null;
  readonly avatars = new AvatarRenderer(8, { heldModel: arenaHeldModel });
  readonly effects: Effects;
  readonly viewmodel = new Viewmodel();
  readonly input = new InputManager();
  readonly kbm: KeyboardMouse;
  readonly touch: TouchControls | null;
  readonly hud: ArenaHud;
  private readonly loadout: LoadoutPicker;
  private readonly scoreboard: Scoreboard;
  private readonly matchEnd: MatchEndScreen;
  private readonly pause: PauseMenu;
  private readonly stats: StatsOverlay;
  private readonly chat: ArenaChat | null;
  private readonly clickToPlay: HTMLElement | null;
  private readonly warmup: WarmupPanel | null;

  // feature modules (hook order = this order)
  readonly moveFx: MovementFx;
  readonly itemsFx: ItemsFx;
  readonly weaponFx: WeaponFx;
  readonly mapFx: MapFx;
  private readonly features: ArenaFeature[];
  private readonly settingsOff: () => void;

  // prediction
  predicted: PlayerSim | null = null;
  private readonly renderPrev = new THREE.Vector3();
  private readonly renderCur = new THREE.Vector3();
  private readonly correction = new THREE.Vector3();
  private pending: Command[] = [];
  private seq = 0;
  private cmdAcc = 0;
  /** Edge-triggered buttons (slide, reload) waiting for the next command; survives frames that build none. */
  private edgeButtons = 0;
  yaw = 0;
  pitch = 0;
  private wantSlot = 0;
  private meleeUntil = 0;
  fov = BASE_FOV;
  private shake = 0;

  // interpolation
  private snaps: SnapshotFrame[] = [];
  latestPoses = new Map<string, PoseData>();

  // match state
  match: MatchInfo;
  private lastPhase: Phase | null = null;
  private spectateId: string | null = null;
  private raf = 0;
  private running = false;
  private disposed = false;
  private readonly resizeOff: () => void;
  private readonly tmpV = new THREE.Vector3();

  constructor(private readonly opts: ArenaGameOptions) {
    this.backend = opts.backend;
    const { container } = opts;
    this.container = container;
    this.renderer = new GameRenderer(container);
    this.renderer.renderer.autoClear = false;
    this.match = this.backend.match();

    // three.js uses physical light units (divided by PI), hence the large intensities.
    const hemi = new THREE.HemisphereLight(0xf2f6ff, 0x8a8490, 3.6);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(0.5, 1, 0.3);
    this.scene.add(hemi, sun, this.avatars.group);
    this.effects = new Effects(this.renderer.profile.effects);
    this.scene.add(this.effects.group);

    this.kbm = new KeyboardMouse(this.input, this.renderer.canvas);
    this.kbm.onUnlock = () => this.openPause();
    this.chat = opts.createChat?.(container) ?? null;
    this.touch = isTouchDevice()
      ? new TouchControls(
          this.input,
          arenaTouchLayout({
            onMenu: () => this.openPause(),
            onScoreboard: () => this.scoreboard.setOpen(!this.scoreboard.open),
            onSwap: () => this.cycleSlot(1),
            onChat: this.chat ? () => this.chat!.toggle() : null,
            onAutoShoot: () => this.toggleAutoShoot(),
          }),
          container,
        )
      : null;

    this.hud = new ArenaHud(container);
    this.loadout = new LoadoutPicker(container, (p, s) => this.weaponFx.pickLoadout(p, s));
    this.scoreboard = new Scoreboard(container);
    this.matchEnd = new MatchEndScreen(
      container,
      () => {
        this.matchEnd.hide();
        this.backend.rematch();
      },
      () => this.exit(),
    );
    this.stats = new StatsOverlay(container, this.renderer, () => this.backend.ping());
    const code = this.backend.roomCode();
    this.warmup = this.backend.online && code
      ? new WarmupPanel(container, code, (bots) => this.backend.startMatch(bots), (d) => this.backend.setBotDifficulty(d))
      : null;
    this.pause = new PauseMenu(container, {
      title: 'Arcfire Arena',
      roomCode: this.backend.roomCode(),
      onResume: () => this.resume(),
      onLeave: () => this.exit(),
      onEditLayout: this.touch ? () => this.editLayout() : undefined,
      extra: [{ label: 'Change loadout', onClick: () => this.showLoadoutNow() }],
      players: () => this.match.players.filter((p) => !p.bot).map((p) => ({ name: p.name, color: p.color, you: p.id === this.backend.localId, connected: p.connected })),
    });
    this.clickToPlay = this.touch
      ? null
      : h('div', { class: 'click-to-play', onclick: () => this.kbm.lock() },
          h('div', { class: 'ctp-card' },
            h('h2', null, 'Click to play'),
            h('p', null, 'WASD move · Space jump · C/Ctrl crouch (slide while running) · Mouse aim'),
            h('p', null, 'Left click fire · Right click aim · R reload · 1-3 / wheel weapons · V knife · X auto-shoot · Tab scores · B loadout · Esc menu'),
          ),
        );
    if (this.clickToPlay) container.appendChild(this.clickToPlay);

    // Feature modules last: they may use everything above (but not the map yet).
    this.moveFx = new MovementFx(this);
    this.itemsFx = new ItemsFx(this);
    this.weaponFx = new WeaponFx(this);
    this.mapFx = new MapFx(this);
    this.features = [this.moveFx, this.itemsFx, this.weaponFx, this.mapFx];
    this.loadMap(this.backend.currentMap());
    this.settingsOff = settings.subscribe((s, changed) => {
      for (const f of this.features) f.onSettings?.(s, changed);
    });

    this.resizeOff = this.renderer.onResize((w, hgt) => {
      this.camera.aspect = w / hgt;
      this.camera.updateProjectionMatrix();
      this.viewmodel.setAspect(w / hgt);
    });
    if (import.meta.env.DEV) Object.assign(window, { __arena: this, __arenaFixtures: { flatArenaMap } });
  }

  start(): void {
    audio.playMusic('arena');
    this.running = true;
    this.raf = requestAnimationFrame(this.frame);
  }

  exit(message?: string): void {
    this.opts.onExit(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.settingsOff();
    for (const f of this.features) f.dispose?.();
    this.resizeOff();
    this.backend.dispose();
    this.kbm.dispose();
    this.touch?.dispose();
    this.chat?.dispose();
    this.warmup?.dispose();
    this.hud.dispose();
    this.matchEnd.dispose();
    this.loadout.el.remove();
    this.scoreboard.el.remove();
    this.stats.dispose();
    this.pause.close();
    this.clickToPlay?.remove();
    this.avatars.dispose();
    this.effects.dispose();
    this.viewmodel.dispose();
    this.disposeMap();
    this.renderer.dispose();
  }

  /** Flips the auto-shoot setting (X key, touch "Auto" button). */
  toggleAutoShoot(): void {
    settings.update({ autoShoot: !settings.get().autoShoot });
  }

  // ---- map ---------------------------------------------------------------------------------

  private loadMap(map: ArenaMap): void {
    this.disposeMap();
    this.map = map;
    this.world = createArenaWorld(map);
    this.mapMesh = buildMapMesh(map);
    this.sky = buildSkyDome(map);
    this.scene.add(this.mapMesh, this.sky);
    this.scene.background = new THREE.Color(map.theme.horizon);
    for (const f of this.features) f.onMapLoaded?.(map, this.world);
  }

  private disposeMap(): void {
    if (this.mapMesh) for (const f of this.features) f.onMapDisposed?.();
    for (const m of [this.mapMesh, this.sky]) {
      if (!m) continue;
      this.scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.mapMesh = this.sky = null;
  }

  // ---- frame -------------------------------------------------------------------------------

  private frame = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    if (!this.renderer.frameAllowed()) return;
    const dt = this.renderer.beginFrame();
    const paused = this.pause.isOpen || isSettingsOpen() || this.touch?.isEditing() === true || this.chat?.isOpen === true;
    this.input.setEnabled(!paused && !this.matchEnd.isVisible);
    const input = this.input.consume();
    if (paused) this.edgeButtons = 0;
    // Crouch presses also request a slide (the sim only starts one while running).
    if (input.pressed.has('crouch')) this.edgeButtons |= Buttons.Slide;
    if (input.pressed.has('reload')) this.edgeButtons |= Buttons.Reload;
    if (input.pressed.has('autoShoot')) this.toggleAutoShoot();

    if (input.pressed.has('menu')) this.togglePause();
    if (input.pressed.has('chat')) this.chat?.toggle();
    if (input.pressed.has('loadout')) this.showLoadoutNow();
    if (!this.touch) this.scoreboard.setOpen(input.held.has('scoreboard') || this.match.phase === 'roundEnd' && false);

    this.match = this.backend.match();
    const map = this.backend.currentMap();
    if (map !== this.map) this.loadMap(map);
    const phase = this.match.phase;
    const frozen = phase === 'loadout' || phase === 'matchEnd' || phase === 'vote';
    const alive = this.predicted?.alive ?? false;

    // ---- look (scaled while zoomed in, never sped up by a wider FOV) ------------------------
    const zoom = Math.min(1, this.fov / BASE_FOV);
    this.yaw += input.lookYaw * zoom;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + input.lookPitch * zoom));
    this.weaponFx.applyRecoil(dt);

    // ---- weapon slot intent -------------------------------------------------------------------
    const sel = this.mapFx.consumeSlotSelect(input.slotSelect);
    if (sel !== null && sel <= 2) this.wantSlot = sel;
    if (input.slotDelta) this.cycleSlot(input.slotDelta);
    if (input.pressed.has('weaponNext')) this.cycleSlot(1);
    if (input.pressed.has('weaponPrev')) this.cycleSlot(-1);
    if (input.pressed.has('melee')) {
      this.wantSlot = 2;
      this.meleeUntil = performance.now() + 450;
    }
    if (!alive && input.pressed.has('primary')) this.nextSpectateTarget();

    // ---- commands at 60 Hz ----------------------------------------------------------------------
    for (const f of this.features) f.beforeCommands?.(input, dt);
    this.cmdAcc += dt;
    const outgoing: Command[] = [];
    let first = true;
    while (this.cmdAcc >= CMD_DT && outgoing.length < MAX_CMDS_PER_FRAME) {
      this.cmdAcc -= CMD_DT;
      const cmd = this.buildCommand(input, first);
      first = false;
      outgoing.push(cmd);
      this.pending.push(cmd);
      if (this.pending.length > 240) this.pending.shift();
      if (this.predicted) {
        this.renderPrev.set(this.predicted.x, this.predicted.y, this.predicted.z);
        const ev = applyCommand(this.predicted, cmd, this.world, frozen, this.backend.localIndex());
        this.renderCur.set(this.predicted.x, this.predicted.y, this.predicted.z);
        for (const f of this.features) f.onLocalCommand?.(ev, this.predicted);
      }
    }
    if (this.cmdAcc > CMD_DT * MAX_CMDS_PER_FRAME) this.cmdAcc = 0;
    if (outgoing.length) this.backend.sendCommands(outgoing);

    if (!(paused && !this.backend.online)) this.backend.update(dt);

    // ---- authoritative updates --------------------------------------------------------------------
    const snaps = this.backend.takeSnapshots();
    for (const s of snaps) {
      this.snaps.push(s);
      if (this.snaps.length > SNAP_BUFFER) this.snaps.shift();
    }
    if (snaps.length) this.reconcile(snaps[snaps.length - 1], frozen);
    for (const e of this.backend.takeEvents()) this.onEvent(e);
    this.onPhase(phase);

    // ---- render ------------------------------------------------------------------------------------
    const remotes = this.interpolateRemotes();
    this.updateCamera(dt, remotes);
    this.updateAvatars(dt, remotes);
    this.updateHud();
    this.warmup?.update(this.match as NetMatchInfo, this.backend.localId, phase === 'warmup' && !this.pause.isOpen);
    this.effects.update(dt);
    for (const f of this.features) f.update?.(dt, remotes);
    if (this.clickToPlay) {
      this.clickToPlay.classList.toggle('hidden', paused || this.kbm.isLocked() || this.loadout.isOpen || this.matchEnd.isVisible || this.mapFx.overlayOpen());
    }
    for (const f of this.features) f.lateUpdate?.(dt, input, remotes);

    const r = this.renderer.renderer;
    r.clear();
    r.render(this.scene, this.camera);
    r.clearDepth();
    r.render(this.viewmodel.scene, this.viewmodel.camera);
  };

  private buildCommand(input: InputFrame, first: boolean): Command {
    let buttons = this.edgeButtons;
    this.edgeButtons = 0;
    if (input.held.has('jump')) buttons |= Buttons.Jump;
    if (input.held.has('crouch')) buttons |= Buttons.Crouch;
    const alive = this.predicted?.alive ?? false;
    if (alive && (input.held.has('primary') || performance.now() < this.meleeUntil)) buttons |= Buttons.Fire;
    if (input.held.has('secondary')) buttons |= Buttons.Aim;
    for (const f of this.features) buttons |= f.commandButtons?.(this.predicted, first) ?? 0;
    return {
      seq: ++this.seq,
      moveX: input.moveX,
      moveY: input.moveY,
      yaw: this.yaw,
      pitch: this.pitch,
      buttons,
      slot: this.wantSlot,
      viewTick: this.backend.serverTick() - this.backend.interpDelayTicks(),
    };
  }

  private reconcile(snap: SnapshotFrame, frozen: boolean): void {
    if (!snap.self) {
      this.predicted = null;
      return;
    }
    this.pending = this.pending.filter((c) => c.seq > snap.ack);
    const before = this.predicted ? new THREE.Vector3(this.predicted.x, this.predicted.y, this.predicted.z) : null;
    const wasAlive = this.predicted?.alive ?? false;
    const replay = clonePlayerSim(snap.self);
    replay.yaw = this.yaw;
    replay.pitch = this.pitch;
    for (const c of this.pending) applyCommand(replay, c, this.world, frozen, this.backend.localIndex());
    this.predicted = replay;
    this.renderCur.set(replay.x, replay.y, replay.z);
    if (before && wasAlive && replay.alive) {
      const err = before.sub(this.renderCur);
      // Small mispredictions are blended out over ~100 ms; big ones (respawn, teleport) snap.
      if (err.length() < 3) this.correction.add(err);
      else this.correction.set(0, 0, 0);
    } else {
      this.correction.set(0, 0, 0);
      this.renderPrev.copy(this.renderCur);
    }
    if (!wasAlive && replay.alive) {
      // Fresh spawn: face the way the spawn point looks.
      this.yaw = snap.self.yaw || this.spawnYaw();
      this.pitch = 0;
      this.wantSlot = 0;
      this.spectateId = null;
    }
  }

  private spawnYaw(): number {
    const p = this.match.players.find((q) => q.id === this.backend.localId);
    return p && this.match.mode !== 'ffa' ? (p.team === 0 ? -Math.PI / 2 : Math.PI / 2) : this.yaw;
  }

  // ---- authoritative events -------------------------------------------------------------------------

  playerName(id: string): { name: string; color: string } {
    const p = this.match.players.find((q) => q.id === id);
    if (!p) return { name: '?', color: '#fff' };
    const c = this.match.mode === 'ffa' ? p.color : (TEAM_COLORS[p.team] ?? p.color);
    return { name: p.id === this.backend.localId ? `${p.name} (you)` : p.name, color: hexColor(c) };
  }

  private myTeam(): number {
    return this.match.players.find((p) => p.id === this.backend.localId)?.team ?? -2;
  }

  isEnemy(id: string): boolean {
    if (id === this.backend.localId) return false;
    if (this.match.mode === 'ffa') return true;
    const p = this.match.players.find((q) => q.id === id);
    return !!p && p.team !== this.myTeam();
  }

  private onEvent(e: ArenaEvent): void {
    const me = this.backend.localId;
    switch (e.type) {
      case 'hit': {
        const victim = this.latestPoses.get(e.victim);
        if (victim) this.effects.impact([victim.x, victim.y + 1.1, victim.z], null, 0xff4f6b, 6);
        if (e.shooter === me) {
          this.hud.hitMarker(e.killed ? 'kill' : e.headshot ? 'head' : 'hit');
          audio.play(e.headshot ? 'headshot' : 'hit');
        }
        if (e.victim === me) {
          audio.play('hurt');
          this.shake = Math.min(1, this.shake + e.damage / 60);
          const shooter = this.latestPoses.get(e.shooter);
          if (shooter && this.predicted) {
            const ang = Math.atan2(-(shooter.x - this.predicted.x), -(shooter.z - this.predicted.z));
            this.hud.damageFrom(ang - this.yaw);
          }
        }
        break;
      }
      case 'kill': {
        const k = this.playerName(e.killer);
        const v = this.playerName(e.victim);
        this.hud.killFeed({
          killer: k.name, killerColor: k.color, victim: v.name, victimColor: v.color,
          weapon: weaponDef(e.weapon).short, weaponId: e.weapon, headshot: e.headshot, mine: e.killer === me || e.victim === me,
        });
        if (e.killer === me) {
          audio.play('kill');
          this.hud.showBanner(`Eliminated ${this.playerName(e.victim).name}`, e.headshot ? 'Headshot' : '', 1300, 'win');
        }
        if (e.victim === me) {
          this.spectateId = e.killer;
          this.hud.showBanner('Eliminated', `by ${this.playerName(e.killer).name}`, 1800, 'lose');
        }
        break;
      }
      case 'roundEnd': {
        const ffa = this.match.mode === 'ffa';
        const won = ffa ? e.winnerId === me : e.winnerTeam === this.myTeam();
        if (e.reason === 'draw' || (e.winnerTeam < 0 && !e.winnerId)) {
          this.hud.showBanner('Draw', 'Nobody scores this round', 3000);
          audio.play('round_lose');
        } else if (won) {
          this.hud.showBanner('Round won', e.reason === 'time' ? 'On time' : '', 3000, 'win');
          audio.play('round_win');
        } else {
          const who = ffa ? this.playerName(e.winnerId ?? '').name : TEAM_NAMES[e.winnerTeam];
          this.hud.showBanner('Round lost', `${who} takes it`, 3000, 'lose');
          audio.play('round_lose');
        }
        break;
      }
      case 'reload':
        if (e.id !== me) {
          const p = this.latestPoses.get(e.id);
          if (p) audio.playAt('reload', p.x - this.camera.position.x, p.z - this.camera.position.z, this.yaw, 20, 0.5);
        }
        break;
      case 'spawn': // recoil reset: WeaponFx
      case 'phase':
      case 'matchEnd':
        break;
    }
    for (const f of this.features) f.onEvent?.(e);
  }

  private onPhase(phase: Phase): void {
    if (phase === this.lastPhase) {
      if (phase === 'loadout') this.showLoadoutPicker(this.match.timeLeft);
      return;
    }
    const prev = this.lastPhase;
    this.lastPhase = phase;
    if (phase !== 'matchEnd') this.matchEnd.hide();
    switch (phase) {
      case 'warmup':
        this.loadout.hide();
        this.hud.showBanner('Warmup', this.backend.online ? 'Waiting for players' : '', 2500);
        break;
      case 'vote':
        this.loadout.hide();
        this.matchEnd.hide();
        this.kbm.unlock();
        break;
      case 'loadout':
        this.showLoadoutPicker(this.match.timeLeft);
        this.hud.showBanner(`Round ${this.match.round}`, this.roundSubtitle(), 2200);
        this.kbm.unlock();
        break;
      case 'live':
        this.loadout.hide();
        this.hud.showBanner('Fight!', '', 900, 'win');
        audio.play('round_start');
        if (!this.touch && !this.pause.isOpen) this.kbm.lock();
        break;
      case 'matchEnd':
        this.loadout.hide();
        this.kbm.unlock();
        this.matchEnd.show(this.match, this.backend.localId, this.mapFx.againLabel());
        break;
      case 'roundEnd':
        break;
    }
    for (const f of this.features) f.onPhase?.(phase, prev);
  }

  private roundSubtitle(): string {
    const m = this.match;
    if (m.mode === 'ffa') {
      const lead = [...m.players].sort((a, b) => b.roundWins - a.roundWins)[0];
      return lead && lead.roundWins > 0 ? `${lead.name} leads with ${lead.roundWins}` : 'First to 5 round wins';
    }
    return `${TEAM_NAMES[0]} ${m.teamWins[0]} – ${m.teamWins[1]} ${TEAM_NAMES[1]}`;
  }

  /** Our primary and secondary as the authority knows them. */
  private myLoadout(): { primary: WeaponId; secondary: WeaponId } {
    const me = this.match.players.find((p) => p.id === this.backend.localId);
    return { primary: me?.primary ?? WeaponId.Rifle, secondary: me?.secondary ?? WeaponId.Pistol };
  }

  private showLoadoutPicker(secondsLeft: number | null): void {
    const { primary, secondary } = this.myLoadout();
    this.loadout.show(primary, secondary, secondsLeft);
  }

  private showLoadoutNow(): void {
    // Picks apply at the next spawn; not during a fight or the map vote.
    if (this.match.phase === 'live' || this.match.phase === 'vote') return;
    this.pause.close();
    this.kbm.unlock();
    this.showLoadoutPicker(this.match.phase === 'loadout' ? this.match.timeLeft : null);
    if (this.match.phase !== 'loadout') window.setTimeout(() => this.loadout.hide(), 6000);
  }

  // ---- interpolation & rendering -------------------------------------------------------------------------

  private interpolateRemotes(): Map<string, RemotePose> {
    const out = new Map<string, RemotePose>();
    const snaps = this.snaps;
    if (snaps.length === 0) return out;
    const t = this.backend.serverTick() - this.backend.interpDelayTicks();
    let a = snaps[0];
    let b = snaps[snaps.length - 1];
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].tick <= t) {
        a = snaps[i - 1];
        b = snaps[i];
        break;
      }
    }
    const span = b.tick - a.tick;
    const k = span > 0 ? Math.max(0, Math.min(1, (t - a.tick) / span)) : 1;
    for (const [id, pb] of b.poses) {
      if (id === this.backend.localId) continue;
      const pa = a.poses.get(id) ?? pb;
      // Don't slide players across the map when they respawn.
      const moved = Math.hypot(pb.x - pa.x, pb.z - pa.z);
      const jump = moved > 4;
      const kk = jump ? 1 : k;
      let dyaw = pb.yaw - pa.yaw;
      dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
      out.set(id, {
        ...pb,
        x: pa.x + (pb.x - pa.x) * kk,
        y: pa.y + (pb.y - pa.y) * kk,
        z: pa.z + (pb.z - pa.z) * kk,
        yaw: pa.yaw + dyaw * kk,
        pitch: pa.pitch + (pb.pitch - pa.pitch) * kk,
        alive: kk < 0.5 ? pa.alive : pb.alive,
        speed: span > 0 && !jump ? moved / (span / TICK_RATE) : 0,
      });
    }
    this.latestPoses = new Map(snaps[snaps.length - 1].poses);
    return out;
  }

  private updateCamera(dt: number, remotes: Map<string, RemotePose>): void {
    const p = this.predicted;
    this.correction.multiplyScalar(Math.exp(-dt * 12));
    this.shake = Math.max(0, this.shake - dt * 3);
    let fovAdd = 0;
    if (p && p.alive) {
      const alpha = Math.min(1, this.cmdAcc / CMD_DT);
      const x = this.renderPrev.x + (this.renderCur.x - this.renderPrev.x) * alpha + this.correction.x;
      const y = this.renderPrev.y + (this.renderCur.y - this.renderPrev.y) * alpha + this.correction.y;
      const z = this.renderPrev.z + (this.renderCur.z - this.renderPrev.z) * alpha + this.correction.z;
      const fx = this.moveFx.camera(p, dt);
      fovAdd = fx.fovAdd;
      const sx = (Math.random() - 0.5) * this.shake * 0.04;
      const sy = (Math.random() - 0.5) * this.shake * 0.04;
      this.camera.position.set(x, y + fx.eye - fx.dipY, z);
      this.camera.rotation.set(this.pitch + sy, this.yaw + sx, fx.roll, 'YXZ');
      this.hud.setSpectating(null);
    } else {
      // Spectate: follow the killer first, then teammates / anyone alive.
      const target = this.pickSpectateTarget(remotes);
      if (target) {
        const [id, t] = target;
        const back = viewDir(t.yaw, 0);
        const tx = t.x - back[0] * 2.6;
        const tz = t.z - back[2] * 2.6;
        this.camera.position.lerp(this.tmpV.set(tx, t.y + 2.2, tz), Math.min(1, dt * 10));
        this.camera.lookAt(t.x, t.y + 1.4, t.z);
        this.hud.setSpectating(`Spectating ${this.playerName(id).name}${this.touch ? ' · tap Fire to switch' : ' · click to switch'}`);
      } else {
        this.hud.setSpectating(this.match.phase === 'warmup' ? 'Respawning…' : null);
      }
    }
    // Zoom.
    const targetFov = p?.alive ? this.weaponFx.fovTarget(p) + fovAdd : BASE_FOV;
    this.fov += (targetFov - this.fov) * Math.min(1, dt * 14);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    this.sky?.position.copy(this.camera.position);
  }

  private pickSpectateTarget(remotes: Map<string, PoseData>): [string, PoseData] | null {
    const alive = [...remotes.entries()].filter(([, p]) => p.alive);
    if (alive.length === 0) return null;
    const cur = this.spectateId ? alive.find(([id]) => id === this.spectateId) : undefined;
    if (cur) return cur;
    const mates = alive.filter(([id]) => !this.isEnemy(id));
    const pick = (mates.length ? mates : alive)[0];
    this.spectateId = pick[0];
    return pick;
  }

  private nextSpectateTarget(): void {
    const ids = [...this.latestPoses.entries()].filter(([id, p]) => p.alive && id !== this.backend.localId).map(([id]) => id);
    if (!ids.length) return;
    const i = this.spectateId ? ids.indexOf(this.spectateId) : -1;
    this.spectateId = ids[(i + 1) % ids.length];
  }

  private updateAvatars(dt: number, remotes: Map<string, RemotePose>): void {
    const poses: AvatarPose[] = [];
    const ffa = this.match.mode === 'ffa';
    const myTeam = this.myTeam();
    for (const [id, p] of remotes) {
      if (!p.alive) continue;
      const info = this.match.players.find((q) => q.id === id);
      poses.push({
        id,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        pitch: p.pitch,
        color: ffa ? (info?.color ?? 0xffffff) : (TEAM_COLORS[info?.team ?? 0] ?? 0xffffff),
        // Walk cadence: ~3.8 steps/s at run speed.
        speed: Math.min(10, p.speed) * 0.55,
        crouch: p.crouching,
        slide: p.sliding,
        aiming: true,
        held: this.weaponFx.heldKey(p.weapon),
        // Names only for teammates (enemy names through walls would be a wallhack).
        name: !ffa && info && info.team === myTeam ? info.name : undefined,
      });
    }
    this.avatars.update(poses, dt, this.camera);
  }

  /** Score bar, timer, HP and the scoreboard; the weapon parts are WeaponFx's. */
  private updateHud(): void {
    const m = this.match;
    const p = this.predicted;
    // Score bar.
    if (m.mode === 'ffa') {
      const mine = m.players.find((q) => q.id === this.backend.localId);
      const best = [...m.players].filter((q) => q.id !== this.backend.localId).sort((a, b) => b.roundWins - a.roundWins)[0];
      this.hud.setScores(`You ${mine?.roundWins ?? 0}`, best ? `${best.name} ${best.roundWins}` : '–', 'mine', '', this.roundLabel());
    } else {
      const t = Math.max(0, this.myTeam());
      this.hud.setScores(String(m.teamWins[t]), String(m.teamWins[1 - t]), `team-${t} mine`, `team-${1 - t}`, this.roundLabel());
    }
    const showTimer = m.phase === 'live' || m.phase === 'loadout';
    this.hud.setTimer(showTimer ? m.timeLeft : null, m.phase === 'live' && m.timeLeft < 15);
    this.hud.setHp(p?.alive ? p.hp : 0);
    this.scoreboard.update(m, this.backend.localId, this.mapFx.scoreboardTitle(m));
  }

  private roundLabel(): string {
    switch (this.match.phase) {
      case 'warmup':
        return 'Warmup';
      case 'vote':
        return 'Map vote';
      case 'loadout':
        return `Round ${this.match.round} · Loadout`;
      case 'matchEnd':
        return 'Match over';
      default:
        return `Round ${this.match.round}`;
    }
  }

  // ---- menus ----------------------------------------------------------------------------------------------------

  private cycleSlot(dir: number): void {
    this.wantSlot = (((this.wantSlot + dir) % 3) + 3) % 3;
  }

  private openPause(): void {
    if (this.pause.isOpen || this.disposed) return;
    this.kbm.unlock();
    this.pause.open();
  }

  private togglePause(): void {
    if (this.pause.isOpen) {
      this.pause.close();
      this.resume();
    } else this.openPause();
  }

  private resume(): void {
    if (!this.touch && !this.loadout.isOpen) this.kbm.lock();
  }

  private editLayout(): void {
    this.touch?.startEditing(() => this.resume());
  }
}

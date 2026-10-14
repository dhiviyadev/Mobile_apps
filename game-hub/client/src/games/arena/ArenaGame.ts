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
 */
import * as THREE from 'three';
import {
  applyCommand,
  arenaMap,
  type ArenaEvent,
  BoxWorld,
  Buttons,
  clonePlayerSim,
  CMD_DT,
  type Command,
  currentSpread,
  eyeHeight,
  type Phase,
  type PlayerSim,
  viewDir,
  WeaponId,
  weaponDef,
} from '@hub/shared';
import { audio, type SfxName } from '../../core/audio/audio';
import { isTouchDevice } from '../../core/device';
import { InputManager } from '../../core/input/InputManager';
import { KeyboardMouse } from '../../core/input/KeyboardMouse';
import { TouchControls } from '../../core/input/TouchControls';
import { GameRenderer } from '../../core/render/GameRenderer';
import { StatsOverlay } from '../../core/render/StatsOverlay';
import { settings } from '../../core/settings';
import { h, hexColor } from '../../core/ui/dom';
import { isSettingsOpen } from '../../core/ui/settingsMenu';
import { AvatarRenderer, type AvatarPose } from '../common/Avatars';
import { PauseMenu } from '../common/PauseMenu';
import { AimAssist } from './AimAssist';
import type { ArenaBackend, MatchInfo, PoseData, SnapshotFrame } from './backend';
import { arenaTouchLayout } from './controls';
import { Effects } from './render/Effects';
import { buildMapMesh, buildSkyDome } from './render/MapRenderer';
import { Viewmodel } from './render/Viewmodel';
import { ArenaHud } from './ui/ArenaHud';
import { LoadoutPicker } from './ui/LoadoutPicker';
import { MatchEndScreen, Scoreboard, TEAM_COLORS, TEAM_NAMES } from './ui/Scoreboard';
import { WarmupPanel } from './ui/WarmupPanel';
import type { NetMatchInfo } from './net/NetBackend';

const BASE_FOV = 78;
const MAX_CMDS_PER_FRAME = 6;
const SNAP_BUFFER = 40;

const SHOT_SOUND: Record<WeaponId, SfxName> = {
  [WeaponId.Rifle]: 'rifle',
  [WeaponId.Shotgun]: 'shotgun',
  [WeaponId.Sniper]: 'sniper',
  [WeaponId.Pistol]: 'pistol',
  [WeaponId.Blade]: 'melee',
};

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

export class ArenaGame {
  readonly renderer: GameRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 300);
  readonly backend: ArenaBackend;
  private world!: BoxWorld;
  private mapIndex = -1;
  private mapMesh: THREE.Mesh | null = null;
  private sky: THREE.Mesh | null = null;
  private readonly avatars = new AvatarRenderer(8);
  private readonly effects: Effects;
  private readonly viewmodel = new Viewmodel();
  private readonly input = new InputManager();
  private readonly kbm: KeyboardMouse;
  private readonly touch: TouchControls | null;
  private readonly hud: ArenaHud;
  private readonly loadout: LoadoutPicker;
  private readonly scoreboard: Scoreboard;
  private readonly matchEnd: MatchEndScreen;
  private readonly pause: PauseMenu;
  private readonly stats: StatsOverlay;
  private readonly aimAssist = new AimAssist();
  private readonly chat: ArenaChat | null;
  private readonly clickToPlay: HTMLElement | null;
  private readonly warmup: WarmupPanel | null;

  // prediction
  predicted: PlayerSim | null = null;
  private readonly renderPrev = new THREE.Vector3();
  private readonly renderCur = new THREE.Vector3();
  private readonly correction = new THREE.Vector3();
  private pending: Command[] = [];
  private seq = 0;
  private cmdAcc = 0;
  private yaw = 0;
  private pitch = 0;
  private wantSlot = 0;
  private meleeUntil = 0;
  private recoilKick = 0;
  private recoilReturn = 0;
  private eyeSmooth = 1.6;
  private fov = BASE_FOV;
  private lastLookDX = 0;
  private lastLookDY = 0;
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
    this.loadMap(this.match.mapIndex);

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
          }),
          container,
        )
      : null;

    this.hud = new ArenaHud(container);
    this.loadout = new LoadoutPicker(container, (w) => this.backend.chooseLoadout(w));
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
    this.warmup = this.backend.online && code ? new WarmupPanel(container, code, (bots) => this.backend.startMatch(bots)) : null;
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
            h('p', null, 'WASD move · Space jump · Ctrl/C crouch · Mouse aim'),
            h('p', null, 'Left click fire · Right click aim · R reload · 1-3 / wheel weapons · V blade · Tab scores · B loadout · Esc menu'),
          ),
        );
    if (this.clickToPlay) container.appendChild(this.clickToPlay);

    this.resizeOff = this.renderer.onResize((w, hgt) => {
      this.camera.aspect = w / hgt;
      this.camera.updateProjectionMatrix();
      this.viewmodel.setAspect(w / hgt);
    });
    if (import.meta.env.DEV) (window as unknown as { __arena?: ArenaGame }).__arena = this;
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

  // ---- map ---------------------------------------------------------------------------------

  private loadMap(index: number): void {
    this.disposeMap();
    const map = arenaMap(index);
    this.mapIndex = index;
    this.world = new BoxWorld(map.boxes);
    this.mapMesh = buildMapMesh(map);
    this.sky = buildSkyDome(map);
    this.scene.add(this.mapMesh, this.sky);
    this.scene.background = new THREE.Color(map.theme.horizon);
  }

  private disposeMap(): void {
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
    const dt = this.renderer.beginFrame();
    const paused = this.pause.isOpen || isSettingsOpen() || this.touch?.isEditing() === true || this.chat?.isOpen === true;
    this.input.setEnabled(!paused && !this.matchEnd.isVisible);
    const input = this.input.consume();

    if (input.pressed.has('menu')) this.togglePause();
    if (input.pressed.has('chat')) this.chat?.toggle();
    if (input.pressed.has('loadout')) this.showLoadoutNow();
    if (!this.touch) this.scoreboard.setOpen(input.held.has('scoreboard') || this.match.phase === 'roundEnd' && false);

    this.match = this.backend.match();
    if (this.match.mapIndex !== this.mapIndex) this.loadMap(this.match.mapIndex);
    const phase = this.match.phase;
    const frozen = phase === 'loadout' || phase === 'matchEnd';
    const alive = this.predicted?.alive ?? false;

    // ---- look (scaled while zoomed) ---------------------------------------------------------
    const zoom = this.fov / BASE_FOV;
    this.yaw += input.lookYaw * zoom;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + input.lookPitch * zoom));
    this.lastLookDX = input.lookYaw;
    this.lastLookDY = input.lookPitch;
    this.applyRecoil(dt);

    // ---- weapon slot intent -------------------------------------------------------------------
    if (input.slotSelect !== null && input.slotSelect <= 2) this.wantSlot = input.slotSelect;
    if (input.slotDelta) this.cycleSlot(input.slotDelta);
    if (input.pressed.has('weaponNext')) this.cycleSlot(1);
    if (input.pressed.has('weaponPrev')) this.cycleSlot(-1);
    if (input.pressed.has('melee')) {
      this.wantSlot = 2;
      this.meleeUntil = performance.now() + 450;
    }
    if (!alive && input.pressed.has('primary')) this.nextSpectateTarget();

    // ---- commands at 60 Hz ----------------------------------------------------------------------
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
        this.onLocalEvents(ev);
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
    this.updateViewmodel(dt);
    if (this.clickToPlay) this.clickToPlay.classList.toggle('hidden', paused || this.kbm.isLocked() || this.loadout.isOpen || this.matchEnd.isVisible);

    // Aim assist for the next frame (touch only, setting-controlled).
    const eye: [number, number, number] = [this.camera.position.x, this.camera.position.y, this.camera.position.z];
    const enemies = [...remotes.entries()].filter(([id, p]) => p.alive && this.isEnemy(id)).map(([, p]) => p);
    this.input.touchLookMultiplier = this.aimAssist.update(dt, settings.get().aimAssist && input.touch && alive, eye, viewDir(this.yaw, this.pitch), enemies, this.world);

    const r = this.renderer.renderer;
    r.clear();
    r.render(this.scene, this.camera);
    r.clearDepth();
    r.render(this.viewmodel.scene, this.viewmodel.camera);
  };

  private buildCommand(input: ReturnType<InputManager['consume']>, first: boolean): Command {
    let buttons = 0;
    if (input.held.has('jump')) buttons |= Buttons.Jump;
    if (input.held.has('crouch')) buttons |= Buttons.Crouch;
    const alive = this.predicted?.alive ?? false;
    if (alive && (input.held.has('primary') || performance.now() < this.meleeUntil)) buttons |= Buttons.Fire;
    if (input.held.has('secondary')) buttons |= Buttons.Aim;
    if (first && input.pressed.has('reload')) buttons |= Buttons.Reload;
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
      if (err.length() < 2) this.correction.add(err);
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

  // ---- local prediction effects ---------------------------------------------------------------------

  private onLocalEvents(ev: ReturnType<typeof applyCommand>): void {
    if (ev.shot) {
      const def = weaponDef(ev.shot.weapon);
      this.viewmodel.fire();
      audio.play(SHOT_SOUND[ev.shot.weapon], { pitch: 0.96 + Math.random() * 0.08 });
      this.recoilKick += def.recoil * (this.predicted?.aiming ? 0.6 : 1);
      this.yaw += (Math.random() - 0.5) * def.recoilYaw;
      if (ev.shot.weapon !== WeaponId.Blade) {
        const muzzle = this.viewmodel.muzzleWorld(this.camera, this.tmpV.set(0, 0, 0));
        for (const [dx, dy, dz] of ev.shot.dirs) {
          const hit = this.world.raycast(ev.shot.ox, ev.shot.oy, ev.shot.oz, dx, dy, dz, def.range);
          const t = hit ? hit.t : Math.min(def.range, 80);
          const end: [number, number, number] = [ev.shot.ox + dx * t, ev.shot.oy + dy * t, ev.shot.oz + dz * t];
          this.effects.tracer(muzzle, end);
          if (hit) this.effects.impact(end, [hit.nx, hit.ny, hit.nz], 0xffe2a0, def.pellets > 1 ? 2 : 6);
        }
      }
    }
    if (ev.reloadStarted) audio.play('reload');
    if (ev.dryFire) audio.play('empty');
    if (ev.jumped) audio.play('jump');
    if (ev.landed > 6) audio.play('land', { volume: Math.min(1, ev.landed / 14) });
    if (ev.switched) audio.play('click', { pitch: 0.8 });
  }

  private applyRecoil(dt: number): void {
    // Kick the view up quickly, then let ~70% of it settle back.
    const k = Math.min(1, dt * 30);
    const kick = this.recoilKick * k;
    this.recoilKick -= kick;
    this.pitch = Math.min(1.45, this.pitch + kick);
    this.recoilReturn += kick * 0.7;
    const back = this.recoilReturn * Math.min(1, dt * 6);
    this.recoilReturn -= back;
    this.pitch -= back;
  }

  // ---- authoritative events -------------------------------------------------------------------------

  private name(id: string): { name: string; color: string } {
    const p = this.match.players.find((q) => q.id === id);
    if (!p) return { name: '?', color: '#fff' };
    const c = this.match.mode === 'ffa' ? p.color : (TEAM_COLORS[p.team] ?? p.color);
    return { name: p.id === this.backend.localId ? `${p.name} (you)` : p.name, color: hexColor(c) };
  }

  private myTeam(): number {
    return this.match.players.find((p) => p.id === this.backend.localId)?.team ?? -2;
  }

  private isEnemy(id: string): boolean {
    if (id === this.backend.localId) return false;
    if (this.match.mode === 'ffa') return true;
    const p = this.match.players.find((q) => q.id === id);
    return !!p && p.team !== this.myTeam();
  }

  private onEvent(e: ArenaEvent): void {
    const me = this.backend.localId;
    switch (e.type) {
      case 'shot': {
        if (e.shooter === me) return; // already predicted locally
        const def = weaponDef(e.weapon);
        const [ox, oy, oz] = e.origin;
        const first = e.ends[0];
        if (first && e.weapon !== WeaponId.Blade) {
          const d = this.tmpV.set(first[0] - ox, first[1] - oy, first[2] - oz).normalize();
          const muzzle: [number, number, number] = [ox + d.x * 0.6, oy - 0.25 + d.y * 0.6, oz + d.z * 0.6];
          this.effects.muzzleFlash(muzzle);
          e.ends.forEach((end, i) => {
            this.effects.tracer(muzzle, end, 0xffc68a);
            if (!e.hits[i] && e.normals[i]) this.effects.impact(end, e.normals[i], 0xffe2a0, def.pellets > 1 ? 2 : 5);
          });
        }
        audio.playAt(SHOT_SOUND[e.weapon], ox - this.camera.position.x, oz - this.camera.position.z, this.yaw, 70, 0.9);
        break;
      }
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
        const k = this.name(e.killer);
        const v = this.name(e.victim);
        this.hud.killFeed({ killer: k.name, killerColor: k.color, victim: v.name, victimColor: v.color, weapon: weaponDef(e.weapon).short, headshot: e.headshot, mine: e.killer === me || e.victim === me });
        if (e.killer === me) {
          audio.play('kill');
          this.hud.showBanner(`Eliminated ${this.name(e.victim).name}`, e.headshot ? 'Headshot' : '', 1300, 'win');
        }
        if (e.victim === me) {
          this.spectateId = e.killer;
          this.hud.showBanner('Eliminated', `by ${this.name(e.killer).name}`, 1800, 'lose');
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
          const who = ffa ? this.name(e.winnerId ?? '').name : TEAM_NAMES[e.winnerTeam];
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
      case 'spawn':
        if (e.id === me) {
          this.recoilKick = this.recoilReturn = 0;
        }
        break;
      case 'phase':
      case 'matchEnd':
        break;
    }
  }

  private onPhase(phase: Phase): void {
    if (phase === this.lastPhase) {
      if (phase === 'loadout') this.loadout.show(this.myPrimary(), this.match.timeLeft);
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
      case 'loadout':
        this.loadout.show(this.myPrimary(), this.match.timeLeft);
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
        this.matchEnd.show(this.match, this.backend.localId, this.backend.online ? 'Rematch (next map)' : 'Next map');
        break;
      case 'roundEnd':
        break;
    }
    void prev;
  }

  private roundSubtitle(): string {
    const m = this.match;
    if (m.mode === 'ffa') {
      const lead = [...m.players].sort((a, b) => b.roundWins - a.roundWins)[0];
      return lead && lead.roundWins > 0 ? `${lead.name} leads with ${lead.roundWins}` : 'First to 5 round wins';
    }
    return `${TEAM_NAMES[0]} ${m.teamWins[0]} – ${m.teamWins[1]} ${TEAM_NAMES[1]}`;
  }

  private myPrimary(): WeaponId {
    return this.match.players.find((p) => p.id === this.backend.localId)?.primary ?? WeaponId.Rifle;
  }

  private showLoadoutNow(): void {
    if (this.match.phase === 'live') return;
    this.pause.close();
    this.kbm.unlock();
    this.loadout.show(this.myPrimary(), this.match.phase === 'loadout' ? this.match.timeLeft : null);
    if (this.match.phase !== 'loadout') window.setTimeout(() => this.loadout.hide(), 6000);
  }

  // ---- interpolation & rendering -------------------------------------------------------------------------

  private interpolateRemotes(): Map<string, PoseData> {
    const out = new Map<string, PoseData>();
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
      const jump = Math.hypot(pb.x - pa.x, pb.z - pa.z) > 4;
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
      });
    }
    this.latestPoses = new Map(snaps[snaps.length - 1].poses);
    return out;
  }

  private updateCamera(dt: number, remotes: Map<string, PoseData>): void {
    const p = this.predicted;
    this.correction.multiplyScalar(Math.exp(-dt * 12));
    this.shake = Math.max(0, this.shake - dt * 3);
    if (p && p.alive) {
      const alpha = Math.min(1, this.cmdAcc / CMD_DT);
      const x = this.renderPrev.x + (this.renderCur.x - this.renderPrev.x) * alpha + this.correction.x;
      const y = this.renderPrev.y + (this.renderCur.y - this.renderPrev.y) * alpha + this.correction.y;
      const z = this.renderPrev.z + (this.renderCur.z - this.renderPrev.z) * alpha + this.correction.z;
      this.eyeSmooth += (eyeHeight(p.crouching) - this.eyeSmooth) * Math.min(1, dt * 14);
      const sx = (Math.random() - 0.5) * this.shake * 0.04;
      const sy = (Math.random() - 0.5) * this.shake * 0.04;
      this.camera.position.set(x, y + this.eyeSmooth, z);
      this.camera.rotation.set(this.pitch + sy, this.yaw + sx, 0, 'YXZ');
      this.hud.setSpectating(null);
    } else {
      // Spectate: follow the killer first, then teammates / anyone alive.
      const target = this.pickSpectateTarget(remotes);
      if (target) {
        const [id, t] = target;
        const back = viewDir(t.yaw, 0);
        const tx = t.x - back[0] * 2.6;
        const tz = t.z - back[2] * 2.6;
        this.camera.position.lerp(this.tmpV.set(tx, t.y + 2.2, tz), Math.min(1, dt * 6));
        this.camera.lookAt(t.x, t.y + 1.4, t.z);
        this.hud.setSpectating(`Spectating ${this.name(id).name}${this.touch ? ' · tap Fire to switch' : ' · click to switch'}`);
      } else {
        this.hud.setSpectating(this.match.phase === 'warmup' ? 'Respawning…' : null);
      }
    }
    // Zoom.
    const def = p ? weaponDef(p.weapons[p.slot].id) : null;
    const targetFov = p?.alive && p.aiming && def ? def.aimFov : BASE_FOV;
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

  private updateAvatars(dt: number, remotes: Map<string, PoseData>): void {
    const poses: AvatarPose[] = [];
    const ffa = this.match.mode === 'ffa';
    const myTeam = this.myTeam();
    for (const [id, p] of remotes) {
      if (!p.alive) continue;
      const info = this.match.players.find((q) => q.id === id);
      const prev = this.latestPoses.get(id);
      const speed = prev ? Math.min(7, Math.hypot(prev.x - p.x, prev.z - p.z) * 30) : 0;
      poses.push({
        id,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        pitch: p.pitch,
        color: ffa ? (info?.color ?? 0xffffff) : (TEAM_COLORS[info?.team ?? 0] ?? 0xffffff),
        speed,
        crouch: p.crouching,
        aiming: true,
        gun: true,
        // Names only for teammates (enemy names through walls would be a wallhack).
        name: !ffa && info && info.team === myTeam ? info.name : undefined,
      });
    }
    this.avatars.update(poses, dt, this.camera);
  }

  private updateViewmodel(dt: number): void {
    const p = this.predicted;
    const weapon = p ? p.weapons[p.slot].id : WeaponId.Rifle;
    const def = weaponDef(weapon);
    const scoped = !!p && p.aiming && weapon === WeaponId.Sniper && this.fov < def.aimFov + 6;
    this.viewmodel.update(dt, {
      weapon,
      aiming: !!p?.aiming,
      reload: p && p.reload > 0 ? 1 - p.reload / def.reloadTime : -1,
      draw: p && p.switching > 0 ? 1 - p.switching / def.drawTime : -1,
      speed: p ? Math.hypot(p.vx, p.vz) : 0,
      onGround: p?.onGround ?? true,
      lookDX: this.lastLookDX,
      lookDY: this.lastLookDY,
      visible: !!p?.alive && !scoped,
    });
    this.hud.setScope(scoped);
  }

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
    if (p) {
      const w = p.weapons[p.slot];
      const def = weaponDef(w.id);
      this.hud.setHp(p.alive ? p.hp : 0);
      this.hud.setAmmo(w.mag, w.reserve, def.name, def.magazine === 0, p.reload > 0 ? 1 - p.reload / def.reloadTime : 0);
      const spread = currentSpread(p);
      const gap = (Math.tan(spread) / Math.tan(THREE.MathUtils.degToRad(this.fov) / 2)) * (this.renderer.height / 2) + 5;
      this.hud.setCrosshair(Math.min(80, gap), p.alive && !(p.aiming && w.id === WeaponId.Sniper));
    } else {
      this.hud.setHp(0);
      this.hud.setCrosshair(10, false);
    }
    this.scoreboard.update(m, this.backend.localId, `${arenaMap(m.mapIndex).name} · ${m.mode.toUpperCase()}`);
  }

  private roundLabel(): string {
    switch (this.match.phase) {
      case 'warmup':
        return 'Warmup';
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

/**
 * Players' survival and combat side in the running game (WP-B): vitals HUD,
 * the bag with crafting and chests, held-item animations, melee / bow /
 * crossbow / shield / eating, drops, ghost arrows, hit feedback, damage
 * numbers, death screen and hints. Runs in sandbox (creative: weapons, no
 * vitals or inventory) and survival. Offline it owns LocalSurvival; online
 * NetSurvival (attachNet).
 */
import {
  applyBodyKnockback,
  Block,
  blockDef,
  breakSeconds as survivalBreakSeconds,
  type ClientEvent,
  craftOp,
  DamageFlags,
  DUSK_TIME,
  type EntityWorldApi,
  forwardFromYawPitch,
  HandFlags,
  HOTBAR,
  InteractKind,
  type InvOp,
  isBlockItem,
  isBossDefeated,
  isInteractiveBlock,
  isNight,
  Item,
  ItemKind,
  itemDef,
  itemFromKey,
  itemName,
  LoadedAmmo,
  loadedOf,
  meleeOf,
  OFFHAND,
  type PlayerBody,
  placementItem,
  ProjectileKind,
  RefType,
  sandboxItems,
  REACH,
  rayAabb,
  boxAt,
  Station,
  stationsNear,
  SurvivalSfx,
  VitalFlags,
  type VoxelHit,
  wearOf,
} from '@hub/shared';
import { audio, type SfxName } from '../../../core/audio/audio';
import { settings } from '../../../core/settings';
import { GAME_ICONS } from '../../../core/ui/icons';
import { h } from '../../../core/ui/dom';
import type { InputFrame } from '../../../core/input/InputManager';
import type { HotbarSource, InteractionHooks, MoveMods, VoxelModule } from '../modules';
import type { VoxelNet } from '../net/VoxelNet';
import { DropRenderer } from '../render/DropRenderer';
import { HitFx } from '../render/HitFx';
import { ProjectileGhosts } from '../render/ProjectileGhosts';
import { DamageNumbers } from '../ui/DamageNumbers';
import { DeathScreen } from '../ui/DeathScreen';
import { InventoryScreen } from '../ui/InventoryScreen';
import { SurvivalHud } from '../ui/SurvivalHud';
import type { SlotView } from '../ui/VoxelHud';
import type { VoxelGame } from '../VoxelGame';
import { InventoryModel } from './InventoryModel';
import { LocalSurvival } from './LocalSurvival';
import { NetSurvival } from './NetSurvival';
import type { SurvivalBackend } from './SurvivalBackend';

export interface SurvivalControllerOptions {
  mode: 'sandbox' | 'survival';
  online: boolean;
  /** Offline survival save data (opaque to VoxelGame; see index.ts OfflineSave.survival). */
  saved: unknown;
}

interface Target {
  refType: number;
  id: number;
  distance: number;
  x: number;
  y: number;
  z: number;
  name: string;
}

const SFX_NAMES: Partial<Record<SurvivalSfx, SfxName>> = {
  [SurvivalSfx.ToolBreak]: 'toolBreak',
  [SurvivalSfx.EatDone]: 'eatDone',
  [SurvivalSfx.ShieldBreak]: 'shieldBreak',
  [SurvivalSfx.XbowLoaded]: 'xbowLoad',
  [SurvivalSfx.Pickup]: 'pickup',
  [SurvivalSfx.SatchelDrop]: 'satchel',
  [SurvivalSfx.Craft]: 'craft',
  [SurvivalSfx.BowShot]: 'bowRelease',
  [SurvivalSfx.XbowShot]: 'xbowFire',
  [SurvivalSfx.Eat]: 'eat',
};

const ammoKind = (item: number): ProjectileKind => (item === Item.Bolt ? ProjectileKind.Bolt : item === Item.EmberArrow ? ProjectileKind.EmberArrow : ProjectileKind.Arrow);
const loadKind = (l: LoadedAmmo): ProjectileKind => (l === LoadedAmmo.Bolt ? ProjectileKind.Bolt : l === LoadedAmmo.EmberArrow ? ProjectileKind.EmberArrow : ProjectileKind.Arrow);

export class SurvivalController implements VoxelModule {
  /** Survival: the 9-slot inventory hotbar. Null: the world area's sandbox hotbar is used. */
  readonly hotbar: HotbarSource | null;
  readonly model = new InventoryModel();
  private readonly creative: boolean;
  private backend: SurvivalBackend | null = null;
  private ui: {
    hud: SurvivalHud;
    inventory: InventoryScreen;
    death: DeathScreen;
    numbers: DamageNumbers;
    drops: DropRenderer;
    ghosts: ProjectileGhosts;
    fx: HitFx;
    popover: HTMLElement | null;
  } | null = null;
  private modelVersion = -1;
  private changed = true;
  // vitals
  private hp = 20;

  /** Current health (20 in sandbox). */
  get health(): number {
    return this.hp;
  }
  private food = 20;
  private vflags = 0;
  private slowMul = 1;
  private slowUntil = 0;
  private burnUntil = 0;
  private dead = false;
  // hands
  private sentHand = '';
  private nextAttack = 0;
  private cooldownTotal = 1;
  private drawStart = 0;
  private drawing = false;
  private loadStart = 0;
  private loading = false;
  private loadedLocal = false;
  private loadedLocalUntil = 0;
  private creativeLoaded = false;
  private eating = false;
  private eatSoundT = 0;
  private guarding = false;
  private interactLatch = false;
  private noSprintUntil = 0;
  private seq = 0;
  private time = 0;
  private digCell: { x: number; y: number; z: number } | null = null;
  private target: Target | null = null;
  private targetFrame = -1;
  private frame = 0;
  private chestOpen: { x: number; y: number; z: number; sealed: boolean } | null = null;
  private lastTime = -1;
  private touchState = '';
  private readonly flashes = new Map<number, number>();
  private readonly swings = new Map<string, { seq: number; t: number }>();
  private keyOff: (() => void) | null = null;

  constructor(
    protected readonly game: VoxelGame,
    protected readonly opts: SurvivalControllerOptions,
  ) {
    this.creative = opts.mode !== 'survival';
    // Sandbox: weapons, tools, ammo and food in the Block Picker.
    if (this.creative) game.worldFeatures.addPickerTab({ id: 'items', label: 'Items', items: () => sandboxItems() });
    this.hotbar = this.creative
      ? null
      : {
          views: () => this.slotViews(),
          takeChanged: () => {
            const c = this.changed || this.model.version !== this.modelVersion;
            this.changed = false;
            this.modelVersion = this.model.version;
            return c;
          },
          placeable: (i) => this.placeable(i),
          heldItem: (i) => (this.model.view.counts[i] ? this.model.view.items[i] : 0),
          offhand: () => this.slotView(OFFHAND),
        };
  }

  // ---- wiring ----

  /** Offline: the creature sim exists now (or never); start the local survival sim. */
  setEntities(_api: EntityWorldApi | null): void {
    if (this.opts.online || this.backend) return;
    this.backend = new LocalSurvival(this.game, this.creative, this.opts.saved);
  }

  /** Online: survival messages on net.session, remote avatar poses. */
  attachNet(net: VoxelNet): void {
    this.backend?.dispose();
    this.backend = new NetSurvival(net.session, this.creative);
    net.poseDecorator = (id, pose) => {
      const s = net.session.state?.players?.get(id) as { eid: number; held: number; offhand: number; act: number; swing: number } | undefined;
      if (!s) return;
      pose.held = s.held > 0 ? s.held : undefined;
      pose.offhand = s.offhand > 0 ? s.offhand : undefined;
      const sw = this.swings.get(id);
      if (!sw || sw.seq !== s.swing) this.swings.set(id, { seq: s.swing, t: sw ? 0 : 1 });
      const swing = this.swings.get(id)!;
      pose.swing = swing.t < 1 ? swing.t : 0;
      pose.guard = (s.act & 1) !== 0;
      pose.draw = s.act & 2 ? 1 : s.act & 12 ? 0.5 : 0;
      pose.flash = this.flashes.get(s.eid) ?? 0;
      if (s.act & 32) pose.alpha = 0;
    };
  }

  get interaction(): Partial<InteractionHooks> {
    return {
      breakSeconds: (b) => this.breakSeconds(b),
      onDigStart: (x, y, z) => {
        this.digCell = { x, y, z };
        this.backend?.digStart(x, y, z);
      },
      entityDistance: () => this.currentTarget()?.distance ?? Infinity,
      onSecondary: (t, pressed) => this.onSecondary(t, pressed),
    };
  }

  /** Opens the bag (survival). */
  openInventory(opts: { station?: Station | null } = {}): void {
    if (this.creative || !this.ui || this.dead) return;
    if (this.ui.inventory.isOpen) {
      this.ui.inventory.close();
      return;
    }
    this.game.releasePointer();
    audio.play('invOpen');
    this.ui.inventory.open({ station: opts.station ?? null });
    this.bindKeys();
  }

  isModalOpen(): boolean {
    return !!this.ui && (this.ui.inventory.isOpen || this.ui.death.isOpen || !!this.ui.popover);
  }

  /** Offline survival save payload (index.ts writes it under OfflineSave.survival). */
  saveData(): unknown {
    return this.backend?.saveData();
  }

  /** Pause-menu entries for the room rules (labels read when the menu opens). */
  pauseEntries(): { label: string; onClick: () => void }[] {
    if (this.creative) return [];
    const self = this;
    return [
      {
        get label() {
          const r = self.backend?.rules();
          return self.backend?.canSetRules() ? `Keep items on death: ${r?.keepInventory ? 'On' : 'Off'}` : `Items ${r?.keepInventory ? 'are kept' : 'drop'} on death`;
        },
        onClick: () => {
          if (!this.backend?.canSetRules()) return;
          this.backend.setRules({ keepInventory: !this.backend.rules().keepInventory });
        },
      },
      ...(this.opts.online
        ? [{
            get label() {
              return `PvP: ${self.backend?.rules().pvp ? 'On' : 'Off'}${self.backend?.pvpConfigurable() ? '' : ' (host only)'}`;
            },
            onClick: () => {
              if (this.backend?.pvpConfigurable()) this.backend.setRules({ pvp: !this.backend.rules().pvp });
            },
          }]
        : []),
    ];
  }

  private ensureUi(): NonNullable<SurvivalController['ui']> {
    if (this.ui) return this.ui;
    const g = this.game;
    const root = g.hud.root;
    const icons = g.itemIcons;
    const hud = new SurvivalHud(root, !this.creative, icons);
    const ui = {
      hud,
      inventory: new InventoryScreen(g.hudContainer, {
        iconFor: icons,
        inventory: () => this.model.view,
        container: () => (this.chestOpen && !this.chestOpen.sealed ? this.model.viewContainer : null),
        stations: () => stationsNear(g.world.getBlock, g.player.body.x, g.player.body.y, g.player.body.z),
        op: (op) => this.invOp(op),
        onClose: () => this.onInventoryClosed(),
        sound: (n) => audio.play(n),
      }),
      death: new DeathScreen(g.hudContainer, () => this.backend?.respawn(), () => g.exit()),
      numbers: new DamageNumbers(root),
      drops: new DropRenderer(g.voxelMaterials.opaque, g.voxelMaterials.uniforms, g.world.getBlock, (x, y, z) => g.world.lightAt(x, y, z)),
      ghosts: new ProjectileGhosts(g.voxelMaterials.uniforms, g.world.getBlock),
      fx: new HitFx(g.renderer.profile.effects),
      popover: null as HTMLElement | null,
    };
    g.scene.add(ui.drops.group, ui.ghosts.group, ui.fx.mesh);
    ui.ghosts.onStick = (x, y, z) => audio.playAt('arrowStick', x - g.camera.position.x, z - g.camera.position.z, g.player.yaw, 32);
    if (!this.creative) {
      root.classList.add('survival');
      g.hud.onLongPress = (i) => this.openSlotPopover(i);
      hud.showHint('start');
    }
    this.ui = ui;
    return ui;
  }

  // ---- hotbar ----

  private slotView(i: number): SlotView {
    const s = this.model.view.get(i);
    if (!s) return { item: 0, name: '' };
    const def = itemDef(s.item);
    const dur = def?.durability ?? 0;
    const wear = dur && wearOf(s.meta) ? 1 - wearOf(s.meta) / dur : undefined;
    const count = i < HOTBAR ? this.model.shownCount(i, performance.now()) : s.count;
    return { item: s.item, name: dur ? `${itemName(s.item)} ${dur - wearOf(s.meta)}/${dur}` : itemName(s.item), count, wear, loaded: def?.ranged?.type === 'crossbow' && loadedOf(s.meta) !== LoadedAmmo.None };
  }

  private slotViews(): SlotView[] {
    return Array.from({ length: HOTBAR }, (_, i) => this.slotView(i));
  }

  private placeable(i: number): number | null {
    const item = this.model.view.counts[i] ? this.model.view.items[i] : 0;
    if (!isBlockItem(item) || this.model.shownCount(i, performance.now()) <= 0 || this.dead) return null;
    const t = this.game.interaction.target;
    if (t && isInteractiveBlock(t.block) && !this.game.player.crouching) return null;
    return item;
  }

  /** Item in the main hand (sandbox: the sandbox hotbar's). */
  private heldItem(): number {
    return this.game.hotbar.heldItem(this.game.hud.selected);
  }

  private hasAmmo(ammo: readonly number[]): boolean {
    return this.creative || this.model.view.findFirst(ammo) >= 0;
  }

  // ---- interaction hooks ----

  private breakSeconds(block: number): number {
    if (this.creative) return blockDef(block).hardness;
    if (block === Block.Chest) {
      const p = this.game.interaction.target;
      if (p) {
        const s = this.game.generator.structureAt(p.x, p.y, p.z);
        if (s?.chests.some((c) => c.sealed && c.x === p.x && c.y === p.y && c.z === p.z) && !isBossDefeated(this.game.world.getBlock, s)) return Infinity;
      }
    }
    return survivalBreakSeconds(block, this.heldItem());
  }

  private onSecondary(t: VoxelHit | null, pressed: boolean): boolean {
    if (this.dead) return true;
    if (!this.creative && t && isInteractiveBlock(t.block) && !this.game.player.crouching) {
      if (pressed) {
        this.interactLatch = true;
        this.useBlock(t);
      }
      return true;
    }
    const item = this.heldItem();
    return item >= 256 || (!this.creative && item === 0);
  }

  private useBlock(t: VoxelHit): void {
    const b = this.backend;
    if (!b) return;
    switch (t.block) {
      case Block.Chest:
        b.interact(InteractKind.OpenChest, t.x, t.y, t.z);
        break;
      case Block.Bedroll:
        b.interact(InteractKind.UseBedroll, t.x, t.y, t.z);
        break;
      case Block.Workbench:
        this.openInventory({ station: Station.Workbench });
        break;
      case Block.Furnace:
        this.openInventory({ station: Station.Furnace });
        break;
    }
  }

  /** Nearest creature or player under the crosshair within reach (cached per frame). */
  private currentTarget(): Target | null {
    if (this.targetFrame === this.frame) return this.target;
    this.targetFrame = this.frame;
    const g = this.game;
    const eye = g.camera.position;
    const d = forwardFromYawPitch(g.player.yaw, g.player.pitch);
    const pad = settings.get().aimAssist && g.input.isEnabled() && this.lastTouch ? 0.35 : 0.15;
    let best: Target | null = null;
    const mob = g.entities?.raycast(eye.x, eye.y, eye.z, d.x, d.y, d.z, REACH, pad);
    if (mob) best = { refType: RefType.Mob, id: mob.id, distance: mob.distance, x: eye.x + d.x * mob.distance, y: eye.y + d.y * mob.distance, z: eye.z + d.z * mob.distance, name: '' };
    const net = g.net as VoxelNet | null;
    const state = net && 'session' in net ? net.session.state : null;
    if (net && state) {
      for (const [id, r] of net.remoteBodies()) {
        const s = state.players?.get(id) as { eid: number; act: number; name: string } | undefined;
        if (!s || s.act & 32) continue;
        const t = rayAabb(eye.x, eye.y, eye.z, d.x, d.y, d.z, boxAt(r.x, r.y, r.z, 0.3, 1.8, pad));
        if (t <= REACH && (!best || t < best.distance)) best = { refType: RefType.Player, id: s.eid, distance: t, x: eye.x + d.x * t, y: eye.y + d.y * t, z: eye.z + d.z * t, name: s.name };
      }
    }
    this.target = best;
    return best;
  }

  private lastTouch = false;

  // ---- per frame ----

  beforePhysics(_dt: number, input: InputFrame): MoveMods | void {
    this.frame++;
    this.lastTouch = input.touch;
    if (!this.backend) return;
    const now = performance.now();
    const resting = (this.vflags & VitalFlags.Resting) !== 0;
    let mul = 1;
    if (this.guarding) mul *= 0.45;
    if (this.drawing) mul *= 0.5;
    if (this.loading) mul *= 0.6;
    if (this.eating) mul *= 0.5;
    if (now < this.slowUntil) mul *= this.slowMul;
    return {
      speedMul: mul,
      noSprint: (this.vflags & VitalFlags.Starving) !== 0 || this.guarding || now < this.noSprintUntil,
      locked: this.dead || resting,
    };
  }

  onStep(body: PlayerBody): void {
    const p = this.game.player;
    this.backend?.pose(body, p.yaw, p.pitch, p.crouching, p.sprinting, false);
  }

  update(dt: number, input: InputFrame, paused: boolean): void {
    const b = this.backend;
    if (!b) return;
    const ui = this.ensureUi();
    this.time += dt;
    b.update(dt, paused && !this.isModalOpen());
    for (const e of b.takeEvents()) this.onEvent(e);
    for (const e of b.takePrivate()) this.onPrivate(e);
    if (!paused) this.handleInput(dt, input);
    this.updateViews(dt);
    if (ui.inventory.isOpen) ui.inventory.refresh();
  }

  private handleInput(dt: number, input: InputFrame): void {
    const g = this.game;
    const b = this.backend!;
    const now = performance.now();
    const item = this.heldItem();
    const def = itemDef(item);
    const view = this.model.view;
    const sel = g.hud.selected;
    const alive = !this.dead;
    const resting = (this.vflags & VitalFlags.Resting) !== 0;
    if (resting && (input.pressed.has('jump') || input.pressed.has('crouch'))) b.interact(InteractKind.StopRest, 0, 0, 0);

    // Keys: bag, drop, swap hands.
    if (!this.creative) {
      if (input.pressed.has('inventory')) this.openInventory();
      if (input.pressed.has('drop') && view.counts[sel]) this.invOp({ op: 'drop', from: sel, count: input.held.has('crouch') ? 0 : 1 });
      if (input.pressed.has('swapHands')) this.invOp({ op: 'swapHands' });
    }

    const secondary = input.held.has('secondary');
    if (!secondary) this.interactLatch = false;
    const useHeld = secondary && !this.interactLatch && alive && !resting;
    const ranged = def?.ranged;
    const shieldAvail = (!this.creative && view.counts[OFFHAND] > 0 && !!itemDef(view.items[OFFHAND])?.shield) || !!def?.shield;
    const shieldDisabled = (this.vflags & VitalFlags.ShieldDisabled) !== 0;

    // Bow: hold to draw, release to shoot.
    const wasDrawing = this.drawing;
    this.drawing = !!ranged && ranged.type === 'bow' && useHeld && this.hasAmmo(ranged.ammo);
    if (this.drawing && !wasDrawing) {
      this.drawStart = now;
      audio.play('bowDraw');
      this.ui!.hud.showHint('bow');
    }
    const charge = this.drawing ? Math.min(1, (now - this.drawStart) / 1000 / (ranged?.drawTime ?? 1)) : 0;
    if (wasDrawing && !this.drawing && ranged?.type === 'bow' && !secondary) {
      const c = Math.min(1, (now - this.drawStart) / 1000 / ranged.drawTime);
      if (c >= ranged.minCharge) {
        const slot = this.creative ? -1 : view.findFirst(ranged.ammo);
        this.fire(item, c, ammoKind(slot >= 0 ? view.items[slot] : Item.Arrow));
        audio.play('bowRelease', { pitch: 0.9 + c * 0.2 });
      }
    }
    g.heldView.setDraw(this.drawing ? Math.max(0.02, charge) : 0);

    // Crossbow: hold to load, then tap to fire.
    const xbow = ranged?.type === 'crossbow';
    const serverLoaded = xbow && (this.creative ? this.creativeLoaded : loadedOf(view.metas[sel]) !== LoadedAmmo.None);
    if (serverLoaded) this.loadedLocal = false;
    if (this.loadedLocal && now > this.loadedLocalUntil) this.loadedLocal = false;
    const loaded = xbow && (serverLoaded || this.loadedLocal);
    const wasLoading = this.loading;
    this.loading = xbow && !loaded && useHeld && this.hasAmmo(ranged!.ammo);
    if (this.loading && !wasLoading) this.loadStart = now;
    const loadF = this.loading ? (now - this.loadStart) / 1000 / ranged!.drawTime : 0;
    if (this.loading && loadF >= 1) {
      this.loading = false;
      this.interactLatch = true; // release before firing
      this.loadedLocal = true;
      this.loadedLocalUntil = now + 1500;
      if (this.creative) this.creativeLoaded = true;
      audio.play('xbowLoad');
    }
    if (loaded && alive && (input.pressed.has('primary') || (input.pressed.has('secondary') && !this.interactLatch))) {
      const l = this.creative ? LoadedAmmo.Bolt : loadedOf(view.metas[sel]);
      this.fire(item, 1, loadKind(l === LoadedAmmo.None ? LoadedAmmo.Bolt : l));
      this.loadedLocal = false;
      this.creativeLoaded = false;
      this.interactLatch = true;
      audio.play('xbowFire');
      g.heldView.recoil();
      this.nextAttack = now + 250;
    }
    g.heldView.setLoad(this.loading ? Math.min(1, loadF) : 0, loaded);

    // Eating.
    this.eating = !this.creative && !!def?.food && useHeld && this.food < 20;
    if (this.eating && (this.eatSoundT -= dt) <= 0) {
      this.eatSoundT = 0.25;
      audio.play('eat');
      const e = g.camera.position;
      const f = forwardFromYawPitch(g.player.yaw, g.player.pitch);
      this.ui!.fx.crumbs(e.x + f.x * 0.45, e.y - 0.25, e.z + f.z * 0.45, def!.color);
    }
    g.heldView.setEating(this.eating);

    // Guard: Z / Guard button, or Use with no other use for the main hand.
    const mainUse = !!ranged || (!!def?.food && !this.creative) || (item > 0 && item < 256);
    this.guarding = alive && shieldAvail && !shieldDisabled && (input.held.has('guard') || (useHeld && !mainUse));
    g.heldView.setGuard(this.guarding);

    // Hand state to the sim (after a shot, so the server still sees Use when it fires).
    const flags = (this.guarding ? HandFlags.Guard : 0) | (this.drawing || this.loading || this.eating ? HandFlags.Use : 0);
    const creativeItem = this.creative ? item : 0;
    const key = `${sel},${flags},${creativeItem}`;
    if (key !== this.sentHand) {
      this.sentHand = key;
      b.hand(sel, flags, creativeItem);
    }

    // Melee: attack what is under the crosshair; a press on air swings.
    const stats = meleeOf(item);
    if (alive && !resting && now >= this.nextAttack && !this.guarding && !this.drawing && !loaded && input.held.has('primary')) {
      const t = this.currentTarget();
      if (t && t.distance <= stats.reach + 0.3) this.attack(t, item);
      else if (input.pressed.has('primary') && !g.interaction.target) this.attack(null, item);
    }
  }

  private attack(t: Target | null, item: number): void {
    const g = this.game;
    const now = performance.now();
    const stats = meleeOf(item);
    const body = g.player.body;
    const crit = body.vy < -1 && !body.onGround && !body.inWater;
    const sprint = g.player.sprinting;
    const e = g.camera.position;
    const pvpOff = t?.refType === RefType.Player && (!this.backend!.rules().pvp || this.creative);
    const target = t && !pvpOff ? { refType: t.refType, id: t.id } : { refType: RefType.World, id: 0 };
    this.seq = (this.seq + 1) & 0xffff;
    this.backend!.attack({ seq: this.seq, target, ex: e.x, ey: e.y, ez: e.z, yaw: g.player.yaw, pitch: g.player.pitch, crit, sprint });
    this.nextAttack = now + stats.cooldown * 1000;
    this.cooldownTotal = stats.cooldown * 1000;
    const def = itemDef(item);
    const kind = def?.kind === ItemKind.Sword ? 'sword' : def?.tool?.kind === 'axe' ? 'axe' : def?.tool ? 'tool' : item === 0 ? 'fist' : 'use';
    g.heldView.swing(kind);
    audio.play(kind === 'axe' ? 'swingHeavy' : 'swing', { pitch: 0.92 + Math.random() * 0.16 });
    if (sprint) this.noSprintUntil = now + 400;
    if (t && target.refType !== RefType.World) {
      // Predicted feedback; numbers wait for the server.
      audio.play(crit ? 'hitCrit' : 'hitFlesh');
      if (crit) this.ui!.fx.crit(t.x, t.y, t.z);
      else this.ui!.fx.hit(t.x, t.y, t.z);
      this.ui!.hud.hitMarker(crit ? 'crit' : 'hit');
    }
  }

  private fire(item: number, charge: number, kind: ProjectileKind): void {
    const g = this.game;
    const r = itemDef(item)!.ranged!;
    const e = g.camera.position;
    const d = forwardFromYawPitch(g.player.yaw, g.player.pitch);
    this.seq = (this.seq + 1) & 0xffff;
    this.backend!.shoot({ seq: this.seq, ox: e.x, oy: e.y, oz: e.z, yaw: g.player.yaw, pitch: g.player.pitch, charge });
    const speed = r.speedMin + (r.speedMax - r.speedMin) * charge;
    const authoritative = this.backend!.online || !!g.localEntities?.api;
    g.heldView.swing('use');
    this.ui!.ghosts.spawn(kind, e.x + d.x * 0.3, e.y + d.y * 0.3 - 0.05, e.z + d.z * 0.3, d.x * speed, d.y * speed, d.z * speed, authoritative);
  }

  private invOp(op: InvOp): void {
    const b = this.backend;
    if (!b || this.creative) return;
    const g = this.game;
    const env = {
      selected: g.hud.selected,
      container: this.chestOpen && !this.chestOpen.sealed ? this.model.viewContainer : null,
      stations: op.op === 'craft' ? stationsNear(g.world.getBlock, g.player.body.x, g.player.body.y, g.player.body.z) : 0,
      sealedContainer: !!this.chestOpen?.sealed,
      craft: craftOp,
    };
    const seq = this.model.apply(op, env);
    if (seq === null) {
      audio.play('empty');
      return;
    }
    b.invOp(seq, op);
    if (op.op === 'craft') {
      audio.play('craft');
      if (this.model.view.count(Block.Workbench) > 0) this.ui?.hud.showHint('workbench');
    } else if (op.op !== 'drop') audio.play('click', { volume: 0.5 });
    this.changed = true;
  }

  // ---- events ----

  private myEid(): number {
    return this.backend?.localEid() ?? 0;
  }

  private onEvent(e: ClientEvent): void {
    const ui = this.ui!;
    const g = this.game;
    const cam = g.camera.position;
    const at = (name: SfxName, x: number, z: number, vol = 1) => audio.playAt(name, x - cam.x, z - cam.z, g.player.yaw, 32, vol);
    switch (e.type) {
      case 'dropSpawn':
        ui.drops.spawn(e);
        break;
      case 'dropMove':
        ui.drops.move(e.id, e.x, e.y, e.z);
        break;
      case 'dropRemove': {
        const info = ui.drops.info(e.id);
        const mine = e.picker !== 0 && e.picker === this.myEid();
        const b = g.player.body;
        ui.drops.remove(e.id, mine ? { x: b.x, y: b.y + 1, z: b.z } : null);
        if (mine && info) {
          audio.play(info.satchel ? 'satchel' : 'pickup', { pitch: 0.9 + Math.random() * 0.3 });
          if (!info.satchel) ui.hud.pickup(info.item, info.count, itemName(info.item));
          else g.hud.flash('Satchel recovered', 1600, 'good');
          if (info.item === Block.Log || info.item === Block.AspenLog || info.item === Block.PineLog) ui.hud.showHint('log');
        }
        break;
      }
      case 'damage':
        this.onDamage(e);
        break;
      case 'sound': {
        const name = SFX_NAMES[e.sfx];
        if (name) at(name, e.x, e.z);
        break;
      }
      case 'death':
        ui.fx.puff(e.x, e.y, e.z);
        if (e.target.refType === RefType.Player && e.target.id !== this.myEid()) at('death', e.x, e.z, 0.6);
        break;
    }
  }

  private onDamage(e: Extract<ClientEvent, { type: 'damage' }>): void {
    const ui = this.ui!;
    const g = this.game;
    const me = e.target.refType === RefType.Player && e.target.id === this.myEid();
    const blocked = (e.flags & DamageFlags.Blocked) !== 0;
    const crit = (e.flags & DamageFlags.Crit) !== 0;
    if (me) {
      if (Math.abs(e.dvx) + Math.abs(e.dvy) + Math.abs(e.dvz) > 0.01) applyBodyKnockback(g.player.body, e.dvx, e.dvy, e.dvz);
      if (e.amount > 0) {
        const len = Math.hypot(e.dvx, e.dvz);
        const angle = len > 0.01 ? Math.atan2(e.dvx, e.dvz) - g.player.yaw : null;
        ui.hud.hurt(angle === null ? null : -angle, e.amount);
        audio.play(e.kind === 4 ? 'drown' : 'hurt');
        g.heldView.hurt(angle === null ? (Math.random() < 0.5 ? -1 : 1) : Math.sin(angle) > 0 ? 1 : -1);
        this.hp = e.hpAfter;
      }
      if (blocked) {
        audio.play('shieldBlock');
        const f = forwardFromYawPitch(g.player.yaw, 0);
        const c = g.camera.position;
        ui.fx.blocked(c.x + f.x * 0.6, c.y - 0.2, c.z + f.z * 0.6);
      }
      if (e.flags & DamageFlags.ShieldDisabled) {
        audio.play('shieldBreak');
        g.hud.flash('Shield disabled!', 1200);
      }
      return;
    }
    const cam = g.camera.position;
    const atSound = (n: SfxName) => audio.playAt(n, e.x - cam.x, e.z - cam.z, g.player.yaw, 32);
    if (e.amount > 0 || blocked) ui.numbers.spawn(e.x, e.y, e.z, e.amount, blocked ? 'blocked' : crit ? 'crit' : 'hit');
    if (blocked) {
      ui.fx.blocked(e.x, e.y, e.z);
      atSound('shieldBlock');
    } else if (e.amount > 0) {
      if (crit) ui.fx.crit(e.x, e.y, e.z);
      ui.fx.hit(e.x, e.y, e.z);
      if (e.kind === 1) atSound('arrowFlesh');
    }
    if (e.target.refType === RefType.Player) this.flashes.set(e.target.id, 1);
    if (e.source.refType === RefType.Player && e.source.id === this.myEid()) {
      ui.hud.hitMarker(e.flags & DamageFlags.Killed ? 'kill' : blocked ? 'blocked' : crit ? 'crit' : 'hit');
      if (e.target.refType === RefType.Player) {
        const net = g.net as VoxelNet | null;
        let name = 'Player';
        net?.session?.state?.players?.forEach((p: { eid: number; name: string }) => {
          if (p.eid === e.target.id) name = p.name;
        });
        ui.hud.showTarget(name, e.hpAfter, e.maxHp);
      }
    }
  }

  private onPrivate(e: import('./SurvivalBackend').PrivateEvent): void {
    const ui = this.ui!;
    const g = this.game;
    switch (e.type) {
      case 'inv':
        this.model.applyServer(e);
        this.changed = true;
        break;
      case 'vitals': {
        const wasDead = this.dead;
        this.hp = e.hpHalf / 2;
        const prevFood = this.food;
        this.food = e.foodHalf / 2;
        this.vflags = e.flags;
        this.dead = (e.flags & VitalFlags.Dead) !== 0;
        const now = performance.now();
        this.slowMul = 1 - e.slowPct / 100;
        this.slowUntil = e.slowTenths > 0 ? now + e.slowTenths * 100 : 0;
        this.burnUntil = e.burnTenths > 0 ? now + e.burnTenths * 100 : 0;
        ui.hud.setVitals(this.hp, this.food, e.air, (e.flags & VitalFlags.Starving) !== 0, this.slowUntil > now, this.burnUntil > now);
        ui.hud.setShieldDisabled((e.flags & VitalFlags.ShieldDisabled) !== 0);
        if (this.food < 14 && prevFood >= 14) ui.hud.showHint('hungry');
        if (wasDead && !this.dead) {
          ui.death.close();
          audio.play('respawn');
          g.capturePointer();
        }
        break;
      }
      case 'container':
        if (e.open) {
          this.chestOpen = { x: e.x, y: e.y, z: e.z, sealed: e.sealed };
          const s = this.game.generator.structureAt(e.x, e.y, e.z);
          const chest = { title: s ? `${s.name} chest` : 'Chest', sealed: e.sealed };
          if (!ui.inventory.isOpen) {
            g.releasePointer();
            audio.play('invOpen');
            ui.inventory.open({ chest });
            this.bindKeys();
          } else ui.inventory.setChest(chest);
        } else {
          this.chestOpen = null;
          this.model.clearContainer();
          if (ui.inventory.isOpen) ui.inventory.setChest(null);
        }
        break;
      case 'dead':
        this.dead = true;
        ui.inventory.close();
        this.closePopover();
        g.releasePointer();
        audio.play('death');
        ui.death.open(e.cause, e.satchel, this.backend!.online);
        break;
      case 'notice':
        g.hud.flash(e.text, 2600);
        break;
    }
  }

  private onInventoryClosed(): void {
    this.keyOff?.();
    this.keyOff = null;
    if (this.chestOpen) this.backend?.interact(InteractKind.CloseContainer, this.chestOpen.x, this.chestOpen.y, this.chestOpen.z);
    this.chestOpen = null;
    this.model.clearContainer();
    if (!this.dead) this.game.capturePointer();
  }

  /** Esc, E and I close the bag (game input is off while it is open). */
  private bindKeys(): void {
    if (this.keyOff) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT' && e.code !== 'Escape') return;
      if (e.code === 'Escape' || e.code === 'KeyE' || e.code === 'KeyI') {
        e.preventDefault();
        this.ui?.inventory.close();
      }
    };
    window.addEventListener('keydown', onKey);
    this.keyOff = () => window.removeEventListener('keydown', onKey);
  }

  /** Touch: long-press a hotbar slot for Drop 1 / Drop all / To off hand. */
  private openSlotPopover(i: number): void {
    if (!this.ui || !this.model.view.counts[i]) return;
    this.closePopover();
    const g = this.game;
    g.input.selectSlot(i);
    const act = (op: InvOp) => () => {
      this.invOp(op);
      this.closePopover();
    };
    const shield = !!itemDef(this.model.view.items[i])?.shield;
    const el = h('div', { class: 'slot-popover', 'data-testid': 'slot-popover' },
      h('div', { class: 'sp-backdrop', onclick: () => this.closePopover() }),
      h('div', { class: 'sp-card' },
        h('b', null, itemName(this.model.view.items[i])),
        h('button', { class: 'btn btn-sm', onclick: act({ op: 'drop', from: i, count: 1 }) }, 'Drop 1'),
        h('button', { class: 'btn btn-sm', onclick: act({ op: 'drop', from: i, count: 0 }) }, 'Drop all'),
        shield ? h('button', { class: 'btn btn-sm', onclick: () => {
          this.closePopover();
          // Selecting the slot reaches the sim first, then the swap.
          window.setTimeout(() => this.invOp({ op: 'swapHands' }), 50);
        } }, 'To off hand') : null,
      ),
    );
    g.hudContainer.appendChild(el);
    this.ui.popover = el;
  }

  private closePopover(): void {
    this.ui?.popover?.remove();
    if (this.ui) this.ui.popover = null;
  }

  // ---- views ----

  private updateViews(dt: number): void {
    const ui = this.ui!;
    const g = this.game;
    const now = performance.now();
    ui.drops.update(dt, g.camera);
    ui.ghosts.update(dt);
    ui.fx.update(dt);
    ui.numbers.update(dt, g.camera);
    for (const [eid, f] of this.flashes) {
      const v = f - dt / 0.18;
      if (v <= 0) this.flashes.delete(eid);
      else this.flashes.set(eid, v);
    }
    for (const s of this.swings.values()) s.t = Math.min(1, s.t + dt / 0.3);
    // Crosshair rings.
    const item = this.heldItem();
    const def = itemDef(item);
    const left = this.nextAttack - now;
    ui.hud.setCooldown(left > 0 && def?.melee ? left / this.cooldownTotal : 0);
    const xbowLoaded = def?.ranged?.type === 'crossbow' && (this.loadedLocal || (this.creative ? this.creativeLoaded : loadedOf(this.model.view.metas[g.hud.selected]) !== LoadedAmmo.None));
    ui.hud.setCharge(this.drawing ? Math.min(1, (now - this.drawStart) / 1000 / (def?.ranged?.drawTime ?? 1)) : this.loading ? Math.min(1, (now - this.loadStart) / 1000 / (def?.ranged?.drawTime ?? 1)) : null, xbowLoaded);
    g.heldView.setOffhand(this.creative ? 0 : this.model.view.counts[OFFHAND] ? this.model.view.items[OFFHAND] : 0);
    if (!this.creative) {
      const t = g.sky.time;
      ui.hud.setDay(this.backend!.day(), t);
      if (this.lastTime >= 0 && this.lastTime < DUSK_TIME && t >= DUSK_TIME) {
        g.hud.flash('Night falls', 2200);
        audio.play('nightFall');
        ui.hud.showHint('dusk');
      } else if (this.lastTime >= 0 && isNight(this.lastTime) && !isNight(t)) g.hud.flash(`Day ${this.backend!.day()}`, 1800, 'good');
      this.lastTime = t;
      // Satchel chip.
      const s = ui.drops.ourSatchel();
      const b = g.player.body;
      ui.hud.setSatchel(s ? { bearing: -(Math.atan2(-(s.x - b.x), -(s.z - b.z)) - g.player.yaw), dist: Math.hypot(s.x - b.x, s.z - b.z) } : null, () => {
        if (s) g.hud.flash(`Satchel at ${Math.round(s.x)}, ${Math.round(s.y)}, ${Math.round(s.z)}`, 2500);
      });
      // Resting.
      if (this.vflags & VitalFlags.Resting) {
        const net = g.net as VoxelNet | null;
        let resting = 0;
        let alive = 0;
        net?.session?.state?.players?.forEach((p: { act: number }) => {
          if (p.act & 32) return;
          alive++;
          if (p.act & 64) resting++;
        });
        ui.hud.setRest(net ? `Resting… ${resting}/${alive} players · Jump to get up` : 'Resting… · Jump to get up');
      } else ui.hud.setRest(null);
      if (def?.shield || itemDef(this.model.view.items[OFFHAND])?.shield) ui.hud.showHint('shield');
    }
    this.updateTouch(def);
  }

  /** Relabels touch buttons for what the hands can do. */
  private updateTouch(def: ReturnType<typeof itemDef>): void {
    const tc = this.game.touchControls;
    if (!tc) return;
    const t = this.currentTarget();
    const attack = !!t && t.distance <= meleeOf(this.heldItem()).reach + 0.3;
    const it = this.game.interaction.target;
    let place = 'Place';
    let placeIcon = GAME_ICONS.place;
    if (!this.creative && it && isInteractiveBlock(it.block) && !this.game.player.crouching) place = it.block === Block.Bedroll ? 'Rest' : 'Open';
    else if (def?.ranged?.type === 'bow') [place, placeIcon] = ['Draw', GAME_ICONS.bow];
    else if (def?.ranged?.type === 'crossbow') [place, placeIcon] = [this.loadedLocal || loadedOf(this.model.view.metas[this.game.hud.selected]) || this.creativeLoaded ? 'Fire' : 'Load', GAME_ICONS.bow];
    else if (def?.food && !this.creative) [place, placeIcon] = ['Eat', GAME_ICONS.eat];
    else if (def?.shield) [place, placeIcon] = ['Guard', GAME_ICONS.shield];
    else if (def && def.id >= 256) place = 'Use';
    const shield = !!def?.shield || (!this.creative && !!itemDef(this.model.view.items[OFFHAND])?.shield && this.model.view.counts[OFFHAND] > 0);
    const state = `${attack}|${place}|${shield}|${this.guarding}`;
    if (state === this.touchState) return;
    this.touchState = state;
    tc.setButton('break', { label: attack ? 'Attack' : this.creative ? 'Break' : 'Mine', icon: attack ? GAME_ICONS.sword : GAME_ICONS.pickaxe });
    tc.setButton('place', { label: place, icon: placeIcon });
    tc.setButton('guard', { hidden: !shield, active: this.guarding });
  }

  /** A local edit was applied (offline): drops, consumption and wear in the sim. */
  afterLocalEdit(x: number, y: number, z: number, before: number, after: number): void {
    if (!this.backend || this.backend.online) return;
    let player = false;
    if (after === Block.Air) {
      const d = this.digCell;
      player = !!d && d.x === x && d.y === y && d.z === z;
      if (player) this.digCell = null;
    } else {
      const sel = this.game.hud.selected;
      player = this.creative || placementItem(after, before) === this.model.view.items[sel];
    }
    this.backend.afterLocalEdit(x, y, z, before, after, player);
  }

  // ---- dev hooks (e2e) ----

  debugGive(key: string, n = 1): void {
    const b = this.backend;
    if (b instanceof LocalSurvival) {
      const item = itemFromKey(key);
      if (item !== null) b.player.inv.add(item, n);
    } else (this.game.net as VoxelNet | null)?.session?.send('dbg', { give: [key, n] });
  }

  debugDamage(hp: number): void {
    const b = this.backend;
    if (b instanceof LocalSurvival) b.sim.debugDamage('local', hp);
    else (this.game.net as VoxelNet | null)?.session?.send('dbg', { damage: hp });
  }

  /** Local sim (offline), for tests. */
  get local(): LocalSurvival | null {
    return this.backend instanceof LocalSurvival ? this.backend : null;
  }

  dispose(): void {
    this.keyOff?.();
    this.closePopover();
    if (this.ui) {
      const g = this.game;
      g.scene.remove(this.ui.drops.group, this.ui.ghosts.group, this.ui.fx.mesh);
      this.ui.hud.dispose();
      this.ui.inventory.close();
      this.ui.death.close();
      this.ui.numbers.dispose();
      this.ui.drops.dispose();
      this.ui.ghosts.dispose();
      this.ui.fx.dispose();
    }
    this.backend?.dispose();
  }
}

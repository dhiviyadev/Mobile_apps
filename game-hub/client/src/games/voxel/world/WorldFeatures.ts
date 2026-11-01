/**
 * World-area features in the running game (WP-A): the sandbox hotbar (12
 * slots, saved per browser in cobalt-hub.voxel.hotbar.v1), the Block Picker
 * (B / Blocks button / long-press a slot), pick-block (middle mouse), biome and
 * ruin banners, biome fog tint, lava ambience, the offline support cascade and
 * the note for worlds made before the biomes update.
 */
import * as THREE from 'three';
import { blockDef, canonicalBlock, collectUnsupported, FIRST_ITEM, HOTBAR_BLOCKS, isSandboxSlotItem, itemName } from '@hub/shared';
import { audio } from '../../../core/audio/audio';
import type { InputFrame } from '../../../core/input/InputManager';
import type { HotbarSource, VoxelModule } from '../modules';
import { BlockPicker, type PickerTab } from '../ui/BlockPicker';
import { createItemIcons } from '../ui/itemIcons';
import type { SlotView } from '../ui/VoxelHud';
import type { VoxelGame } from '../VoxelGame';
import { createAtlasCanvas } from './atlas';
import { Surroundings } from './Surroundings';

export type { PickerTab };

export const HOTBAR_KEY = 'cobalt-hub.voxel.hotbar.v1';
/** Shown in the pause menu of worlds made before the biomes update. */
export const LEGACY_NOTE = 'This world was made before the Biomes update. New biomes, ores and ruins appear in new worlds.';

function loadHotbar(): number[] {
  const slots = [...HOTBAR_BLOCKS] as number[];
  try {
    const raw = JSON.parse(localStorage.getItem(HOTBAR_KEY) ?? 'null') as unknown;
    if (Array.isArray(raw)) raw.slice(0, slots.length).forEach((id, i) => {
      if (typeof id === 'number' && Number.isInteger(id) && isSandboxSlotItem(id)) slots[i] = id;
    });
  } catch {
    /* no saved hotbar */
  }
  return slots;
}

let iconCache: ReturnType<typeof createItemIcons> | null = null;

export class WorldFeatures implements VoxelModule {
  private slots: number[];
  private changed = true;
  private readonly extraTabs: PickerTab[] = [];
  private picker: BlockPicker | null = null;
  private readonly surroundings: Surroundings;
  private cascading = false;
  private legacyShown = false;

  constructor(protected readonly game: VoxelGame) {
    const mode = game.generator.mode;
    this.slots = mode === 'sandbox' ? loadHotbar() : [...HOTBAR_BLOCKS];
    this.surroundings = new Surroundings(
      { generator: game.generator, getBlock: (x, y, z) => game.world.getBlock(x, y, z), showPlace: (t, s) => game.hud?.showPlace(t, s) },
      mode !== 'parkour',
    );
  }

  readonly hotbar: HotbarSource = {
    views: (): readonly SlotView[] => this.slots.map((item) => ({ item, name: item < FIRST_ITEM ? blockDef(item).name : itemName(item) })),
    takeChanged: () => {
      const c = this.changed;
      this.changed = false;
      return c;
    },
    placeable: (i) => (this.slots[i] !== undefined && this.slots[i] < 256 ? this.slots[i] : null),
    heldItem: (i) => this.slots[i] ?? 0,
  };

  /** Fog tint for VoxelGame.updateLighting (weight 0 = none). */
  get fogTint(): { color: THREE.Color; weight: number } {
    return this.surroundings.fog;
  }

  /** Sandbox: assign an item to a slot (picker, pick-block). Saved per browser. */
  setSlot(i: number, item: number): void {
    if (i < 0 || i >= this.slots.length || !isSandboxSlotItem(item)) return;
    this.slots[i] = item;
    this.changed = true;
    this.saveHotbar();
  }

  /** Extra picker tabs (WP-B: sandbox weapons, tools, ammo and food). */
  addPickerTab(tab: PickerTab): void {
    this.extraTabs.push(tab);
  }

  /** Opens the Block Picker for a slot (sandbox only). */
  openPicker(slot?: number): void {
    if (this.game.generator.mode !== 'sandbox') return;
    if (document.pointerLockElement) document.exitPointerLock();
    iconCache ??= createItemIcons(createAtlasCanvas());
    this.picker ??= new BlockPicker(this.game.hud.root.parentElement ?? document.body, {
      iconFor: iconCache.iconFor,
      slots: () => this.slots,
      assign: (s, item) => this.setSlot(s, item),
      reset: () => {
        this.slots = [...HOTBAR_BLOCKS];
        this.changed = true;
        this.saveHotbar();
      },
      targetBlock: () => this.targetBlock(),
      extraTabs: () => this.extraTabs,
      onClose: () => undefined,
    });
    this.picker.open(slot ?? this.game.hud.selected);
  }

  isModalOpen(): boolean {
    return this.picker?.isOpen ?? false;
  }

  update(dt: number, input: InputFrame, paused: boolean): void {
    const b = this.game.player.body;
    this.surroundings.update(dt, b.x, b.y + 1.6, b.z, this.game.player.yaw);
    if (!this.legacyShown) {
      this.legacyShown = true;
      if (this.game.generator.genVersion === 1 && this.game.generator.mode !== 'parkour' && !this.game.net) {
        this.game.hud.showPlace('New biomes and ruins', 'Start a New world from the menu to explore them', 5000);
      }
    }
    if (paused || this.game.generator.mode !== 'sandbox') return;
    if (input.pressed.has('loadout')) this.openPicker();
    if (input.pressed.has('pickBlock')) {
      const t = this.targetBlock();
      if (t !== null) {
        this.setSlot(this.game.hud.selected, t);
        audio.play('click');
      }
    }
  }

  /** Offline: blocks that lost their support go too (online the server sends them). */
  afterLocalEdit(x: number, y: number, z: number): void {
    if (this.cascading || this.game.net) return;
    this.cascading = true;
    try {
      const cells = collectUnsupported(this.game.world.getBlock, x, y, z);
      for (const [cx, cy, cz] of cells) this.game.applyWorldEdit(cx, cy, cz, 0);
      if (cells.length) audio.play('breakPlant', { volume: 0.6 });
    } finally {
      this.cascading = false;
    }
  }

  dispose(): void {
    this.picker?.dispose();
  }

  private targetBlock(): number | null {
    const t = this.game.interaction?.target;
    if (!t) return null;
    const id = canonicalBlock(t.block);
    return isSandboxSlotItem(id) ? id : null;
  }

  private saveHotbar(): void {
    if (this.game.generator.mode !== 'sandbox') return;
    try {
      localStorage.setItem(HOTBAR_KEY, JSON.stringify(this.slots));
    } catch {
      /* storage full or blocked: keep playing */
    }
  }
}

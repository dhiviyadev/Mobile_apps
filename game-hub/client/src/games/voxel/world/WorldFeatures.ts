/**
 * World-area features in the running game (WP-A owns this file after WP0):
 * the sandbox hotbar (12 slots, saved per browser in cobalt-hub.voxel.hotbar.v1),
 * the Block Picker (B / Blocks button / long-press a slot), pick-block (middle
 * mouse), biome and ruin banners, biome fog tint, lava ambience, legacy-world note.
 * WP0 stub: the fixed HOTBAR_BLOCKS hotbar.
 */
import { blockDef, HOTBAR_BLOCKS } from '@hub/shared';
import type { InputFrame } from '../../../core/input/InputManager';
import type { HotbarSource, VoxelModule } from '../modules';
import type { SlotView } from '../ui/VoxelHud';
import type { VoxelGame } from '../VoxelGame';

/** A tab the picker shows (WP-B registers 'Items'). */
export interface PickerTab {
  id: string;
  label: string;
  items(): readonly number[];
}

export class WorldFeatures implements VoxelModule {
  private slots: number[] = [...HOTBAR_BLOCKS];
  private changed = true;
  private readonly extraTabs: PickerTab[] = [];

  constructor(protected readonly game: VoxelGame) {}

  readonly hotbar: HotbarSource = {
    views: (): readonly SlotView[] => this.slots.map((item) => ({ item, name: blockDef(item).name })),
    takeChanged: () => {
      const c = this.changed;
      this.changed = false;
      return c;
    },
    placeable: (i) => (this.slots[i] !== undefined && this.slots[i] < 256 ? this.slots[i] : null),
    heldItem: (i) => this.slots[i] ?? 0,
  };

  /** Sandbox: assign an item to a slot (picker, pick-block). */
  setSlot(i: number, item: number): void {
    if (i < 0 || i >= this.slots.length) return;
    this.slots[i] = item;
    this.changed = true;
  }

  /** Extra picker tabs (WP-B: sandbox weapons, tools, ammo and food). */
  addPickerTab(tab: PickerTab): void {
    this.extraTabs.push(tab);
  }

  /** Opens the Block Picker for a slot (sandbox only). WP-A. */
  openPicker(_slot?: number): void {}

  isModalOpen(): boolean {
    return false;
  }

  beforePhysics(_dt: number, _input: InputFrame): void {}

  update(_dt: number, _input: InputFrame, _paused: boolean): void {}

  dispose(): void {}
}

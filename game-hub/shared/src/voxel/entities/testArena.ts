/**
 * Synthetic boss arenas for dev hooks and tests: a walled 17x17x8 room with
 * pillars, lights, an altar against the north wall and a south doorway, in
 * the style of each structure type (pools in the shrine, lava braziers in the
 * crypt). Real structures come from the world generator (WLD §7).
 */
import { Block } from '../blocks';
import { LootTableId } from '../loot';
import { STRUCTURE_NAMES, StructureType, type StructureInfo } from '../structures/types';
import { Biome } from '../worldgen';

export interface TestArena {
  info: StructureInfo;
  /** World edits that build it: [x, y, z, id]. */
  edits: [number, number, number, number][];
}

const HALF = 8;
const HEIGHT = 8;

/**
 * Original blocks (ids 0..29) only, so the arena renders with any atlas; the
 * altar and the crypt's lava braziers are the only newer blocks.
 */
const STYLE: Record<StructureType, { wall: number; floor: number; pillar: number; ceiling: number; trim: number }> = {
  [StructureType.SunscorchTemple]: { wall: Block.Brick, floor: Block.Sand, pillar: Block.Planks, ceiling: Block.Brick, trim: Block.Lamp },
  [StructureType.FrostCitadel]: { wall: Block.Cobble, floor: Block.Stone, pillar: Block.Ice, ceiling: Block.Snow, trim: Block.Lamp },
  [StructureType.OvergrownShrine]: { wall: Block.Cobble, floor: Block.Dirt, pillar: Block.Log, ceiling: Block.Leaves, trim: Block.Lamp },
  [StructureType.AshenCrypt]: { wall: Block.Stone, floor: Block.Gravel, pillar: Block.Cobble, ceiling: Block.Stone, trim: Block.Lamp },
};

/** Builds a test arena of `type` centred on (cx, cz) with its floor surface at feet height `floorY`. */
export function buildTestArena(type: StructureType, cx: number, floorY: number, cz: number, id = 0xfff0 + type): TestArena {
  cx = Math.floor(cx);
  cz = Math.floor(cz);
  const F = Math.max(3, Math.min(52, Math.floor(floorY)));
  const s = STYLE[type];
  const cells = new Map<string, [number, number, number, number]>();
  const set = (x: number, y: number, z: number, b: number) => cells.set(`${x},${y},${z}`, [x, y, z, b]);
  const x0 = cx - HALF;
  const x1 = cx + HALF + 1;
  const z0 = cz - HALF;
  const z1 = cz + HALF + 1;
  for (let x = x0 - 1; x <= x1; x++) {
    for (let z = z0 - 1; z <= z1; z++) {
      const wall = x === x0 - 1 || x === x1 || z === z0 - 1 || z === z1;
      set(x, F - 1, z, s.floor);
      set(x, F - 2, z, s.wall);
      for (let y = F; y < F + HEIGHT; y++) set(x, y, z, wall ? (y === F + 4 && (x + z) % 4 === 0 ? s.trim : s.wall) : Block.Air);
      // Clear a little air above the roof so terrain does not bury the lights.
      set(x, F + HEIGHT, z, (x - cx) % 4 === 0 && (z - cz) % 4 === 0 && !wall ? Block.Lamp : s.ceiling);
    }
  }
  // Doorway in the south wall and a short approach.
  for (let x = cx - 1; x <= cx + 1; x++) {
    for (let y = F; y < F + 3; y++) {
      set(x, y, z1, Block.Air);
      set(x, y, z1 + 1, Block.Air);
      set(x, y, z1 + 2, Block.Air);
    }
  }
  // Pillars, pools and braziers per style.
  const pillars: [number, number][] =
    type === StructureType.OvergrownShrine
      ? [[cx - 5, cz], [cx + 5, cz], [cx, cz - 5]]
      : [[cx - 5, cz - 5], [cx + 5, cz - 5], [cx - 5, cz + 5], [cx + 5, cz + 5]];
  for (const [px, pz] of pillars) for (let y = F; y < F + HEIGHT; y++) set(px, y, pz, s.pillar);
  if (type === StructureType.OvergrownShrine) {
    for (const [px, pz] of [[cx - 5, cz - 5], [cx + 5, cz - 5], [cx - 5, cz + 5], [cx + 5, cz + 5]]) {
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) set(px + dx, F - 1, pz + dz, Block.Water);
    }
  }
  if (type === StructureType.AshenCrypt) {
    for (const [px, pz] of [[cx - 7, cz - 7], [cx + 7, cz - 7], [cx - 7, cz + 7], [cx + 7, cz + 7]]) {
      set(px, F, pz, Block.Cobble);
      set(px, F + 1, pz, Block.Lava);
    }
  }
  const altar = { x: cx, y: F, z: z0 };
  set(altar.x, altar.y, altar.z, Block.BossAltar);
  const arena = { x0, y0: F, z0, x1, y1: F + HEIGHT, z1 };
  const info: StructureInfo = {
    id,
    type,
    name: STRUCTURE_NAMES[type],
    biome: Biome.Plains,
    anchor: { x: cx, z: cz },
    bounds: { x0: x0 - 1, y0: F - 2, z0: z0 - 1, x1: x1 + 1, y1: F + HEIGHT + 1, z1: z1 + 3 },
    entrance: { x: cx, y: F, z: z1 + 2 },
    arena,
    bossSpawn: { x: cx + 0.5, y: F, z: cz + 0.5 },
    altar,
    doorways: [{ x0: cx - 1, y0: F, z0: z1, x1: cx + 2, y1: F + 3, z1: z1 + 1 }],
    chests: [{ x: cx + 1, y: F, z: z0, index: 0, loot: LootTableId.TempleBoss, lootSeed: 1, sealed: true }],
    guardSpawns: [{ x: cx - 2.5, y: F, z: z1 + 2.5 }, { x: cx + 3.5, y: F, z: z1 + 2.5 }],
  };
  return { info, edits: [...cells.values()] };
}

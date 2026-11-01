/**
 * Placement and support rules, shared by the server (edit validation and the
 * support cascade), offline play and client prediction:
 *   - Support.Below: plants, torches, lanterns, snow layers, bedrolls need a
 *     solid block underneath (cactus: sand, red sand or cactus; reeds: solid or
 *     reeds; lily pads: still water);
 *   - Support.Above: hanging moss hangs from a solid block (leaves count) or moss;
 *   - Support.Wall: ladders lean on the solid block their id faces.
 * Breaking a supporting block removes what it held, following chains (reed and
 * cactus stacks upward, moss downward).
 */
import {
  Block,
  canonicalBlock,
  IS_LIQUID,
  IS_REPLACEABLE,
  IS_SOLID,
  isPlaceable,
  ladderFacing,
  ladderWall,
  SLAB_FULL,
  SUPPORT,
  Support,
} from './blocks';
import type { VoxelHit } from './raycast';

export type BlockGet = (x: number, y: number, z: number) => number;

/** Most cells one support cascade removes. */
export const MAX_CASCADE = 32;

/** True when `id` at (x, y, z) has what it stands on / hangs from / leans on. */
export function hasSupport(get: BlockGet, x: number, y: number, z: number, id: number): boolean {
  switch (SUPPORT[id]) {
    case Support.Below: {
      const below = get(x, y - 1, z);
      if (id === Block.Cactus) return below === Block.Sand || below === Block.RedSand || below === Block.Cactus;
      if (id === Block.Reeds) return IS_SOLID[below] === 1 || below === Block.Reeds;
      if (id === Block.LilyPad) return below === Block.Water;
      return IS_SOLID[below] === 1;
    }
    case Support.Above: {
      const above = get(x, y + 1, z);
      return IS_SOLID[above] === 1 || above === id;
    }
    case Support.Wall: {
      const w = ladderWall(id);
      return !!w && IS_SOLID[get(x + w[0], y, z + w[1])] === 1;
    }
    default:
      return true;
  }
}

/** null when the block may be placed there; otherwise the reason (as the server logs it). */
export function placementError(get: BlockGet, x: number, y: number, z: number, id: number): string | null {
  if (!isPlaceable(id)) return 'not placeable';
  const current = get(x, y, z);
  const merge = SLAB_FULL[current] !== 0 && id === SLAB_FULL[current];
  if (current !== Block.Air && !IS_LIQUID[current] && !IS_REPLACEABLE[current] && !merge) return 'occupied by a block';
  if (!hasSupport(get, x, y, z, id)) return 'needs support';
  return null;
}

const SIDES = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const;

/**
 * After the cell (x, y, z) changed (`get` already shows the change): every
 * block that lost its support, following chains, in removal order, at most
 * MAX_CASCADE cells.
 */
export function collectUnsupported(get: BlockGet, x: number, y: number, z: number): [number, number, number][] {
  const removed: [number, number, number][] = [];
  const gone = new Set<string>();
  const view: BlockGet = (bx, by, bz) => (gone.has(`${bx},${by},${bz}`) ? Block.Air : get(bx, by, bz));
  const queue: [number, number, number][] = [[x, y, z]];
  while (queue.length && removed.length < MAX_CASCADE) {
    const [cx, cy, cz] = queue.shift()!;
    for (const [dx, dy, dz] of SIDES) {
      const nx = cx + dx;
      const ny = cy + dy;
      const nz = cz + dz;
      if (ny < 0 || ny > 63) continue;
      const id = view(nx, ny, nz);
      if (SUPPORT[id] === Support.None || hasSupport(view, nx, ny, nz, id)) continue;
      gone.add(`${nx},${ny},${nz}`);
      removed.push([nx, ny, nz]);
      queue.push([nx, ny, nz]);
      if (removed.length >= MAX_CASCADE) break;
    }
  }
  return removed;
}

/**
 * Where (and as what) the selected block goes when placed against a hit:
 * into a replaceable hit cell itself; a slab on top of the same slab becomes
 * the full block; ladders face the block they lean on (top/bottom faces: the
 * wall in the look direction). Null when there is nowhere to put it.
 */
export function resolvePlacement(get: BlockGet, hit: VoxelHit, selected: number, yaw: number): { x: number; y: number; z: number; id: number } | null {
  if (IS_REPLACEABLE[hit.block] && !IS_LIQUID[hit.block] && canonicalBlock(selected) !== Block.LadderNZ) {
    return { x: hit.x, y: hit.y, z: hit.z, id: selected };
  }
  if (SLAB_FULL[selected] && hit.block === selected && hit.ny === 1) {
    return { x: hit.x, y: hit.y, z: hit.z, id: SLAB_FULL[selected] };
  }
  const x = hit.x + hit.nx;
  const y = hit.y + hit.ny;
  const z = hit.z + hit.nz;
  if (canonicalBlock(selected) === Block.LadderNZ) {
    if (hit.nx !== 0 || hit.nz !== 0) return { x, y, z, id: ladderFacing(-hit.nx, -hit.nz) };
    // Top or bottom face: lean on the wall in front (forward is (-sin yaw, -cos yaw)).
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const [wx, wz] = Math.abs(fx) >= Math.abs(fz) ? [Math.sign(fx), 0] : [0, Math.sign(fz)];
    if (!IS_SOLID[get(x + wx, y, z + wz)]) return null;
    return { x, y, z, id: ladderFacing(wx, wz) };
  }
  return { x, y, z, id: selected };
}

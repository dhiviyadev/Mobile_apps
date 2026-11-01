/**
 * The 6 tree species of the v2 generator (oak, aspen, pine, thornwood,
 * duskwood, mahogany) plus their variants (swamp oak, snowy pine, giants,
 * jungle bush). Every shape is a pure function of the root and the cell hash,
 * so a tree crossing a chunk border is built identically by both chunks.
 */
import { hashFloat } from '../../util/rng';
import { Block } from '../blocks';
import { TreeSpecies } from './biomes';

/**
 * Writes a block; `onlyAir` leaves anything but air alone (leaves, moss, snow).
 * Logs overwrite. Returns true when the cell now holds `b` (false outside the chunk).
 */
export type TreeSet = (x: number, y: number, z: number, b: Block, onlyAir: boolean) => boolean;

/** Trunk height for a species from the cell hash. */
export function treeHeight(species: TreeSpecies, hsh: number): number {
  const r = (n: number) => (hsh >>> 16) % n;
  switch (species) {
    case TreeSpecies.Oak:
      return 4 + r(3);
    case TreeSpecies.SwampOak:
      return 5 + r(2);
    case TreeSpecies.Aspen:
      return 6 + r(3);
    case TreeSpecies.Pine:
    case TreeSpecies.SnowyPine:
      return 7 + r(4);
    case TreeSpecies.Thornwood:
      return 4 + (hsh % 2);
    case TreeSpecies.Duskwood:
      return 6 + r(3);
    case TreeSpecies.GiantDuskwood:
      return 8 + r(4);
    case TreeSpecies.Mahogany:
      return 9 + r(5);
    case TreeSpecies.GiantMahogany:
      return 12 + r(5);
    case TreeSpecies.JungleBush:
      return 1;
  }
}

/** Builds one tree whose trunk starts at (x, y, z) (y = first log above the ground). */
export function placeTree(species: TreeSpecies, x: number, y: number, z: number, hsh: number, seed: number, set: TreeSet): void {
  const height = Math.min(treeHeight(species, hsh), 60 - y);
  const top = y + height - 1;
  const chance = (bx: number, by: number, bz: number, salt: number) => hashFloat(bx * 31 + salt, by, bz, seed);
  const leaf = (bx: number, by: number, bz: number, b: Block) => set(bx, by, bz, b, true);
  const trunk = (log: Block, wide: boolean, h = height) => {
    for (let k = 0; k < h; k++) {
      set(x, y + k, z, log, false);
      if (wide) {
        set(x + 1, y + k, z, log, false);
        set(x, y + k, z + 1, log, false);
        set(x + 1, y + k, z + 1, log, false);
      }
    }
  };
  /** Horizontal leaf disc; `cx`/`cz` may be off-cell (giants). */
  const disc = (cy: number, r2: number, b: Block, cx = x, cz = z, edge?: [number, number]) => {
    const r = Math.ceil(Math.sqrt(r2));
    for (let dz = -r; dz <= r + 1; dz++) {
      for (let dx = -r; dx <= r + 1; dx++) {
        const bx = Math.floor(cx) + dx;
        const bz = Math.floor(cz) + dz;
        const d2 = (bx + 0.5 - (cx + 0.5)) ** 2 + (bz + 0.5 - (cz + 0.5)) ** 2;
        if (d2 > r2) continue;
        if (edge && d2 > edge[0] && chance(bx, cy, bz, 3) >= edge[1]) continue;
        leaf(bx, cy, bz, b);
      }
    }
  };
  const plus = (cy: number, b: Block, cx = x, cz = z) => {
    leaf(cx, cy, cz, b);
    leaf(cx + 1, cy, cz, b);
    leaf(cx - 1, cy, cz, b);
    leaf(cx, cy, cz + 1, b);
    leaf(cx, cy, cz - 1, b);
  };

  switch (species) {
    case TreeSpecies.Oak: {
      // The v1 oak: two wide layers, then a narrow cap.
      for (let dy = -2; dy <= 1; dy++) {
        const ly = top + dy;
        const r = dy <= -1 ? 2 : 1;
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const corner = Math.abs(dx) === r && Math.abs(dz) === r;
            if (corner && (r === 1 || hashFloat(x + dx, ly, z + dz, seed) < 0.6)) continue;
            leaf(x + dx, ly, z + dz, Block.Leaves);
          }
        }
      }
      trunk(Block.Log, false);
      break;
    }
    case TreeSpecies.SwampOak: {
      const rim: [number, number][] = [];
      for (const ly of [top - 1, top]) {
        for (let dz = -3; dz <= 3; dz++) {
          for (let dx = -3; dx <= 3; dx++) {
            const ax = Math.abs(dx), az = Math.abs(dz);
            if (ax === 3 && az === 3) continue;
            if (ax + az === 5 && chance(x + dx, ly, z + dz, 5) < 0.5) continue;
            const placed = leaf(x + dx, ly, z + dz, Block.Leaves);
            if (placed && ly === top - 1 && Math.max(ax, az) === 3) rim.push([dx, dz]);
          }
        }
      }
      plus(top + 1, Block.Leaves);
      // Moss hangs from the leaves of the lower rim, stopping at the first obstacle.
      for (const [dx, dz] of rim) {
        if (chance(x + dx, top, z + dz, 6) >= 0.3) continue;
        const len = 1 + Math.floor(chance(x + dx, top, z + dz, 7) * 3);
        for (let k = 1; k <= len; k++) if (!leaf(x + dx, top - 1 - k, z + dz, Block.HangingMoss)) break;
      }
      trunk(Block.Log, false);
      break;
    }
    case TreeSpecies.Aspen: {
      for (let ly = top - 3; ly <= top - 1; ly++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx !== 0 && dz !== 0 && chance(x + dx, ly, z + dz, 8) < 0.5) continue;
            leaf(x + dx, ly, z + dz, Block.AspenLeaves);
          }
        }
      }
      plus(top, Block.AspenLeaves);
      leaf(x, top + 1, z, Block.AspenLeaves);
      trunk(Block.AspenLog, false);
      break;
    }
    case TreeSpecies.Pine:
    case TreeSpecies.SnowyPine: {
      const snowy = species === TreeSpecies.SnowyPine;
      leaf(x, top + 1, z, snowy ? Block.Snow : Block.PineLeaves);
      plus(top, Block.PineLeaves);
      for (let k = 1; k <= height - 3; k++) {
        const ly = top - k;
        const r = k % 2 === 1 ? 1 : 2;
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            const ax = Math.abs(dx), az = Math.abs(dz);
            if (ax === r && az === r) continue;
            if (r === 2 && ax + az === 3 && chance(x + dx, ly, z + dz, 9) < 0.4) continue;
            const placed = leaf(x + dx, ly, z + dz, Block.PineLeaves);
            if (placed && snowy && r === 2 && Math.max(ax, az) === 2 && chance(x + dx, ly, z + dz, 10) < 0.6) leaf(x + dx, ly + 1, z + dz, Block.SnowLayer);
          }
        }
      }
      trunk(Block.PineLog, false);
      break;
    }
    case TreeSpecies.Thornwood: {
      const a = 2 + (hsh % 2);
      const dirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
      const [sx, sz] = dirs[(hsh >>> 4) & 3];
      trunk(Block.ThornwoodLog, false, a);
      let tx = x, ty = y + a - 1, tz = z;
      for (let k = 0; k < 2; k++) {
        tx += sx;
        tz += sz;
        ty += 1;
        set(tx, ty, tz, Block.ThornwoodLog, false);
      }
      disc(ty + 1, 9.5, Block.ThornwoodLeaves, tx, tz, [8, 0.7]);
      disc(ty + 2, 4.5, Block.ThornwoodLeaves, tx, tz);
      break;
    }
    case TreeSpecies.Duskwood:
      for (let ly = top - 2; ly <= top; ly++) disc(ly, 5, Block.DuskwoodLeaves);
      disc(top + 1, 2, Block.DuskwoodLeaves);
      trunk(Block.DuskwoodLog, false);
      break;
    case TreeSpecies.GiantDuskwood:
      for (let ly = top - 2; ly <= top; ly++) disc(ly, 10.5, Block.DuskwoodLeaves, x + 0.5, z + 0.5);
      disc(top + 1, 3, Block.DuskwoodLeaves, x + 0.5, z + 0.5);
      trunk(Block.DuskwoodLog, true);
      break;
    case TreeSpecies.Mahogany:
    case TreeSpecies.GiantMahogany: {
      const giant = species === TreeSpecies.GiantMahogany;
      const c = giant ? 0.5 : 0;
      disc(top - 1, giant ? 13 : 9.5, Block.MahoganyLeaves, x + c, z + c);
      disc(top, 4.5, Block.MahoganyLeaves, x + c, z + c);
      plus(top + 1, Block.MahoganyLeaves);
      // Side branches with a leaf blob 2 out.
      const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
      for (const [i, by] of [y + Math.floor(height / 2), y + Math.floor((2 * height) / 3)].entries()) {
        const [dx, dz] = dirs[((hsh >>> (8 + i * 2)) + i) & 3];
        const ox = dx > 0 && giant ? 1 : 0;
        const oz = dz > 0 && giant ? 1 : 0;
        set(x + ox + dx, by, z + oz + dz, Block.MahoganyLog, false);
        const lx = x + ox + dx * 2, lz = z + oz + dz * 2;
        for (let ey = -1; ey <= 1; ey++) for (let ez = -1; ez <= 1; ez++) for (let ex = -1; ex <= 1; ex++) if (Math.abs(ex) + Math.abs(ey) + Math.abs(ez) <= 1) leaf(lx + ex, by + ey, lz + ez, Block.MahoganyLeaves);
      }
      trunk(Block.MahoganyLog, giant);
      break;
    }
    case TreeSpecies.JungleBush:
      set(x, y, z, Block.MahoganyLog, false);
      disc(y, 4, Block.MahoganyLeaves);
      plus(y + 1, Block.MahoganyLeaves);
      break;
  }
}

/** Widest reach of any tree from its root column (cells scanned around a chunk). */
export const TREE_REACH = 6;

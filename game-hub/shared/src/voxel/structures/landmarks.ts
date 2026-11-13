/**
 * Generator-3 additions to the boss structures, so ruins can be found in an
 * endless world:
 * - every temple, citadel and shrine gets a landmark spire beside its way in:
 *   a tapering tower of its own stone with glowing lamps at the top, tall
 *   enough to show over the trees from about 100 blocks;
 * - the Ashen Crypt gets a gatehouse: a crumbling tower beside the
 *   mausoleum whose spiral stair winds down to the catacomb's east room, with
 *   lit door posts at the top and a lamp-crowned pillar as its landmark.
 * Generator-2 structures are untouched (worlds keep their blocks).
 */
import { Block } from '../blocks';
import { type Box3i, StructureType } from './types';
import { StructureVolume } from './volume';

/** Highest cell a structure block may take. */
const TOP = 62;

interface Palette {
  body: Block;
  accent: Block;
  worn: Block;
}

const PALETTES: Partial<Record<StructureType, Palette>> = {
  [StructureType.SunscorchTemple]: { body: Block.SandstoneBricks, accent: Block.Marble, worn: Block.Sandstone },
  [StructureType.FrostCitadel]: { body: Block.IceBricks, accent: Block.PackedIce, worn: Block.StoneBricks },
  [StructureType.OvergrownShrine]: { body: Block.MossyStoneBricks, accent: Block.MudBricks, worn: Block.MossyCobble },
  [StructureType.AshenCrypt]: { body: Block.StoneBricks, accent: Block.BasaltBricks, worn: Block.MossyStoneBricks },
};

/** What the additions need to know about a placed structure. */
export interface LandmarkSite {
  type: StructureType;
  anchor: { x: number; z: number };
  bounds: Box3i;
  /** Floor height F. */
  floor: number;
}

// ---- spires (temple, citadel, shrine) ---------------------------------------------------------

/** Spire footprint corner (3x3), beside the entrance side of the structure. */
function spireCorner(s: LandmarkSite): { x: number; z: number } {
  const b = s.bounds;
  // The temple's door faces north (-z); the citadel's and shrine's face south (+z).
  return s.type === StructureType.SunscorchTemple ? { x: b.x0 - 4, z: b.z0 - 4 } : { x: b.x0 - 4, z: b.z1 + 1 };
}

const spireTop = (F: number) => Math.min(TOP, F + 26);

// ---- the crypt gatehouse ------------------------------------------------------------------------

/** Spiral ring around the gatehouse pillar, clockwise from the north-west corner. */
const RING: readonly [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
/** Catacomb floor (the block under the side rooms' feet). */
const CAT_FLOOR = 9;

/** Centre column of the crypt gatehouse of a crypt anchored at (ax, az). */
export const cryptGate = (ax: number, az: number) => ({ x: ax + 13, z: az - 14 });
const gateTop = (F: number) => Math.min(TOP - 3, F + 12);

/** Ring index of the stair's top step (its last step, on the floor, is always the west cell by the room door). */
const topStep = (F: number) => (((7 - (F - CAT_FLOOR)) % 8) + 8) % 8;

/** The gatehouse door: the wall cell beside the top step and the step out of it. */
function gateDoor(F: number, gx: number, gz: number): { x: number; z: number; dx: number; dz: number } {
  const [rx, rz] = RING[topStep(F)];
  // Corners leave through their x side.
  const dx = rx !== 0 ? rx : 0;
  const dz = rx !== 0 ? 0 : rz;
  return { x: gx + rx + dx, z: gz + rz + dz, dx, dz };
}

// ---- layout and build ---------------------------------------------------------------------------

/** The box the additions occupy (to grow the structure's bounds). */
export function landmarkBox(s: LandmarkSite): Box3i {
  const F = s.floor;
  if (s.type === StructureType.AshenCrypt) {
    const g = cryptGate(s.anchor.x, s.anchor.z);
    return { x0: g.x - 4, y0: CAT_FLOOR, z0: g.z - 4, x1: g.x + 5, y1: gateTop(F) + 4, z1: g.z + 5 };
  }
  const c = spireCorner(s);
  return { x0: c.x, y0: F - 1, z0: c.z, x1: c.x + 3, y1: spireTop(F) + 1, z1: c.z + 3 };
}

/** Grows `b` to hold `o`. */
export function unionBox(b: Box3i, o: Box3i): Box3i {
  return { x0: Math.min(b.x0, o.x0), y0: Math.min(b.y0, o.y0), z0: Math.min(b.z0, o.z0), x1: Math.max(b.x1, o.x1), y1: Math.max(b.y1, o.y1), z1: Math.max(b.z1, o.z1) };
}

/**
 * Where the crypt gatehouse stands must be about as high as the mausoleum
 * floor, so its door opens onto the ground (checked when placing crypts).
 */
export function cryptGateFits(column: (x: number, z: number) => { height: number }, ax: number, az: number, F: number): boolean {
  const g = cryptGate(ax, az);
  const d = gateDoor(F, g.x, g.z);
  for (const [x, z] of [[g.x, g.z], [d.x + d.dx * 2, d.z + d.dz * 2]]) {
    const h = column(x, z).height;
    if (h < F - 3 || h > F + 2) return false;
  }
  return true;
}

/** Builds the additions of a structure (volumes copied after the template's own). */
export function buildLandmark(s: LandmarkSite, rng: () => number): StructureVolume[] {
  return s.type === StructureType.AshenCrypt ? [buildGatehouse(s, rng)] : [buildSpire(s, rng)];
}

function buildSpire(s: LandmarkSite, rng: () => number): StructureVolume {
  const F = s.floor;
  const p = PALETTES[s.type]!;
  const c = spireCorner(s);
  const top = spireTop(F);
  const oy = F - 1;
  const v = new StructureVolume(c.x, oy, c.z, 3, top - oy + 1, 3, p.body);
  const stone = () => (rng() < 0.18 ? p.worn : p.body);
  for (let y = oy; y <= top; y++) {
    const ly = y - oy;
    const h = y - F;
    if (h <= 14) {
      // Square shaft: full 3x3 up to F+8, then the corners fall away.
      for (let z = 0; z < 3; z++) {
        for (let x = 0; x < 3; x++) {
          const corner = x !== 1 && z !== 1;
          if (corner && h > 8) continue;
          v.set(x, ly, z, h % 6 === 0 && !corner ? p.accent : stone());
        }
      }
    } else if (y < top) {
      v.set(1, ly, 1, h % 4 === 0 ? p.accent : p.body);
    } else {
      v.set(1, ly, 1, Block.Lamp);
    }
  }
  // A ring of lamps where the shaft narrows, and an accent cap under them.
  const lampY = Math.min(top - 2, F + 14) - oy;
  for (const [x, z] of [[1, 0], [0, 1], [2, 1], [1, 2]]) v.set(x, lampY, z, Block.Lamp);
  return v;
}

function buildGatehouse(s: LandmarkSite, rng: () => number): StructureVolume {
  const F = s.floor;
  const p = PALETTES[StructureType.AshenCrypt]!;
  const g = cryptGate(s.anchor.x, s.anchor.z);
  const top = gateTop(F);
  const ox = g.x - 4;
  const oz = g.z - 4;
  const oy = CAT_FLOOR;
  const v = new StructureVolume(ox, oy, oz, 9, top + 4 - oy + 1, 9, null);
  const at = (x: number, y: number, z: number, id: number) => v.set(x - ox, y - oy, z - oz, id);
  const wall = (y: number) => (y < F - 1 ? Block.BasaltBricks : rng() < 0.3 ? p.worn : p.body);

  // Shell (5x5) from the catacomb floor to the top, crumbling in its last rows; floor and pillar inside.
  for (let y = oy; y <= top; y++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
        if (!edge) {
          at(g.x + dx, y, g.z + dz, y === oy || (dx === 0 && dz === 0) ? Block.BasaltBricks : Block.Air);
          continue;
        }
        if (y === top && (dx + dz) % 2 !== 0) continue; // crenels
        if (y >= top - 2 && rng() < 0.3) continue; // broken stones
        at(g.x + dx, y, g.z + dz, wall(y));
      }
    }
  }
  // The pillar: lamps every 6 blocks down the stair, and a lamp-crowned top above the walls.
  for (let y = oy + 3; y < F; y += 6) at(g.x, y, g.z, Block.Lamp);
  for (let y = top + 1; y <= top + 3; y++) at(g.x, y, g.z, p.accent);
  at(g.x, top + 4, g.z, Block.Lamp);

  // Spiral stair: step k (top block y = F - k) on ring cell (topStep + k) % 8, down to the floor.
  const t0 = topStep(F);
  for (let k = 0; k < F - CAT_FLOOR; k++) {
    const [rx, rz] = RING[(t0 + k) % 8];
    at(g.x + rx, F - k, g.z + rz, F - k < F - 1 ? Block.BasaltBricks : Block.StoneBricks);
  }

  // Bottom door: west, through the gatehouse wall and the side room's east wall.
  for (const y of [CAT_FLOOR + 1, CAT_FLOOR + 2]) {
    at(g.x - 2, y, g.z, Block.Air);
    at(g.x - 3, y, g.z, Block.Air);
  }

  // Top door, a short paved path out of it, and two lit posts flanking the path.
  const d = gateDoor(F, g.x, g.z);
  for (let y = F + 1; y <= F + 3; y++) at(d.x, y, d.z, Block.Air);
  at(d.x, F + 4, d.z, p.accent);
  for (let i = 1; i <= 2; i++) {
    const x = d.x + d.dx * i;
    const z = d.z + d.dz * i;
    at(x, F, z, i === 1 ? p.accent : Block.StoneBricks);
    for (let y = F + 1; y <= F + 3; y++) at(x, y, z, Block.Air);
  }
  // Posts beside the second path cell (perpendicular to the way out).
  const px = d.dz !== 0 ? 1 : 0;
  const pz = d.dx !== 0 ? 1 : 0;
  for (const side of [-1, 1]) {
    const x = d.x + d.dx * 2 + px * side;
    const z = d.z + d.dz * 2 + pz * side;
    at(x, F, z, p.accent);
    at(x, F + 1, z, p.body);
    at(x, F + 2, z, p.body);
    at(x, F + 3, z, Block.Lantern);
  }
  return v;
}

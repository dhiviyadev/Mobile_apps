import { describe, expect, it } from 'vitest';
import {
  approxLight,
  Block,
  BLOCKS,
  BLOCK_COUNT,
  blockDef,
  canonicalBlock,
  collectUnsupported,
  collides,
  createBody,
  hasSupport,
  isPlaceable,
  ladderFacing,
  ladderWall,
  LIGHT_COST,
  LIGHT_EMISSION,
  MAX_CASCADE,
  packPos,
  placementError,
  PLACEABLE,
  PLAYER_EYE,
  raycastVoxels,
  resolvePlacement,
  SLAB_FULL,
  stepBody,
  Tile,
  VOXEL_PHYSICS,
} from '../src';
import { meshChunk, REGION_VOLUME, regionIndex } from '../src/voxel/mesher';
import { computeLight } from '../src/voxel/light';

/** A sparse world: listed cells, air elsewhere, bedrock below 0. */
function world(cells: [number, number, number, number][]) {
  const map = new Map<number, number>();
  for (const [x, y, z, b] of cells) map.set(packPos(x, y, z), b);
  const get = (x: number, y: number, z: number) => (y < 0 ? Block.Bedrock : (map.get(packPos(x, y, z)) ?? 0));
  const set = (x: number, y: number, z: number, b: number) => map.set(packPos(x, y, z), b);
  return { get, set };
}
const floor = (size: number, extra: [number, number, number, number][] = []) => {
  const cells: [number, number, number, number][] = [];
  for (let x = -size; x <= size; x++) for (let z = -size; z <= size; z++) cells.push([x, 0, z, Block.Stone]);
  return world([...cells, ...extra]);
};
const still = { strafe: 0, forward: 0, yaw: 0, jump: false, sprint: false, crouch: false, autoJump: false };

describe('block registry (world area)', () => {
  it('keeps the original ids and flags', () => {
    const snapshot = [
      [Block.Air, 0, 0, 1, 0, 0], [Block.Grass, 1, 1, 0, 0, 0], [Block.Water, 5, 0, 1, 1, 0], [Block.Leaves, 7, 1, 1, 0, 0],
      [Block.Glass, 10, 1, 1, 0, 0], [Block.Lamp, 13, 1, 0, 0, 1], [Block.Bedrock, 14, 1, 0, 0, 0], [Block.Ice, 21, 1, 1, 0, 0], [Block.WaterFalling, 29, 0, 1, 1, 0],
    ];
    for (const [id, want, solid, transparent, liquid, emissive] of snapshot) {
      const d = blockDef(id);
      expect([id, d.solid ? 1 : 0, d.transparent ? 1 : 0, d.liquid ? 1 : 0, d.emissive ? 1 : 0]).toEqual([want, solid, transparent, liquid, emissive]);
    }
    expect(BLOCK_COUNT).toBe(144);
  });

  it('references only tiles of the 16x16 atlas', () => {
    for (const d of BLOCKS) if (d) for (const t of d.tiles) expect(t).toBeLessThan(240);
    expect(Tile.Crack0).toBe(240);
  });

  it('places what it should and every placeable block can be supported', () => {
    expect(PLACEABLE.has(Block.Lava) || PLACEABLE.has(Block.BossAltar) || PLACEABLE.has(Block.BossAltarDormant)).toBe(false);
    for (const id of [Block.LadderNZ, Block.LadderPX, Block.LadderPZ, Block.LadderNX]) expect(isPlaceable(id)).toBe(true);
    expect(canonicalBlock(Block.LadderPX)).toBe(Block.LadderNZ);
    for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) expect(ladderWall(ladderFacing(dx, dz))).toEqual([dx, dz]);
    // A solid cube everywhere around (sand below for cactus, water for lily pads).
    for (const id of PLACEABLE) {
      const below = id === Block.Cactus ? Block.Sand : id === Block.LilyPad ? Block.Water : Block.Stone;
      const get = (x: number, y: number, z: number) => (x === 0 && y === 0 && z === 0 ? 0 : y === -1 && x === 0 && z === 0 ? below : Block.Stone);
      expect(hasSupport(get, 0, 0, 0, id), blockDef(id).name).toBe(true);
    }
    for (let id = 0; id < 256; id++) {
      if (!SLAB_FULL[id]) continue;
      const full = blockDef(SLAB_FULL[id]);
      expect(full.placeable && full.solid && !full.transparent).toBe(true);
    }
  });
});

describe('support rules', () => {
  it('removes a flower when its soil goes', () => {
    const w = world([[0, 0, 0, Block.Grass], [0, 1, 0, Block.Sunpetal]]);
    w.set(0, 0, 0, Block.Air);
    expect(collectUnsupported(w.get, 0, 0, 0)).toEqual([[0, 1, 0]]);
  });

  it('follows cactus stacks up and moss chains down', () => {
    const c = world([[0, 0, 0, Block.Sand], [0, 1, 0, Block.Cactus], [0, 2, 0, Block.Cactus], [0, 3, 0, Block.Cactus]]);
    c.set(0, 0, 0, Block.Air);
    expect(collectUnsupported(c.get, 0, 0, 0)).toEqual([[0, 1, 0], [0, 2, 0], [0, 3, 0]]);
    const m = world([[0, 9, 0, Block.Leaves], [0, 8, 0, Block.HangingMoss], [0, 7, 0, Block.HangingMoss]]);
    m.set(0, 9, 0, Block.Air);
    expect(collectUnsupported(m.get, 0, 9, 0)).toEqual([[0, 8, 0], [0, 7, 0]]);
  });

  it('drops a ladder whose wall goes and caps a cascade', () => {
    const l = world([[0, 1, -1, Block.Stone], [0, 1, 0, Block.LadderNZ]]);
    l.set(0, 1, -1, Block.Air);
    expect(collectUnsupported(l.get, 0, 1, -1)).toEqual([[0, 1, 0]]);
    const tall: [number, number, number, number][] = [[0, 0, 0, Block.Sand]];
    for (let y = 1; y < 50; y++) tall.push([0, y, 0, Block.Reeds]);
    const r = world(tall);
    r.set(0, 0, 0, Block.Air);
    expect(collectUnsupported(r.get, 0, 0, 0)).toHaveLength(MAX_CASCADE);
  });

  it('validates placement like the server', () => {
    const w = world([[0, 0, 0, Block.Grass], [1, 1, 0, Block.TallGrass], [1, 0, 0, Block.Grass], [2, 0, 0, Block.StoneSlab], [3, 0, 0, Block.Stone]]);
    expect(placementError(w.get, 5, 5, 5, Block.Torch)).toBe('needs support');
    expect(placementError(w.get, 0, 1, 0, Block.Torch)).toBeNull();
    expect(placementError(w.get, 1, 1, 0, Block.Stone)).toBeNull(); // tall grass is replaceable
    expect(placementError(w.get, 2, 0, 0, Block.Stone)).toBeNull(); // slab + slab = full block
    expect(placementError(w.get, 3, 0, 0, Block.Stone)).toBe('occupied by a block');
    expect(placementError(w.get, 0, 1, 0, Block.Lava)).toBe('not placeable');
    const hit = raycastVoxels(w.get, 2.5, 3, 0.5, 0, -1, 0, 6)!;
    expect(hit.block).toBe(Block.StoneSlab);
    expect(resolvePlacement(w.get, hit, Block.StoneSlab, 0)).toEqual({ x: 2, y: 0, z: 0, id: Block.Stone });
    // A ladder clicked on the side of the stone faces it.
    const side = raycastVoxels(w.get, 5.5, 0.5, 0.5, -1, 0, 0, 6)!;
    expect(resolvePlacement(w.get, side, Block.LadderNZ, 0)).toEqual({ x: 4, y: 0, z: 0, id: ladderFacing(-1, 0) });
  });
});

describe('shapes in the mesher', () => {
  const vol = () => new Uint8Array(REGION_VOLUME);
  it('draws plants as 4 quads, and none when decor is hidden', () => {
    const v = vol();
    v[regionIndex(5, 0, 5)] = Block.Grass;
    v[regionIndex(5, 1, 5)] = Block.TallGrass;
    const grassOnly = meshChunk((() => { const g = vol(); g[regionIndex(5, 0, 5)] = Block.Grass; return g; })()).opaque.vertexCount;
    expect(meshChunk(v).opaque.vertexCount - grassOnly).toBe(16);
    expect(meshChunk(v, { decor: false }).opaque.vertexCount).toBe(grassOnly);
  });

  it('draws a slab with a half-height top, culls shared faces and lights it from its neighbours', () => {
    const v = vol();
    for (let x = -16; x < 32; x++) for (let z = -16; z < 32; z++) v[regionIndex(x, 0, z)] = Block.Stone;
    const base = meshChunk(v).opaque.vertexCount;
    v[regionIndex(4, 1, 4)] = Block.StoneSlab;
    const one = meshChunk(v).opaque;
    expect(one.vertexCount - base).toBe(20); // 5 slab faces (the bottom one lies on stone)
    const ys = new Set<number>();
    for (let i = base; i < one.vertexCount; i++) ys.add(one.positions[i * 3 + 1]);
    expect(ys.has(1.5)).toBe(true);
    const lit = [...Array(one.vertexCount).keys()].filter((i) => one.positions[i * 3 + 1] === 1.5).map((i) => one.lights[i * 4 + 1]);
    expect(Math.min(...lit)).toBe(255);
    v[regionIndex(5, 1, 4)] = Block.StoneSlab;
    const two = meshChunk(v).opaque.vertexCount;
    expect(two - one.vertexCount).toBe(12); // 3 more faces: the two shared sides are culled
  });

  it('keeps lava in the opaque pass, emissive, with a lowered surface, and shows water against it', () => {
    const v = vol();
    v[regionIndex(3, 4, 3)] = Block.Lava;
    v[regionIndex(4, 4, 3)] = Block.Water;
    const m = meshChunk(v);
    expect(m.opaque.vertexCount).toBeGreaterThan(0);
    let top = false;
    for (let i = 0; i < m.opaque.vertexCount; i++) {
      expect(m.opaque.lights[i * 4 + 3]).toBe(255);
      if (m.opaque.positions[i * 3 + 1] === 4.875) top = true;
    }
    expect(top).toBe(true);
    let waterFace = false;
    for (let i = 0; i < m.liquid.vertexCount; i++) if (m.liquid.positions[i * 3] === 4) waterFace = true;
    expect(waterFace).toBe(true);
  });

  it('makes torches emissive and gives non-cube cells no greedy faces', () => {
    const v = vol();
    v[regionIndex(6, 0, 6)] = Block.Stone;
    v[regionIndex(6, 1, 6)] = Block.Torch;
    const m = meshChunk(v).opaque;
    let emissive = 0;
    for (let i = 0; i < m.vertexCount; i++) if (m.lights[i * 4 + 3] === 255) emissive++;
    expect(emissive).toBe(5 * 4); // torch box minus its bottom face
  });
});

describe('shape physics and raycast', () => {
  it('lands on a slab at half height and steps onto it without jumping', () => {
    const slabs: [number, number, number, number][] = [[0, 1, 0, Block.StoneSlab]];
    for (let x = 3; x <= 6; x++) for (let z = -1; z <= 1; z++) slabs.push([x, 1, z, Block.StoneSlab]);
    const w = floor(6, slabs);
    const body = createBody(0.5, 4, 0.5);
    for (let i = 0; i < 120; i++) stepBody(body, still, w.get, 1 / 60, PLAYER_EYE);
    expect(body.y).toBeCloseTo(1.5, 5);
    const walker = createBody(1.5, 1, 0.5);
    let jumped = false;
    for (let i = 0; i < 40; i++) {
      stepBody(walker, { ...still, strafe: 1 }, w.get, 1 / 60, PLAYER_EYE);
      jumped ||= walker.jumped;
    }
    expect(walker.x).toBeGreaterThan(3.2);
    expect(walker.y).toBeCloseTo(1.5, 5);
    expect(jumped).toBe(false);
  });

  it('still auto-jumps a full block and walks through snow layers and plants', () => {
    const w = floor(6, [[3, 1, 0, Block.Stone], [3, 1, 1, Block.Stone], [3, 1, -1, Block.Stone], [1, 1, 0, Block.SnowLayer]]);
    const body = createBody(0.5, 1, 0.5);
    let jumped = false;
    for (let i = 0; i < 90; i++) {
      stepBody(body, { ...still, strafe: 1, autoJump: true }, w.get, 1 / 60, PLAYER_EYE);
      jumped ||= body.jumped;
    }
    expect(jumped).toBe(true);
    expect(collides(w.get, 1.5, 1, 0.5)).toBe(false);
  });

  it('climbs ladders and slides down them slowly', () => {
    const cells: [number, number, number, number][] = [];
    for (let y = 1; y < 12; y++) {
      cells.push([0, y, -1, Block.Stone], [0, y, 0, Block.LadderNZ]);
    }
    const w = floor(4, cells);
    const body = createBody(0.5, 1, 0.5);
    let maxVy = 0;
    for (let i = 0; i < 40; i++) {
      stepBody(body, { ...still, forward: 1 }, w.get, 1 / 60, PLAYER_EYE);
      maxVy = Math.max(maxVy, body.vy);
    }
    expect(maxVy).toBeCloseTo(VOXEL_PHYSICS.climbSpeed, 5);
    expect(body.y).toBeGreaterThan(2.5);
    let minVy = 0;
    for (let i = 0; i < 60; i++) {
      stepBody(body, still, w.get, 1 / 60, PLAYER_EYE);
      minVy = Math.min(minVy, body.vy);
    }
    expect(minVy).toBeGreaterThanOrEqual(-VOXEL_PHYSICS.climbSlide - 1e-9);
  });

  it('hits shapes only inside their box', () => {
    const w = world([[5, 1, 0, Block.StoneSlab], [7, 1, 0, Block.Dirt], [2, 1, 0, Block.Torch]]);
    // Through the empty upper half of the slab onto the dirt behind it.
    const over = raycastVoxels(w.get, 3.5, 1.8, 0.5, 1, 0, 0, 10)!;
    expect(over.block).toBe(Block.Dirt);
    const low = raycastVoxels(w.get, 3.5, 1.2, 0.5, 1, 0, 0, 10)!;
    expect(low).toMatchObject({ x: 5, block: Block.StoneSlab, nx: -1 });
    // Beside the torch stick: miss; through it: hit.
    expect(raycastVoxels(w.get, 0.5, 1.3, 0.1, 1, 0, 0, 4)).toBeNull();
    expect(raycastVoxels(w.get, 0.5, 1.3, 0.5, 1, 0, 0, 4)?.block).toBe(Block.Torch);
  });
});

describe('light with the new blocks', () => {
  it('torches emit 14, needles dim like leaves, slabs block sky light', () => {
    expect(LIGHT_EMISSION[Block.Torch]).toBe(14);
    expect(LIGHT_COST[Block.PineLeaves]).toBe(LIGHT_COST[Block.Leaves]);
    const sx = 3, sz = 3, h = 4;
    const blocks = new Uint8Array(sx * sz * h);
    blocks[(3 * sz + 1) * sx + 1] = Block.StoneSlab; // y = 3 above the middle column
    const sky = new Uint8Array(sx * sz * h);
    computeLight(blocks, sx, h, sz, sky, new Uint8Array(sx * sz * h));
    expect(sky[(2 * sz + 1) * sx + 1]).toBeLessThan(15);
  });

  it('approximates light in the open and next to a torch in a sealed room', () => {
    const open = world([]);
    expect(approxLight(open.get, 0, 5, 0)).toBe(15);
    const room: [number, number, number, number][] = [];
    for (let x = -3; x <= 3; x++) for (let y = 0; y <= 6; y++) for (let z = -3; z <= 3; z++) {
      if (Math.max(Math.abs(x), Math.abs(z)) === 3 || y === 0 || y === 6) room.push([x, y, z, Block.Stone]);
    }
    room.push([0, 1, 0, Block.Torch]);
    const w = world(room);
    const l = approxLight(w.get, 1, 1, 0);
    expect(l).toBeGreaterThan(0);
    expect(l).toBeLessThanOrEqual(14);
  });
});

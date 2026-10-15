import { describe, expect, it } from 'vitest';
import { Block, changesLight, computeLight, LIGHT_EMISSION, MAX_LIGHT } from '../src';

/** A small box of blocks in chunk layout (x fastest, then z, then y). */
function box(sx: number, h: number, sz: number) {
  const blocks = new Uint8Array(sx * h * sz);
  const sky = new Uint8Array(blocks.length);
  const block = new Uint8Array(blocks.length);
  const at = (x: number, y: number, z: number) => (y * sz + z) * sx + x;
  const set = (x: number, y: number, z: number, id: number) => {
    blocks[at(x, y, z)] = id;
  };
  const fill = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number) => {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) set(x, y, z, id);
  };
  const light = () => computeLight(blocks, sx, h, sz, sky, block);
  return { blocks, sky, block, at, set, fill, light };
}

describe('light propagation', () => {
  it('lights open air with full sky light and no block light', () => {
    const w = box(8, 16, 8);
    w.light();
    expect(w.sky.every((v) => v === MAX_LIGHT)).toBe(true);
    expect(w.block.every((v) => v === 0)).toBe(true);
  });

  it('keeps a sealed cave completely dark', () => {
    const w = box(12, 12, 12);
    w.fill(0, 0, 0, 11, 8, 11, Block.Stone);
    w.fill(3, 2, 3, 8, 5, 8, Block.Air);
    w.light();
    for (let y = 2; y <= 5; y++) for (let z = 3; z <= 8; z++) for (let x = 3; x <= 8; x++) expect(w.sky[w.at(x, y, z)]).toBe(0);
    expect(w.sky[w.at(5, 9, 5)]).toBe(MAX_LIGHT); // above the rock
  });

  it('fades by one level per block away from a cave opening', () => {
    // A long tunnel under a roof with a skylight at x = 0.
    const w = box(24, 8, 3);
    w.fill(0, 0, 0, 23, 7, 2, Block.Stone);
    w.fill(0, 1, 1, 23, 2, 1, Block.Air);
    w.set(0, 3, 1, Block.Air);
    for (let y = 4; y < 8; y++) w.set(0, y, 1, Block.Air);
    w.light();
    expect(w.sky[w.at(0, 1, 1)]).toBe(MAX_LIGHT);
    for (let x = 0; x < 24; x++) expect(w.sky[w.at(x, 1, 1)]).toBe(Math.max(0, MAX_LIGHT - x));
  });

  it('lights the area around a lamp and fades to nothing 15 blocks away', () => {
    const w = box(40, 3, 3);
    w.set(5, 1, 1, Block.Lamp);
    w.light();
    expect(LIGHT_EMISSION[Block.Lamp]).toBe(15);
    expect(w.block[w.at(5, 1, 1)]).toBe(15);
    expect(w.block[w.at(6, 1, 1)]).toBe(14);
    expect(w.block[w.at(4, 1, 1)]).toBe(14);
    expect(w.block[w.at(5, 2, 1)]).toBe(14);
    expect(w.block[w.at(6, 2, 2)]).toBe(12);
    for (let x = 5; x < 40; x++) expect(w.block[w.at(x, 1, 1)]).toBe(Math.max(0, 15 - (x - 5)));
    expect(w.block[w.at(20, 1, 1)]).toBe(0);
    expect(w.block[w.at(39, 1, 1)]).toBe(0);
  });

  it('is stopped by opaque walls', () => {
    const w = box(20, 6, 6);
    w.fill(0, 0, 0, 19, 5, 5, Block.Stone);
    w.fill(1, 1, 1, 18, 4, 4, Block.Air); // sealed room
    w.fill(10, 1, 1, 10, 4, 4, Block.Brick); // dividing wall
    w.set(5, 2, 2, Block.Lamp);
    w.light();
    expect(w.block[w.at(9, 2, 2)]).toBe(11);
    for (let x = 11; x <= 18; x++) expect(w.block[w.at(x, 2, 2)]).toBe(0);
    expect(w.block[w.at(10, 2, 2)]).toBe(0);
    // Glass is not opaque.
    w.fill(10, 1, 1, 10, 4, 4, Block.Glass);
    w.light();
    expect(w.block[w.at(11, 2, 2)]).toBe(9);
  });

  it('dims faster through leaves and water', () => {
    // Sideways from a lamp: leaves cost one extra level per block.
    const w = box(24, 3, 3);
    w.set(2, 1, 1, Block.Lamp);
    w.fill(3, 0, 0, 23, 2, 2, Block.Leaves);
    w.light();
    for (let k = 1; k <= 7; k++) expect(w.block[w.at(2 + k, 1, 1)]).toBe(15 - 2 * k);
    expect(w.block[w.at(10, 1, 1)]).toBe(0);

    // Straight down through water: one level per block instead of none through air.
    const sea = box(3, 20, 3);
    sea.fill(0, 0, 0, 2, 2, 2, Block.Sand);
    sea.fill(0, 3, 0, 2, 12, 2, Block.Water);
    sea.light();
    expect(sea.sky[sea.at(1, 13, 1)]).toBe(15);
    expect(sea.sky[sea.at(1, 12, 1)]).toBe(14);
    expect(sea.sky[sea.at(1, 3, 1)]).toBe(5);
    expect(sea.sky[sea.at(1, 2, 1)]).toBe(0);
  });

  it('spreads sky light under an overhang', () => {
    const w = box(20, 10, 1);
    w.fill(0, 0, 0, 19, 0, 0, Block.Stone);
    w.fill(5, 4, 0, 19, 4, 0, Block.Stone); // roof from x = 5 onwards
    w.light();
    expect(w.sky[w.at(4, 2, 0)]).toBe(15);
    expect(w.sky[w.at(5, 2, 0)]).toBe(14);
    expect(w.sky[w.at(8, 1, 0)]).toBe(11);
    expect(w.sky[w.at(8, 5, 0)]).toBe(15); // on top of the roof
  });

  it('flags edits that change light', () => {
    expect(changesLight(Block.Air, Block.Stone)).toBe(true);
    expect(changesLight(Block.Stone, Block.Air)).toBe(true);
    expect(changesLight(Block.Air, Block.Lamp)).toBe(true);
    expect(changesLight(Block.Air, Block.Leaves)).toBe(true);
    expect(changesLight(Block.Air, Block.Glass)).toBe(false);
    expect(changesLight(Block.Stone, Block.Brick)).toBe(false);
  });

  it('lights a full 48x64x48 region quickly', () => {
    const sx = 48;
    const h = 64;
    const w = box(sx, h, sx);
    // Rolling ground with a cave layer and some leaves, so both passes do real work.
    for (let z = 0; z < sx; z++) {
      for (let x = 0; x < sx; x++) {
        const top = 28 + Math.round(4 * Math.sin(x / 5) * Math.cos(z / 7));
        w.fill(x, 0, z, x, top, z, Block.Stone);
        if ((x * 7 + z * 13) % 11 === 0) w.fill(x, top + 4, z, x, top + 6, z, Block.Leaves);
      }
    }
    w.fill(4, 10, 4, 43, 14, 43, Block.Air);
    w.fill(20, 15, 20, 21, 40, 21, Block.Air);
    w.set(30, 11, 30, Block.Lamp);
    w.light();
    const t0 = performance.now();
    const runs = 5;
    for (let i = 0; i < runs; i++) w.light();
    const ms = (performance.now() - t0) / runs;
    console.log(`[light] 48x64x48 region: ${ms.toFixed(2)} ms`);
    expect(w.sky[w.at(20, 12, 20)]).toBeGreaterThan(0);
    expect(w.block[w.at(31, 11, 30)]).toBe(14);
    expect(ms).toBeLessThan(40);
  });
});

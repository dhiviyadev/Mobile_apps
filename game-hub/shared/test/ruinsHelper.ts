/** Test helpers for the generator-4 ruins (structure set 2). The integrator's real generator 4 overrides structureOptions the same way. */
import { Block, blockIndex, TerrainGeneratorV3 } from '../src';
import type { LazyOptions } from '../src/voxel/structures/place';

export class RuinsGen extends TerrainGeneratorV3 {
  protected override structureOptions(): LazyOptions {
    return { structureSet: 2 };
  }
}

/** Block reader over generated chunks (generated on demand, kept). */
export function sampler(gen: { generateChunk(cx: number, cz: number): Uint8Array }) {
  const chunks = new Map<string, Uint8Array>();
  const get = (x: number, y: number, z: number) => {
    if (y < 0) return Block.Bedrock;
    if (y > 63) return Block.Air;
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16);
    const k = `${cx},${cz}`;
    let c = chunks.get(k);
    if (!c) chunks.set(k, (c = gen.generateChunk(cx, cz)));
    return c[blockIndex(x - cx * 16, y, z - cz * 16)];
  };
  return { get, chunks };
}

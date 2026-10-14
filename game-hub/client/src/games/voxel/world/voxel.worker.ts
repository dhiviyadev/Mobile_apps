/**
 * Voxel worker: generates terrain chunks and greedy-meshes them off the main
 * thread. Results are sent back as transferable typed arrays (zero copy).
 */
import { createWorldGenerator, type VoxelMode, type WorldGenerator } from '@hub/shared';
import { meshChunk } from '@hub/shared/voxel/mesher';

export type WorkerRequest =
  | { id: number; type: 'gen'; seed: number; mode: VoxelMode; cx: number; cz: number }
  | { id: number; type: 'mesh'; vol: Uint8Array };

let generator: WorldGenerator | null = null;
let generatorKey = '';

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'gen') {
      const key = `${msg.seed}:${msg.mode}`;
      if (key !== generatorKey) {
        generator = createWorldGenerator(msg.seed, msg.mode);
        generatorKey = key;
      }
      const blocks = generator!.generateChunk(msg.cx, msg.cz);
      self.postMessage({ id: msg.id, blocks }, { transfer: [blocks.buffer] });
    } else {
      const mesh = meshChunk(msg.vol);
      const transfer: ArrayBuffer[] = [];
      for (const part of [mesh.opaque, mesh.liquid]) {
        transfer.push(part.positions.buffer as ArrayBuffer, part.uvs.buffer as ArrayBuffer, part.tiles.buffer as ArrayBuffer, part.lights.buffer as ArrayBuffer, part.indices.buffer as ArrayBuffer);
      }
      self.postMessage({ id: msg.id, mesh }, { transfer });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err) });
  }
};

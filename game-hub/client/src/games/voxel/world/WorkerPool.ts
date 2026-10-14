/**
 * Small promise-based pool of voxel workers. Each worker accepts a couple of
 * jobs at a time so it is never idle while the main thread uploads results.
 */
import type { ChunkMesh } from '@hub/shared/voxel/mesher';
import type { VoxelMode } from '@hub/shared';

interface Slot {
  worker: Worker;
  busy: number;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class WorkerPool {
  private readonly slots: Slot[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  readonly maxPerWorker = 2;

  constructor(count: number) {
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./voxel.worker.ts', import.meta.url), { type: 'module', name: `voxel-${i}` });
      const slot: Slot = { worker, busy: 0 };
      worker.onmessage = (e: MessageEvent<{ id: number; error?: string }>) => {
        slot.busy--;
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve(e.data);
      };
      worker.onerror = (e) => console.error('[voxel worker]', e.message);
      this.slots.push(slot);
    }
  }

  /** Number of jobs that can be submitted right now without queueing inside a worker. */
  get capacity(): number {
    let c = 0;
    for (const s of this.slots) c += Math.max(0, this.maxPerWorker - s.busy);
    return c;
  }

  generate(seed: number, mode: VoxelMode, cx: number, cz: number): Promise<{ blocks: Uint8Array }> {
    return this.submit({ type: 'gen', seed, mode, cx, cz }, []);
  }

  mesh(vol: Uint8Array): Promise<{ mesh: ChunkMesh }> {
    return this.submit({ type: 'mesh', vol }, [vol.buffer as ArrayBuffer]);
  }

  dispose(): void {
    for (const s of this.slots) s.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('disposed'));
    this.pending.clear();
  }

  private submit<T>(msg: object, transfer: Transferable[]): Promise<T> {
    const slot = this.slots.reduce((a, b) => (b.busy < a.busy ? b : a));
    const id = this.nextId++;
    slot.busy++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      slot.worker.postMessage({ ...msg, id }, transfer);
    });
  }
}

export function defaultWorkerCount(): number {
  const cores = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(3, cores - 1));
}

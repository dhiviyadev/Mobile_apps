/**
 * Client-side voxel world: chunk storage, streaming around the player,
 * worker scheduling, edit overlay, and THREE mesh management.
 *
 * Chunks are generated from the seed in workers; player edits are kept in a
 * separate overlay map and re-applied whenever a chunk is (re)generated, so
 * unloading far chunks never loses changes.
 */
import * as THREE from 'three';
import {
  Block,
  blockIndex,
  CHUNK_HEIGHT,
  CHUNK_SIZE,
  chunkInWorld,
  chunkKey,
  toChunkCoord,
  toLocal,
  type VoxelMode,
} from '@hub/shared';
import {
  buildRegion,
  editTouchesBorder,
  isFluidOnlyChange,
  type MeshBuffers,
  neighbourNeedsRemesh,
  REGION_VOLUME,
  regionDistance,
  streamMeshRange,
  streamUnloadRange,
} from '@hub/shared/voxel/mesher';
import { WorkerPool } from './WorkerPool';

/**
 * Remesh priorities: an edited chunk first so the player sees the change at
 * once, then its neighbours, then chunks flowing water changed (rate limited,
 * see FLUID_REMESH_MS), then streaming (which also rebuilds light-only changes
 * from water).
 */
const PRIORITY_STREAM = 0;
const PRIORITY_FLUID = 1;
const PRIORITY_NEIGHBOUR = 2;
const PRIORITY_EDIT = 3;
/** A chunk changed only by flowing water is remeshed at most this often. */
const FLUID_REMESH_MS = 250;
/** Light of a cell whose chunk has no mesh yet: open sky (sky 15 << 4 | block 0). */
const OPEN_SKY_LIGHT = 0xf0;

interface Chunk {
  cx: number;
  cz: number;
  key: string;
  blocks: Uint8Array | null;
  generating: boolean;
  meshing: boolean;
  /** Needs a (re)mesh. */
  dirty: boolean;
  /** Bumped by every edit; lets us detect stale mesh results. */
  version: number;
  /** Edit-driven remeshes jump the streaming queue (PRIORITY_*). */
  priority: number;
  /** performance.now() when the last mesh job started. */
  meshedAt: number;
  opaque: THREE.Mesh | null;
  liquid: THREE.Mesh | null;
  /** Light of every cell from the last mesh (sky << 4 | block), for lighting the held block. */
  light: Uint8Array | null;
}

export interface WorldStats {
  chunks: number;
  meshed: number;
  pendingJobs: number;
}

const BOUNDS_SPHERE = new THREE.Sphere(new THREE.Vector3(CHUNK_SIZE / 2, CHUNK_HEIGHT / 2, CHUNK_SIZE / 2), Math.hypot(8, 32, 8) + 1);
const NEIGHBOURS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

export class World {
  readonly group = new THREE.Group();
  private readonly chunks = new Map<string, Chunk>();
  /** chunkKey -> (local block index -> block id) */
  private readonly edits = new Map<string, Map<number, number>>();
  private centerCx = 0;
  private centerCz = 0;
  private wanted: { cx: number; cz: number; d: number }[] = [];
  private wantedKey = '';
  private disposed = false;
  /** Region buffers handed back by workers, reused for the next mesh jobs. */
  private readonly spareRegions: Uint8Array[] = [];
  private readonly regionChunks: (Uint8Array | null)[] = new Array(9).fill(null);
  renderDistance = 4;

  constructor(
    private readonly pool: WorkerPool,
    readonly seed: number,
    readonly mode: VoxelMode,
    private readonly opaqueMaterial: THREE.Material,
    private readonly liquidMaterial: THREE.Material,
  ) {
    this.group.name = 'voxel-world';
  }

  // ---- block access -------------------------------------------------------------

  /** Block id at world coordinates. Unloaded chunks read as bedrock (solid). */
  getBlock = (x: number, y: number, z: number): number => {
    if (y < 0) return Block.Bedrock;
    if (y >= CHUNK_HEIGHT) return Block.Air;
    const c = this.chunks.get(chunkKey(toChunkCoord(x), toChunkCoord(z)));
    if (!c?.blocks) return Block.Bedrock;
    return c.blocks[blockIndex(toLocal(x), y, toLocal(z))];
  };

  isLoaded(x: number, z: number): boolean {
    return !!this.chunks.get(chunkKey(toChunkCoord(x), toChunkCoord(z)))?.blocks;
  }

  /**
   * Light at a block from the last mesh of its chunk, as sky << 4 | block
   * (0..15 each); open sky while the chunk has no mesh.
   */
  lightAt(x: number, y: number, z: number): number {
    if (y < 0) return 0;
    if (y >= CHUNK_HEIGHT) return OPEN_SKY_LIGHT;
    const light = this.chunks.get(chunkKey(toChunkCoord(x), toChunkCoord(z)))?.light;
    return light ? light[blockIndex(toLocal(x), y, toLocal(z))] : OPEN_SKY_LIGHT;
  }

  /** Sets a block, records it as an edit, and schedules remeshing. */
  setBlock(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= CHUNK_HEIGHT) return;
    this.recordEdit(x, y, z, id);
    this.applyBlock(x, y, z, id);
  }

  /**
   * Makes the edit overlay exactly `list`: the server's full edit list on
   * joining and after a reconnect. Cells that lost their edit meanwhile (such
   * as water that dried while we were away) go back to generated terrain:
   * their chunks are generated again, keeping the old blocks and mesh on show
   * until the new ones are ready.
   */
  replaceEdits(list: Iterable<[number, number, number, number]>): void {
    const before = new Map(this.edits);
    this.edits.clear();
    for (const [x, y, z, id] of list) if (y >= 0 && y < CHUNK_HEIGHT) this.recordEdit(x, y, z, id);
    for (const [key, cells] of before) {
      const now = this.edits.get(key);
      let lost = false;
      for (const idx of cells.keys()) {
        if (!now?.has(idx)) {
          lost = true;
          break;
        }
      }
      const c = lost ? this.chunks.get(key) : undefined;
      // Generating again applies the new overlay when the blocks arrive.
      if (c?.blocks && !c.generating) this.generate(c);
    }
    for (const [x, y, z, id] of this.allEdits()) this.applyBlock(x, y, z, id);
  }

  /** All edits as world coordinates (for saving offline worlds). */
  *allEdits(): Generator<[number, number, number, number]> {
    for (const [key, map] of this.edits) {
      const [cx, cz] = key.split(',').map(Number);
      for (const [idx, id] of map) {
        const x = idx % CHUNK_SIZE;
        const z = Math.floor(idx / CHUNK_SIZE) % CHUNK_SIZE;
        const y = Math.floor(idx / (CHUNK_SIZE * CHUNK_SIZE));
        yield [cx * CHUNK_SIZE + x, y, cz * CHUNK_SIZE + z, id];
      }
    }
  }

  // ---- streaming ------------------------------------------------------------------

  /** Call every frame with the player position. */
  update(px: number, pz: number): void {
    if (this.disposed) return;
    this.centerCx = toChunkCoord(px);
    this.centerCz = toChunkCoord(pz);
    const r = this.renderDistance;

    // Wanted chunks: meshes inside the render circle, block data for those and
    // the ring around them (each mesh is built from its 3x3 chunk region).
    // Rebuilt only when the player crosses a chunk border or the radius changes.
    const meshRange = streamMeshRange(r);
    const key = `${this.centerCx},${this.centerCz},${r}`;
    if (key !== this.wantedKey) {
      this.wantedKey = key;
      this.wanted = [];
      for (let dz = -r - 1; dz <= r + 1; dz++) {
        for (let dx = -r - 1; dx <= r + 1; dx++) {
          const cx = this.centerCx + dx;
          const cz = this.centerCz + dz;
          if (!chunkInWorld(cx, cz) || regionDistance(dx, dz) > meshRange) continue;
          this.wanted.push({ cx, cz, d: dx * dx + dz * dz });
        }
      }
      this.wanted.sort((a, b) => a.d - b.d);
    }
    const wanted = this.wanted;
    const busy = this.pool.capacity <= 0;
    const now = performance.now();

    // 1. Edit-driven remeshes first: edited chunks, then neighbours whose borders or light changed,
    //    then chunks flowing water changed. Chunks outside the render circle keep their flag until
    //    they come into range.
    let reserve: boolean | undefined;
    if (!busy) for (let p = PRIORITY_EDIT; p > PRIORITY_STREAM; p--) {
      for (const c of this.chunks.values()) {
        if (this.pool.capacity <= 0) break;
        if (c.priority !== p || !c.dirty || c.meshing) continue;
        if (p === PRIORITY_FLUID && now - c.meshedAt < FLUID_REMESH_MS) continue;
        const dx = c.cx - this.centerCx;
        const dz = c.cz - this.centerCz;
        if (dx * dx + dz * dz > meshRange || !this.neighboursReady(c)) continue;
        // Leave the last worker for streaming while terrain is missing (the player's own edits excepted).
        if (p < PRIORITY_EDIT && this.pool.capacity <= 1 && (reserve ??= this.streamingPending(meshRange))) break;
        this.mesh(c);
      }
    }
    // 2. Generate / mesh nearest-first.
    if (!busy) for (const w of wanted) {
      if (this.pool.capacity <= 0) break;
      const key = chunkKey(w.cx, w.cz);
      let c = this.chunks.get(key);
      if (!c) {
        c = { cx: w.cx, cz: w.cz, key, blocks: null, generating: false, meshing: false, dirty: true, version: 0, priority: PRIORITY_STREAM, meshedAt: 0, opaque: null, liquid: null, light: null };
        this.chunks.set(key, c);
      }
      if (!c.blocks && !c.generating) {
        this.generate(c);
        continue;
      }
      // Higher priorities are step 1's (it rate limits water); a recent mesh redone only for light waits too.
      if (c.priority !== PRIORITY_STREAM || ((c.opaque || c.liquid) && now - c.meshedAt < FLUID_REMESH_MS)) continue;
      const inMeshRange = w.d <= meshRange;
      if (inMeshRange && c.blocks && c.dirty && !c.meshing && this.neighboursReady(c)) this.mesh(c);
    }
    // 3. Unload chunks well past the wanted ring (the slack avoids reloading
    //    when walking back and forth), and hide those outside the render circle.
    const unload = streamUnloadRange(r);
    for (const c of this.chunks.values()) {
      const dx = c.cx - this.centerCx;
      const dz = c.cz - this.centerCz;
      if (regionDistance(dx, dz) > unload && !c.generating && !c.meshing) {
        this.disposeChunk(c);
        continue;
      }
      const vis = dx * dx + dz * dz <= meshRange;
      if (c.opaque) c.opaque.visible = vis;
      if (c.liquid) c.liquid.visible = vis;
    }
  }

  /** Fraction of chunks within `radius` of (px, pz) that have meshes (for loading screens). */
  readiness(px: number, pz: number, radius: number): number {
    const ccx = toChunkCoord(px);
    const ccz = toChunkCoord(pz);
    let total = 0;
    let ready = 0;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (!chunkInWorld(ccx + dx, ccz + dz)) continue;
        total++;
        const c = this.chunks.get(chunkKey(ccx + dx, ccz + dz));
        if (c?.blocks && !c.dirty) ready++;
      }
    }
    return total ? ready / total : 1;
  }

  stats(): WorldStats {
    let meshed = 0;
    for (const c of this.chunks.values()) if (c.opaque || c.liquid || (c.blocks && !c.dirty)) meshed++;
    return { chunks: this.chunks.size, meshed, pendingJobs: this.pool.maxPerWorker * 3 - this.pool.capacity };
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.chunks.values()) this.disposeChunk(c);
    this.chunks.clear();
    this.spareRegions.length = 0;
  }

  // ---- internals --------------------------------------------------------------------

  private recordEdit(x: number, y: number, z: number, id: number): void {
    const key = chunkKey(toChunkCoord(x), toChunkCoord(z));
    let e = this.edits.get(key);
    if (!e) this.edits.set(key, (e = new Map()));
    e.set(blockIndex(toLocal(x), y, toLocal(z)), id);
  }

  /** Writes a block into its loaded chunk (if any) and marks the meshes it changes. */
  private applyBlock(x: number, y: number, z: number, id: number): void {
    const cx = toChunkCoord(x);
    const cz = toChunkCoord(z);
    const lx = toLocal(x);
    const lz = toLocal(z);
    const c = this.chunks.get(chunkKey(cx, cz));
    let old: number | null = null; // unknown when the chunk is not loaded
    if (c?.blocks) {
      const idx = blockIndex(lx, y, lz);
      old = c.blocks[idx];
      // Server echoes of our own optimistic edits are no-ops: skip the remesh.
      if (old === id) return;
      c.blocks[idx] = id;
    }
    // Flowing water remeshes behind player edits and streaming; anything else jumps the queue.
    const fluid = isFluidOnlyChange(old, id);
    if (c?.blocks) this.markDirty(c, fluid ? PRIORITY_FLUID : PRIORITY_EDIT);
    // Neighbours whose border reads or light the edit can change.
    for (const [dx, dz] of NEIGHBOURS) {
      if (!neighbourNeedsRemesh(dx, dz, lx, lz, old, id)) continue;
      const priority = !fluid ? PRIORITY_NEIGHBOUR : editTouchesBorder(dx, dz, lx, lz) ? PRIORITY_FLUID : PRIORITY_STREAM;
      this.markDirtyAt(cx + dx, cz + dz, priority);
    }
  }

  /**
   * True while terrain near the player is still missing: a wanted chunk
   * without blocks, or one in mesh range that has never been meshed.
   */
  private streamingPending(meshRange: number): boolean {
    for (const w of this.wanted) {
      const c = this.chunks.get(chunkKey(w.cx, w.cz));
      if (!c || (!c.blocks && !c.generating)) return true;
      if (w.d <= meshRange && c.blocks && c.dirty && !c.meshing && !c.opaque && !c.liquid) return true;
    }
    return false;
  }

  private markDirtyAt(cx: number, cz: number, priority: number): void {
    const c = this.chunks.get(chunkKey(cx, cz));
    if (c?.blocks) this.markDirty(c, priority);
  }

  private markDirty(c: Chunk, priority: number): void {
    c.dirty = true;
    c.version++;
    if (priority > c.priority) c.priority = priority;
  }

  private neighboursReady(c: Chunk): boolean {
    for (const [dx, dz] of NEIGHBOURS) {
      const n = this.chunks.get(chunkKey(c.cx + dx, c.cz + dz));
      if (!chunkInWorld(c.cx + dx, c.cz + dz)) continue; // world edge: treated as air
      if (!n?.blocks) return false;
    }
    return true;
  }

  private generate(c: Chunk): void {
    c.generating = true;
    this.pool
      .generate(this.seed, this.mode, c.cx, c.cz)
      .then(({ blocks }) => {
        c.generating = false;
        if (this.disposed || this.chunks.get(c.key) !== c) return;
        const e = this.edits.get(c.key);
        if (e) for (const [idx, id] of e) blocks[idx] = id;
        c.blocks = blocks;
        c.dirty = true;
        // Neighbours that meshed against "missing" data must rebuild their borders.
        for (const [dx, dz] of NEIGHBOURS) {
          const n = this.chunks.get(chunkKey(c.cx + dx, c.cz + dz));
          if (n?.blocks && (n.opaque || n.liquid)) n.dirty = true;
        }
      })
      .catch(() => {
        c.generating = false;
      });
  }

  private mesh(c: Chunk): void {
    const region = this.regionFor(c);
    const version = c.version;
    c.meshing = true;
    c.dirty = false;
    c.priority = PRIORITY_STREAM;
    c.meshedAt = performance.now();
    this.pool
      .mesh(region)
      .then(({ mesh, region }) => {
        c.meshing = false;
        if (this.spareRegions.length < 8) this.spareRegions.push(region);
        if (this.disposed || this.chunks.get(c.key) !== c) return;
        if (c.version !== version) c.dirty = true; // edited meanwhile: mesh again, but show this one now
        c.opaque = this.applyMesh(c, c.opaque, mesh.opaque, this.opaqueMaterial, 0);
        c.liquid = this.applyMesh(c, c.liquid, mesh.liquid, this.liquidMaterial, 1);
        c.light = mesh.light;
      })
      .catch(() => {
        c.meshing = false;
        c.dirty = true;
      });
  }

  private applyMesh(c: Chunk, existing: THREE.Mesh | null, data: MeshBuffers, material: THREE.Material, order: number): THREE.Mesh | null {
    if (data.vertexCount === 0) {
      if (existing) {
        this.group.remove(existing);
        existing.geometry.dispose();
      }
      return null;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    geo.setAttribute('tile', new THREE.BufferAttribute(data.tiles, 2));
    geo.setAttribute('light', new THREE.BufferAttribute(data.lights, 4, true));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geo.boundingSphere = BOUNDS_SPHERE.clone();
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(CHUNK_SIZE, CHUNK_HEIGHT, CHUNK_SIZE));
    if (existing) {
      existing.geometry.dispose();
      existing.geometry = geo;
      return existing;
    }
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(c.cx * CHUNK_SIZE, 0, c.cz * CHUNK_SIZE);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.renderOrder = order;
    mesh.name = `chunk ${c.key}${order ? ' water' : ''}`;
    this.group.add(mesh);
    return mesh;
  }

  /** Copies the chunk and its 8 neighbours into a 48x64x48 region (a recycled buffer when one is free). */
  private regionFor(c: Chunk): Uint8Array {
    const n = this.regionChunks;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) n[(dz + 1) * 3 + dx + 1] = this.chunks.get(chunkKey(c.cx + dx, c.cz + dz))?.blocks ?? null;
    }
    const region = buildRegion(n, this.spareRegions.pop() ?? new Uint8Array(REGION_VOLUME));
    n.fill(null);
    return region;
  }

  private disposeChunk(c: Chunk): void {
    for (const m of [c.opaque, c.liquid]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
    c.opaque = c.liquid = null;
    c.light = null;
    this.chunks.delete(c.key);
  }
}

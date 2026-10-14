/**
 * Procedural parkour course: a chain of floating platforms above the sea,
 * with checkpoints every few jumps and a finish pad. Every jump is checked
 * against the player's movement limits so the course is always beatable.
 */
import { mulberry32 } from '../util/rng';
import { Block } from './blocks';
import { blockIndex, packPos } from './chunk';
import { CHUNK_HEIGHT, CHUNK_SIZE, CHUNK_VOLUME, SEA_LEVEL } from './constants';

export interface ParkourCourse {
  /** packPos(x, y, z) -> block id */
  blocks: Map<number, Block>;
  /** Feet position to spawn at. */
  start: { x: number; y: number; z: number };
  /** Checkpoint pad block positions; index 0 is the start pad. */
  checkpoints: { x: number; y: number; z: number }[];
  /** Finish pad block positions (any of them counts). */
  finish: { x: number; y: number; z: number }[];
  /** Falling below this Y sends the player back to the last checkpoint. */
  killY: number;
}

const COURSE_Y = 38;
const JUMPS = 44;
const CHECKPOINT_EVERY = 8;

/**
 * Max centre-to-centre horizontal distance for a jump that rises `dy` blocks.
 * Derived from the shared physics constants (jump ~1.25 blocks high, sprint
 * 5.6 b/s), with a margin so walking players on tablets can make the early part.
 */
export function maxJumpDistance(dy: number, sprint: boolean): number {
  if (dy >= 1) return sprint ? 3.2 : 2.6;
  if (dy === 0) return sprint ? 4.2 : 3.3;
  return sprint ? 4.8 : 3.8;
}

export function generateParkourCourse(seed: number): ParkourCourse {
  const rnd = mulberry32(seed ^ 0x51ed);
  const blocks = new Map<number, Block>();
  const put = (x: number, y: number, z: number, b: Block) => blocks.set(packPos(x, y, z), b);
  const pad = (cx: number, y: number, cz: number, r: number, b: Block, center?: Block) => {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) put(cx + dx, y, cz + dz, b);
    if (center !== undefined) put(cx, y, cz, center);
  };

  // Start pad.
  let x = 0;
  let y = COURSE_Y;
  let z = 0;
  pad(x, y, z, 2, Block.Cloud, Block.Checkpoint);
  const checkpoints = [{ x, y, z }];
  x += 3;
  let heading = 0; // radians around +X

  for (let i = 1; i <= JUMPS; i++) {
    const difficulty = i / JUMPS; // 0..1
    const isCheckpoint = i % CHECKPOINT_EVERY === 0;
    // Pick the vertical change, staying inside a comfortable band.
    let dy = rnd() < 0.45 ? 1 : rnd() < 0.7 ? 0 : -1;
    if (y + dy > CHUNK_HEIGHT - 8) dy = -1;
    if (y + dy < COURSE_Y - 6) dy = 1;
    if (isCheckpoint) dy = Math.min(dy, 0);
    const sprint = difficulty > 0.6;
    const maxD = maxJumpDistance(dy, sprint);
    const minD = 2;
    const d = Math.round(Math.min(maxD, minD + rnd() * (maxD - minD) * (0.5 + difficulty * 0.5)));
    // Wander left/right but keep heading roughly along +X.
    heading += (rnd() - 0.5) * 0.9;
    heading = Math.max(-0.9, Math.min(0.9, heading));
    const nx = x + Math.round(Math.cos(heading) * d);
    const nz = z + Math.round(Math.sin(heading) * d);
    // Rounding can stretch the jump; clamp back to the limit.
    const dist = Math.hypot(nx - x, nz - z);
    const ok = dist <= maxD + 0.01 && dist >= 1.5;
    x = ok ? nx : x + Math.min(d, Math.floor(maxD));
    z = ok ? nz : z;
    y += dy;

    if (isCheckpoint) {
      pad(x, y, z, 1, Block.Cloud, Block.Checkpoint);
      checkpoints.push({ x, y, z });
      x += 1;
    } else {
      const kind = rnd();
      if (kind < 0.55 - difficulty * 0.3) put(x, y, z, Block.Planks); // single block
      else if (kind < 0.8) {
        // 2x2 platform
        put(x, y, z, Block.Brick);
        put(x + 1, y, z, Block.Brick);
        put(x, y, z + 1, Block.Brick);
        put(x + 1, y, z + 1, Block.Brick);
        x += 1;
      } else {
        // narrow beam
        const len = 3 + Math.floor(rnd() * 3);
        for (let k = 0; k < len; k++) put(x + k, y, z, Block.Glass);
        x += len - 1;
      }
    }
  }

  // Finish pad.
  x += 3;
  pad(x + 1, y, z, 2, Block.Finish);
  const finish: ParkourCourse['finish'] = [];
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) finish.push({ x: x + 1 + dx, y, z: z + dz });

  // Decorative clouds drifting beside and below the course.
  for (let i = 0; i < 26; i++) {
    const cx = Math.floor(-10 + rnd() * (x + 20));
    const cz = Math.floor(-24 + rnd() * 48);
    if (Math.abs(cz) < 6) continue;
    const cy = SEA_LEVEL + 6 + Math.floor(rnd() * 10);
    const w = 3 + Math.floor(rnd() * 5);
    const dpt = 2 + Math.floor(rnd() * 3);
    for (let dz = 0; dz < dpt; dz++) for (let dx = 0; dx < w; dx++) if (rnd() < 0.85) put(cx + dx, cy, cz + dz, Block.Cloud);
  }

  return {
    blocks,
    start: { x: 0.5, y: COURSE_Y + 1, z: 0.5 },
    checkpoints,
    finish,
    killY: SEA_LEVEL + 4,
  };
}

/** Builds a parkour chunk: calm sea with a sandy floor, plus the course. */
export function generateParkourChunk(course: ParkourCourse, cx: number, cz: number, out: Uint8Array = new Uint8Array(CHUNK_VOLUME)): Uint8Array {
  out.fill(Block.Air);
  const floor = SEA_LEVEL - 8;
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      out[blockIndex(lx, 0, lz)] = Block.Bedrock;
      for (let y = 1; y <= floor; y++) out[blockIndex(lx, y, lz)] = Block.Sand;
      for (let y = floor + 1; y <= SEA_LEVEL; y++) out[blockIndex(lx, y, lz)] = Block.Water;
    }
  }
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  for (const [key, b] of course.blocks) {
    const y = key % 256;
    const rest = (key - y) / 256;
    const z = (rest % 65536) - 32768;
    const x = Math.floor(rest / 65536) - 32768;
    const lx = x - x0;
    const lz = z - z0;
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) continue;
    out[blockIndex(lx, y, lz)] = b;
  }
  return out;
}

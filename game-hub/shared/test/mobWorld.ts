/** Test fixtures for the creature sim: a flat block world, a host and scriptable players. */
import {
  applyDamage,
  Biome,
  Block,
  EntityWorld,
  OFFLINE_CAPS,
  rulesForMode,
  Team,
  type DamageOutcome,
  type DamageRequest,
  type EntityCaps,
  type EntityHost,
  type PlayerHooks,
  type PlayerTarget,
  type VoxelMode,
  type WorldGenerator,
} from '../src/index';

export const FLOOR = 10;

export class FlatBlocks {
  readonly edits = new Map<string, number>();
  constructor(
    public floor = FLOOR,
    public surface: number = Block.Grass,
  ) {}
  get = (x: number, y: number, z: number): number => {
    const e = this.edits.get(`${x},${y},${z}`);
    if (e !== undefined) return e;
    if (y < 0) return Block.Bedrock;
    if (y < this.floor - 1) return Block.Stone;
    if (y === this.floor - 1) return this.surface;
    return Block.Air;
  };
  set(x: number, y: number, z: number, id: number): void {
    this.edits.set(`${x},${y},${z}`, id);
  }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.set(x, y, z, id);
  }
}

export interface TestPlayer extends PlayerTarget {
  hits: { req: DamageRequest; res: DamageOutcome }[];
  health: number;
  held: string | null;
}

export function testPlayer(id: string, x: number, y: number, z: number, targetable = true): TestPlayer {
  return {
    id, eid: 1, name: id, x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0, crouching: false, sprinting: false,
    targetable, alive: true, halfWidth: 0.3, height: 1.8, blockingYaw: null, hits: [], health: 20, held: null,
  };
}

export interface TestSetup {
  blocks: FlatBlocks;
  world: EntityWorld;
  players: TestPlayer[];
  drops: { x: number; y: number; z: number; stacks: { item: string; count: number }[] }[];
  setBlocks: [number, number, number, number][];
  announced: string[];
  time: { value: number };
}

const flatGenerator = (biome: Biome, genVersion: 1 | 2 | 3 | 4 = 1): WorldGenerator => ({
  mode: 'survival',
  genVersion,
  radiusChunks: 32,
  limit: genVersion >= 3 ? 32000 : 512,
  course: null,
  generateChunk: () => new Uint8Array(0),
  findSpawn: () => ({ x: 0, y: FLOOR, z: 0 }),
  biomeAt: () => biome,
  surfaceHeight: () => FLOOR - 1,
  structures: () => [],
  structuresNear: () => [],
  structureAt: () => null,
});

export function setupWorld(opts: { mode?: VoxelMode; time?: number; caps?: Partial<EntityCaps>; biome?: Biome; seed?: number; blocks?: FlatBlocks; genVersion?: 1 | 2 | 3 | 4 } = {}): TestSetup {
  const blocks = opts.blocks ?? new FlatBlocks();
  const time = { value: opts.time ?? 0.5 };
  const drops: TestSetup['drops'] = [];
  const setBlocks: TestSetup['setBlocks'] = [];
  const announced: string[] = [];
  const host: EntityHost = {
    getBlock: blocks.get,
    isAvailable: () => true,
    generator: flatGenerator(opts.biome ?? Biome.Plains, opts.genVersion ?? 1),
    timeOfDay: () => time.value,
    setBlock: (x, y, z, id) => {
      setBlocks.push([x, y, z, id]);
      blocks.set(x, y, z, id);
    },
    announce: (t) => announced.push(t),
  };
  const mode = opts.mode ?? 'survival';
  const world = new EntityWorld(host, { seed: opts.seed ?? 7, rules: rulesForMode(mode), caps: { ...OFFLINE_CAPS, ...opts.caps } });
  const players: TestPlayer[] = [];
  const hooks: PlayerHooks = {
    playerTargets: () => players,
    damagePlayer: (id, req) => {
      const p = players.find((q) => q.id === id)!;
      const d = {
        ref: { type: 'player' as const, id }, team: Team.Player, x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, halfWidth: 0.3, height: 1.8,
        health: p.health, maxHealth: 20, armor: 0, knockbackResist: 0, hurtTime: 0, lastHurtAmount: 0, blockingYaw: p.blockingYaw, alive: true, effects: [],
      };
      const res = applyDamage(d, req);
      p.health = d.health;
      p.hits.push({ req, res });
      return res;
    },
    dropItems: (x, y, z, stacks) => void drops.push({ x, y, z, stacks: [...stacks] }),
    consumeHeld: (id, key) => players.find((q) => q.id === id)?.held === key,
    heldItem: (id) => players.find((q) => q.id === id)?.held ?? null,
    playerName: (id) => id,
  };
  world.setPlayerHooks(hooks);
  return { blocks, world, players, drops, setBlocks, announced, time };
}

export function run(w: EntityWorld, seconds: number, each?: () => void): void {
  for (let i = 0; i < Math.round(seconds * 20); i++) {
    w.step();
    each?.();
  }
}

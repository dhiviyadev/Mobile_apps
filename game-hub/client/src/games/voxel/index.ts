/**
 * Voxelvale entry point (lazy-loaded chunk). Offline worlds are saved to
 * localStorage (one world per saved mode); online play attaches the network layer.
 */
import { type GenVersion, isGenVersion, isVoxelMode, LATEST_GEN_VERSION, packPos, unpackPos, type VoxelMode } from '@hub/shared';
import type { GameInstance, GameLaunchContext } from '../types';
import { VoxelGame } from './VoxelGame';

/** Sandbox keeps the original key (old saves load unchanged); survival has its own world. */
const SAVE_KEYS: Partial<Record<VoxelMode, string>> = {
  sandbox: 'cobalt-hub.voxel.offline.v1',
  survival: 'cobalt-hub.voxel.offline.survival.v1',
};
const MAX_SAVED_EDITS = 60000;

interface OfflineSave {
  seed: number;
  edits: [number, number][];
  player: { x: number; y: number; z: number; yaw: number; pitch: number };
  time: number;
  /** Terrain generator version; missing = 1 (saves made before the world upgrade). */
  gen?: GenVersion;
  /** Tamed creatures (WP-C: { v: 1, list }). */
  mobs?: unknown;
  /** Survival state (WP-B: { v: 1, day, rules, vitals, spawn, inv, chests, satchels }). Survival key only. */
  survival?: unknown;
}

function loadSave(key: string): OfflineSave | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as OfflineSave) : null;
  } catch {
    return null;
  }
}

function writeSave(key: string, game: VoxelGame): void {
  const edits: [number, number][] = [];
  // Player edits only: water the simulation spread is rebuilt from its sources.
  for (const [x, y, z, id] of game.savedEdits()) {
    if (edits.length >= MAX_SAVED_EDITS) break;
    edits.push([packPos(x, y, z), id]);
  }
  const b = game.player.body;
  const save: OfflineSave = {
    seed: game.world.seed,
    edits,
    player: { x: b.x, y: b.y, z: b.z, yaw: game.player.yaw, pitch: game.player.pitch },
    time: game.sky.time,
    gen: game.generator.genVersion,
  };
  const mobs = game.localEntities?.saveData();
  if (mobs !== undefined) save.mobs = mobs;
  const survival = game.survival?.saveData();
  if (survival !== undefined) save.survival = survival;
  try {
    localStorage.setItem(key, JSON.stringify(save));
  } catch {
    /* storage full: keep playing */
  }
}

export async function launch(ctx: GameLaunchContext): Promise<GameInstance> {
  const mode: VoxelMode = isVoxelMode(ctx.mode) ? ctx.mode : 'sandbox';
  ctx.loading.set(0.32, 'Painting textures');

  if (ctx.session) {
    const { launchOnline } = await import('./net/online');
    return launchOnline(ctx, mode);
  }

  // Offline: sandbox and survival keep one persistent world each; parkour uses a fixed course seed.
  const key = SAVE_KEYS[mode];
  const save = key ? loadSave(key) : null;
  const seed = mode === 'parkour' ? 20251 : (save?.seed ?? ((Math.random() * 0xffffffff) >>> 0));
  let game: VoxelGame | null = null;
  const create = (fresh: boolean) =>
    new VoxelGame({
      container: ctx.container,
      seed: fresh ? (Math.random() * 0xffffffff) >>> 0 : seed,
      mode,
      loading: ctx.loading,
      onExit: (m) => ctx.exit(m),
      initialEdits: fresh ? [] : save?.edits.map(([k, id]) => [...unpackPos(k), id] as [number, number, number, number]),
      initialPlayer: fresh ? null : (save?.player ?? null),
      initialTime: fresh ? undefined : save?.time,
      // A save without `gen` predates the world upgrade: keep its terrain.
      genVersion: !fresh && save ? (isGenVersion(save.gen) ? save.gen : 1) : LATEST_GEN_VERSION,
      initialMobs: fresh ? undefined : save?.mobs,
      initialSurvival: fresh ? undefined : save?.survival,
      onSave: key ? (g) => writeSave(key, g) : undefined,
      onResetWorld: key
        ? () => {
            try {
              localStorage.removeItem(key);
            } catch {
              /* nothing saved */
            }
            ctx.exit('Started a fresh world. Open Voxelvale again to play it.');
          }
        : undefined,
    });
  game = create(false);
  await game.start();
  return { dispose: () => game?.dispose() };
}

/**
 * Voxelvale entry point (lazy-loaded chunk). Offline worlds are saved to
 * localStorage; online play attaches the network layer.
 */
import { isVoxelMode, packPos, unpackPos, type VoxelMode } from '@hub/shared';
import type { GameInstance, GameLaunchContext } from '../types';
import { VoxelGame } from './VoxelGame';

const SAVE_KEY = 'cobalt-hub.voxel.offline.v1';
const MAX_SAVED_EDITS = 60000;

interface OfflineSave {
  seed: number;
  edits: [number, number][];
  player: { x: number; y: number; z: number; yaw: number; pitch: number };
  time: number;
}

function loadSave(): OfflineSave | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? (JSON.parse(raw) as OfflineSave) : null;
  } catch {
    return null;
  }
}

function writeSave(game: VoxelGame): void {
  const edits: [number, number][] = [];
  for (const [x, y, z, id] of game.world.allEdits()) {
    if (edits.length >= MAX_SAVED_EDITS) break;
    edits.push([packPos(x, y, z), id]);
  }
  const b = game.player.body;
  const save: OfflineSave = {
    seed: game.world.seed,
    edits,
    player: { x: b.x, y: b.y, z: b.z, yaw: game.player.yaw, pitch: game.player.pitch },
    time: game.sky.time,
  };
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
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

  // Offline: sandbox keeps one persistent world; parkour uses a fixed course seed.
  const save = mode === 'sandbox' ? loadSave() : null;
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
      onSave: mode === 'sandbox' ? writeSave : undefined,
      onResetWorld:
        mode === 'sandbox'
          ? () => {
              localStorage.removeItem(SAVE_KEY);
              ctx.exit('Started a fresh world. Open Voxelvale again to play it.');
            }
          : undefined,
    });
  game = create(false);
  await game.start();
  return { dispose: () => game?.dispose() };
}

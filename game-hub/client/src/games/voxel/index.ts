/**
 * Voxelvale entry point (lazy-loaded chunk). Offline worlds come from the
 * device's world library (library/WorldLibrary.ts) and are saved back to it
 * while playing; parkour is a fixed course; online play attaches the network
 * layer (and, when hosting, uploads the world first: net/online.ts).
 */
import { isVoxelMode, type SavedWorld, type VoxelMode, type WorldMeta } from '@hub/shared';
import { toast } from '../../core/ui/overlays';
import { setPauseNote } from '../common/PauseMenu';
import type { GameInstance, GameLaunchContext } from '../types';
import { voxelLaunchData } from './launchData';
import { captureWorld, type CapturedWorld, openWorld } from './library/codec';
import { getLibrary } from './library/WorldLibrary';
import { VoxelGame } from './VoxelGame';
import { LEGACY_NOTE } from './world/WorldFeatures';

/** The running game's world in the library's terms. */
export function captureGame(game: VoxelGame, mode: VoxelMode): CapturedWorld {
  const b = game.player.body;
  const tp = game.teleport?.saveData();
  return {
    seed: game.world.seed,
    mode,
    genVersion: game.generator.genVersion,
    // Player edits only: water the simulation spread is rebuilt from its sources.
    edits: game.savedEdits(),
    player: { x: b.x, y: b.y, z: b.z, yaw: game.player.yaw, pitch: game.player.pitch },
    time: game.sky.time,
    survival: game.survival?.saveData(),
    mobs: game.localEntities ? (game.localEntities.saveData() ?? undefined) : null,
    places: tp?.places,
    autoDecline: tp?.autoDecline,
  };
}

export async function launch(ctx: GameLaunchContext): Promise<GameInstance> {
  const mode: VoxelMode = isVoxelMode(ctx.mode) ? ctx.mode : 'sandbox';
  ctx.loading.set(0.32, 'Painting textures');

  if (ctx.session) {
    const { launchOnline } = await import('./net/online');
    return launchOnline(ctx, mode);
  }

  if (mode === 'parkour') {
    // A fixed course; nothing is saved.
    const game = new VoxelGame({ container: ctx.container, seed: 20251, mode, loading: ctx.loading, onExit: (m) => ctx.exit(m) });
    await game.start();
    return { dispose: () => game.dispose() };
  }

  const { worldId } = voxelLaunchData(ctx);
  const lib = await getLibrary();
  const got = worldId ? await lib.load(worldId) : null;
  if (!worldId || !got) throw new Error('That world could not be found. It may have been deleted.');
  const opened = openWorld(got.world, lib.myKey);
  const w = opened.world;
  let current: SavedWorld = got.world;
  let meta: WorldMeta = { ...opened.meta, lastPlayed: Date.now() };
  let since = performance.now();
  let warned = false;

  const save = (game: VoxelGame) => {
    const now = performance.now();
    meta = { ...meta, lastPlayed: Date.now(), playtimeMs: meta.playtimeMs + Math.max(0, now - since) };
    since = now;
    current = captureWorld(current, captureGame(game, w.mode), lib.myKey, meta);
    lib.save(worldId, current).catch((err) => {
      console.error('[worlds] save failed', err);
      if (!warned) toast('Could not save this world: the device storage may be full. Export it to keep a copy.', 'error', 6000);
      warned = true;
    });
  };

  const game = new VoxelGame({
    container: ctx.container,
    seed: w.seed,
    mode: w.mode,
    loading: ctx.loading,
    onExit: (m) => ctx.exit(m),
    initialEdits: w.edits,
    initialPlayer: w.player,
    initialTime: w.time,
    genVersion: w.genVersion,
    initialMobs: w.mobs,
    initialSurvival: w.survival,
    initialPlaces: w.places,
    initialAutoDecline: w.autoDecline,
    onSave: save,
  });
  // Worlds saved before the biomes update keep their terrain; say so in the pause menu.
  setPauseNote(ctx.container, () => [`Saved on this device as "${meta.name}".`, game.generator.genVersion === 1 ? LEGACY_NOTE : null].filter(Boolean).join(' '));
  await game.start();
  save(game); // moves it to the top of the list right away
  return {
    dispose: () => {
      setPauseNote(ctx.container, null);
      game.dispose();
    },
  };
}

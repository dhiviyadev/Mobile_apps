/** Server entry point. */
import { config } from './config';
import { createGameServer } from './app';
import { logger } from './log';
import { isWorldOpen } from './rooms/VoxelRoom';
import { openWorldStore, setWorldStore } from './voxel/WorldStore';

const log = logger('server');
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Saved Voxelvale worlds. Falls back to memory (with a warning) if the data dir is unusable.
// Saves beyond the limits evict the least recently saved worlds that no open room holds.
const store = await openWorldStore({
  dir: config.dataDir,
  persist: config.persistWorlds,
  maxWorlds: config.maxSavedWorlds,
  maxMemoryBytes: config.maxMemoryWorldBytes,
  maxFileBytes: config.maxSavedWorldBytes,
  inUse: isWorldOpen,
});
setWorldStore(store);

async function pruneWorlds(): Promise<void> {
  try {
    // Worlds held by open rooms stay: they are saved again when their room closes.
    const removed = await store.prune(config.worldTtlDays * DAY_MS, config.maxSavedWorlds, isWorldOpen);
    if (removed > 0) log.info(`pruned ${removed} saved world(s)`);
  } catch (err) {
    log.warn('pruning saved worlds failed', err);
  }
}
await pruneWorlds();
setInterval(() => void pruneWorlds(), PRUNE_INTERVAL_MS).unref();

// SIGTERM/SIGINT dispose every room first; voxel rooms save their world as the shutdown starts and again while disposing.
const server = createGameServer();
await server.listen(config.port, config.host);
log.info(`listening on ws://${config.host}:${config.port}`);

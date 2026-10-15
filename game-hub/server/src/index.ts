/** Server entry point. */
import { config } from './config';
import { createGameServer } from './app';
import { logger } from './log';
import { openWorldStore, setWorldStore } from './voxel/WorldStore';

const log = logger('server');
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Saved Voxelvale worlds. Falls back to memory (with a warning) if the data dir is unusable.
const store = await openWorldStore({ dir: config.dataDir, persist: config.persistWorlds });
setWorldStore(store);

async function pruneWorlds(): Promise<void> {
  try {
    const removed = await store.prune(config.worldTtlDays * DAY_MS, config.maxSavedWorlds);
    if (removed > 0) log.info(`pruned ${removed} saved world(s)`);
  } catch (err) {
    log.warn('pruning saved worlds failed', err);
  }
}
await pruneWorlds();
setInterval(() => void pruneWorlds(), PRUNE_INTERVAL_MS).unref();

// SIGTERM/SIGINT dispose every room first, and voxel rooms save their world while disposing.
const server = createGameServer();
await server.listen(config.port, config.host);
log.info(`listening on ws://${config.host}:${config.port}`);

/** Runtime configuration, read from environment variables. */
import path from 'node:path';
import { DEFAULT_SERVER_PORT } from '@hub/shared';

/** Positive number from the environment, or the fallback when unset / invalid. */
function positive(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: Number(process.env.PORT ?? DEFAULT_SERVER_PORT),
  host: process.env.HOST ?? '0.0.0.0',
  /**
   * Comma separated list of origins allowed to call the REST endpoints,
   * e.g. "https://hub.example.com". "*" (default) allows any origin.
   */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Where saved Voxelvale worlds are written (<dataDir>/worlds). Relative paths resolve against the working directory. */
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  /** Save sandbox worlds to disk. "false" or "0" keeps them in memory only (lost on restart). */
  persistWorlds: !/^(false|0)$/i.test((process.env.PERSIST_WORLDS ?? '').trim()),
  /** Saved worlds not visited for this many days are deleted. */
  worldTtlDays: positive(process.env.WORLD_TTL_DAYS, 30),
  /** Upper bound on saved worlds; the least recently saved go first. */
  maxSavedWorlds: Math.floor(positive(process.env.MAX_SAVED_WORLDS, 500)),
};

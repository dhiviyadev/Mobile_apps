/** Runtime configuration, read from environment variables. */
import path from 'node:path';
import { DEFAULT_SERVER_PORT } from '@hub/shared';

/** Number of at least 1 from the environment, or the fallback when unset / invalid / smaller. */
function atLeastOne(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** Whole number of at least 0 from the environment, or the fallback when unset / invalid. */
function wholeNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
}

const MB = 1024 * 1024;

export const config = {
  port: Number(process.env.PORT ?? DEFAULT_SERVER_PORT),
  host: process.env.HOST ?? '0.0.0.0',
  /**
   * Comma separated list of origins allowed to call the REST endpoints,
   * e.g. "https://hub.example.com". "*" (default) allows any origin.
   */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Running on Fly.io (it sets FLY_APP_NAME): its proxy puts the real client address in Fly-Client-IP. */
  onFly: !!process.env.FLY_APP_NAME,
  /**
   * Reverse proxies in front of the server that each append the address they
   * received a request from to X-Forwarded-For (Render: 1). With 0 (default)
   * the TCP peer address is used. Never set it higher than the real number of
   * proxies: the entries further left are whatever the client sent.
   */
  trustProxyHops: wholeNumber(process.env.TRUST_PROXY_HOPS, 0),
  /** Where saved Voxelvale worlds are written (<dataDir>/worlds). Relative paths resolve against the working directory. */
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  /** Save sandbox worlds to disk. "false" or "0" keeps them in memory only (lost on restart). */
  persistWorlds: !/^(false|0)$/i.test((process.env.PERSIST_WORLDS ?? '').trim()),
  /** Saved worlds not visited for this many days are deleted (at least 1; players are told whole days). */
  worldTtlDays: atLeastOne(process.env.WORLD_TTL_DAYS, 30),
  /** Upper bound on saved worlds (at least 1); the least recently saved go first. */
  maxSavedWorlds: Math.floor(atLeastOne(process.env.MAX_SAVED_WORLDS, 500)),
  /** Bytes of saved worlds kept in memory when persistence is off (or the data dir is unusable). */
  maxMemoryWorldBytes: Math.floor(atLeastOne(process.env.MAX_MEMORY_WORLD_BYTES, 128 * MB)),
  /**
   * Bytes of world files kept in <dataDir>/worlds. The default leaves a 1 GB
   * volume room for the filesystem's own overhead and files being written.
   */
  maxSavedWorldBytes: Math.floor(atLeastOne(process.env.MAX_SAVED_WORLD_BYTES, 850 * MB)),
};

/**
 * Resolves the game server address.
 *
 * - VITE_SERVER_URL (build-time) wins, e.g. "wss://cobalt-hub.fly.dev".
 * - Otherwise use the page's hostname on port 2567, so a tablet on the same
 *   Wi-Fi as a dev machine running `npm run dev` connects automatically.
 * - `?server=` query param overrides both (handy for testing deployments).
 */
import { DEFAULT_SERVER_PORT } from '@hub/shared';

export function serverWsUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get('server');
  if (fromQuery) return fromQuery;
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv;
  const secure = location.protocol === 'https:';
  return `${secure ? 'wss' : 'ws'}://${location.hostname}:${DEFAULT_SERVER_PORT}`;
}

/** HTTP(S) base URL of the same server, for REST calls. */
export function serverHttpUrl(): string {
  return serverWsUrl().replace(/^ws/, 'http').replace(/\/$/, '');
}

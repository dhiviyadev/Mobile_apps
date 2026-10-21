/** REST helpers (room list / online counts) and waiting for a sleeping server. */
import type { RoomListResponse } from '@hub/shared';
import { hasGameServer, serverHttpUrl } from './serverUrl';

/** Longest a join waits for a sleeping server to start (free hosts take a minute or two). */
export const SERVER_WAKE_DEADLINE_MS = 180_000;

/** When the server last answered (performance.now()), or null if it never has. */
let lastContact: number | null = null;

/** True when the server answered a request within the last `withinMs`. */
export function serverSeenRecently(withinMs = 60_000): boolean {
  return lastContact !== null && performance.now() - lastContact < withinMs;
}

export async function fetchRooms(signal?: AbortSignal): Promise<RoomListResponse> {
  if (!hasGameServer()) throw new Error('no game server configured');
  const res = await fetch(`${serverHttpUrl()}/api/rooms`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`room list failed: ${res.status}`);
  const data = (await res.json()) as RoomListResponse;
  lastContact = performance.now();
  return data;
}

export interface WaitForServerOptions {
  signal?: AbortSignal;
  /** Called about once a second, with the seconds waited so far, once the first try has failed. */
  onWait?: (seconds: number) => void;
  deadlineMs?: number;
}

/**
 * Resolves once the server answers GET /health. Free hosting puts the server
 * to sleep when nobody plays; the next request wakes it, which takes a minute
 * or two, and until then requests hang or fail. Rejects with a player-facing
 * Error after the deadline, or with an AbortError when `signal` aborts.
 */
export async function waitForServer({ signal, onWait, deadlineMs = SERVER_WAKE_DEADLINE_MS }: WaitForServerOptions = {}): Promise<void> {
  const started = performance.now();
  const seconds = () => Math.round((performance.now() - started) / 1000);
  let ticker = 0;
  try {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(signal);
      const tryStart = performance.now();
      // An awake server answers well within the first timeout; a waking one may hold requests.
      if (await healthy(signal, attempt === 0 ? 4000 : 8000)) {
        lastContact = performance.now();
        return;
      }
      throwIfAborted(signal);
      if (attempt === 0 && onWait) {
        onWait(seconds());
        ticker = window.setInterval(() => onWait(seconds()), 1000);
      }
      if (performance.now() - started >= deadlineMs) {
        throw new Error("The game server didn't start. Try again in a minute, or play offline.");
      }
      // At most one try every 3 s: a host that is waking up may turn away bursts of requests.
      await delay(3000 - (performance.now() - tryStart), signal);
    }
  } finally {
    window.clearInterval(ticker);
  }
}

async function healthy(signal: AbortSignal | undefined, timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  const timer = window.setTimeout(stop, timeoutMs);
  signal?.addEventListener('abort', stop);
  try {
    const res = await fetch(`${serverHttpUrl()}/health`, { signal: ctrl.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      if (signal?.aborted) reject(abortError());
      else resolve();
    };
    const timer = window.setTimeout(done, Math.max(0, ms));
    signal?.addEventListener('abort', done);
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException('Cancelled', 'AbortError');
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

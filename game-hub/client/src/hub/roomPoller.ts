/**
 * Polls GET /api/rooms while the hub is visible and fans results out to views.
 */
import type { RoomListResponse } from '@hub/shared';
import { fetchRooms } from '../net/api';
import { hasGameServer } from '../net/serverUrl';

/** How long a server that stopped answering counts as starting up (free hosts take a minute or two to wake). */
export const WAKE_GRACE_MS = 180_000;
/**
 * Silence after which a free host may have put the server to sleep (Render: 15
 * minutes without traffic). Polling stops while a game runs or the tab is hidden.
 */
export const SLEEP_AFTER_MS = 10 * 60_000;

/** `waking`: the server stopped answering after a long silence, so it is probably starting up. */
export type RoomPollListener = (data: RoomListResponse | null, error: boolean, waking: boolean) => void;

export class RoomPoller {
  private timer = 0;
  private listeners = new Set<RoomPollListener>();
  private last: RoomListResponse | null = null;
  private lastError = false;
  private running = false;
  private inflight: AbortController | null = null;
  /** When the last poll that finished (not cancelled) started, or null before the first one. */
  private lastPollAt: number | null = null;
  /** When the current wake-up began, or null. */
  private wakeSince: number | null = null;

  constructor(private readonly intervalMs = 4000) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.running) void this.poll();
    });
  }

  subscribe(listener: RoomPollListener): () => void {
    this.listeners.add(listener);
    listener(this.last, this.lastError, this.waking());
    return () => this.listeners.delete(listener);
  }

  /** Latest result without subscribing. */
  snapshot(): { data: RoomListResponse | null; error: boolean; waking: boolean } {
    return { data: this.last, error: this.lastError, waking: this.waking() };
  }

  private waking(): boolean {
    return this.lastError && this.wakeSince !== null && hasGameServer() && performance.now() - this.wakeSince < WAKE_GRACE_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    window.clearTimeout(this.timer);
    this.inflight?.abort();
  }

  /** Forces an immediate refresh. */
  refresh(): void {
    if (this.running) void this.poll();
  }

  private async poll(): Promise<void> {
    window.clearTimeout(this.timer);
    this.inflight?.abort();
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const startedAt = performance.now();
    const quiet = this.lastPollAt === null || startedAt - this.lastPollAt > SLEEP_AFTER_MS;
    const timeout = window.setTimeout(() => ctrl.abort(), 3500);
    try {
      const data = await fetchRooms(ctrl.signal);
      if (this.inflight !== ctrl) return; // a newer poll reports instead
      this.lastPollAt = startedAt;
      this.last = data;
      this.lastError = false;
      this.wakeSince = null;
    } catch {
      // Cancelled by stop() or by a newer poll (only the timeout counts as a failure).
      if (this.inflight !== ctrl || (ctrl.signal.aborted && !this.running)) return;
      this.lastPollAt = startedAt;
      // Nobody may have reached the server for a long time: it is most likely waking up.
      if (quiet && this.wakeSince === null) this.wakeSince = startedAt;
      this.lastError = true;
    } finally {
      window.clearTimeout(timeout);
    }
    const waking = this.waking();
    for (const l of this.listeners) l(this.last, this.lastError, waking);
    if (this.running && document.visibilityState === 'visible') {
      this.timer = window.setTimeout(() => void this.poll(), this.intervalMs);
    }
  }
}

/**
 * Polls GET /api/rooms while the hub is visible and fans results out to views.
 */
import type { RoomListResponse } from '@hub/shared';
import { fetchRooms } from '../net/api';
import { hasGameServer } from '../net/serverUrl';

/** How long a server that has not answered yet counts as starting up (free hosts sleep when idle). */
export const WAKE_GRACE_MS = 90_000;

/** `waking`: the server has not answered since the hub opened, but may still be starting up. */
export type RoomPollListener = (data: RoomListResponse | null, error: boolean, waking: boolean) => void;

export class RoomPoller {
  private timer = 0;
  private listeners = new Set<RoomPollListener>();
  private last: RoomListResponse | null = null;
  private lastError = false;
  private running = false;
  private inflight: AbortController | null = null;
  private reached = false;
  private firstStart = 0;

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
    return this.lastError && !this.reached && hasGameServer() && performance.now() - this.firstStart < WAKE_GRACE_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.firstStart ||= performance.now();
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
    const timeout = window.setTimeout(() => ctrl.abort(), 3500);
    try {
      this.last = await fetchRooms(ctrl.signal);
      this.lastError = false;
      this.reached = true;
    } catch {
      if (ctrl.signal.aborted && !this.running) return;
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

/**
 * Polls GET /api/rooms while the hub is visible and fans results out to views.
 */
import type { RoomListResponse } from '@hub/shared';
import { fetchRooms } from '../net/api';

export type RoomPollListener = (data: RoomListResponse | null, error: boolean) => void;

export class RoomPoller {
  private timer = 0;
  private listeners = new Set<RoomPollListener>();
  private last: RoomListResponse | null = null;
  private lastError = false;
  private running = false;
  private inflight: AbortController | null = null;

  constructor(private readonly intervalMs = 4000) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.running) void this.poll();
    });
  }

  subscribe(listener: RoomPollListener): () => void {
    this.listeners.add(listener);
    listener(this.last, this.lastError);
    return () => this.listeners.delete(listener);
  }

  /** Latest result without subscribing. */
  snapshot(): { data: RoomListResponse | null; error: boolean } {
    return { data: this.last, error: this.lastError };
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
    const timeout = window.setTimeout(() => ctrl.abort(), 3500);
    try {
      this.last = await fetchRooms(ctrl.signal);
      this.lastError = false;
    } catch {
      if (ctrl.signal.aborted && !this.running) return;
      this.lastError = true;
    } finally {
      window.clearTimeout(timeout);
    }
    for (const l of this.listeners) l(this.last, this.lastError);
    if (this.running && document.visibilityState === 'visible') {
      this.timer = window.setTimeout(() => void this.poll(), this.intervalMs);
    }
  }
}

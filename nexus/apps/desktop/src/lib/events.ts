/** WebSocket client for the core event bus, with reconnect + backoff.
 * Both windows (main and floating mini) hold one of these; the backend is the
 * single source of truth, so they stay in sync without sharing memory. */
import { wsUrl } from "./api";

export interface BusEvent<T = unknown> {
  topic: string;
  ts?: string;
  data: T;
}

type Handler = (e: BusEvent) => void;
export type ConnState = "connecting" | "open" | "closed";

class EventStream {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private stateHandlers = new Set<(s: ConnState) => void>();
  private retry = 0;
  private timer: number | null = null;
  private ping: number | null = null;
  private stopped = false;
  state: ConnState = "closed";

  async connect(): Promise<void> {
    this.stopped = false;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.setState("connecting");
    let url: string;
    try {
      url = await wsUrl();
    } catch {
      this.schedule();
      return;
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setState("open");
      this.ping = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 25000);
    };
    ws.onmessage = (m) => {
      try {
        this.dispatch(JSON.parse(m.data as string) as BusEvent);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      if (this.ping) window.clearInterval(this.ping);
      this.ws = null;
      this.setState("closed");
      if (!this.stopped) this.schedule();
    };
    ws.onerror = () => ws.close();
  }

  private schedule(): void {
    if (this.timer) return;
    const delay = Math.min(15000, 500 * 2 ** this.retry++);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }

  reconnectNow(): void {
    this.retry = 0;
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.ws?.close();
    void this.connect();
  }

  close(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private setState(s: ConnState): void {
    this.state = s;
    this.stateHandlers.forEach((h) => h(s));
  }

  onState(h: (s: ConnState) => void): () => void {
    this.stateHandlers.add(h);
    return () => this.stateHandlers.delete(h);
  }

  /** Subscribe to a topic ("task.event"), a prefix ("task"), or "*" for everything. */
  on<T = unknown>(topic: string, handler: (e: BusEvent<T>) => void): () => void {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler as Handler);
    this.handlers.set(topic, set);
    return () => set.delete(handler as Handler);
  }

  private dispatch(e: BusEvent): void {
    const prefix = e.topic.split(".")[0] ?? "";
    for (const key of [e.topic, prefix, "*"]) this.handlers.get(key)?.forEach((h) => h(e));
  }
}

export const bus = new EventStream();

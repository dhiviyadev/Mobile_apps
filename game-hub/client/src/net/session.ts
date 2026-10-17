/**
 * NetSession: a Colyseus room connection that survives network drops.
 *
 * The Colyseus SDK reconnects a dropped room by itself (same Room object, so
 * handlers stay attached); the session turns that into a status for the UI,
 * tunes the retries to the server's reconnection window, buffers messages
 * that arrive before a handler is registered (the game bundle is lazy-loaded
 * *after* joining), measures ping, and keeps a resume token so a reloaded
 * page (iOS Safari) can rejoin its seat.
 *
 * The SDK is imported dynamically so the hub's first paint doesn't pay for it.
 */
import type { Client, Room } from '@colyseus/sdk';
import { CLOSE_KICKED, type GameId, type JoinOptions, RECONNECT_WINDOW_SECONDS, REVIVE_ERRORS } from '@hub/shared';
import { serverWsUrl } from './serverUrl';

export type JoinRequest =
  | { kind: 'quick'; game: GameId; options: JoinOptions }
  | { kind: 'create'; game: GameId; options: JoinOptions }
  /** `game` is set when the code is known to belong to that game (room list); saved worlds only reopen for voxel. */
  | { kind: 'code'; code: string; options: JoinOptions; game?: GameId }
  | { kind: 'resume'; token: string };

type CodeRequest = Extract<JoinRequest, { kind: 'code' }>;

export type SessionStatus = 'connected' | 'reconnecting' | 'closed';
export type CloseReason = 'left' | 'lost' | 'kicked' | 'room-closed';

type MessageHandler = (message: any) => void;

const RESUME_KEY = 'cobalt-hub.resume';
/** Colyseus close codes: the server ended our seat (client.leave()) / is shutting down. */
const CLOSE_CONSENTED = 4000;
const CLOSE_SERVER_SHUTDOWN = 4001;

async function createClient(): Promise<Client> {
  const { Client } = await import('@colyseus/sdk');
  return new Client(serverWsUrl());
}

/**
 * Automatic reconnection settings: keep retrying (backing off to 4 s) for
 * about as long as the server holds a dropped player's seat, also for drops
 * soon after joining.
 */
function tuneReconnection(room: Room): void {
  const r = room.reconnection;
  r.maxDelay = 4000;
  r.minUptime = 1000;
  // ~6 s of quick retries, then one every maxDelay until the seat is gone.
  r.maxRetries = 6 + Math.ceil(Math.max(0, RECONNECT_WINDOW_SECONDS * 1000 - 6000) / r.maxDelay);
}

export class NetSession {
  private handlers = new Map<string | number, Set<MessageHandler>>();
  private buffered = new Map<string | number, unknown[]>();
  private stateListeners = new Set<(state: any) => void>();
  private statusListeners = new Set<(status: SessionStatus, detail?: number | CloseReason) => void>();
  private boundTypes = new Set<string | number>();
  private leaving = false;
  private pingTimer = 0;
  /** Polls the SDK's retry count while reconnecting, for the banner. */
  private retryTimer = 0;
  private _status: SessionStatus = 'connected';
  /** Smoothed round-trip time in milliseconds. */
  ping = 0;

  private constructor(private readonly room: Room) {
    this.bind(room);
  }

  /** Joins or creates a room. Throws a user-presentable Error on failure. */
  static async connect(req: JoinRequest): Promise<NetSession> {
    const client = await createClient();
    let room: Room;
    try {
      switch (req.kind) {
        case 'quick':
          room = await client.joinOrCreate(req.game, req.options);
          break;
        case 'create':
          room = await client.create(req.game, { ...req.options, private: true });
          break;
        case 'code':
          room = await joinByCode(client, req);
          break;
        case 'resume':
          room = await client.reconnect(req.token);
          break;
      }
    } catch (err) {
      throw new Error(describeJoinError(err, req));
    }
    return new NetSession(room);
  }

  // ---- accessors --------------------------------------------------------------

  get roomId(): string {
    return this.room.roomId;
  }
  get sessionId(): string {
    return this.room.sessionId;
  }
  /** Game id (= Colyseus room name). */
  get game(): GameId {
    return this.room.name as GameId;
  }
  /** Current replicated state. */
  get state(): any {
    return this.room.state;
  }
  get status(): SessionStatus {
    return this._status;
  }

  // ---- messaging -------------------------------------------------------------

  send(type: string | number, message?: unknown): void {
    if (this._status === 'connected') this.room.send(type, message);
  }

  sendBytes(type: string | number, bytes: Uint8Array): void {
    if (this._status === 'connected') this.room.sendBytes(type, bytes);
  }

  /** Registers a message handler; returns an unsubscribe function. */
  onMessage<T = any>(type: string | number, handler: (message: T) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as MessageHandler);
    this.bindType(this.room, type);
    // Deliver anything that arrived before the game was ready.
    const pending = this.buffered.get(type);
    if (pending) {
      this.buffered.delete(type);
      for (const m of pending) (handler as MessageHandler)(m);
    }
    return () => set!.delete(handler as MessageHandler);
  }

  onStateChange(listener: (state: any) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onStatus(listener: (status: SessionStatus, detail?: number | CloseReason) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Leaves on purpose (no reconnect attempts). */
  async leave(): Promise<void> {
    this.leaving = true;
    clearResumeToken();
    window.clearInterval(this.pingTimer);
    window.clearInterval(this.retryTimer);
    try {
      await this.room.leave(true);
    } catch {
      /* already closed */
    }
    this.setStatus('closed', 'left');
  }

  // ---- internals -------------------------------------------------------------

  private bind(room: Room): void {
    tuneReconnection(room);
    room.onStateChange((state) => {
      for (const l of this.stateListeners) l(state);
    });
    room.onDrop(() => this.handleDrop());
    room.onReconnect(() => this.handleReconnect());
    room.onLeave((code) => this.handleLeave(code));
    room.onError((code, message) => console.warn(`[net] room error ${code}: ${message}`));
    room.onMessage('pong', (sentAt: number) => {
      const rtt = performance.now() - sentAt;
      this.ping = this.ping === 0 ? rtt : this.ping * 0.7 + rtt * 0.3;
    });
    room.onMessage('*', (type: string | number, message: unknown) => {
      // No handler yet: keep a bounded backlog.
      let q = this.buffered.get(type);
      if (!q) this.buffered.set(type, (q = []));
      if (q.length < 256) q.push(message);
    });
    this.pingTimer = window.setInterval(() => {
      this.send('ping', performance.now());
      touchResumeToken();
    }, 2000);
    this.send('ping', performance.now());
    saveResumeToken(room);
  }

  private bindType(room: Room, type: string | number): void {
    if (this.boundTypes.has(type)) return;
    this.boundTypes.add(type);
    room.onMessage(type, (message: unknown) => {
      const set = this.handlers.get(type);
      if (set) for (const h of set) h(message);
    });
  }

  /** The SDK lost the connection and is retrying (same room, handlers stay attached). */
  private handleDrop(): void {
    if (this.leaving) return;
    let shown = 1;
    this.setStatus('reconnecting', shown);
    window.clearInterval(this.retryTimer);
    this.retryTimer = window.setInterval(() => {
      const attempt = Math.max(1, this.room.reconnection.retryCount);
      if (attempt !== shown && this._status === 'reconnecting') this.setStatus('reconnecting', (shown = attempt));
    }, 300);
  }

  private handleReconnect(): void {
    window.clearInterval(this.retryTimer);
    if (this.leaving) return;
    saveResumeToken(this.room); // the token changes with every connection
    this.setStatus('connected');
    this.send('ping', performance.now());
  }

  /** The room is gone for good: left, kicked, closed, or reconnecting gave up. */
  private handleLeave(code: number): void {
    window.clearInterval(this.pingTimer);
    window.clearInterval(this.retryTimer);
    if (this.leaving) return;
    clearResumeToken();
    const reason: CloseReason =
      code === CLOSE_KICKED ? 'kicked' : code === CLOSE_CONSENTED || code === CLOSE_SERVER_SHUTDOWN ? 'room-closed' : 'lost';
    this.setStatus('closed', reason);
  }

  private setStatus(status: SessionStatus, detail?: number | CloseReason): void {
    this._status = status;
    for (const l of this.statusListeners) l(status, detail);
  }
}

// ---- helpers -------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const NOT_FOUND = /not found|no rooms found|not exist/i;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Joins the open room with this code. When none is open the code may belong
 * to a saved Voxelvale world, so ask the server to reopen it.
 * Exported for tests.
 */
export async function joinByCode(client: Pick<Client, 'joinById' | 'create'>, req: CodeRequest): Promise<Room> {
  const canRevive = req.game === undefined || req.game === 'voxel';
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.joinById(req.code, req.options);
    } catch (err) {
      if (!canRevive || !NOT_FOUND.test(errorMessage(err))) throw err;
    }
    let room: Room;
    try {
      // private: a server too old to know reviveCode at least makes a hidden room (left again below).
      room = await client.create('voxel', { ...req.options, private: true, reviveCode: req.code } satisfies JoinOptions);
    } catch (err) {
      // Someone reopened it a moment ago (or its last room is still closing): join that room instead.
      if (attempt > 0 || !errorMessage(err).includes(REVIVE_ERRORS.alreadyOpen)) throw err;
      await sleep(300);
      continue;
    }
    if (room.roomId === req.code.trim().toUpperCase()) return room;
    // The server ignored reviveCode and opened a brand-new world instead.
    await room.leave(true).catch(() => undefined);
    throw new Error(`${REVIVE_ERRORS.noSavedWorld}: the server cannot reopen saved worlds`);
  }
}

/** Turns a join failure into a message for players. Exported for tests. */
export function describeJoinError(err: unknown, req: JoinRequest): string {
  const msg = errorMessage(err);
  if (msg.includes(REVIVE_ERRORS.alreadyOpen)) return 'That world is just reopening. Try joining again in a moment.';
  if (msg.includes(REVIVE_ERRORS.tooManyAttempts)) return 'Too many tries with room codes. Wait a minute and try again.';
  if (msg.includes(REVIVE_ERRORS.noSavedWorld) || NOT_FOUND.test(msg)) {
    return req.kind === 'code' ? `No room with code ${req.code}. Check the code and try again.` : 'That room no longer exists.';
  }
  if (/locked|full|maxClients/i.test(msg)) return 'That room is full.';
  if (/Failed to fetch|NetworkError|ECONNREFUSED|Load failed|offline/i.test(msg)) {
    return 'Cannot reach the game server. Check your connection and try again.';
  }
  return msg || 'Could not join the room.';
}

interface ResumeInfo {
  token: string;
  game: string;
  at: number;
}

function saveResumeToken(room: Room): void {
  try {
    const info: ResumeInfo = { token: room.reconnectionToken, game: room.name, at: Date.now() };
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(info));
  } catch {
    /* ignore */
  }
}

function clearResumeToken(): void {
  try {
    sessionStorage.removeItem(RESUME_KEY);
  } catch {
    /* ignore */
  }
}

/** Returns a still-valid token if the page was reloaded mid-game (iOS likes to do that). */
export function pendingResume(): ResumeInfo | null {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    const info = JSON.parse(raw) as ResumeInfo;
    if (Date.now() - info.at > (RECONNECT_WINDOW_SECONDS - 3) * 1000) {
      clearResumeToken();
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

/** Keeps the resume timestamp fresh while connected. */
export function touchResumeToken(): void {
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (!raw) return;
    const info = JSON.parse(raw) as ResumeInfo;
    info.at = Date.now();
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(info));
  } catch {
    /* ignore */
  }
}

export { clearResumeToken };

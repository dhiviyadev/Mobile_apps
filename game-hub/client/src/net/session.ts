/**
 * NetSession: a Colyseus room connection that survives network drops.
 *
 * Game code talks to the session, never to the raw Room, because a reconnect
 * produces a brand-new Room object. The session re-binds every handler to the
 * new room, buffers messages that arrive before a handler is registered
 * (the game bundle is lazy-loaded *after* joining), and measures ping.
 *
 * colyseus.js is imported dynamically so the hub's first paint doesn't pay for it.
 */
import type { Client, Room } from 'colyseus.js';
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
const CLOSE_CONSENTED = 4000;
const CLOSE_DEVMODE_RESTART = 4010;

async function createClient(): Promise<Client> {
  const { Client } = await import('colyseus.js');
  return new Client(serverWsUrl());
}

export class NetSession {
  private handlers = new Map<string | number, Set<MessageHandler>>();
  private buffered = new Map<string | number, unknown[]>();
  private stateListeners = new Set<(state: any) => void>();
  private statusListeners = new Set<(status: SessionStatus, detail?: number | CloseReason) => void>();
  private boundTypes = new Set<string | number>();
  private leaving = false;
  private pingTimer = 0;
  private _status: SessionStatus = 'connected';
  /** Smoothed round-trip time in milliseconds. */
  ping = 0;

  private constructor(
    private readonly client: Client,
    private room: Room,
  ) {
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
    return new NetSession(client, room);
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
  /** Current replicated state. Re-read it after a reconnect; the object changes. */
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
    try {
      await this.room.leave(true);
    } catch {
      /* already closed */
    }
    this.setStatus('closed', 'left');
  }

  // ---- internals -------------------------------------------------------------

  private bind(room: Room): void {
    this.boundTypes.clear();
    room.onStateChange((state) => {
      for (const l of this.stateListeners) l(state);
    });
    room.onLeave((code) => void this.handleLeave(code));
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
    for (const type of this.handlers.keys()) this.bindType(room, type);
    window.clearInterval(this.pingTimer);
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

  private async handleLeave(code: number): Promise<void> {
    window.clearInterval(this.pingTimer);
    if (this.leaving) return;
    const recoverable = code < 4000 || code === CLOSE_DEVMODE_RESTART;
    if (!recoverable) {
      clearResumeToken();
      this.setStatus('closed', code === CLOSE_KICKED ? 'kicked' : code === CLOSE_CONSENTED ? 'room-closed' : 'lost');
      return;
    }
    const token = this.room.reconnectionToken;
    const deadline = performance.now() + (RECONNECT_WINDOW_SECONDS - 2) * 1000;
    let attempt = 0;
    while (!this.leaving && performance.now() < deadline) {
      attempt++;
      this.setStatus('reconnecting', attempt);
      if (navigator.onLine === false) await waitForOnline(4000);
      try {
        const room = await this.client.reconnect(token);
        this.room = room;
        this.bind(room);
        this.setStatus('connected');
        return;
      } catch {
        await sleep(Math.min(4000, 400 * 2 ** (attempt - 1)));
      }
    }
    if (!this.leaving) {
      clearResumeToken();
      this.setStatus('closed', 'lost');
    }
  }

  private setStatus(status: SessionStatus, detail?: number | CloseReason): void {
    this._status = status;
    for (const l of this.statusListeners) l(status, detail);
  }
}

// ---- helpers -------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

function waitForOnline(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('online', done);
      resolve();
    };
    window.addEventListener('online', done);
    window.setTimeout(done, timeoutMs);
  });
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for an SDK Room: handler lists plus helpers that replay the SDK's event order. */
class FakeRoom {
  roomId = 'K7PX2M';
  sessionId = 'sess1';
  name = 'voxel';
  state = { mode: 'sandbox' };
  reconnectionToken = 'K7PX2M:token-1';
  reconnection = { enabled: true, retryCount: 0, maxDelay: 5000, minUptime: 5000, maxRetries: 15 };
  sent: unknown[] = [];
  leaves: boolean[] = [];
  private handlers = new Map<string, ((...args: any[]) => void)[]>();

  private on(event: string) {
    return (cb: (...args: any[]) => void) => {
      if (!this.handlers.has(event)) this.handlers.set(event, []);
      this.handlers.get(event)!.push(cb);
    };
  }
  onStateChange = this.on('state');
  onDrop = this.on('drop');
  onReconnect = this.on('reconnect');
  onLeave = this.on('leave');
  onError = this.on('error');
  onMessage(type: string, cb: (...args: any[]) => void) {
    this.on(`msg:${type}`)(cb);
  }
  send(type: string, message: unknown) {
    this.sent.push([type, message]);
  }
  sendBytes() {}
  async leave(consented = true) {
    this.leaves.push(consented);
    return 4000;
  }

  emit(event: string, ...args: unknown[]) {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  /** As the SDK does: onReconnect handlers run first, then the new token is stored. */
  reconnect(token: string) {
    this.emit('reconnect');
    this.reconnectionToken = token;
  }
}

let room: FakeRoom;

vi.mock('@colyseus/sdk', () => ({
  Client: class {
    async joinOrCreate() {
      return room;
    }
  },
}));

const store = new Map<string, string>();
const resumeToken = () => JSON.parse(store.get('cobalt-hub.resume') ?? 'null') as { token: string; at: number } | null;

beforeEach(() => {
  vi.useFakeTimers();
  store.clear();
  room = new FakeRoom();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connect() {
  const { NetSession } = await import('../src/net/session');
  const session = await NetSession.connect({ kind: 'quick', game: 'voxel', options: { nickname: 'Kid' } });
  const statuses: [string, unknown][] = [];
  session.onStatus((status, detail) => statuses.push([status, detail]));
  return { session, statuses };
}

describe('NetSession with SDK reconnection', () => {
  it('tunes the SDK retries to the server seat window', async () => {
    await connect();
    expect(room.reconnection.minUptime).toBeLessThanOrEqual(1000);
    expect(room.reconnection.maxRetries * room.reconnection.maxDelay).toBeGreaterThanOrEqual(25_000);
  });

  it('saves the new resume token after an automatic reconnect', async () => {
    const { statuses } = await connect();
    expect(resumeToken()?.token).toBe('K7PX2M:token-1');
    room.emit('drop', 1006);
    room.reconnect('K7PX2M:token-2');
    await Promise.resolve();
    expect(resumeToken()?.token).toBe('K7PX2M:token-2');
    expect(statuses).toEqual([
      ['reconnecting', 1],
      ['connected', undefined],
    ]);
  });

  it('shows one banner per drop and counts the SDK retries', async () => {
    const { statuses } = await connect();
    room.emit('drop', 1006);
    room.reconnection.retryCount = 2;
    room.emit('drop', 1006); // a failed retry is reported as another drop
    vi.advanceTimersByTime(350);
    room.reconnection.retryCount = 3;
    vi.advanceTimersByTime(350);
    expect(statuses).toEqual([
      ['reconnecting', 1],
      ['reconnecting', 2],
      ['reconnecting', 3],
    ]);
  });

  it('refreshes the resume timestamp only while connected', async () => {
    await connect();
    vi.advanceTimersByTime(2100);
    const connectedAt = resumeToken()!.at;
    room.emit('drop', 1006);
    vi.advanceTimersByTime(6000);
    expect(resumeToken()!.at).toBe(connectedAt);
  });

  it('leaving while reconnecting stops retrying and gives back a seat that comes back anyway', async () => {
    const { session, statuses } = await connect();
    room.emit('drop', 1006);
    await session.leave(); // must not wait for a LEAVE frame the dead socket cannot send
    expect(room.reconnection.enabled).toBe(false);
    expect(room.leaves).toEqual([]);
    expect(resumeToken()).toBeNull();
    expect(statuses.at(-1)).toEqual(['closed', 'left']);
    // A retry that was already scheduled still lands: leave the room right away.
    room.reconnect('K7PX2M:token-2');
    expect(room.leaves).toEqual([true]);
    await Promise.resolve();
    expect(resumeToken()).toBeNull();
  });

  it('maps final close codes to reasons', async () => {
    const reasons: unknown[] = [];
    for (const code of [4100, 4000, 4001, 4003]) {
      room = new FakeRoom();
      const { statuses } = await connect();
      room.emit('leave', code);
      reasons.push(statuses.at(-1)?.[1]);
    }
    expect(reasons).toEqual(['kicked', 'room-closed', 'room-closed', 'lost']);
  });
});

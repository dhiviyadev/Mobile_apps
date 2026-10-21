import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchRooms = vi.fn();
vi.mock('../src/net/api', () => ({ fetchRooms: (signal?: AbortSignal) => fetchRooms(signal) }));
vi.mock('../src/net/serverUrl', () => ({ hasGameServer: () => true }));

const ROOMS = { rooms: [], online: { voxel: 0, arena: 0 } };

beforeEach(() => {
  vi.useFakeTimers();
  fetchRooms.mockReset();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function poller() {
  const { RoomPoller, WAKE_GRACE_MS } = await import('../src/hub/roomPoller');
  const p = new RoomPoller(4000);
  const seen: boolean[] = [];
  p.subscribe((_data, _error, waking) => seen.push(waking));
  return { p, seen, WAKE_GRACE_MS };
}

describe('RoomPoller waking state', () => {
  it('reports a sleeping server as waking, then offline once the grace period ends', async () => {
    fetchRooms.mockRejectedValue(new Error('unreachable'));
    const { p, WAKE_GRACE_MS } = await poller();
    p.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.snapshot()).toMatchObject({ error: true, waking: true });
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);
    expect(p.snapshot()).toMatchObject({ error: true, waking: false });
    p.stop();
  });

  it('stops waking as soon as the server answers', async () => {
    fetchRooms.mockRejectedValueOnce(new Error('unreachable')).mockResolvedValueOnce(ROOMS);
    const { p, seen } = await poller();
    p.start();
    await vi.advanceTimersByTimeAsync(4010);
    expect(p.snapshot()).toMatchObject({ error: false, waking: false });
    expect(seen.slice(-2)).toEqual([true, false]);
    p.stop();
  });

  it('treats a server that answered once and then fails as offline, not waking', async () => {
    fetchRooms.mockResolvedValueOnce(ROOMS).mockRejectedValue(new Error('down'));
    const { p } = await poller();
    p.start();
    await vi.advanceTimersByTimeAsync(4010);
    expect(p.snapshot()).toMatchObject({ error: true, waking: false });
    p.stop();
  });
});

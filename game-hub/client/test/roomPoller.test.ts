import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchRooms = vi.fn();
vi.mock('../src/net/api', () => ({ fetchRooms: (signal?: AbortSignal) => fetchRooms(signal) }));
vi.mock('../src/net/serverUrl', () => ({ hasGameServer: () => true }));

const ROOMS = { rooms: [], online: { voxel: 0, arena: 0 } };
const down = () => Promise.reject(new Error('unreachable'));
/** A request a sleeping host holds open: settles only when aborted. */
const held = (signal?: AbortSignal) =>
  new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

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
  const { RoomPoller, WAKE_GRACE_MS, SLEEP_AFTER_MS } = await import('../src/hub/roomPoller');
  const p = new RoomPoller(4000);
  const seen: { error: boolean; waking: boolean }[] = [];
  p.subscribe((_data, error, waking) => seen.push({ error, waking }));
  seen.length = 0;
  return { p, seen, WAKE_GRACE_MS, SLEEP_AFTER_MS };
}

describe('RoomPoller waking state', () => {
  it('reports a sleeping server as waking, then offline once the grace period ends', async () => {
    fetchRooms.mockImplementation(held);
    const { p, WAKE_GRACE_MS } = await poller();
    p.start();
    await vi.advanceTimersByTimeAsync(3600); // the first poll times out
    expect(p.snapshot()).toMatchObject({ error: true, waking: true });
    await vi.advanceTimersByTimeAsync(WAKE_GRACE_MS);
    expect(p.snapshot()).toMatchObject({ error: true, waking: false });
    p.stop();
  });

  it('stops waking as soon as the server answers', async () => {
    fetchRooms.mockImplementationOnce(down).mockResolvedValueOnce(ROOMS);
    const { p, seen } = await poller();
    p.start();
    await vi.advanceTimersByTimeAsync(4010);
    expect(p.snapshot()).toMatchObject({ error: false, waking: false });
    expect(seen).toEqual([
      { error: true, waking: true },
      { error: false, waking: false },
    ]);
    p.stop();
  });

  it('treats a server that fails while it is being polled as offline, not waking', async () => {
    fetchRooms.mockResolvedValueOnce(ROOMS).mockImplementation(down);
    const { p } = await poller();
    p.start();
    await vi.advanceTimersByTimeAsync(4010);
    expect(p.snapshot()).toMatchObject({ error: true, waking: false });
    p.stop();
  });

  it('expects the server to be waking again after a long pause in polling', async () => {
    fetchRooms.mockResolvedValueOnce(ROOMS).mockImplementation(down);
    const { p, SLEEP_AFTER_MS } = await poller();
    p.start();
    await vi.advanceTimersByTimeAsync(10);
    p.stop(); // an offline game, or a hidden tab
    await vi.advanceTimersByTimeAsync(SLEEP_AFTER_MS + 60_000);
    p.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(p.snapshot()).toMatchObject({ error: true, waking: true });
    p.stop();
  });

  it('still expects a wake-up when a refresh replaces the first poll after a pause', async () => {
    fetchRooms.mockImplementation(held);
    const { p, seen } = await poller();
    p.start();
    await vi.advanceTimersByTimeAsync(1000);
    p.refresh(); // a game card was opened
    await vi.advanceTimersByTimeAsync(3600);
    expect(seen).toEqual([{ error: true, waking: true }]);
    p.stop();
  });

  it('does not report a poll replaced by a refresh as an error', async () => {
    fetchRooms.mockResolvedValueOnce(ROOMS).mockImplementationOnce(held).mockResolvedValue(ROOMS);
    const { p, seen } = await poller();
    p.start();
    await vi.advanceTimersByTimeAsync(4010); // second poll is in flight
    p.refresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(seen.every((s) => !s.error)).toBe(true);
    expect(seen).toHaveLength(2);
    p.stop();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/net/serverUrl', () => ({ hasGameServer: () => true, serverHttpUrl: () => 'https://hub.example' }));

const fetchMock = vi.fn();
const ok = () => Promise.resolve({ ok: true, json: async () => ({ rooms: [], online: { voxel: 0, arena: 0 } }) });
const asleep = () => Promise.resolve({ ok: false, status: 503 });
const held = (_url: string, init?: RequestInit) =>
  new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const api = () => import('../src/net/api');

describe('waitForServer', () => {
  it('returns at once when the server is awake, without reporting a wait', async () => {
    fetchMock.mockImplementation(ok);
    const { waitForServer, serverSeenRecently } = await api();
    const onWait = vi.fn();
    expect(serverSeenRecently()).toBe(false);
    await waitForServer({ onWait });
    expect(onWait).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('https://hub.example/health', expect.anything());
    expect(serverSeenRecently()).toBe(true);
  });

  it('keeps trying a waking server, reporting the wait, until it answers', async () => {
    fetchMock.mockImplementationOnce(held).mockImplementationOnce(asleep).mockImplementationOnce(held).mockImplementation(ok);
    const { waitForServer } = await api();
    const waits: number[] = [];
    let done = false;
    void waitForServer({ onWait: (s) => waits.push(s) }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4000); // first try held until its timeout
    expect(waits).toEqual([4]);
    await vi.advanceTimersByTimeAsync(3000); // second try refused at once
    await vi.advanceTimersByTimeAsync(8000); // third held until its timeout
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(done).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(waits.at(-1)).toBeGreaterThanOrEqual(14);
  });

  it('never tries more than once every 3 s against a host that refuses at once', async () => {
    fetchMock.mockImplementation(asleep);
    const { waitForServer } = await api();
    const wait = waitForServer({ deadlineMs: 60_000 }).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(11);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(((await wait) as Error).message).toMatch(/didn't start/);
  });

  it('gives up after the deadline with a message for players', async () => {
    fetchMock.mockImplementation(held);
    const { waitForServer, SERVER_WAKE_DEADLINE_MS } = await api();
    const wait = waitForServer().catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(SERVER_WAKE_DEADLINE_MS + 12_000);
    const err = (await wait) as Error;
    expect(err.message).toBe("The game server didn't start. Try again in a minute, or play offline.");
  });

  it('stops at once when cancelled, with an AbortError', async () => {
    fetchMock.mockImplementation(held);
    const { waitForServer, isAbortError } = await api();
    const cancel = new AbortController();
    const wait = waitForServer({ signal: cancel.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    cancel.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(isAbortError(await wait)).toBe(true);
    const calls = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});

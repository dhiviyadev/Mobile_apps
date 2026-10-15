import { beforeAll, describe, expect, it, vi } from 'vitest';
import { describeJoinError, joinByCode, type JoinRequest } from '../src/net/session';

type CodeRequest = Extract<JoinRequest, { kind: 'code' }>;

beforeAll(() => {
  // session.ts waits with window.setTimeout; these tests run in node.
  vi.stubGlobal('window', globalThis);
});

const options = { nickname: 'Kid' };
const request = (code: string, game?: 'voxel' | 'arena'): CodeRequest => ({ kind: 'code', code, options, game });
const fakeRoom = (roomId: string) => ({ roomId, leave: vi.fn(async () => 1000) });

/** A colyseus.js Client stand-in with scripted joinById / create results. */
function fakeClient() {
  const calls = { joinById: vi.fn(), create: vi.fn() };
  return { calls, client: calls as unknown as Parameters<typeof joinByCode>[0] };
}

const notFound = (code: string) => new Error(`room "${code}" not found`);

describe('joinByCode', () => {
  it('joins the open room without trying to reopen a saved world', async () => {
    const { calls, client } = fakeClient();
    const room = fakeRoom('K7PX2M');
    calls.joinById.mockResolvedValueOnce(room);
    expect(await joinByCode(client, request('K7PX2M'))).toBe(room);
    expect(calls.joinById).toHaveBeenCalledWith('K7PX2M', options);
    expect(calls.create).not.toHaveBeenCalled();
  });

  it('reopens a saved world when no room has the code', async () => {
    const { calls, client } = fakeClient();
    const room = fakeRoom('K7PX2M');
    calls.joinById.mockRejectedValueOnce(notFound('K7PX2M'));
    calls.create.mockResolvedValueOnce(room);
    expect(await joinByCode(client, request('K7PX2M'))).toBe(room);
    expect(calls.create).toHaveBeenCalledWith('voxel', { ...options, private: true, reviveCode: 'K7PX2M' });
  });

  it('joins by code again when the world is just reopening, but only once', async () => {
    const { calls, client } = fakeClient();
    const room = fakeRoom('K7PX2M');
    calls.joinById.mockRejectedValueOnce(notFound('K7PX2M')).mockResolvedValueOnce(room);
    calls.create.mockRejectedValueOnce(new Error('ROOM_ALREADY_OPEN: room K7PX2M is already open'));
    expect(await joinByCode(client, request('K7PX2M'))).toBe(room);
    expect(calls.joinById).toHaveBeenCalledTimes(2);

    const again = fakeClient();
    again.calls.joinById.mockRejectedValue(notFound('K7PX2M'));
    again.calls.create.mockRejectedValue(new Error('ROOM_ALREADY_OPEN: room K7PX2M is already open'));
    const err = await joinByCode(again.client, request('K7PX2M')).catch((e: unknown) => e);
    expect(again.calls.create).toHaveBeenCalledTimes(2);
    expect(describeJoinError(err, request('K7PX2M'))).toMatch(/just reopening/);
  });

  it('reports codes without a saved world as unknown', async () => {
    const { calls, client } = fakeClient();
    calls.joinById.mockRejectedValueOnce(notFound('ZZZZZZ'));
    calls.create.mockRejectedValueOnce(new Error('NO_SAVED_WORLD: no saved world with that code'));
    const err = await joinByCode(client, request('ZZZZZZ')).catch((e: unknown) => e);
    expect(describeJoinError(err, request('ZZZZZZ'))).toBe('No room with code ZZZZZZ. Check the code and try again.');
  });

  it('never tries to reopen codes from another game', async () => {
    const { calls, client } = fakeClient();
    calls.joinById.mockRejectedValueOnce(notFound('K7PX2M'));
    await expect(joinByCode(client, request('K7PX2M', 'arena'))).rejects.toThrow(/not found/);
    expect(calls.create).not.toHaveBeenCalled();
  });

  it('leaves a fresh world opened by a server that cannot reopen saved ones', async () => {
    const { calls, client } = fakeClient();
    const stranger = fakeRoom('QQQQQQ');
    calls.joinById.mockRejectedValueOnce(notFound('K7PX2M'));
    calls.create.mockResolvedValueOnce(stranger);
    const err = await joinByCode(client, request('k7px2m')).catch((e: unknown) => e);
    expect(stranger.leave).toHaveBeenCalled();
    expect(describeJoinError(err, request('K7PX2M'))).toMatch(/No room with code K7PX2M/);
  });

  it('explains rate limiting', () => {
    const err = new Error('TOO_MANY_REVIVES: too many attempts to reopen saved worlds');
    expect(describeJoinError(err, request('K7PX2M'))).toMatch(/Too many tries/);
  });
});

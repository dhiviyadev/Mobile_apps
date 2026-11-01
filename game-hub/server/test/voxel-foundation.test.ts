import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeEdits } from '@hub/shared';
import { playerKeyHash } from '../src/rooms/VoxelRoom';
import { decodeWorld, encodeWorld, isValidWorldId, type SavedWorld } from '../src/voxel/WorldStore';
import { startTestServer, type TestServer } from './helpers';

const world = (over: Partial<SavedWorld> = {}): SavedWorld => ({
  id: 'K7PX2M', seed: 7, mode: 'survival', private: true, timeOfDay: 0.25, savedAt: 1_700_000_000_000,
  edits: encodeEdits([{ x: 1, y: 2, z: 3, id: 4 }], true), ...over,
});

describe('CVW2 save format', () => {
  it('keeps format 1 while nothing needs more, and round-trips sections and genVersion', () => {
    expect(encodeWorld(world({ mode: 'sandbox' }))[4]).toBe(1);
    const sections = new Map([['PLYR', new Uint8Array([1, 0, 0])], ['ZZZZ', new Uint8Array([9])]]);
    const bytes = encodeWorld(world({ genVersion: 2, sections }));
    expect(bytes[4]).toBe(2);
    const back = decodeWorld('K7PX2M', bytes);
    expect(back.mode).toBe('survival');
    expect(back.genVersion).toBe(2);
    expect([...back.sections!.keys()]).toEqual(['PLYR', 'ZZZZ']);
    expect(() => decodeWorld('K7PX2M', bytes.subarray(0, bytes.length - 1))).toThrow();
    const trailing = new Uint8Array(bytes.length + 1);
    trailing.set(bytes);
    expect(() => decodeWorld('K7PX2M', trailing)).toThrow();
  });

  it('accepts survival slot ids and hashes player keys', () => {
    expect(isValidWorldId('survival-4')).toBe(true);
    expect(isValidWorldId('survival-5')).toBe(false);
    expect(playerKeyHash({ playerKey: 'abcdefghijklmnopqrstuv' })).toMatch(/^[0-9a-f]{32}$/);
    expect(playerKeyHash({ playerKey: 'short' })).toBeNull();
  });
});

describe('survival rooms', () => {
  let ts: TestServer;
  beforeAll(async () => {
    ts = await startTestServer();
  });
  afterAll(async () => {
    await ts.close();
  });

  it('refuses old clients in survival rooms too (arena WP0 gate)', async () => {
    await expect(ts.rawClient().create('voxel', { nickname: 'Old', mode: 'survival' })).rejects.toThrow(/CLIENT_OUTDATED/);
  });

  it('opens survival rooms with the new schema fields', async () => {
    const room = await ts.client().create('voxel', { nickname: 'Surv', mode: 'survival', private: true });
    await new Promise((r) => setTimeout(r, 150));
    const state = room.state as unknown as { mode: string; day: number; genVersion: number; players: Map<string, { hp: number }> };
    expect(state.mode).toBe('survival');
    expect(state.day).toBe(1);
    expect(state.genVersion).toBeGreaterThanOrEqual(1);
    await room.leave();
  });
});

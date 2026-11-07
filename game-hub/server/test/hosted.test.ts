/** Worlds hosted from a player's device (Package W): upload, play, saves back to the host, privacy, host leaving. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Room } from '@colyseus/sdk';
import {
  decodeEdits,
  decodePlayers,
  decodeWorld,
  decodeWorldMeta,
  encodeEdits,
  encodePlayers,
  encodeWorld,
  encodeWorldMeta,
  type HostReadyMsg,
  Item,
  REVIVE_ERRORS,
  type RoomListResponse,
  SECTION_TAGS,
  uploadChunks,
  VOXEL_MAX_PLAYERS,
  VoxelMsg,
  type SavedWorld,
} from '@hub/shared';
import { HOST_LEFT_TEXT, playerKeyHash, resetHostLimits } from '../src/rooms/VoxelRoom';
import { MemoryWorldStore } from '../src/voxel/WorldStore';
import { startTestServer, type TestServer, until, wait } from './helpers';

let ts: TestServer;
const store = new MemoryWorldStore();
beforeAll(async () => {
  ts = await startTestServer({ worldStore: store });
});
afterAll(async () => {
  await ts.close();
});

const HOST_KEY = 'hostkeyhostkeyhostkey1';
const GUEST_KEY = 'guestkeyguestkeyguest1';
const SEED = 909_090;

async function roomList(): Promise<RoomListResponse> {
  const res = await fetch(`http://127.0.0.1:${ts.port}/api/rooms`);
  return (await res.json()) as RoomListResponse;
}

/** A survival world as the library would write it, with a record for the guest holding 5 sticks. */
function worldFile(extra: Partial<SavedWorld> = {}): Uint8Array {
  const guest = playerKeyHash({ playerKey: GUEST_KEY })!;
  const sections = new Map<string, Uint8Array>([
    [SECTION_TAGS.players, encodePlayers([{ key: guest, lastSeen: Date.now(), saved: { x: 3.5, y: 60, z: 4.5, yaw: 0, pitch: 0, health: 17, food: 18, dead: false, spawn: null, slots: [[0, Item.Stick, 5, 0]] } }])],
    [SECTION_TAGS.meta, encodeWorldMeta({ name: 'Castle', createdAt: 1, lastPlayed: 2, playtimeMs: 3 })],
  ]);
  return encodeWorld({
    id: 'local', seed: SEED, mode: 'survival', private: true, timeOfDay: 0.4, savedAt: Date.now(), genVersion: 2,
    edits: encodeEdits([{ x: 2, y: 40, z: 2, id: 3 }], true), sections, ...extra,
  });
}

interface Host {
  room: Room;
  ready: HostReadyMsg | null;
  saves: Uint8Array[];
  worlds: number;
}

async function host(opts: { private?: boolean; hostCode?: string; file?: Uint8Array; upload?: boolean } = {}): Promise<Host> {
  resetHostLimits();
  const room = await ts.client().create('voxel', {
    nickname: 'Hosty', mode: 'survival', private: opts.private ?? true, host: true, worldName: 'Castle', hostCode: opts.hostCode, playerKey: HOST_KEY,
  });
  const h: Host = { room, ready: null, saves: [], worlds: 0 };
  room.onMessage(VoxelMsg.HostReady, (m: HostReadyMsg) => (h.ready = m));
  room.onMessage(VoxelMsg.HostSave, (b: Uint8Array) => h.saves.push(b));
  room.onMessage(VoxelMsg.World, () => h.worlds++);
  for (const t of [VoxelMsg.Edits, VoxelMsg.Chat, VoxelMsg.InvSync, VoxelMsg.Vitals, VoxelMsg.SurvivalEvents, 'N', 'V', VoxelMsg.HostClosed]) room.onMessage(t, () => {});
  if (opts.upload !== false) {
    for (const chunk of uploadChunks(opts.file ?? worldFile(), 1000)) room.sendBytes(VoxelMsg.HostUpload, chunk);
    await until(() => h.ready !== null, 5000);
  }
  return h;
}

async function guest(code: string): Promise<{ room: Room; inv: Map<number, number>; closed: string[] }> {
  const room = await ts.client().joinById(code, { nickname: 'Guesty', playerKey: GUEST_KEY });
  const inv = new Map<number, number>();
  const closed: string[] = [];
  const { decodeInvSync } = await import('@hub/shared');
  room.onMessage(VoxelMsg.InvSync, (b: Uint8Array) => {
    for (const [ref, item, count] of decodeInvSync(b).slots) if (count > 0 && ref < 37) inv.set(item, count);
  });
  room.onMessage(VoxelMsg.HostClosed, (m: { text: string }) => closed.push(m.text));
  for (const t of [VoxelMsg.World, VoxelMsg.Edits, VoxelMsg.Chat, VoxelMsg.Vitals, VoxelMsg.SurvivalEvents, 'N', 'V']) room.onMessage(t, () => {});
  return { room, inv, closed };
}

describe('hosted worlds', () => {
  it('stay locked and hidden until the upload arrives, then load it like a save', async () => {
    const h = await host({ upload: false });
    await wait(50);
    await expect(ts.client().joinById(h.room.roomId, { nickname: 'Early' })).rejects.toThrow();
    expect((await roomList()).rooms.find((r) => r.roomId === h.room.roomId)).toBeUndefined();

    for (const chunk of uploadChunks(worldFile(), 700)) h.room.sendBytes(VoxelMsg.HostUpload, chunk);
    await until(() => h.ready !== null, 5000);
    expect(h.ready).toEqual({ ok: true, code: h.room.roomId, seed: SEED });
    await until(() => h.room.state.seed === SEED);
    expect(h.room.state.genVersion).toBe(2);
    expect(h.room.state.worldKind).toBe('hosted');
    await until(() => h.worlds > 0);
    // Private: still not listed, and quick match goes elsewhere.
    expect((await roomList()).rooms.find((r) => r.roomId === h.room.roomId)).toBeUndefined();
    const stranger = await ts.client().joinOrCreate('voxel', { nickname: 'Stranger', mode: 'survival' });
    expect(stranger.roomId).not.toBe(h.room.roomId);
    await stranger.leave();
    // Nothing goes into the server's store.
    expect(await store.exists(h.room.roomId)).toBe(false);
    await h.room.leave();
  });

  it('give a returning guest their inventory and send saves with their record back to the host', async () => {
    const h = await host();
    const g = await guest(h.room.roomId);
    await until(() => g.inv.get(Item.Stick) === 5);

    g.room.send('dbg', { give: ['bread', 2] });
    await until(() => g.inv.get(Item.Bread) === 2);
    await g.room.leave();
    await until(() => h.saves.length > 0, 5000);
    const saved = decodeWorld('x', h.saves[h.saves.length - 1]);
    expect(saved.seed).toBe(SEED);
    expect(decodeEdits(saved.edits, true)).toContainEqual({ x: 2, y: 40, z: 2, id: 3 });
    expect(decodeWorldMeta(saved.sections!.get(SECTION_TAGS.meta))?.name).toBe('Castle'); // carried through untouched
    const rec = decodePlayers(saved.sections!.get(SECTION_TAGS.players)!).find((r) => r.key === playerKeyHash({ playerKey: GUEST_KEY }));
    expect(rec?.saved.slots.map(([, item, count]) => [item, count])).toEqual(expect.arrayContaining([[Item.Stick, 5], [Item.Bread, 2]]));

    // Asking for a save gets one; guests may not ask or upload.
    const n = h.saves.length;
    h.room.send(VoxelMsg.HostSaveRequest, {});
    await until(() => h.saves.length > n);
    await h.room.leave();
  });

  it('can switch to Public (listed with name and host) and back', async () => {
    const h = await host();
    h.room.send(VoxelMsg.HostPrivacy, { public: true });
    await until(() => h.room.state.privateRoom === false);
    let listed = (await roomList()).rooms.find((r) => r.roomId === h.room.roomId);
    expect(listed).toMatchObject({ hosted: true, worldName: 'Castle', hostName: 'Hosty', maxClients: VOXEL_MAX_PLAYERS });
    h.room.send(VoxelMsg.HostPrivacy, { public: false });
    await until(() => h.room.state.privateRoom === true);
    listed = (await roomList()).rooms.find((r) => r.roomId === h.room.roomId);
    expect(listed).toBeUndefined();
    await h.room.leave();
  });

  it('close for everyone when the host leaves, and reopen under the same code with progress kept', async () => {
    const h = await host();
    const code = h.room.roomId;
    const g = await guest(code);
    await until(() => g.inv.get(Item.Stick) === 5);
    g.room.send('dbg', { give: ['bread', 4] });
    await until(() => g.inv.get(Item.Bread) === 4);
    // A guest cannot change privacy or upload.
    g.room.send(VoxelMsg.HostPrivacy, { public: true });
    await wait(100);
    expect(h.room.state.privateRoom).toBe(true);

    let left = 0;
    g.room.onLeave(() => left++);
    h.room.send(VoxelMsg.HostSaveRequest, {});
    await until(() => h.saves.length > 0);
    await h.room.leave();
    await until(() => g.closed.length > 0 && left > 0, 5000);
    expect(g.closed[0]).toBe(HOST_LEFT_TEXT);

    // Not revivable from the server's store...
    await expect(ts.client().create('voxel', { nickname: 'X', private: true, reviveCode: code })).rejects.toThrow(REVIVE_ERRORS.noSavedWorld);
    // ...but the host's own copy reopens under the same code, and the guest's bread is back.
    await wait(100);
    const again = await host({ hostCode: code, file: h.saves[h.saves.length - 1] });
    expect(again.room.roomId).toBe(code);
    const back = await guest(code);
    await until(() => back.inv.get(Item.Bread) === 4);
    await back.room.leave();
    await again.room.leave();
  });

  it('limit how many worlds one address hosts in a row', async () => {
    resetHostLimits();
    const rooms: Room[] = [];
    let refused = '';
    for (let i = 0; i < 8 && !refused; i++) {
      try {
        rooms.push(await ts.client().create('voxel', { nickname: 'Spam', mode: 'sandbox', host: true }));
      } catch (err) {
        refused = (err as Error).message;
      }
    }
    expect(rooms.length).toBe(6);
    expect(refused).toContain(REVIVE_ERRORS.tooManyAttempts);
    await Promise.all(rooms.map((r) => r.leave()));
  });

  it('refuse broken and oversized uploads', async () => {
    const bad = await host({ upload: false });
    const junk = new Uint8Array(500).fill(7);
    for (const chunk of uploadChunks(junk)) bad.room.sendBytes(VoxelMsg.HostUpload, chunk);
    await until(() => bad.ready !== null);
    expect(bad.ready).toMatchObject({ ok: false });

    const big = await host({ upload: false });
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, 64 * 1024 * 1024, true);
    big.room.sendBytes(VoxelMsg.HostUpload, new Uint8Array([...header, 1, 2, 3]));
    await until(() => big.ready !== null);
    expect(big.ready).toMatchObject({ ok: false, error: expect.stringContaining('too big') });

    const sandbox = await host({ upload: false });
    sandbox.room.sendBytes(VoxelMsg.HostUpload, uploadChunks(worldFile({ mode: 'sandbox' }))[0]);
    await until(() => sandbox.ready !== null);
    expect(sandbox.ready).toMatchObject({ ok: false });
  });
});

/** Helpers for Arcfire Arena room tests: joining as a client, pacing commands, and the live room. */
import { matchMaker } from '@colyseus/core';
import type { Room } from '@colyseus/sdk';
import { type ArenaEvent, ArenaMsg, type Command, decodeSnapshot, encodeCommands, type FlatMapOptions, flatArenaMap, type JoinOptions, type SnapshotMsg } from '@hub/shared';
import type { ArenaRoom } from '../src/rooms/ArenaRoom';
import { type TestServer, until, wait } from './helpers';

export interface Peer {
  room: Room;
  snaps: SnapshotMsg[];
  events: ArenaEvent[];
  seq: number;
}

/** Creates a private room (or joins `roomId`) and records its snapshots and events. */
export async function join(ts: TestServer, nickname: string, roomId?: string, mode = '1v1', extra: Partial<JoinOptions> = {}): Promise<Peer> {
  const c = ts.client();
  const room = roomId ? await c.joinById(roomId, { nickname, ...extra }) : await c.create('arena', { nickname, mode, private: true, ...extra });
  const peer: Peer = { room, snaps: [], events: [], seq: 0 };
  room.onMessage(ArenaMsg.Snapshot, (b: Uint8Array) => peer.snaps.push(decodeSnapshot(b, peer.snaps.at(-1)?.ack ?? 0)));
  room.onMessage(ArenaMsg.Events, (e: ArenaEvent[]) => peer.events.push(...e));
  room.onMessage('chat', () => undefined);
  await until(() => room.state.players?.get(room.sessionId) !== undefined);
  return peer;
}

/** The server-side room behind a client connection (same process). */
export function serverRoom(id: string): ArenaRoom {
  return matchMaker.getLocalRoomById(id) as unknown as ArenaRoom;
}

/** Sends `n` commands paced like a 60 Hz client (2 per 33 ms). */
export async function sendPaced(p: Peer, n: number, make: (seq: number) => Partial<Command>): Promise<void> {
  for (let i = 0; i < n; i += 2) {
    const batch: Command[] = [];
    for (let k = 0; k < 2 && i + k < n; k++) {
      const seq = ++p.seq;
      batch.push({ seq, moveX: 0, moveY: 0, yaw: 0, pitch: 0, buttons: 0, slot: 255, viewTick: 0, ...make(seq) });
    }
    p.room.sendBytes(ArenaMsg.Input, encodeCommands(batch));
    await wait(33);
  }
}

/** Moves the room's match onto an open flat fixture map (in warmup everyone respawns there). */
export function useFlatMap(room: ArenaRoom, opts: FlatMapOptions = {}): void {
  room.sim.changeMap(flatArenaMap(opts));
}

/** REST helpers (room list / online counts). */
import type { RoomListResponse } from '@hub/shared';
import { hasGameServer, serverHttpUrl } from './serverUrl';

export async function fetchRooms(signal?: AbortSignal): Promise<RoomListResponse> {
  if (!hasGameServer()) throw new Error('no game server configured');
  const res = await fetch(`${serverHttpUrl()}/api/rooms`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`room list failed: ${res.status}`);
  return (await res.json()) as RoomListResponse;
}

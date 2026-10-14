/** Online Voxelvale (phase 3). Until then online rooms show the room lobby. */
import type { VoxelMode } from '@hub/shared';
import { launchRoomLobby } from '../../common/RoomLobbyView';
import type { GameInstance, GameLaunchContext } from '../../types';

export async function launchOnline(ctx: GameLaunchContext, _mode: VoxelMode): Promise<GameInstance> {
  return launchRoomLobby(ctx);
}

/** Online Arcfire Arena (phase 5). Until then online rooms show the room lobby. */
import { launchRoomLobby } from '../../common/RoomLobbyView';
import type { GameInstance, GameLaunchContext } from '../../types';

export async function launchOnline(ctx: GameLaunchContext): Promise<GameInstance> {
  return launchRoomLobby(ctx);
}

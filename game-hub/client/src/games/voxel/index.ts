/** Voxelvale entry point (lazy-loaded chunk). */
import { launchRoomLobby } from '../common/RoomLobbyView';
import type { GameInstance, GameLaunchContext } from '../types';

export async function launch(ctx: GameLaunchContext): Promise<GameInstance> {
  ctx.loading.set(0.9, 'Entering room');
  return launchRoomLobby(ctx);
}

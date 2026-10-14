/** Online Voxelvale: build the game from the room's seed and attach the network layer. */
import type { VoxelMode } from '@hub/shared';
import type { GameInstance, GameLaunchContext } from '../../types';
import { VoxelGame } from '../VoxelGame';
import { VoxelNet } from './VoxelNet';

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeoutMs) throw new Error('Timed out waiting for the room state.');
    await new Promise((r) => setTimeout(r, 30));
  }
}

export async function launchOnline(ctx: GameLaunchContext, fallbackMode: VoxelMode): Promise<GameInstance> {
  const session = ctx.session!;
  ctx.loading.set(0.34, 'Syncing world');
  await waitFor(() => !!session.state?.seed && session.state.players?.get(session.sessionId) !== undefined, 10000);
  const state = session.state;
  const mode = (state.mode as VoxelMode) || fallbackMode;
  const me = state.players.get(session.sessionId);

  const game = new VoxelGame({
    container: ctx.container,
    seed: state.seed,
    mode,
    chat: true,
    loading: ctx.loading,
    onExit: (m) => ctx.exit(m),
    // Use the server's idea of where we are (matters after a reconnect / page reload).
    initialPlayer: me ? { x: me.x, y: me.y, z: me.z, yaw: me.yaw, pitch: me.pitch } : null,
    initialTime: state.timeOfDay,
  });
  const net = new VoxelNet(session, game, ctx.container);
  game.setNet(net);
  await game.start();
  return { dispose: () => game.dispose() };
}

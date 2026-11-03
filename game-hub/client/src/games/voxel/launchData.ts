/** What the hub's world menu hands Voxelvale in GameLaunchContext.launchData. */
import type { GameLaunchContext } from '../types';

export interface VoxelLaunchData {
  /** Library world to play (offline) or host (with `host`). */
  worldId?: string;
  /** Host this world online. */
  host?: { public: boolean };
}

export function voxelLaunchData(ctx: Pick<GameLaunchContext, 'launchData'>): VoxelLaunchData {
  const d = ctx.launchData as VoxelLaunchData | undefined;
  return d && typeof d === 'object' ? d : {};
}

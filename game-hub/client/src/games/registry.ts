/**
 * Lazy loaders for each game. Vite turns every dynamic import into its own
 * chunk, so the hub never downloads three.js or a game until it is opened.
 */
import type { GameId } from '@hub/shared';
import type { GameModule } from './types';

export const gameLoaders: Record<GameId, () => Promise<GameModule>> = {
  voxel: () => import('./voxel/index'),
  arena: () => import('./arena/index'),
};

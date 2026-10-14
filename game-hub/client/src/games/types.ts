/**
 * Contract between the hub shell and a lazily loaded game bundle.
 */
import type { GameId } from '@hub/shared';
import type { NetSession } from '../net/session';
import type { LoadingScreen } from '../core/ui/overlays';

export interface GameLaunchContext {
  game: GameId;
  /** Full-screen element the game owns until it exits. */
  container: HTMLElement;
  /** Online session, or null for offline / practice play. */
  session: NetSession | null;
  /** Game-specific mode (sandbox / parkour / 1v1 / 2v2 / ffa). */
  mode: string;
  loading: LoadingScreen;
  /** Called by the game when the player quits (or the connection is gone for good). */
  exit: (message?: string) => void;
}

export interface GameInstance {
  dispose(): void;
}

export interface GameModule {
  launch(ctx: GameLaunchContext): Promise<GameInstance>;
}

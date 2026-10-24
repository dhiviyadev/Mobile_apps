/** Arcfire Arena entry point (lazy-loaded chunk). */
import { ARENA_MAPS, type ArenaMode, DEFAULT_PRIMARY, DEFAULT_SECONDARY, isArenaMode, isBotDifficulty, isPrimary, isSecondary } from '@hub/shared';
import { settings } from '../../core/settings';
import type { GameInstance, GameLaunchContext } from '../types';
import { ArenaGame } from './ArenaGame';
import { LocalBackend } from './local/LocalBackend';

export async function launch(ctx: GameLaunchContext): Promise<GameInstance> {
  if (ctx.session) {
    const { launchOnline } = await import('./net/online');
    return launchOnline(ctx);
  }
  const mode: ArenaMode = isArenaMode(ctx.mode) ? ctx.mode : '1v1';
  ctx.loading.set(0.5, 'Building arena');
  const s = settings.get();
  const backend = new LocalBackend(mode, Math.floor(Math.random() * ARENA_MAPS.length), s.nickname || 'You', s.color, {
    botDifficulty: isBotDifficulty(s.arenaBotDifficulty) ? s.arenaBotDifficulty : 'normal',
    primary: isPrimary(s.arenaPrimary) ? s.arenaPrimary : DEFAULT_PRIMARY,
    secondary: isSecondary(s.arenaSecondary) ? s.arenaSecondary : DEFAULT_SECONDARY,
  });
  const game = new ArenaGame({ container: ctx.container, backend, onExit: (m) => ctx.exit(m) });
  ctx.loading.set(0.95, 'Ready');
  game.start();
  return { dispose: () => game.dispose() };
}

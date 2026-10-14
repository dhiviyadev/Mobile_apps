/** Online Arcfire Arena: NetBackend + the shared ArenaGame client. */
import { ArenaMsg, type ChatMessage } from '@hub/shared';
import { ChatBox } from '../../common/ChatBox';
import type { GameInstance, GameLaunchContext } from '../../types';
import { ArenaGame } from '../ArenaGame';
import { NetBackend } from './NetBackend';

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start > timeoutMs) throw new Error('Timed out waiting for the match state.');
    await new Promise((r) => setTimeout(r, 30));
  }
}

export async function launchOnline(ctx: GameLaunchContext): Promise<GameInstance> {
  const session = ctx.session!;
  ctx.loading.set(0.5, 'Syncing match');
  await waitFor(() => session.state?.players?.get(session.sessionId) !== undefined, 10000);
  const backend = new NetBackend(session);
  let offChat: (() => void) | null = null;
  const game = new ArenaGame({
    container: ctx.container,
    backend,
    onExit: (m) => ctx.exit(m),
    createChat: (container) => {
      const chat = new ChatBox(container, (text) => session.send(ArenaMsg.Chat, { text }), () => undefined);
      offChat = session.onMessage('chat', (m: ChatMessage) => chat.add(m));
      return chat;
    },
  });
  ctx.loading.set(0.95, 'Ready');
  game.start();
  return {
    dispose: () => {
      offChat?.();
      game.dispose();
    },
  };
}

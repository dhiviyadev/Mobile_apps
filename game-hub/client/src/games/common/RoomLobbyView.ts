/**
 * Simple in-room lobby: room code, players with connection state, leave.
 * Used as the Phase 1 stand-in for both games (and later for offline errors).
 */
import { GAME_TITLES } from '@hub/shared';
import { h, hexColor, svg } from '../../core/ui/dom';
import { toast } from '../../core/ui/overlays';
import type { GameInstance, GameLaunchContext } from '../types';

const COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';

export function launchRoomLobby(ctx: GameLaunchContext): GameInstance {
  const { session } = ctx;
  const list = h('ul', { class: 'lobby-players', 'data-testid': 'lobby-players' });
  const codeEl = h('span', { class: 'lobby-code', 'data-testid': 'lobby-code' }, session?.roomId ?? 'OFFLINE');
  const pingEl = h('span', { class: 'lobby-ping' }, '');

  const renderPlayers = () => {
    if (!session) return;
    const items: HTMLElement[] = [];
    session.state?.players?.forEach((p: { name: string; color: number; connected: boolean }, id: string) => {
      items.push(
        h('li', { class: p.connected ? '' : 'dropped' },
          h('span', { class: 'dot', style: `background:${hexColor(p.color)}` }),
          h('span', { class: 'name' }, p.name),
          id === session.sessionId ? h('span', { class: 'tag' }, 'you') : null,
          id === session.state.hostId ? h('span', { class: 'tag host' }, 'host') : null,
          p.connected ? null : h('span', { class: 'tag warn' }, 'reconnecting'),
        ),
      );
    });
    list.replaceChildren(...items);
  };

  const view = h('div', { class: 'lobby-view' },
    h('div', { class: 'lobby-card' },
      h('h2', null, GAME_TITLES[ctx.game]),
      h('p', { class: 'muted' }, `Mode: ${ctx.mode}`),
      h('div', { class: 'lobby-code-row' },
        h('span', { class: 'muted' }, 'Room code'),
        codeEl,
        h('button', {
          class: 'icon-btn', 'aria-label': 'Copy code',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(session?.roomId ?? '');
              toast('Code copied', 'success', 1500);
            } catch {
              toast('Copy not available — read the code out loud!');
            }
          },
        }, svg(COPY)),
      ),
      h('h3', null, 'Players'),
      list,
      pingEl,
      h('button', { class: 'btn btn-danger', 'data-testid': 'leave-room', onclick: () => ctx.exit() }, 'Leave room'),
    ),
  );
  ctx.container.appendChild(view);

  const offState = session?.onStateChange(renderPlayers);
  const pingTimer = window.setInterval(() => {
    if (session) pingEl.textContent = `Ping ${Math.round(session.ping)} ms`;
  }, 1000);
  renderPlayers();

  return {
    dispose() {
      offState?.();
      window.clearInterval(pingTimer);
      view.remove();
    },
  };
}

/**
 * Online warmup lobby shown over the arena while players gather:
 * room code, who's here, auto-start countdown and the host's start buttons.
 * Players can run around and shoot each other during warmup.
 */
import { h, svg } from '../../../core/ui/dom';
import { toast } from '../../../core/ui/overlays';
import type { NetMatchInfo } from '../net/NetBackend';

const COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>';

export class WarmupPanel {
  readonly el: HTMLElement;
  private readonly status: HTMLElement;
  private readonly roster: HTMLElement;
  private readonly actions: HTMLElement;
  private lastKey = '';
  private lastStatus = '';

  constructor(parent: HTMLElement, code: string, private readonly onStart: (bots: boolean) => void) {
    this.status = h('div', { class: 'wu-status', 'data-testid': 'warmup-status' });
    this.roster = h('div', { class: 'wu-roster' });
    this.actions = h('div', { class: 'wu-actions' });
    this.el = h('div', { class: 'warmup-panel hidden', 'data-testid': 'warmup' },
      h('div', { class: 'wu-head' },
        h('span', { class: 'wu-title' }, 'Warmup'),
        h('button', {
          class: 'wu-code',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(code);
              toast('Room code copied', 'success', 1500);
            } catch {
              toast(`Room code: ${code}`);
            }
          },
        }, code, svg(COPY)),
      ),
      this.status,
      this.roster,
      this.actions,
    );
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    parent.appendChild(this.el);
  }

  update(m: NetMatchInfo, localId: string, visible: boolean): void {
    this.el.classList.toggle('hidden', !visible);
    if (!visible) return;
    const humans = m.players.filter((p) => !p.bot);
    const isHost = m.hostId === localId;
    const startsIn = m.startsIn === null ? -1 : Math.ceil(m.startsIn);
    const status =
      startsIn >= 0
        ? `Match starts in ${startsIn}…`
        : humans.length >= m.minHumans
          ? 'Ready to start'
          : `${humans.length}/${m.minHumans} players · share the code to invite friends`;
    if (status !== this.lastStatus) {
      this.status.textContent = status;
      this.lastStatus = status;
    }
    // Rebuild the roster and buttons only when they change (keeps buttons stable under the finger).
    const key = `${m.players.map((p) => p.id + p.connected).join()}|${isHost}|${humans.length >= 2}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.roster.replaceChildren(
      ...m.players.map((p) => h('span', { class: `wu-chip ${p.bot ? 'bot' : ''} ${p.connected ? '' : 'dropped'}` }, p.name, p.bot ? ' 🤖' : '', p.id === localId ? ' (you)' : '')),
    );
    this.actions.replaceChildren(
      isHost
        ? h('div', { class: 'wu-host' },
            h('button', { class: 'btn btn-primary btn-sm', 'data-testid': 'start-bots', onclick: () => this.onStart(true) }, 'Start with bots'),
            humans.length >= 2 ? h('button', { class: 'btn btn-sm', 'data-testid': 'start-now', onclick: () => this.onStart(false) }, 'Start now') : null,
          )
        : h('span', { class: 'wu-hint' }, 'Waiting for the host to start…'),
    );
  }

  dispose(): void {
    this.el.remove();
  }
}

/**
 * Bottom sheet for one game: pick a mode, quick match, create a private room,
 * play offline, or join one of the listed public rooms.
 */
import {
  ARENA_MODE_INFO,
  ARENA_MODES,
  GAME_TITLES,
  type GameId,
  VOXEL_MODES,
} from '@hub/shared';
import { clear, h, removeWithTransition, svg } from '../core/ui/dom';
import { ICONS } from './art';
import type { RoomPoller } from './roomPoller';

export type SheetAction =
  | { kind: 'quick'; mode: string }
  | { kind: 'create'; mode: string }
  | { kind: 'offline'; mode: string }
  | { kind: 'join'; code: string };

const MODE_LABELS: Record<string, string> = {
  sandbox: 'Sandbox',
  parkour: 'Parkour',
  ...Object.fromEntries(ARENA_MODES.map((m) => [m, ARENA_MODE_INFO[m].label])),
};

const MODE_HINTS: Record<string, string> = {
  sandbox: 'Build together in an endless procedurally generated world.',
  parkour: 'Race through a floating obstacle course. Checkpoints and a timer.',
  '1v1': 'Duel. First to 5 rounds wins.',
  '2v2': 'Two teams of two. First to 5 rounds wins.',
  ffa: 'Up to 8 players. Win a round by being the last one standing.',
};

const LAST_MODE_KEY = 'cobalt-hub.last-mode.';

export class GameSheet {
  readonly el: HTMLElement;
  private mode: string;
  private list: HTMLElement;
  private unsubscribe: () => void;
  private closed = false;

  constructor(
    private readonly game: GameId,
    poller: RoomPoller,
    private readonly onAction: (action: SheetAction) => void,
    private readonly onClose: () => void,
  ) {
    const modes: readonly string[] = game === 'voxel' ? VOXEL_MODES : ARENA_MODES;
    this.mode = localStorage.getItem(LAST_MODE_KEY + game) ?? modes[0];
    if (!modes.includes(this.mode)) this.mode = modes[0];

    const hint = h('p', { class: 'sheet-hint' }, MODE_HINTS[this.mode]);
    const seg = h('div', { class: 'segmented', role: 'tablist' });
    const renderSeg = () => {
      clear(seg);
      for (const m of modes) {
        seg.appendChild(
          h('button', {
            class: `seg-btn ${m === this.mode ? 'active' : ''}`,
            role: 'tab',
            'aria-selected': String(m === this.mode),
            onclick: () => {
              this.mode = m;
              localStorage.setItem(LAST_MODE_KEY + game, m);
              hint.textContent = MODE_HINTS[m];
              renderSeg();
              this.renderRooms(poller);
              offlineBtn.lastChild!.textContent = this.offlineLabel();
            },
          }, MODE_LABELS[m]),
        );
      }
    };
    renderSeg();

    const offlineBtn = h('button', { class: 'btn btn-ghost btn-lg', onclick: () => this.act({ kind: 'offline', mode: this.mode }) },
      svg(ICONS.bot), this.offlineLabel());

    this.list = h('div', { class: 'room-list scrollable' });

    this.el = h('div', { class: 'sheet-backdrop entering', onclick: (e: Event) => e.target === this.el && this.close() },
      h('div', { class: `sheet sheet-${game}`, role: 'dialog', 'aria-label': GAME_TITLES[game] },
        h('div', { class: 'sheet-grip' }),
        h('div', { class: 'sheet-head' },
          h('h2', null, GAME_TITLES[game]),
          h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => this.close() }, svg(ICONS.close)),
        ),
        seg,
        hint,
        h('div', { class: 'sheet-actions' },
          h('button', { class: 'btn btn-primary btn-xl', 'data-testid': 'quick-match', onclick: () => this.act({ kind: 'quick', mode: this.mode }) },
            svg(ICONS.bolt), 'Quick Match'),
          h('div', { class: 'sheet-actions-row' },
            h('button', { class: 'btn btn-lg', 'data-testid': 'create-private', onclick: () => this.act({ kind: 'create', mode: this.mode }) },
              svg(ICONS.lock), 'Private room'),
            offlineBtn,
          ),
        ),
        h('h3', { class: 'sheet-sub' }, 'Open rooms'),
        this.list,
      ),
    );
    this.unsubscribe = poller.subscribe(() => this.renderRooms(poller));
    document.body.appendChild(this.el);
    requestAnimationFrame(() => this.el.classList.remove('entering'));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    removeWithTransition(this.el, 260);
    this.onClose();
  }

  private offlineLabel(): string {
    if (this.game === 'arena') return 'Practice vs bots';
    return 'Play offline';
  }

  private act(action: SheetAction): void {
    this.onAction(action);
  }

  private renderRooms(poller: RoomPoller): void {
    const { data, error } = poller.snapshot();
    clear(this.list);
    if (error && !data) {
      this.list.appendChild(h('div', { class: 'room-empty' }, svg(ICONS.wifiOff), 'Game server unreachable. Offline play still works.'));
      return;
    }
    const rooms = data?.rooms.filter((r) => r.game === this.game && r.mode === this.mode) ?? [];
    if (rooms.length === 0) {
      this.list.appendChild(h('div', { class: 'room-empty' }, 'No open rooms right now. Quick Match will start one for you.'));
      return;
    }
    for (const r of rooms) {
      const full = r.clients >= r.maxClients || r.locked;
      this.list.appendChild(
        h('div', { class: 'room-row' },
          h('span', { class: 'room-code' }, r.roomId),
          h('span', { class: 'room-status' }, r.status ?? ''),
          h('span', { class: 'room-count' }, svg(ICONS.user), `${r.clients}/${r.maxClients}`),
          h('button', { class: 'btn btn-sm', disabled: full, onclick: () => this.act({ kind: 'join', code: r.roomId }) }, full ? 'Full' : 'Join'),
        ),
      );
    }
  }
}

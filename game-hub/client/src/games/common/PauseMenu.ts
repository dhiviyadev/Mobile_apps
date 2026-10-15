/**
 * In-game pause menu shared by both games: resume, settings, touch layout
 * editor, room code (online), game-specific extras, and leave.
 */
import { isTouchDevice } from '../../core/device';
import { h, hexColor, removeWithTransition } from '../../core/ui/dom';
import { toast } from '../../core/ui/overlays';
import { openSettings } from '../../core/ui/settingsMenu';

export interface PauseMenuOptions {
  title: string;
  roomCode: string | null;
  onResume: () => void;
  onLeave: () => void;
  onEditLayout?: () => void;
  extra?: { label: string; onClick: () => void; danger?: boolean }[];
  /** Online: players in the room. */
  players?: () => { name: string; color: number; you: boolean; connected: boolean }[];
  /** Optional line under the room code (e.g. whether the world is saved). */
  note?: () => string | null;
}

/** Note providers registered per game container (see setPauseNote). */
const notes = new WeakMap<HTMLElement, () => string | null>();

/**
 * Supplies the note line for the pause menu opened inside `container`, for
 * layers (like the online one) that do not construct the menu themselves.
 * Pass null to remove it.
 */
export function setPauseNote(container: HTMLElement, note: (() => string | null) | null): void {
  if (note) notes.set(container, note);
  else notes.delete(container);
}

export class PauseMenu {
  private el: HTMLElement | null = null;

  constructor(private readonly parent: HTMLElement, private readonly opts: PauseMenuOptions) {}

  setRoomCode(code: string | null): void {
    this.opts.roomCode = code;
  }

  get isOpen(): boolean {
    return this.el !== null;
  }

  open(): void {
    if (this.el) return;
    const o = this.opts;
    const close = () => this.close();
    this.el = h('div', { class: 'pause-menu entering', 'data-testid': 'pause-menu' },
      h('div', { class: 'pause-card' },
        h('h2', null, o.title),
        o.roomCode
          ? h('button', {
              class: 'room-code-chip',
              title: 'Copy room code',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(o.roomCode!);
                  toast('Room code copied', 'success', 1500);
                } catch {
                  toast(`Room code: ${o.roomCode}`);
                }
              },
            }, h('span', null, 'Room code'), h('strong', null, o.roomCode))
          : h('p', { class: 'muted' }, 'Offline game'),
        this.note(),
        this.playerList(),
        h('button', { class: 'btn btn-primary btn-lg', 'data-testid': 'resume', onclick: () => { close(); o.onResume(); } }, 'Resume'),
        h('button', { class: 'btn btn-lg', onclick: () => openSettings({ onEditTouchLayout: o.onEditLayout && isTouchDevice() ? () => { close(); o.onEditLayout!(); } : undefined }) }, 'Settings'),
        o.onEditLayout && isTouchDevice() ? h('button', { class: 'btn btn-lg', onclick: () => { close(); o.onEditLayout!(); } }, 'Edit touch layout') : null,
        (o.extra ?? []).map((x) => h('button', { class: `btn btn-lg ${x.danger ? 'btn-danger' : ''}`, onclick: () => { close(); x.onClick(); } }, x.label)),
        h('button', { class: 'btn btn-lg btn-danger', 'data-testid': 'leave-game', onclick: () => { close(); o.onLeave(); } }, 'Leave game'),
      ),
    );
    this.parent.appendChild(this.el);
    requestAnimationFrame(() => this.el?.classList.remove('entering'));
  }

  private note(): HTMLElement | null {
    const text = (this.opts.note ?? notes.get(this.parent))?.() ?? null;
    return text ? h('p', { class: 'muted pause-note', 'data-testid': 'pause-note' }, text) : null;
  }

  private playerList(): HTMLElement | null {
    const list = this.opts.players?.() ?? [];
    if (list.length === 0) return null;
    return h('ul', { class: 'pause-players' },
      list.map((p) => h('li', { class: p.connected ? '' : 'dropped' },
        h('span', { class: 'dot', style: `background:${hexColor(p.color)}` }),
        p.name,
        p.you ? h('span', { class: 'tag' }, 'you') : null,
      )),
    );
  }

  close(): void {
    if (!this.el) return;
    removeWithTransition(this.el, 200);
    this.el = null;
  }
}

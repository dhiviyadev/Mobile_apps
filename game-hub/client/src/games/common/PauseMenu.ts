/**
 * In-game pause menu shared by both games: resume, settings, touch layout
 * editor, room code (online), game-specific extras, and leave.
 */
import { isTouchDevice } from '../../core/device';
import { h, removeWithTransition } from '../../core/ui/dom';
import { toast } from '../../core/ui/overlays';
import { openSettings } from '../../core/ui/settingsMenu';

export interface PauseMenuOptions {
  title: string;
  roomCode: string | null;
  onResume: () => void;
  onLeave: () => void;
  onEditLayout?: () => void;
  extra?: { label: string; onClick: () => void; danger?: boolean }[];
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

  close(): void {
    if (!this.el) return;
    removeWithTransition(this.el, 200);
    this.el = null;
  }
}

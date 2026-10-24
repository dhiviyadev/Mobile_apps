/**
 * Full-screen overlays: loading screen with progress bar, reconnect banner,
 * toasts and simple modal dialogs.
 */
import { h, removeWithTransition } from './dom';

const TIPS = [
  'Drag on the right half of the screen to look around.',
  'Every control button can be moved and resized in Settings → Touch layout.',
  'Left-handed? Flip the whole layout in Settings → Controls.',
  'Share your 6-letter room code so friends can join you.',
  'Low on frames? Drop the quality preset or the render distance.',
  'Swipe across the hotbar to flick through blocks quickly.',
];

/** Loading screen with weighted progress and rotating tips. */
export class LoadingScreen {
  readonly el: HTMLElement;
  private bar: HTMLElement;
  private label: HTMLElement;
  private pct: HTMLElement;
  private card: HTMLElement;

  constructor(title: string, accent = 'var(--accent)') {
    this.bar = h('div', { class: 'loading-bar-fill' });
    this.label = h('div', { class: 'loading-label' }, 'Starting…');
    this.pct = h('div', { class: 'loading-pct' }, '0%');
    this.card = h('div', { class: 'loading-card' },
      h('div', { class: 'loading-logo' }, h('span', { class: 'cube-spinner' })),
      h('h2', null, title),
      h('div', { class: 'loading-bar' }, this.bar),
      h('div', { class: 'loading-row' }, this.label, this.pct),
      h('p', { class: 'loading-tip' }, TIPS[Math.floor(Math.random() * TIPS.length)]),
    );
    this.el = h('div', { class: 'loading-screen entering', style: `--loading-accent:${accent}` }, this.card);
    document.body.appendChild(this.el);
    requestAnimationFrame(() => this.el.classList.remove('entering'));
  }

  /** @param progress 0..1 */
  set(progress: number, label?: string): void {
    const p = Math.max(0, Math.min(1, progress));
    this.bar.style.transform = `scaleX(${p})`;
    this.pct.textContent = `${Math.round(p * 100)}%`;
    if (label) this.label.textContent = label;
  }

  /** Shows a Cancel button until the returned function is called. */
  showCancel(onCancel: () => void): () => void {
    const button = h('button', {
      class: 'btn btn-ghost btn-sm loading-cancel',
      'data-testid': 'loading-cancel',
      onclick: () => {
        button.disabled = true;
        onCancel();
      },
    }, 'Cancel');
    this.card.appendChild(button);
    return () => button.remove();
  }

  done(): void {
    this.set(1, 'Ready');
    removeWithTransition(this.el, 350);
  }
}

/** Banner shown while the network layer tries to get back into the room. */
export class ReconnectBanner {
  private el: HTMLElement | null = null;

  show(attempt: number): void {
    const text = `Connection lost — reconnecting${attempt > 1 ? ` (try ${attempt})` : ''}…`;
    if (!this.el) {
      this.el = h('div', { class: 'reconnect-banner', role: 'status' }, h('span', { class: 'dot-pulse' }), h('span', { class: 'txt' }, text));
      document.body.appendChild(this.el);
    } else {
      this.el.querySelector('.txt')!.textContent = text;
    }
  }

  hide(): void {
    if (this.el) removeWithTransition(this.el);
    this.el = null;
  }
}

let toastHost: HTMLElement | null = null;

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info', ms = 3200, action?: ToastAction): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: `toast toast-${kind} entering` }, message);
  if (action) {
    t.append(' ', h('button', {
      class: 'btn btn-sm toast-action',
      onclick: () => {
        removeWithTransition(t, 250);
        action.onClick();
      },
    }, action.label));
  }
  toastHost.appendChild(t);
  requestAnimationFrame(() => t.classList.remove('entering'));
  window.setTimeout(() => removeWithTransition(t, 250), ms);
}

export interface DialogButton {
  label: string;
  primary?: boolean;
  danger?: boolean;
  value: string;
}

/** Promise-based modal dialog. Resolves with the clicked button's value ('' on dismiss). */
export function dialog(title: string, body: string | Node, buttons: DialogButton[], opts: { testId?: string } = {}): Promise<string> {
  return new Promise((resolve) => {
    const close = (value: string) => {
      removeWithTransition(backdrop);
      resolve(value);
    };
    const backdrop = h(
      'div',
      { class: 'modal-backdrop entering', onclick: (e: Event) => e.target === backdrop && close('') },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'data-testid': opts.testId },
        h('h3', null, title),
        typeof body === 'string' ? h('p', null, body) : body,
        h('div', { class: 'modal-actions' },
          buttons.map((b) =>
            h('button', { class: `btn ${b.primary ? 'btn-primary' : ''} ${b.danger ? 'btn-danger' : ''}`, onclick: () => close(b.value) }, b.label),
          ),
        ),
      ),
    );
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.remove('entering'));
  });
}

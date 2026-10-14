/**
 * In-game text chat: a fading message log plus an input row. Opened with
 * T / Enter on keyboards or the chat button on tablets (which raises the
 * on-screen keyboard). Server-side rate limiting is authoritative; the client
 * also refuses to send more than one message per 600 ms.
 */
import { CHAT_MAX_LENGTH, type ChatMessage } from '@hub/shared';
import { audio } from '../../core/audio/audio';
import { h, hexColor } from '../../core/ui/dom';

const VISIBLE_MS = 9000;

export class ChatBox {
  readonly el: HTMLElement;
  private readonly log: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly form: HTMLElement;
  private open = false;
  private lastSent = 0;

  constructor(
    parent: HTMLElement,
    private readonly send: (text: string) => void,
    private readonly onOpenChange: (open: boolean) => void,
  ) {
    this.log = h('div', { class: 'chat-log', 'aria-live': 'polite', 'data-testid': 'chat-log' });
    this.input = h('input', {
      class: 'chat-input',
      type: 'text',
      maxlength: String(CHAT_MAX_LENGTH),
      placeholder: 'Say something…',
      enterkeyhint: 'send',
      autocomplete: 'off',
      'data-testid': 'chat-input',
    });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.submit();
      else if (e.key === 'Escape') this.close();
    });
    this.input.addEventListener('keyup', (e) => e.stopPropagation());
    this.form = h('div', { class: 'chat-form hidden' },
      this.input,
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => this.submit() }, 'Send'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => this.close() }, 'Close'),
    );
    this.el = h('div', { class: 'chat' }, this.log, this.form);
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.el.classList.add('open');
    this.form.classList.remove('hidden');
    this.onOpenChange(true);
    // Focus after the keypress that opened us has finished, so it isn't typed into the box.
    window.setTimeout(() => this.input.focus(), 0);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('open');
    this.form.classList.add('hidden');
    this.input.blur();
    this.onOpenChange(false);
  }

  add(msg: ChatMessage): void {
    const line = h('div', { class: `chat-line ${msg.system ? 'system' : ''}` },
      msg.system ? null : h('span', { class: 'chat-name', style: `color:${hexColor(msg.color)}` }, msg.name),
      h('span', { class: 'chat-text' }, msg.text),
    );
    this.log.appendChild(line);
    while (this.log.children.length > 40) this.log.firstElementChild?.remove();
    window.setTimeout(() => line.classList.add('faded'), VISIBLE_MS);
    if (!msg.system) audio.play('chat');
  }

  private submit(): void {
    const text = this.input.value.trim();
    const now = performance.now();
    if (text && now - this.lastSent > 600) {
      this.send(text);
      this.lastSent = now;
      this.input.value = '';
    }
    this.close();
  }

  dispose(): void {
    this.el.remove();
  }
}

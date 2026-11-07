/**
 * Teleport menu in the running game (sandbox and survival): saved places and
 * asking other players to teleport to them. P (or the touch button, or the
 * pause menu) opens the panel; requests to you pop up as a small card that
 * does not stop play (Y accept, N decline). The rules live in the shared
 * TeleportCore: offline in the browser (LocalTeleport), online on the server.
 */
import { forwardFromYawPitch, PLACE_COLORS, TELEPORT, type TeleportEvent, type TeleportOp, type Waypoint } from '@hub/shared';
import { audio } from '../../../core/audio/audio';
import { clear, h, hexColor, removeWithTransition } from '../../../core/ui/dom';
import { toast } from '../../../core/ui/overlays';
import type { VoxelModule } from '../modules';
import type { VoxelGame } from '../VoxelGame';
import type { TeleportBackend, TeleportPeer } from './backends';

const icon = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/** Original icons: a ringed pin (places), two figures (players), an arrow. */
export const TP_ICONS = {
  teleport: icon('<path d="M12 21s-6-5.6-6-10a6 6 0 0 1 12 0c0 4.4-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/><path d="M4 20c2.5-1.4 5-2 8-2s5.5.6 8 2"/>'),
  people: icon('<circle cx="8.5" cy="8" r="3"/><circle cx="16.5" cy="9" r="2.5"/><path d="M3 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6M14.5 14.3c3 0 5.5 2.4 5.5 5.7"/>'),
  arrow: icon('<path d="M12 4l6 12-6-3.5L6 16z" fill="currentColor"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  edit: icon('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  trash: icon('<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13"/>'),
};

const span = (markup: string, cls = 'tp-ico') => {
  const s = h('span', { class: cls });
  s.innerHTML = markup;
  return s;
};

interface Pending {
  from: string;
  name: string;
  expiresAt: number;
  el: HTMLElement;
}

export class TeleportController implements VoxelModule {
  private backend: TeleportBackend | null = null;
  private places: Waypoint[] = [];
  private autoDecline = false;
  private readonly pending = new Map<string, Pending>();
  private panel: HTMLElement | null = null;
  private tab: 'places' | 'players' = 'places';
  private body: HTMLElement | null = null;
  private readonly prompts: HTMLElement;
  private readonly warmEl: HTMLElement;
  private warm: { until: number; total: number; to: string } | null = null;
  private cooldownUntil = 0;
  private refreshTimer = 0;
  private readonly keyOff: () => void;
  private openedAt = 0;
  /** Color picked for the next saved place. */
  private nextColor = 0;

  constructor(private readonly game: VoxelGame) {
    this.prompts = h('div', { class: 'tp-prompts', 'aria-live': 'polite' });
    this.warmEl = h('div', { class: 'tp-warm hidden', 'data-testid': 'tp-warmup' });
    game.hudContainer.append(this.prompts, this.warmEl);
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener('keydown', onKey);
    this.keyOff = () => window.removeEventListener('keydown', onKey);
  }

  /** Offline (LocalTeleport) or online (NetTeleport). */
  attach(backend: TeleportBackend): void {
    this.backend?.dispose();
    this.backend = backend;
  }

  /** Events from the backend. */
  readonly onEvent = (e: TeleportEvent): void => {
    switch (e.kind) {
      case 'places':
        this.places = e.list;
        this.autoDecline = e.autoDecline;
        this.nextColor = this.places.length % PLACE_COLORS.length;
        this.render();
        break;
      case 'request':
        this.addPrompt(e.from, e.name, e.expiresInMs);
        break;
      case 'requestGone':
        this.removePrompt(e.from);
        break;
      case 'warmup':
        this.warm = { until: performance.now() + e.ms, total: e.ms, to: e.to };
        audio.play('countdown');
        break;
      case 'cancelled':
        this.warm = null;
        toast(e.reason, 'error', 2200);
        break;
      case 'arrived':
        this.warm = null;
        this.cooldownUntil = performance.now() + e.cooldownMs;
        audio.play('checkpoint');
        toast(`Teleported to ${e.to}.`, 'success', 1800);
        this.render();
        break;
      case 'notice':
        toast(e.text, e.error ? 'error' : 'info', 2600);
        break;
    }
  };

  get isOpen(): boolean {
    return this.panel !== null;
  }

  isModalOpen(): boolean {
    return this.isOpen;
  }

  /** Places and setting for the world file (offline). */
  saveData(): { places: Waypoint[]; autoDecline: boolean } {
    return { places: this.places.map((p) => ({ ...p })), autoDecline: this.autoDecline };
  }

  toggle(): void {
    if (this.panel) this.close();
    else this.open();
  }

  open(tab: 'places' | 'players' = 'places'): void {
    if (!this.backend) return;
    this.tab = tab;
    if (!this.panel) {
      // The tap that opened the panel ends with a click on its backdrop: ignore that one.
      this.openedAt = performance.now();
      this.game.releasePointer();
      this.body = h('div', { class: 'tp-body scrollable' });
      this.panel = h('div', { class: 'tp-backdrop entering', 'data-testid': 'teleport-menu', onclick: (e: Event) => e.target === this.panel && performance.now() - this.openedAt > 400 && this.close() },
        h('div', { class: 'tp-panel', role: 'dialog', 'aria-label': 'Teleport' },
          h('div', { class: 'tp-head' },
            span(TP_ICONS.teleport, 'tp-ico tp-ico-lg'),
            h('h2', null, 'Teleport'),
            h('div', { class: 'tp-tabs', role: 'tablist' },
              this.tabButton('places', 'Places'),
              this.tabButton('players', 'Players'),
            ),
            h('button', { class: 'icon-btn tp-close', 'aria-label': 'Close', onclick: () => this.close() }, span(TP_ICONS.close)),
          ),
          this.body,
        ),
      );
      this.game.hudContainer.appendChild(this.panel);
      requestAnimationFrame(() => this.panel?.classList.remove('entering'));
      // Distances and the players list change while the panel is open.
      this.refreshTimer = window.setInterval(() => this.render(true), 500);
    }
    this.render();
  }

  close(): void {
    if (!this.panel) return;
    window.clearInterval(this.refreshTimer);
    removeWithTransition(this.panel, 180);
    this.panel = null;
    this.body = null;
    this.game.capturePointer();
  }

  update(dt: number): void {
    this.backend?.update(dt);
    const now = performance.now();
    for (const p of this.pending.values()) {
      if (now >= p.expiresAt) this.removePrompt(p.from);
      else p.el.style.setProperty('--left', String((p.expiresAt - now) / TELEPORT.requestTtlMs));
    }
    if (this.warm) {
      const left = Math.max(0, this.warm.until - now);
      this.warmEl.classList.remove('hidden');
      this.warmEl.style.setProperty('--k', String(1 - left / this.warm.total));
      this.warmEl.textContent = `Teleporting to ${this.warm.to}… ${Math.max(1, Math.ceil(left / 1000))}`;
    } else this.warmEl.classList.add('hidden');
  }

  dispose(): void {
    this.close();
    this.keyOff();
    this.backend?.dispose();
    this.prompts.remove();
    this.warmEl.remove();
  }

  // ---- input ----

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input, textarea') || e.repeat) return;
    if (this.game.net?.isChatOpen?.()) return;
    if (e.code === 'KeyP') {
      e.preventDefault();
      this.toggle();
    } else if (e.code === 'Escape' && this.panel) {
      e.preventDefault();
      this.close();
    } else if ((e.code === 'KeyY' || e.code === 'KeyN') && this.pending.size) {
      const first = [...this.pending.values()][0];
      this.answer(first.from, e.code === 'KeyY');
    }
  }

  private send(op: TeleportOp): void {
    this.backend?.send(op);
  }

  // ---- request prompts ----

  private addPrompt(from: string, name: string, ms: number): void {
    this.removePrompt(from);
    audio.play('click');
    const el = h('div', { class: 'tp-prompt entering', 'data-testid': 'tp-request' },
      h('div', { class: 'tp-prompt-text' }, h('strong', null, name), ' wants to teleport to you'),
      h('div', { class: 'tp-prompt-actions' },
        h('button', { class: 'btn btn-sm btn-primary', 'data-testid': 'tp-accept', onclick: () => this.answer(from, true) }, 'Accept', h('kbd', null, 'Y')),
        h('button', { class: 'btn btn-sm', 'data-testid': 'tp-decline', onclick: () => this.answer(from, false) }, 'Decline', h('kbd', null, 'N')),
      ),
      h('div', { class: 'tp-prompt-bar' }),
    );
    this.prompts.appendChild(el);
    requestAnimationFrame(() => el.classList.remove('entering'));
    this.pending.set(from, { from, name, expiresAt: performance.now() + ms, el });
  }

  private removePrompt(from: string): void {
    const p = this.pending.get(from);
    if (!p) return;
    this.pending.delete(from);
    removeWithTransition(p.el, 200);
  }

  private answer(from: string, accept: boolean): void {
    this.send({ op: 'answer', from, accept });
    this.removePrompt(from);
  }

  // ---- panel ----

  private tabButton(tab: 'places' | 'players', label: string): HTMLElement {
    return h('button', {
      class: `seg-btn ${this.tab === tab ? 'active' : ''}`,
      role: 'tab',
      'data-tab': tab,
      'aria-selected': String(this.tab === tab),
      onclick: () => {
        this.tab = tab;
        this.panel?.querySelectorAll<HTMLElement>('.tp-tabs .seg-btn').forEach((b) => {
          b.classList.toggle('active', b.dataset.tab === tab);
          b.setAttribute('aria-selected', String(b.dataset.tab === tab));
        });
        this.render();
      },
    }, label);
  }

  /** Redraws the open tab (soft: only live numbers, keeping focus and inputs). */
  private render(soft = false): void {
    const body = this.body;
    if (!body) return;
    if (soft) {
      body.querySelectorAll<HTMLElement>('[data-place]').forEach((row) => this.updateDistance(row, this.places[Number(row.dataset.place)]));
      if (this.tab === 'players' && body.dataset.peers !== this.peerKey()) this.render();
      this.updateCooldown();
      return;
    }
    clear(body);
    if (this.tab === 'places') this.renderPlaces(body);
    else this.renderPlayers(body);
    this.updateCooldown();
  }

  private updateCooldown(): void {
    const el = this.body?.querySelector('.tp-cooldown');
    if (!el) return;
    const left = Math.ceil((this.cooldownUntil - performance.now()) / 1000);
    el.textContent = left > 0 ? `Recharging: ${left} s` : '';
  }

  private renderPlaces(body: HTMLElement): void {
    const full = this.places.length >= TELEPORT.maxPlaces;
    const name = h('input', {
      type: 'text', class: 'tp-name', maxlength: String(TELEPORT.nameMax), 'aria-label': 'Place name', 'data-testid': 'tp-place-name',
      placeholder: this.places.length === 0 ? 'Home' : `Place ${this.places.length + 1}`, enterkeyhint: 'done',
    });
    const swatches = h('div', { class: 'tp-swatches', role: 'radiogroup', 'aria-label': 'Marker colour' },
      PLACE_COLORS.map((c, i) => h('button', {
        class: `tp-swatch ${i === this.nextColor ? 'active' : ''}`, style: `--c:${hexColor(c)}`, role: 'radio', 'aria-checked': String(i === this.nextColor), 'aria-label': `Colour ${i + 1}`,
        onclick: (e: Event) => {
          this.nextColor = i;
          (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('.tp-swatch').forEach((s, j) => s.classList.toggle('active', j === i));
        },
      })),
    );
    const save = () => {
      this.send({ op: 'save', name: name.value.trim() || name.placeholder, color: this.nextColor });
      name.value = '';
    };
    name.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') save();
    });
    body.append(
      h('div', { class: 'tp-save' },
        name,
        swatches,
        h('button', { class: 'btn btn-primary', disabled: full, 'data-testid': 'tp-save', onclick: save }, 'Save this spot'),
      ),
      h('div', { class: 'tp-meta' }, h('span', null, `${this.places.length}/${TELEPORT.maxPlaces} places`), h('span', { class: 'tp-cooldown' })),
    );
    if (this.places.length === 0) {
      body.append(h('p', { class: 'tp-empty' }, 'Stand somewhere you want to come back to, like your house, and save it here. Then teleport back from anywhere.'));
      return;
    }
    const list = h('ul', { class: 'tp-list' });
    this.places.forEach((p, i) => {
      const row = h('li', { class: 'tp-row', dataset: { place: String(i) } },
        h('span', { class: 'tp-dot', style: `--c:${hexColor(PLACE_COLORS[p.color] ?? PLACE_COLORS[0])}` }),
        h('div', { class: 'tp-row-main' }, h('strong', { class: 'tp-row-name' }, p.name), h('span', { class: 'tp-row-sub' }, span(TP_ICONS.arrow, 'tp-ico tp-dir'), h('span', { class: 'tp-dist' }))),
        h('div', { class: 'tp-row-actions' },
          h('button', { class: 'btn btn-sm btn-primary', 'data-testid': 'tp-go', onclick: () => this.go(i) }, 'Teleport'),
          h('button', { class: 'icon-btn tp-small', 'aria-label': `Rename ${p.name}`, onclick: () => this.rename(row, i) }, span(TP_ICONS.edit)),
          h('button', { class: 'icon-btn tp-small', 'aria-label': `Delete ${p.name}`, onclick: () => this.remove(row, i) }, span(TP_ICONS.trash)),
        ),
      );
      this.updateDistance(row, p);
      list.appendChild(row);
    });
    body.appendChild(list);
  }

  private go(i: number): void {
    this.send({ op: 'go', index: i });
    this.close();
  }

  private rename(row: HTMLElement, i: number): void {
    const name = row.querySelector('.tp-row-name');
    if (!name) return;
    const input = h('input', { type: 'text', class: 'tp-name tp-inline', maxlength: String(TELEPORT.nameMax), value: this.places[i]?.name ?? '', 'aria-label': 'New name' });
    const commit = () => {
      const v = input.value.trim();
      if (v && v !== this.places[i]?.name) this.send({ op: 'rename', index: i, name: v });
      else this.render();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') this.render();
    });
    input.addEventListener('blur', commit);
    name.replaceWith(input);
    input.focus();
    input.select();
  }

  private remove(row: HTMLElement, i: number): void {
    // Two taps: the first arms the button (no modal on top of the panel).
    const btn = row.querySelectorAll('.tp-small')[1] as HTMLElement | undefined;
    if (btn && !btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.setAttribute('aria-label', 'Tap again to delete');
      toast('Tap the bin again to delete this place.', 'info', 1600);
      window.setTimeout(() => btn.classList.remove('armed'), 2500);
      return;
    }
    this.send({ op: 'delete', index: i });
  }

  private updateDistance(row: HTMLElement, p: Waypoint | undefined): void {
    if (!p) return;
    const b = this.game.player.body;
    const dx = p.x - b.x;
    const dz = p.z - b.z;
    const d = Math.hypot(dx, dz);
    const dist = row.querySelector('.tp-dist');
    if (dist) dist.textContent = d < 2 ? 'You are here' : `${Math.round(d)} blocks${Math.abs(p.y - b.y) > 4 ? (p.y > b.y ? ', above' : ', below') : ''}`;
    const dir = row.querySelector<HTMLElement>('.tp-dir');
    if (dir) {
      // Angle between where we look and where the place is (0 = straight ahead).
      const f = forwardFromYawPitch(this.game.player.yaw, 0);
      const ang = Math.atan2(dx * f.z - dz * f.x, dx * f.x + dz * f.z);
      dir.style.transform = `rotate(${(ang * 180) / Math.PI}deg)`;
      dir.style.display = d < 2 ? 'none' : '';
    }
  }

  private peerKey(): string {
    return this.backend?.peers().map((p) => p.id).join(',') ?? '';
  }

  private renderPlayers(body: HTMLElement): void {
    body.dataset.peers = this.peerKey();
    const peers: TeleportPeer[] = this.backend?.peers() ?? [];
    const auto = h('label', { class: 'tp-toggle' },
      h('input', { type: 'checkbox', checked: this.autoDecline, 'data-testid': 'tp-auto-decline', onchange: (e: Event) => this.send({ op: 'autoDecline', on: (e.target as HTMLInputElement).checked }) }),
      h('span', null, 'Turn down requests automatically'),
    );
    body.append(h('div', { class: 'tp-meta' }, h('span', null, peers.length ? `${peers.length} other player${peers.length === 1 ? '' : 's'} here` : ''), h('span', { class: 'tp-cooldown' })), auto);
    if (!peers.length) {
      body.append(h('p', { class: 'tp-empty' }, this.game.net ? 'Nobody else is in this world right now.' : 'You are playing alone. Host this world online to play with friends, then ask to teleport to them here.'));
      return;
    }
    const list = h('ul', { class: 'tp-list' });
    for (const p of peers) {
      list.appendChild(h('li', { class: 'tp-row' },
        h('span', { class: 'tp-dot', style: `--c:${hexColor(p.color)}` }),
        h('div', { class: 'tp-row-main' }, h('strong', null, p.name)),
        h('div', { class: 'tp-row-actions' },
          h('button', {
            class: 'btn btn-sm', 'data-testid': 'tp-ask',
            onclick: (e: Event) => {
              this.send({ op: 'ask', to: p.id });
              const b = e.currentTarget as HTMLButtonElement;
              b.disabled = true;
              b.textContent = 'Asked';
            },
          }, 'Ask to teleport'),
        ),
      ));
    }
    body.appendChild(list);
  }
}

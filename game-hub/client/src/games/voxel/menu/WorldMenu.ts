/**
 * The Voxelvale screen that opens from the hub card: your worlds (saved on
 * this device) and joining others. Full screen, touch first, keyboard friendly
 * (arrows move between worlds, Enter plays, Delete deletes, Esc goes back).
 * Original layout and wording in the hub's style.
 */
import { isValidRoomCode, normalizeRoomCode, type RoomListing, VOXEL_MAX_PLAYERS } from '@hub/shared';
import { audio } from '../../../core/audio/audio';
import { clear, h, removeWithTransition, svg } from '../../../core/ui/dom';
import { dialog, toast } from '../../../core/ui/overlays';
import type { RoomPoller } from '../../../hub/roomPoller';
import { ImportError, type WorldEntry, type WorldLibrary, WORLD_EXTENSION } from '../library/WorldLibrary';
import { askHostOnline, askNewWorld, askRename } from './dialogs';
import { accentFor, drawWorldThumb } from './thumb';

/** What the menu asks the hub to do. */
export interface WorldMenuHost {
  poller: RoomPoller;
  /** False (and the hub says why) when no nickname is set yet. */
  requireNickname(): boolean;
  play(world: WorldEntry): void;
  host(world: WorldEntry, isPublic: boolean): void;
  joinCode(code: string): void;
  quickMatch(mode: 'sandbox' | 'survival'): void;
  parkour(): void;
  onClose(): void;
}

const I = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  import: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 3.6 5.6 3.6 8.5s-1 5.9-3.6 8.5M12 3.5C9.4 6.1 8.4 9.1 8.4 12s1 5.9 3.6 8.5"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V4M6 4h11l-2.5 4L17 12H6"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/></svg>',
  drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 8v6M9 11l3 3 3-3"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>',
  wifiOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M14.5 10.4A10 10 0 0 1 19 13M2 9.5a15 15 0 0 1 4.3-2.7M10 6.1a15 15 0 0 1 12 3.4"/><circle cx="12" cy="20" r="1"/></svg>',
};

const MODE_LABEL = { sandbox: 'Sandbox', survival: 'Survival' } as const;

/** "just now", "5 min ago", "3 h ago", "yesterday", "12 Mar". */
export function playedAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172800) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function playtime(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'Just started';
  if (m < 60) return `${m} min played`;
  return `${Math.floor(m / 60)} h ${m % 60} min played`;
}

export class WorldMenu {
  readonly el: HTMLElement;
  private tab: 'worlds' | 'join' = 'worlds';
  private readonly content: HTMLElement;
  private readonly tabs: HTMLElement;
  private worlds: WorldEntry[] = [];
  private selected = 0;
  private closed = false;
  private busy = false;
  private readonly unsubscribe: () => void;
  private readonly onKeyDown = (e: KeyboardEvent) => this.onKey(e);
  private joinList: HTMLElement | null = null;
  private dropIn: HTMLElement | null = null;

  constructor(
    private readonly lib: WorldLibrary,
    private readonly host: WorldMenuHost,
  ) {
    this.content = h('div', { class: 'vw-content scrollable' });
    this.tabs = h('div', { class: 'segmented vw-tabs', role: 'tablist' });
    this.renderTabs();
    this.el = h('div', { class: 'vw-screen entering', role: 'dialog', 'aria-label': 'Voxelvale', 'data-testid': 'world-menu' },
      h('header', { class: 'vw-bar' },
        h('button', { class: 'icon-btn vw-back', 'aria-label': 'Back to the hub', 'data-testid': 'world-menu-back', onclick: () => this.close() }, svg(I.back)),
        h('div', { class: 'vw-title' },
          svg('<svg viewBox="0 0 64 64"><polygon points="32,6 58,20 32,34 6,20" fill="#5fd17a"/><polygon points="6,20 32,34 32,60 6,46" fill="#2fb3a6"/><polygon points="58,20 32,34 32,60 58,46" fill="#3a9a5a"/></svg>', 'vw-logo'),
          h('h2', null, 'Voxelvale'),
        ),
        this.tabs,
        h('button', { class: 'btn btn-ghost vw-parkour', 'data-testid': 'play-parkour', onclick: () => this.act(() => this.host.parkour()) }, svg(I.flag), h('span', null, 'Parkour')),
      ),
      this.storageBanner(),
      this.content,
    );
    document.body.appendChild(this.el);
    document.addEventListener('keydown', this.onKeyDown);
    requestAnimationFrame(() => this.el.classList.remove('entering'));
    this.unsubscribe = host.poller.subscribe(() => this.renderOnline());
    void this.reload();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    document.removeEventListener('keydown', this.onKeyDown);
    removeWithTransition(this.el, 240);
    this.host.onClose();
  }

  // ---- layout -------------------------------------------------------------------------

  private renderTabs(): void {
    clear(this.tabs);
    const tab = (id: 'worlds' | 'join', label: string) =>
      h('button', {
        class: `seg-btn ${this.tab === id ? 'active' : ''}`,
        role: 'tab',
        'aria-selected': String(this.tab === id),
        'data-testid': `tab-${id}`,
        onclick: () => {
          if (this.tab === id) return;
          this.tab = id;
          audio.play('click');
          this.renderTabs();
          this.render();
        },
      }, label);
    this.tabs.append(tab('worlds', 'Your worlds'), tab('join', 'Join others'));
  }

  private storageBanner(): HTMLElement | null {
    if (this.lib.durable) return null;
    return h('div', { class: 'vw-banner', role: 'status', 'data-testid': 'storage-warning' }, svg(I.warn),
      h('span', null, this.lib.storage.kind === 'memory'
        ? "This browser can't keep worlds: they are gone when you close it. Export them, or install the app."
        : "This browser can't keep worlds safely. Export them, or install the app."));
  }

  private async reload(): Promise<void> {
    this.worlds = await this.lib.list();
    this.selected = Math.min(this.selected, Math.max(0, this.worlds.length - 1));
    if (!this.closed) this.render();
  }

  private render(): void {
    clear(this.content);
    this.joinList = null;
    this.dropIn = null;
    this.content.scrollTop = 0;
    if (this.tab === 'worlds') this.renderWorlds();
    else this.renderJoin();
  }

  // ---- your worlds ------------------------------------------------------------------------

  private renderWorlds(): void {
    const actions = h('div', { class: 'vw-actions' },
      h('button', { class: 'btn btn-primary btn-lg', 'data-testid': 'new-world', onclick: () => void this.newWorld() }, svg(I.plus), 'New world'),
      h('button', { class: 'btn btn-lg', 'data-testid': 'import-world', onclick: () => this.pickImport() }, svg(I.import), 'Import'),
    );
    this.content.appendChild(actions);
    if (this.worlds.length === 0) {
      this.content.appendChild(h('div', { class: 'vw-empty', 'data-testid': 'worlds-empty' },
        h('div', { class: 'vw-empty-art' }, ...[0, 1, 2].map((i) => h('span', { class: `vw-cube c${i}` }))),
        h('h3', null, 'No worlds yet'),
        h('p', null, 'Make one with New world: Sandbox to build freely, Survival to gather, craft and make it through the nights. Worlds are kept on this device; you can take them online any time.'),
      ));
      return;
    }
    const grid = h('div', { class: 'vw-grid', role: 'listbox', 'aria-label': 'Your worlds' });
    this.worlds.forEach((w, i) => grid.appendChild(this.card(w, i)));
    this.content.appendChild(grid);
  }

  private card(w: WorldEntry, i: number): HTMLElement {
    const canvas = h('canvas', { class: 'vw-thumb', 'aria-hidden': 'true' });
    drawWorldThumb(canvas, w.seed, w.mode === 'survival');
    const more = h('button', { class: 'icon-btn vw-more', 'aria-label': `More for ${w.name}`, 'data-testid': 'world-more', onclick: (e: Event) => this.openMore(e, w) }, svg(I.more));
    const card = h('div', {
      class: `vw-card ${i === this.selected ? 'selected' : ''}`,
      role: 'option',
      tabindex: i === this.selected ? '0' : '-1',
      'aria-selected': String(i === this.selected),
      'data-testid': 'world-card',
      'data-world': w.id,
      style: `--wc:${accentFor(w.seed)}`,
      onclick: (e: Event) => {
        if ((e.target as HTMLElement).closest('button')) return;
        this.select(i);
      },
      ondblclick: () => this.act(() => this.host.play(w)),
    },
      h('div', { class: 'vw-thumb-wrap' }, canvas, h('span', { class: `vw-mode vw-mode-${w.mode}` }, MODE_LABEL[w.mode])),
      h('div', { class: 'vw-card-body' },
        h('div', { class: 'vw-card-head' }, h('h3', { class: 'vw-name', title: w.name }, w.name), more),
        h('p', { class: 'vw-sub' },
          `Played ${playedAgo(w.lastPlayed)}`,
          w.mode === 'survival' && w.day > 1 ? ` · Day ${w.day}` : '',
        ),
        h('p', { class: 'vw-sub vw-sub2' }, playtime(w.playtimeMs), w.hostCode ? h('span', { class: 'vw-code', title: 'Online code' }, w.hostCode) : null),
        h('div', { class: 'vw-card-actions' },
          h('button', { class: 'btn btn-primary', 'data-testid': 'play-world', onclick: () => this.act(() => this.host.play(w)) }, svg(I.play), 'Play'),
          h('button', { class: 'btn', 'data-testid': 'host-world', onclick: () => void this.goOnline(w) }, svg(I.globe), 'Play online…'),
        ),
      ),
    );
    return card;
  }

  private select(i: number, focus = false): void {
    this.selected = i;
    this.content.querySelectorAll<HTMLElement>('.vw-card').forEach((c, j) => {
      c.classList.toggle('selected', j === i);
      c.setAttribute('aria-selected', String(j === i));
      c.tabIndex = j === i ? 0 : -1;
      if (j === i && focus) {
        c.focus({ preventScroll: true });
        c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  }

  private openMore(e: Event, w: WorldEntry): void {
    e.stopPropagation();
    document.querySelector('.vw-pop')?.remove();
    const anchor = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const item = (label: string, testId: string, run: () => void, danger = false) =>
      h('button', { class: `vw-pop-item ${danger ? 'danger' : ''}`, role: 'menuitem', 'data-testid': testId, onclick: () => {
        pop.remove();
        run();
      } }, label);
    const pop = h('div', { class: 'vw-pop', role: 'menu' },
      item('Rename', 'world-rename', () => void this.rename(w)),
      item('Duplicate', 'world-duplicate', () => void this.duplicate(w)),
      item('Export file', 'world-export', () => void this.exportWorld(w)),
      item('Delete', 'world-delete', () => void this.remove(w), true),
    );
    const width = 200;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, anchor.right - width))}px`;
    const below = anchor.bottom + 6;
    if (below + 210 > window.innerHeight) pop.style.bottom = `${Math.max(8, window.innerHeight - anchor.top + 6)}px`;
    else pop.style.top = `${below}px`;
    const away = (ev: Event) => {
      if (!pop.contains(ev.target as Node)) {
        pop.remove();
        document.removeEventListener('pointerdown', away, true);
      }
    };
    document.addEventListener('pointerdown', away, true);
    this.el.appendChild(pop);
    (pop.firstElementChild as HTMLElement | null)?.focus();
  }

  // ---- world actions ------------------------------------------------------------------------

  /** Runs a launch action once (double taps start one game). */
  private act(run: () => void): void {
    if (this.busy) return;
    this.busy = true;
    audio.play('click');
    run();
    window.setTimeout(() => (this.busy = false), 800);
  }

  private async newWorld(): Promise<void> {
    const opts = await askNewWorld(await this.lib.defaultName());
    if (!opts) return;
    try {
      const w = await this.lib.create(opts);
      this.act(() => this.host.play(w));
    } catch (err) {
      console.error(err);
      toast('Could not make the world: the device storage may be full.', 'error', 5000);
    }
  }

  private async goOnline(w: WorldEntry): Promise<void> {
    if (!this.host.requireNickname()) return;
    const choice = await askHostOnline(w);
    if (choice === null) return;
    this.act(() => this.host.host(w, choice));
  }

  private async rename(w: WorldEntry): Promise<void> {
    const name = await askRename(w.name);
    if (!name) return;
    await this.lib.rename(w.id, name);
    await this.reload();
  }

  private async duplicate(w: WorldEntry): Promise<void> {
    try {
      const copy = await this.lib.duplicate(w.id);
      if (copy) toast(`Made "${copy.name}".`, 'success', 2200);
    } catch {
      toast('Could not copy the world: the device storage may be full.', 'error', 4000);
    }
    await this.reload();
  }

  private async remove(w: WorldEntry): Promise<void> {
    const ok = await dialog(`Delete "${w.name}"?`, 'The world and everything built in it is removed from this device. Export it first if you want a copy.', [
      { label: 'Keep it', value: '' },
      { label: 'Delete', value: 'yes', danger: true },
    ], { testId: 'confirm-delete' });
    if (ok !== 'yes') return;
    await this.lib.remove(w.id);
    toast(`Deleted "${w.name}".`, 'info', 2000);
    await this.reload();
  }

  private async exportWorld(w: WorldEntry): Promise<void> {
    const file = await this.lib.exportFile(w.id);
    if (!file) return;
    const blob = new Blob([file.bytes as BlobPart], { type: 'application/octet-stream' });
    // iPhone/iPad: the share sheet ("Save to Files"); everywhere else a download.
    const asFile = typeof File === 'function' ? new File([blob], file.fileName, { type: 'application/octet-stream' }) : null;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios && asFile && navigator.canShare?.({ files: [asFile] })) {
      try {
        await navigator.share({ files: [asFile], title: w.name });
        return;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: file.fileName, style: 'display:none' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    toast(`Exported ${file.fileName}. Import it on any device to keep playing.`, 'success', 4000);
  }

  private pickImport(): void {
    const input = h('input', { type: 'file', accept: `${WORLD_EXTENSION},application/octet-stream`, style: 'display:none', 'data-testid': 'import-input' });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return;
      try {
        const entry = await this.lib.importFile(new Uint8Array(await f.arrayBuffer()), f.name);
        toast(`Imported "${entry.name}".`, 'success', 2500);
        this.tab = 'worlds';
        this.selected = 0;
        await this.reload();
      } catch (err) {
        toast(err instanceof ImportError ? err.message : 'Could not import that file.', 'error', 4500);
      }
    });
    this.el.appendChild(input);
    input.click();
  }

  // ---- join others ---------------------------------------------------------------------------

  private renderJoin(): void {
    const code = h('input', {
      class: 'code-input vw-code-input', type: 'text', inputmode: 'text', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
      maxlength: '6', placeholder: 'ABC123', 'aria-label': 'World code', 'data-testid': 'join-world-code',
    });
    const go = () => {
      const c = normalizeRoomCode(code.value);
      if (!isValidRoomCode(c)) {
        toast('Codes are 6 letters and numbers, like K7PX2M.', 'error');
        code.focus();
        return;
      }
      if (this.host.requireNickname()) this.act(() => this.host.joinCode(c));
    };
    code.addEventListener('input', () => (code.value = normalizeRoomCode(code.value)));
    code.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') go();
      if (e.key === 'Escape') code.blur();
    });
    this.joinList = h('div', { class: 'vw-rooms' });
    this.dropIn = h('div', { class: 'vw-dropin' });
    this.content.append(
      h('section', { class: 'vw-panel vw-join-code' },
        h('h3', null, 'Got a code from a friend?'),
        h('div', { class: 'join-code-row' }, code, h('button', { class: 'btn btn-primary', 'data-testid': 'join-world', onclick: go }, 'Join')),
      ),
      h('section', { class: 'vw-panel' },
        h('h3', null, 'Open worlds'),
        h('p', { class: 'vw-hint' }, 'Worlds players are hosting right now and have made Public.'),
        this.joinList,
      ),
      h('section', { class: 'vw-panel' },
        h('h3', null, 'Drop-in worlds'),
        h('p', { class: 'vw-hint' }, 'Shared worlds run by the game server for anyone to jump into. They are not yours to keep: they start over when the server restarts.'),
        this.dropIn,
      ),
    );
    this.renderOnline();
    this.host.poller.refresh();
  }

  private renderOnline(): void {
    const list = this.joinList;
    const drop = this.dropIn;
    if (!list || !drop) return;
    const { data, error, waking } = this.host.poller.snapshot();
    clear(list);
    clear(drop);
    if (waking || error || !data) {
      const msg = waking
        ? 'The game server is waking up, which can take a minute or two.'
        : error
          ? 'Game server unreachable. Your worlds still work offline.'
          : 'Looking for worlds…';
      list.appendChild(h('div', { class: 'room-empty', 'data-testid': 'join-offline' }, error ? svg(I.wifiOff) : null, msg));
    } else {
      const hosted = data.rooms.filter((r) => r.game === 'voxel' && r.hosted);
      if (!hosted.length) list.appendChild(h('div', { class: 'room-empty' }, 'Nobody is hosting a Public world right now. Host one of yours with Play online…'));
      for (const r of hosted) list.appendChild(this.roomRow(r));
    }
    const counts = (mode: string) => data?.rooms.filter((r) => r.game === 'voxel' && !r.hosted && r.mode === mode).reduce((n, r) => n + r.clients, 0) ?? 0;
    for (const mode of ['sandbox', 'survival'] as const) {
      drop.appendChild(h('button', {
        class: `vw-drop vw-drop-${mode}`,
        'data-testid': `quick-${mode}`,
        disabled: !!error && !waking,
        onclick: () => {
          if (this.host.requireNickname()) this.act(() => this.host.quickMatch(mode));
        },
      },
        svg(I.drop),
        h('span', { class: 'vw-drop-text' }, h('strong', null, `${MODE_LABEL[mode]} drop-in`), h('span', null, data ? `${counts(mode)} playing` : 'Shared server world')),
      ));
    }
  }

  private roomRow(r: RoomListing): HTMLElement {
    const full = r.clients >= (r.maxClients || VOXEL_MAX_PLAYERS) || r.locked;
    return h('div', { class: 'room-row vw-room', 'data-testid': 'open-world' },
      h('div', { class: 'vw-room-main' },
        h('strong', { class: 'vw-room-name' }, r.worldName || 'A world'),
        h('span', { class: 'room-status' }, `${r.hostName ? `${r.hostName}'s` : 'Hosted'} · ${r.mode === 'survival' ? 'Survival' : 'Sandbox'}`),
      ),
      h('span', { class: 'room-count' }, svg(I.user), `${r.clients}`),
      h('button', { class: 'btn btn-sm', disabled: full, onclick: () => this.host.requireNickname() && this.act(() => this.host.joinCode(r.roomId)) }, full ? 'Full' : 'Join'),
    );
  }

  // ---- keyboard -----------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (this.closed || document.querySelector('.modal-backdrop')) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea')) return;
    if (e.key === 'Escape') {
      const pop = this.el.querySelector('.vw-pop');
      if (pop) pop.remove();
      else this.close();
      e.preventDefault();
      return;
    }
    if (this.tab !== 'worlds' || !this.worlds.length) return;
    const cols = this.columns();
    let next = this.selected;
    if (e.key === 'ArrowRight') next++;
    else if (e.key === 'ArrowLeft') next--;
    else if (e.key === 'ArrowDown') next += cols;
    else if (e.key === 'ArrowUp') next -= cols;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = this.worlds.length - 1;
    else if (e.key === 'Enter' && !t?.closest('button')) {
      e.preventDefault();
      const w = this.worlds[this.selected];
      if (w) this.act(() => this.host.play(w));
      return;
    } else if (e.key === 'Delete') {
      const w = this.worlds[this.selected];
      if (w) void this.remove(w);
      return;
    } else return;
    e.preventDefault();
    this.select(Math.max(0, Math.min(this.worlds.length - 1, next)), true);
  }

  /** Cards per row in the grid right now. */
  private columns(): number {
    const cards = [...this.content.querySelectorAll<HTMLElement>('.vw-card')];
    if (cards.length < 2) return 1;
    const top = cards[0].offsetTop;
    const n = cards.findIndex((c) => c.offsetTop !== top);
    return n < 0 ? cards.length : n;
  }
}

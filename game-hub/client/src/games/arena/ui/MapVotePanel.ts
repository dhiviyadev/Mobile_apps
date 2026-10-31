/**
 * Map vote overlay shown before every match (design-arena-maps §5.6): three
 * large cards with a procedural preview, tags, size, live vote pips (filled =
 * player, hollow = bot) and a "Your vote" badge; a ring timer; the reveal
 * (with a tie roll); and the bot difficulty switch. Touch-first: big cards,
 * tap to vote, tap another card to change your mind. Keys 1–3 vote too
 * (MapFx maps them).
 */
import { ARENA_MAPS, type BotDifficulty, VOTE } from '@hub/shared';
import { audio } from '../../../core/audio/audio';
import { isTouchDevice } from '../../../core/device';
import { h, hexColor } from '../../../core/ui/dom';
import { mapThumbnail } from '../render/mapThumbnail';

export interface VoteCardView {
  map: number;
  humans: { name: string; color: number; me: boolean }[];
  bots: number;
}

export interface VoteView {
  stage: 'open' | 'reveal';
  timeLeft: number;
  cards: VoteCardView[];
  /** Map index we voted for (-1 none). */
  myVote: number;
  winner: number;
  tie: boolean;
  /** Candidates that shared the top score (for the tie roll). */
  tied: number[];
  allVoted: boolean;
  /** "1 vs 1 · Practice" / "2 vs 2 · Room ABC123". */
  subtitle: string;
  /** null when the match has no bots. */
  bots: BotDifficulty | null;
  /** Offline, or the online host. */
  canSetBots: boolean;
}

export const BOT_LABELS: Record<BotDifficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
const RING = 2 * Math.PI * 18;
const THUMB_W = 320;
const THUMB_H = 200;

interface Card {
  el: HTMLButtonElement;
  map: number;
  pips: HTMLElement;
  count: HTMLElement;
  key: string;
}

export class MapVotePanel {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly ring: SVGCircleElement;
  private readonly secs: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly bots: HTMLElement;
  private readonly foot: HTMLElement;
  private cards: Card[] = [];
  private candidatesKey = '';
  private open = false;
  /** Vote sent but not yet confirmed by the authority (optimistic highlight). */
  private pending = -1;
  private pendingAt = 0;
  private lastSecond = -1;
  private revealed = false;
  private rollTimer = 0;
  private rollUntil = 0;
  private botsKey = '';
  private footText = '';
  private titleText = '';

  constructor(
    parent: HTMLElement,
    private readonly cb: { onVote(map: number): void; onBots(d: BotDifficulty): void },
  ) {
    this.title = h('div', { class: 'mv-title' });
    this.sub = h('small', { class: 'mv-sub' });
    this.secs = h('span', { class: 'mv-secs' });
    this.timer = h('div', { class: 'mv-timer', 'data-testid': 'vote-timer' }, this.secs);
    this.timer.insertAdjacentHTML(
      'afterbegin',
      `<svg viewBox="0 0 44 44" aria-hidden="true"><circle class="mv-ring-bg" cx="22" cy="22" r="18"/><circle class="mv-ring" cx="22" cy="22" r="18" stroke-dasharray="${RING.toFixed(2)}"/></svg>`,
    );
    this.ring = this.timer.querySelector('.mv-ring') as SVGCircleElement;
    this.grid = h('div', { class: 'mv-grid' });
    this.bots = h('div', { class: 'mv-bots' });
    this.foot = h('div', { class: 'mv-foot', 'data-testid': 'vote-hint' });
    this.el = h('div', { class: 'map-vote hidden', 'data-testid': 'map-vote', role: 'dialog', 'aria-label': 'Map vote' },
      h('div', { class: 'mv-head' }, h('div', { class: 'mv-heading' }, this.title, this.sub), this.timer),
      this.grid,
      this.bots,
      this.foot,
    );
    // Keep taps and clicks on the panel away from the game (look, fire, pointer lock).
    for (const type of ['pointerdown', 'mousedown', 'touchstart', 'wheel'] as const) this.el.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
    parent.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.pending = -1;
    this.lastSecond = -1;
    this.revealed = false;
    this.candidatesKey = '';
    this.el.classList.remove('hidden');
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.el.classList.add('hidden');
    window.clearInterval(this.rollTimer);
  }

  /** Called every frame while open; only touches the DOM when something visible changed. */
  update(v: VoteView): void {
    if (!this.open) return;
    const key = v.cards.map((c) => c.map).join(',');
    if (key !== this.candidatesKey) this.build(v, key);
    // Confirmed (or overridden) votes replace the optimistic one; give the network a moment.
    if (this.pending >= 0 && (v.myVote === this.pending || performance.now() - this.pendingAt > 1500)) this.pending = -1;
    const mine = this.pending >= 0 ? this.pending : v.myVote;
    for (const [i, c] of this.cards.entries()) {
      const view = v.cards[i];
      c.el.classList.toggle('mine', c.map === mine);
      c.el.setAttribute('aria-pressed', String(c.map === mine));
      const pipKey = `${view.humans.map((p) => `${p.name}:${p.color}:${p.me}`).join('|')}#${view.bots}`;
      if (pipKey !== c.key) {
        c.key = pipKey;
        c.pips.replaceChildren(
          ...view.humans.map((p) => h('i', { class: `mv-pip${p.me ? ' me' : ''}`, title: p.name, style: `background:${hexColor(p.color)};border-color:${hexColor(p.color)}` })),
          ...Array.from({ length: view.bots }, () => h('i', { class: 'mv-pip bot', title: 'Bot' })),
        );
        c.count.textContent = String(view.humans.length + view.bots);
      }
    }
    this.updateHead(v);
    this.updateBots(v);
    this.updateFoot(v);
    if (v.stage === 'reveal' && !this.revealed) this.reveal(v);
  }

  private build(v: VoteView, key: string): void {
    this.candidatesKey = key;
    this.revealed = false;
    window.clearInterval(this.rollTimer);
    this.cards = v.cards.map((cv, i) => {
      const map = ARENA_MAPS[cv.map];
      const thumb = h('canvas', { class: 'mv-thumb', width: THUMB_W * 2, height: THUMB_H * 2 }) as HTMLCanvasElement;
      const src = mapThumbnail(map, THUMB_W, THUMB_H);
      thumb.width = src.width;
      thumb.height = src.height;
      thumb.getContext('2d')?.drawImage(src, 0, 0);
      const w = map.bounds.maxX - map.bounds.minX;
      const d = map.bounds.maxZ - map.bounds.minZ;
      const pips = h('span', { class: 'mv-pips' });
      const count = h('strong', { class: 'mv-count' }, '0');
      const el = h('button', {
        class: 'mv-card',
        type: 'button',
        'data-testid': `vote-card-${i}`,
        'data-map': String(cv.map),
        'aria-pressed': 'false',
        onclick: () => this.vote(cv.map),
      },
        h('span', { class: 'mv-key' }, String(i + 1)),
        thumb,
        h('span', { class: 'mv-info' },
          h('h3', { class: 'mv-name' }, map.name),
          h('span', { class: 'mv-tags' }, ...map.tags.map((t) => h('span', { class: 'mv-tag' }, t))),
          h('span', { class: 'mv-size' }, `${w} × ${d} m · ${map.pads.length} pads · ${map.pickups.length} pickups`),
          h('span', { class: 'mv-votes' }, pips, count),
        ),
        h('span', { class: 'mv-badge' }, 'Your vote'),
      ) as HTMLButtonElement;
      return { el, map: cv.map, pips, count, key: '' };
    });
    this.grid.replaceChildren(...this.cards.map((c) => c.el));
  }

  /** A tap or click (or key 1–3 through MapFx). */
  vote(map: number): void {
    if (!this.open || this.revealed) return;
    const card = this.cards.find((c) => c.map === map);
    if (!card || card.el.classList.contains('mine')) return;
    this.pending = map;
    this.pendingAt = performance.now();
    for (const c of this.cards) c.el.classList.toggle('mine', c === card);
    audio.play('vote_cast');
    this.cb.onVote(map);
  }

  private updateHead(v: VoteView): void {
    const title = v.stage === 'reveal' ? `Loading ${ARENA_MAPS[v.winner]?.name ?? ''}…` : 'Vote for the next map';
    if (title !== this.titleText) {
      this.titleText = title;
      this.title.textContent = title;
    }
    if (this.sub.textContent !== v.subtitle) this.sub.textContent = v.subtitle;
    this.timer.classList.toggle('hidden', v.stage === 'reveal');
    if (v.stage !== 'open') return;
    const secs = Math.max(0, Math.ceil(v.timeLeft));
    this.ring.style.strokeDashoffset = String(RING * (1 - Math.max(0, Math.min(1, v.timeLeft / VOTE.time))));
    if (secs !== this.lastSecond) {
      if (this.lastSecond > secs && secs <= 5 && secs > 0) audio.play('vote_tick');
      this.lastSecond = secs;
      this.secs.textContent = String(secs);
      this.timer.classList.toggle('urgent', secs <= 5);
    }
  }

  private updateBots(v: VoteView): void {
    const key = `${v.bots}|${v.canSetBots}`;
    if (key === this.botsKey) return;
    this.botsKey = key;
    this.bots.classList.toggle('hidden', v.bots === null);
    if (v.bots === null) return;
    const current = v.bots;
    this.bots.replaceChildren(
      h('span', { class: 'mv-bots-label' }, 'Bots'),
      v.canSetBots
        ? h('span', { class: 'mv-seg', role: 'group', 'aria-label': 'Bot difficulty' },
            ...(Object.keys(BOT_LABELS) as BotDifficulty[]).map((d) =>
              h('button', {
                type: 'button',
                class: `mv-seg-btn${d === current ? ' on' : ''}`,
                'data-testid': `bots-${d}`,
                'aria-pressed': String(d === current),
                onclick: () => {
                  if (d !== current) this.cb.onBots(d);
                },
              }, BOT_LABELS[d]),
            ),
          )
        : h('span', { class: 'mv-bots-fixed', 'data-testid': 'bots-label' }, BOT_LABELS[current]),
    );
  }

  private updateFoot(v: VoteView): void {
    let text: string;
    if (v.stage === 'reveal') text = `Next map: ${ARENA_MAPS[v.winner]?.name ?? ''}${v.tie ? ' · tie broken at random' : ''}`;
    else if (v.allVoted) text = 'Everyone has voted';
    else text = isTouchDevice() ? 'Tap a map to vote · you can change your vote' : 'Click a map or press 1–3 · you can change your vote';
    if (text !== this.footText) {
      this.footText = text;
      this.foot.textContent = text;
    }
  }

  private reveal(v: VoteView): void {
    this.revealed = true;
    this.pending = -1;
    audio.play('vote_win');
    const finish = () => {
      window.clearInterval(this.rollTimer);
      for (const c of this.cards) {
        c.el.classList.remove('flash');
        c.el.classList.toggle('winner', c.map === v.winner);
        c.el.classList.toggle('loser', c.map !== v.winner);
      }
    };
    const tied = this.cards.filter((c) => v.tied.includes(c.map));
    if (!v.tie || tied.length < 2) return finish();
    // Tie roll: a highlight hops across the tied cards and lands on the winner.
    let i = 0;
    this.rollUntil = performance.now() + 900;
    window.clearInterval(this.rollTimer);
    this.rollTimer = window.setInterval(() => {
      const last = performance.now() >= this.rollUntil;
      const on = last ? tied.find((c) => c.map === v.winner) : tied[i++ % tied.length];
      for (const c of this.cards) c.el.classList.toggle('flash', c === on);
      if (last) finish();
    }, 110);
  }

  dispose(): void {
    window.clearInterval(this.rollTimer);
    this.el.remove();
  }
}

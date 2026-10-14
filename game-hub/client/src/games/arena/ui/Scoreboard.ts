/** Scoreboard overlay (hold Tab or tap the scoreboard button) and end-of-match screen. */
import { clear, h, hexColor } from '../../../core/ui/dom';
import type { MatchInfo, PlayerInfo } from '../backend';

export const TEAM_COLORS = [0xff7a45, 0x4fa3ff];
export const TEAM_NAMES = ['Ember', 'Tide'];

function accuracy(p: PlayerInfo): string {
  return p.shots ? `${Math.round((p.hits / p.shots) * 100)}%` : '–';
}

function rows(players: PlayerInfo[], localId: string, ffa: boolean): HTMLElement[] {
  return players.map((p) =>
    h('tr', { class: `${p.id === localId ? 'me' : ''} ${p.connected ? '' : 'dropped'}` },
      h('td', { class: 'sb-name' }, h('span', { class: 'sb-dot', style: `background:${hexColor(ffa ? p.color : TEAM_COLORS[p.team] ?? p.color)}` }), p.name, p.bot ? h('small', null, ' bot') : null),
      ffa ? h('td', null, String(p.roundWins)) : null,
      h('td', null, String(p.kills)),
      h('td', null, String(p.deaths)),
      h('td', null, String(Math.round(p.damage))),
      h('td', null, accuracy(p)),
    ),
  );
}

export function scoreTable(match: MatchInfo, localId: string): HTMLElement {
  const ffa = match.mode === 'ffa';
  const head = h('tr', null, h('th', null, 'Player'), ffa ? h('th', null, 'Rounds') : null, h('th', null, 'K'), h('th', null, 'D'), h('th', null, 'DMG'), h('th', null, 'ACC'));
  const sorted = [...match.players].sort((a, b) => b.roundWins - a.roundWins || b.kills - a.kills || b.damage - a.damage);
  if (ffa) return h('table', { class: 'sb-table' }, h('thead', null, head), h('tbody', null, rows(sorted, localId, true)));
  return h('div', { class: 'sb-teams' },
    [0, 1].map((t) =>
      h('div', { class: 'sb-team', style: `--team:${hexColor(TEAM_COLORS[t])}` },
        h('div', { class: 'sb-team-head' }, h('span', null, TEAM_NAMES[t]), h('strong', null, String(match.teamWins[t]))),
        h('table', { class: 'sb-table' }, h('thead', null, head.cloneNode(true)), h('tbody', null, rows(sorted.filter((p) => p.team === t), localId, false))),
      ),
    ),
  );
}

export class Scoreboard {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  open = false;

  constructor(parent: HTMLElement) {
    this.body = h('div', { class: 'sb-body' });
    this.el = h('div', { class: 'scoreboard hidden', 'data-testid': 'scoreboard' }, this.body);
    parent.appendChild(this.el);
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.el.classList.toggle('hidden', !open);
  }

  update(match: MatchInfo, localId: string, title: string): void {
    if (!this.open) return;
    clear(this.body);
    this.body.append(h('div', { class: 'sb-title' }, title), scoreTable(match, localId));
  }
}

export class MatchEndScreen {
  readonly el: HTMLElement;
  private visible = false;

  constructor(
    private readonly parent: HTMLElement,
    private readonly onAgain: () => void,
    private readonly onLeave: () => void,
  ) {
    this.el = h('div', { class: 'match-end hidden', 'data-testid': 'match-end' });
    parent.appendChild(this.el);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  show(match: MatchInfo, localId: string, againLabel: string): void {
    this.visible = true;
    const me = match.players.find((p) => p.id === localId);
    let title = 'Draw';
    let kind = 'draw';
    if (match.matchWinner) {
      if (match.mode === 'ffa') {
        const w = match.players.find((p) => p.id === match.matchWinner!.id);
        title = w?.id === localId ? 'Victory!' : `${w?.name ?? 'Someone'} wins`;
        kind = w?.id === localId ? 'win' : 'lose';
      } else {
        const won = me?.team === match.matchWinner.team;
        title = won ? 'Victory!' : 'Defeat';
        kind = won ? 'win' : 'lose';
      }
    }
    const mvp = [...match.players].sort((a, b) => b.kills * 100 + b.damage - (a.kills * 100 + a.damage))[0];
    clear(this.el);
    this.el.append(
      h('div', { class: `me-card ${kind}` },
        h('h1', null, title),
        match.mode === 'ffa' ? null : h('div', { class: 'me-score' }, `${TEAM_NAMES[0]} ${match.teamWins[0]} – ${match.teamWins[1]} ${TEAM_NAMES[1]}`),
        mvp ? h('div', { class: 'me-mvp' }, 'MVP: ', h('strong', null, mvp.name), ` · ${mvp.kills} kills · ${Math.round(mvp.damage)} damage`) : null,
        scoreTable(match, localId),
        h('div', { class: 'me-actions' },
          h('button', { class: 'btn btn-primary btn-lg', 'data-testid': 'play-again', onclick: () => this.onAgain() }, againLabel),
          h('button', { class: 'btn btn-lg btn-danger', onclick: () => this.onLeave() }, 'Leave'),
        ),
      ),
    );
    this.el.classList.remove('hidden');
  }

  hide(): void {
    this.visible = false;
    this.el.classList.add('hidden');
  }

  dispose(): void {
    this.el.remove();
    void this.parent;
  }
}

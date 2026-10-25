/**
 * Map and match-flow presentation: the map vote (panel, 1–3 keys, banner,
 * touch controls out of the way), the bot difficulty switch, the round-1
 * banner with the map name, the scoreboard title and the match-end button
 * label (design-arena-maps §5.6, §6.7).
 */
import { ARENA_MODE_INFO, type ArenaEvent, type BotDifficulty, isBotDifficulty, type Phase, VOTE } from '@hub/shared';
import { settings, type Settings } from '../../../core/settings';
import type { MatchInfo } from '../backend';
import { TEAM_COLORS } from '../ui/Scoreboard';
import { BOT_LABELS, MapVotePanel, type VoteView } from '../ui/MapVotePanel';
import type { ArenaClient, ArenaFeature } from './types';

export class MapFx implements ArenaFeature {
  /** The vote overlay (dev tools and e2e reach in through it). */
  readonly panel: MapVotePanel;
  private touchHidden = false;

  constructor(readonly client: ArenaClient) {
    this.panel = new MapVotePanel(client.container, {
      onVote: (map) => client.backend.castVote(map),
      onBots: (d) => this.setBots(d),
    });
  }

  /** Number-key slot pick for this frame; during the vote keys 1–3 vote instead (null = used up). */
  consumeSlotSelect(i: number | null): number | null {
    const v = this.client.match.vote;
    if (this.client.match.phase !== 'vote' || i === null) return i;
    if (v && v.stage === 'open' && i < v.candidates.length) this.panel.vote(v.candidates[i]);
    return null;
  }

  /** True while a full-screen map overlay (the vote) is up: the click-to-play card stays hidden. */
  overlayOpen(): boolean {
    return this.panel.isOpen;
  }

  scoreboardTitle(m: MatchInfo): string {
    const bots = m.players.some((p) => p.bot) ? ` · Bots: ${BOT_LABELS[m.botDifficulty]}` : '';
    return `${this.client.map.name} · ${m.mode.toUpperCase()}${bots}`;
  }

  /** Label of the match-end screen's main button (a new map vote follows, online and offline). */
  againLabel(): string {
    return 'Play again';
  }

  onPhase(phase: Phase, prev: Phase | null): void {
    const { hud, touch } = this.client;
    if (phase === 'vote') {
      this.panel.show();
      this.panel.update(this.view());
      if (touch && !this.touchHidden) {
        touch.setVisible(false);
        this.touchHidden = true;
      }
      hud.showBanner('Map vote', '', 1200);
      // The round timer starts out showing "1:30"; refresh it so the next HUD update (no timer in the vote) clears it.
      hud.setTimer(0);
      return;
    }
    this.panel.hide();
    if (this.touchHidden) {
      touch?.setVisible(true);
      this.touchHidden = false;
    }
    // The first round of a match names the map it is on.
    if (phase === 'loadout' && this.client.match.round === 1 && prev !== 'loadout') hud.showBanner('Round 1', this.client.map.name, 2200);
  }

  onEvent(e: ArenaEvent): void {
    // The reveal comes through the match state too; this only makes it immediate.
    if (e.type === 'mapVote' && this.panel.isOpen) this.panel.update(this.view());
  }

  update(): void {
    if (this.panel.isOpen && this.client.match.vote) this.panel.update(this.view());
  }

  onSettings(s: Readonly<Settings>, changed: readonly (keyof Settings)[]): void {
    // Offline the settings row changes the practice bots at once; online only the host's switch does.
    if (!this.client.backend.online && changed.includes('arenaBotDifficulty') && isBotDifficulty(s.arenaBotDifficulty) && s.arenaBotDifficulty !== this.client.match.botDifficulty) {
      this.client.backend.setBotDifficulty(s.arenaBotDifficulty);
    }
  }

  dispose(): void {
    this.panel.dispose();
  }

  /** Bot difficulty from the vote panel: applies to this match and is remembered for the next practice. */
  private setBots(d: BotDifficulty): void {
    this.client.backend.setBotDifficulty(d);
    settings.update({ arenaBotDifficulty: d });
  }

  /** What the vote panel shows, from the authoritative match state. */
  private view(): VoteView {
    const m = this.client.match;
    const v = m.vote ?? { stage: 'open' as const, candidates: [], winner: -1, tie: false };
    const { backend } = this.client;
    const ffa = m.mode === 'ffa';
    const me = m.players.find((p) => p.id === backend.localId);
    const cards = v.candidates.map((map) => ({
      map,
      humans: m.players.filter((p) => !p.bot && p.vote === map).map((p) => ({ name: p.name, color: ffa ? p.color : (TEAM_COLORS[p.team] ?? p.color), me: p.id === backend.localId })),
      bots: m.players.filter((p) => p.bot && p.vote === map).length,
    }));
    // Same weighting as the sim: a human vote outranks any number of bot votes.
    const score = cards.map((c) => c.humans.length * VOTE.humanWeight + c.bots);
    const top = Math.max(0, ...score);
    const humans = m.players.filter((p) => !p.bot && p.connected);
    const hasBots = m.players.some((p) => p.bot);
    const code = backend.roomCode();
    return {
      stage: v.stage,
      timeLeft: m.timeLeft,
      cards,
      myVote: me?.vote ?? -1,
      winner: v.winner,
      tie: v.tie,
      tied: cards.filter((_, i) => score[i] === top).map((c) => c.map),
      allVoted: humans.length > 0 && humans.every((p) => p.vote >= 0),
      subtitle: `${ARENA_MODE_INFO[m.mode].label} · ${backend.online && code ? `Room ${code}` : 'Practice'}`,
      bots: hasBots ? m.botDifficulty : null,
      canSetBots: !backend.online || m.hostId === backend.localId,
    };
  }
}

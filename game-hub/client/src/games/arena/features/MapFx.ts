/**
 * Map and match-flow presentation: the map vote (panel, 1–3 keys, banner),
 * scoreboard title and the match-end button label (design-arena-maps §5.6).
 */
import type { MatchInfo } from '../backend';
import type { ArenaClient, ArenaFeature } from './types';

export class MapFx implements ArenaFeature {
  constructor(readonly client: ArenaClient) {}

  /** Number-key slot pick for this frame; returns what is left for weapon slots (null = used up). */
  consumeSlotSelect(i: number | null): number | null {
    return i;
  }

  /** True while a full-screen map overlay (the vote) is up: the click-to-play card stays hidden. */
  overlayOpen(): boolean {
    return false;
  }

  scoreboardTitle(m: MatchInfo): string {
    return `${this.client.map.name} · ${m.mode.toUpperCase()}`;
  }

  /** Label of the match-end screen's main button. */
  againLabel(): string {
    return this.client.backend.online ? 'Rematch (next map)' : 'Next map';
  }

  dispose(): void {
    // Nothing to free yet (the vote panel comes with the map vote).
  }
}

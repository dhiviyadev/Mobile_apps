/**
 * Interactive items presentation: launch pads and pickups (renderers, sounds,
 * HUD flashes, predicted pickup touches). Works entirely through its hooks;
 * see design-arena-maps §4 and design-arena-movement §5.
 */
import type { ArenaClient, ArenaFeature } from './types';

export class ItemsFx implements ArenaFeature {
  constructor(readonly client: ArenaClient) {}

  dispose(): void {
    // Nothing to free yet (pad and pickup renderers come with the items).
  }
}

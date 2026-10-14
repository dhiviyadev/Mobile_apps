/**
 * Schema pieces common to every hub room. Colyseus delta-encodes these into a
 * compact binary patch stream, so they are only used for low-frequency state
 * (names, scores, phases). High-frequency movement uses custom binary messages.
 */
import { MapSchema, Schema, type } from '@colyseus/schema';

export class HubPlayer extends Schema {
  @type('string') name = '';
  @type('uint32') color = 0xffffff;
  /** False while the player's seat is held for auto-reconnect. */
  @type('boolean') connected = true;
  /** True for server-controlled bots (arena). */
  @type('boolean') bot = false;
}

export abstract class HubState<P extends HubPlayer = HubPlayer> extends Schema {
  abstract players: MapSchema<P>;
  @type('string') mode = '';
  @type('string') code = '';
  /** Session id of the player allowed to change room settings. */
  @type('string') hostId = '';
}

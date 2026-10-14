/** Replicated state of an Arcfire Arena room. */
import { MapSchema, type } from '@colyseus/schema';
import { HubPlayer, HubState } from './HubState';

export class ArenaPlayer extends HubPlayer {}

export class ArenaState extends HubState<ArenaPlayer> {
  @type({ map: ArenaPlayer }) players = new MapSchema<ArenaPlayer>();
  /** Match phase: "waiting" until enough players have joined. */
  @type('string') phase = 'waiting';
}

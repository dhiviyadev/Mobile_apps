/**
 * Replicated (schema) state of an Arcfire Arena room: roster, stats, phase
 * and score. High-frequency data (positions, aim, ammo) is NOT here; it goes
 * out as compact per-client binary snapshots at 30 Hz.
 */
import { MapSchema, type } from '@colyseus/schema';
import { HubPlayer, HubState } from './HubState';

export class ArenaPlayer extends HubPlayer {
  @type('uint8') team = 0;
  /** Stable small index used in binary snapshots and spread seeds. */
  @type('uint8') index = 0;
  @type('uint16') kills = 0;
  @type('uint16') deaths = 0;
  @type('uint32') damage = 0;
  @type('uint32') shots = 0;
  @type('uint32') hits = 0;
  @type('uint16') headshots = 0;
  @type('uint8') roundWins = 0;
  @type('uint8') primary = 0;
}

export class ArenaState extends HubState<ArenaPlayer> {
  @type({ map: ArenaPlayer }) players = new MapSchema<ArenaPlayer>();
  @type('string') phase = 'warmup';
  /** Server tick at which the current phase ends (0 = open-ended). */
  @type('uint32') phaseEndTick = 0;
  /** Warmup auto-start countdown target tick (0 = not counting down). */
  @type('uint32') startTick = 0;
  @type('uint8') round = 0;
  @type('uint8') teamWins0 = 0;
  @type('uint8') teamWins1 = 0;
  @type('uint8') mapIndex = 0;
  @type('int8') roundWinnerTeam = -2;
  @type('string') roundWinnerId = '';
  @type('int8') matchWinnerTeam = -2;
  @type('string') matchWinnerId = '';
  /** Humans needed before a public match starts by itself. */
  @type('uint8') minHumans = 2;
  @type('uint8') rematchVotes = 0;
}

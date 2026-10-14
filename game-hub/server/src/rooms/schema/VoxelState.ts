/** Replicated state of a Voxelvale room. */
import { MapSchema, type } from '@colyseus/schema';
import { HubPlayer, HubState } from './HubState';

export class VoxelPlayer extends HubPlayer {}

export class VoxelState extends HubState<VoxelPlayer> {
  @type({ map: VoxelPlayer }) players = new MapSchema<VoxelPlayer>();
  /** World seed: every client generates identical terrain from it. */
  @type('uint32') seed = 0;
}

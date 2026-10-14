/** Replicated state of a Voxelvale room. */
import { MapSchema, type } from '@colyseus/schema';
import { HubPlayer, HubState } from './HubState';

export class VoxelPlayer extends HubPlayer {
  /** Feet position, view angles and movement flags, used for interpolation on other clients. */
  @type('float32') x = 0;
  @type('float32') y = 0;
  @type('float32') z = 0;
  @type('float32') yaw = 0;
  @type('float32') pitch = 0;
  @type('uint8') flags = 0;
  /** Parkour: best finish time in ms (0 = none) and current checkpoint. */
  @type('uint32') bestMs = 0;
  @type('uint8') checkpoint = 0;
}

export class VoxelState extends HubState<VoxelPlayer> {
  @type({ map: VoxelPlayer }) players = new MapSchema<VoxelPlayer>();
  /** World seed: every client generates identical terrain from it. */
  @type('uint32') seed = 0;
  /** Day/night cycle position, 0..1 (updated about once a second). */
  @type('float32') timeOfDay = 0.3;
}

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
  // ---- survival / combat (written by SurvivalRoomHost, WP-B) ----
  /** Entity id in binary combat messages (1..999; 0 = none, parkour). */
  @type('uint16') eid = 0;
  /** Health rounded up (0..20); 20 in sandbox. */
  @type('uint8') hp = 20;
  /** Main-hand and off-hand item ids for third-person models (0 = empty). */
  @type('uint16') held = 0;
  @type('uint16') offhand = 0;
  /** ActFlags: Guard 1, Draw 2, Load 4, Loaded 8, Eat 16, Dead 32, Rest 64, Burning 128. */
  @type('uint8') act = 0;
  /** Increments on every melee swing (remote clients play the swing when it changes). */
  @type('uint8') swing = 0;
}

export class VoxelState extends HubState<VoxelPlayer> {
  @type({ map: VoxelPlayer }) players = new MapSchema<VoxelPlayer>();
  /** World seed: every client generates identical terrain from it. */
  @type('uint32') seed = 0;
  /** Day/night cycle position, 0..1 (updated about once a second). */
  @type('float32') timeOfDay = 0.3;
  /** "saved" when the server keeps the world after the room empties, otherwise "temporary". */
  @type('string') worldKind = 'temporary';
  /**
   * Saved worlds: days the world is kept after the last visit. 0 for temporary
   * worlds, and for saved worlds that last only until the server restarts.
   */
  @type('uint16') saveDays = 0;
  /** Private (code-only) room: the room code is what reopens a saved world. */
  @type('boolean') privateRoom = false;
  /** Terrain generator version of this world (1 = original, 2 = biomes; world area). */
  @type('uint8') genVersion = 1;
  /** Survival RuleFlags (PvP 1, KeepInventory 2). */
  @type('uint8') rules = 0;
  /** Survival day counter (starts at 1; +1 when timeOfDay wraps or a night is skipped). */
  @type('uint16') day = 1;
}

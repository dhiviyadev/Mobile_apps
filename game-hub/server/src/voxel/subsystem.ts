/**
 * Extension points of VoxelRoom. Creatures (ServerEntities, WP-C) and survival
 * (SurvivalRoomHost, WP-B) are subsystems: they live in their own files and the
 * room calls them at fixed points, in a fixed order (entities first, then
 * survival). Neither package edits VoxelRoom.ts.
 */
import type { Client } from '@colyseus/core';
import type { BlockEdit, JoinOptions, MoveUpdate, VoxelMode } from '@hub/shared';
import type { VoxelPlayer, VoxelState } from '../rooms/schema/VoxelState';
import type { ServerVoxelWorld } from './ServerVoxelWorld';

/** What subsystems may use of the room. */
export interface VoxelRoomApi {
  readonly roomId: string;
  readonly mode: VoxelMode;
  readonly isPrivate: boolean;
  readonly state: VoxelState;
  readonly world: ServerVoxelWorld;
  /** Connected clients by sessionId. */
  client(sessionId: string): Client | undefined;
  forEachClient(fn: (client: Client) => void): void;
  /** Registers a binary message handler (sendBytes on the client). */
  onBytes(type: string, handler: (client: Client, bytes: Uint8Array) => void): void;
  /** Registers a JSON message handler. */
  onJson(type: string, handler: (client: Client, data: unknown) => void): void;
  /**
   * Authoritative world edit made by gameplay (boss altar, cascades): setBlock,
   * broadcast with this tick's edits, fluids, then every subsystem's afterEdit with
   * sessionId null. Returns false if the edit budget is exhausted.
   */
  applyServerEdit(x: number, y: number, z: number, id: number): boolean;
  /** Moves a player (respawn): Teleport message + 3 s of movement grace. */
  teleport(sessionId: string, x: number, y: number, z: number): void;
  /** Extra seconds of movement grace (knockback, respawn). */
  graceUntil(sessionId: string, ms: number): void;
  systemChat(text: string): void;
  /** Something worth saving changed (inventories, tamed creatures) even without block edits. */
  markDirty(): void;
  log: { info(msg: string): void; warn(msg: string, err?: unknown): void; error(msg: string, err?: unknown): void; debug(msg: string): void };
}

export interface VoxelSubsystem {
  /** Registers message handlers (called once, in setup). */
  bind?(): void;
  /** A saved spawn position for this joiner (survival: PLYR record by playerKey), else null. */
  spawnFor?(options: JoinOptions): { x: number; y: number; z: number } | null;
  join?(client: Client, player: VoxelPlayer, options: JoinOptions): void;
  reconnect?(client: Client, player: VoxelPlayer): void;
  leave?(sessionId: string): void;
  /** Extra checks after the room's own (mode, rate, world, placement, reach). Return a reason to reject. */
  validateEdit?(sessionId: string, e: BlockEdit, current: number): string | null;
  /** After an edit was applied (sessionId null for server edits). */
  afterEdit?(sessionId: string | null, e: BlockEdit, before: number): void;
  /** Cells removed by the world's support cascade after an edit (drops as if harvested by hand). */
  blocksRemoved?(cells: readonly BlockEdit[], before: readonly number[]): void;
  /** Every Move: accepted (pose applied) or rejected (snapped back). */
  move?(sessionId: string, m: MoveUpdate, accepted: boolean): void;
  /** Extra horizontal b/s allowed right now (knockback grace). */
  moveAllowance?(sessionId: string, now: number): number;
  /** Start of the tick, before anything moves (record player history). */
  preTick?(dtMs: number): void;
  /** Simulation step (20 Hz), before this tick's edits are broadcast. */
  tick?(dtMs: number): void;
  /** Adds this subsystem's CVW2 sections (tags from SECTION_TAGS). */
  saveSections?(out: Map<string, Uint8Array>): void;
  /** The sections of the restored save (all tags; take yours, ignore the rest). */
  restoreSections?(sections: ReadonlyMap<string, Uint8Array>): void;
  /** True when there is something to save although no block was edited. */
  hasProgress?(): boolean;
  dispose?(): void;
}

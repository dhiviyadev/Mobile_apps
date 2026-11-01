/**
 * What the survival controller talks to (design-voxel-survival §15.1):
 * LocalSurvival runs the shared SurvivalSim in the browser (offline), and
 * NetSurvival sends intents to the server and decodes its replies. Both hand
 * back the same event shapes, so the controller has one code path.
 */
import type { AttackIntent, ClientEvent, DeadMessage, InteractKind, InvOp, InvSyncData, PlayerBody, ShootIntent, VitalsData } from '@hub/shared';

export type PrivateEvent =
  | ({ type: 'inv' } & InvSyncData)
  | ({ type: 'vitals' } & VitalsData)
  | { type: 'container'; open: boolean; x: number; y: number; z: number; sealed: boolean }
  | ({ type: 'dead' } & DeadMessage)
  /** A message for this player only (offline; online these arrive as system chat). */
  | { type: 'notice'; text: string };

export interface SurvivalBackend {
  /** Sandbox: weapons without vitals or inventory. */
  readonly creative: boolean;
  readonly online: boolean;
  /** Our wire id (offline 1). */
  localEid(): number;
  /** Offline: advance the sim (fixed 20 Hz). Online: nothing. */
  update(dt: number, paused: boolean): void;
  /** Offline: a physics step of the local body. Online: nothing (Move carries it). */
  pose(body: PlayerBody, yaw: number, pitch: number, crouch: boolean, sprint: boolean, climbing: boolean): void;
  hand(slot: number, flags: number, creativeItem: number): void;
  digStart(x: number, y: number, z: number): void;
  attack(a: AttackIntent): void;
  shoot(s: ShootIntent): void;
  invOp(seq: number, op: InvOp): void;
  interact(kind: InteractKind, x: number, y: number, z: number): void;
  respawn(): void;
  setRules(r: { pvp?: boolean; keepInventory?: boolean }): void;
  /** Offline: a local edit was applied (player = the local player made it). */
  afterLocalEdit(x: number, y: number, z: number, before: number, after: number, player: boolean): void;
  takeEvents(): ClientEvent[];
  takePrivate(): PrivateEvent[];
  rules(): { pvp: boolean; keepInventory: boolean };
  day(): number;
  /** May change the room rules (offline: always; online: host of a private survival room). */
  canSetRules(): boolean;
  /** The PvP rule can be changed here (online private rooms only). */
  pvpConfigurable(): boolean;
  /** Offline save payload. */
  saveData(): unknown;
  dispose(): void;
}

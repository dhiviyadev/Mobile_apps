/**
 * Online survival: encodes the player's intents (hd k s g i x r rules) and
 * decodes the server's replies (S I vt C dead) into the backend event shapes.
 * The server runs the authoritative SurvivalSim (SurvivalRoomHost).
 */
import {
  type AttackIntent,
  asBytes,
  type ClientEvent,
  type DeadMessage,
  decodeContainer,
  decodeInvSync,
  decodeSurvivalEvents,
  decodeVitals,
  encodeAttack,
  encodeCell,
  encodeHand,
  encodeInteract,
  encodeInvOp,
  encodeShoot,
  type InteractKind,
  type InvOp,
  RuleFlags,
  type ShootIntent,
  VoxelMsg,
} from '@hub/shared';
import type { NetSession } from '../../../net/session';
import type { PrivateEvent, SurvivalBackend } from './SurvivalBackend';

export class NetSurvival implements SurvivalBackend {
  readonly online = true;
  private readonly events: ClientEvent[] = [];
  private readonly priv: PrivateEvent[] = [];
  private readonly offs: (() => void)[] = [];

  constructor(
    private readonly session: NetSession,
    readonly creative: boolean,
  ) {
    const bytes = (fn: (b: Uint8Array) => void) => (m: unknown) => {
      const b = asBytes(m);
      if (!b) return;
      try {
        fn(b);
      } catch {
        /* malformed message */
      }
    };
    this.offs.push(
      session.onMessage(VoxelMsg.SurvivalEvents, bytes((b) => this.events.push(...decodeSurvivalEvents(b)))),
      session.onMessage(VoxelMsg.InvSync, bytes((b) => this.priv.push({ type: 'inv', ...decodeInvSync(b) }))),
      session.onMessage(VoxelMsg.Vitals, bytes((b) => this.priv.push({ type: 'vitals', ...decodeVitals(b) }))),
      session.onMessage(VoxelMsg.Container, bytes((b) => this.priv.push({ type: 'container', ...decodeContainer(b) }))),
      session.onMessage(VoxelMsg.Dead, (m: DeadMessage) => {
        if (m && typeof m.cause === 'string') this.priv.push({ type: 'dead', cause: m.cause, satchel: m.satchel ?? null });
      }),
    );
  }

  private get me(): { eid?: number } | undefined {
    return this.session.state?.players?.get(this.session.sessionId);
  }

  localEid(): number {
    return this.me?.eid ?? 0;
  }

  update(): void {}
  pose(): void {}

  hand(slot: number, flags: number, creativeItem: number): void {
    this.session.sendBytes(VoxelMsg.Hand, encodeHand(slot, flags, creativeItem));
  }

  digStart(x: number, y: number, z: number): void {
    this.session.sendBytes(VoxelMsg.DigStart, encodeCell(x, y, z));
  }

  attack(a: AttackIntent): void {
    this.session.sendBytes(VoxelMsg.Attack, encodeAttack(a));
  }

  shoot(s: ShootIntent): void {
    this.session.sendBytes(VoxelMsg.Shoot, encodeShoot(s));
  }

  invOp(seq: number, op: InvOp): void {
    this.session.sendBytes(VoxelMsg.InvOp, encodeInvOp(seq, op));
  }

  interact(kind: InteractKind, x: number, y: number, z: number): void {
    this.session.sendBytes(VoxelMsg.Interact, encodeInteract(kind, x, y, z));
  }

  respawn(): void {
    this.session.sendBytes(VoxelMsg.Respawn, new Uint8Array([0]));
  }

  setRules(r: { pvp?: boolean; keepInventory?: boolean }): void {
    this.session.send(VoxelMsg.Rules, r);
  }

  afterLocalEdit(): void {}

  takeEvents(): ClientEvent[] {
    return this.events.splice(0);
  }

  takePrivate(): PrivateEvent[] {
    return this.priv.splice(0);
  }

  rules(): { pvp: boolean; keepInventory: boolean } {
    const f = (this.session.state?.rules as number) ?? 0;
    return { pvp: (f & RuleFlags.PvP) !== 0, keepInventory: (f & RuleFlags.KeepInventory) !== 0 };
  }

  day(): number {
    return (this.session.state?.day as number) ?? 1;
  }

  canSetRules(): boolean {
    const s = this.session.state;
    return !this.creative && !!s?.privateRoom && s?.hostId === this.session.sessionId;
  }

  pvpConfigurable(): boolean {
    return this.canSetRules();
  }

  saveData(): unknown {
    return undefined;
  }

  dispose(): void {
    for (const off of this.offs) off();
  }
}

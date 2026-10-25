/**
 * Interactive items presentation (design-arena-maps §4): launch pads and
 * pickups. Draws them (PadRenderer, PickupRenderer), plays their sounds,
 * flashes the HUD when we collect something, and hides a pickup the moment
 * our predicted player touches it (cosmetic: HP and ammo only change when
 * the authority says so).
 */
import type { ArenaEvent, ArenaMap, BoxWorld, CommandEvents, LaunchPad, Phase, PickupKind, PlayerSim } from '@hub/shared';
import { audio, type SfxName } from '../../../core/audio/audio';
import { PadRenderer } from '../render/PadRenderer';
import { PickupRenderer, PREDICT_HIDE_TICKS } from '../render/PickupRenderer';
import type { ArenaClient, ArenaFeature } from './types';

/** Sound per pad kind: trampoline boing, launcher whoosh, speed-strip zip. */
export function padSound(pad: LaunchPad): SfxName {
  return pad.horizontal === 'keep' ? 'pad' : pad.horizontal === 'set' ? 'pad_launch' : 'pad_boost';
}

const PICKUP_SOUND: Record<PickupKind, SfxName> = { health: 'pickup_health', ammo: 'pickup_ammo' };

export class ItemsFx implements ArenaFeature {
  readonly pads: PadRenderer;
  /** Pickup models; `pickups.isVisible(i)` is what e2e tests read. */
  readonly pickups: PickupRenderer;

  constructor(readonly client: ArenaClient) {
    this.pads = new PadRenderer(client.scene);
    this.pickups = new PickupRenderer(client.scene);
  }

  onMapLoaded(map: ArenaMap, world: BoxWorld): void {
    this.pads.load(map, world);
    this.pickups.load(map);
  }

  onMapDisposed(): void {
    this.pads.clear();
    this.pickups.clear();
  }

  onLocalCommand(ev: CommandEvents, p: PlayerSim): void {
    const c = this.client;
    if (ev.launched >= 0) {
      // Our own launch is predicted; the server's echo of it is ignored.
      const pad = c.world.pads[ev.launched];
      this.pads.pulse(ev.launched);
      if (pad) audio.play(padSound(pad));
    }
    const phase = c.match.phase;
    if (phase !== 'live' && phase !== 'warmup') return;
    const i = this.pickups.predictTouch(p);
    if (i < 0) return;
    this.pickups.markTaken(i, c.backend.serverTick() + PREDICT_HIDE_TICKS);
    audio.play(PICKUP_SOUND[this.pickups.pickup(i)!.kind]);
  }

  onEvent(e: ArenaEvent): void {
    const c = this.client;
    const me = c.backend.localId;
    const cam = c.camera.position;
    if (e.type === 'launch') {
      if (e.id === me) return;
      const pad = c.world.pads[e.pad];
      if (!pad) return;
      this.pads.pulse(e.pad);
      const at = c.latestPoses.get(e.id) ?? { x: (pad.minX + pad.maxX) / 2, z: (pad.minZ + pad.maxZ) / 2 };
      audio.playAt(padSound(pad), at.x - cam.x, at.z - cam.z, c.yaw, 40, 0.9);
    } else if (e.type === 'pickup') {
      const pk = this.pickups.pickup(e.index);
      this.pickups.confirmTaken(e.index, c.backend.serverTick());
      if (e.id === me) {
        if (!this.pickups.predictedRecently(e.index)) audio.play(PICKUP_SOUND[e.kind]);
        c.hud.pickupFlash(e.kind === 'health' ? `+${e.amount} HP` : '+Ammo', e.kind);
      } else if (pk) {
        audio.playAt(PICKUP_SOUND[e.kind], pk.x - cam.x, pk.z - cam.z, c.yaw, 20, 0.6);
      }
    }
  }

  onPhase(phase: Phase): void {
    // New round, warmup or vote: everything the authority reset is back at once.
    if (phase === 'loadout' || phase === 'warmup' || phase === 'vote') this.pickups.clearOverrides();
  }

  update(dt: number): void {
    const c = this.client;
    this.pads.update(dt);
    const back = this.pickups.update(dt, c.match.pickupReady, c.backend.serverTick());
    // Respawn chime for nearby pickups (not when a new round brings them all back).
    const phase = c.match.phase;
    if (back.length && (phase === 'live' || phase === 'warmup')) {
      const cam = c.camera.position;
      for (const i of back) {
        const pk = this.pickups.pickup(i)!;
        audio.playAt('pickup_spawn', pk.x - cam.x, pk.z - cam.z, c.yaw, 25, 0.5);
      }
    }
  }

  dispose(): void {
    this.pads.dispose();
    this.pickups.dispose();
  }
}

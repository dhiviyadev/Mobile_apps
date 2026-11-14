/**
 * The Eclipse Colossus (package D): the guardian of the Eclipse Orrery in the
 * Gloamreach. Three phases; every attack telegraphs first.
 *   Umbra Drop      - shadows fall on every player (circles, then a slam)
 *   Prism Volley    - fans of cold glint bolts
 *   Eclipse Pulse   - a ring of force around the Colossus (twice in phase 3)
 *   Call the Hushed - two Hushwalkers rise at the arena's corners
 *   Orbit Sweep     - a crossed beam that sweeps round (phases 2 and 3)
 */
import { DamageKind } from '../../combat';
import { ProjectileKind } from '../api';
import { BurstKind, EntityEventType, MobAction, MobKind, MobVariant, TelegraphShape } from '../types';
import { fan, summonAt } from './attacks';
import type { BossController, BossScript } from './boss';

const ALL = 7;
const P23 = 6;

const BEAM = 16;

/** Hurts players on the four arms of a cross turned by `yaw`. */
function sweepHit(b: BossController, yaw: number, key: string): void {
  const m = b.mob;
  for (let k = 0; k < 4; k++) {
    const a = yaw + (k * Math.PI) / 2;
    const ex = m.x - Math.sin(a) * BEAM;
    const ez = m.z - Math.cos(a) * BEAM;
    for (const p of b.playersOnLine(m.x, m.z, ex, ez, 0.9)) {
      const mark = `${key}_${p.id}`;
      if (b.data[mark]) continue;
      b.data[mark] = 1;
      b.w.hurtPlayer(p.id, { amount: 6, kind: DamageKind.Burst, attacker: m.ref, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 4, lift: 6, unblockable: true });
    }
    for (let d = 3; d <= BEAM; d += 4) b.w.emit({ type: EntityEventType.Burst, kind: BurstKind.Rupture, x: m.x - Math.sin(a) * d, y: b.floorY, z: m.z - Math.cos(a) * d, radius: 1 });
  }
}

export const eclipseColossus: BossScript = {
  kind: MobKind.EclipseColossus,
  title: 'Warden of the Eclipse Orrery',
  phaseAt: [0.6, 0.3],
  hover: 0.8,
  preferred: 9,
  phase3: { cooldownMul: 0.7, telegraphMul: 0.8 },
  attacks: [
    {
      id: 1, name: 'Umbra Drop', phases: ALL, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.3, active: 0.2, recover: 0.9, cooldown: 6, action: MobAction.Cast,
      begin: (b) => {
        const pts: { x: number; y: number; z: number }[] = [];
        for (const t of b.targets().slice(0, 3)) {
          pts.push({ x: t.x, y: b.floorY, z: t.z });
          if (b.phase >= 2) pts.push({ x: t.x + t.vx * 1.3, y: b.floorY, z: t.z + t.vz * 1.3 });
        }
        while (pts.length < 3) {
          const p = b.randomArenaPoint(0);
          pts.push({ x: p.x, y: b.floorY, z: p.z });
        }
        b.points = pts.slice(0, b.phase === 3 ? 7 : 5);
        return b.points.map((p) => b.tele(TelegraphShape.Circle, p.x, p.z, 2.4));
      },
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        for (const p of b.points) b.slam(p.x, p.z, 2.4, 7, 5, 6, BurstKind.Impact);
      },
    },
    {
      id: 2, name: 'Prism Volley', phases: ALL, minRange: 4, maxRange: 24, weight: 4,
      telegraph: 0.8, active: 1.4, recover: 0.7, cooldown: 5, action: MobAction.Cast,
      begin: () => [],
      update: (b, t) => {
        const waves = b.phase + 1;
        const k = Math.floor(t / 0.4);
        if (k >= waves || (b.data.k ?? -1) >= k) return;
        b.data.k = k;
        fan(b, ProjectileKind.GlintBolt, b.phase === 1 ? 5 : 7, 54, 16, 4, 2, b.mob.y + 2.6);
      },
    },
    {
      id: 3, name: 'Eclipse Pulse', phases: ALL, minRange: 0, maxRange: 8, weight: 4,
      telegraph: 1.1, active: 0.9, recover: 0.9, cooldown: 7, action: MobAction.Slam,
      begin: (b) => [b.tele(TelegraphShape.Ring, b.mob.x, b.mob.z, 7)],
      update: (b, t) => {
        const m = b.mob;
        if (!b.data.done) {
          b.data.done = 1;
          b.slam(m.x, m.z, 7, 6, 8, 5, BurstKind.Pulse);
          if (b.phase === 3) b.emitTelegraph(b.tele(TelegraphShape.Ring, m.x, m.z, 10.5, { seconds: 0.7 }));
        }
        if (b.phase === 3 && t >= 0.7 && !b.data.second) {
          b.data.second = 1;
          b.slam(m.x, m.z, 10.5, 5, 7, 4, BurstKind.Pulse);
        }
      },
    },
    {
      id: 4, name: 'Call the Hushed', phases: ALL, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.3, active: 0.2, recover: 0.8, cooldown: 30, action: MobAction.Summon,
      ready: (b) => b.canSummon(0.75, 2, 30),
      begin: (b) => {
        const a = b.structure.arena;
        const corners = [
          { x: a.x0 + 4.5, z: a.z0 + 4.5 },
          { x: a.x1 - 4.5, z: a.z0 + 4.5 },
          { x: a.x0 + 4.5, z: a.z1 - 4.5 },
          { x: a.x1 - 4.5, z: a.z1 - 4.5 },
        ];
        const t = b.target();
        // The two corners farthest from the player: the Hushed take a moment to reach them.
        corners.sort((p, q) => (t ? Math.hypot(q.x - t.x, q.z - t.z) - Math.hypot(p.x - t.x, p.z - t.z) : 0));
        b.points = corners.slice(0, 2).map((c) => ({ x: c.x, y: b.floorY, z: c.z }));
        return b.points.map((p) => b.tele(TelegraphShape.Marker, p.x, p.z, 1));
      },
      end: (b) => summonAt(b, MobKind.Hushwalker, MobVariant.Default, b.points),
    },
    {
      id: 5, name: 'Orbit Sweep', phases: P23, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.0, active: 1.4, recover: 0.9, cooldown: 9, action: MobAction.Roar,
      begin: (b) => {
        const m = b.mob;
        const yaw = b.w.rng() * Math.PI;
        b.data.yaw = yaw;
        return [0, 1, 2, 3].map((k) => b.tele(TelegraphShape.Line, m.x, m.z, BEAM, { width: 1.8, yaw: yaw + (k * Math.PI) / 2 }));
      },
      update: (b, t) => {
        const m = b.mob;
        if (!b.data.first) {
          b.data.first = 1;
          sweepHit(b, b.data.yaw, 'a');
          // The cross turns an eighth: the second sweep is announced at once.
          for (const k of [0, 1, 2, 3]) b.emitTelegraph(b.tele(TelegraphShape.Line, m.x, m.z, BEAM, { width: 1.8, yaw: b.data.yaw + Math.PI / 4 + (k * Math.PI) / 2, seconds: 0.8 }));
        }
        if (t >= 0.85 && !b.data.second) {
          b.data.second = 1;
          sweepHit(b, b.data.yaw + Math.PI / 4, 'b');
        }
      },
    },
  ],
};

/**
 * The four bosses of the generator-4 ruins (package S): Brineclaw Matriarch
 * (Saltworn Lighthouse), Stormtalon (Stormcrown Aerie), Bramblehorn Elder
 * (Hollowheart Grove) and Anvilheart Colossus (Cinderdeep Forge). Same
 * framework as scripts.ts: three phases, every attack telegraphs first.
 */
import { DamageKind, StatusKind } from '../../combat';
import { HazardKind, ProjectileKind } from '../api';
import { BurstKind, EntityEventType, MobAction, MobKind, MobVariant, TelegraphShape } from '../types';
import { beginCharge, fan, lob, summonAt, updateCharge } from './attacks';
import type { BossController, BossScript } from './boss';

const ALL = 7;
const P23 = 6;
const P3 = 4;

/** Yaw (boss convention: facing -Z at 0) from the boss toward its target. */
function yawToTarget(b: BossController): number {
  const t = b.target();
  return t ? Math.atan2(-(t.x - b.mob.x), -(t.z - b.mob.z)) : b.mob.yaw;
}

/** Everyone inside `radius` is hauled toward (cx, cz): a hit whose source lies behind the target. */
function pull(b: BossController, cx: number, cz: number, radius: number, damage: number, kb: number): void {
  const m = b.mob;
  for (const p of b.targets()) {
    const d = Math.hypot(p.x - cx, p.z - cz);
    if (d > radius || d < 0.5 || Math.abs(p.y - b.floorY) > 2.5) continue;
    const k = 2;
    b.w.hurtPlayer(p.id, { amount: damage, kind: DamageKind.Burst, attacker: m.ref, fromX: p.x + ((p.x - cx) / d) * k, fromY: m.y + 1, fromZ: p.z + ((p.z - cz) / d) * k, knockback: kb, lift: 2, unblockable: true });
  }
}

/** Floor point near the target for an emergence or strike, kept inside the arena. */
function nearTarget(b: BossController, spread: number): { x: number; z: number } {
  const t = b.target();
  if (!t) return b.randomArenaPoint(0);
  for (let i = 0; i < 8; i++) {
    const x = t.x + (b.w.rng() * 2 - 1) * spread;
    const z = t.z + (b.w.rng() * 2 - 1) * spread;
    if (b.grid.isOpen(x, z)) return { x, z };
  }
  return { x: t.x, z: t.z };
}

// ---- Brineclaw Matriarch ----------------------------------------------------------------------

const brineclaw: BossScript = {
  kind: MobKind.BrineclawMatriarch,
  title: 'Matriarch of the Saltworn Lighthouse',
  phaseAt: [0.55, 0.25],
  hover: 0,
  preferred: 4,
  phase3: { cooldownMul: 0.75, speedMul: 1.25 },
  attacks: [
    {
      id: 1, name: 'Claw Crush', phases: ALL, minRange: 0, maxRange: 4.5, weight: 5,
      telegraph: 0.7, active: 0.4, recover: 0.6, cooldown: 2.8, action: MobAction.Attack,
      begin: (b) => {
        const yaw = yawToTarget(b);
        b.data.yaw = yaw;
        return [b.tele(TelegraphShape.Arc, b.mob.x, b.mob.z, 4.5, { yaw, halfAngle: Math.PI / 3 })];
      },
      update: (b, t) => {
        if (t < 0.12 || b.data.done) return;
        b.data.done = 1;
        b.arcHit(4.5, Math.PI / 3, b.data.yaw, 6, 7, 3);
      },
    },
    {
      id: 2, name: 'Riptide', phases: ALL, minRange: 0, maxRange: 99, weight: 3,
      telegraph: 1.3, active: 1.1, recover: 0.8, cooldown: 11, action: MobAction.Cast,
      begin: (b) => [b.tele(TelegraphShape.Circle, b.mob.x, b.mob.z, 8)],
      update: (b, t) => {
        if (!b.data.pulled) {
          b.data.pulled = 1;
          pull(b, b.mob.x, b.mob.z, 8, 1, 11);
          b.w.emit({ type: EntityEventType.Burst, kind: BurstKind.Pulse, x: b.mob.x, y: b.floorY, z: b.mob.z, radius: 8 });
        }
        if (t >= 0.8 && !b.data.slammed) {
          b.data.slammed = 1;
          b.slam(b.mob.x, b.mob.z, 3.6, 8, 8, 6, BurstKind.Slam);
        }
      },
    },
    {
      id: 3, name: 'Tidal Surge', phases: ALL, minRange: 3, maxRange: 20, weight: 4,
      telegraph: 1.0, active: 0.4, recover: 0.9, cooldown: 8, action: MobAction.Slam,
      begin: (b) => {
        const yaw = yawToTarget(b);
        b.data.yaw = yaw;
        return [b.tele(TelegraphShape.Line, b.mob.x, b.mob.z, 16, { width: 5, yaw })];
      },
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        const m = b.mob;
        const yaw = b.data.yaw;
        const ex = m.x - Math.sin(yaw) * 16;
        const ez = m.z - Math.cos(yaw) * 16;
        for (const p of b.playersOnLine(m.x, m.z, ex, ez, 2.5)) {
          b.w.hurtPlayer(p.id, { amount: 6, kind: DamageKind.Burst, attacker: m.ref, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 12, lift: 4, unblockable: true });
        }
        for (let d = 3; d <= 15; d += 3) {
          const x = m.x - Math.sin(yaw) * d;
          const z = m.z - Math.cos(yaw) * d;
          b.w.emit({ type: EntityEventType.Burst, kind: BurstKind.Hail, x, y: b.floorY, z, radius: 1.5 });
          if (b.phase >= 2 && b.grid.isOpen(x, z)) b.w.hazards.spawn({ kind: HazardKind.FrostPatch, x, y: b.floorY, z, radius: 1.6, seconds: 5, dps: 0, slow: 0.4, team: m.team, owner: m.ref });
        }
      },
    },
    {
      id: 4, name: 'Call the Drowned', phases: ALL, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.3, active: 0.2, recover: 0.8, cooldown: 30, action: MobAction.Summon,
      ready: (b) => b.canSummon(0.75, 2, 30),
      begin: (b) => {
        const a = b.structure.arena;
        const cx = (a.x0 + a.x1) / 2;
        const cz = (a.z0 + a.z1) / 2;
        const r = Math.min(a.x1 - a.x0, a.z1 - a.z0) / 2 - 2.5;
        const base = b.w.rng() * Math.PI * 2;
        b.points = [0, 1].map((i) => ({ x: cx + Math.cos(base + i * Math.PI) * r, y: b.floorY, z: cz + Math.sin(base + i * Math.PI) * r }));
        return b.points.map((p) => b.tele(TelegraphShape.Marker, p.x, p.z, 1));
      },
      end: (b) => summonAt(b, MobKind.Mudlurch, MobVariant.Frost, b.points),
    },
    {
      id: 5, name: 'Sand Burrow', phases: P23, minRange: 0, maxRange: 99, weight: 8,
      telegraph: 0.8, active: 1.6, recover: 0.8, cooldown: 18, action: MobAction.Burrow,
      begin: (b) => {
        const p = nearTarget(b, 2);
        b.points = [{ x: p.x, y: b.floorY, z: p.z }];
        return [];
      },
      update: (b, t) => {
        b.underground = true;
        const p = b.points[0];
        if (t >= 0.8 && !b.data.marked) {
          b.data.marked = 1;
          b.emitTelegraph(b.tele(TelegraphShape.Circle, p.x, p.z, 3.2, { seconds: 0.8 }));
        }
      },
      end: (b) => {
        const p = b.points[0];
        b.underground = false;
        b.mob.x = p.x;
        b.mob.z = p.z;
        b.mob.setAction(MobAction.Emerge, 1);
        b.slam(p.x, p.z, 3.2, 7, 6, 6, BurstKind.Emerge);
      },
    },
    {
      id: 6, name: 'Whirlpool Claw', phases: P3, minRange: 0, maxRange: 6, weight: 6,
      telegraph: 0.9, active: 0.6, recover: 0.9, cooldown: 9, action: MobAction.Slam,
      begin: (b) => [b.tele(TelegraphShape.Circle, b.mob.x, b.mob.z, 6)],
      update: (b, t) => {
        if (!b.data.pulled) {
          b.data.pulled = 1;
          pull(b, b.mob.x, b.mob.z, 6, 2, 8);
        }
        if (t >= 0.35 && !b.data.slammed) {
          b.data.slammed = 1;
          b.slam(b.mob.x, b.mob.z, 4.4, 8, 9, 6, BurstKind.Nova, [{ kind: StatusKind.Slow, strength: 0.4, seconds: 2.5 }]);
        }
      },
    },
  ],
};

// ---- Stormtalon ---------------------------------------------------------------------------------

const stormtalon: BossScript = {
  kind: MobKind.Stormtalon,
  title: 'Tyrant of the Stormcrown Aerie',
  phaseAt: [0.55, 0.25],
  hover: 1.3,
  preferred: 6,
  phase3: { cooldownMul: 0.7, speedMul: 1.3 },
  attacks: [
    {
      id: 1, name: 'Wing Buffet', phases: ALL, minRange: 0, maxRange: 5.5, weight: 5,
      telegraph: 0.9, active: 0.2, recover: 0.8, cooldown: 4.5, action: MobAction.Slam,
      begin: (b) => [b.tele(TelegraphShape.Circle, b.mob.x, b.mob.z, 5.5)],
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        b.slam(b.mob.x, b.mob.z, 5.5, 4, 13, 7, BurstKind.Pulse);
      },
    },
    {
      id: 2, name: 'Gale Volley', phases: ALL, minRange: 4, maxRange: 24, weight: 4,
      telegraph: 0.7, active: 1.2, recover: 0.7, cooldown: 5, action: MobAction.Cast,
      begin: () => [],
      update: (b, t) => {
        const waves = b.phase === 3 ? 3 : 2;
        const k = Math.floor(t / 0.45);
        if (k >= waves || (b.data.k ?? -1) >= k) return;
        b.data.k = k;
        fan(b, ProjectileKind.IceShard, 5, 60, 17, 3, 2, b.mob.y + 1.6);
      },
    },
    {
      id: 3, name: 'Talon Dive', phases: ALL, minRange: 5, maxRange: 22, weight: 4,
      telegraph: 1.0, active: 3, recover: 0.6, cooldown: 7, action: MobAction.Charge,
      begin: (b) => beginCharge(b, 2, 16),
      update: (b, _t, dt) => updateCharge(b, dt, { speed: 15, width: 2, damage: 7, kb: 9, lift: 4, stun: 3 }),
    },
    {
      id: 4, name: 'Lightning Call', phases: ALL, minRange: 0, maxRange: 99, weight: 3,
      telegraph: 1.4, active: 0.2, recover: 0.9, cooldown: 9, action: MobAction.Cast,
      begin: (b) => {
        const pts: { x: number; y: number; z: number }[] = [];
        for (const t of b.targets().slice(0, 3)) pts.push({ x: t.x, y: b.floorY, z: t.z });
        const extra = b.phase === 3 ? 4 : b.phase === 2 ? 2 : 1;
        for (let i = 0; i < extra; i++) {
          const p = b.randomArenaPoint(0);
          pts.push({ x: p.x, y: b.floorY, z: p.z });
        }
        b.points = pts;
        return pts.map((p) => b.tele(TelegraphShape.Circle, p.x, p.z, 1.9));
      },
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        for (const p of b.points) b.slam(p.x, p.z, 1.9, 7, 3, 5, BurstKind.Impact, [{ kind: StatusKind.Burn, strength: 1, seconds: 1.5 }]);
      },
    },
    {
      id: 5, name: 'Updraft', phases: P23, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.2, active: 0.2, recover: 0.8, cooldown: 10, action: MobAction.Cast,
      begin: (b) => {
        const pts = b.targets().slice(0, 3).map((t) => ({ x: t.x + t.vx * 1.2, y: b.floorY, z: t.z + t.vz * 1.2 }));
        while (pts.length < 2) {
          const p = b.randomArenaPoint(0);
          pts.push({ x: p.x, y: b.floorY, z: p.z });
        }
        b.points = pts;
        return pts.map((p) => b.tele(TelegraphShape.Circle, p.x, p.z, 2.6));
      },
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        for (const p of b.points) b.slam(p.x, p.z, 2.6, 3, 1, 15, BurstKind.Hail);
      },
    },
    {
      id: 6, name: 'Call the Flock', phases: ALL, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.3, active: 0.2, recover: 0.8, cooldown: 30, action: MobAction.Summon,
      ready: (b) => b.canSummon(0.7, 2, 30),
      begin: (b) => {
        const a = b.structure.arena;
        b.points = [
          { x: a.x0 + 2, y: b.floorY + 2, z: a.z0 + 2 },
          { x: a.x1 - 2, y: b.floorY + 2, z: a.z1 - 2 },
        ];
        return b.points.map((p) => b.tele(TelegraphShape.Marker, p.x, p.z, 1));
      },
      end: (b) => summonAt(b, MobKind.Duskwing, MobVariant.Default, b.points),
    },
  ],
};

// ---- Bramblehorn Elder ---------------------------------------------------------------------------

const elder: BossScript = {
  kind: MobKind.BramblehornElder,
  title: 'Elder of the Hollowheart Grove',
  phaseAt: [0.55, 0.25],
  hover: 0,
  preferred: 3.5,
  phase3: { cooldownMul: 0.75, speedMul: 1.3 },
  attacks: [
    {
      id: 1, name: 'Antler Gore', phases: ALL, minRange: 0, maxRange: 4.5, weight: 5,
      telegraph: 0.7, active: 0.4, recover: 0.6, cooldown: 3, action: MobAction.Attack,
      begin: (b) => {
        const yaw = yawToTarget(b);
        b.data.yaw = yaw;
        return [b.tele(TelegraphShape.Arc, b.mob.x, b.mob.z, 4.5, { yaw, halfAngle: (55 * Math.PI) / 180 })];
      },
      update: (b, t) => {
        if (t < 0.12 || b.data.done) return;
        b.data.done = 1;
        b.arcHit(4.5, (55 * Math.PI) / 180, b.data.yaw, 7, 8, 4);
      },
    },
    {
      id: 2, name: 'Rootsnare', phases: ALL, minRange: 3, maxRange: 24, weight: 4,
      telegraph: 1.0, active: 0.2, recover: 0.7, cooldown: 7, action: MobAction.Cast,
      begin: (b) => {
        const pts = b.targets().slice(0, 3).map((t) => ({ x: t.x + t.vx * 0.9, y: b.floorY, z: t.z + t.vz * 0.9 }));
        if (!pts.length) {
          const p = b.randomArenaPoint(0);
          pts.push({ x: p.x, y: b.floorY, z: p.z });
        }
        b.points = pts;
        return pts.map((p) => b.tele(TelegraphShape.Circle, p.x, p.z, 1.8));
      },
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        for (const p of b.points) {
          b.slam(p.x, p.z, 1.8, 4, 1, 4, BurstKind.Seed, [{ kind: StatusKind.Slow, strength: 0.6, seconds: 3 }]);
          b.w.hazards.spawn({ kind: HazardKind.ThornPatch, x: p.x, y: b.floorY, z: p.z, radius: 1.5, seconds: 6, dps: 1, slow: 0.5, team: b.mob.team, owner: b.mob.ref });
        }
      },
    },
    {
      id: 3, name: 'Root Wave', phases: ALL, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.1, active: 0.3, recover: 0.9, cooldown: 9, action: MobAction.Slam,
      begin: (b) => {
        const yaw = yawToTarget(b) + (b.phase === 3 ? Math.PI / 6 : 0);
        b.data.yaw = yaw;
        return [0, 1, 2, 3, 4, 5].map((k) => b.tele(TelegraphShape.Line, b.mob.x, b.mob.z, 12, { width: 1.6, yaw: yaw + (k * Math.PI) / 3 }));
      },
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        const m = b.mob;
        for (let k = 0; k < 6; k++) {
          const yaw = b.data.yaw + (k * Math.PI) / 3;
          const ex = m.x - Math.sin(yaw) * 12;
          const ez = m.z - Math.cos(yaw) * 12;
          for (const p of b.playersOnLine(m.x, m.z, ex, ez, 0.8)) {
            if (b.data[`r_${p.id}`]) continue;
            b.data[`r_${p.id}`] = 1;
            b.w.hurtPlayer(p.id, { amount: 6, kind: DamageKind.Burst, attacker: m.ref, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 3, lift: 8, unblockable: true });
          }
          for (let d = 2; d <= 12; d += 3.3) b.w.emit({ type: EntityEventType.Burst, kind: BurstKind.Rupture, x: m.x - Math.sin(yaw) * d, y: b.floorY, z: m.z - Math.cos(yaw) * d, radius: 1 });
        }
      },
    },
    {
      id: 4, name: 'Stomp', phases: ALL, minRange: 0, maxRange: 6, weight: 4,
      telegraph: 1.0, active: 0.2, recover: 1.0, cooldown: 8, action: MobAction.Slam,
      begin: (b) => [b.tele(TelegraphShape.Circle, b.mob.x, b.mob.z, 5.5)],
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        const m = b.mob;
        b.slam(m.x, m.z, 5.5, 7, 9, 5, BurstKind.Slam);
        const n = b.phase === 3 ? 7 : 4;
        for (let i = 0; i < n; i++) {
          const a = b.w.rng() * Math.PI * 2;
          const r = 2.5 + b.w.rng() * 4;
          const x = m.x + Math.cos(a) * r;
          const z = m.z + Math.sin(a) * r;
          if (b.grid.isOpen(x, z)) b.w.hazards.spawn({ kind: HazardKind.ThornPatch, x, y: b.floorY, z, radius: 1.5, seconds: 8, dps: 2, slow: 0.3, team: m.team, owner: m.ref });
        }
      },
    },
    {
      id: 5, name: 'Call the Hollow', phases: ALL, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.2, active: 0.2, recover: 0.8, cooldown: 30, action: MobAction.Summon,
      ready: (b) => b.canSummon(0.75, 2, 30),
      begin: (b) => {
        const a = b.structure.arena;
        const cx = (a.x0 + a.x1) / 2;
        const cz = (a.z0 + a.z1) / 2;
        const base = b.w.rng() * Math.PI * 2;
        b.points = [0, 1].map((i) => ({ x: cx + Math.cos(base + i * Math.PI) * 6, y: b.floorY, z: cz + Math.sin(base + i * Math.PI) * 6 }));
        return b.points.map((p) => b.tele(TelegraphShape.Marker, p.x, p.z, 1));
      },
      end: (b) => summonAt(b, MobKind.Puffcap, MobVariant.Moss, b.points),
    },
    {
      id: 6, name: 'Stampede', phases: P23, minRange: 6, maxRange: 18, weight: 3,
      telegraph: 1.0, active: 3, recover: 0.7, cooldown: 10, action: MobAction.Charge,
      begin: (b) => beginCharge(b, 2.4, 16),
      update: (b, _t, dt) => updateCharge(b, dt, { speed: 11, width: 2.4, damage: 8, kb: 9, lift: 4, stun: 2.5, again: b.phase === 3 }),
    },
  ],
};

// ---- Anvilheart Colossus ----------------------------------------------------------------------------

const colossus: BossScript = {
  kind: MobKind.AnvilheartColossus,
  title: 'Heart of the Cinderdeep Forge',
  phaseAt: [0.55, 0.25],
  hover: 0,
  preferred: 4.5,
  phase3: { cooldownMul: 0.75, telegraphMul: 0.85 },
  attacks: [
    {
      id: 1, name: 'Hammerfall', phases: ALL, minRange: 0, maxRange: 5.5, weight: 5,
      telegraph: 1.1, active: 0.2, recover: 1.0, cooldown: 4.5, action: MobAction.Slam,
      begin: (b) => [b.tele(TelegraphShape.Circle, b.mob.x, b.mob.z, 4.8)],
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        b.slam(b.mob.x, b.mob.z, 4.8, 8, 9, 5, BurstKind.Slam);
      },
    },
    {
      id: 2, name: 'Slag Lob', phases: ALL, minRange: 4, maxRange: 24, weight: 4,
      telegraph: 1.0, active: 1.4, recover: 0.8, cooldown: 7, action: MobAction.Cast,
      begin: (b) => {
        const n = b.phase === 3 ? 5 : b.phase === 2 ? 4 : 3;
        const targets = b.targets();
        b.points = [];
        for (let i = 0; i < n && targets.length; i++) {
          const t = targets[i % targets.length];
          const p = { x: t.x + (b.w.rng() * 2 - 1) * 2, y: b.floorY, z: t.z + (b.w.rng() * 2 - 1) * 2 };
          b.points.push(p);
        }
        return b.points.map((p) => b.tele(TelegraphShape.Circle, p.x, p.z, 1.6, { seconds: b.telegraphTime() + 1.1 }));
      },
      update: (b, t) => {
        const m = b.mob;
        if (!b.data.lobbed) {
          b.data.lobbed = 1;
          for (const p of b.points) lob(b, ProjectileKind.Ember, m.x, m.y + 3.0, m.z, p.x, b.floorY, p.z, 1.1, 4);
        }
        if (t >= 1.15 && !b.data.pools) {
          b.data.pools = 1;
          for (const p of b.points) b.w.hazards.spawn({ kind: HazardKind.FireTrail, x: p.x, y: b.floorY, z: p.z, radius: 1.6, seconds: 7, dps: 2, slow: 0, team: m.team, owner: m.ref });
        }
      },
    },
    {
      id: 3, name: 'Furnace Breath', phases: ALL, minRange: 0, maxRange: 9, weight: 4,
      telegraph: 1.2, active: 0.9, recover: 0.9, cooldown: 8, action: MobAction.Cast,
      begin: (b) => {
        const yaw = yawToTarget(b);
        b.data.yaw = yaw;
        return [b.tele(TelegraphShape.Arc, b.mob.x, b.mob.z, 9, { yaw, halfAngle: (38 * Math.PI) / 180 })];
      },
      update: (b, t) => {
        const k = Math.floor(t / 0.3);
        if (k > 2 || (b.data.k ?? -1) >= k) return;
        b.data.k = k;
        const m = b.mob;
        for (const p of b.targets()) {
          const dx = p.x - m.x;
          const dz = p.z - m.z;
          const d = Math.hypot(dx, dz);
          if (d > 9 + p.halfWidth || d < 0.2) continue;
          const fx = -Math.sin(b.data.yaw);
          const fz = -Math.cos(b.data.yaw);
          if ((dx * fx + dz * fz) / d < Math.cos((38 * Math.PI) / 180)) continue;
          b.w.hurtPlayer(p.id, { amount: 3, kind: DamageKind.Fire, attacker: m.ref, fromX: m.x, fromY: m.y + 1.5, fromZ: m.z, knockback: 3, lift: 1, effects: [{ kind: StatusKind.Burn, strength: 1, seconds: 2.5 }] });
        }
        b.w.emit({ type: EntityEventType.Burst, kind: BurstKind.Impact, x: m.x - Math.sin(b.data.yaw) * (3 + k * 2.5), y: b.floorY, z: m.z - Math.cos(b.data.yaw) * (3 + k * 2.5), radius: 1.8 });
      },
    },
    {
      id: 4, name: 'Anvil Shockwave', phases: P23, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.2, active: 1.4, recover: 1.0, cooldown: 11, action: MobAction.Slam,
      begin: (b) => [b.tele(TelegraphShape.Circle, b.mob.x, b.mob.z, 3.8)],
      update: (b, t) => {
        const m = b.mob;
        if (!b.data.first) {
          b.data.first = 1;
          b.slam(m.x, m.z, 3.8, 8, 7, 5, BurstKind.Slam);
          b.emitTelegraph(b.tele(TelegraphShape.Ring, m.x, m.z, 8, { seconds: 0.7 }));
        }
        if (t >= 0.7 && !b.data.second) {
          b.data.second = 1;
          // The ring: everyone between 4 and 8 blocks from the colossus.
          for (const p of b.targets()) {
            const d = Math.hypot(p.x - m.x, p.z - m.z);
            if (d < 4 || d > 8.2 || Math.abs(p.y - b.floorY) > 1.6) continue;
            b.w.hurtPlayer(p.id, { amount: 6, kind: DamageKind.Burst, attacker: m.ref, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 9, lift: 5, unblockable: true });
          }
          for (let a = 0; a < 8; a++) b.w.emit({ type: EntityEventType.Burst, kind: BurstKind.Rupture, x: m.x + Math.cos((a * Math.PI) / 4) * 6, y: b.floorY, z: m.z + Math.sin((a * Math.PI) / 4) * 6, radius: 1.4 });
        }
      },
    },
    {
      id: 5, name: 'Call the Forgeborn', phases: ALL, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.3, active: 0.2, recover: 0.8, cooldown: 30, action: MobAction.Summon,
      ready: (b) => b.canSummon(0.75, 2, 30),
      begin: (b) => {
        const s = b.structure.bossSpawn;
        b.points = [
          { x: s.x - 6, y: b.floorY, z: s.z + 6 },
          { x: s.x + 6, y: b.floorY, z: s.z + 6 },
        ];
        return b.points.map((p) => b.tele(TelegraphShape.Marker, p.x, p.z, 1));
      },
      end: (b) => summonAt(b, MobKind.Mudlurch, MobVariant.Ash, b.points),
    },
    {
      id: 6, name: 'Molten Rain', phases: P3, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.4, active: 0.2, recover: 0.9, cooldown: 10, action: MobAction.Cast,
      begin: (b) => {
        const pts: { x: number; y: number; z: number }[] = [];
        for (const t of b.targets().slice(0, 3)) pts.push({ x: t.x, y: b.floorY, z: t.z });
        while (pts.length < 6) {
          const p = b.randomArenaPoint(0);
          pts.push({ x: p.x, y: b.floorY, z: p.z });
        }
        b.points = pts;
        return pts.map((p) => b.tele(TelegraphShape.Circle, p.x, p.z, 1.7));
      },
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        for (const p of b.points) {
          b.slam(p.x, p.z, 1.7, 5, 3, 3, BurstKind.Hail, [{ kind: StatusKind.Burn, strength: 1, seconds: 2 }]);
          b.w.hazards.spawn({ kind: HazardKind.FireTrail, x: p.x, y: b.floorY, z: p.z, radius: 1.2, seconds: 4, dps: 2, slow: 0, team: b.mob.team, owner: b.mob.ref });
        }
      },
    },
  ],
};

export const RUIN_BOSS_SCRIPTS: Readonly<Partial<Record<MobKind, BossScript>>> = {
  [MobKind.BrineclawMatriarch]: brineclaw,
  [MobKind.Stormtalon]: stormtalon,
  [MobKind.BramblehornElder]: elder,
  [MobKind.AnvilheartColossus]: colossus,
};

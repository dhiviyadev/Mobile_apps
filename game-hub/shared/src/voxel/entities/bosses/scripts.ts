/**
 * The four bosses (design-voxel-mobs §7.2-7.5): Sunforged Sentinel (Sunscorch
 * Temple), Rime Warden (Frost Citadel), Thornmaw (Overgrown Shrine) and Ashen
 * Knight (Ashen Crypt). Every attack telegraphs before it deals damage.
 */
import { DamageKind, StatusKind } from '../../combat';
import { StructureType } from '../../structures/types';
import { HazardKind, ProjectileKind } from '../api';
import { BurstKind, EntityEventType, MobAction, MobKind, MobVariant, TelegraphShape } from '../types';
import { beginCharge, fan, lob, summonAt, updateCharge } from './attacks';
import type { BossController, BossScript, Telegraph } from './boss';

const ALL = 7;
const P23 = 6;
const P3 = 4;

// ---- Sunforged Sentinel ----------------------------------------------------------------

const sentinel: BossScript = {
  kind: MobKind.SunforgedSentinel,
  title: 'Guardian of the Sunscorch Temple',
  phaseAt: [0.5, 0.2],
  hover: 0,
  preferred: 5,
  phase3: { cooldownMul: 0.7, speedMul: 1.3 },
  attacks: [
    {
      id: 1, name: 'Sunfall Slam', phases: ALL, minRange: 0, maxRange: 4.5, weight: 3,
      telegraph: 1.0, active: 0.15, recover: 1.2, cooldown: 5, action: MobAction.Slam,
      begin: (b) => [b.tele(TelegraphShape.Circle, b.mob.x, b.mob.z, 4.5)],
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        b.slam(b.mob.x, b.mob.z, 4.5, 6, 7, 6, BurstKind.Slam);
      },
    },
    {
      id: 2, name: 'Glare Volley', phases: ALL, minRange: 5, maxRange: 20, weight: 3,
      telegraph: 0.8, active: 1.2, recover: 0.8, cooldown: 6, action: MobAction.Cast,
      begin: () => [],
      update: (b, t) => {
        const waves = b.phase;
        const wave = Math.floor(t / 0.5);
        if (wave >= waves || (b.data.wave ?? -1) >= wave) return;
        b.data.wave = wave;
        fan(b, ProjectileKind.SunBolt, 5, 50, 14, 4, 3, b.mob.y + 2.4);
      },
    },
    {
      id: 3, name: 'Call the Sandguard', phases: ALL, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.5, active: 0.2, recover: 0.8, cooldown: 30, action: MobAction.Summon,
      ready: (b) => b.canSummon(0.75, 2, 30),
      begin: (b) => {
        const t = b.target();
        const pts = [...b.pillars].sort((p, q) => (t ? Math.hypot(q.x - t.x, q.z - t.z) - Math.hypot(p.x - t.x, p.z - t.z) : 0)).slice(0, 2);
        const s = b.structure.bossSpawn;
        b.points = (pts.length >= 2 ? pts : [{ x: s.x - 5, z: s.z - 5 }, { x: s.x + 5, z: s.z - 5 }]).map((p) => {
          // Stand at the pillar's base, toward the arena centre.
          const dx = s.x - p.x;
          const dz = s.z - p.z;
          const l = Math.hypot(dx, dz) || 1;
          return { x: p.x + (dx / l) * 1.5, y: b.floorY, z: p.z + (dz / l) * 1.5 };
        });
        return b.points.map((p) => b.tele(TelegraphShape.Marker, p.x, p.z, 1));
      },
      end: (b) => summonAt(b, MobKind.Rattlebow, MobVariant.Sand, b.points),
    },
    {
      id: 4, name: 'Whirling Charge', phases: P23, minRange: 6, maxRange: 18, weight: 3,
      telegraph: 0.9, active: 3, recover: 0.6, cooldown: 7, action: MobAction.Charge,
      begin: (b) => beginCharge(b, 2, 14),
      update: (b, _t, dt) => updateCharge(b, dt, { speed: 11, width: 2, damage: 5, kb: 9, lift: 4, stun: 2 }),
    },
  ],
};

// ---- Rime Warden -----------------------------------------------------------------------

const warden: BossScript = {
  kind: MobKind.RimeWarden,
  title: 'Keeper of the Frost Citadel',
  phaseAt: [0.5, 0.25],
  hover: 0.6,
  preferred: 8,
  attacks: [
    {
      id: 1, name: 'Shard Volley', phases: ALL, minRange: 4, maxRange: 22, weight: 4,
      telegraph: 0.6, active: 1.4, recover: 0.6, cooldown: 4.5, action: MobAction.Cast,
      begin: () => [],
      update: (b, t) => {
        const bursts = b.phase === 3 ? 4 : 3;
        const k = Math.floor(t / 0.35);
        if (k >= bursts || (b.data.k ?? -1) >= k) return;
        b.data.k = k;
        fan(b, ProjectileKind.IceShard, 3, 12, 18, 3, 2, b.mob.y + 2);
      },
    },
    {
      id: 2, name: 'Frost Nova', phases: ALL, minRange: 0, maxRange: 5, weight: 4,
      telegraph: 1.1, active: 0.15, recover: 0.8, cooldown: 7, action: MobAction.Slam,
      begin: (b) => [b.tele(TelegraphShape.Circle, b.mob.x, b.mob.z, 5)],
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        b.slam(b.mob.x, b.mob.z, 5, 5, 6, 3, BurstKind.Nova, [{ kind: StatusKind.Slow, strength: 0.5, seconds: 3 }]);
        const n = b.phase === 3 ? 5 : 3;
        for (let i = 0; i < n; i++) {
          const a = b.w.rng() * Math.PI * 2;
          const r = 2 + b.w.rng() * 4;
          const x = b.mob.x + Math.cos(a) * r;
          const z = b.mob.z + Math.sin(a) * r;
          if (b.grid.isOpen(x, z)) b.w.hazards.spawn({ kind: HazardKind.FrostPatch, x, y: b.floorY, z, radius: 1.8, seconds: 6, dps: 0, slow: 0.4, team: b.mob.team, owner: b.mob.ref });
        }
        b.data.blinkSoon = 1;
        b.cooldowns.set(4, 0);
        (b as BossController & { blinkAfterNova?: boolean }).blinkAfterNova = true;
      },
    },
    {
      id: 3, name: 'Raise the Frozen', phases: ALL, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.2, active: 0.2, recover: 0.8, cooldown: 25, action: MobAction.Summon,
      ready: (b) => b.canSummon(0.7, 3, 25),
      begin: (b) => {
        const a = b.structure.arena;
        const cx = (a.x0 + a.x1) / 2;
        const cz = (a.z0 + a.z1) / 2;
        const r = Math.min(a.x1 - a.x0, a.z1 - a.z0) / 2 - 2;
        const base = b.w.rng() * Math.PI * 2;
        b.points = [0, 1, 2].map((i) => {
          const ang = base + (i * Math.PI * 2) / 3;
          return { x: cx + Math.cos(ang) * r, y: b.floorY, z: cz + Math.sin(ang) * r };
        });
        return b.points.map((p) => b.tele(TelegraphShape.Marker, p.x, p.z, 1));
      },
      end: (b) => summonAt(b, MobKind.Mudlurch, MobVariant.Frost, b.points),
    },
    {
      id: 4, name: 'Blink', phases: P23, minRange: 0, maxRange: 99, weight: 6,
      telegraph: 0.5, active: 0.4, recover: 0.3, cooldown: 6, action: MobAction.Cast,
      ready: (b) => b.closeTime > 2 || !!(b as BossController & { blinkAfterNova?: boolean }).blinkAfterNova,
      begin: (b) => {
        (b as BossController & { blinkAfterNova?: boolean }).blinkAfterNova = false;
        const p = b.randomArenaPoint(8);
        b.points = [{ x: p.x, y: b.floorY, z: p.z }];
        return [b.tele(TelegraphShape.Marker, p.x, p.z, 1.2)];
      },
      end: (b) => {
        const p = b.points[0];
        if (!p) return;
        b.mob.x = p.x;
        b.mob.z = p.z;
        b.w.emit({ type: EntityEventType.Burst, kind: BurstKind.Pulse, x: p.x, y: b.floorY, z: p.z, radius: 1.2 });
      },
    },
    {
      id: 5, name: 'Hailstorm', phases: P23, minRange: 0, maxRange: 99, weight: 3,
      telegraph: 1.4, active: 0.15, recover: 0.8, cooldown: 9, action: MobAction.Cast,
      begin: (b) => {
        const pts: { x: number; y: number; z: number }[] = [];
        for (const t of b.targets().slice(0, 3)) {
          pts.push({ x: t.x, y: b.floorY, z: t.z });
          pts.push({ x: t.x + t.vx * 1.4, y: b.floorY, z: t.z + t.vz * 1.4 });
        }
        while (pts.length < 6) {
          const p = b.randomArenaPoint(0);
          pts.push({ x: p.x, y: b.floorY, z: p.z });
        }
        b.points = pts.slice(0, 6);
        return b.points.map((p) => b.tele(TelegraphShape.Circle, p.x, p.z, 1.5));
      },
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        for (const p of b.points) b.slam(p.x, p.z, 1.5, 5, 2, 1, BurstKind.Hail, [{ kind: StatusKind.Slow, strength: 0.35, seconds: 2.5 }]);
      },
    },
  ],
};

// ---- Thornmaw ---------------------------------------------------------------------------

const thornmaw: BossScript = {
  kind: MobKind.Thornmaw,
  title: 'Heart of the Overgrown Shrine',
  phaseAt: [0.55, 0.25],
  hover: 0,
  rooted: true,
  preferred: 0,
  onPhase: (b, phase) => {
    if (phase === 2) b.cooldowns.set(4, 0);
  },
  attacks: [
    {
      id: 1, name: 'Vine Lash', phases: ALL, minRange: 0, maxRange: 6, weight: 4,
      telegraph: 0.7, active: 0.4, recover: 0.5, cooldown: 3.5, action: MobAction.Attack,
      begin: (b) => {
        const t = b.target();
        const yaw = t ? Math.atan2(-(t.x - b.mob.x), -(t.z - b.mob.z)) : b.mob.yaw;
        b.data.yaw = yaw;
        return [b.tele(TelegraphShape.Arc, b.mob.x, b.mob.z, 6, { yaw, halfAngle: (70 * Math.PI) / 180 })];
      },
      update: (b, t) => {
        if (t < 0.15 || b.data.done) return;
        b.data.done = 1;
        b.arcHit(6, (70 * Math.PI) / 180, b.data.yaw, 5, 7, 4);
      },
    },
    {
      id: 2, name: 'Seed Barrage', phases: ALL, minRange: 4, maxRange: 20, weight: 4,
      telegraph: 0.7, active: 0.3, recover: 0.6, cooldown: 5, action: MobAction.Cast,
      begin: (b) => {
        const n = b.phase >= 2 ? 6 : 4;
        const targets = b.targets();
        const out: Telegraph[] = [];
        b.points = [];
        for (let i = 0; i < n && targets.length; i++) {
          const t = targets[i % targets.length];
          const x = t.x + (b.w.rng() * 2 - 1) * 2.5;
          const z = t.z + (b.w.rng() * 2 - 1) * 2.5;
          b.points.push({ x, y: b.floorY, z });
          out.push(b.tele(TelegraphShape.Marker, x, z, 2.2, { seconds: b.telegraphTime() + 1.1 }));
        }
        return out;
      },
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        const m = b.mob;
        for (const p of b.points) lob(b, ProjectileKind.SeedPod, m.x, m.y + 2.6, m.z, p.x, b.floorY, p.z, 1.1, 0);
      },
    },
    {
      id: 3, name: 'Sporelings', phases: ALL, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.0, active: 0.2, recover: 0.6, cooldown: 30, action: MobAction.Summon,
      ready: (b) => b.canSummon(0.75, 2, 30),
      begin: (b) => {
        const pools = [...b.pools].sort(() => b.w.rng() - 0.5).slice(0, 2);
        b.points = pools.map((p) => ({ x: p.x, y: b.floorY, z: p.z }));
        return b.points.map((p) => b.tele(TelegraphShape.Marker, p.x, p.z, 1));
      },
      end: (b) => summonAt(b, MobKind.Puffcap, MobVariant.Moss, b.points),
    },
    {
      id: 4, name: 'Burrow', phases: P23, minRange: 0, maxRange: 99, weight: 8,
      telegraph: 0.8, active: 1.5, recover: 0.8, cooldown: 20, action: MobAction.Burrow,
      begin: (b) => {
        const m = b.mob;
        const others = b.pools.filter((p) => Math.hypot(p.x - m.x, p.z - m.z) > 3);
        const p = others.length ? others[Math.floor(b.w.rng() * others.length)] : b.pools[0];
        b.points = [{ x: p.x, y: b.floorY, z: p.z }];
        return [];
      },
      update: (b, t) => {
        b.underground = true;
        const p = b.points[0];
        if (t >= 0.7 && !b.data.marked) {
          b.data.marked = 1;
          b.emitTelegraph(b.tele(TelegraphShape.Marker, p.x, p.z, 3, { seconds: 0.8 }));
        }
      },
      end: (b) => {
        const p = b.points[0];
        b.underground = false;
        b.mob.x = p.x;
        b.mob.z = p.z;
        b.mob.setAction(MobAction.Emerge, 1);
        b.slam(p.x, p.z, 3, 4, 6, 5, BurstKind.Emerge);
      },
    },
    {
      id: 5, name: 'Thorn Ring', phases: P3, minRange: 0, maxRange: 99, weight: 3,
      telegraph: 0.6, active: 0.2, recover: 1, cooldown: 8, action: MobAction.Slam,
      begin: (b) => [b.tele(TelegraphShape.Ring, b.mob.x, b.mob.z, 2)],
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        b.w.hazards.spawn({ kind: HazardKind.ThornRing, x: b.mob.x, y: b.floorY, z: b.mob.z, radius: 1, seconds: 11 / 6, dps: 5, slow: 0, team: b.mob.team, owner: b.mob.ref, growRate: 6 });
      },
    },
  ],
};

// ---- Ashen Knight -------------------------------------------------------------------------

const knight: BossScript = {
  kind: MobKind.AshenKnight,
  title: 'Warden of the Ashen Crypt',
  phaseAt: [0.5, 0.2],
  hover: 0,
  preferred: 3,
  phase3: { telegraphMul: 0.75 },
  attacks: [
    {
      id: 1, name: 'Cleave', phases: ALL, minRange: 0, maxRange: 3.5, weight: 5,
      telegraph: 0.6, active: 0.3, recover: 0.6, cooldown: 2.5, action: MobAction.Attack,
      begin: (b) => {
        const t = b.target();
        const yaw = t ? Math.atan2(-(t.x - b.mob.x), -(t.z - b.mob.z)) : b.mob.yaw;
        b.data.yaw = yaw;
        return [b.tele(TelegraphShape.Arc, b.mob.x, b.mob.z, 3.5, { yaw, halfAngle: Math.PI / 3 })];
      },
      update: (b, t) => {
        if (t < 0.1 || b.data.done) return;
        b.data.done = 1;
        b.arcHit(3.5, Math.PI / 3, b.data.yaw, 6, 6, 2);
      },
    },
    {
      id: 2, name: 'Cinder Charge', phases: ALL, minRange: 5, maxRange: 20, weight: 3,
      telegraph: 1.0, active: 4, recover: 0.6, cooldown: 6, action: MobAction.Charge,
      begin: (b) => beginCharge(b, 1.6, 18),
      update: (b, _t, dt) => updateCharge(b, dt, { speed: 12, width: 1.6, damage: 7, kb: 10, lift: 5, stun: 2.5, trail: b.phase >= 2, again: b.phase === 3 }),
    },
    {
      id: 3, name: 'Ember Volley', phases: ALL, minRange: 4, maxRange: 24, weight: 3,
      telegraph: 0.8, active: 0.2, recover: 0.6, cooldown: 6, action: MobAction.Cast,
      begin: () => [],
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        const targets = b.targets();
        if (!targets.length) return;
        if (b.braziers.length) {
          for (const br of b.braziers) {
            for (let i = 0; i < 2; i++) {
              const tg = targets[Math.floor(b.w.rng() * targets.length)];
              const d = Math.hypot(tg.x - br.x, tg.z - br.z);
              lob(b, ProjectileKind.Ember, br.x, br.y + 0.5, br.z, tg.x + (b.w.rng() - 0.5), tg.y + 1, tg.z + (b.w.rng() - 0.5), Math.max(0.6, d / 12), 3);
            }
          }
        } else fan(b, ProjectileKind.Ember, 5, 40, 12, 3, 2, b.mob.y + 2.2);
      },
    },
    {
      id: 4, name: 'Ashguard', phases: ALL, minRange: 0, maxRange: 99, weight: 4,
      telegraph: 1.2, active: 0.2, recover: 0.6, cooldown: 30, action: MobAction.Summon,
      ready: (b) => b.canSummon(0.7, 2, 30),
      begin: (b) => {
        const a = b.structure.arena;
        const door = b.structure.doorways[0];
        const dx = door ? (door.x0 + door.x1) / 2 : (a.x0 + a.x1) / 2;
        const dz = door ? (door.z0 + door.z1) / 2 : a.z0;
        const corners = [
          { x: a.x0 + 1.5, z: a.z0 + 1.5 },
          { x: a.x1 - 1.5, z: a.z0 + 1.5 },
          { x: a.x0 + 1.5, z: a.z1 - 1.5 },
          { x: a.x1 - 1.5, z: a.z1 - 1.5 },
        ].sort((p, q) => Math.hypot(p.x - dx, p.z - dz) - Math.hypot(q.x - dx, q.z - dz));
        b.points = corners.slice(0, 2).map((c) => ({ x: c.x, y: b.floorY, z: c.z }));
        return b.points.map((p) => b.tele(TelegraphShape.Marker, p.x, p.z, 1));
      },
      end: (b) => summonAt(b, MobKind.Rattlebow, MobVariant.Ash, b.points),
    },
    {
      id: 5, name: 'Ground Rupture', phases: P23, minRange: 3, maxRange: 12, weight: 3,
      telegraph: 0.9, active: 0.2, recover: 0.8, cooldown: 8, action: MobAction.Slam,
      begin: (b) => {
        const t = b.target();
        const yaw = t ? Math.atan2(-(t.x - b.mob.x), -(t.z - b.mob.z)) : b.mob.yaw;
        b.data.yaw = yaw;
        return [-1, 0, 1].map((k) => b.tele(TelegraphShape.Line, b.mob.x, b.mob.z, 10, { width: 1.4, yaw: yaw + (k * Math.PI) / 6 }));
      },
      update: (b) => {
        if (b.data.done) return;
        b.data.done = 1;
        const m = b.mob;
        for (const k of [-1, 0, 1]) {
          const yaw = b.data.yaw + (k * Math.PI) / 6;
          const ex = m.x - Math.sin(yaw) * 10;
          const ez = m.z - Math.cos(yaw) * 10;
          for (const p of b.playersOnLine(m.x, m.z, ex, ez, 0.7)) {
            if (b.data[`r_${p.id}`]) continue;
            b.data[`r_${p.id}`] = 1;
            b.w.hurtPlayer(p.id, { amount: 6, kind: DamageKind.Burst, attacker: m.ref, fromX: m.x, fromY: m.y, fromZ: m.z, knockback: 3, lift: 7, unblockable: true });
          }
          for (let d = 2; d <= 10; d += 4) b.w.emit({ type: EntityEventType.Burst, kind: BurstKind.Rupture, x: m.x - Math.sin(yaw) * d, y: b.floorY, z: m.z - Math.cos(yaw) * d, radius: 1 });
        }
      },
    },
  ],
};

export const BOSS_SCRIPTS: Readonly<Partial<Record<MobKind, BossScript>>> = {
  [MobKind.SunforgedSentinel]: sentinel,
  [MobKind.RimeWarden]: warden,
  [MobKind.Thornmaw]: thornmaw,
  [MobKind.AshenKnight]: knight,
};

/** Which boss guards a structure type. */
export const BOSS_FOR_STRUCTURE: Readonly<Record<StructureType, MobKind>> = {
  [StructureType.SunscorchTemple]: MobKind.SunforgedSentinel,
  [StructureType.FrostCitadel]: MobKind.RimeWarden,
  [StructureType.OvergrownShrine]: MobKind.Thornmaw,
  [StructureType.AshenCrypt]: MobKind.AshenKnight,
};

export function bossTitle(kind: MobKind): string {
  return BOSS_SCRIPTS[kind]?.title ?? '';
}

import { describe, expect, it } from 'vitest';
import { ALL_MOB_KINDS, MOB_DEFS, MobAction, MobKind, ProjectileKind } from '@hub/shared';
import { animate, createPose } from '../src/games/voxel/entities/animate';
import { MOB_MODELS, mobModel, projectileModel } from '../src/games/voxel/entities/models';

describe('creature models', () => {
  it('every model compiles, parents exist, colours resolve and the size fits the creature', () => {
    for (const kind of ALL_MOB_KINDS) {
      const m = mobModel(kind);
      const def = MOB_DEFS[kind];
      expect(m.parts.length, def.key).toBeGreaterThan(5);
      expect(m.parts.length, def.key).toBeLessThanOrEqual(40);
      for (const p of m.parts) expect(MOB_MODELS[kind].palette[p.color], `${def.key}.${p.id}`).toBeTypeOf('number');
      // Tallest point near the collision height (flyers and the hovering Warden have root offsets).
      if (kind !== MobKind.Duskwing && kind !== MobKind.Glimmerfin && kind !== MobKind.RimeWarden) {
        expect(m.top / def.height, def.key).toBeGreaterThan(0.65);
        expect(m.top / def.height, def.key).toBeLessThan(1.8); // ears and antlers stick out
      }
    }
  });

  it('projectile models exist for every creature volley and player ammo', () => {
    for (const k of [ProjectileKind.Arrow, ProjectileKind.Bolt, ProjectileKind.MobArrow, ProjectileKind.SunBolt, ProjectileKind.IceShard, ProjectileKind.SeedPod, ProjectileKind.Ember, ProjectileKind.EmberArrow]) {
      expect(projectileModel(k)).not.toBeNull();
    }
  });

  it('animation moves legs while walking and raises arms for an attack', () => {
    const m = mobModel(MobKind.Mudlurch);
    const pose = createPose(m.parts.length);
    const base = { kind: MobKind.Mudlurch, t: 1, phase: 1.2, k: 1, action: MobAction.Walk, actionT: 0, progress: 0, headYaw: 0, headPitch: 0, onGround: true, inWater: false, deathT: -1, hurt: 0, enraged: false, phase2: false, fast: false };
    animate(m, base, pose);
    const leg = m.parts.findIndex((p) => p.role === 'legA');
    expect(Math.abs(pose.rot[leg * 3])).toBeGreaterThan(0.3);
    animate(m, { ...base, action: MobAction.Attack, progress: 0.6 }, pose);
    const arm = m.parts.findIndex((p) => p.role === 'armL');
    expect(pose.rot[arm * 3]).toBeLessThan(-1);
  });
});

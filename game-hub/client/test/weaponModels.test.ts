/** Procedural weapon models: every weapon builds at both levels of detail, within the tablet budget. */
import { beforeAll, describe, expect, it } from 'vitest';
import { WEAPON_COUNT, WEAPONS, WeaponId } from '@hub/shared';
import { arenaHeldModel } from '../src/games/arena/render/heldModels';
import { buildParts, buildWeapon } from '../src/games/arena/render/weaponKit';
import { buildCasing, buildHand, type HandPose, WEAPON_SPECS } from '../src/games/arena/render/weaponSpecs';
import { WEAPON_VISUALS } from '../src/games/arena/render/weaponVisuals';

describe('weapon models', () => {
  // The first build pays for JIT warm-up; time the steady state.
  beforeAll(() => {
    for (const def of WEAPONS) buildWeapon(WEAPON_SPECS[def.id], 'fp');
  });

  for (const def of WEAPONS) {
    it(`${def.name} builds first- and third-person models`, () => {
      const spec = WEAPON_SPECS[def.id];
      const t0 = performance.now();
      const fp = buildWeapon(spec, 'fp');
      const fpMs = performance.now() - t0;
      const tp = buildWeapon(spec, 'tp');
      expect(fpMs, 'build time').toBeLessThan(20);
      expect(fp.triangles).toBeGreaterThan(100);
      expect(fp.triangles).toBeLessThanOrEqual(2500);
      expect(tp.triangles).toBeLessThanOrEqual(260);
      expect(tp.mag).toBeNull();
      expect(tp.act).toBeNull();
      // One draw call per moving part: no material groups, every vertex knows its channel.
      for (const g of [fp.body, fp.mag, fp.act]) {
        if (!g) continue;
        expect(g.groups).toHaveLength(0);
        expect(g.attributes.mat.count).toBe(g.attributes.position.count);
        expect(g.attributes.color.count).toBe(g.attributes.position.count);
      }
      const a = fp.anchors;
      expect(a.muzzle[2]).toBeLessThan(a.sight[2]);
      expect(a.gripR).toHaveLength(3);
      if (def.kind !== 'melee') expect(fp.mag, 'magazine part').not.toBeNull();
      if (def.kind === 'projectile') expect(a.nockRest && a.nockDrawn && a.limbTips).toBeTruthy();
      // The model fits a real weapon's size, and the HUD tag matches the fire mode.
      expect(fp.body.boundingSphere!.radius).toBeLessThan(0.75);
      const tag = WEAPON_VISUALS[def.id].mode;
      const tags = { auto: ['AUTO', 'PUMP'], semi: ['SEMI', 'BOLT'], burst: ['BURST'] }[def.fireMode];
      if (def.kind === 'hitscan') expect(tags).toContain(tag);
      else expect(tag).toBe('');
    });
  }

  it('gives the avatars a held model with a muzzle for every weapon', () => {
    for (let id = 0; id < WEAPON_COUNT; id++) {
      const g = arenaHeldModel(id)!;
      expect(g.attributes.position.count / 3).toBeLessThanOrEqual(260);
      expect(g.userData.muzzle.z).toBeLessThan(-0.1);
      expect(g.attributes.mat).toBeUndefined();
    }
  });

  it('builds the hands and casings', () => {
    for (const pose of ['grip', 'under', 'vertical', 'cup', 'knife'] as HandPose[]) {
      const g = buildParts((k) => buildHand(k, pose));
      expect(g.attributes.position.count / 3).toBeLessThanOrEqual(400);
    }
    expect(buildParts(buildCasing).attributes.position.count / 3).toBeLessThanOrEqual(60);
    expect(WEAPON_SPECS[WeaponId.Crossbow]).toBeDefined();
  });
});

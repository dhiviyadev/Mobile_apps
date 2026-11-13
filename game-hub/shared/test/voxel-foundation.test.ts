import { describe, expect, it } from 'vitest';
import {
  applyBodyKnockback,
  applyDamage,
  Block,
  BLOCK_COUNT,
  blockDef,
  canonicalBlock,
  COMBAT,
  createBody,
  createWorldGenerator,
  type Damageable,
  DamageKind,
  daylightAt,
  isPlaceable,
  itemFromKey,
  KNOCKBACK,
  ladderFacing,
  ladderWall,
  LIGHT_EMISSION,
  lootKeys,
  LootTableId,
  maxJumpDistance,
  PROJECTILE_DEFS,
  ProjectileKind,
  rollLoot,
  stepBody,
  Team,
  VOXEL_MODES,
  VOXEL_PHYSICS,
} from '../src/index';

const target = (over: Partial<Damageable> = {}): Damageable => ({
  ref: { type: 'mob', id: 1 }, team: Team.Hostile, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, halfWidth: 0.3, height: 1.8,
  health: 20, maxHealth: 20, armor: 0, knockbackResist: 0, hurtTime: 0, lastHurtAmount: 0, blockingYaw: null, alive: true, effects: [], ...over,
});
const hit = (amount: number, over = {}) => ({ amount, kind: DamageKind.Melee, attacker: null, fromX: 0, fromY: 1, fromZ: -2, knockback: 5, lift: 3, ...over });

describe('voxel foundation: ids and registries', () => {
  it('keeps old ids and appends 30..127', () => {
    expect([Block.WaterFalling, Block.RedSand, Block.BossAltarDormant, Block.Bedroll]).toEqual([29, 30, 126, 127]);
    expect(BLOCK_COUNT).toBe(144);
    expect(VOXEL_MODES.indexOf('survival')).toBe(2);
    expect(isPlaceable(Block.Lava) || isPlaceable(Block.BossAltar) || isPlaceable(Block.WaterFlow3)).toBe(false);
    expect(isPlaceable(Block.LadderPX) && isPlaceable(Block.Torch) && isPlaceable(Block.Bedroll)).toBe(true);
    expect(canonicalBlock(Block.LadderNX)).toBe(Block.LadderNZ);
    for (const [dx, dz] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) expect(ladderWall(ladderFacing(dx, dz))).toEqual([dx, dz]);
    expect(LIGHT_EMISSION[Block.Torch]).toBe(14);
    expect(blockDef(Block.Log).name).toBe('Oak Log');
  });

  it('resolves every block loot key and rolls loot deterministically', () => {
    for (const k of lootKeys().filter((k) => k.startsWith('block:'))) expect(itemFromKey(k), k).not.toBeNull();
    expect(rollLoot(LootTableId.TempleBoss, 77)).toEqual(rollLoot(LootTableId.TempleBoss, 77));
    expect(rollLoot(LootTableId.TempleBoss, 77).some((s) => ['cobalt_sword', 'cobalt_axe', 'cobalt_crossbow'].includes(s.item))).toBe(true);
    expect(PROJECTILE_DEFS[ProjectileKind.EmberArrow].kind).toBe(8);
  });

  it('exposes the generator API with v1 stubs', () => {
    const g = createWorldGenerator(5, 'survival', 1);
    expect(g.genVersion).toBe(1);
    expect(g.structures()).toEqual([]);
    expect(g.findSpawn()).toEqual(g.findSpawn());
    expect(typeof g.biomeAt(10, 10)).toBe('number');
    expect(daylightAt(0.5)).toBe(1);
    expect(daylightAt(0)).toBe(0);
  });
});

describe('voxel foundation: movement', () => {
  it('is about 16% faster and parkour jumps stay reachable', () => {
    expect(VOXEL_PHYSICS.walkSpeed).toBe(5);
    expect(VOXEL_PHYSICS.sprintSpeed).toBe(6.7);
    // Run along a ledge (top y = 10), jump at its edge and land one block lower. With the old
    // speeds emulated through speedMul the jump is shorter: courses built for them stay reachable.
    // (WP-B adds the full reach table against maxJumpDistance.)
    const get = (x: number, y: number) => (y < (x <= 0 ? 10 : 9) ? Block.Stone : Block.Air);
    const leap = (sprint: boolean, speedMul: number) => {
      const b = createBody(-6, 10, 0.5);
      let jumped = false;
      for (let i = 0; i < 600; i++) {
        stepBody(b, { strafe: 0, forward: 1, yaw: -Math.PI / 2, jump: !jumped && b.x > 1.2, sprint, crouch: false, autoJump: false, speedMul }, (x, y) => get(x, y), 1 / 60, 1.62);
        if (b.jumped) jumped = true;
        if (jumped && b.onGround) break;
      }
      expect(b.y).toBe(9);
      return b.x;
    };
    expect(leap(false, 1)).toBeGreaterThan(leap(false, 4.3 / 5) + 0.3);
    expect(leap(true, 1)).toBeGreaterThan(leap(true, 5.8 / 6.7) + 0.3);
    expect(maxJumpDistance(0, true)).toBe(4.2); // course limits are unchanged
  });

  it('applies knockback with reduced control', () => {
    const b = createBody(0, 10, 0);
    applyBodyKnockback(b, 4, 3, 0);
    expect(b.vx).toBe(4);
    expect(b.vy).toBe(3);
    expect(b.knockTime).toBe(KNOCKBACK.controlTime);
  });
});

describe('voxel foundation: combat contract', () => {
  it('applies armor, immunity difference and knockback', () => {
    const t = target({ armor: 5 });
    const r = applyDamage(t, hit(10));
    expect(r.dealt).toBeCloseTo(8);
    expect(t.hurtTime).toBe(COMBAT.mobImmunity);
    expect(applyDamage(t, hit(8)).ignored).toBe(true);
    expect(applyDamage(t, hit(12.5)).dealt).toBeCloseTo(2);
    expect(r.dvz).toBeGreaterThan(0); // pushed away from fromZ = -2
  });

  it('blocks from the front only, and reports shield disable', () => {
    const t = target({ team: Team.Player, blockingYaw: 0 }); // facing -Z, attacker at -Z
    const r = applyDamage(t, hit(6, { shieldDisable: 1.6 }));
    expect(r.blocked && r.dealt === 0 && r.shieldDisabled).toBe(true);
    expect(Math.abs(r.dvz)).toBeCloseTo(5 * COMBAT.shieldKnockbackMul);
    const back = target({ team: Team.Player, blockingYaw: Math.PI });
    expect(applyDamage(back, hit(6)).blocked).toBe(false);
    const guard = target({ team: Team.Player, guardFactor: () => 0.7 });
    expect(applyDamage(guard, hit(10)).dealt).toBeCloseTo(3);
    expect(applyDamage(target({ blockingYaw: 0 }), hit(6, { unblockable: true, kind: DamageKind.Burst })).blocked).toBe(false);
  });
});

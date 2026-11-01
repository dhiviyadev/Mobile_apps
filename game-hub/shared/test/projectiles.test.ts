import { describe, expect, it } from 'vitest';
import { Block, MobKind, PROJECTILE_DEFS, ProjectileKind, Team, type ProjectileSpawn } from '../src/index';
import { FLOOR, run, setupWorld, testPlayer } from './mobWorld';

const arrow = (o: Partial<ProjectileSpawn> = {}): ProjectileSpawn => ({
  kind: ProjectileKind.Arrow, owner: { type: 'player', id: 'ana' }, team: Team.Player, x: 0.5, y: FLOOR + 1.5, z: 0.5, vx: 20, vy: 0, vz: 0,
  damage: 5, knockback: 2.5, hitsPlayers: false, pickupItem: 'arrow', ...o,
});

describe('projectiles', () => {
  it('player ammo uses the survival numbers', () => {
    expect(PROJECTILE_DEFS[ProjectileKind.Arrow].gravity).toBe(16);
    expect(PROJECTILE_DEFS[ProjectileKind.Bolt].gravity).toBe(12);
    expect(PROJECTILE_DEFS[ProjectileKind.EmberArrow].stickSeconds).toBe(30);
  });

  it('flies a ballistic arc close to the analytic one', () => {
    const s = setupWorld({ blocks: undefined });
    s.blocks.floor = -100;
    const id = s.world.spawnProjectile(arrow({ kind: ProjectileKind.MobArrow, vx: 10, vy: 5, y: 40 }));
    run(s.world, 1);
    const p = s.world.projectiles.list.find((q) => q.id === id)!;
    // MobArrow: gravity 16, drag 0.01 (tiny).
    expect(p.x).toBeCloseTo(0.5 + 10, 0);
    expect(Math.abs(p.y - (40 + 5 - 8))).toBeLessThan(0.3);
  });

  it('sticks in a block for its stick time, passes through tall grass, and stays collectable', () => {
    const s = setupWorld();
    let stuck = 0;
    s.world.hooks.onProjectileStuck = () => void stuck++;
    s.blocks.fill(3, FLOOR, -2, 3, FLOOR + 3, 2, Block.TallGrass);
    s.blocks.fill(8, FLOOR, -2, 8, FLOOR + 3, 2, Block.Stone);
    const id = s.world.spawnProjectile(arrow());
    run(s.world, 1);
    const p = s.world.projectiles.list.find((q) => q.id === id)!;
    expect(p.stuck).toBe(true);
    expect(p.x).toBeGreaterThan(7.5);
    expect(stuck).toBe(1);
    const sandbox = s.world.spawnProjectile(arrow({ stickSeconds: 10 }));
    run(s.world, 11);
    expect(s.world.projectiles.list.some((q) => q.id === sandbox)).toBe(false);
    expect(s.world.projectiles.list.some((q) => q.id === id)).toBe(true);
    s.world.onBlockChanged(8, Math.floor(p.y), 0);
    expect(s.drops.flatMap((d) => d.stacks)).toContainEqual({ item: 'arrow', count: 1 });
  });

  it('hits mobs (not the owner or its team) and pierces', () => {
    const s = setupWorld({ time: 0, caps: { maxNatural: 0 } });
    s.players.push(testPlayer('far', 20, FLOOR, 30, false));
    const a = s.world.spawnMob(MobKind.Mudlurch, 4.5, FLOOR, 0.5)!;
    const b = s.world.spawnMob(MobKind.Mudlurch, 7.5, FLOOR, 0.5)!;
    s.world.step();
    s.world.spawnProjectile(arrow({ pierce: 1 }));
    run(s.world, 1);
    expect(a.health).toBeLessThan(a.maxHealth);
    expect(b.health).toBeLessThan(b.maxHealth);

    const own = s.world.spawnMob(MobKind.Rattlebow, 12.5, FLOOR, 0.5)!;
    const ally = s.world.spawnMob(MobKind.Mudlurch, 15.5, FLOOR, 0.5)!;
    s.world.step();
    s.world.spawnProjectile(arrow({ kind: ProjectileKind.MobArrow, owner: own.ref, team: Team.Hostile, x: 13.5, hitsPlayers: true }));
    run(s.world, 1);
    expect(ally.health).toBe(ally.maxHealth);
  });

  it('a SeedPod bursts within its radius and leaves a ThornPatch', () => {
    const s = setupWorld();
    const p = testPlayer('ana', 5.5, FLOOR, 0.5);
    s.players.push(p);
    s.world.spawnProjectile({ kind: ProjectileKind.SeedPod, owner: { type: 'mob', id: 999 }, team: Team.Hostile, x: 5.5, y: FLOOR + 3, z: 1, vx: 0, vy: -5, vz: 0, damage: 0, knockback: 0, hitsPlayers: true, pickupItem: null });
    run(s.world, 1);
    expect(p.hits.length).toBeGreaterThan(0);
    expect(s.world.hazards.list.length).toBe(1);
  });

  it('caps evict the oldest stuck projectile first', () => {
    const s = setupWorld({ caps: { maxProjectiles: 3 } });
    s.blocks.fill(4, FLOOR, -2, 4, FLOOR + 3, 2, Block.Stone);
    const first = s.world.spawnProjectile(arrow());
    run(s.world, 1);
    const flying = s.world.spawnProjectile(arrow({ vx: -1, y: 50 }));
    s.world.spawnProjectile(arrow({ vx: -1, y: 52 }));
    s.world.spawnProjectile(arrow({ vx: -1, y: 54 }));
    const ids = s.world.projectiles.list.map((q) => q.id);
    expect(ids).not.toContain(first);
    expect(ids).toContain(flying);
  });
});

/**
 * Natural spawning and despawning, structure guards and boss triggers
 * (design-voxel-mobs §6, §7.1). Each player gets one spawn pass per second;
 * friendly herds appear on grass-like ground in daylight by biome, hostiles
 * where it is dark (light ≤ 4) in survival only.
 */
import { Block, IS_LIQUID, IS_REPLACEABLE, IS_SOLID } from '../blocks';
import { Team } from '../combat';
import { CHUNK_HEIGHT, FLIGHT_CEILING, SEA_LEVEL } from '../constants';
import { isBossDefeated, StructureType, type StructureInfo } from '../structures/types';
import type { PlayerTarget } from './api';
import { insideBox, standY } from './ai/common';
import { BossController } from './bosses/boss';
import { BOSS_FOR_STRUCTURE, BOSS_SCRIPTS } from './bosses/scripts';
import { FISH_BIOMES, FRIENDLY_SPAWNS, hostileCaveTable, hostileSurfaceTable, pickWeighted, variantFor, type SpawnEntry } from './defs';
import { openSky, spawnLight } from './perception';
import { EntityEventType, MobFlag, MobKind, MobVariant, type Mob } from './types';
import type { EntityWorld } from './world';

const COUNT_RADIUS = 48;
const GROUND = new Set<number>([Block.Grass, Block.SnowyGrass, Block.ForestFloor, Block.ParchedGrass, Block.Snow]);
const BAD_FLOOR = new Set<number>([Block.Leaves, Block.Glass, Block.Bedrock]);
const GUARD_RESPAWN = 300;

interface GuardState {
  live: Map<number, number>;
  respawnAt: Map<number, number>;
}

const GUARD_KINDS: Record<StructureType, [MobKind, MobKind, MobVariant]> = {
  [StructureType.SunscorchTemple]: [MobKind.Rattlebow, MobKind.Mudlurch, MobVariant.Sand],
  [StructureType.FrostCitadel]: [MobKind.Mudlurch, MobKind.Rattlebow, MobVariant.Frost],
  [StructureType.OvergrownShrine]: [MobKind.Puffcap, MobKind.Cragcrawler, MobVariant.Moss],
  [StructureType.AshenCrypt]: [MobKind.Rattlebow, MobKind.Mudlurch, MobVariant.Ash],
};

export class Spawner {
  private passes = 0;
  /** structure id -> live boss mob id. */
  readonly bosses = new Map<number, number>();
  private readonly guards = new Map<number, GuardState>();

  constructor(private readonly w: EntityWorld) {}

  tick(): void {
    const w = this.w;
    const players = w.players;
    for (let i = 0; i < players.length; i++) {
      if (w.tick % 20 === i % 20) this.pass(players[i]);
    }
    if (w.tick % 5 === 0) {
      this.bossTriggers();
      this.guardSpawns();
    }
  }

  /** Is a natural (counted) creature: not tamed, no boss, guard or minion. */
  private natural(m: Mob): boolean {
    return !m.has(MobFlag.Tamed) && !m.has(MobFlag.Guard) && !m.has(MobFlag.Minion) && !m.boss;
  }

  counts(x: number, z: number): { natural: number; extra: number; friendly: number; hostile: number; flyers: number; fish: number } {
    const c = { natural: 0, extra: 0, friendly: 0, hostile: 0, flyers: 0, fish: 0 };
    for (const m of this.w.mobs.values()) {
      if (!m.alive) continue;
      const nat = this.natural(m);
      if (!nat) {
        if (!m.has(MobFlag.Tamed)) c.extra++;
        continue;
      }
      const fish = m.def.swim === 'fish';
      if (!fish) c.natural++;
      if (Math.hypot(m.x - x, m.z - z) > COUNT_RADIUS) continue;
      if (fish) c.fish++;
      else if (m.team === Team.Hostile) {
        c.hostile++;
        if (m.def.fly) c.flyers++;
      } else c.friendly++;
    }
    return c;
  }

  /** One spawn pass around a player. */
  pass(p: PlayerTarget): void {
    const w = this.w;
    this.passes++;
    this.reviveDormant(p);
    const caps = w.caps;
    const c = this.counts(p.x, p.z);
    if (w.rules.friendly && c.natural < caps.maxNatural && c.friendly < caps.friendlyPerPlayer && w.daylight > 0.3) this.friendlyAttempt(p, caps.maxNatural - c.natural, caps.friendlyPerPlayer - c.friendly);
    if (w.rules.friendly && this.passes % 4 === 0 && c.fish < caps.fishPerPlayer) this.fishAttempt(p, caps.fishPerPlayer - c.fish);
    if (w.rules.hostile && c.natural < caps.maxNatural && c.hostile < caps.hostilePerPlayer) {
      // The surface is tried on every other pass only (calmer nights); caves on every pass.
      this.hostileAttempt(p, Math.min(caps.maxNatural - c.natural, caps.hostilePerPlayer - c.hostile), caps.flyersPerPlayer - c.flyers, Math.floor(w.tick / 20) % 2 === 0);
    }
  }

  /** A column in the spawn ring, or null (unavailable, outside the world, near a structure). */
  private column(p: PlayerTarget): { x: number; z: number } | null {
    const w = this.w;
    const a = w.rng() * Math.PI * 2;
    const d = w.caps.spawnMin + w.rng() * (w.caps.spawnMax - w.caps.spawnMin);
    const x = Math.floor(p.x + Math.cos(a) * d);
    const z = Math.floor(p.z + Math.sin(a) * d);
    const limit = w.host.generator.limit;
    if (x < -limit + 2 || x >= limit - 2 || z < -limit + 2 || z >= limit - 2) return null;
    if (!w.host.isAvailable(x, z)) {
      w.host.warm?.(Math.floor(x / 16), Math.floor(z / 16));
      return null;
    }
    for (const s of w.structuresNear(x, z, 5)) if (insideBox(s.bounds, x, s.bounds.y0 + 1, z, 4)) return null;
    for (const q of w.players) if (Math.hypot(q.x - x, q.z - z) < w.caps.spawnMin) return null;
    return { x, z };
  }

  private topSolid(x: number, z: number, fromY: number): number {
    const get = this.w.host.getBlock;
    for (let y = Math.min(CHUNK_HEIGHT - 1, fromY); y > 0; y--) {
      const b = get(x, y, z);
      if (IS_SOLID[b]) return y;
      if (IS_LIQUID[b]) return -1;
    }
    return -1;
  }

  private group(e: SpawnEntry, max: number): number {
    return Math.min(max, e.min + Math.floor(this.w.rng() * (e.max - e.min + 1)));
  }

  private friendlyAttempt(p: PlayerTarget, roomLeft: number, localLeft: number): void {
    const w = this.w;
    const col = this.column(p);
    if (!col) return;
    const get = w.host.getBlock;
    const top = this.topSolid(col.x, col.z, Math.floor(p.y) + 24);
    if (top < 1) return;
    const ground = get(col.x, top, col.z);
    const biome = w.host.generator.biomeAt(col.x, col.z);
    const table = FRIENDLY_SPAWNS[biome];
    if (!table) return;
    const e = pickWeighted(table, w.rng);
    if (!e) return;
    const okGround = GROUND.has(ground) || (ground === Block.Mud && biome === 13) || ((ground === Block.Sand || ground === Block.RedSand) && e.kind === MobKind.Hopling);
    if (!okGround) return;
    for (let k = 1; k <= 2; k++) {
      const b = get(col.x, top + k, col.z);
      if (IS_SOLID[b] || IS_LIQUID[b] || (b !== Block.Air && !IS_REPLACEABLE[b])) return;
    }
    if (!openSky(get, col.x, top + 1, col.z)) return;
    const n = this.group(e, Math.min(roomLeft, localLeft));
    const variant = variantFor(e.kind, biome, top, w.rng);
    for (let i = 0; i < n; i++) {
      const x = col.x + 0.5 + (i ? Math.round((w.rng() - 0.5) * 6) : 0);
      const z = col.z + 0.5 + (i ? Math.round((w.rng() - 0.5) * 6) : 0);
      const y = standY(w, x, top + 1, z, 1.6, 1);
      if (y === null) continue;
      w.spawnMob(e.kind, x, y, z, { variant });
    }
  }

  private fishAttempt(p: PlayerTarget, left: number): void {
    const w = this.w;
    const col = this.column(p);
    if (!col) return;
    const get = w.host.getBlock;
    const biome = w.host.generator.biomeAt(col.x, col.z);
    if (!FISH_BIOMES.has(biome)) return;
    if (!IS_LIQUID[get(col.x, SEA_LEVEL, col.z)] || !IS_LIQUID[get(col.x, SEA_LEVEL - 1, col.z)] || !IS_LIQUID[get(col.x, SEA_LEVEL - 2, col.z)] || IS_SOLID[get(col.x, SEA_LEVEL + 1, col.z)]) return;
    const n = Math.min(left, 2 + Math.floor(w.rng() * 3));
    const variant = variantFor(MobKind.Glimmerfin, biome, SEA_LEVEL, w.rng);
    for (let i = 0; i < n; i++) {
      const x = col.x + 0.5 + (w.rng() - 0.5) * 2;
      const z = col.z + 0.5 + (w.rng() - 0.5) * 2;
      const y = SEA_LEVEL - 1 - Math.floor(w.rng() * 2) + 0.2;
      if (!IS_LIQUID[get(Math.floor(x), Math.floor(y), Math.floor(z))]) continue;
      w.spawnMob(MobKind.Glimmerfin, x, y, z, { variant });
    }
  }

  private hostileAttempt(p: PlayerTarget, left: number, flyersLeft: number, surface: boolean): void {
    const w = this.w;
    const col = this.column(p);
    if (!col) return;
    const get = w.host.getBlock;
    const top = this.topSolid(col.x, col.z, CHUNK_HEIGHT - 1);
    const cands: { y: number; cave: boolean }[] = [];
    if (top > 0 && surface) cands.push({ y: top + 1, cave: false });
    for (let i = 0; i < 3; i++) {
      const y = Math.floor(p.y - 16 + w.rng() * 32);
      if (y < 2 || y > CHUNK_HEIGHT - 2 || (top > 0 && y > top - 4)) continue;
      const floor = get(col.x, y - 1, col.z);
      if (!IS_SOLID[floor] || BAD_FLOOR.has(floor) || IS_SOLID[get(col.x, y, col.z)] || IS_SOLID[get(col.x, y + 1, col.z)]) continue;
      cands.push({ y, cave: true });
    }
    const biome = w.host.generator.biomeAt(col.x, col.z);
    for (const cnd of cands) {
      const y = cnd.y;
      if (IS_SOLID[get(col.x, y, col.z)] || IS_SOLID[get(col.x, y + 1, col.z)] || IS_LIQUID[get(col.x, y, col.z)]) continue;
      if (BAD_FLOOR.has(get(col.x, y - 1, col.z)) || !IS_SOLID[get(col.x, y - 1, col.z)]) continue;
      if (w.players.some((q) => Math.hypot(q.x - col.x, q.y - y, q.z - col.z) < 24)) continue;
      if (spawnLight(get, col.x, y, col.z, w.skyLevel) > 4) continue;
      let table: SpawnEntry[];
      if (cnd.cave) {
        let duskcap = false;
        const px = col.x + Math.floor((w.rng() - 0.5) * 12);
        const pz = col.z + Math.floor((w.rng() - 0.5) * 12);
        for (let dy = -3; dy <= 3 && !duskcap; dy++) if (get(px, y + dy, pz) === Block.Duskcap) duskcap = true;
        table = hostileCaveTable(duskcap);
      } else {
        table = hostileSurfaceTable(biome);
        let open = true;
        for (let k = 0; k < 6 && open; k++) if (get(col.x, y + k, col.z) !== Block.Air) open = false;
        if (!open || w.daylight >= 0.15 || flyersLeft <= 0) table = table.filter((e) => e.kind !== MobKind.Duskwing);
      }
      const e = pickWeighted(table, w.rng);
      if (!e) return;
      const n = this.group(e, e.kind === MobKind.Duskwing ? Math.min(left, flyersLeft) : left);
      const variant = variantFor(e.kind, biome, y, w.rng);
      for (let i = 0; i < n; i++) {
        const x = col.x + 0.5 + (i ? Math.round((w.rng() - 0.5) * 4) : 0);
        const z = col.z + 0.5 + (i ? Math.round((w.rng() - 0.5) * 4) : 0);
        const sy = e.kind === MobKind.Duskwing ? y + 4 : standY(w, x, y, z, 2, 1);
        if (sy === null) continue;
        w.spawnMob(e.kind, x, sy, z, { variant });
      }
      return;
    }
  }

  /** Re-creates dormant tamed creatures near a player. */
  private reviveDormant(p: PlayerTarget): void {
    const w = this.w;
    if (!w.dormant.length) return;
    w.dormant = w.dormant.filter((s) => {
      if (Math.hypot(s.x - p.x, s.z - p.z) > w.caps.simDist || !w.host.isAvailable(s.x, s.z)) return true;
      const m = w.spawnMob(s.kind, s.x, s.y, s.z, { variant: s.variant, flags: s.flags & (MobFlag.Baby | MobFlag.Tamed | MobFlag.Named), yaw: s.yaw });
      if (!m) return true;
      m.health = Math.max(1, Math.min(m.maxHealth, s.health));
      m.growLeft = s.growLeft;
      m.owner = s.owner;
      m.name = s.name;
      m.home = { x: s.x, y: s.y, z: s.z };
      if (m.name) w.emit({ type: EntityEventType.MobInfo, id: m.id, name: m.name, owner: m.owner, x: m.x, y: m.y, z: m.z });
      return false;
    });
  }

  /** Removal rules (§6.4); called for every live mob each tick. */
  despawnCheck(m: Mob, near: number, dt: number): void {
    const w = this.w;
    if (m.boss) return;
    if (m.has(MobFlag.Tamed)) {
      if (near > w.caps.despawnDist) {
        w.dormant.push({ kind: m.kind, variant: m.variant, flags: m.flags & (MobFlag.Baby | MobFlag.Tamed | MobFlag.Named), x: m.x, y: m.y, z: m.z, yaw: m.yaw, health: m.health, growLeft: m.growLeft, owner: m.owner, name: m.name });
        w.removeMob(m);
      }
      return;
    }
    if (m.has(MobFlag.Minion)) {
      const boss = w.mobs.get(m.bossId);
      if (!boss || !boss.alive) w.crumble(m);
      return;
    }
    if (m.has(MobFlag.Guard)) {
      if (near > 64) {
        this.guardDied(m, false);
        w.removeMob(m);
      }
      return;
    }
    if (near > w.caps.despawnDist) {
      w.removeMob(m);
      return;
    }
    const hostile = m.team === Team.Hostile;
    m.idleFarTime = near > (hostile ? 32 : 48) ? m.idleFarTime + dt : 0;
    if (m.idleFarTime > (hostile ? 30 : 60)) {
      w.removeMob(m);
      return;
    }
    if (m.def.daylight === 'flee') {
      if (w.daylight > 0.4) {
        m.sunTime += dt;
        if (m.sunTime > 10 || m.y > FLIGHT_CEILING) w.removeMob(m);
      } else m.sunTime = 0;
    } else if (m.def.daylight === 'shade') {
      const sun = w.daylight > 0.55 && m.underSky && near > 16;
      m.sunTime = sun ? m.sunTime + dt : 0;
      if (m.sunTime > 45) w.removeMob(m);
    }
  }

  // ---- structures ----

  /** Structures within `radius` of any live player (each once). */
  private structuresNearPlayers(radius: number): StructureInfo[] {
    const w = this.w;
    const out: StructureInfo[] = [];
    for (const p of w.players) {
      if (!p.alive) continue;
      for (const s of w.structuresNear(p.x, p.z, radius)) if (!out.some((o) => o.id === s.id && o.anchor.x === s.anchor.x && o.anchor.z === s.anchor.z)) out.push(s);
    }
    return out;
  }

  /** Bosses awaken when a survival player steps into an active altar's arena. */
  private bossTriggers(): void {
    const w = this.w;
    for (const [sid, id] of this.bosses) if (!w.mobs.has(id)) this.bosses.delete(sid);
    if (!w.rules.bosses) return;
    const get = w.host.getBlock;
    for (const s of this.structuresNearPlayers(64)) {
      if (this.bosses.has(s.id) || get(s.altar.x, s.altar.y, s.altar.z) !== Block.BossAltar) continue;
      if (!w.host.isAvailable(s.bossSpawn.x, s.bossSpawn.z)) continue;
      const inside = w.players.some((p) => p.alive && p.targetable && p.x >= s.arena.x0 && p.x < s.arena.x1 && p.z >= s.arena.z0 && p.z < s.arena.z1 && p.y >= s.arena.y0 - 1 && p.y < s.arena.y1);
      if (!inside) continue;
      this.spawnBoss(s);
    }
  }

  /** Spawns the structure's boss (also used by dev hooks and tests). */
  spawnBoss(s: StructureInfo): Mob | null {
    const w = this.w;
    const kind = BOSS_FOR_STRUCTURE[s.type];
    const script = BOSS_SCRIPTS[kind];
    if (!script) return null;
    const sp = s.bossSpawn;
    const m = w.spawnMob(kind, sp.x, sp.y + script.hover, sp.z, { flags: MobFlag.Boss, yaw: 0 });
    if (!m) return null;
    m.boss = new BossController(w, m, s, script);
    this.bosses.set(s.id, m.id);
    w.emit({ type: EntityEventType.BossAwake, id: m.id, kind, structureId: s.id, x: m.x, y: m.y, z: m.z });
    return m;
  }

  private guardSpawns(): void {
    const w = this.w;
    if (!w.rules.bosses) return;
    const get = w.host.getBlock;
    for (const s of this.structuresNearPlayers(64)) {
      if (isBossDefeated(get, s) || !s.guardSpawns.length) continue;
      if (!w.players.some((p) => p.alive && Math.hypot(p.x - s.entrance.x, p.z - s.entrance.z) < 40)) continue;
      let st = this.guards.get(s.id);
      if (!st) this.guards.set(s.id, (st = { live: new Map(), respawnAt: new Map() }));
      const [even, odd, variant] = GUARD_KINDS[s.type];
      for (let i = 0; i < s.guardSpawns.length; i++) {
        const id = st.live.get(i);
        if (id && w.mobs.get(id)?.alive) continue;
        st.live.delete(i);
        if ((st.respawnAt.get(i) ?? 0) > w.time) continue;
        if (this.counts(0, 0).extra >= w.caps.maxExtra) return;
        const g = s.guardSpawns[i];
        if (!w.host.isAvailable(g.x, g.z)) continue;
        const m = w.spawnMob(i % 2 === 0 ? even : odd, g.x, g.y, g.z, { variant, flags: MobFlag.Guard });
        if (!m) continue;
        m.structureId = s.id;
        m.guardIndex = i;
        m.home = { ...g };
        const b = s.bounds;
        m.leash = {
          x0: Math.max(b.x0 - 8, Math.floor(g.x) - 8), y0: Math.max(b.y0 - 8, Math.floor(g.y) - 8), z0: Math.max(b.z0 - 8, Math.floor(g.z) - 8),
          x1: Math.min(b.x1 + 8, Math.floor(g.x) + 8), y1: Math.min(b.y1 + 8, Math.floor(g.y) + 8), z1: Math.min(b.z1 + 8, Math.floor(g.z) + 8),
        };
        st.live.set(i, m.id);
      }
    }
  }

  /** A guard died (or despawned): its point respawns after 300 s (death only). */
  guardDied(m: Mob, killed = true): void {
    const st = this.guards.get(m.structureId);
    if (!st) return;
    st.live.delete(m.guardIndex);
    if (killed) st.respawnAt.set(m.guardIndex, this.w.time + GUARD_RESPAWN);
  }
}

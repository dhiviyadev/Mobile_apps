/**
 * Boss framework (design-voxel-mobs §7.1): awakening, health scaling by
 * players, arena leash, a telegraph → active → recover → reposition attack
 * loop, phases with invulnerable transitions, stuns, reset when nobody fights,
 * defeat (altar → dormant, unique drops, announcement).
 */
import { Block, IS_LIQUID, IS_SOLID } from '../../blocks';
import { DamageKind, Team, type DamageRequest, type StatusEffect } from '../../combat';
import type { StructureInfo, Box3i } from '../../structures/types';
import type { PlayerTarget } from '../api';
import { insideBox } from '../ai/common';
import { MOB_DEFS } from '../defs';
import { ArenaGrid } from '../pathfind';
import { EntityEventType, MobAction, MobFlag, MobKind, TelegraphShape, type Mob, type MobVariant, BurstKind } from '../types';
import type { EntityWorld } from '../world';

export interface Telegraph {
  shape: TelegraphShape;
  x: number;
  y: number;
  z: number;
  radius: number;
  width: number;
  yaw: number;
  halfAngle: number;
  seconds: number;
}

export interface BossAttack {
  id: number;
  name: string;
  /** Bit 1 = phase 1, 2 = phase 2, 4 = phase 3. */
  phases: number;
  minRange: number;
  maxRange: number;
  weight: number;
  telegraph: number;
  active: number;
  recover: number;
  cooldown: number;
  action: MobAction;
  /** Extra readiness (summons: health thresholds, minion counts). */
  ready?(b: BossController): boolean;
  /** At telegraph start: the shapes to show. */
  begin(b: BossController): Telegraph[];
  /** Every tick of the active part (t = seconds into it). */
  update?(b: BossController, t: number, dt: number): void;
  end?(b: BossController): void;
}

export interface BossScript {
  kind: MobKind;
  title: string;
  /** Health fractions that start phases 2 and 3. */
  phaseAt: [number, number];
  /** Feet above the floor (Rime Warden 0.6). */
  hover: number;
  /** Cannot walk (Thornmaw). */
  rooted?: boolean;
  /** Preferred distance from its target while repositioning. */
  preferred: number;
  attacks: BossAttack[];
  /** Phase 2/3 cooldown multiplier and speed multiplier. */
  phase3?: { cooldownMul?: number; speedMul?: number; telegraphMul?: number };
  onPhase?(b: BossController, phase: number): void;
}

export type BossMode = 'awakening' | 'fight' | 'transition' | 'reset' | 'dying';
type Step = 'idle' | 'telegraph' | 'active' | 'recover' | 'reposition';

const AWAKEN_SECONDS = 2.5;
const TRANSITION_SECONDS = 1.5;
const RESET_AFTER = 15;
const REMOVE_AFTER = 60;

export class BossController {
  readonly grid: ArenaGrid;
  readonly floorY: number;
  phase: 1 | 2 | 3 = 1;
  mode: BossMode = 'awakening';
  modeTime = 0;
  step: Step = 'idle';
  stepTime = 0;
  stepLength = 0;
  current: BossAttack | null = null;
  readonly cooldowns = new Map<number, number>();
  /** Damage dealt per player and time spent inside during the fight. */
  readonly participants = new Map<string, { damage: number; insideTime: number; name: string }>();
  readonly minions = new Set<number>();
  /** Scratch for the running attack. */
  data: Record<string, number> = {};
  points: { x: number; y: number; z: number }[] = [];
  pools: { x: number; y: number; z: number }[] = [];
  braziers: { x: number; y: number; z: number }[] = [];
  pillars: { x: number; z: number }[] = [];
  targetId: string | null = null;
  stunned = 0;
  underground = false;
  baseHealth: number;
  playerScale = 1;
  noTargetTime = 0;
  nobodyNearTime = 0;
  /** Seconds a single player has stayed within 3 (Warden's Blink). */
  closeTime = 0;
  summoned = false;
  lastSummon = -999;
  reposX = 0;
  reposZ = 0;

  constructor(
    readonly w: EntityWorld,
    readonly mob: Mob,
    readonly structure: StructureInfo,
    readonly script: BossScript,
  ) {
    this.baseHealth = MOB_DEFS[mob.kind].maxHealth;
    this.floorY = Math.round(structure.bossSpawn.y);
    const get = w.host.getBlock;
    const a = structure.arena;
    this.grid = new ArenaGrid(get, a, this.floorY, mob.halfWidth);
    // Pillars, pools (water in the floor layer) and braziers (lava) of the arena.
    for (let z = a.z0; z < a.z1; z++) {
      for (let x = a.x0; x < a.x1; x++) {
        if (IS_SOLID[get(x, this.floorY, z)] && IS_SOLID[get(x, this.floorY + 2, z)]) this.pillars.push({ x: x + 0.5, z: z + 0.5 });
        for (let y = this.floorY - 1; y <= this.floorY + 2; y++) {
          const b = get(x, y, z);
          if (b === Block.Lava) this.braziers.push({ x: x + 0.5, y: y + 1, z: z + 0.5 });
          else if (y === this.floorY - 1 && IS_LIQUID[b]) this.pools.push({ x: x + 0.5, y: this.floorY - 0.5, z: z + 0.5 });
        }
      }
    }
    this.pools = groupPoints(this.pools);
    this.pillars = groupPoints(this.pillars.map((p) => ({ ...p, y: 0 })));
    if (this.pools.length < 2) {
      const s = structure.bossSpawn;
      this.pools = [
        { x: s.x + 4, y: s.y, z: s.z },
        { x: s.x - 4, y: s.y, z: s.z },
        { x: s.x, y: s.y, z: s.z + 4 },
        { x: s.x, y: s.y, z: s.z - 4 },
      ];
    }
    mob.leash = a;
    mob.structureId = structure.id;
    mob.home = { ...structure.bossSpawn };
    mob.setAction(MobAction.Roar, AWAKEN_SECONDS);
  }

  // ---- queries used by attacks ----

  get kind(): MobKind {
    return this.mob.kind;
  }

  get healthFrac(): number {
    return this.mob.health / this.mob.maxHealth;
  }

  target(): PlayerTarget | null {
    return this.targetId ? (this.w.playerById(this.targetId) ?? null) : null;
  }

  /** Players who may be attacked: targetable and inside the arena (+2) or a doorway. */
  targets(): PlayerTarget[] {
    const s = this.structure;
    return this.w.players.filter((p) => p.alive && p.targetable && (insideBox(s.arena, p.x, p.y, p.z, 2) || s.doorways.some((d) => insideBox(d, p.x, p.y, p.z, 0.5))));
  }

  vulnerable(): boolean {
    return this.mode === 'fight' && !this.underground;
  }

  adjustDamage(req: DamageRequest): DamageRequest {
    return this.stunned > 0 ? { ...req, amount: req.amount * 1.5 } : req;
  }

  credit(playerId: string, dealt: number): void {
    const p = this.participants.get(playerId) ?? { damage: 0, insideTime: 0, name: this.w.hooks.playerName(playerId) };
    p.damage += dealt;
    this.participants.set(playerId, p);
  }

  minionCount(): number {
    let n = 0;
    for (const id of this.minions) {
      const m = this.w.mobs.get(id);
      if (m && m.alive) n++;
      else this.minions.delete(id);
    }
    return n;
  }

  /** Telegraph helper (shape, seconds from the attack's telegraph time). */
  tele(shape: TelegraphShape, x: number, z: number, radius: number, extra: Partial<Telegraph> = {}): Telegraph {
    return { shape, x, y: this.floorY, z, radius, width: 0, yaw: 0, halfAngle: 0, seconds: this.telegraphTime(), ...extra };
  }

  telegraphTime(): number {
    return (this.current?.telegraph ?? 1) * this.teleMul();
  }

  private teleMul(): number {
    return this.phase === 3 ? (this.script.phase3?.telegraphMul ?? 1) : 1;
  }

  emitTelegraph(t: Telegraph): void {
    this.w.emit({ type: EntityEventType.Telegraph, bossId: this.mob.id, shape: t.shape, seconds: t.seconds, x: t.x, y: t.y, z: t.z, radius: t.radius, width: t.width, yaw: t.yaw, halfAngle: t.halfAngle });
  }

  /** Area hit centred on a point (unblockable). */
  slam(x: number, z: number, radius: number, damage: number, kb: number, lift: number, kind: BurstKind, effects?: StatusEffect[]): void {
    this.w.burst(x, this.floorY, z, radius, damage, kb, lift, this.mob.ref, Team.Hostile, kind, DamageKind.Burst, effects);
  }

  /** Melee arc in front (blockable): everyone within radius and halfAngle of yaw. */
  arcHit(radius: number, halfAngle: number, yaw: number, damage: number, kb: number, lift: number): void {
    const m = this.mob;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    for (const p of this.targets()) {
      const dx = p.x - m.x;
      const dz = p.z - m.z;
      const d = Math.hypot(dx, dz);
      if (d > radius + p.halfWidth || Math.abs(p.y - this.floorY) > 2.5) continue;
      if (d > 0.5 && (dx * fx + dz * fz) / d < Math.cos(halfAngle)) continue;
      this.w.hurtPlayer(p.id, { amount: damage, kind: DamageKind.Melee, attacker: m.ref, fromX: m.x, fromY: m.y + 1.5, fromZ: m.z, knockback: kb, lift, shieldDisable: 1.5 });
    }
  }

  /** Players within `half` of the segment (x0,z0)-(x1,z1). */
  playersOnLine(x0: number, z0: number, x1: number, z1: number, half: number): PlayerTarget[] {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len2 = dx * dx + dz * dz || 1;
    return this.targets().filter((p) => {
      const t = Math.max(0, Math.min(1, ((p.x - x0) * dx + (p.z - z0) * dz) / len2));
      return Math.hypot(p.x - (x0 + dx * t), p.z - (z0 + dz * t)) <= half + p.halfWidth && Math.abs(p.y - this.floorY) < 2.5;
    });
  }

  /** Free length along a direction before a wall or pillar (grid cells), up to max. */
  freeLength(yaw: number, max: number): number {
    const m = this.mob;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let d = 0;
    while (d < max) {
      const nd = d + 0.25;
      if (!this.grid.isOpen(m.x + fx * nd, m.z + fz * nd)) break;
      d = nd;
    }
    return d;
  }

  /** Spawns a minion (counted, leashed to the arena). */
  summon(kind: MobKind, variant: MobVariant, x: number, z: number): Mob | null {
    const y = this.floorY;
    const m = this.w.spawnMob(kind, x, y, z, { variant, flags: MobFlag.Minion });
    if (!m) return null;
    m.leash = this.structure.arena;
    m.home = { x, y, z };
    m.bossId = this.mob.id;
    m.structureId = this.structure.id;
    m.setAction(MobAction.Emerge, 1.2);
    this.minions.add(m.id);
    this.lastSummon = this.w.time;
    this.summoned = true;
    return m;
  }

  /** Summon readiness: below the health fraction, fewer than `max` minions, first time or every `every` s. */
  canSummon(frac: number, max: number, every: number): boolean {
    return this.healthFrac < frac && this.minionCount() < max && (!this.summoned || this.w.time - this.lastSummon >= every);
  }

  randomArenaPoint(minFromPlayers: number): { x: number; z: number } {
    const a = this.structure.arena;
    const m = this.mob;
    for (let i = 0; i < 20; i++) {
      const x = a.x0 + 1 + this.w.rng() * (a.x1 - a.x0 - 2);
      const z = a.z0 + 1 + this.w.rng() * (a.z1 - a.z0 - 2);
      if (!this.grid.isOpen(x, z)) continue;
      if (this.w.players.every((p) => Math.hypot(p.x - x, p.z - z) >= minFromPlayers)) return { x, z };
    }
    return { x: m.x, z: m.z };
  }

  // ---- lifecycle ----

  /** Raises max health when more players join (health keeps its fraction). */
  private scale(): void {
    const s = this.structure;
    const n = this.w.players.filter((p) => p.alive && p.targetable && insideBox(s.arena, p.x, p.y, p.z, 4)).length;
    const k = Math.min(3, 1 + 0.5 * Math.max(0, n - 1));
    if (k > this.playerScale) {
      const frac = this.healthFrac;
      this.playerScale = k;
      this.mob.maxHealth = this.baseHealth * k;
      this.mob.health = this.mob.maxHealth * frac;
    }
  }

  private setMode(mode: BossMode): void {
    this.mode = mode;
    this.modeTime = 0;
  }

  /** One tick (called by the boss brain). */
  update(dt: number): void {
    const m = this.mob;
    const w = this.w;
    const it = m.intent;
    it.vx = it.vz = 0;
    it.jump = false;
    it.climb = false;
    it.faceYaw = null;
    this.modeTime += dt;
    this.stunned = Math.max(0, this.stunned - dt);
    for (const [id, c] of this.cooldowns) this.cooldowns.set(id, c - dt);
    this.clampToArena();
    this.hover();
    const targets = this.targets();
    // Credit time inside for participants.
    for (const p of targets) {
      const e = this.participants.get(p.id) ?? { damage: 0, insideTime: 0, name: p.name };
      e.insideTime += dt;
      this.participants.set(p.id, e);
    }
    const anyoneNear = w.players.some((p) => insideBox(this.structure.arena, p.x, p.y, p.z, 48));
    this.nobodyNearTime = anyoneNear ? 0 : this.nobodyNearTime + dt;
    if (this.nobodyNearTime > REMOVE_AFTER) {
      this.despawn();
      return;
    }
    switch (this.mode) {
      case 'awakening':
        this.scale();
        if (this.modeTime >= AWAKEN_SECONDS) this.setMode('fight');
        return;
      case 'transition':
        if (this.modeTime >= TRANSITION_SECONDS) this.setMode('fight');
        return;
      case 'reset':
        this.walkTo(this.structure.bossSpawn.x, this.structure.bossSpawn.z, 1);
        m.health = Math.min(m.maxHealth, m.health + (m.maxHealth / 3) * dt);
        if (targets.length) {
          this.setMode('fight');
          this.noTargetTime = 0;
        }
        return;
      case 'dying':
        return;
    }
    this.scale();
    if (!targets.length) {
      this.noTargetTime += dt;
      if (this.noTargetTime > RESET_AFTER) this.reset();
      return;
    }
    this.noTargetTime = 0;
    // Phase changes.
    const next = this.healthFrac <= this.script.phaseAt[1] ? 3 : this.healthFrac <= this.script.phaseAt[0] ? 2 : 1;
    if (next > this.phase && this.step !== 'active') {
      this.phase = next as 2 | 3;
      this.endAttack(false);
      this.setMode('transition');
      this.underground = false;
      m.setAction(MobAction.Roar, TRANSITION_SECONDS);
      this.slam(m.x, m.z, 4, 0, 6, 3, BurstKind.Pulse);
      w.emit({ type: EntityEventType.BossPhase, id: m.id, phase: this.phase, x: m.x, y: m.y, z: m.z });
      this.script.onPhase?.(this, this.phase);
      return;
    }
    // Who stays close (Blink).
    const near = targets.some((p) => Math.hypot(p.x - m.x, p.z - m.z) < 3);
    this.closeTime = near ? this.closeTime + dt : 0;
    this.attackLoop(dt, targets);
  }

  private attackLoop(dt: number, targets: PlayerTarget[]): void {
    const m = this.mob;
    this.stepTime += dt;
    const t = this.target() ?? targets[0];
    switch (this.step) {
      case 'idle': {
        this.targetId = this.pickTarget(targets);
        const tg = this.target();
        if (!tg) return;
        this.face(tg.x, tg.z);
        if (this.stepTime < 0.6) return;
        const atk = this.pickAttack(Math.hypot(tg.x - m.x, tg.z - m.z));
        if (atk) {
          this.current = atk;
          this.data = {};
          this.points = [];
          this.step = 'telegraph';
          this.stepTime = 0;
          this.stepLength = atk.telegraph * this.teleMul();
          const shapes = atk.begin(this);
          for (const s of shapes) this.emitTelegraph(s);
          m.setAction(atk.action, this.stepLength + atk.active);
          this.w.emit({ type: EntityEventType.MobAction, id: m.id, action: atk.action, param: atk.id, x: m.x, y: m.y, z: m.z });
        } else if (!this.script.rooted) {
          // Nothing in range: close in.
          this.walkTo(tg.x, tg.z, this.script.preferred);
        }
        return;
      }
      case 'telegraph':
        if (t && this.current && this.current.action !== MobAction.Charge) this.face(t.x, t.z, 0.5);
        if (this.stepTime >= this.stepLength) {
          this.step = 'active';
          this.stepTime = 0;
          this.stepLength = this.current!.active;
        }
        return;
      case 'active':
        this.current!.update?.(this, this.stepTime, dt);
        if (this.step === 'active' && this.stepTime >= this.stepLength) this.endAttack(true);
        return;
      case 'recover':
        if (this.stepTime >= this.stepLength) {
          this.step = 'reposition';
          this.stepTime = 0;
          this.stepLength = 0.8 + this.w.rng() * 1.2;
          if (t) {
            const a = Math.atan2(m.z - t.z, m.x - t.x) + (this.w.rng() - 0.5);
            this.reposX = t.x + Math.cos(a) * this.script.preferred;
            this.reposZ = t.z + Math.sin(a) * this.script.preferred;
          }
        }
        return;
      case 'reposition':
        if (!this.script.rooted) this.walkTo(this.reposX, this.reposZ, 0.5);
        if (t) this.face(t.x, t.z, 0.6);
        if (this.stepTime >= this.stepLength) {
          this.step = 'idle';
          this.stepTime = 0;
        }
        return;
    }
  }

  /** Ends the running attack: cooldown, then recover (stunned when the attack asked for it). */
  endAttack(normal: boolean): void {
    const atk = this.current;
    if (atk) {
      if (normal) atk.end?.(this);
      const mul = this.phase === 3 ? (this.script.phase3?.cooldownMul ?? 1) : 1;
      this.cooldowns.set(atk.id, atk.cooldown * mul);
    }
    this.current = null;
    this.step = 'recover';
    this.stepTime = 0;
    this.stepLength = atk ? atk.recover : 0.5;
    if (this.stunned > 0) {
      this.stepLength = Math.max(this.stepLength, this.stunned);
      this.mob.setAction(MobAction.Stunned, this.stunned);
    }
  }

  /** The attack asks for a stun (charge into a wall). */
  stun(seconds: number): void {
    this.stunned = seconds;
    this.mob.vx = this.mob.vz = 0;
    this.w.emit({ type: EntityEventType.Burst, kind: BurstKind.Impact, x: this.mob.x, y: this.floorY, z: this.mob.z, radius: 1.5 });
  }

  private pickTarget(targets: PlayerTarget[]): string | null {
    const m = this.mob;
    const sorted = [...targets].sort((a, b) => Math.hypot(a.x - m.x, a.z - m.z) - Math.hypot(b.x - m.x, b.z - m.z));
    if (!sorted.length) return null;
    if (sorted.length > 1 && this.w.rng() < 0.3) return sorted[1].id;
    return sorted[0].id;
  }

  private pickAttack(dist: number): BossAttack | null {
    const bit = 1 << (this.phase - 1);
    const ready = this.script.attacks.filter((a) => (a.phases & bit) !== 0 && (this.cooldowns.get(a.id) ?? 0) <= 0 && dist >= a.minRange && dist <= a.maxRange && (!a.ready || a.ready(this)));
    if (!ready.length) return null;
    let total = 0;
    for (const a of ready) total += a.weight;
    let r = this.w.rng() * total;
    for (const a of ready) {
      r -= a.weight;
      if (r < 0) return a;
    }
    return ready[0];
  }

  /** Moves toward a point through the arena grid (stops `stopAt` away). */
  walkTo(x: number, z: number, stopAt: number): void {
    const m = this.mob;
    const d = Math.hypot(x - m.x, z - m.z);
    if (d <= stopAt || this.script.rooted) return;
    const wp = this.grid.nextWaypoint(m.x, m.z, x, z);
    const dx = wp.x - m.x;
    const dz = wp.z - m.z;
    const l = Math.hypot(dx, dz) || 1;
    const speed = m.def.wanderSpeed * (this.phase === 3 ? (this.script.phase3?.speedMul ?? 1) : 1);
    m.intent.vx = (dx / l) * speed;
    m.intent.vz = (dz / l) * speed;
  }

  face(x: number, z: number, _rate = 1): void {
    this.mob.intent.faceYaw = Math.atan2(-(x - this.mob.x), -(z - this.mob.z));
    const t = this.target();
    if (t) this.mob.headPitch = Math.max(-0.6, Math.min(0.6, Math.atan2(t.y + 1.5 - this.mob.eyeY, Math.hypot(t.x - this.mob.x, t.z - this.mob.z) || 1)));
  }

  private clampToArena(): void {
    const m = this.mob;
    const a = this.structure.arena;
    const r = m.halfWidth + 0.1;
    m.x = Math.max(a.x0 + r, Math.min(a.x1 - r, m.x));
    m.z = Math.max(a.z0 + r, Math.min(a.z1 - r, m.z));
  }

  private hover(): void {
    const m = this.mob;
    if (!m.def.fly) return;
    const want = this.floorY + this.script.hover + (this.underground ? -4 : 0);
    m.intent.vy = Math.max(-4, Math.min(4, (want - m.y) * 4));
  }

  /** No valid target for 15 s: minions crumble, heal, walk home, phase 1. */
  reset(): void {
    this.crumbleMinions();
    this.endAttack(false);
    this.phase = 1;
    this.step = 'idle';
    this.underground = false;
    this.stunned = 0;
    this.summoned = false;
    this.cooldowns.clear();
    this.participants.clear();
    this.setMode('reset');
  }

  crumbleMinions(): void {
    for (const id of this.minions) {
      const mm = this.w.mobs.get(id);
      if (mm) this.w.crumble(mm);
    }
    this.minions.clear();
  }

  /** Nobody near for a minute: removed (it awakens again, at full health, next time). */
  private despawn(): void {
    this.crumbleMinions();
    this.w.removeMob(this.mob);
  }

  /** Health reached 0: altar dormant, drops, minions crumble, announcement. */
  onDefeated(): void {
    const m = this.mob;
    const w = this.w;
    const s = this.structure;
    this.setMode('dying');
    this.crumbleMinions();
    w.emit({ type: EntityEventType.BossDefeated, id: m.id, kind: m.kind, structureId: s.id, x: m.x, y: m.y, z: m.z });
    const maxH = m.maxHealth;
    const names: string[] = [];
    let count = 0;
    for (const [id, p] of this.participants) {
      if (p.damage >= maxH * 0.05 || p.insideTime >= 30) {
        count++;
        names.push(p.name || w.hooks.playerName(id));
      }
    }
    w.dropBossLoot(m.kind, s.bossSpawn.x, s.bossSpawn.y + 1, s.bossSpawn.z, Math.max(1, count));
    w.host.setBlock(s.altar.x, s.altar.y, s.altar.z, Block.BossAltarDormant);
    const by = names.length ? ` Defeated by ${joinNames(names)}.` : '';
    w.host.announce(`The ${m.def.name} has fallen!${by}`);
  }
}

function joinNames(n: string[]): string {
  if (n.length <= 1) return n.join('');
  return `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

/** Groups adjacent points (≤ 1.5 apart) and returns group centres. */
function groupPoints(pts: { x: number; y: number; z: number }[]): { x: number; y: number; z: number }[] {
  const groups: { x: number; y: number; z: number; n: number; members: { x: number; z: number }[] }[] = [];
  for (const p of pts) {
    const g = groups.find((g) => g.members.some((q) => Math.abs(q.x - p.x) <= 1.5 && Math.abs(q.z - p.z) <= 1.5));
    if (g) {
      g.x += p.x;
      g.z += p.z;
      g.y += p.y;
      g.n++;
      g.members.push(p);
    } else groups.push({ x: p.x, y: p.y, z: p.z, n: 1, members: [p] });
  }
  return groups.map((g) => ({ x: g.x / g.n, y: g.y / g.n, z: g.z / g.n }));
}

/** The structure type each boss belongs to. */
export function bossBoxOf(s: StructureInfo): Box3i {
  return s.arena;
}

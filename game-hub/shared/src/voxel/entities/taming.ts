/**
 * Feeding, taming, breeding and growing up (design-voxel-mobs §8.1-8.2).
 */
import type { PlayerTarget } from './api';
import { EntityEventType, MobCategory, MobFlag, TameHow, type InteractResult, type Mob } from './types';
import type { EntityWorld } from './world';

/** Tamed creatures one world keeps (live + dormant). */
export const MAX_TAMED = 64;
export const LOVE_SECONDS = 30;
export const BREED_COOLDOWN = 300;
export const GROW_SECONDS = 480;
/** Eye-to-box reach for feeding (the server adds 1 block of slack). */
export const INTERACT_REACH = 4.5;

function tamedEvent(w: EntityWorld, m: Mob, how: number): void {
  w.emit({ type: EntityEventType.Tamed, id: m.id, how, x: m.x, y: m.y, z: m.z });
}

/** Secondary on a creature with `held` in hand. */
export function interactMob(w: EntityWorld, mobId: number, player: PlayerTarget, held: string | null): InteractResult {
  const m = w.mobs.get(mobId);
  if (!m || !m.alive || m.def.category !== MobCategory.Friendly || !m.def.likes.length || !w.rules.taming) return 'none';
  const liked = !!held && m.def.likes.includes(held);
  const tamed = m.has(MobFlag.Tamed);
  const consume = (): boolean => !w.rules.consumeFood || w.hooks.consumeHeld(player.id, held!);
  if (liked) {
    if (!tamed) {
      if (w.tamedCount() >= MAX_TAMED) return 'cap';
      if (!consume()) return 'none';
      m.panicUntil = 0;
      if (w.rng() < m.def.tameChance) {
        m.flags |= MobFlag.Tamed;
        m.owner = player.name;
        m.home = { x: m.x, y: m.y, z: m.z };
        tamedEvent(w, m, TameHow.Tamed);
        w.emit({ type: EntityEventType.MobInfo, id: m.id, name: m.name, owner: m.owner, x: m.x, y: m.y, z: m.z });
        return 'tamed';
      }
      tamedEvent(w, m, TameHow.Fed);
      return 'fed';
    }
    if (m.has(MobFlag.Baby)) {
      if (!consume()) return 'none';
      m.growLeft = Math.max(0, m.growLeft - 60);
      tamedEvent(w, m, TameHow.Fed);
      return 'fed';
    }
    if (w.time < m.breedCooldown || m.loveUntil > w.time) return 'none';
    if (!consume()) return 'none';
    m.loveUntil = w.time + LOVE_SECONDS;
    tamedEvent(w, m, TameHow.Love);
    return 'love';
  }
  if (tamed) return m.owner === player.name ? 'name' : 'not-owner';
  return 'none';
}

/** Lovers that meet have a baby; babies grow up; love runs out. */
export function tickTaming(w: EntityWorld, dt: number): void {
  for (const m of w.mobs.values()) {
    if (!m.alive || !m.has(MobFlag.Tamed)) continue;
    if (m.has(MobFlag.Baby)) {
      m.growLeft -= dt;
      if (m.growLeft <= 0) grow(m);
      continue;
    }
    if (m.loveUntil <= w.time) continue;
    for (const o of w.mobsAround(m.x, m.z, 2)) {
      if (o.id <= m.id || !o.alive || o.kind !== m.kind || o.loveUntil <= w.time || o.has(MobFlag.Baby) || !o.has(MobFlag.Tamed)) continue;
      if (Math.hypot(o.x - m.x, o.z - m.z) > 1.5 + m.halfWidth + o.halfWidth || Math.abs(o.y - m.y) > 1) continue;
      if (w.tamedCount() >= MAX_TAMED) break;
      const baby = w.spawnMob(m.kind, (m.x + o.x) / 2, Math.max(m.y, o.y), (m.z + o.z) / 2, { variant: m.variant, flags: MobFlag.Tamed | MobFlag.Baby });
      m.loveUntil = o.loveUntil = 0;
      m.breedCooldown = o.breedCooldown = w.time + BREED_COOLDOWN;
      if (baby) {
        baby.owner = m.owner;
        baby.growLeft = GROW_SECONDS;
        baby.home = { x: baby.x, y: baby.y, z: baby.z };
        tamedEvent(w, baby, TameHow.Born);
        w.markPersistChanged();
      }
      break;
    }
  }
}

function grow(m: Mob): void {
  m.flags &= ~MobFlag.Baby;
  m.growLeft = 0;
  const frac = m.health / m.maxHealth;
  m.scale = 1;
  m.halfWidth = m.def.halfWidth;
  m.height = m.def.height;
  m.maxHealth = m.def.maxHealth;
  m.health = Math.max(1, m.maxHealth * frac);
}

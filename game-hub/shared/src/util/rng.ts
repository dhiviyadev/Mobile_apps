/**
 * Deterministic pseudo random helpers. Everything procedural (terrain, parkour
 * courses, textures, music) is seeded so client and server agree.
 */

/** mulberry32: tiny, fast, good-enough 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of up to four ints, stable across platforms. */
export function hash4(a: number, b = 0, c = 0, d = 0): number {
  let h = 0x811c9dc5 ^ Math.imul(a | 0, 0x27d4eb2d);
  h = Math.imul(h ^ (b | 0), 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (c | 0), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  h = Math.imul(h ^ (d | 0), 0x9e3779b1);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash to float in [0, 1). */
export function hashFloat(a: number, b = 0, c = 0, d = 0): number {
  return hash4(a, b, c, d) / 4294967296;
}

/** Turns an arbitrary string into a 32-bit seed. */
export function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

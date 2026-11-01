/**
 * Procedural item models (design-voxel-survival §17.1): weapons, tools and
 * shields are merged boxes with vertex colours; food, materials and ammo are
 * their 16x16 sprite extruded into a thin voxel slab. Convention: grip at the
 * origin, blades and handles along +Y, shield faces toward -Z, the crossbow
 * stock points along -Z. Cached per (item, lod).
 *
 * Attributes: position, normal, color (u8 x3), light (u8 x4: shade, sky,
 * block, emissive) so the same geometry works with the voxel-lit item
 * material (first person, drops) and Lambert (third-person avatars).
 */
import * as THREE from 'three';
import { blockDef, FIRST_ITEM, Item, ItemKind, itemDef, itemTier, TIER_COLORS, UNIQUE_COLORS } from '@hub/shared';
import { itemSprite } from '../world/itemSprites';

export type ModelLod = 'fp' | 'tp';

interface Box {
  s: [number, number, number];
  p: [number, number, number];
  r?: [number, number, number];
  c: number;
  e?: boolean;
  /** First person only (detail). */
  fp?: boolean;
}

const FACES: { n: [number, number, number]; v: [number, number, number][]; shade: number }[] = [
  { n: [1, 0, 0], v: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]], shade: 0.8 },
  { n: [-1, 0, 0], v: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]], shade: 0.8 },
  { n: [0, 1, 0], v: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]], shade: 1 },
  { n: [0, -1, 0], v: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]], shade: 0.55 },
  { n: [0, 0, 1], v: [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]], shade: 0.9 },
  { n: [0, 0, -1], v: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]], shade: 0.7 },
];

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  lig: number[] = [];
  idx: number[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly nm = new THREE.Matrix3();

  box(b: Box): void {
    this.m.compose(this.v.set(...b.p), this.q.setFromEuler(this.e.set(...(b.r ?? [0, 0, 0]))), new THREE.Vector3(b.s[0] / 2, b.s[1] / 2, b.s[2] / 2));
    this.nm.getNormalMatrix(this.m);
    const r = (b.c >> 16) & 255;
    const g = (b.c >> 8) & 255;
    const bl = b.c & 255;
    for (const f of FACES) {
      const base = this.pos.length / 3;
      const n = new THREE.Vector3(...f.n).applyMatrix3(this.nm).normalize();
      for (const c of f.v) {
        this.v.set(c[0], c[1], c[2]).applyMatrix4(this.m);
        this.pos.push(this.v.x, this.v.y, this.v.z);
        this.nor.push(n.x, n.y, n.z);
        this.col.push(r, g, bl);
        this.lig.push(Math.round(f.shade * 255), 255, 0, b.e ? 255 : 0);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** One quad (for extruded sprites). */
  quad(v: [number, number, number][], n: [number, number, number], c: number, shade: number): void {
    const base = this.pos.length / 3;
    for (const p of v) {
      this.pos.push(...p);
      this.nor.push(...n);
      this.col.push((c >> 16) & 255, (c >> 8) & 255, c & 255);
      this.lig.push(Math.round(shade * 255), 255, 0, 0);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.col), 3, true));
    g.setAttribute('light', new THREE.BufferAttribute(new Uint8Array(this.lig), 4, true));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const WOOD = 0x8a5a32;
const WOOD_DARK = 0x5a3a1e;
const WRAP = 0x8a5a32;
const GOLD = 0xf2c63a;

function colors(id: number): { main: number; light: number; dark: number; accent: number; glow?: boolean } {
  const u = UNIQUE_COLORS[id];
  if (u) return { main: u[0], light: 0xffffff, dark: u[1], accent: u[1], glow: true };
  const t = itemTier(id);
  const [main, light, dark] = TIER_COLORS[t];
  return { main, light, dark, accent: t === 4 ? GOLD : dark };
}

function sword(id: number): Box[] {
  const c = colors(id);
  return [
    { s: [0.07, 0.07, 0.07], p: [0, -0.13, 0], c: c.accent },
    { s: [0.045, 0.17, 0.045], p: [0, -0.02, 0], c: 0x5a3a1e },
    { s: [0.055, 0.025, 0.055], p: [0, -0.06, 0], c: WRAP, fp: true },
    { s: [0.055, 0.025, 0.055], p: [0, 0.02, 0], c: WRAP, fp: true },
    { s: [0.26, 0.045, 0.07], p: [0, 0.085, 0], c: c.accent },
    { s: [0.075, 0.56, 0.022], p: [0, 0.39, 0], c: c.main },
    { s: [0.012, 0.54, 0.024], p: [0.042, 0.39, 0], c: c.light, fp: true },
    { s: [0.012, 0.54, 0.024], p: [-0.042, 0.39, 0], c: c.light, fp: true },
    { s: [0.014, 0.3, 0.026], p: [0, 0.3, 0], c: c.dark, fp: true },
    { s: [0.055, 0.05, 0.02], p: [0, 0.695, 0], c: c.main },
    { s: [0.03, 0.04, 0.018], p: [0, 0.735, 0], c: c.light },
    ...(c.glow ? [{ s: [0.02, 0.4, 0.03] as [number, number, number], p: [0, 0.38, 0] as [number, number, number], c: c.accent, e: true, fp: true }] : []),
  ];
}

function axe(id: number): Box[] {
  const c = colors(id);
  return [
    { s: [0.05, 0.68, 0.05], p: [0, 0.24, 0], c: WOOD },
    { s: [0.06, 0.06, 0.06], p: [0, -0.1, 0], c: WOOD_DARK, fp: true },
    { s: [0.06, 0.14, 0.07], p: [0, 0.52, 0], c: c.dark },
    { s: [0.14, 0.2, 0.035], p: [0.1, 0.52, 0], c: c.main },
    { s: [0.04, 0.24, 0.04], p: [0.19, 0.52, 0], c: c.light },
    { s: [0.07, 0.08, 0.06], p: [-0.06, 0.52, 0], c: c.dark },
    ...(c.glow ? [{ s: [0.012, 0.2, 0.042] as [number, number, number], p: [0.205, 0.52, 0] as [number, number, number], c: c.accent, e: true }] : []),
  ];
}

function pickaxe(id: number): Box[] {
  const c = colors(id);
  const out: Box[] = [{ s: [0.05, 0.68, 0.05], p: [0, 0.24, 0], c: WOOD }, { s: [0.09, 0.09, 0.12], p: [0, 0.56, 0], c: c.dark }];
  for (const side of [-1, 1]) {
    out.push({ s: [0.12, 0.07, 0.07], p: [side * 0.1, 0.55, 0], r: [0, 0, side * 0.21], c: c.main });
    out.push({ s: [0.12, 0.05, 0.05], p: [side * 0.21, 0.51, 0], r: [0, 0, side * 0.42], c: c.light });
  }
  return out;
}

function shovel(id: number): Box[] {
  const c = colors(id);
  return [
    { s: [0.05, 0.6, 0.05], p: [0, 0.2, 0], c: WOOD },
    { s: [0.07, 0.07, 0.07], p: [0, 0.5, 0], c: c.dark },
    { s: [0.18, 0.2, 0.03], p: [0, 0.63, 0], c: c.main },
    { s: [0.12, 0.05, 0.03], p: [0, 0.755, 0], c: c.light },
  ];
}

function shield(id: number): Box[] {
  const wooden = id === Item.WoodenShield;
  const face = wooden ? 0x9a6b3c : id === Item.IronShield ? 0xb8bec8 : 0x2f6fe0;
  const rim = wooden ? 0xc8743a : id === Item.IronShield ? 0x6a707c : GOLD;
  const out: Box[] = [];
  if (wooden) {
    for (let i = 0; i < 5; i++) out.push({ s: [0.1, 0.3, 0.05], p: [-0.2 + i * 0.1, 0.07, 0], c: i % 2 ? 0x8a5f34 : 0x9a6b3c });
  } else out.push({ s: [0.5, 0.3, 0.05], p: [0, 0.07, 0], c: face });
  out.push(
    { s: [0.44, 0.16, 0.05], p: [0, -0.16, 0], c: face },
    { s: [0.3, 0.12, 0.05], p: [0, -0.3, 0], c: face },
    { s: [0.54, 0.03, 0.06], p: [0, 0.235, 0], c: rim },
    { s: [0.03, 0.3, 0.06], p: [-0.26, 0.07, 0], c: rim },
    { s: [0.03, 0.3, 0.06], p: [0.26, 0.07, 0], c: rim },
    { s: [0.03, 0.3, 0.06], p: [-0.2, -0.22, 0], r: [0, 0, -0.5], c: rim, fp: true },
    { s: [0.03, 0.3, 0.06], p: [0.2, -0.22, 0], r: [0, 0, 0.5], c: rim, fp: true },
    { s: [0.12, 0.12, 0.05], p: [0, 0.02, -0.03], c: 0xb8bec8 },
    { s: [0.06, 0.2, 0.03], p: [0, 0.02, 0.04], c: 0x5a3a1e, fp: true },
  );
  if (id === Item.CobaltShield) {
    out.push({ s: [0.03, 0.18, 0.02], p: [-0.06, -0.12, -0.035], r: [0, 0, 0.6], c: 0xe8f0ff, fp: true });
    out.push({ s: [0.03, 0.18, 0.02], p: [0.06, -0.12, -0.035], r: [0, 0, -0.6], c: 0xe8f0ff, fp: true });
  }
  return out;
}

/** Bow limbs bend away from the player (-Z at the grip, tips toward +Z). */
function bow(id: number): Box[] {
  const unique = id === Item.ThornheartBow;
  const limb = unique ? 0x3f8a3a : WOOD;
  const out: Box[] = [{ s: [0.05, 0.1, 0.05], p: [0, 0, 0], c: WOOD_DARK }];
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue;
    const a = (i / 3) * 0.96;
    out.push({ s: [0.04, 0.13, 0.04], p: [0, Math.sin(a) * 0.5, 0.5 - Math.cos(a) * 0.5], r: [-a, 0, 0], c: Math.abs(i) === 3 ? WOOD_DARK : limb });
    if (unique && Math.abs(i) === 2) out.push({ s: [0.02, 0.04, 0.02], p: [0, Math.sin(a) * 0.5, 0.47 - Math.cos(a) * 0.5], c: 0xc83a2a, e: true, fp: true });
  }
  return out;
}

function crossbow(id: number): Box[] {
  const c = id === Item.Crossbow ? { main: 0xd8dde6, dark: 0x8a909c } : id === Item.RimeboundCrossbow ? { main: 0xbfe8ff, dark: 0x5a9ad8 } : { main: 0x2f6fe0, dark: 0x1a3a8a };
  return [
    { s: [0.07, 0.06, 0.55], p: [0, 0, -0.12], c: WOOD },
    { s: [0.03, 0.02, 0.4], p: [0, 0.04, -0.2], c: WOOD_DARK, fp: true },
    { s: [0.24, 0.035, 0.035], p: [0, 0.03, -0.37], c: c.main },
    { s: [0.2, 0.03, 0.03], p: [-0.2, 0.03, -0.34], r: [0, 0.35, 0], c: c.main },
    { s: [0.2, 0.03, 0.03], p: [0.2, 0.03, -0.34], r: [0, -0.35, 0], c: c.main },
    { s: [0.12, 0.02, 0.03], p: [0, -0.02, -0.41], c: c.dark, fp: true },
    { s: [0.02, 0.05, 0.02], p: [0, -0.05, 0.02], c: c.dark, fp: true },
  ];
}

/** Extruded sprite: one quad per same-colour run on each side, plus edge faces. */
function extrude(id: number, size: number): THREE.BufferGeometry {
  const b = new Builder();
  const px = itemSprite(id);
  if (!px) {
    b.box({ s: [size * 0.5, size * 0.5, size * 0.5], p: [0, 0, 0], c: itemDef(id)?.color ?? 0x888888 });
    return b.geometry();
  }
  const k = size / 16;
  const t = k * 1.1;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x > 15 || y > 15 || px[(y * 16 + x) * 4 + 3] < 128 ? -1 : (px[(y * 16 + x) * 4] << 16) | (px[(y * 16 + x) * 4 + 1] << 8) | px[(y * 16 + x) * 4 + 2]);
  const X = (x: number) => (x - 8) * k;
  const Y = (y: number) => (8 - y) * k;
  for (let y = 0; y < 16; y++) {
    let x = 0;
    while (x < 16) {
      const c = at(x, y);
      if (c < 0) {
        x++;
        continue;
      }
      let e = x + 1;
      while (e < 16 && at(e, y) === c) e++;
      b.quad([[X(x), Y(y + 1), t / 2], [X(e), Y(y + 1), t / 2], [X(e), Y(y), t / 2], [X(x), Y(y), t / 2]], [0, 0, 1], c, 0.95);
      b.quad([[X(x), Y(y), -t / 2], [X(e), Y(y), -t / 2], [X(e), Y(y + 1), -t / 2], [X(x), Y(y + 1), -t / 2]], [0, 0, -1], c, 0.75);
      x = e;
    }
  }
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const c = at(x, y);
    if (c < 0) continue;
    if (at(x, y - 1) < 0) b.quad([[X(x), Y(y), t / 2], [X(x + 1), Y(y), t / 2], [X(x + 1), Y(y), -t / 2], [X(x), Y(y), -t / 2]], [0, 1, 0], c, 1);
    if (at(x, y + 1) < 0) b.quad([[X(x), Y(y + 1), -t / 2], [X(x + 1), Y(y + 1), -t / 2], [X(x + 1), Y(y + 1), t / 2], [X(x), Y(y + 1), t / 2]], [0, -1, 0], c, 0.55);
    if (at(x - 1, y) < 0) b.quad([[X(x), Y(y + 1), t / 2], [X(x), Y(y), t / 2], [X(x), Y(y), -t / 2], [X(x), Y(y + 1), -t / 2]], [-1, 0, 0], c, 0.8);
    if (at(x + 1, y) < 0) b.quad([[X(x + 1), Y(y + 1), -t / 2], [X(x + 1), Y(y), -t / 2], [X(x + 1), Y(y), t / 2], [X(x + 1), Y(y + 1), t / 2]], [1, 0, 0], c, 0.8);
  }
  return b.geometry();
}

/** Box list for weapons, tools and shields; null for sprite items. */
function boxesFor(id: number): Box[] | null {
  const def = itemDef(id);
  if (!def || def.kind === ItemKind.Food || def.kind === ItemKind.Material || def.kind === ItemKind.Ammo || def.kind === ItemKind.Special) return null;
  if (def.shield) return shield(id);
  if (def.ranged) return def.ranged.type === 'bow' ? bow(id) : crossbow(id);
  if (def.tool?.kind === 'pick') return pickaxe(id);
  if (def.tool?.kind === 'shovel') return shovel(id);
  if (def.tool?.kind === 'axe') return axe(id);
  if (def.melee) return sword(id);
  return null;
}

const cache = new Map<string, THREE.BufferGeometry>();

/** Geometry for an item (cached; do not dispose). Blocks: a small coloured cube (third person). */
export function buildItemModel(id: number, lod: ModelLod): THREE.BufferGeometry {
  const key = `${id}:${lod}`;
  let g = cache.get(key);
  if (g) return g;
  if (id < FIRST_ITEM) {
    const b = new Builder();
    b.box({ s: [0.22, 0.22, 0.22], p: [0, 0.11, 0], c: blockDef(id).color });
    g = b.geometry();
  } else {
    const boxes = boxesFor(id);
    if (boxes) {
      const b = new Builder();
      for (const box of boxes) if (lod === 'fp' || !box.fp) b.box(box);
      g = b.geometry();
    } else g = extrude(id, lod === 'fp' ? 0.32 : 0.26);
  }
  cache.set(key, g);
  return g;
}

/** Third-person geometry for Avatars: blades point forward and up from the hand; shields face forward. */
export function buildThirdPersonModel(id: number): THREE.BufferGeometry {
  const key = `${id}:tp-held`;
  let g = cache.get(key);
  if (g) return g;
  const def = itemDef(id);
  g = buildItemModel(id, 'tp').clone();
  if (def?.ranged?.type === 'crossbow') g.translate(0, 0, 0.05);
  else if (def?.ranged?.type === 'bow') g.rotateY(Math.PI / 2).rotateZ(0.2);
  else if (!def?.shield) g.rotateX(-1.1);
  cache.set(key, g);
  return g;
}

/** Flying arrow / bolt (ghosts): shaft along -Z from the origin, head at -Z. Sizes from design-voxel-survival §17.5. */
export function buildProjectileModel(kind: 'arrow' | 'bolt' | 'ember'): THREE.BufferGeometry {
  const key = `proj:${kind}`;
  let g = cache.get(key);
  if (g) return g;
  const b = new Builder();
  if (kind === 'bolt') {
    b.box({ s: [0.035, 0.035, 0.42], p: [0, 0, -0.21], c: 0x6a4a2a });
    b.box({ s: [0.055, 0.055, 0.07], p: [0, 0, -0.44], c: 0xc8743a });
    b.box({ s: [0.004, 0.05, 0.08], p: [0, 0, -0.04], c: 0x3a3a40 });
    b.box({ s: [0.05, 0.004, 0.08], p: [0, 0, -0.04], c: 0x3a3a40 });
  } else {
    b.box({ s: [0.025, 0.025, 0.6], p: [0, 0, -0.3], c: 0x9a7a4a });
    b.box({ s: [0.05, 0.05, 0.08], p: [0, 0, -0.62], c: kind === 'ember' ? 0xff6a2a : 0x5a5a64, e: kind === 'ember' });
    b.box({ s: [0.004, 0.06, 0.12], p: [0, 0, -0.06], c: 0xf0f0f0 });
    b.box({ s: [0.06, 0.004, 0.12], p: [0, 0, -0.06], c: 0xd23a3a });
  }
  g = b.geometry();
  cache.set(key, g);
  return g;
}

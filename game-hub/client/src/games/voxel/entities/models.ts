/**
 * Procedural box models of every creature, boss and creature projectile
 * (design-voxel-mobs §11.2). A model is a small hierarchy of boxes: each part
 * hangs off a joint in its parent's joint space, has a rest rotation, an
 * anchor (which face sits on the joint) and a palette colour. animate.ts
 * moves the joints by role; EntityRenderer turns parts into instances.
 *
 * Coordinates: blocks, feet at y 0, facing -Z. Rotations in degrees: pitch
 * (X), yaw (Y), roll (Z), three.js handedness.
 */
import { MobKind, MobVariant, ProjectileKind } from '@hub/shared';

export type Anchor = 'c' | 't' | 'b' | 'f' | 'k' | 'l' | 'r';
export type Role =
  | 'legA' | 'legB' | 'armL' | 'armR' | 'arm2L' | 'arm2R' | 'head' | 'neck' | 'torso' | 'tail' | 'ear'
  | 'wingL' | 'wingR' | 'finL' | 'finR' | 'jaw' | 'jawTop' | 'jawBottom' | 'cap' | 'halo' | 'orbit'
  | 'stem' | 'leaf' | 'vineL' | 'vineR' | 'cape' | 'weapon' | 'bowstring' | 'blade' | 'spin';

export interface PartDef {
  id: string;
  parent?: string;
  size: [number, number, number];
  at: [number, number, number];
  anchor: Anchor;
  color: string;
  role?: Role;
  rot?: [number, number, number];
  detail?: boolean;
  emissive?: boolean;
  alpha?: number;
  /** Index within a repeated group (halo plates, orbiting shards, leaves, vine segments). */
  index?: number;
}

export interface ModelDef {
  palette: Record<string, number>;
  variants?: Partial<Record<MobVariant, Record<string, number>>>;
  parts: PartDef[];
  /** Walk-cycle radians per block travelled. */
  stride: number;
  /** Blob shadow radius. */
  shadow: number;
  biped?: boolean;
}

/** A part ready for rendering: parent index, numbers in radians, resolved anchor offset. */
export interface CompiledPart extends PartDef {
  parentIndex: number;
  restRad: [number, number, number];
  /** Offset from the joint to the box centre. */
  offset: [number, number, number];
}

export interface CompiledModel {
  def: ModelDef;
  parts: CompiledPart[];
  /** Highest point of the model at rest (nametags, sanity tests). */
  top: number;
}

const ROLES = new Set<string>(['legA', 'legB', 'armL', 'armR', 'arm2L', 'arm2R', 'head', 'neck', 'torso', 'tail', 'ear', 'wingL', 'wingR', 'finL', 'finR', 'jaw', 'jawTop', 'jawBottom', 'cap', 'halo', 'orbit', 'stem', 'leaf', 'vineL', 'vineR', 'cape', 'weapon', 'bowstring', 'blade', 'spin']);

/** Parses lines "id parent w h d x y z anchor colour [role] [detail] [emissive] [alpha 0.9] [rot(p,y,r)]". */
function parts(table: string): PartDef[] {
  const out: PartDef[] = [];
  for (const raw of table.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const rot = /rot\(([^)]*)\)/.exec(line);
    const tok = line.replace(/rot\([^)]*\)/, '').split(/\s+/);
    const [id, parent, w, h, d, x, y, z, anchor, color, ...rest] = tok;
    const p: PartDef = { id, size: [+w, +h, +d], at: [+x, +y, +z], anchor: anchor as Anchor, color };
    if (parent !== '-') p.parent = parent;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      if (ROLES.has(t)) p.role = t as Role;
      else if (t === 'detail') p.detail = true;
      else if (t === 'emissive') p.emissive = true;
      else if (t === 'alpha') p.alpha = +rest[++i];
    }
    if (rot) p.rot = rot[1].split(',').map(Number) as [number, number, number];
    out.push(p);
  }
  return out;
}

const hex = (o: Record<string, string>): Record<string, number> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, parseInt(v, 16)]));

// ---- friendly ------------------------------------------------------------------------------

const WOOLBACK: ModelDef = {
  palette: hex({ wool: 'e9e4d8', skin: '5a4636', horn: 'cbb894', eye: '17141a', nose: '3a2e26' }),
  variants: { [MobVariant.Frost]: hex({ wool: 'f6f8fb', skin: '6a6070' }), [MobVariant.Sand]: hex({ wool: 'd8c39a', skin: '6e5236' }) },
  stride: 2.6,
  shadow: 0.7,
  parts: parts(`
    body   -     0.90 0.62 1.20   0 0.50 0         b wool  torso
    tuft   body  0.70 0.14 0.90   0 0.62 0         b wool  detail
    belly  body  0.80 0.10 1.00   0 -0.04 0        b wool  detail
    head   -     0.40 0.40 0.42   0 0.92 -0.58     f skin  head
    cap    head  0.50 0.18 0.30   0 0.20 -0.12     b wool  detail
    hornL  head  0.12 0.12 0.30  -0.25 0.14 -0.12  k horn  detail rot(30,25,0)
    hornR  head  0.12 0.12 0.30   0.25 0.14 -0.12  k horn  detail rot(30,-25,0)
    eyeL   head  0.07 0.07 0.02  -0.12 0.06 -0.42  c eye   detail
    eyeR   head  0.07 0.07 0.02   0.12 0.06 -0.42  c eye   detail
    nose   head  0.16 0.08 0.02   0 -0.10 -0.43    c nose  detail
    legFL  -     0.18 0.50 0.18  -0.27 0.50 -0.40  t skin  legA
    legFR  -     0.18 0.50 0.18   0.27 0.50 -0.40  t skin  legB
    legBL  -     0.18 0.50 0.18  -0.27 0.50 0.40   t skin  legB
    legBR  -     0.18 0.50 0.18   0.27 0.50 0.40   t skin  legA
    tail   body  0.18 0.22 0.12   0 0.46 0.60      k wool  tail detail
  `),
};

const HOPLING: ModelDef = {
  palette: hex({ fur: 'c8a27a', belly: 'f0e2c8', tip: '6a4a3a', eye: '17141a' }),
  variants: { [MobVariant.Sand]: hex({ fur: 'e0c890' }), [MobVariant.Frost]: hex({ fur: 'f4f4f8', tip: '9aa0b0' }) },
  stride: 3.0,
  shadow: 0.35,
  parts: parts(`
    body   -     0.42 0.36 0.50   0 0.12 0.02      b fur   torso
    belly  body  0.32 0.24 0.04   0 0.04 -0.25     b belly detail
    head   -     0.32 0.30 0.30   0 0.40 -0.20     f fur   head
    earL   head  0.08 0.34 0.06  -0.08 0.14 -0.10  b fur   ear rot(-10,0,8)
    earR   head  0.08 0.34 0.06   0.08 0.14 -0.10  b fur   ear rot(-10,0,-8)
    tipL   earL  0.09 0.08 0.07   0 0.34 0         b tip   detail
    tipR   earR  0.09 0.08 0.07   0 0.34 0         b tip   detail
    eyeL   head  0.02 0.07 0.07  -0.165 0.04 -0.18 c eye   detail
    eyeR   head  0.02 0.07 0.07   0.165 0.04 -0.18 c eye   detail
    nose   head  0.07 0.05 0.02   0 -0.02 -0.30    c tip   detail
    footL  -     0.12 0.10 0.30  -0.14 0.10 0.08   t fur   legA
    footR  -     0.12 0.10 0.30   0.14 0.10 0.08   t fur   legA
    pawL   -     0.08 0.12 0.08  -0.10 0.12 -0.16  t belly legB detail
    pawR   -     0.08 0.12 0.08   0.10 0.12 -0.16  t belly legB detail
    tail   body  0.16 0.16 0.12   0 0.22 0.25      k belly tail detail
  `),
};

const CLUCKIT: ModelDef = {
  palette: hex({ body: 'f2efe6', wing: 'e6dfcf', crest: 'd8442a', beak: 'f0b030', leg: 'e0a030', eye: '17141a' }),
  variants: { [MobVariant.Tropical]: hex({ body: '3fa34a', wing: '2f7a3a', crest: 'e8402a' }) },
  stride: 4.0,
  shadow: 0.35,
  parts: parts(`
    body   -     0.40 0.36 0.50   0 0.26 0         b body  torso
    head   -     0.26 0.28 0.24   0 0.58 -0.20     b body  head
    crest  head  0.05 0.16 0.22   0 0.28 0.02      b crest detail
    beak   head  0.10 0.07 0.12   0 0.12 -0.12     f beak
    wattle head  0.06 0.09 0.04   0 0.06 -0.14     t crest detail
    eyeL   head  0.02 0.05 0.05  -0.135 0.17 -0.05 c eye   detail
    eyeR   head  0.02 0.05 0.05   0.135 0.17 -0.05 c eye   detail
    wingL  -     0.06 0.26 0.36  -0.23 0.58 0.02   t wing  wingL
    wingR  -     0.06 0.26 0.36   0.23 0.58 0.02   t wing  wingR
    tail   body  0.30 0.28 0.06   0 0.30 0.25      b wing  tail detail rot(-25,0,0)
    legL   -     0.05 0.26 0.05  -0.09 0.26 0      t leg   legA
    legR   -     0.05 0.26 0.05   0.09 0.26 0      t leg   legB
    footL  legL  0.10 0.03 0.14   0 -0.26 -0.03    t leg   detail
    footR  legR  0.10 0.03 0.14   0 -0.26 -0.03    t leg   detail
  `),
};

const FERNHART: ModelDef = {
  palette: hex({ coat: '8a5a3a', belly: 'd8c0a0', antler: '6a5a3a', moss: '5a8a3a', dark: '3a2a20', eye: '17141a' }),
  variants: { [MobVariant.Frost]: hex({ coat: 'b8b0a8', moss: '9ab8c0' }) },
  stride: 2.2,
  shadow: 0.6,
  parts: parts(`
    body   -     0.50 0.55 1.20   0 0.80 0         b coat  torso
    belly  body  0.40 0.06 0.90   0 -0.02 0        b belly detail
    neck   -     0.24 0.55 0.24   0 1.20 -0.48     b coat  neck rot(-25,0,0)
    head   neck  0.28 0.28 0.44   0 0.55 0.04      f coat  head
    snout  head  0.18 0.14 0.12   0 -0.05 -0.44    f dark  detail
    earL   head  0.22 0.06 0.12  -0.17 0.12 -0.06  c moss  ear detail
    earR   head  0.22 0.06 0.12   0.17 0.12 -0.06  c moss  ear detail
    antL   head  0.06 0.45 0.06  -0.09 0.14 0.02   b antler detail rot(0,0,20)
    antR   head  0.06 0.45 0.06   0.09 0.14 0.02   b antler detail rot(0,0,-20)
    tineL  antL  0.22 0.06 0.06  -0.08 0.28 0      c antler detail
    tineR  antR  0.22 0.06 0.06   0.08 0.28 0      c antler detail
    mossL  antL  0.14 0.10 0.14   0 0.45 0         b moss  detail
    mossR  antR  0.14 0.10 0.14   0 0.45 0         b moss  detail
    eyeL   head  0.02 0.06 0.06  -0.145 0.06 -0.22 c eye   detail
    eyeR   head  0.02 0.06 0.06   0.145 0.06 -0.22 c eye   detail
    legFL  -     0.12 0.80 0.12  -0.16 0.80 -0.45  t coat  legA
    legFR  -     0.12 0.80 0.12   0.16 0.80 -0.45  t coat  legB
    legBL  -     0.12 0.80 0.12  -0.16 0.80 0.45   t coat  legB
    legBR  -     0.12 0.80 0.12   0.16 0.80 0.45   t coat  legA
    tail   body  0.12 0.18 0.06   0 0.50 0.60      t belly tail detail
  `),
};

const GLIMMERFIN: ModelDef = {
  palette: hex({ body: '3a7ac8', fin: '8ad0e8', glow: '9ff0ff', eye: '101010' }),
  variants: { [MobVariant.Frost]: hex({ body: 'a8c8e0' }) },
  stride: 0,
  shadow: 0,
  parts: parts(`
    body   -     0.22 0.28 0.50   0 0.04 0         b body  torso
    head   body  0.20 0.24 0.14   0 0.02 -0.25     f body  head
    tail   body  0.04 0.26 0.20   0 0.14 0.25      k fin   tail
    dorsal body  0.04 0.10 0.22   0 0.28 0.02      b fin   detail
    finL   body  0.12 0.03 0.10  -0.12 0.08 -0.08  c fin   finL detail
    finR   body  0.12 0.03 0.10   0.12 0.08 -0.08  c fin   finR detail
    spotL  body  0.02 0.05 0.05  -0.115 0.16 0.05  c glow  emissive detail
    spotR  body  0.02 0.05 0.05   0.115 0.16 0.05  c glow  emissive detail
    spot2L body  0.02 0.04 0.04  -0.115 0.08 0.15  c glow  emissive detail
    spot2R body  0.02 0.04 0.04   0.115 0.08 0.15  c glow  emissive detail
    eyeL   head  0.02 0.05 0.05  -0.105 0.14 -0.08 c eye   detail
    eyeR   head  0.02 0.05 0.05   0.105 0.14 -0.08 c eye   detail
  `),
};

// ---- hostile -------------------------------------------------------------------------------

const MUDLURCH: ModelDef = {
  palette: hex({ mud: '5a4434', dark: '3e2f24', moss: '5a7a3a', eye: 'ffb040' }),
  variants: {
    [MobVariant.Sand]: hex({ mud: 'b89a64', dark: '8a7048', moss: 'a8945a' }),
    [MobVariant.Frost]: hex({ mud: '8aa8c0', dark: '5a7890', moss: 'd8f0ff' }),
    [MobVariant.Moss]: hex({ moss: '6aa04a', mud: '4a5a34' }),
    [MobVariant.Ash]: hex({ mud: '4a4648', dark: '2e2a2c', moss: '6a3020', eye: 'ff6a2a' }),
  },
  stride: 2.0,
  shadow: 0.5,
  biped: true,
  parts: parts(`
    legL   -     0.22 0.75 0.24  -0.14 0.75 0      t dark  legA
    legR   -     0.22 0.75 0.24   0.14 0.75 0      t dark  legB
    hips   -     0.50 0.30 0.30   0 0.75 0         b dark
    torso  hips  0.62 0.62 0.40   0 0.30 0         b mud   torso rot(-18,0,0)
    hump   torso 0.50 0.20 0.32   0 0.60 0.06      b moss  detail
    hump2  hump  0.30 0.12 0.22   0.06 0.20 0.02   b moss  detail
    head   torso 0.40 0.38 0.40   0 0.58 -0.14     b mud   head
    jaw    head  0.34 0.10 0.30   0 0.04 -0.06     t dark  jaw detail
    eyeL   head  0.09 0.06 0.02  -0.10 0.24 -0.205 c eye   emissive
    eyeR   head  0.09 0.06 0.02   0.10 0.24 -0.205 c eye   emissive
    armL   torso 0.18 0.86 0.20  -0.41 0.52 0      t mud   armL
    armR   torso 0.18 0.86 0.20   0.41 0.52 0      t mud   armR
    handL  armL  0.24 0.22 0.24   0 -0.86 0        t dark  detail
    handR  armR  0.24 0.22 0.24   0 -0.86 0        t dark  detail
    drip   torso 0.06 0.20 0.06   0.20 0.02 -0.18  t dark  detail
    drip2  armL  0.05 0.14 0.05   0.05 -0.4 -0.1   t dark  detail
  `),
};

const RATTLEBOW: ModelDef = {
  palette: hex({ bone: 'e8e0cc', wood: '9a8a6a', cowl: '3a4a5a', eye: '7fd0ff', string: 'd8d8d8' }),
  variants: {
    [MobVariant.Sand]: hex({ cowl: 'b08a4a' }),
    [MobVariant.Frost]: hex({ bone: 'f0f4f8', cowl: '8ab0d0' }),
    [MobVariant.Ash]: hex({ bone: '9a948a', cowl: '2a2224', eye: 'ff7a3a' }),
  },
  stride: 2.2,
  shadow: 0.45,
  biped: true,
  parts: parts(`
    legL     -      0.09 0.85 0.09  -0.10 0.85 0      t bone legA
    legR     -      0.09 0.85 0.09   0.10 0.85 0      t bone legB
    pelvis   -      0.36 0.16 0.20   0 0.85 0         b bone
    spine    pelvis 0.10 0.45 0.10   0 0.16 0         b bone torso
    ribs     spine  0.44 0.34 0.26   0 0.28 0         c bone
    rib2     ribs   0.36 0.04 0.28   0 -0.06 0        c cowl detail
    cowl     spine  0.56 0.20 0.34   0 0.44 0         b cowl
    cloak    cowl   0.50 0.60 0.06   0 0 0.16         t cowl detail
    skull    spine  0.32 0.34 0.32   0 0.58 -0.02     b bone head
    hoodTop  skull  0.40 0.10 0.38   0 0.34 0.03      b cowl detail
    hoodBack skull  0.40 0.32 0.08   0 0.02 0.18      b cowl detail
    hoodL    skull  0.04 0.32 0.36  -0.20 0.02 0.01   b cowl detail
    hoodR    skull  0.04 0.32 0.36   0.20 0.02 0.01   b cowl detail
    eyeL     skull  0.07 0.05 0.02  -0.08 0.18 -0.165 c eye  emissive
    eyeR     skull  0.07 0.05 0.02   0.08 0.18 -0.165 c eye  emissive
    armL     spine  0.08 0.70 0.08  -0.26 0.46 0      t bone armL
    armR     spine  0.08 0.70 0.08   0.26 0.46 0      t bone armR
    bow      armL   0.05 0.90 0.08   0 -0.62 -0.06    c wood weapon
    string   bow    0.01 0.86 0.01   0 0 0.06         c string bowstring detail
  `),
};

const CRAGCRAWLER: ModelDef = {
  palette: hex({ shell: '6a6e78', body: '3a2e2a', leg: '2a2220', eye: '8aff6a' }),
  variants: { [MobVariant.Moss]: hex({ shell: '5a7a4a' }), [MobVariant.Frost]: hex({ shell: '9ab8d0' }), [MobVariant.Ash]: hex({ shell: '3a3638', eye: 'ff5a2a' }) },
  stride: 5.0,
  shadow: 0.7,
  parts: parts(`
    abdomen -       0.80 0.36 0.62   0 0.28 0.22      b body  torso
    shell   abdomen 0.86 0.12 0.66   0 0.36 0         b shell
    ridge   shell   0.20 0.08 0.50   0 0.12 0         b shell detail
    plateL  shell   0.20 0.06 0.40  -0.25 0.10 0      b shell detail
    plateR  shell   0.20 0.06 0.40   0.25 0.10 0      b shell detail
    head    -       0.50 0.30 0.40   0 0.30 -0.28     b body  head
    mandL   head    0.08 0.06 0.22  -0.12 0.06 -0.20  f shell jaw detail
    mandR   head    0.08 0.06 0.22   0.12 0.06 -0.20  f shell jaw detail
    eyeL    head    0.07 0.07 0.02  -0.09 0.22 -0.205 c eye   emissive
    eyeR    head    0.07 0.07 0.02   0.09 0.22 -0.205 c eye   emissive
    eye2L   head    0.05 0.05 0.02  -0.19 0.16 -0.205 c eye   emissive detail
    eye2R   head    0.05 0.05 0.02   0.19 0.16 -0.205 c eye   emissive detail
    leg1L   -       0.62 0.08 0.08  -0.30 0.42 -0.25  l leg   legA rot(0,-20,35)
    leg2L   -       0.62 0.08 0.08  -0.30 0.42 0      l leg   legB rot(0,0,35)
    leg3L   -       0.62 0.08 0.08  -0.30 0.42 0.25   l leg   legA rot(0,20,35)
    leg1R   -       0.62 0.08 0.08   0.30 0.42 -0.25  r leg   legB rot(0,20,-35)
    leg2R   -       0.62 0.08 0.08   0.30 0.42 0      r leg   legA rot(0,0,-35)
    leg3R   -       0.62 0.08 0.08   0.30 0.42 0.25   r leg   legB rot(0,-20,-35)
  `),
};

const PUFFCAP: ModelDef = {
  palette: hex({ cap: 'b8402a', spot: 'f4e8d8', stem: 'e8dcc0', gill: 'c8b090', eye: '2a1a1a' }),
  variants: { [MobVariant.Moss]: hex({ cap: '6a8a3a', spot: 'd8e8a0' }) },
  stride: 3.0,
  shadow: 0.5,
  biped: true,
  parts: parts(`
    legL   -     0.14 0.20 0.16  -0.11 0.20 0      t stem legA
    legR   -     0.14 0.20 0.16   0.11 0.20 0      t stem legB
    stem   -     0.42 0.55 0.42   0 0.20 0         b stem torso
    gills  stem  0.80 0.06 0.80   0 0.55 0         t gill cap detail
    cap    stem  0.86 0.32 0.86   0 0.55 0         b cap  cap
    capTop cap   0.60 0.10 0.60   0 0.32 0         b cap  detail
    spot1  cap   0.16 0.04 0.16  -0.22 0.32 -0.20  b spot detail
    spot2  cap   0.14 0.04 0.14   0.24 0.32 -0.10  b spot detail
    spot3  cap   0.16 0.04 0.16   0.05 0.32 0.24   b spot detail
    spot4  cap   0.10 0.04 0.10  -0.28 0.32 0.20   b spot detail
    spot5  cap   0.12 0.12 0.02   0.18 0.12 -0.435 c spot detail
    eyeL   stem  0.07 0.10 0.02  -0.10 0.36 -0.215 c eye
    eyeR   stem  0.07 0.10 0.02   0.10 0.36 -0.215 c eye
    armL   stem  0.08 0.20 0.08  -0.25 0.42 0      t stem armL detail
    armR   stem  0.08 0.20 0.08   0.25 0.42 0      t stem armR detail
  `),
};

const DUSKWING: ModelDef = {
  palette: hex({ body: '3a2e4a', fuzz: '6a5a7a', wing: '4a3a6a', spot: 'ffd84a', eye: 'ff4a6a' }),
  stride: 0,
  shadow: 0.4,
  parts: parts(`
    body   -     0.24 0.24 0.50   0 0.30 0         c body torso
    collar body  0.30 0.30 0.14   0 0 -0.18        c fuzz detail
    head   body  0.20 0.20 0.16   0 0.02 -0.30     c body head
    eyeL   head  0.06 0.06 0.02  -0.06 0.03 -0.09  c eye  emissive
    eyeR   head  0.06 0.06 0.02   0.06 0.03 -0.09  c eye  emissive
    antL   head  0.03 0.03 0.26  -0.05 0.08 -0.06  f fuzz detail rot(40,15,0)
    antR   head  0.03 0.03 0.26   0.05 0.08 -0.06  f fuzz detail rot(40,-15,0)
    wingL  body  0.60 0.02 0.44  -0.12 0.08 -0.02  l wing wingL alpha 0.92
    wingR  body  0.60 0.02 0.44   0.12 0.08 -0.02  r wing wingR alpha 0.92
    spotL  wingL 0.14 0.025 0.14 -0.32 0 0.04      c spot emissive detail
    spotR  wingR 0.14 0.025 0.14  0.32 0 0.04      c spot emissive detail
    hindL  body  0.34 0.02 0.26  -0.10 0.06 0.18   l wing wingL detail alpha 0.92
    hindR  body  0.34 0.02 0.26   0.10 0.06 0.18   r wing wingR detail alpha 0.92
  `),
};

// ---- bosses -------------------------------------------------------------------------------

const SENTINEL: ModelDef = {
  palette: hex({ sand: 'd8b878', dark: 'a88850', gold: 'f2c63a', glow: 'ffe08a', eye: 'fff4c0' }),
  stride: 1.4,
  shadow: 1.4,
  biped: true,
  parts: [
    ...parts(`
      legL   -      0.50 0.90 0.55  -0.38 1.10 0      t sand legA
      legR   -      0.50 0.90 0.55   0.38 1.10 0      t sand legB
      footL  legL   0.60 0.20 0.75   0 -0.90 -0.08    t dark
      footR  legR   0.60 0.20 0.75   0 -0.90 -0.08    t dark
      pelvis -      1.10 0.40 0.70   0 1.10 0         b dark
      torso  pelvis 1.50 1.10 0.90   0 0.40 0         b sand torso
      belt   torso  1.56 0.14 0.96   0 0.05 0         b gold detail
      plate  torso  0.90 0.50 0.08   0 0.55 -0.45     f gold detail
      core   plate  0.30 0.30 0.06   0 0 -0.08        f glow emissive
      head   torso  0.70 0.62 0.66   0 1.10 -0.05     b gold head
      slitL  head   0.20 0.06 0.02  -0.16 0.36 -0.335 c eye  emissive
      slitR  head   0.20 0.06 0.02   0.16 0.36 -0.335 c eye  emissive
      crest  head   0.12 0.40 0.50   0 0.62 0.05      b gold detail
      uArmL  torso  0.42 1.10 0.42  -0.96 1.00 0      t sand armL
      uArmR  torso  0.42 1.10 0.42   0.96 1.00 0      t sand armR
      padL   uArmL  0.52 0.22 0.52   0 0.05 0         t gold detail
      padR   uArmR  0.52 0.22 0.52   0 0.05 0         t gold detail
      fistL  uArmL  0.55 0.50 0.55   0 -1.10 0        t gold
      fistR  uArmR  0.55 0.50 0.55   0 -1.10 0        t gold
      lArmL  torso  0.28 0.75 0.28  -0.86 0.45 -0.10  t dark arm2L
      lArmR  torso  0.28 0.75 0.28   0.86 0.45 -0.10  t dark arm2R
      handL  lArmL  0.32 0.30 0.32   0 -0.75 0        t gold detail
      handR  lArmR  0.32 0.30 0.32   0 -0.75 0        t gold detail
    `),
    ...ring(8, (i) => ({ id: `halo${i}`, parent: 'torso', size: [0.24, 0.24, 0.1], at: [0, 1.25, 0.6], anchor: 'c', color: 'gold', role: 'halo', emissive: true, index: i })),
  ],
};

const WARDEN: ModelDef = {
  palette: hex({ robe: '6a8aa8', robeDark: '3a5070', ice: 'bfe8ff', void: '10182a', glow: '8ae0ff' }),
  stride: 0,
  shadow: 1.0,
  parts: [
    ...parts(`
      hem       -         1.20 0.60 1.00   0 0 0           b robeDark
      robe2     hem       1.00 0.60 0.85   0 0.60 0        b robe
      robe3     robe2     0.85 0.60 0.70   0 0.60 0        b robeDark torso
      sash      robe3     0.90 0.10 0.75   0 0.10 0        b ice detail
      shoulders robe3     1.30 0.30 0.75   0 0.60 0        b ice
      hood      shoulders 0.60 0.62 0.60   0 0.30 -0.02    b robeDark head
      face      hood      0.42 0.40 0.02   0 0.10 -0.305   b void
      eyeL      hood      0.10 0.05 0.02  -0.10 0.36 -0.315 c glow emissive
      eyeR      hood      0.10 0.05 0.02   0.10 0.36 -0.315 c glow emissive
      armL      shoulders 0.24 1.00 0.24  -0.62 0.15 0     t robe armL
      armR      shoulders 0.24 1.00 0.24   0.62 0.15 0     t robe armR
      clawL     armL      0.30 0.32 0.20   0 -1.00 0       t ice
      clawR     armR      0.30 0.32 0.20   0 -1.00 0       t ice
    `),
    ...[-0.22, -0.11, 0, 0.11, 0.22].map((x, i): PartDef => ({ id: `spike${i}`, parent: 'hood', size: [0.08, i === 2 ? 0.4 : 0.3, 0.08], at: [x, 0.62, 0], anchor: 'b', color: 'ice', emissive: true, detail: true })),
    ...ring(4, (i) => ({ id: `orbit${i}`, size: [0.16, 0.36, 0.16], at: [0, 1.6, 0], anchor: 'c', color: 'ice', role: 'orbit', emissive: true, index: i })),
  ],
};

const THORNMAW: ModelDef = {
  palette: hex({ stem: '4a7a3a', dark: '2f5a2a', petal: 'c83a6a', inner: 'f08ab0', maw: '3a0a1a', teeth: 'f4ecd8', leaf: '5aa04a', thorn: '8a6a3a', glow: 'd8ff8a' }),
  stride: 0,
  shadow: 1.6,
  parts: [
    ...parts(`
      mound   -      1.60 0.40 1.60   0 0 0          b dark
      stem1   mound  0.60 0.50 0.60   0 0.40 0       b stem stem
      stem2   stem1  0.55 0.50 0.55   0 0.50 0       b stem stem
      stem3   stem2  0.50 0.50 0.50   0 0.50 0       b stem stem
      bulb    stem3  1.40 0.90 1.40   0 0.50 0       b petal head
      maw     bulb   1.10 0.45 0.90   0 0.40 -0.10   b maw
      jawTop  bulb   1.50 0.35 1.30   0 0.90 0.65    f petal jawTop
      lip     bulb   1.40 0.20 1.20   0 0.45 0.60    f inner jawBottom
      teethT  jawTop 1.10 0.12 0.08   0 -0.18 -1.20  c teeth detail
      teethB  lip    1.10 0.12 0.08   0 0.16 -1.10   c teeth detail
    `),
    ...[-0.35, 0, 0.35].map((x, i): PartDef => ({ id: `glow${i}`, parent: 'bulb', size: [0.12, 0.12, 0.02], at: [x, 0.25, -0.71], anchor: 'c', color: 'glow', emissive: true, detail: true })),
    ...ring(6, (i) => ({ id: `leaf${i}`, size: [0.5, 0.08, 1.3], at: [0, 0.05, 0], anchor: 'f', color: 'leaf', role: 'leaf', index: i })),
    ...vine('L', -0.4),
    ...vine('R', 0.4),
  ],
};

const KNIGHT: ModelDef = {
  palette: hex({ armor: '4a4a52', dark: '2e2e34', ember: 'ff6a2a', cape: '5a1e1e', blade: '8a8a94', edge: 'ffb05a' }),
  stride: 1.6,
  shadow: 1.2,
  biped: true,
  parts: parts(`
    legL   -      0.38 0.90 0.42  -0.26 1.05 0      t dark  legA
    legR   -      0.38 0.90 0.42   0.26 1.05 0      t dark  legB
    bootL  legL   0.44 0.15 0.60   0 -0.90 -0.06    t armor
    bootR  legR   0.44 0.15 0.60   0 -0.90 -0.06    t armor
    hips   -      0.90 0.35 0.55   0 1.05 0         b armor
    torso  hips   1.10 0.95 0.65   0 0.35 0         b armor torso
    crack  torso  0.20 0.40 0.04   0.15 0.45 -0.33  c ember emissive detail
    crack2 torso  0.30 0.06 0.04  -0.10 0.55 -0.33  c ember emissive detail
    pauldL torso  0.55 0.32 0.62  -0.62 0.95 0      c dark
    pauldR torso  0.55 0.32 0.62   0.62 0.95 0      c dark
    helm   torso  0.56 0.62 0.58   0 0.95 -0.02     b armor head
    visor  helm   0.38 0.06 0.02   0 0.36 -0.30     c ember emissive
    plume  helm   0.10 0.30 0.60   0 0.62 0.05      b cape  detail
    armL   pauldL 0.30 0.90 0.32   0 -0.10 0        t armor armL
    armR   pauldR 0.30 0.90 0.32   0 -0.10 0        t armor armR
    gauntL armL   0.34 0.30 0.36   0 -0.90 0        t dark
    gauntR armR   0.34 0.30 0.36   0 -0.90 0        t dark
    grip   gauntR 0.10 0.35 0.10   0 -0.15 -0.10    c dark  weapon rot(70,0,0)
    guard  grip   0.50 0.10 0.16   0 0.20 0         c blade
    blade  guard  0.12 1.70 0.32   0 0.05 0         b blade blade
    cape   torso  0.95 1.40 0.06   0 0.90 0.34      t cape  cape
  `),
};

function ring(n: number, make: (i: number) => PartDef): PartDef[] {
  return Array.from({ length: n }, (_, i) => make(i));
}

function vine(side: 'L' | 'R', x: number): PartDef[] {
  const out: PartDef[] = [];
  const th = [0.22, 0.2, 0.18, 0.16];
  for (let i = 0; i < 4; i++) {
    out.push({ id: `vine${side}${i}`, parent: i ? `vine${side}${i - 1}` : 'stem2', size: [th[i], th[i], 0.7], at: i ? [0, 0, -0.7] : [x, 0.3, 0], anchor: 'f', color: 'stem', role: side === 'L' ? 'vineL' : 'vineR', index: i, rot: i ? undefined : [-20, side === 'L' ? 50 : -50, 0] });
    if (i === 1 || i === 3) out.push({ id: `thorn${side}${i}`, parent: `vine${side}${i}`, size: [0.08, 0.16, 0.08], at: [0, 0.1, -0.35], anchor: 'b', color: 'thorn', detail: true });
  }
  return out;
}

// ---- projectiles -------------------------------------------------------------------------

const arrowModel = (fletch: string, shaft = 0.6): ModelDef => ({
  palette: hex({ wood: '9a7a4a', head: '8a8a94', fletch }),
  stride: 0,
  shadow: 0,
  parts: parts(`
    shaft  -      0.05 0.05 ${shaft}  0 0 0         c wood
    head   shaft  0.08 0.08 0.10  0 0 ${-shaft / 2}  f head
    fl     shaft  0.14 0.02 0.10  0 0 ${shaft / 2 - 0.05}  c fletch
    fl2    shaft  0.02 0.14 0.10  0 0 ${shaft / 2 - 0.05}  c fletch
  `),
});

const PROJECTILE_MODELS: Record<number, ModelDef> = {
  [ProjectileKind.Arrow]: arrowModel('f0f0f0'),
  [ProjectileKind.MobArrow]: arrowModel('e8e0cc'),
  [ProjectileKind.Bolt]: arrowModel('c03a2a', 0.45),
  [ProjectileKind.EmberArrow]: { ...arrowModel('ff8a3a'), palette: hex({ wood: '9a7a4a', head: 'ff6a2a', fletch: 'ff8a3a' }) },
  [ProjectileKind.SunBolt]: { palette: hex({ core: 'ffe08a', halo: 'f2c63a' }), stride: 0, shadow: 0, parts: parts(`
    core  -  0.22 0.22 0.22  0 0 0  c core spin emissive
    halo  -  0.36 0.36 0.36  0 0 0  c halo spin emissive alpha 0.4
  `) },
  [ProjectileKind.IceShard]: { palette: hex({ ice: 'bfe8ff' }), stride: 0, shadow: 0, parts: parts(`
    shard -  0.12 0.12 0.50  0 0 0  c ice emissive
  `) },
  [ProjectileKind.SeedPod]: { palette: hex({ pod: '3f6a2a', thorn: '8a6a3a' }), stride: 0, shadow: 0, parts: parts(`
    pod   -    0.30 0.30 0.30  0 0 0         c pod spin
    t1    pod  0.06 0.18 0.06  0 0.15 0      b thorn
    t2    pod  0.06 0.18 0.06  0 -0.15 0     t thorn
  `) },
  [ProjectileKind.Ember]: { palette: hex({ ember: 'ff6a2a' }), stride: 0, shadow: 0, parts: parts(`
    ember -  0.18 0.18 0.18  0 0 0  c ember spin emissive
  `) },
};

export const MOB_MODELS: Record<MobKind, ModelDef> = {
  [MobKind.Woolback]: WOOLBACK,
  [MobKind.Hopling]: HOPLING,
  [MobKind.Cluckit]: CLUCKIT,
  [MobKind.Fernhart]: FERNHART,
  [MobKind.Glimmerfin]: GLIMMERFIN,
  [MobKind.Mudlurch]: MUDLURCH,
  [MobKind.Rattlebow]: RATTLEBOW,
  [MobKind.Cragcrawler]: CRAGCRAWLER,
  [MobKind.Puffcap]: PUFFCAP,
  [MobKind.Duskwing]: DUSKWING,
  [MobKind.SunforgedSentinel]: SENTINEL,
  [MobKind.RimeWarden]: WARDEN,
  [MobKind.Thornmaw]: THORNMAW,
  [MobKind.AshenKnight]: KNIGHT,
};

const DEG = Math.PI / 180;

function offsetFor(a: Anchor, s: [number, number, number]): [number, number, number] {
  switch (a) {
    case 't': return [0, -s[1] / 2, 0];
    case 'b': return [0, s[1] / 2, 0];
    case 'f': return [0, 0, -s[2] / 2];
    case 'k': return [0, 0, s[2] / 2];
    case 'l': return [-s[0] / 2, 0, 0];
    case 'r': return [s[0] / 2, 0, 0];
    default: return [0, 0, 0];
  }
}

export function compileModel(def: ModelDef): CompiledModel {
  const index = new Map<string, number>();
  const out: CompiledPart[] = [];
  for (const p of def.parts) {
    const parentIndex = p.parent ? (index.get(p.parent) ?? -1) : -1;
    if (p.parent && parentIndex < 0) throw new Error(`model part ${p.id}: unknown parent ${p.parent}`);
    index.set(p.id, out.length);
    const r = p.rot ?? [0, 0, 0];
    out.push({ ...p, parentIndex, restRad: [r[0] * DEG, r[1] * DEG, r[2] * DEG], offset: offsetFor(p.anchor, p.size) });
  }
  // Rough rest top: joint heights accumulated (ignores rotations).
  const ys: number[] = [];
  let top = 0;
  out.forEach((p, i) => {
    ys[i] = (p.parentIndex >= 0 ? ys[p.parentIndex] : 0) + p.at[1];
    top = Math.max(top, ys[i] + p.offset[1] + p.size[1] / 2);
  });
  return { def, parts: out, top };
}

const compiled = new Map<number, CompiledModel>();
const compiledProj = new Map<number, CompiledModel>();

export function mobModel(kind: MobKind): CompiledModel {
  let m = compiled.get(kind);
  if (!m) compiled.set(kind, (m = compileModel(MOB_MODELS[kind])));
  return m;
}

export function projectileModel(kind: number): CompiledModel | null {
  const def = PROJECTILE_MODELS[kind];
  if (!def) return null;
  let m = compiledProj.get(kind);
  if (!m) compiledProj.set(kind, (m = compileModel(def)));
  return m;
}

/** Colour of a palette slot for a variant. */
export function paletteColor(def: ModelDef, slot: string, variant: MobVariant): number {
  return def.variants?.[variant]?.[slot] ?? def.palette[slot] ?? 0xff00ff;
}

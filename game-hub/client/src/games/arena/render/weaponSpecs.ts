/**
 * Part lists of the twelve Arcfire weapons (design-arena-weapons §9.2), the gloved hands that hold
 * them and the casings they eject. All designs are original: each weapon is told apart by its
 * silhouette (stock, magazine, sight, barrel furniture) and its colours.
 *
 * Model space: metres, origin at the top of the pistol grip, +X right, +Y up, −Z toward the muzzle.
 * Channels: M matte, K metal, E emissive, S sleeve. Groups: mag and act are the parts that animate.
 */
import { WeaponId } from '@hub/shared';
import type { Kit, PartOpts, V3, WeaponSpec } from './weaponKit';

// Palette (original).
export const GUN = 0x2a2e37;
export const GRAPH = 0x4d5566;
export const BLACK = 0x1d2027;
export const STEEL = 0xa3acbe;
export const TAN = 0xb09a70;
export const OLIVE = 0x5d6845;
export const WHITE = 0xc5cad4;
export const WOOD = 0x8a5c36;
export const WOOD_D = 0x5f3d23;
export const BRASS = 0xd4a447;
export const SHELL_RED = 0xc23b2b;
export const STRING = 0xe8e4d8;
export const ORANGE = 0xff7a45;
export const TEAL = 0x2fd3c8;
export const LENS = 0x3a8fb3;
export const RED = 0xff3b3b;
const GLOVE = 0x5d5853;
const GLOVE_D = 0x3f3b37;
const CUFF = 0x2b2927;
const SLEEVE = 0xffffff;
const SLEEVE_FABRIC = 0x454a55;

/** Every primitive's extra options, so the channel helpers below can carry them. */
type Opts = Partial<PartOpts> & { seg?: number; r2?: number; open?: boolean; x?: number; holes?: [number, number][][]; bevel?: number; mirror?: boolean };
const M = (c: number, o: Opts = {}): PartOpts & Opts => ({ c, ch: 'M', ...o });
const K = (c: number, o: Opts = {}): PartOpts & Opts => ({ c, ch: 'K', ...o });
const E = (c: number, o: Opts = {}): PartOpts & Opts => ({ c, ch: 'E', ...o });

/** Pistol grip hanging from the origin, slanting back as it goes down. */
function grip(k: Kit, c: number, h = 0.115, z = 0, w = 0.034): void {
  k.prof([[0.025 + z, 0], [-0.02 + z, 0], [0.005 + z, -h], [0.05 + z, -h]], w, M(c));
  k.box(w + 0.002, 0.008, 0.05, [0, -h + 0.004, 0.028 + z], M(BLACK, { d: true })); // base plate
}

/** Trigger guard and trigger in front of a grip at the origin. */
function trigger(k: Kit, z = 0, y = 0): void {
  k.box(0.01, 0.007, 0.07, [0, y - 0.05, z - 0.04], K(GRAPH, { d: true }));
  k.box(0.008, 0.046, 0.008, [0, y - 0.027, z - 0.074], K(GRAPH, { d: true }));
  k.box(0.006, 0.026, 0.007, [0, y - 0.022, z - 0.032], K(STEEL, { d: true, rot: [0.35, 0, 0] }));
}

/** Peep sight: a small ring on a post (iron sights you look through). */
function peep(k: Kit, at: V3, r = 0.008): void {
  k.ring(r, 0.0022, at, 'z', K(BLACK));
  k.box(0.006, at[1] - r - 0.06, 0.008, [at[0], (at[1] - r + 0.06) / 2, at[2]], K(BLACK, { d: true }));
}

/** Front post with protective ears; its tip is at `tip`. */
function post(k: Kit, tip: V3, base: number): void {
  const h = tip[1] - base;
  k.box(0.005, h, 0.008, [tip[0], base + h / 2, tip[2]], K(BLACK));
  k.box(0.004, h * 0.8, 0.01, [tip[0] - 0.009, base + h * 0.4, tip[2]], K(BLACK, { d: true }));
  k.box(0.004, h * 0.8, 0.01, [tip[0] + 0.009, base + h * 0.4, tip[2]], K(BLACK, { d: true }));
}

const ASSAULT_RIFLE: WeaponSpec = {
  build(k) {
    // Lower receiver with magazine well, upper with ejection port, flat-top rail.
    k.prof([[0.1, 0.008], [-0.17, 0.008], [-0.17, -0.03], [-0.15, -0.045], [-0.05, -0.05], [0.04, -0.05], [0.1, -0.025]], 0.05, M(GUN));
    k.box(0.056, 0.055, 0.36, [0, 0.035, -0.05], K(GRAPH));
    k.box(0.002, 0.018, 0.055, [0.029, 0.038, -0.03], K(BLACK, { d: true })); // ejection port
    k.cyl(0.009, 0.03, 'x', [0.03, 0.035, 0.05], K(GRAPH, { d: true, seg: 8 })); // forward assist
    k.box(0.03, 0.012, 0.32, [0, 0.069, -0.06], K(BLACK));
    for (let i = 0; i < 7; i++) k.box(0.036, 0.006, 0.012, [0, 0.077, 0.07 - i * 0.042], K(BLACK, { d: true }));
    // Round handguard with the Arcfire glow strip, barrel, muzzle brake, front post.
    k.cyl(0.034, 0.3, 'z', [0, 0.03, -0.38], M(GUN, { seg: 8 }));
    k.box(0.071, 0.008, 0.22, [0, 0.03, -0.39], E(ORANGE));
    for (let i = 0; i < 3; i++) k.box(0.071, 0.012, 0.03, [0, 0.0, -0.3 - i * 0.075], M(BLACK, { d: true }));
    k.cyl(0.011, 0.17, 'z', [0, 0.035, -0.61], K(BLACK));
    k.cyl(0.018, 0.05, 'z', [0, 0.035, -0.715], K(GRAPH, { seg: 6 }));
    k.box(0.04, 0.006, 0.03, [0, 0.035, -0.715], K(BLACK, { d: true })); // brake ports
    post(k, [0, 0.085, -0.5], 0.06);
    // Red-dot: open frame, the dot floats in the middle.
    k.box(0.04, 0.014, 0.05, [0, 0.082, -0.03], K(BLACK)); // riser mount
    k.box(0.046, 0.007, 0.05, [0, 0.1365, -0.03], K(BLACK, { d: true }));
    k.box(0.006, 0.048, 0.05, [-0.02, 0.113, -0.03], K(BLACK));
    k.box(0.006, 0.048, 0.05, [0.02, 0.113, -0.03], K(BLACK));
    k.box(0.04, 0.004, 0.004, [0, 0.091, -0.054], E(LENS, { d: true }));
    k.box(0.0032, 0.0032, 0.002, [0, 0.113, -0.05], E(RED));
    k.cyl(0.006, 0.01, 'x', [0.026, 0.113, -0.03], K(GRAPH, { d: true, seg: 6 })); // brightness knob
    grip(k, GUN);
    trigger(k);
    k.box(0.004, 0.012, 0.02, [-0.027, 0.0, 0.02], K(STEEL, { d: true })); // selector
    // Curved magazine.
    k.prof([[-0.06, -0.03], [-0.13, -0.03], [-0.16, -0.2], [-0.095, -0.21]], 0.03, M(GUN, { g: 'mag' }));
    k.box(0.036, 0.012, 0.068, [0, -0.212, -0.128], M(BLACK, { g: 'mag', rot: [-0.18, 0, 0] }));
    // Buffer tube and stock.
    k.cyl(0.016, 0.16, 'z', [0, 0.03, 0.18], K(GRAPH, { seg: 8 }));
    k.prof([[0.14, 0.055], [0.31, 0.045], [0.32, -0.1], [0.29, -0.11], [0.18, -0.02], [0.14, -0.02]], 0.045, M(GUN));
    k.box(0.05, 0.155, 0.014, [0, -0.028, 0.322], M(BLACK));
    // Charging handle and bolt carrier (they cycle on every shot).
    k.box(0.05, 0.01, 0.03, [0, 0.063, 0.09], K(GRAPH, { g: 'act' }));
    k.box(0.004, 0.02, 0.05, [0.03, 0.037, -0.03], K(STEEL, { g: 'act' }));
    return {
      muzzle: [0, 0.035, -0.745], sight: [0, 0.113, -0.03], eject: [0.03, 0.04, -0.03],
      gripR: [0, -0.05, 0.02], gripL: [0, -0.004, -0.39], leftHand: 'under',
      magPivot: [0, -0.04, -0.095], actPivot: [0, 0.05, 0.03],
    };
  },
};

const SMG: WeaponSpec = {
  build(k) {
    // Boxy receiver with a teal top accent.
    k.box(0.055, 0.075, 0.3, [0, 0.03, -0.07], M(GUN));
    k.box(0.057, 0.02, 0.28, [0, 0.075, -0.07], K(GRAPH));
    k.box(0.058, 0.008, 0.2, [0, 0.055, -0.08], E(TEAL));
    k.box(0.002, 0.02, 0.05, [0.028, 0.04, -0.04], K(BLACK, { d: true })); // ejection port
    // Perforated shroud and stubby barrel.
    k.cyl(0.022, 0.12, 'z', [0, 0.035, -0.28], K(BLACK, { seg: 8 }));
    for (let i = 0; i < 3; i++) k.box(0.046, 0.008, 0.016, [0, 0.035, -0.245 - i * 0.035], K(GRAPH, { d: true }));
    k.cyl(0.009, 0.05, 'z', [0, 0.035, -0.36], K(GRAPH, { seg: 8 }));
    // Vertical foregrip and pistol grip.
    k.prof([[-0.19, -0.005], [-0.24, -0.005], [-0.235, -0.105], [-0.2, -0.105]], 0.03, M(GUN));
    grip(k, GUN, 0.105);
    trigger(k);
    // Sights: peep at the rear, hooded post at the front.
    peep(k, [0, 0.105, 0.04]);
    post(k, [0, 0.105, -0.2], 0.085);
    // Wire stock (kept low so it stays out of the sight picture).
    k.cyl(0.006, 0.2, 'z', [-0.02, 0.012, 0.14], K(GRAPH));
    k.cyl(0.006, 0.2, 'z', [0.02, 0.012, 0.14], K(GRAPH));
    k.rod([-0.02, 0.012, 0.24], [-0.018, -0.06, 0.245], 0.006, K(GRAPH));
    k.rod([0.02, 0.012, 0.24], [0.018, -0.06, 0.245], 0.006, K(GRAPH));
    k.box(0.05, 0.085, 0.012, [0, -0.02, 0.25], K(BLACK));
    // Straight stick magazine.
    k.box(0.03, 0.17, 0.045, [0, -0.09, -0.06], M(BLACK, { g: 'mag', rot: [0.05, 0, 0] }));
    k.box(0.034, 0.01, 0.05, [0, -0.175, -0.064], M(GRAPH, { g: 'mag', d: true, rot: [0.05, 0, 0] }));
    // Bolt handle on the left.
    k.box(0.016, 0.012, 0.025, [-0.034, 0.045, -0.02], K(STEEL, { g: 'act' }));
    return {
      muzzle: [0, 0.035, -0.385], sight: [0, 0.105, 0.04], eject: [0.03, 0.05, -0.04],
      gripR: [0, -0.05, 0.02], gripL: [0, -0.05, -0.215], leftHand: 'vertical',
      magPivot: [0, -0.01, -0.06], actPivot: [-0.034, 0.045, -0.02],
    };
  },
};

const SHOTGUN: WeaponSpec = {
  build(k) {
    // Steel receiver, long barrel over the tube magazine, bead sight.
    k.box(0.055, 0.08, 0.22, [0, 0.025, -0.11], K(GRAPH));
    k.box(0.002, 0.03, 0.07, [0.028, 0.035, -0.1], K(BLACK, { d: true })); // loading/ejection port
    k.cyl(0.016, 0.52, 'z', [0, 0.05, -0.48], K(BLACK));
    k.cyl(0.014, 0.42, 'z', [0, 0.015, -0.44], K(GRAPH));
    k.box(0.04, 0.05, 0.02, [0, 0.032, -0.66], K(GRAPH, { d: true }));
    k.box(0.007, 0.007, 0.007, [0, 0.07, -0.735], E(ORANGE));
    k.box(0.008, 0.004, 0.42, [0, 0.067, -0.45], K(GRAPH, { d: true })); // vent rib
    // Wood stock with a pistol-grip wrist.
    k.prof(
      [[0, 0.05], [0.3, 0.012], [0.31, -0.125], [0.275, -0.135], [0.1, -0.035], [0.05, -0.035], [0.065, -0.115], [0.015, -0.12], [-0.015, -0.03], [0, -0.015]],
      0.045,
      M(WOOD),
    );
    k.box(0.047, 0.14, 0.014, [0, -0.06, 0.305], M(BLACK, { rot: [0.07, 0, 0] })); // recoil pad
    trigger(k, -0.01, 0.0);
    // Side saddle with four red shells.
    for (let i = 0; i < 4; i++) {
      k.cyl(0.008, 0.03, 'y', [0.033, 0.04, -0.075 - i * 0.025], M(SHELL_RED, { d: true, seg: 8 }));
      k.cyl(0.0085, 0.007, 'y', [0.033, 0.022, -0.075 - i * 0.025], K(BRASS, { d: true, seg: 8 }));
    }
    k.box(0.004, 0.035, 0.11, [0.028, 0.04, -0.112], M(BLACK, { d: true }));
    // Pump with grip rings (rides on the tube).
    k.cyl(0.026, 0.18, 'z', [0, 0.015, -0.36], M(WOOD, { g: 'act', seg: 10 }));
    for (let i = 0; i < 5; i++) k.cyl(0.0268, 0.008, 'z', [0, 0.015, -0.295 - i * 0.03], M(WOOD_D, { g: 'act', d: true, seg: 10 }));
    // The shell being loaded (visible only while reloading).
    k.cyl(0.009, 0.03, 'z', [0, -0.03, -0.14], M(SHELL_RED, { g: 'mag', seg: 8 }));
    k.cyl(0.0095, 0.006, 'z', [0, -0.03, -0.122], K(BRASS, { g: 'mag', seg: 8 }));
    return {
      muzzle: [0, 0.05, -0.74], sight: [0, 0.074, -0.11], eject: [0.03, 0.035, -0.1],
      gripR: [0, -0.07, 0.03], gripL: [0, -0.011, -0.36], leftHand: 'under',
      magPivot: [0, -0.03, -0.14], actPivot: [0, 0.015, -0.36],
    };
  },
};

const SNIPER: WeaponSpec = {
  build(k) {
    // Round receiver, long tapered barrel, box muzzle brake.
    k.cyl(0.022, 0.24, 'z', [0, 0.035, -0.04], K(GRAPH));
    k.cyl(0.014, 0.62, 'z', [0, 0.035, -0.47], K(BLACK, { r2: 0.011 }));
    k.box(0.05, 0.03, 0.06, [0, 0.035, -0.8], K(GRAPH));
    for (let i = 0; i < 2; i++) k.box(0.052, 0.012, 0.012, [0, 0.035, -0.785 - i * 0.025], K(BLACK, { d: true }));
    // Olive thumbhole stock with a cheek riser and the Arcfire strip.
    k.prof(
      [[-0.3, 0], [0.12, 0], [0.4, 0.03], [0.41, -0.13], [0.3, -0.14], [0.2, -0.06], [0.05, -0.11], [0, -0.11], [-0.02, -0.03], [-0.3, -0.03]],
      0.05,
      M(OLIVE, { holes: [[[0.1, -0.03], [0.16, -0.03], [0.15, -0.07], [0.1, -0.07]]] }),
    );
    k.box(0.03, 0.035, 0.13, [0, 0.045, 0.27], M(BLACK));
    k.box(0.052, 0.006, 0.1, [0, -0.06, 0.25], E(ORANGE, { d: true }));
    k.box(0.052, 0.13, 0.016, [0, -0.055, 0.41], M(BLACK));
    trigger(k);
    // Large scope with turrets on two rings.
    k.cyl(0.02, 0.3, 'z', [0, 0.105, -0.03], K(BLACK, { seg: 12 }));
    k.cyl(0.02, 0.08, 'z', [0, 0.105, -0.21], K(BLACK, { seg: 12, r2: 0.031 }));
    k.cyl(0.031, 0.02, 'z', [0, 0.105, -0.255], K(GRAPH, { seg: 12 }));
    k.cyl(0.026, 0.06, 'z', [0, 0.105, 0.13], K(BLACK, { seg: 12, r2: 0.02 }));
    k.cyl(0.012, 0.03, 'y', [0, 0.135, -0.03], K(GRAPH, { seg: 8 }));
    k.cyl(0.012, 0.03, 'x', [0.03, 0.105, -0.03], K(GRAPH, { d: true, seg: 8 }));
    k.box(0.05, 0.04, 0.02, [0, 0.075, -0.1], K(GRAPH));
    k.box(0.05, 0.04, 0.02, [0, 0.075, 0.04], K(GRAPH));
    k.cyl(0.027, 0.003, 'z', [0, 0.105, -0.266], E(LENS, { seg: 12 }));
    // Folded bipod under the forend.
    k.cyl(0.006, 0.18, 'z', [-0.018, -0.035, -0.38], K(GRAPH, { d: true }));
    k.cyl(0.006, 0.18, 'z', [0.018, -0.035, -0.38], K(GRAPH, { d: true }));
    k.box(0.05, 0.02, 0.02, [0, -0.03, -0.28], K(BLACK, { d: true }));
    // Detachable magazine.
    k.box(0.035, 0.05, 0.08, [0, -0.025, -0.07], K(BLACK, { g: 'mag' }));
    // Bolt with handle and knob (rotates up and pulls back).
    k.cyl(0.012, 0.1, 'z', [0, 0.04, 0.06], K(STEEL, { g: 'act' }));
    k.box(0.05, 0.008, 0.01, [0.045, 0.03, 0.09], K(STEEL, { g: 'act' }));
    k.cyl(0.011, 0.014, 'x', [0.072, 0.03, 0.09], K(GRAPH, { g: 'act', seg: 8 }));
    return {
      muzzle: [0, 0.035, -0.83], sight: [0, 0.105, 0.16], eject: [0.03, 0.045, 0.02],
      gripR: [0, -0.06, 0.02], gripL: [0, -0.03, -0.3], leftHand: 'under',
      magPivot: [0, -0.025, -0.07], actPivot: [0, 0.04, 0.06],
    };
  },
};

const CROSSBOW: WeaponSpec = {
  build(k) {
    // Wood stock with tiller and grip.
    k.prof([[0.3, 0.02], [0.32, -0.1], [0.26, -0.11], [0.12, -0.03], [0.04, -0.1], [0, -0.1], [-0.02, -0.02], [-0.44, 0], [-0.44, 0.032], [0, 0.032]], 0.045, M(WOOD));
    k.box(0.047, 0.11, 0.014, [0, -0.045, 0.315], M(BLACK, { rot: [0.15, 0, 0] }));
    k.box(0.02, 0.012, 0.46, [0, 0.038, -0.22], K(GRAPH));
    k.box(0.1, 0.05, 0.05, [0, 0.02, -0.42], K(BLACK));
    k.box(0.03, 0.02, 0.06, [0, 0.045, -0.1], K(GRAPH)); // latch
    trigger(k, 0.02, 0.0);
    // Steel limbs swept forward, with cams and teal tips.
    k.plan([[-0.05, -0.4], [-0.18, -0.425], [-0.33, -0.365], [-0.335, -0.345], [-0.18, -0.395], [-0.05, -0.37]], 0.02, 0.02, K(STEEL, { mirror: true }));
    k.cyl(0.018, 0.022, 'y', [-0.33, 0.03, -0.35], K(BLACK, { seg: 10 }));
    k.cyl(0.018, 0.022, 'y', [0.33, 0.03, -0.35], K(BLACK, { seg: 10 }));
    k.cyl(0.006, 0.026, 'y', [-0.33, 0.03, -0.35], E(TEAL, { d: true, seg: 6 }));
    k.cyl(0.006, 0.026, 'y', [0.33, 0.03, -0.35], E(TEAL, { d: true, seg: 6 }));
    // Foot stirrup.
    k.box(0.12, 0.012, 0.012, [0, -0.01, -0.5], K(GRAPH, { d: true }));
    k.box(0.012, 0.05, 0.012, [-0.06, 0.01, -0.48], K(GRAPH, { d: true }));
    k.box(0.012, 0.05, 0.012, [0.06, 0.01, -0.48], K(GRAPH, { d: true }));
    // Ring sight with a teal dot.
    k.box(0.02, 0.03, 0.02, [0, 0.058, -0.05], K(BLACK));
    k.ring(0.02, 0.003, [0, 0.093, -0.05], 'z', K(BLACK));
    k.box(0.004, 0.004, 0.002, [0, 0.093, -0.05], E(TEAL));
    // The loaded bolt on the rail.
    k.cyl(0.004, 0.36, 'z', [0, 0.05, -0.24], M(BLACK, { g: 'mag', seg: 6 }));
    k.cone(0.008, 0.03, 'z', [0, 0.05, -0.435], K(STEEL, { g: 'mag', seg: 6 }));
    k.box(0.002, 0.016, 0.05, [0, 0.056, -0.085], E(ORANGE, { g: 'mag' }));
    k.box(0.016, 0.002, 0.05, [0, 0.05, -0.085], E(ORANGE, { g: 'mag' }));
    return {
      muzzle: [0, 0.05, -0.45], sight: [0, 0.093, -0.05], eject: null,
      gripR: [0, -0.055, 0.02], gripL: [0, 0, -0.3], leftHand: 'under',
      magPivot: [0, 0.05, -0.24], actPivot: [0, 0.04, -0.1],
      nockRest: [0, 0.05, -0.38], nockDrawn: [0, 0.05, -0.08], limbTips: [[-0.335, 0.03, -0.35], [0.335, 0.03, -0.35]],
    };
  },
};

const BURST_RIFLE: WeaponSpec = {
  build(k) {
    // One-piece light shell (bullpup: the magazine sits behind the grip).
    k.prof([[0.28, 0.065], [-0.3, 0.065], [-0.34, 0.02], [-0.34, -0.035], [-0.06, -0.035], [-0.03, -0.01], [0.06, -0.01], [0.09, -0.06], [0.28, -0.075]], 0.06, M(WHITE));
    k.box(0.03, 0.006, 0.4, [0, 0.067, -0.08], K(GRAPH)); // top rail breaks up the shell
    k.box(0.062, 0.15, 0.016, [0, -0.005, 0.287], M(GUN));
    k.box(0.062, 0.01, 0.3, [0, 0.0, -0.05], E(ORANGE));
    k.box(0.062, 0.03, 0.18, [0, 0.04, -0.2], M(GUN, { d: true })); // forward grip panel
    k.box(0.002, 0.025, 0.05, [0.031, 0.04, 0.1], K(BLACK, { d: true })); // ejection port
    grip(k, GUN);
    trigger(k);
    k.cyl(0.011, 0.1, 'z', [0, 0.035, -0.39], K(BLACK));
    k.cyl(0.015, 0.045, 'z', [0, 0.035, -0.462], K(GRAPH, { seg: 6 }));
    // Holographic sight: open frame, red ring reticle.
    k.box(0.036, 0.026, 0.06, [0, 0.078, -0.05], K(BLACK)); // riser
    k.box(0.005, 0.046, 0.05, [-0.019, 0.114, -0.05], K(BLACK));
    k.box(0.005, 0.046, 0.05, [0.019, 0.114, -0.05], K(BLACK));
    k.box(0.043, 0.006, 0.05, [0, 0.14, -0.05], K(BLACK));
    k.ring(0.0065, 0.0009, [0, 0.112, -0.06], 'z', E(RED));
    k.box(0.0018, 0.0018, 0.001, [0, 0.112, -0.06], E(RED));
    // Magazine behind the grip.
    k.box(0.03, 0.14, 0.05, [0, -0.085, 0.14], M(GUN, { g: 'mag', rot: [-0.15, 0, 0] }));
    k.box(0.034, 0.01, 0.055, [0, -0.155, 0.152], M(BLACK, { g: 'mag', d: true, rot: [-0.15, 0, 0] }));
    k.box(0.012, 0.012, 0.04, [-0.034, 0.05, -0.12], K(STEEL, { g: 'act' }));
    return {
      muzzle: [0, 0.035, -0.485], sight: [0, 0.112, -0.05], eject: [0.031, 0.04, 0.1],
      gripR: [0, -0.05, 0.02], gripL: [0, -0.035, -0.22], leftHand: 'under',
      magPivot: [0, -0.02, 0.13], actPivot: [-0.034, 0.05, -0.12],
    };
  },
};

const MARKSMAN: WeaponSpec = {
  build(k) {
    k.box(0.056, 0.055, 0.34, [0, 0.035, -0.05], K(GRAPH));
    k.prof([[0.1, 0.008], [-0.17, 0.008], [-0.17, -0.03], [-0.15, -0.045], [-0.05, -0.05], [0.04, -0.05], [0.1, -0.025]], 0.05, M(TAN));
    k.box(0.002, 0.018, 0.055, [0.029, 0.038, -0.03], K(BLACK, { d: true }));
    // Long slotted tan handguard, barrel and brake.
    k.box(0.06, 0.06, 0.32, [0, 0.03, -0.36], M(TAN));
    for (let i = 0; i < 3; i++) k.box(0.062, 0.012, 0.04, [0, 0.03, -0.27 - i * 0.08], M(BLACK, { d: true }));
    k.box(0.03, 0.008, 0.3, [0, 0.064, -0.36], K(BLACK, { d: true }));
    k.cyl(0.012, 0.25, 'z', [0, 0.035, -0.645], K(BLACK));
    k.cyl(0.017, 0.06, 'z', [0, 0.035, -0.79], K(GRAPH, { seg: 8 }));
    // 2× optic.
    k.cyl(0.018, 0.16, 'z', [0, 0.105, -0.03], K(BLACK));
    k.cyl(0.018, 0.05, 'z', [0, 0.105, -0.135], K(BLACK, { r2: 0.024 }));
    k.cyl(0.022, 0.04, 'z', [0, 0.105, 0.07], K(BLACK, { r2: 0.018 }));
    k.box(0.03, 0.03, 0.1, [0, 0.075, -0.03], K(GRAPH));
    k.cyl(0.023, 0.003, 'z', [0, 0.105, -0.161], E(LENS));
    k.cyl(0.009, 0.02, 'y', [0, 0.128, -0.03], K(GRAPH, { d: true, seg: 8 }));
    grip(k, TAN);
    trigger(k);
    k.box(0.032, 0.12, 0.06, [0, -0.1, -0.1], M(BLACK, { g: 'mag' }));
    // Precision stock with a cheek rest.
    k.cyl(0.016, 0.16, 'z', [0, 0.03, 0.18], K(GRAPH, { seg: 8 }));
    k.prof([[0.12, 0.05], [0.36, 0.05], [0.37, -0.11], [0.33, -0.12], [0.16, -0.03], [0.12, -0.03]], 0.045, M(TAN));
    k.box(0.03, 0.025, 0.12, [0, 0.07, 0.26], M(BLACK));
    k.box(0.048, 0.165, 0.014, [0, -0.03, 0.372], M(BLACK));
    k.box(0.05, 0.01, 0.03, [0, 0.063, 0.09], K(STEEL, { g: 'act' }));
    return {
      muzzle: [0, 0.035, -0.82], sight: [0, 0.105, 0.09], eject: [0.03, 0.04, -0.03],
      gripR: [0, -0.05, 0.02], gripL: [0, 0, -0.37], leftHand: 'under',
      magPivot: [0, -0.04, -0.1], actPivot: [0, 0.063, 0.09],
    };
  },
};

const LMG: WeaponSpec = {
  build(k) {
    k.box(0.07, 0.09, 0.36, [0, 0.03, -0.02], K(GRAPH));
    k.box(0.072, 0.01, 0.24, [0, 0.0, -0.02], E(ORANGE));
    k.box(0.002, 0.02, 0.06, [0.036, 0.03, -0.02], K(BLACK, { d: true }));
    // Heavy perforated shroud, barrel, conical flash hider.
    k.cyl(0.032, 0.3, 'z', [0, 0.04, -0.37], M(GUN, { seg: 8 }));
    for (let i = 0; i < 4; i++) {
      k.box(0.066, 0.012, 0.03, [0, 0.04, -0.27 - i * 0.065], K(BLACK, { d: true }));
      k.box(0.012, 0.066, 0.03, [0, 0.04, -0.27 - i * 0.065], K(BLACK, { d: true }));
    }
    k.cyl(0.014, 0.13, 'z', [0, 0.04, -0.585], K(BLACK));
    k.cone(0.022, 0.06, 'z', [0, 0.04, -0.675], K(GRAPH, { seg: 6 }));
    // Carry handle and sights.
    k.box(0.014, 0.04, 0.014, [0, 0.09, -0.2], K(GRAPH));
    k.box(0.014, 0.04, 0.014, [0, 0.09, -0.31], K(GRAPH));
    k.box(0.022, 0.014, 0.16, [0, 0.115, -0.255], K(BLACK));
    post(k, [0, 0.115, -0.52], 0.07);
    peep(k, [0, 0.115, 0.06], 0.01);
    // Bipod.
    k.rod([-0.025, 0.01, -0.45], [-0.04, -0.03, -0.25], 0.007, K(GRAPH, { d: true }));
    k.rod([0.025, 0.01, -0.45], [0.04, -0.03, -0.25], 0.007, K(GRAPH, { d: true }));
    k.box(0.07, 0.02, 0.02, [0, 0.01, -0.46], K(BLACK, { d: true }));
    // Blocky stock and grip.
    k.prof([[0.15, 0.06], [0.34, 0.05], [0.35, -0.1], [0.15, -0.05]], 0.05, M(GUN));
    k.box(0.052, 0.155, 0.014, [0, -0.022, 0.352], M(BLACK));
    grip(k, GUN);
    trigger(k);
    // Box magazine with its brass belt; the top cover opens to reload.
    k.box(0.09, 0.12, 0.12, [-0.02, -0.09, -0.06], M(OLIVE, { g: 'mag' }));
    k.box(0.092, 0.02, 0.122, [-0.02, -0.14, -0.06], M(GUN, { g: 'mag', d: true }));
    k.box(0.022, 0.035, 0.04, [-0.046, 0.0, -0.06], K(BRASS, { g: 'mag', d: true }));
    k.box(0.072, 0.025, 0.24, [0, 0.0875, -0.02], K(BLACK, { g: 'act' }));
    return {
      muzzle: [0, 0.04, -0.73], sight: [0, 0.115, 0.06], eject: [0.035, 0.03, -0.02],
      gripR: [0, -0.05, 0.02], gripL: [0, 0.008, -0.4], leftHand: 'under',
      magPivot: [-0.02, -0.03, -0.06], actPivot: [0, 0.1, 0.1],
    };
  },
};

const PISTOL: WeaponSpec = {
  build(k) {
    // Two-tone: dark slide over a grey frame, orange backstrap.
    k.box(0.03, 0.032, 0.19, [0, 0.03, -0.055], K(GRAPH, { g: 'act' }));
    for (let i = 0; i < 4; i++) k.box(0.032, 0.02, 0.003, [0, 0.03, 0.012 + i * 0.008], K(BLACK, { g: 'act', d: true }));
    k.box(0.002, 0.012, 0.03, [0.016, 0.034, -0.04], K(BLACK, { g: 'act', d: true })); // ejection port
    k.box(0.024, 0.008, 0.008, [0, 0.05, 0.03], K(BLACK, { g: 'act' })); // rear sight with notch
    k.box(0.004, 0.004, 0.003, [-0.007, 0.0485, 0.0345], E(TEAL, { g: 'act', d: true }));
    k.box(0.004, 0.004, 0.003, [0.007, 0.0485, 0.0345], E(TEAL, { g: 'act', d: true }));
    k.box(0.005, 0.01, 0.008, [0, 0.051, -0.14], E(TEAL, { g: 'act' }));
    k.box(0.028, 0.02, 0.15, [0, 0.004, -0.06], M(GUN));
    k.box(0.024, 0.008, 0.06, [0, -0.008, -0.105], M(BLACK, { d: true })); // accessory rail
    k.cyl(0.007, 0.012, 'z', [0, 0.034, -0.15], K(BLACK, { seg: 8 }));
    k.prof([[0.035, 0], [-0.01, 0], [0.005, -0.11], [0.05, -0.11]], 0.03, M(GUN));
    k.box(0.006, 0.09, 0.012, [0, -0.05, 0.045], E(ORANGE, { d: true, rot: [-0.38, 0, 0] }));
    trigger(k, -0.005, 0.02);
    k.box(0.022, 0.1, 0.04, [0, -0.05, 0.015], M(BLACK, { g: 'mag', rot: [-0.38, 0, 0] }));
    k.box(0.028, 0.01, 0.045, [0, -0.112, 0.037], M(BLACK, { g: 'mag', rot: [-0.38, 0, 0] }));
    return {
      muzzle: [0, 0.034, -0.158], sight: [0, 0.054, 0.03], eject: [0.016, 0.04, -0.03],
      gripR: [0, -0.05, 0.022], gripL: [-0.01, -0.07, 0.0], leftHand: 'cup',
      magPivot: [0, -0.05, 0.015], actPivot: [0, 0.03, -0.055],
    };
  },
};

const HAND_CANNON: WeaponSpec = {
  build(k) {
    // Steel revolver frame, long barrel with top rib and ejector housing.
    k.prof([[0.05, 0.045], [-0.07, 0.045], [-0.07, -0.01], [-0.02, -0.02], [0.04, -0.02], [0.06, 0.02]], 0.03, K(0x8a93a4));
    k.cyl(0.012, 0.17, 'z', [0, 0.04, -0.15], K(0x8a93a4));
    k.box(0.014, 0.012, 0.17, [0, 0.055, -0.15], K(GRAPH));
    k.box(0.012, 0.016, 0.1, [0, 0.02, -0.12], K(STEEL));
    k.box(0.004, 0.014, 0.012, [0, 0.067, -0.225], E(ORANGE));
    k.box(0.02, 0.008, 0.01, [0, 0.062, 0.045], K(BLACK));
    k.box(0.01, 0.025, 0.015, [0, 0.058, 0.055], K(GRAPH, { d: true, rot: [-0.4, 0, 0] })); // hammer
    k.prof([[0.05, 0], [0.01, -0.01], [0.03, -0.11], [0.075, -0.105], [0.07, -0.02]], 0.034, M(WOOD));
    k.box(0.036, 0.004, 0.03, [0, -0.06, 0.045], M(WOOD_D, { d: true, rot: [-0.3, 0, 0] }));
    trigger(k, 0.0, 0.02);
    // Six-shot cylinder (turns 60° per shot, swings out to reload).
    k.cyl(0.022, 0.055, 'z', [0, 0.02, -0.035], K(GRAPH, { seg: 12 }));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      k.box(0.006, 0.006, 0.04, [Math.cos(a) * 0.021, 0.02 + Math.sin(a) * 0.021, -0.035], K(BLACK, { g: 'act', d: true, rot: [0, 0, a] }));
    }
    k.cyl(0.02, 0.03, 'z', [0, 0.02, 0.0], K(BLACK, { g: 'mag', seg: 10 }));
    return {
      muzzle: [0, 0.04, -0.235], sight: [0, 0.066, 0.045], eject: null,
      gripR: [0, -0.055, 0.04], gripL: [-0.01, -0.075, 0.02], leftHand: 'cup',
      magPivot: [0, 0.02, 0.0], actPivot: [0, 0.02, -0.035],
    };
  },
};

const MACHINE_PISTOL: WeaponSpec = {
  build(k) {
    k.box(0.032, 0.04, 0.2, [0, 0.03, -0.06], K(BLACK));
    k.box(0.034, 0.008, 0.12, [0, 0.012, -0.07], E(TEAL));
    k.box(0.028, 0.02, 0.15, [0, 0.0, -0.06], M(GUN));
    k.prof([[0.035, 0], [-0.01, 0], [0.005, -0.11], [0.05, -0.11]], 0.03, M(GUN));
    k.prof([[-0.1, -0.01], [-0.13, -0.01], [-0.125, -0.085], [-0.105, -0.085]], 0.026, M(GUN));
    trigger(k, -0.005, 0.02);
    k.cyl(0.011, 0.035, 'z', [0, 0.032, -0.177], K(GRAPH, { seg: 6 }));
    k.box(0.024, 0.004, 0.02, [0, 0.032, -0.177], K(BLACK, { d: true }));
    k.box(0.008, 0.008, 0.12, [0, 0.0, 0.1], K(GRAPH, { d: true }));
    k.box(0.024, 0.008, 0.008, [0, 0.053, 0.03], K(BLACK));
    k.box(0.005, 0.012, 0.008, [0, 0.055, -0.15], E(TEAL));
    // Extended magazine out of the grip.
    k.box(0.022, 0.17, 0.04, [0, -0.085, 0.018], M(BLACK, { g: 'mag', rot: [-0.3, 0, 0] }));
    k.box(0.026, 0.01, 0.045, [0, -0.168, 0.044], M(GRAPH, { g: 'mag', d: true, rot: [-0.3, 0, 0] }));
    k.box(0.01, 0.012, 0.02, [0, 0.055, 0.02], K(STEEL, { g: 'act' }));
    return {
      muzzle: [0, 0.032, -0.195], sight: [0, 0.058, 0.03], eject: [0.017, 0.04, -0.04],
      gripR: [0, -0.05, 0.022], gripL: [0, -0.045, -0.115], leftHand: 'vertical',
      magPivot: [0, -0.05, 0.015], actPivot: [0, 0.055, 0.02],
    };
  },
};

const COMBAT_KNIFE: WeaponSpec = {
  build(k) {
    // Ridged black handle, teal guard, clip-point steel blade with spine and fuller.
    k.prof([[0.1, 0.012], [0, 0.015], [0, -0.015], [0.1, -0.012], [0.11, 0]], 0.026, M(BLACK));
    for (let i = 0; i < 4; i++) k.box(0.028, 0.004, 0.006, [0, -0.014, 0.02 + i * 0.022], K(GRAPH, { d: true }));
    k.cyl(0.013, 0.016, 'z', [0, 0, 0.112], K(STEEL));
    k.box(0.022, 0.054, 0.012, [0, 0.002, -0.002], M(TEAL));
    k.prof([[0, 0.016], [-0.15, 0.014], [-0.2, 0], [-0.17, -0.01], [-0.05, -0.016], [0, -0.016]], 0.006, K(STEEL, { bevel: 0.0015 }));
    k.box(0.007, 0.004, 0.13, [0, 0.016, -0.07], K(GRAPH, { d: true }));
    k.box(0.0065, 0.004, 0.1, [0, 0.002, -0.07], K(0x6c7486, { d: true }));
    return {
      muzzle: [0, 0, -0.2], sight: [0, 0.02, 0], eject: null,
      gripR: [0, 0, 0.055], gripL: [0, 0, 0.055], leftHand: 'none',
      magPivot: [0, 0, 0], actPivot: [0, 0, 0],
    };
  },
};

export const WEAPON_SPECS: Record<WeaponId, WeaponSpec> = {
  [WeaponId.Rifle]: ASSAULT_RIFLE,
  [WeaponId.Shotgun]: SHOTGUN,
  [WeaponId.Sniper]: SNIPER,
  [WeaponId.Pistol]: PISTOL,
  [WeaponId.Blade]: COMBAT_KNIFE,
  [WeaponId.Smg]: SMG,
  [WeaponId.Crossbow]: CROSSBOW,
  [WeaponId.BurstRifle]: BURST_RIFLE,
  [WeaponId.Marksman]: MARKSMAN,
  [WeaponId.Lmg]: LMG,
  [WeaponId.HandCannon]: HAND_CANNON,
  [WeaponId.MachinePistol]: MACHINE_PISTOL,
};

// ---- hands --------------------------------------------------------------------------------------

export type HandPose = 'grip' | 'under' | 'vertical' | 'cup' | 'knife';

/** Forearm from the wrist: a dark cuff, a dark sleeve, and a band in the team colour. */
function forearm(k: Kit, wrist: V3, dir: V3, len: number): void {
  const l = Math.hypot(...dir);
  const at = (t: number): V3 => [wrist[0] + (dir[0] / l) * t, wrist[1] + (dir[1] / l) * t, wrist[2] + (dir[2] / l) * t];
  k.rod(at(-0.01), at(0.05), 0.03, { c: CUFF, ch: 'M', seg: 10, r2: 0.033 });
  k.rod(at(0.045), at(len), 0.036, { c: SLEEVE_FABRIC, ch: 'M', seg: 10, r2: 0.043 });
  k.rod(at(0.09), at(0.15), 0.0375, { c: SLEEVE, ch: 'S', seg: 10, r2: 0.039 }); // team band
}

/** A gloved fist closed around a vertical grip at the origin; `side` +1 = right hand, −1 = left hand. */
function fist(k: Kit, side: 1 | -1): void {
  const s = side;
  k.box(0.026, 0.085, 0.075, [0.031 * s, 0, 0.012], M(GLOVE)); // back of the hand
  k.box(0.012, 0.08, 0.026, [0.043 * s, -0.002, -0.018], M(GLOVE_D)); // knuckles
  k.box(0.058, 0.074, 0.026, [0.006 * s, -0.012, -0.032], M(GLOVE)); // curled fingers
  for (let i = 0; i < 3; i++) k.box(0.059, 0.003, 0.027, [0.006 * s, -0.03 + i * 0.019, -0.032], M(GLOVE_D, { d: true }));
  k.box(0.022, 0.024, 0.056, [-0.024 * s, 0.03, -0.008], M(GLOVE, { rot: [0, 0.2 * s, 0] })); // thumb
  k.box(0.06, 0.024, 0.052, [0.012 * s, 0.045, 0.016], M(GLOVE)); // web of the hand
  k.box(0.05, 0.065, 0.045, [0.026 * s, -0.012, 0.062], M(GLOVE)); // heel of the hand
}

/** Hand geometry per pose, in hand space (see Viewmodel for where each pose goes). */
export function buildHand(k: Kit, pose: HandPose): void {
  switch (pose) {
    case 'grip':
      // Right hand on a pistol grip, index finger along the trigger.
      fist(k, 1);
      k.box(0.016, 0.017, 0.044, [0.008, 0.024, -0.05], M(GLOVE));
      forearm(k, [0.03, -0.02, 0.075], [0.28, -0.52, 1], 0.46);
      break;
    case 'vertical':
      // Left hand around a vertical foregrip.
      fist(k, -1);
      k.box(0.016, 0.017, 0.04, [-0.008, 0.024, -0.05], M(GLOVE));
      forearm(k, [-0.03, -0.02, 0.075], [-0.42, -0.55, 1], 0.6);
      break;
    case 'under':
      // Left hand cradling a handguard (origin: its underside): palm under it, fingers up the far
      // (right) side, the thumb and the heel of the hand on the near side where the camera sees them.
      k.box(0.056, 0.024, 0.088, [-0.002, -0.013, 0], M(GLOVE, { rot: [0, 0, 0.3] }));
      k.box(0.022, 0.056, 0.08, [0.04, 0.018, -0.004], M(GLOVE, { rot: [0, 0, -0.12] }));
      for (let i = 0; i < 3; i++) k.box(0.023, 0.057, 0.003, [0.04, 0.018, -0.03 + i * 0.022], M(GLOVE_D, { d: true, rot: [0, 0, -0.12] }));
      k.box(0.02, 0.024, 0.072, [-0.035, 0.024, -0.022], M(GLOVE)); // thumb along the side
      k.box(0.008, 0.02, 0.05, [-0.044, 0.026, -0.02], M(GLOVE_D, { d: true })); // thumb seam
      k.box(0.03, 0.05, 0.06, [-0.032, -0.012, 0.03], M(GLOVE)); // heel of the hand
      k.box(0.05, 0.04, 0.05, [-0.012, -0.03, 0.055], M(GLOVE));
      forearm(k, [-0.026, -0.032, 0.07], [-0.8, -0.5, 0.75], 0.75);
      break;
    case 'cup':
      // Left hand under the right one on a pistol.
      k.box(0.052, 0.026, 0.085, [0, 0, 0], M(GLOVE));
      k.box(0.054, 0.062, 0.024, [0.008, 0.03, -0.052], M(GLOVE));
      for (let i = 0; i < 3; i++) k.box(0.055, 0.003, 0.025, [0.008, 0.012 + i * 0.018, -0.052], M(GLOVE_D, { d: true }));
      k.box(0.018, 0.022, 0.06, [-0.032, 0.032, -0.01], M(GLOVE, { rot: [0, -0.15, 0] }));
      k.box(0.05, 0.045, 0.045, [-0.012, -0.012, 0.05], M(GLOVE));
      forearm(k, [-0.018, -0.02, 0.075], [-0.55, -0.5, 1], 0.55);
      break;
    case 'knife':
      // Right hand around the knife handle (its axis runs along Z).
      k.box(0.026, 0.07, 0.085, [0.03, 0.004, 0], M(GLOVE));
      k.box(0.054, 0.024, 0.08, [0.004, -0.027, 0], M(GLOVE));
      k.box(0.022, 0.05, 0.08, [-0.026, -0.006, -0.002], M(GLOVE));
      for (let i = 0; i < 3; i++) k.box(0.055, 0.025, 0.003, [0.004, -0.027, -0.028 + i * 0.02], M(GLOVE_D, { d: true }));
      k.box(0.02, 0.02, 0.06, [-0.012, 0.027, -0.012], M(GLOVE));
      k.box(0.05, 0.06, 0.04, [0.016, -0.004, 0.058], M(GLOVE));
      forearm(k, [0.02, -0.01, 0.07], [0.2, -0.42, 1], 0.5);
      break;
  }
}

// ---- casings ------------------------------------------------------------------------------------

/** One casing shape for every weapon (instance scale and colour make rifle, pistol and shotgun hulls). */
export function buildCasing(k: Kit): void {
  k.cyl(0.005, 0.022, 'z', [0, 0, 0], { c: 0xffffff, ch: 'K', seg: 6 });
  k.cyl(0.0055, 0.004, 'z', [0, 0, 0.011], { c: 0xb4b4b4, ch: 'K', seg: 6 }); // rim (darker than the tint)
}

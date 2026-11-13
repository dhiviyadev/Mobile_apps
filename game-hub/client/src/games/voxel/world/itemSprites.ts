/**
 * Item sprite painters for atlas tiles 160..239 (WP-B; recipes in
 * design-voxel-survival §17.6 and §19.6). 16x16 original pixel art, painted
 * procedurally: transparent background, then a darker 1 px outline. Used for
 * icons, extruded first-person models and (through WP-A's atlas builder) the
 * world atlas.
 */
import { Item, itemDef, TIER_COLORS } from '@hub/shared';

type RGB = number; // 0xrrggbb
type Px = (x: number, y: number, c: RGB) => void;

interface Canvas16 {
  px: Px;
  get(x: number, y: number): number;
}

const HANDLE = 0x8a5a32;
const HANDLE_DARK = 0x5a3a1e;

function line(px: Px, x0: number, y0: number, x1: number, y1: number, c: RGB | ((i: number, n: number) => RGB), w = 1): void {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / Math.max(1, n));
    const y = Math.round(y0 + ((y1 - y0) * i) / Math.max(1, n));
    const col = typeof c === 'function' ? c(i, n) : c;
    px(x, y, col);
    if (w > 1) px(x + 1, y, col);
  }
}

function poly(px: Px, pts: [number, number][], c: (x: number, y: number) => RGB | null): void {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        if (yi > y + 0.5 !== yj > y + 0.5 && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) {
        const col = c(x, y);
        if (col !== null) px(x, y, col);
      }
    }
  }
}

function disc(px: Px, cx: number, cy: number, r: number, c: (x: number, y: number, d: number) => RGB | null): void {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (d <= r) {
      const col = c(x, y, d);
      if (col !== null) px(x, y, col);
    }
  }
}

const tierOf = (id: number) => (((id - Item.WoodenPickaxe) % 4) + 1) as 1 | 2 | 3 | 4;
const GOLD = 0xf2c63a;

/** Palette for tools/weapons: tier colours or a boss unique's own. */
function palette(id: number): { main: RGB; light: RGB; dark: RGB; accent: RGB } {
  switch (id) {
    case Item.SunforgedSword: return { main: 0xf2c63a, light: 0xfff2a8, dark: 0xb06a1a, accent: 0xff8a2a };
    case Item.RimeboundCrossbow: return { main: 0xbfe8ff, light: 0xffffff, dark: 0x5a9ad8, accent: 0x5a9ad8 };
    case Item.ThornheartBow: return { main: 0x3f8a3a, light: 0x6ac860, dark: 0x24501f, accent: 0xc83a2a };
    case Item.AshenAxe: return { main: 0x3a3a40, light: 0x6a6a72, dark: 0x1e1e22, accent: 0xff6a2a };
    case Item.CoralfangBlade: return { main: 0xe8e2d0, light: 0xffffff, dark: 0x2a8a98, accent: 0x2ab8c8 };
    case Item.GaleshotBow: return { main: 0xdff4ff, light: 0xffffff, dark: 0x5a8ab8, accent: 0x6ad8ff };
    case Item.RootsplitterAxe: return { main: 0x8a5a2a, light: 0xc8905a, dark: 0x4a2e14, accent: 0x7ae86a };
    case Item.ForgeheartHammer: return { main: 0x4a4a52, light: 0x8a8a96, dark: 0x24242a, accent: 0xff7a2a };
    case Item.CobaltCrossbow: return { main: 0x2f6fe0, light: 0x9cc8ff, dark: 0x1a3a8a, accent: GOLD };
    case Item.Crossbow: return { main: 0xd8dde6, light: 0xffffff, dark: 0x8a909c, accent: 0xc8743a };
  }
  const [main, light, dark] = TIER_COLORS[tierOf(id)];
  return { main, light, dark, accent: tierOf(id) === 4 ? GOLD : dark };
}

function sword(c: Canvas16, id: number): void {
  const p = palette(id);
  line(c.px, 5, 10, 13, 2, p.main, 2);
  line(c.px, 6, 10, 13, 3, p.light);
  c.px(14, 1, p.light);
  c.px(13, 2, p.light);
  line(c.px, 3, 8, 7, 12, p.accent === GOLD || id === Item.SunforgedSword ? GOLD : p.dark);
  line(c.px, 2, 13, 4, 11, HANDLE_DARK, 2);
  c.px(1, 14, p.accent);
  if (id === Item.SunforgedSword) for (const [x, y] of [[8, 6], [10, 4], [12, 3]]) c.px(x, y, p.accent);
  if (id === Item.CoralfangBlade) {
    // A serrated coral edge and a teal glint.
    for (const [x, y] of [[8, 8], [10, 6], [12, 4], [7, 9]]) c.px(x, y, p.accent);
    for (const [x, y] of [[9, 9], [11, 7], [13, 5]]) c.px(x, y, p.dark);
  }
}

function axe(c: Canvas16, id: number): void {
  const p = palette(id);
  line(c.px, 3, 14, 11, 4, (i) => (i % 2 ? HANDLE : HANDLE_DARK));
  for (let y = 2; y <= 7; y++) for (let x = 7; x <= 12; x++) if (!((x === 12 && (y === 2 || y === 7)))) c.px(x, y, p.main);
  for (let y = 3; y <= 6; y++) c.px(12, y, p.light);
  for (let y = 2; y <= 7; y++) c.px(13, y, y > 2 && y < 7 ? p.light : p.main);
  for (let y = 3; y <= 5; y++) c.px(6, y, p.dark);
  if (id === Item.AshenAxe || id === Item.RootsplitterAxe) for (const [x, y] of [[13, 3], [13, 5], [12, 6]]) c.px(x, y, p.accent);
  if (id === Item.RootsplitterAxe) for (const [x, y] of [[8, 3], [9, 6], [5, 12]]) c.px(x, y, p.accent);
}

/** A forge hammer: a heavy two-tone head on a haft, with a glowing face. */
function hammer(c: Canvas16, id: number): void {
  const p = palette(id);
  line(c.px, 3, 14, 10, 7, (i) => (i % 2 ? HANDLE : HANDLE_DARK));
  for (let y = 1; y <= 7; y++) for (let x = 7; x <= 14; x++) c.px(x, y, y <= 2 || x === 7 ? p.light : y >= 6 || x === 14 ? p.dark : p.main);
  for (let y = 3; y <= 5; y++) c.px(14, y, p.accent);
  for (const [x, y] of [[9, 4], [11, 3], [12, 5]]) c.px(x, y, p.accent);
  c.px(8, 8, p.dark);
  c.px(9, 8, p.dark);
}

function pickaxe(c: Canvas16, id: number): void {
  const p = palette(id);
  line(c.px, 3, 14, 10, 7, (i) => (i % 2 ? HANDLE : HANDLE_DARK));
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (y > 9 || x < 3) continue;
    const d = Math.abs(Math.hypot(x - 10, y - 10) - 7);
    if (d < 1.0) c.px(x, y, y <= 3 ? p.light : p.main);
  }
  c.px(3, 8, p.dark);
  c.px(3, 9, p.dark);
  c.px(15, 9, p.dark);
  c.px(14, 9, p.dark);
}

function shovel(c: Canvas16, id: number): void {
  const p = palette(id);
  line(c.px, 3, 14, 9, 8, (i) => (i % 2 ? HANDLE : HANDLE_DARK));
  for (let y = 2; y <= 7; y++) for (let x = 9; x <= 14; x++) {
    if ((x === 9 || x === 14) && (y === 2 || y === 7)) continue;
    c.px(x, y, x === 10 ? p.light : p.main);
  }
  line(c.px, 10, 6, 13, 3, p.dark);
}

function shield(c: Canvas16, id: number): void {
  const face = id === Item.WoodenShield ? null : id === Item.IronShield ? 0xb8bec8 : 0x2f6fe0;
  const rim = id === Item.WoodenShield ? 0xc8743a : id === Item.IronShield ? 0x6a707c : GOLD;
  const inside = (x: number, y: number) => {
    if (y < 1 || y > 14) return false;
    if (y <= 9) return x >= 2 && x <= 13;
    const k = y - 9;
    return x >= 2 + k && x <= 13 - k;
  };
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (!inside(x, y)) continue;
    const edge = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
    c.px(x, y, edge ? rim : (face ?? (Math.floor(x / 2) % 2 ? 0x9a6b3c : 0x8a5f34)));
  }
  for (const [x, y] of [[7, 6], [8, 6], [7, 7], [8, 7]]) c.px(x, y, 0xd8dde6);
  if (id === Item.CobaltShield) for (let y = 8; y <= 11; y++) for (let x = 3; x <= 12; x++) if (Math.abs(x + 0.5 - 8) === 12 - y + 0.5 || Math.abs(x - 7.5) === 12 - y) c.px(x, y, 0xe8f0ff);
}

function bow(c: Canvas16, id: number): void {
  const p = id === Item.ThornheartBow || id === Item.GaleshotBow ? palette(id) : { main: HANDLE, dark: HANDLE_DARK, accent: HANDLE_DARK, light: 0xb07a50 };
  for (let y = 0; y < 16; y++) for (let x = 4; x < 16; x++) {
    const d = Math.abs(Math.hypot(x + 6, y - 7.5) - 15.5);
    if (d < 1.0) c.px(x, y, y < 2 || y > 13 ? p.dark : p.main);
  }
  for (let y = 1; y <= 14; y++) c.px(4, y, 0xe8e0d0);
  for (let y = 6; y <= 9; y++) {
    c.px(10, y, HANDLE_DARK);
    c.px(11, y, HANDLE_DARK);
  }
  if (id === Item.ThornheartBow) for (const [x, y] of [[9, 3], [9, 12], [8, 1]]) c.px(x, y, p.accent);
  if (id === Item.GaleshotBow) for (const [x, y] of [[8, 2], [7, 4], [8, 11], [7, 13], [12, 7]]) c.px(x, y, p.accent);
}

function crossbow(c: Canvas16, id: number): void {
  const p = palette(id);
  line(c.px, 2, 13, 10, 5, HANDLE, 2);
  for (let i = 0; i <= 9; i++) {
    const x = 5 + i;
    const y = 10 - i + Math.round(Math.sin((i / 9) * Math.PI) * -1.5);
    c.px(x, y, i === 0 || i === 9 ? p.dark : p.main);
  }
  line(c.px, 5, 10, 9, 6, 0xe8e0d0);
  line(c.px, 14, 1, 9, 6, 0xe8e0d0);
  c.px(11, 4, p.accent);
}

function ingot(c: Canvas16, light: RGB, main: RGB, dark: RGB): void {
  for (let y = 5; y <= 7; y++) for (let x = 4; x <= 11; x++) c.px(x, y, light);
  for (let y = 8; y <= 10; y++) for (let x = 3; x <= 12; x++) c.px(x, y, main);
  for (let x = 3; x <= 12; x++) c.px(x, 11, dark);
}

function arrow(c: Canvas16, head: RGB, headLight: RGB, ember: boolean): void {
  line(c.px, 3, 12, 11, 4, 0x9a7a4a);
  poly(c.px, [[11, 1], [15, 1], [15, 5], [13, 6], [10, 3]], () => head);
  c.px(13, 2, headLight);
  c.px(12, 3, headLight);
  for (let i = 0; i < 4; i++) {
    c.px(1 + i, 11 + i - 1, i % 2 ? 0xd23a3a : 0xf0f0f0);
    c.px(2 + i, 14 - i, i % 2 ? 0xf0f0f0 : 0xd23a3a);
  }
  if (ember) for (const [x, y] of [[9, 2], [14, 7], [10, 6]]) c.px(x, y, 0xffb040);
}

function food(c: Canvas16, id: number): void {
  switch (id) {
    case Item.Apple:
      disc(c.px, 7.5, 9, 5.5, (x, y) => (x <= 6 && y <= 7 && x >= 5 && y >= 6 ? 0xf07a6a : 0xd23a3a));
      line(c.px, 8, 2, 8, 4, 0x6a4a2a);
      line(c.px, 9, 3, 11, 3, 0x4f9a3a);
      c.px(10, 4, 0x4f9a3a);
      break;
    case Item.MelonSlice:
      disc(c.px, 7.5, 5, 6.5, (x, y, d) => (y < 5 ? null : d > 5.8 ? 0x5aa03a : d > 5 ? 0xc8e8a0 : (x * 7 + y * 3) % 11 === 0 ? 0x2a2a2a : 0xe8584a));
      break;
    case Item.Bread:
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const e = ((x + 0.5 - 7.5) / 6.5) ** 2 + ((y + 0.5 - 9) / 4) ** 2;
        if (e <= 1) c.px(x, y, y < 8 ? 0xe0b060 : (x - y) % 4 === 0 && y < 11 ? 0xa06a2a : 0xc8903a);
      }
      break;
    case Item.MushroomSkewer:
      line(c.px, 2, 14, 13, 3, 0x8a6a3a);
      disc(c.px, 6, 10, 2.6, (x, y) => ((x + y) % 3 === 0 ? 0xf4ece0 : 0xc83a2a));
      disc(c.px, 10, 6, 2.6, () => 0x8a6a4a);
      break;
    case Item.RawMeat:
    case Item.CookedMeat: {
      const cooked = id === Item.CookedMeat;
      poly(c.px, [[3, 5], [6, 3], [11, 3], [13, 6], [12, 11], [8, 13], [4, 11]], (x, y) =>
        cooked ? ((x + 2 * y) % 6 === 0 ? 0x5a2a1a : y < 6 ? 0xb06a3a : 0x8a4a2a) : Math.sin(x * 0.9 + y * 0.4) > 0.85 ? 0xf4d0d0 : 0xd86a6a);
      disc(c.px, 4, 12, 1.6, () => 0xf0e8d8);
      break;
    }
    case Item.RawFish:
    case Item.CookedFish: {
      const body = id === Item.RawFish ? 0x6aa8c8 : 0xb07a4a;
      const belly = id === Item.RawFish ? 0xbfe0f0 : 0xd8a870;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const e = ((x + 0.5 - 7) / 5.5) ** 2 + ((y + 0.5 - 8) / 3.2) ** 2;
        if (e <= 1) c.px(x, y, y > 8 ? belly : body);
      }
      poly(c.px, [[12, 8], [15, 4], [15, 12]], () => body);
      c.px(4, 7, 0x1a1a1a);
      break;
    }
  }
}

function material(c: Canvas16, id: number): void {
  switch (id) {
    case Item.Stick:
      line(c.px, 3, 13, 12, 4, (i) => (i < 4 ? 0xb08850 : 0x8a6a3a), 2);
      break;
    case Item.PlantFiber:
      for (let i = 0; i < 3; i++) for (let y = 2; y <= 14; y++) c.px(4 + i * 4 + Math.round(Math.sin(y * 0.6 + i) * 1.2), y, i % 2 ? 0x6a9a3a : 0x8ac84a);
      break;
    case Item.Twine:
    case Item.Silk: {
      const col = id === Item.Twine ? 0xd8c49a : 0xf4f4ff;
      disc(c.px, 7.5, 7.5, 5.7, (x, y, d) => (Math.abs(d - 4.5) < 1.1 ? col : null));
      line(c.px, 4, 4, 11, 11, id === Item.Twine ? 0xb8a47a : 0xd8d8f0);
      line(c.px, 4, 11, 11, 4, id === Item.Twine ? 0xb8a47a : 0xd8d8f0);
      break;
    }
    case Item.FlintShard:
      poly(c.px, [[4, 12], [6, 4], [11, 3], [13, 9], [9, 14]], (x, y) => (x + y < 13 ? 0x8a8a96 : 0x4a4a52));
      c.px(8, 5, 0xc8c8d0);
      break;
    case Item.Coal:
      poly(c.px, [[3, 10], [5, 4], [11, 3], [13, 8], [10, 13], [5, 13]], (x, y) => ((x * 13 + y * 7) % 7 === 0 ? 0x55555c : 0x2a2a2e));
      c.px(6, 5, 0x6a6a72);
      c.px(7, 5, 0x6a6a72);
      break;
    case Item.CopperIngot: ingot(c, 0xe8a070, 0xc8743a, 0x8a4a22); break;
    case Item.IronIngot: ingot(c, 0xffffff, 0xd8dde6, 0x8a909c); break;
    case Item.GoldIngot: ingot(c, 0xfff2a8, 0xf2c63a, 0xb08a1a); break;
    case Item.CobaltGem:
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const dx = Math.abs(x + 0.5 - 8);
        const dy = Math.abs(y + 0.5 - 8);
        if (dx + dy * 0.6 > 6) continue;
        c.px(x, y, dx + dy * 0.6 > 5 ? 0x1a3a8a : y < 8 ? 0x9cc8ff : 0x2f6fe0);
      }
      c.px(6, 4, 0xffffff);
      break;
    case Item.EmberShard:
      poly(c.px, [[7, 1], [10, 6], [12, 13], [5, 14], [4, 7]], (x) => (x === 7 || x === 8 ? 0xffd08a : 0xff6a2a));
      break;
    case Item.WildGrain:
      for (let i = 0; i < 3; i++) {
        line(c.px, 4 + 3 * i, 15, 5 + 3 * i, 4, 0xc8a040);
        for (let r = 3; r <= 7; r += 2) {
          c.px(4 + 3 * i, r, 0xe8c860);
          c.px(6 + 3 * i, r + 1, 0xe8c860);
        }
      }
      break;
    case Item.Feather:
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        // Distance to the quill line (3,14)-(12,2), upper side only.
        const t = Math.max(0, Math.min(1, ((x - 3) * 9 + (y - 14) * -12) / 225));
        const qx = 3 + 9 * t;
        const qy = 14 - 12 * t;
        const d = Math.hypot(x - qx, y - qy);
        const side = (x - 3) * -12 - (y - 14) * 9 < 0;
        if (d < 0.6) c.px(x, y, 0xc8c8c8);
        else if (d < 2.4 && side && t > 0.1) c.px(x, y, (x + y) % 3 === 0 ? 0xd8d8d8 : 0xf4f4f4);
      }
      break;
    case Item.Fleece:
      for (const [cx, cy, r] of [[5, 7, 3], [9, 6, 3.5], [11, 9, 3], [7, 10, 3.5], [4, 10, 2.5]]) disc(c.px, cx, cy, r, (x, y) => (x + y > 18 ? 0xd8d2c4 : 0xf4f1ea));
      break;
    case Item.Hide:
      poly(c.px, [[3, 3], [7, 2], [12, 3], [14, 8], [12, 13], [8, 14], [3, 12], [2, 7]], (x, y) => (Math.hypot(x - 8, y - 8) < 3.5 ? 0xb07a50 : 0x8a5a3a));
      break;
    case Item.Bone:
      line(c.px, 4, 11, 11, 4, 0xe8e0d0, 2);
      disc(c.px, 3.5, 12.5, 1.7, () => 0xf4ecdc);
      disc(c.px, 5, 13.5, 1.4, () => 0xf4ecdc);
      disc(c.px, 12.5, 3.5, 1.7, () => 0xf4ecdc);
      disc(c.px, 13.5, 5, 1.4, () => 0xf4ecdc);
      break;
    case Item.GlowDust:
      disc(c.px, 8, 8, 6, (x, y, d) => {
        const h = (x * 31 + y * 17) % 9;
        return h === 0 || h === 4 ? (d < 3 ? 0xfff8d0 : 0xffe8a0) : d < 2.5 ? 0xfff0b8 : null;
      });
      break;
  }
}

function satchel(c: Canvas16): void {
  for (let y = 5; y <= 14; y++) for (let x = 3; x <= 12; x++) {
    if ((x === 3 || x === 12) && (y === 5 || y === 14)) continue;
    c.px(x, y, y <= 8 ? 0x6a4a2a : 0x8a6a3a);
  }
  for (const [x, y] of [[7, 8], [8, 8], [7, 9], [8, 9]]) c.px(x, y, GOLD);
  for (let x = 4; x <= 11; x++) c.px(x, Math.round(1 + Math.abs(x - 7.5) * 0.8), 0x5a3a1e);
}

/** Paints a sprite into a 16x16 RGBA buffer (row-major). False = no painter for this tile. */
export function paintItemTile(tile: number, out: Uint8ClampedArray): boolean {
  const id = ITEM_BY_TILE.get(tile);
  if (id === undefined) return false;
  const buf = new Int32Array(256).fill(-1);
  const c: Canvas16 = {
    px: (x, y, col) => {
      if (x >= 0 && x < 16 && y >= 0 && y < 16) buf[y * 16 + x] = col;
    },
    get: (x, y) => (x >= 0 && x < 16 && y >= 0 && y < 16 ? buf[y * 16 + x] : -1),
  };
  paintItem(c, id);
  // Darker 1 px outline around every shape.
  const outline: [number, number, number][] = [];
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (buf[y * 16 + x] >= 0) continue;
    const n = [c.get(x - 1, y), c.get(x + 1, y), c.get(x, y - 1), c.get(x, y + 1)].find((v) => v >= 0);
    if (n !== undefined) outline.push([x, y, n]);
  }
  for (const [x, y, n] of outline) {
    const r = ((n >> 16) & 255) * 0.42;
    const g = ((n >> 8) & 255) * 0.42;
    const b = (n & 255) * 0.42;
    buf[y * 16 + x] = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  }
  for (let i = 0; i < 256; i++) {
    const v = buf[i];
    out[i * 4] = v >= 0 ? (v >> 16) & 255 : 0;
    out[i * 4 + 1] = v >= 0 ? (v >> 8) & 255 : 0;
    out[i * 4 + 2] = v >= 0 ? v & 255 : 0;
    out[i * 4 + 3] = v >= 0 ? 255 : 0;
  }
  return true;
}

function paintItem(c: Canvas16, id: number): void {
  if (id === Item.Satchel) return satchel(c);
  if (id === Item.Arrow) return arrow(c, 0x5a5a64, 0x9a9aa4, false);
  if (id === Item.EmberArrow) return arrow(c, 0xff6a2a, 0xffd08a, true);
  if (id === Item.Bolt) {
    line(c.px, 4, 11, 11, 4, 0x6a4a2a, 2);
    poly(c.px, [[11, 2], [14, 2], [14, 5], [12, 5]], () => 0xc8743a);
    line(c.px, 2, 12, 4, 14, 0x3a3a40, 2);
    return;
  }
  const def = itemDef(id);
  if (!def) return;
  if (def.food) return food(c, id);
  if (def.shield) return shield(c, id);
  if (def.ranged) return def.ranged.type === 'bow' ? bow(c, id) : crossbow(c, id);
  if (id === Item.SunforgedSword) return sword(c, id);
  if (id === Item.AshenAxe) return axe(c, id);
  if (id === Item.ForgeheartHammer) return hammer(c, id);
  if (def.tool?.kind === 'pick') return pickaxe(c, id);
  if (def.tool?.kind === 'shovel') return shovel(c, id);
  if (def.tool?.kind === 'axe') return axe(c, id);
  if (def.melee) return sword(c, id);
  material(c, id);
}

/** tile -> item id for every registered survival item. */
const ITEM_BY_TILE = new Map<number, number>();
for (let id = 256; id < 512; id++) {
  const d = itemDef(id);
  if (d && d.tile >= 160) ITEM_BY_TILE.set(d.tile, id);
}

/** A 16x16 RGBA sprite of an item (cached), or null for block items. */
const SPRITES = new Map<number, Uint8ClampedArray | null>();
export function itemSprite(id: number): Uint8ClampedArray | null {
  let s = SPRITES.get(id);
  if (s === undefined) {
    const def = itemDef(id);
    s = null;
    if (def && def.tile >= 160) {
      const buf = new Uint8ClampedArray(1024);
      if (paintItemTile(def.tile, buf)) s = buf;
    }
    SPRITES.set(id, s);
  }
  return s;
}

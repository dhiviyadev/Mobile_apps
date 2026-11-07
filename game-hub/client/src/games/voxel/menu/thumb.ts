/**
 * World card art: a tiny isometric block island drawn from the world's seed
 * (cheap value noise, no terrain generator), tinted by a seed-picked palette
 * and the mode (survival islands get a dusk sky and a campfire glow).
 * Original procedural art; one small canvas per card.
 */

interface Palette {
  sky: [string, string];
  top: string;
  side: string;
  deep: string;
  water: string;
  accent: string;
}

/** Meadow, dunes, snowfield, forest, blossom, mesa. */
const PALETTES: Palette[] = [
  { sky: ['#7cc8ff', '#d8f1ff'], top: '#5fd17a', side: '#8a5a3a', deep: '#6a4430', water: '#3a8fd8', accent: '#ffd166' },
  { sky: ['#ffc98a', '#fff1d6'], top: '#f2d48a', side: '#d1a85a', deep: '#a8803e', water: '#2fb3a6', accent: '#ff7a45' },
  { sky: ['#a9c8ff', '#eef4ff'], top: '#f4f8ff', side: '#9aa6c8', deep: '#6f7a99', water: '#4f7fd8', accent: '#bfe8ff' },
  { sky: ['#8fd3c3', '#e2fbf4'], top: '#2f9a4e', side: '#6a4a2a', deep: '#4a3420', water: '#2a78b8', accent: '#9be36a' },
  { sky: ['#f7b6d6', '#fff0f7'], top: '#7fd18a', side: '#9a6a4a', deep: '#74503a', water: '#5aa0e8', accent: '#ff8fc8' },
  { sky: ['#ffb38a', '#ffe6d1'], top: '#d8743a', side: '#b0502a', deep: '#86381e', water: '#3a8fd8', accent: '#ffd166' },
];

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff;
  };
}

/** Index of the palette a seed uses (also used for the card's accent colour). */
export function paletteIndex(seed: number): number {
  return (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0) % PALETTES.length;
}

export function accentFor(seed: number): string {
  return PALETTES[paletteIndex(seed)].accent;
}

/** Heights of an n×n island (0 = water). */
function heights(seed: number, n: number): number[][] {
  const r = rng(seed ^ 0x51ed270b);
  const corners = Array.from({ length: 16 }, () => r());
  const at = (x: number, y: number) => corners[(y & 3) * 4 + (x & 3)];
  const out: number[][] = [];
  for (let z = 0; z < n; z++) {
    const row: number[] = [];
    for (let x = 0; x < n; x++) {
      const fx = (x / (n - 1)) * 3;
      const fz = (z / (n - 1)) * 3;
      const ix = Math.floor(fx);
      const iz = Math.floor(fz);
      const tx = fx - ix;
      const tz = fz - iz;
      const v = at(ix, iz) * (1 - tx) * (1 - tz) + at(ix + 1, iz) * tx * (1 - tz) + at(ix, iz + 1) * (1 - tx) * tz + at(ix + 1, iz + 1) * tx * tz;
      // Island falloff: the rim sinks into water.
      const dx = x / (n - 1) - 0.5;
      const dz = z / (n - 1) - 0.5;
      const fall = 1 - Math.min(1, Math.max(0, Math.hypot(dx, dz) * 1.5 - 0.12));
      row.push(Math.max(0, Math.round((v * 0.8 + 0.5) * fall * 4.4)));
    }
    out.push(row);
  }
  return out;
}

/** Draws the island for this seed onto a canvas sized w × h CSS pixels. */
export function drawWorldThumb(canvas: HTMLCanvasElement, seed: number, survival: boolean, w = 132, h = 96): void {
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const p = PALETTES[paletteIndex(seed)];
  const sky = g.createLinearGradient(0, 0, 0, h);
  if (survival) {
    sky.addColorStop(0, '#2a2f5a');
    sky.addColorStop(1, p.sky[0]);
  } else {
    sky.addColorStop(0, p.sky[0]);
    sky.addColorStop(1, p.sky[1]);
  }
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  if (survival) {
    // A few stars.
    const r = rng(seed ^ 0x1234);
    g.fillStyle = 'rgba(255,255,255,0.8)';
    for (let i = 0; i < 9; i++) g.fillRect(r() * w, r() * h * 0.35, 1.2, 1.2);
  }
  const n = 7;
  const hs = heights(seed, n);
  const cell = Math.min(w / 16, h / 9.6);
  const ox = w / 2;
  const oy = h * 0.4;
  const iso = (x: number, z: number, y: number): [number, number] => [ox + (x - z) * cell, oy + (x + z) * cell * 0.5 - y * cell * 0.62];
  const quad = (pts: [number, number][], fill: string) => {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  // Back to front.
  for (let s = 0; s <= (n - 1) * 2; s++) {
    for (let x = 0; x < n; x++) {
      const z = s - x;
      if (z < 0 || z >= n) continue;
      const top = hs[z][x];
      const water = top === 0;
      const y = water ? 0.6 : top;
      const a = iso(x, z, y);
      const b = iso(x + 1, z, y);
      const c = iso(x + 1, z + 1, y);
      const d = iso(x, z + 1, y);
      if (!water) {
        const c0 = iso(x + 1, z + 1, 0);
        const d0 = iso(x, z + 1, 0);
        const b0 = iso(x + 1, z, 0);
        quad([d, c, c0, d0], p.side);
        quad([c, b, b0, c0], p.deep);
      }
      quad([a, b, c, d], water ? p.water : top >= 4 && !survival ? p.accent : p.top);
    }
  }
  if (survival) {
    // Campfire glow on the highest block.
    let bx = 3;
    let bz = 3;
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) if (hs[z][x] > hs[bz][bx]) [bx, bz] = [x, z];
    const [fx, fy] = iso(bx + 0.5, bz + 0.5, hs[bz][bx]);
    const glow = g.createRadialGradient(fx, fy, 0, fx, fy, cell * 2.2);
    glow.addColorStop(0, 'rgba(255,170,80,0.85)');
    glow.addColorStop(1, 'rgba(255,170,80,0)');
    g.fillStyle = glow;
    g.fillRect(fx - cell * 3, fy - cell * 3, cell * 6, cell * 6);
  }
}

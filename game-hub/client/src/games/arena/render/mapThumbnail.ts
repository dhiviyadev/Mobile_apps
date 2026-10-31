/**
 * Procedural map preview for the vote cards: a 2.5-D oblique "diorama" of
 * the map's boxes seen from the south, drawn on a 2D canvas (no three.js, no
 * GPU), with pads, launcher arcs, pickups and team spawns marked
 * (design-arena-maps §5.6).
 */
import { type ArenaMap, launchLanding, createArenaWorld, MOVE } from '@hub/shared';
import { TEAM_COLORS } from '../ui/Scoreboard';
import { cssColor, kindColor } from './mapColors';

/** Screen height per metre of box height (the oblique tilt). */
const K = 0.55;

export interface ThumbnailLayout {
  /** Pixels per metre. */
  s: number;
  /** Screen x of world x = 0, screen y of world z = 0 at height 0. */
  ox: number;
  oz: number;
  /** Tallest height drawn (m). */
  hMax: number;
}

/** Scale and origin that fit the whole map (walls included) with its tallest box into w × h, centred. */
export function thumbnailLayout(map: ArenaMap, w: number, h: number, pad = 6): ThumbnailLayout {
  const b = map.bounds;
  const sizeX = b.maxX - b.minX;
  const sizeZ = b.maxZ - b.minZ;
  const hMax = Math.min(12, Math.max(...map.boxes.map((x) => x.maxY)));
  const s = Math.min((w - 2 * pad) / (sizeX + 2), (h - 2 * pad) / (sizeZ + 2 + hMax * K));
  const ox = w / 2 - ((b.minX + b.maxX) / 2) * s;
  // Drawn span: from the back wall's top (z = minZ − 1, y = hMax) to the front edge (z = maxZ + 1, y = 0).
  const top = (b.minZ - 1) * s - hMax * K * s;
  const bottom = (b.maxZ + 1) * s;
  const oz = h / 2 - (top + bottom) / 2;
  return { s, ox, oz, hMax };
}

/** Draws the map preview into a w × h area of ctx (canvas pixels). */
export function drawMapThumbnail(ctx: CanvasRenderingContext2D, map: ArenaMap, w: number, h: number, pad = 6): void {
  const L = thumbnailLayout(map, w, h, pad);
  const { s } = L;
  const X = (x: number) => L.ox + x * s;
  const Y = (z: number, y: number) => L.oz + z * s - Math.min(y, L.hMax) * K * s;
  const t = map.theme;
  const front = map.bounds.maxZ - 0.25;
  ctx.fillStyle = cssColor(t.horizon, 0.35);
  ctx.fillRect(0, 0, w, h);

  // Painter's order: back to front, low to high.
  const order = (x: { kind: string; maxZ: number }) => (x.kind === 'floor' ? -Infinity : x.maxZ);
  const boxes = [...map.boxes].sort((a, b) => order(a) - order(b) || a.maxY - b.maxY);
  ctx.lineWidth = 1;
  for (const bx of boxes) {
    const base = kindColor(map, bx.kind);
    // The south perimeter (wall and cap) is cut away to a low rim so it does not hide the map.
    const rim = bx.kind !== 'floor' && bx.minZ >= front;
    if (rim && bx.minY > 0.6) continue;
    const y1 = rim ? Math.min(bx.maxY, 0.6) : bx.maxY;
    const wpx = (bx.maxX - bx.minX) * s;
    if (bx.kind !== 'floor') {
      ctx.fillStyle = cssColor(base, 0.62);
      ctx.fillRect(X(bx.minX), Y(bx.maxZ, y1), wpx, (Math.min(y1, L.hMax) - Math.min(bx.minY, L.hMax)) * K * s);
    }
    ctx.fillStyle = cssColor(base, bx.kind === 'floor' ? 0.8 : 0.85 + Math.min(0.35, y1 / 20));
    ctx.fillRect(X(bx.minX), Y(bx.minZ, y1), wpx, (bx.maxZ - bx.minZ) * s);
    if (bx.kind === 'floor') floorGrid(ctx, map, X, Y);
    else if (wpx > 3) {
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.strokeRect(X(bx.minX) + 0.5, Y(bx.minZ, y1) + 0.5, wpx - 1, (bx.maxZ - bx.minZ) * s - 1);
    }
  }

  // Pads: glowing rings; launchers also get a dashed arc to where they land.
  const world = map.pads.some((p) => p.horizontal === 'set') ? createArenaWorld(map) : null;
  ctx.lineWidth = Math.max(1.5, s * 0.35);
  for (const p of map.pads) {
    const cx = (p.minX + p.maxX) / 2;
    const cz = (p.minZ + p.maxZ) / 2;
    ctx.strokeStyle = cssColor(t.pad, 1.15);
    ctx.beginPath();
    ctx.arc(X(cx), Y(cz, p.top), Math.max(2.5, (Math.max(p.maxX - p.minX, p.maxZ - p.minZ) / 2) * s), 0, Math.PI * 2);
    ctx.stroke();
    if (p.horizontal === 'set' && world) {
      const land = launchLanding(world, p);
      if (!land) continue;
      const flight = Math.hypot(land.x - cx, land.z - cz) / Math.max(1e-3, Math.hypot(p.vx, p.vz));
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        const tt = (flight * i) / 16;
        const x = cx + p.vx * tt;
        const z = cz + p.vz * tt;
        const y = Math.max(land.y, p.top + p.vy * tt - 0.5 * MOVE.gravity * tt * tt);
        if (i === 0) ctx.moveTo(X(x), Y(z, y));
        else ctx.lineTo(X(x), Y(z, y));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Pickups: a mint plus for health, an amber square for ammo.
  const r = Math.max(2, s * 0.9);
  for (const pk of map.pickups) {
    const x = X(pk.x);
    const y = Y(pk.z, pk.y) - r * 0.6;
    if (pk.kind === 'health') {
      ctx.fillStyle = '#34d27b';
      ctx.fillRect(x - r, y - r * 0.35, r * 2, r * 0.7);
      ctx.fillRect(x - r * 0.35, y - r, r * 0.7, r * 2);
    } else {
      ctx.fillStyle = '#ffc24a';
      ctx.fillRect(x - r * 0.75, y - r * 0.75, r * 1.5, r * 1.5);
    }
  }

  // Team spawns: small team-coloured ticks.
  map.spawns.team.forEach((list, team) => {
    ctx.fillStyle = cssColor(TEAM_COLORS[team] ?? 0xffffff);
    for (const sp of list) ctx.fillRect(X(sp.x) - 1.5, Y(sp.z, sp.y) - 1.5, 3, 3);
  });
}

/** Faint 8 m grid on the floor for scale. */
function floorGrid(ctx: CanvasRenderingContext2D, map: ArenaMap, X: (x: number) => number, Y: (z: number, y: number) => number): void {
  const b = map.bounds;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let x = Math.ceil(b.minX / 8) * 8; x <= b.maxX; x += 8) ctx.fillRect(X(x), Y(b.minZ, 0), 1, Y(b.maxZ, 0) - Y(b.minZ, 0));
  for (let z = Math.ceil(b.minZ / 8) * 8; z <= b.maxZ; z += 8) ctx.fillRect(X(b.minX), Y(z, 0), X(b.maxX) - X(b.minX), 1);
}

const cache = new Map<string, HTMLCanvasElement>();

/**
 * The preview as a canvas cssW × cssH CSS pixels (× min(2, devicePixelRatio)), drawn once per map and size and
 * cached; cards copy it with drawImage.
 */
export function mapThumbnail(map: ArenaMap, cssW = 320, cssH = 200, createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')): HTMLCanvasElement {
  const key = `${map.id}:${cssW}x${cssH}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  const canvas = createCanvas();
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx) drawMapThumbnail(ctx, map, canvas.width, canvas.height, 6 * dpr);
  cache.set(key, canvas);
  return canvas;
}

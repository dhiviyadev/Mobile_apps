/**
 * Flat side-view icons of the weapons (loadout cards, kill feed, ammo panel), drawn on a 2D canvas from
 * the same procedural model: every right-facing triangle is projected onto the side plane and painted
 * back to front with simple shading, over a dark outline pass. No WebGL needed; cached as data URLs.
 */
import { WeaponId } from '@hub/shared';
import { buildWeapon } from './weaponKit';
import { WEAPON_SPECS } from './weaponSpecs';

const cache = new Map<string, string>();

interface Tri {
  pts: [number, number][];
  depth: number;
  fill: string;
}

/** Triangles of a weapon at rest (magazine and action in place), seen from its right side. */
function sideTriangles(id: WeaponId): Tri[] {
  const built = buildWeapon(WEAPON_SPECS[id], 'fp');
  const a = built.anchors;
  const out: Tri[] = [];
  const add = (g: typeof built.body | null, off: [number, number, number]) => {
    if (!g) return;
    const pos = g.attributes.position.array as Float32Array;
    const col = g.attributes.color.array as Float32Array;
    const mat = g.attributes.mat.array as Float32Array;
    for (let i = 0; i < pos.length / 9; i++) {
      const v = [0, 1, 2].map((k) => [pos[i * 9 + k * 3] + off[0], pos[i * 9 + k * 3 + 1] + off[1], pos[i * 9 + k * 3 + 2] + off[2]]);
      // Face normal; keep faces turned toward the viewer (+X) and the top faces slightly.
      const ux = v[1][0] - v[0][0], uy = v[1][1] - v[0][1], uz = v[1][2] - v[0][2];
      const wx = v[2][0] - v[0][0], wy = v[2][1] - v[0][1], wz = v[2][2] - v[0][2];
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      if (nx < 0.05) continue;
      const emissive = mat[i * 3] === 2;
      const shade = emissive ? 1.25 : 0.62 + 0.38 * Math.max(0, ny * 0.8 + nx * 0.5 - nz * 0.1);
      const c = (k: number) => Math.min(255, Math.round(col[i * 9 + k] * 255 * shade + (emissive ? 0 : 14)));
      out.push({
        pts: v.map(([, y, z]) => [-z, y] as [number, number]),
        depth: (v[0][0] + v[1][0] + v[2][0]) / 3,
        fill: `rgb(${c(0)},${c(1)},${c(2)})`,
      });
    }
    g.dispose();
  };
  add(built.body, [0, 0, 0]);
  add(built.mag, a.magPivot);
  add(built.act, a.actPivot);
  return out.sort((p, q) => p.depth - q.depth);
}

/**
 * A data URL with the weapon's side view, muzzle to the right, fitted into w × h CSS pixels with 8%
 * padding (drawn at 2× for sharp edges). Empty string where no canvas is available.
 */
export function weaponIcon(id: WeaponId, w: number, h: number): string {
  const key = `${id}:${w}x${h}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (typeof document === 'undefined') return '';
  const tris = sideTriangles(id);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of tris) {
    for (const [x, y] of t.pts) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const pad = 0.08;
  const k = Math.min((canvas.width * (1 - 2 * pad)) / (maxX - minX), (canvas.height * (1 - 2 * pad)) / (maxY - minY));
  const ox = (canvas.width - (maxX - minX) * k) / 2 - minX * k;
  const oy = (canvas.height + (maxY - minY) * k) / 2 + minY * k;
  const path = (t: Tri) => {
    ctx.beginPath();
    t.pts.forEach(([x, y], i) => (i ? ctx.lineTo(ox + x * k, oy - y * k) : ctx.moveTo(ox + x * k, oy - y * k)));
    ctx.closePath();
  };
  // Outline: the silhouette drawn fat in a dark colour first.
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(6,8,14,0.9)';
  ctx.fillStyle = 'rgba(6,8,14,0.9)';
  ctx.lineWidth = 2.5 * scale;
  for (const t of tris) {
    path(t);
    ctx.fill();
    ctx.stroke();
  }
  ctx.lineWidth = 0.6;
  for (const t of tris) {
    path(t);
    ctx.fillStyle = t.fill;
    ctx.strokeStyle = t.fill;
    ctx.fill();
    ctx.stroke();
  }
  const url = canvas.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

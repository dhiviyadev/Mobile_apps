/**
 * Builds an arena map as ONE merged mesh (one draw call): every box becomes
 * six flat-shaded faces with baked lighting and contact shadows in vertex
 * colours. A small shader adds a world-space 1 m / 4 m grid for depth cues
 * and distance fog. Also builds the gradient sky dome for the map theme.
 */
import * as THREE from 'three';
import { type ArenaMap, type BoxKind, hashFloat } from '@hub/shared';

const SHADE = { top: 1, bottom: 0.55, x: 0.82, z: 0.7 };

function kindColor(map: ArenaMap, kind: BoxKind): number {
  const t = map.theme;
  switch (kind) {
    case 'floor':
      return t.floor;
    case 'wall':
      return t.wall;
    case 'platform':
    case 'stairs':
      return t.platform;
    case 'accent':
      return t.accent;
    case 'trim':
      return t.trim;
    case 'pillar':
      return t.wall;
    default:
      return t.cover;
  }
}

export function buildMapMesh(map: ArenaMap): THREE.Mesh {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const base = new THREE.Color();
  const c = new THREE.Color();

  const quad = (pts: number[][], n: number[], col: THREE.Color, shade: number, aoBottom: boolean, minY: number) => {
    const start = positions.length / 3;
    for (const p of pts) {
      positions.push(p[0], p[1], p[2]);
      normals.push(n[0], n[1], n[2]);
      // Contact shadow: darken the bottom edge of walls that touch the floor.
      const ao = aoBottom && p[1] <= minY + 0.001 ? 0.68 : 1;
      c.copy(col).multiplyScalar(shade * ao);
      colors.push(c.r, c.g, c.b);
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  };

  for (const b of map.boxes) {
    base.setHex(kindColor(map, b.kind));
    // Gentle per-box variation so repeated pieces don't look copy-pasted.
    const v = 0.92 + hashFloat(Math.round(b.minX * 10), Math.round(b.minZ * 10), Math.round(b.maxY * 10)) * 0.16;
    if (b.kind !== 'trim') base.multiplyScalar(v);
    const { minX: x0, maxX: x1, minY: y0, maxY: y1, minZ: z0, maxZ: z1 } = b;
    const onFloor = y0 <= 0.001 && b.kind !== 'floor';
    const trim = b.kind === 'trim' ? 1.15 : 1;
    // top (+Y)
    quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], base, SHADE.top * trim, false, y0);
    // bottom (-Y) — skipped for anything resting on the floor
    if (!onFloor && b.kind !== 'floor') quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], base, SHADE.bottom, false, y0);
    // +X
    quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], base, SHADE.x * trim, onFloor, y0);
    // -X
    quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], base, SHADE.x * trim, onFloor, y0);
    // +Z
    quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], base, SHADE.z * trim, onFloor, y0);
    // -Z
    quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], base, SHADE.z * trim, onFloor, y0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();

  const fog = new THREE.Color(map.theme.fog);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uFogColor: { value: fog }, uFogNear: { value: 30 }, uFogFar: { value: 85 } },
    vertexColors: true,
    vertexShader: /* glsl */ `
      varying vec3 vColor;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vFogDist;
      void main() {
        vColor = color;
        vNormal = normal;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 mv = viewMatrix * world;
        vFogDist = length(mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec3 vColor;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying float vFogDist;
      float grid(vec2 p) {
        vec2 g = abs(fract(p - 0.5) - 0.5) / max(fwidth(p), vec2(1e-4));
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        vec3 n = abs(vNormal);
        vec2 p = n.y > 0.5 ? vWorld.xz : (n.x > 0.5 ? vWorld.zy : vWorld.xy);
        float lines = grid(p) * 0.06 + grid(p * 0.25) * 0.1;
        vec3 c = vColor * (1.0 - lines);
        gl_FragColor = vec4(mix(c, uFogColor, smoothstep(uFogNear, uFogFar, vFogDist)), 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.matrixAutoUpdate = false;
  mesh.name = `map ${map.id}`;
  return mesh;
}

/** Gradient sky dome in the map's colours. */
export function buildSkyDome(map: ArenaMap): THREE.Mesh {
  const geo = new THREE.SphereGeometry(150, 20, 10);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const top = new THREE.Color(map.theme.sky);
  const hor = new THREE.Color(map.theme.horizon);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.max(0, pos.getY(i) / 150);
    c.copy(hor).lerp(top, Math.pow(t, 0.55));
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  return dome;
}
